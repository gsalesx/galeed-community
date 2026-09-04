#!/usr/bin/env -S npx tsx
/** M12/S4 — WORKER dedicado de ingestão (ADR-006, decisão #1: processo SEPARADO, não loop no BFF).
 *  Loop: claimNextJob → processBlobJob → markJobDone | markJobError → repete; backoff quando vazio.
 *  Resiliente (job que falha não derruba o worker) + graceful shutdown (SIGINT/SIGTERM). `npm run worker`. */
// Carrega .env (como o cli.ts): o worker precisa de ANTHROPIC_API_KEY (extração) e OPENAI_API_KEY
// (embeddings/buildIndex). Sem isto, depender só do env exportado é frágil — sem OPENAI = 0 vetores =
// busca semântica desligada (bug real: o cérebro não achava relações por significado).
try {
  process.loadEnvFile();
} catch {
  /* sem .env: usa process.env */
}
import {
  claimNextJob,
  updateJobProgress,
  markJobDone,
  markJobError,
  markJobFindable,
  markJobDigesting,
  closeIngestQueue,
  // M16/S4 — poll de lotes (S2): claim + transições de lote; getJob p/ a guarda do markJobDone condicional.
  getJob,
  claimPollableBatches,
  updateBatchStatus,
  markJobHarvesting,
  clearBatchState,
  // P0-C — reaper (re-enfileira lease expirado) + rastro de embeddings no caminho batch.
  reapExpiredJobs,
  mergeJobResult,
  type IngestJob,
} from "../core/ingestion/ingest-queue.ts";
import { processBlobJob } from "../core/ingestion/process-blob-job.ts";
import { runRepairSweep } from "../core/ingestion/repair.ts"; // P0-C — varredura de reparo (C3b/M3a)
import { getBatch } from "../lib/batch-client.ts"; // M16/S1 — GET /v1/messages/batches/{id}
import { harvestExtractionBatch } from "../core/ingestion/batch-extract.ts"; // M16/S3 — recupera + deriva
import { closeEngines } from "../core/platform/engine.ts";
import { runConsolidationStep, type ConsolidacaoTrace } from "../core/ingestion/consolidate-step.ts"; // M23-D
import { maybeSono, type SonoTrace } from "../core/ingestion/sono-step.ts"; // M24-D
import { scanSupersededFacts } from "../core/platform/webhook-emit.ts"; // C2 — gancho fact.superseded (fail-soft)

export interface WorkerOpts {
  idleMs?: number; // espera quando a fila está vazia (default 1000)
  once?: boolean; // processa no MÁX 1 ciclo e retorna (testes). default false
  shutdownTimeoutMs?: number; // tempo máx p/ o job atual terminar no shutdown (default 30000)
}

let draining = false; // setado pelo handler de sinal — para de claimar novos
let activeJobId: string | null = null;

/** M23-D — consolidação pós-done (fail-soft M3a): roda DEPOIS do terminal (lease já liberado);
 *  NUNCA lança; rastro em result_json.consolidacao via mergeJobResult (jsonb ||, P0-C). */
async function consolidateAfterJob(brain: string, jobId: string): Promise<void> {
  try {
    const c: ConsolidacaoTrace = await runConsolidationStep(brain); // já é fail-soft por contrato
    await mergeJobResult(jobId, { consolidacao: c });
    log("consolidacao", { jobId, brain, status: c.status, merges: c.merges, fontes: c.fontes_rederivadas });
  } catch (err) {
    // cinto-e-suspensório: nem o mergeJobResult pode derrubar o loop
    const message = err instanceof Error ? err.message : String(err);
    await mergeJobResult(jobId, { consolidacao: { status: "falhou", erro: message } }).catch(() => {});
    log("consolidacao-error", { jobId, brain, message });
  }
  // C2 — GANCHO fact.superseded: PÓS-consolidação, a derivação bitemporal (applyBitemporal →
  // replaceFactsForSourcesAndGroups) já gravou os valid_to dos fatos que perderam vigência. O scan
  // BOUNDED + brain-scoped emite 1 fact.superseded por fato superado-no-passado AINDA não notificado e
  // marca webhook_notified_superseded=true (a coluna garante o não-reemitir). FAIL-SOFT por contrato
  // (NUNCA lança) — fora do try/catch da consolidação de propósito: roda mesmo se a consolidação falhar
  // (os valid_to já foram gravados pelo deriveIncremental do pipeline, antes deste passo).
  try {
    const s = await scanSupersededFacts(brain);
    if (s.scanned > 0) log("fact-superseded", { jobId, brain, scanned: s.scanned, enqueued: s.enqueued });
  } catch (err) {
    log("fact-superseded-error", { jobId, brain, message: err instanceof Error ? err.message : String(err) });
  }
}

/** M24-D — sono pós-done no idle (fail-soft M3a): roda DEPOIS do terminal e da consolidação
 *  M23-D; NUNCA lança; rastro em result_json.sono via mergeJobResult (jsonb ||, P0-C). O gatilho
 *  (acúmulo/cooldown/fila) é quem decide se o ciclo roda — chamada INCONDICIONAL no pós-done. */
async function sonoAfterJob(brain: string, jobId: string): Promise<void> {
  try {
    const t: SonoTrace = await maybeSono(brain); // já é fail-soft por contrato
    await mergeJobResult(jobId, { sono: t });
    log("sono", { jobId, brain, status: t.status, chamadas_llm: t.chamadas_llm });
  } catch (err) {
    // cinto-e-suspensório: nem o mergeJobResult pode derrubar o loop
    const message = err instanceof Error ? err.message : String(err);
    await mergeJobResult(jobId, { sono: { status: "falhou", erro: message } }).catch(() => {});
    log("sono-error", { jobId, brain, message });
  }
}

/** Roda o loop. Resolve quando `once` é true (1 ciclo) ou quando draining encerra o loop. */
export async function runIngestWorker(opts: WorkerOpts = {}): Promise<void> {
  const idleMs = opts.idleMs ?? 1000;
  const once = opts.once ?? false;
  log("worker iniciado", { idleMs, once });

  do {
    if (draining) break;
    const job = await claimNextJob();
    if (!job) {
      if (once) return;
      await sleep(idleMs);
      continue;
    }
    activeJobId = job.id;
    log("claimed", { jobId: job.id, brain: job.brain, kind: job.kind });
    try {
      const result = await processBlobJob(
        job,
        (f, m) => updateJobProgress(job.id, f, m),
        async (phase) => {
          // M15/S2 — liga as fases do pipeline na máquina de estados da fila. Fase A concluída ⇒
          // BUSCÁVEL (FTS+embeddings) com a digestão ainda em curso; Fase B ⇒ digestão LLM.
          if (phase === "findable") await markJobFindable(job.id);
          if (phase === "digesting") await markJobDigesting(job.id);
        },
      );
      // M16/S4 — quem fecha o job? Se entrou em BATCH, processBlobJob já transicionou pra
      // batch_submitted (markJobBatchSubmitted, S3) e RETORNOU; o loop de poll é quem fecha — NÃO
      // chamar markJobDone aqui (fecharia antes do harvest). Reler o status (1 SELECT barato) é o
      // caminho de menor acoplamento entre slots (DESIGN-SPEC §1).
      const after = await getJob(job.brain, job.id);
      if (after && (after.status === "batch_submitted" || after.status === "batch_harvesting")) {
        // P0-C/M3a — o poller fecha com markJobDone PRÓPRIO; o rastro de embeddings da Fase A
        // precisa ser persistido AGORA (markJobDone agora mergeia, então ele sobrevive ao done).
        if (result.embeddings === "failed") {
          await mergeJobResult(job.id, { embeddings: "failed", embeddings_error: result.embeddings_error ?? "" });
        }
        log("batch-submitted", { jobId: job.id, batchId: after.batchId });
      } else {
        await markJobDone(job.id, result); // sync: o flag já vem dentro do result (§5.1)
        log("done", { jobId: job.id, total: result.total, skipped: result.skipped });
        // M23-D — consolidação automática PÓS-derive (BRIEF §3 Peça 4). Só quando o job criou
        // página nova (total>0): re-ingestão idempotente (P1-D, total=0) não muda entidade.
        // DEPOIS do markJobDone de propósito: job já terminal ⇒ lease null ⇒ reaper não o vê.
        if (result.total > 0) await consolidateAfterJob(job.brain, job.id);
        await sonoAfterJob(job.brain, job.id); // M24-D — NOVO (incondicional: o gatilho decide)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await markJobError(job.id, message); // ← resiliência: job falho não derruba o loop
      log("error", { jobId: job.id, message });
    } finally {
      activeJobId = null;
    }
  } while (!once);
}

/** M16/S4 — loop de POLL dos lotes (decisão §9a / ADR-010: MESMO worker, 2º loop — não processo
 *  separado). RESUMÍVEL: nenhum estado em memória; lê o batch_id do banco a cada tick (claim) →
 *  getBatch (S1) → ended? harvest (S3) + fecha : updateBatchStatus + segue. Respeita `draining`
 *  (graceful shutdown compartilhado). Resiliente: erro num lote loga e NÃO derruba o worker nem os
 *  outros lotes. NUNCA re-submete (só faz GET — submit é exclusivo do S3 no processBlobJob). */
export async function runBatchPoller(opts: { pollMs?: number; once?: boolean } = {}): Promise<void> {
  const pollMs = opts.pollMs ?? Number(process.env.GALEED_BATCH_POLL_MS ?? 12000);
  const once = opts.once ?? false;
  log("poller iniciado", { pollMs, once });
  do {
    if (draining) break;
    const jobs = await claimPollableBatches(10);
    if (!jobs.length) {
      if (once) return;
      await sleep(pollMs);
      continue;
    }
    for (const job of jobs) {
      if (draining) break;
      try {
        await pollOne(job);
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        log("batch-poll-error", { jobId: job.id, batchId: job.batchId, message: m });
        // NÃO markJobError por erro TRANSITÓRIO de poll (rede, 5xx, 429 — a Anthropic pode estar bem
        // e o lote seguir ok): só loga e tenta no próximo tick. Erro DEFINITIVO (4xx exceto 408/429 —
        // chave revogada, lote apagado/expirado há >29 dias) re-tentado pra sempre vira loop infinito
        // que ainda BLOQUEIA o repair do brain inteiro (listRepairableBrains exclui brains com job em
        // batch_*). Dead-letter após N falhas definitivas: markJobError solta o claim de poll E a
        // exclusão do repair — a varredura re-digere as páginas extract_version='' pelo caminho
        // síncrono (digestPendingPages) e o brain se destrava sozinho. Contador em result_json
        // (poll_failures via mergeJobResult — zero coluna nova); o bookkeeping é FAIL-SOFT (nunca
        // derruba o loop nem os outros lotes). RESUMÍVEL via batch_id persistido.
        const status = definitivePollErrorStatus(m);
        if (status != null) {
          try {
            const falhas = Number(job.resultJson?.poll_failures ?? 0) + 1;
            if (falhas >= maxPollFailures()) {
              await markJobError(
                job.id,
                `lote inacessível na Anthropic (HTTP ${status}) — as páginas capturadas continuam buscáveis e serão re-digeridas pela varredura de reparo.`,
              );
              log("batch-dead-letter", { jobId: job.id, batchId: job.batchId, status, falhas });
            } else {
              await mergeJobResult(job.id, { poll_failures: falhas, poll_last_error: m });
            }
          } catch (e2) {
            log("batch-dead-letter-error", { jobId: job.id, message: e2 instanceof Error ? e2.message : String(e2) });
          }
        }
      }
    }
    if (once) return;
    await sleep(pollMs);
  } while (!once && !draining);
}

/** Classifica erro de poll DEFINITIVO pelo status HTTP que o batch-client embute na mensagem
 *  (`Batch get 401: …` / `Batch results 404: …` — batch-client.ts). 4xx = a Anthropic RESPONDEU
 *  recusando; re-tentar não muda nada (exceto 408 timeout e 429 rate-limit, transitórios por
 *  natureza). Sem status na mensagem (rede caiu, DNS, abort) ou 5xx ⇒ transitório (null).
 *  Exportada por ser PURA (testável sem banco). */
export function definitivePollErrorStatus(message: string): number | null {
  const m = /^Batch (?:get|results) (\d{3}):/.exec(message);
  if (!m) return null;
  const status = Number(m[1]);
  return status >= 400 && status < 500 && status !== 408 && status !== 429 ? status : null;
}

/** Teto de falhas DEFINITIVAS de poll antes do dead-letter (GALEED_BATCH_POLL_MAX_FAILURES, default 5). */
function maxPollFailures(): number {
  const n = Number(process.env.GALEED_BATCH_POLL_MAX_FAILURES);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 5;
}

/** Processa UM job com lote pendente: consulta o batch_id; ended → harvest + fecha. */
async function pollOne(job: IngestJob): Promise<void> {
  if (!job.batchId) return; // defensivo (claimPollableBatches só devolve batch_id not null)
  const handle = await getBatch(job.batchId); // S1 — GET /v1/messages/batches/{id}
  // Tick de poll BEM-SUCEDIDO zera o contador de falhas definitivas (só quando presente — 1 UPDATE
  // a mais apenas em job que já falhou): blips definitivos espaçados (ex.: proxy devolvendo 403
  // intermitente) não acumulam até o dead-letter num lote saudável.
  if (Number(job.resultJson?.poll_failures ?? 0) > 0) {
    await mergeJobResult(job.id, { poll_failures: 0 });
  }
  await updateBatchStatus(job.id, handle.processing_status); // S2 — observabilidade (não muda status do job)
  if (handle.processing_status !== "ended") {
    log("batch-in-progress", { jobId: job.id, batchId: job.batchId, counts: handle.request_counts });
    return; // próximo tick (RESUMÍVEL — segue pollável via batch_id)
  }
  // ended → guarda anti-harvest-duplo (S2): UPDATE condicional; só prossegue quem ganhou a transição.
  if (!(await markJobHarvesting(job.id))) return; // outro tick/worker já está no harvest
  const customMap = job.batchCustomMap ?? {};
  // S3 — getBatchResults + parse por custom_id + putExtraction/markExtracted + deriveIncremental (M14).
  const { harvested, errored } = await harvestExtractionBatch(job.brain, handle, customMap);
  await clearBatchState(job.id); // S2 — limpa o custom_map grande (batch_id/status ficam p/ auditoria)
  await markJobDone(job.id, {
    // terminal de sucesso (status='done') — tira o job do claim de poll
    total: harvested,
    slugs: [],
    skipped: 0,
    message: `Digestão em lote concluída (${harvested} fontes${errored ? `, ${errored} com erro` : ""}).`,
  });
  log("batch-done", { jobId: job.id, batchId: job.batchId, harvested, errored });
  // M23-D — consolidação pós-harvest (o deriveIncremental do lote rodou no harvestExtractionBatch).
  if (harvested > 0) await consolidateAfterJob(job.brain, job.id);
  await sonoAfterJob(job.brain, job.id); // M24-D — NOVO
}

/** Varredura de reparo PERIÓDICA — o tick do timer do main() (exportado pra teste; o timer em si
 *  vive no main). Antes, runRepairSweep rodava SÓ no boot/--repair-only: num worker de longa duração,
 *  página presa sem Fase B (job 'error' no meio da digestão) e embeddings 'failed' nunca curavam sem
 *  restart. Diferente do reaper (2 UPDATEs baratos), uma passada pode levar MINUTOS (até
 *  GALEED_REPAIR_MAX_PAGES páginas de LLM) — daí a flag de reentrada: o setInterval NÃO sobrepõe
 *  passadas. `draining` corta passada nova no shutdown. Loga só quando houve trabalho (padrão do
 *  reaper); erro só loga — nunca derruba o worker. Corrida com job em voo é benigna:
 *  listRepairableBrains pula brains ativos e o write-path é idempotente (putExtraction é upsert;
 *  deriveIncremental é função pura) — a mesma janela que o --repair-only já aceita hoje. */
let repairRunning = false;
export function repairTick(): void {
  if (draining || repairRunning) return;
  repairRunning = true;
  runRepairSweep()
    .then(
      (r) => {
        if (r.pagesDigested || r.pagesSkipped || r.underivedDerived || r.embeddingsRetried) log("repair", r as any);
      },
      (err) => log("repair-error", { message: err instanceof Error ? err.message : String(err) }),
    )
    .finally(() => {
      repairRunning = false;
    });
}

/** Entrypoint: instala sinais de shutdown e roda o loop até drenar. */
async function main(): Promise<void> {
  // P0-C — modo de reparo one-shot: varre, repara, sai. Pra operar sem reiniciar o loop.
  if (process.argv.includes("--repair-only")) {
    let code = 0;
    try {
      await getJob("__warmup__", "__warmup__"); // warm-up serial (M16/S7 — DDL sem deadlock)
      const reaped = await reapExpiredJobs();
      log("reaper", { requeued: reaped.requeued.length, dead: reaped.dead.length });
      const rep = await runRepairSweep();
      log("repair-only concluído", rep as any);
    } catch (err) {
      code = 1;
      console.error("[worker] crash fatal — encerrando com exit 1", err);
    } finally {
      await closeIngestQueue().catch(() => {});
      await closeEngines().catch(() => {});
      process.exit(code);
    }
    return;
  }

  const shutdownTimeoutMs = Number(process.env.WORKER_SHUTDOWN_MS ?? 30000);
  let shuttingDown = false;
  const onSignal = (sig: string) => {
    if (shuttingDown) {
      log("segundo sinal — saindo já", { sig });
      process.exit(1);
    }
    shuttingDown = true;
    draining = true;
    log("shutdown solicitado — drenando", { sig, activeJobId, shutdownTimeoutMs });
    // dá ao job atual até shutdownTimeoutMs; depois força a saída.
    const t = setTimeout(() => {
      log("timeout de shutdown — saindo", {});
      process.exit(activeJobId ? 1 : 0);
    }, shutdownTimeoutMs);
    t.unref?.();
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));

  let exitCode = 0;
  try {
    // M16/S7 (HOTFIX) — WARM-UP SERIAL do schema/engine ANTES dos dois loops. No cold start, os dois
    // loops chamavam `db()` no MESMO instante → dois runs de DDL concorrente (create table/index if not
    // exists, alter table) em catálogo → `PostgresError: deadlock detected`, engolido pelo `finally`
    // (exit(0) + "worker encerrado" — parecia shutdown gracioso, era crash). Uma chamada read-only
    // SERIAL (getJob de uma chave inexistente → SELECT que retorna null) dispara o init UMA vez; quando
    // o Promise.all roda, ambos os loops já encontram a conexão/schema prontos (fast path de db()). É
    // SEM efeito colateral — NÃO claima job (claimNextJob/claimPollableBatches marcariam um job real).
    await getJob("__warmup__", "__warmup__");
    // P0-C — reaper no boot (resgata o backlog preso) + varredura de reparo ANTES dos loops
    // (awaited: não concorre com deriveIncremental de job novo — o guard de brain-ativo foi
    // computado agora). Erro na varredura NÃO derruba o worker (loga e segue).
    const reaped = await reapExpiredJobs();
    log("reaper", { requeued: reaped.requeued.length, dead: reaped.dead.length });
    await runRepairSweep().then(
      (r) => log("repair", r as any),
      (err) => log("repair-error", { message: err instanceof Error ? err.message : String(err) }),
    );
    // Varredura de reparo PERIÓDICA (GALEED_REPAIR_INTERVAL_MS, default 15 min) — timer na família
    // do reaper/janela/github. O tick (repairTick, acima) tem flag de reentrada: passada longa não
    // sobrepõe passada. Custo quando não há nada a reparar: uns SELECTs por brain, zero LLM.
    const repairMs = Number(process.env.GALEED_REPAIR_INTERVAL_MS ?? 15 * 60_000);
    const repairTimer = setInterval(repairTick, repairMs);
    repairTimer.unref?.();
    // P0-C — reaper periódico (default 30s; GALEED_REAPER_INTERVAL_MS). Erro só loga.
    const reapMs = Number(process.env.GALEED_REAPER_INTERVAL_MS ?? 30_000);
    const reaper = setInterval(() => {
      reapExpiredJobs().then(
        (r) => { if (r.requeued.length || r.dead.length) log("reaper", { requeued: r.requeued.length, dead: r.dead.length }); },
        (err) => log("reaper-error", { message: err instanceof Error ? err.message : String(err) }),
      );
    }, reapMs);
    reaper.unref?.();
    // JANELA DE CONVERSA (ingestores de mensagem, ver janela.ts): fecha janelas vencidas
    // (silêncio > GALEED_JANELA_MIN ou teto de mensagens) e entrega a conversa inteira como
    // UMA página. Roda no boot (backlog de janelas que venceram com o worker parado) e a cada
    // 60s (GALEED_JANELA_FLUSH_MS). Erro só loga — nunca derruba o worker.
    const { registerBuiltinIngestors } = await import("../core/ingestion/ingestors/boot.ts");
    const { flushJanelas } = await import("../core/ingestion/ingestors/janela.ts");
    registerBuiltinIngestors();
    const flushJanela = () =>
      flushJanelas().then(
        (r) => { if (r.janelas || r.erros.length) log("janela", { janelas: r.janelas, mensagens: r.mensagens, jobs: r.jobs.length, erros: r.erros }); },
        (err) => log("janela-error", { message: err instanceof Error ? err.message : String(err) }),
      );
    await flushJanela();
    const flushMs = Number(process.env.GALEED_JANELA_FLUSH_MS ?? 60_000);
    const janelaTimer = setInterval(flushJanela, flushMs);
    janelaTimer.unref?.();
    // GITHUB SYNC (github-sync.ts): espelho legível organizado pra pessoas + ingestão do diff
    // (entrada/, com remoção pós-job-done) dos brains com sync ligada. Roda no boot + a cada
    // GALEED_GITHUB_SYNC_MS (default 120s). Erro de um brain não derruba os outros (last_error).
    const { runGithubSync } = await import("../core/platform/github-sync.ts");
    const githubTick = () =>
      runGithubSync().then(
        (rs) => {
          for (const r of rs) {
            if (r.entradaIngeridos || r.entradaRemovidos || r.espelhoEnviados || r.espelhoRemovidos || r.erro) {
              log("github-sync", {
                brain: r.brain, entrada: r.entradaIngeridos, entradaLimpa: r.entradaRemovidos,
                espelho: r.espelhoEnviados, removidos: r.espelhoRemovidos,
                commit: r.commit?.slice(0, 8) ?? null, erro: r.erro,
              });
            }
          }
        },
        (err) => log("github-sync-error", { message: err instanceof Error ? err.message : String(err) }),
      );
    await githubTick();
    const ghMs = Number(process.env.GALEED_GITHUB_SYNC_MS ?? 120_000);
    const ghTimer = setInterval(githubTick, ghMs);
    ghTimer.unref?.();
    // M16/S4 — dois loops no MESMO processo (decisão §9a): jobs (M12/M15, INTACTO) + poll de lotes
    // (M16). `draining` (módulo-local) é compartilhado: o handler de sinal acima o seta e AMBOS os
    // loops saem no próximo `if (draining) break`. Resolvem juntos quando o shutdown encerra.
    await Promise.all([
      runIngestWorker({}), // loop de jobs (M12/M15) — INTACTO
      runBatchPoller({}), // loop de poll (M16) — NOVO
    ]);
  } catch (err) {
    // P0-C/C3c — NUNCA mais exit(0) mascarando crash: loga a CAUSA (com stack) e sai com 1.
    exitCode = 1;
    console.error("[worker] crash fatal — encerrando com exit 1", err);
  } finally {
    await closeIngestQueue().catch(() => {});
    await closeEngines().catch(() => {});
    log("worker encerrado", { exitCode });
    process.exit(exitCode);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function log(msg: string, meta: Record<string, unknown>): void {
  console.error(`[worker] ${msg}${Object.keys(meta).length ? " " + JSON.stringify(meta) : ""}`);
}

// roda main() só quando executado como entrypoint (não em import de teste).
// padrão ESM: compara o módulo atual com o argv[1].
const isEntry = (() => {
  try {
    return import.meta.url === new URL(`file://${process.argv[1]}`).href;
  } catch {
    return false;
  }
})();
if (isEntry) {
  main();
}
