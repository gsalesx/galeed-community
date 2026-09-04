/** M16/S5 · GATE EXECUTÁVEL da Batch API (§7 do brief). A LEI virando prova. Cobre:
 *   #2 E2E REAL do lote (invariante #9 — NÃO moca a Batch API; opt-in por M16_BATCH_E2E=1 + ANTHROPIC_API_KEY);
 *   #3 RESUMIBILIDADE (restart do poller não re-submete — submit 1×) + o CASO-LIMITE do Integrador
 *      (morte ENTRE markJobHarvesting e markJobDone → o job não pode ficar preso em batch_harvesting);
 *   #4 ERRO PARCIAL (1 errored no JSONL não derruba os demais);
 *   #5 ROTEAMENTO (shouldUseBatch: limiar + provider/chave/disable — fail-safe síncrono).
 *
 *  Os its determinísticos (#3/#4/#5) mocam só getBatch/getBatchResults/submitBatch (a Batch API) — o ESTADO
 *  da fila e o harvest+derive rodam no ENGINE REAL (Postgres :5434). O it "lote real" (#2) usa a Anthropic
 *  de verdade (sem nenhum mock da Batch API). Brains descartáveis `__test_m16_s5_*` (NUNCA Accelera).
 *  Skip automático sem DATABASE_URL; "lote real" skip sem opt-in. */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { hasDb, wipeBrain, rawConnect } from "./helpers/db.ts";
import { fakeBatchResult, fakeErroredResult, fakeHandle } from "./helpers/batch-fixtures/index.ts";

/** Helper legado mantido para limpeza explícita da fila nos casos de poller. `wipeBrain` também limpa
 *  `galeed_ingest_jobs`, mas estes testes chamam isto diretamente nos pontos onde só a fila importa. */
async function wipeJobs(brain: string): Promise<void> {
  const sql = await rawConnect();
  try {
    await sql.unsafe(`delete from galeed_ingest_jobs where brain = $1`, [brain]).catch(() => {});
  } finally {
    await sql.end({ timeout: 5 });
  }
}

// ── MOCK da Batch API (S1). submitBatch/getBatch/getBatchResults espionados; o resto passa direto. ──
const mockSubmitBatch = vi.fn();
const mockGetBatch = vi.fn();
const mockGetBatchResults = vi.fn();
vi.mock("../../src/lib/batch-client.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/batch-client.ts")>();
  return {
    ...actual,
    submitBatch: (...a: any[]) => mockSubmitBatch(...a),
    getBatch: (...a: any[]) => mockGetBatch(...a),
    getBatchResults: (...a: any[]) => mockGetBatchResults(...a),
  };
});

import { capture } from "../../src/core/ingestion/capture.ts";
import { getEngine, type PageRow } from "../../src/core/platform/engine.ts";
import { buildExtractionContext, buildExtractionUnits } from "../../src/core/extraction/extract.ts";
import {
  shouldUseBatch,
  resolveBatchThreshold,
  DEFAULT_BATCH_THRESHOLD,
  buildBatchRequests,
  submitExtractionBatch,
  harvestExtractionBatch,
  makeCustomId,
} from "../../src/core/ingestion/batch-extract.ts";
import { runBatchPoller } from "../../src/connectors/ingest-worker.ts";
import {
  enqueueIngestJob,
  getJob,
  markJobBatchSubmitted,
  claimPollableBatches,
  markJobHarvesting,
  type IngestJob,
} from "../../src/core/ingestion/ingest-queue.ts";

// ── helper: força uma transição de job p/ batch_submitted com batch_id+customMap (simula o que o
//    processBlobJob/S3 faz no ramo batch), SEM precisar submeter de verdade. Devolve o jobId. ──
async function seedBatchSubmittedJob(brain: string, batchId: string, customMap: Record<string, string>): Promise<string> {
  const { jobId } = await enqueueIngestJob({ brain, kind: "text", type: "nota", textBody: "seed batch job" });
  await markJobBatchSubmitted(jobId, batchId, customMap);
  return jobId;
}

describe.skipIf(!hasDb())("M16/S5 · Gate — resumibilidade + erro parcial + roteamento (batch MOCADO)", () => {
  beforeEach(() => {
    mockSubmitBatch.mockReset();
    mockGetBatch.mockReset();
    mockGetBatchResults.mockReset();
  });

  // ===================================================================================================
  // Gate #5 — ROTEAMENTO (puro; sem DB)
  // ===================================================================================================
  describe("#5 roteamento por limiar + fail-safe", () => {
    const ENV = { ...process.env };
    beforeEach(() => {
      process.env = { ...ENV };
    });
    afterAll(() => {
      process.env = ENV;
    });

    it("worthy>limiar ∧ provider api ∧ chave → batch ; ==/<limiar → sync", async () => {
      process.env.ANTHROPIC_API_KEY = "sk-test";
      delete process.env.GALEED_BATCH_DISABLE;
      process.env.GALEED_PROVIDER = "api";
      process.env.GALEED_BATCH_THRESHOLD = "10";
      expect(await shouldUseBatch("nobrain", 11)).toBe(true);
      expect(await shouldUseBatch("nobrain", 10)).toBe(false); // == não é estritamente maior
      expect(await shouldUseBatch("nobrain", 1)).toBe(false);
    });

    it("fail-safe SÍNCRONO: sem chave / provider cli / GALEED_BATCH_DISABLE=1", async () => {
      process.env.GALEED_PROVIDER = "api";
      process.env.GALEED_BATCH_THRESHOLD = "1";
      delete process.env.ANTHROPIC_API_KEY;
      expect(await shouldUseBatch("nobrain", 9999)).toBe(false); // sem chave

      process.env.ANTHROPIC_API_KEY = "sk-test";
      process.env.GALEED_PROVIDER = "cli";
      expect(await shouldUseBatch("nobrain", 9999)).toBe(false); // provider cli

      process.env.GALEED_PROVIDER = "api";
      process.env.GALEED_BATCH_DISABLE = "1";
      expect(await shouldUseBatch("nobrain", 9999)).toBe(false); // disable explícito
    });

    it("limiar: env GALEED_BATCH_THRESHOLD > default ; NaN/≤0 cai pro default", async () => {
      delete process.env.GALEED_BATCH_THRESHOLD;
      expect(await resolveBatchThreshold("nobrain")).toBe(DEFAULT_BATCH_THRESHOLD);
      process.env.GALEED_BATCH_THRESHOLD = "7";
      expect(await resolveBatchThreshold("nobrain")).toBe(7);
      process.env.GALEED_BATCH_THRESHOLD = "-3";
      expect(await resolveBatchThreshold("nobrain")).toBe(DEFAULT_BATCH_THRESHOLD);
    });
  });

  // ===================================================================================================
  // Gate #4 — ERRO PARCIAL (engine real, getBatchResults mocado por fixture JSONL)
  // ===================================================================================================
  describe("#4 erro parcial não derruba o lote", () => {
    const BRAIN = "__test_m16_s5_partial";
    beforeAll(async () => {
      await wipeBrain(BRAIN);
    });
    afterAll(async () => {
      await wipeBrain(BRAIN);
    });

    it("JSONL com N-1 succeeded + 1 errored → harvested=N-1, errored=1, succeeded derivam", async () => {
      const e = await getEngine(BRAIN);
      const cap = await capture({ home: BRAIN, text: "A Accelera tem MRR de R$ 50 mil em janeiro de 2026.", type: "nota" });
      const page = await e.getPage(cap.slug);
      if (!page) throw new Error("seed falhou");
      const ctx = await buildExtractionContext(BRAIN, page);
      const dim = ctx.dims[0]; // "facts"

      const cid0 = makeCustomId(page.slug, 0);
      const cid1 = makeCustomId(page.slug, 1);
      const customMap = { [cid0]: page.slug, [cid1]: page.slug };
      const lines = [
        fakeBatchResult(cid0, {
          [dim]: [{ text: "MRR Accelera", context_quote: "R$ 50 mil", entity: "accelera", predicate: "mrr", value: "R$ 50 mil", value_num: 50000, unit: "BRL", period: "monthly", valid_from: "2026-01-01" }],
        }),
        fakeErroredResult(cid1), // ← o errored: NÃO pode derrubar o harvest
      ];
      mockGetBatchResults.mockResolvedValue(lines);

      const out = await harvestExtractionBatch(BRAIN, fakeHandle({ status: "ended" }), customMap);
      expect(out.harvested).toBe(1); // 1 página tocada (a succeeded)
      expect(out.errored).toBe(1); // o errored contado, sem derrubar

      const cur = await e.currentFacts();
      const mrr = cur.find((f) => (f.entity || "") === "accelera" && (f.predicate || "") === "mrr");
      expect(mrr, "o fato da linha succeeded deve estar vigente mesmo com 1 errored no lote").toBeTruthy();
    });
  });

  // ===================================================================================================
  // Gate #3 — RESUMIBILIDADE (estado real na fila; getBatch/Results mocados — o ciclo de orquestração)
  // ===================================================================================================
  describe("#3 resumibilidade — restart não re-submete + o poller fecha o lote", () => {
    const BRAIN = "__test_m16_s5_resume";
    beforeAll(async () => {
      await wipeBrain(BRAIN);
      await wipeJobs(BRAIN);
    });
    afterAll(async () => {
      await wipeBrain(BRAIN);
      await wipeJobs(BRAIN);
    });
    beforeEach(async () => {
      // limpa fatos E jobs anteriores deste brain p/ o claim de poll não pegar lixo de outro it
      // (wipeBrain NÃO toca galeed_ingest_jobs — por isso o wipeJobs explícito).
      await wipeBrain(BRAIN);
      await wipeJobs(BRAIN);
    });

    it("submeter (1×) → 'matar' o poller → reiniciar runBatchPoller({once}) → retoma do batch_id, NÃO re-submete", async () => {
      // 1) seed: um job em batch_submitted com batch_id real-like + customMap (o que o S3 grava). 1 página.
      const e = await getEngine(BRAIN);
      const cap = await capture({ home: BRAIN, text: "A Accelera cobra R$ 30 mil/mes no enterprise (jan/2026).", type: "nota" });
      const page = await e.getPage(cap.slug);
      if (!page) throw new Error("seed falhou");
      const cid = makeCustomId(page.slug, 0);
      const customMap = { [cid]: page.slug };

      // simula o submit que JÁ aconteceu (1×) ANTES da "morte": grava batch_id na fila.
      const fakeRequests = [{ custom_id: cid, params: {} as Record<string, unknown> }];
      mockSubmitBatch.mockResolvedValue(fakeHandle({ id: "msgbatch_resume", status: "in_progress" }));
      const handle = await submitExtractionBatch(fakeRequests as any);
      expect(mockSubmitBatch).toHaveBeenCalledTimes(1); // submit aconteceu 1×
      const jobId = await seedBatchSubmittedJob(BRAIN, handle.id, customMap);

      // 2) "MORTE": nenhum harvest rodou. Agora REINICIA o poller (nova instância, once) com getBatch
      //    devolvendo ended → harvest. O poller RETOMA do batch_id persistido (claimPollableBatches).
      mockGetBatch.mockResolvedValue(fakeHandle({ id: handle.id, status: "ended" }));
      mockGetBatchResults.mockResolvedValue([
        fakeBatchResult(cid, {
          facts: [{ text: "Preço Accelera enterprise", context_quote: "R$ 30 mil/mes", entity: "accelera", predicate: "preco", value: "R$ 30 mil", value_num: 30000, unit: "BRL", period: "monthly", valid_from: "2026-01-01" }],
        }),
      ]);

      await runBatchPoller({ once: true, pollMs: 1 });

      // 3) NÃO re-submeteu (submit AINDA 1×) — o batch_id persistiu → retomou o poll, não recriou o lote.
      expect(mockSubmitBatch).toHaveBeenCalledTimes(1);
      // o getBatch foi chamado COM o batch_id persistido (resumiu do banco).
      expect(mockGetBatch).toHaveBeenCalledWith("msgbatch_resume");

      // 4) o job fechou (done) e o fato foi derivado (harvest rodou no restart).
      const after = await getJob(BRAIN, jobId);
      expect(after?.status).toBe("done");
      const cur = await e.currentFacts();
      expect(cur.find((f) => f.entity === "accelera" && f.predicate === "preco")).toBeTruthy();
    });

    it("in_progress no 1º tick não fecha o job (segue pollável) ; só fecha quando ended", async () => {
      const e = await getEngine(BRAIN);
      const cap = await capture({ home: BRAIN, text: "Accelera fechou contrato em Joinville.", type: "nota" });
      const page = await e.getPage(cap.slug);
      if (!page) throw new Error("seed falhou");
      const cid = makeCustomId(page.slug, 0);
      const jobId = await seedBatchSubmittedJob(BRAIN, "msgbatch_inprog", { [cid]: page.slug });

      // tick 1: in_progress → NÃO harvesta, NÃO fecha; job segue batch_submitted (pollável).
      mockGetBatch.mockResolvedValueOnce(fakeHandle({ id: "msgbatch_inprog", status: "in_progress" }));
      await runBatchPoller({ once: true, pollMs: 1 });
      let j = await getJob(BRAIN, jobId);
      expect(j?.status).toBe("batch_submitted");
      expect(mockGetBatchResults).not.toHaveBeenCalled();

      // tick 2: ended → harvest → done.
      mockGetBatch.mockResolvedValueOnce(fakeHandle({ id: "msgbatch_inprog", status: "ended" }));
      mockGetBatchResults.mockResolvedValueOnce([
        fakeBatchResult(cid, { facts: [{ text: "Accelera Joinville", context_quote: "Joinville", entity: "accelera", predicate: "cidade", value: "Joinville", valid_from: "2026-01-01" }] }),
      ]);
      await runBatchPoller({ once: true, pollMs: 1 });
      j = await getJob(BRAIN, jobId);
      expect(j?.status).toBe("done");
    });

    /** O CASO-LIMITE que o Integrador apontou: morte ENTRE markJobHarvesting (status→batch_harvesting) e
     *  markJobDone. Na volta, claimPollableBatches RE-CLAIMA o job (status batch_harvesting está no claim),
     *  e o poller chama markJobHarvesting de novo. Harvest é idempotente (deriveIncremental M14 puro +
     *  putExtraction upsert por (brain, source_slug)), então re-harvestar é SEGURO.
     *
     *  CONSERTADO pelo S6 (gap-S5-1/DECISION): o WHERE de markJobHarvesting passou a aceitar
     *  `status in ('batch_submitted','batch_harvesting')` → a 2ª chamada (retomada pós-crash) devolve `true`
     *  e o poller re-harvesta, fechando o job em `done`. Por isso este caso-limite é `it` VERDE (não mais
     *  `it.fails`): com o fix do S6 na main, a LEI I (resumibilidade) vale até nesta janela de milissegundos.
     *  Ver `specs/slots/M16/gap-S5-1/DECISION.md` (idempotência + WHERE reentrante). */
    it("CASO-LIMITE (Integrador): morte entre markJobHarvesting e markJobDone → o job re-harvesta ao reiniciar (não fica preso) [gap-S5-1 · fix S6]", async () => {
      const e = await getEngine(BRAIN);
      const cap = await capture({ home: BRAIN, text: "A Accelera subiu o preço pra R$ 30 mil em 2026.", type: "nota" });
      const page = await e.getPage(cap.slug);
      if (!page) throw new Error("seed falhou");
      const cid = makeCustomId(page.slug, 0);
      const customMap = { [cid]: page.slug };
      const jobId = await seedBatchSubmittedJob(BRAIN, "msgbatch_crash", customMap);

      // SIMULA a morte exata: o poller já transicionou pra batch_harvesting (1º markJobHarvesting ganhou)
      // mas MORREU antes de harvestar/markJobDone. Reproduzimos isso chamando markJobHarvesting direto.
      const won = await markJobHarvesting(jobId);
      expect(won).toBe(true); // a transição batch_submitted→batch_harvesting aconteceu
      let crashed = await getJob(BRAIN, jobId);
      expect(crashed?.status).toBe("batch_harvesting"); // o job ficou AQUI quando o worker morreu

      // RESTART do poller: o lote está ended; o harvest é idempotente → deveria retomar e FECHAR o job.
      mockGetBatch.mockResolvedValue(fakeHandle({ id: "msgbatch_crash", status: "ended" }));
      mockGetBatchResults.mockResolvedValue([
        fakeBatchResult(cid, { facts: [{ text: "Preço Accelera 2026", context_quote: "R$ 30 mil", entity: "accelera", predicate: "preco", value: "R$ 30 mil", value_num: 30000, unit: "BRL", period: "monthly", valid_from: "2026-01-01" }] }),
      ]);

      // confirma primeiro que o claim AINDA enxerga o job preso em batch_harvesting (pré-condição p/ retomar):
      const pollable = (await claimPollableBatches(50)).filter((p: IngestJob) => p.id === jobId);
      expect(pollable.length, "claimPollableBatches deve re-enxergar o job preso em batch_harvesting").toBe(1);

      await runBatchPoller({ once: true, pollMs: 1 });

      // A LEI I (resumibilidade): o job NÃO pode ficar preso em batch_harvesting. Com o fix do S6
      // (markJobHarvesting reentrante) ele fecha em `done` e deriva o fato. Se ficar 'batch_harvesting',
      // é regressão do guard markJobHarvesting (gap-S5-1 reaberto) → reabrir S6.
      const after = await getJob(BRAIN, jobId);
      expect(after?.status, "job preso em batch_harvesting = regressão do guard markJobHarvesting (gap-S5-1)").toBe("done");
      const cur = await e.currentFacts();
      expect(cur.find((f) => f.entity === "accelera" && f.predicate === "preco")).toBeTruthy();
    });
  });
});

// =====================================================================================================
// Gate #2 — E2E REAL do lote (invariante #9). OPT-IN: M16_BATCH_E2E=1 + ANTHROPIC_API_KEY. NÃO moca nada.
// =====================================================================================================
const E2E_ON = process.env.M16_BATCH_E2E === "1" && !!process.env.ANTHROPIC_API_KEY && hasDb();

describe.skipIf(!E2E_ON)("M16/S5 · Gate #2 — E2E REAL do lote (Anthropic, sem mock — opt-in)", () => {
  const BRAIN = "__test_m16_s5_e2e_real";

  beforeAll(async () => {
    await wipeBrain(BRAIN);
    // o E2E real precisa do caminho HTTP/api (Batch API só existe em provider api).
    process.env.GALEED_PROVIDER = "api";
    delete process.env.GALEED_BATCH_DISABLE;
  });
  afterAll(async () => {
    await wipeBrain(BRAIN);
  });

  it(
    "submit REAL → poll até ended → harvest REAL → fatos corretos (≈centavos, minutos)",
    async () => {
      // IMPORTANTE: este it NÃO usa os mocks (estão neste arquivo, mas as funções REAIS são chamadas via
      // submitExtractionBatch/harvestExtractionBatch → batch-client REAL? Não: o vi.mock acima intercepta
      // batch-client no MÓDULO INTEIRO. Para o E2E REAL precisamos das funções de verdade → restauramos.
      const real = await vi.importActual<typeof import("../../src/lib/batch-client.ts")>("../../src/lib/batch-client.ts");
      mockSubmitBatch.mockImplementation((...a: any[]) => (real.submitBatch as any)(...a));
      mockGetBatch.mockImplementation((...a: any[]) => (real.getBatch as any)(...a));
      mockGetBatchResults.mockImplementation((...a: any[]) => (real.getBatchResults as any)(...a));

      const e = await getEngine(BRAIN);
      // 2-4 páginas densas com claim canônico esperado (preço/tier) — input REAL, custo de centavos.
      const texts = [
        "A Accelera cobra R$ 30 mil por mês no plano enterprise a partir de janeiro de 2026.",
        "O MRR da Accelera chegou a R$ 50 mil em janeiro de 2026; o status do contrato é ativo.",
        "A Accelera fechou um contrato grande em Joinville e mantém o tier enterprise.",
      ];
      const worthyByPage = [];
      for (const t of texts) {
        const cap = await capture({ home: BRAIN, text: t, type: "nota" });
        const page = await e.getPage(cap.slug);
        if (!page) throw new Error("seed falhou");
        const ctx = await buildExtractionContext(BRAIN, page);
        const units = buildExtractionUnits(page);
        worthyByPage.push({ page, ctx, units });
      }

      // 1) monta os requests REAIS (1/unit) e submete o lote REAL.
      const { requests, customMap } = await buildBatchRequests(BRAIN, worthyByPage);
      expect(requests.length).toBeGreaterThan(0);
      const handle = await submitExtractionBatch(requests);
      expect(handle.id).toMatch(/^msgbatch_/);
      // eslint-disable-next-line no-console
      console.log(`[E2E] lote submetido: ${handle.id} (${requests.length} requests)`);

      // 2) poll REAL até ended (timeout generoso — em geral minutos).
      const { getBatch } = real;
      let cur = handle;
      const t0 = Date.now();
      while (cur.processing_status !== "ended") {
        await new Promise((r) => setTimeout(r, 10_000));
        cur = await getBatch(handle.id);
        // eslint-disable-next-line no-console
        console.log(`[E2E] status=${cur.processing_status} counts=${JSON.stringify(cur.request_counts)} (${Math.round((Date.now() - t0) / 1000)}s)`);
      }

      // 3) harvest REAL → persiste + deriva.
      const out = await harvestExtractionBatch(BRAIN, cur, customMap);
      // eslint-disable-next-line no-console
      console.log(`[E2E] harvest: harvested=${out.harvested} errored=${out.errored} em ${Math.round((Date.now() - t0) / 1000)}s`);
      expect(out.harvested).toBeGreaterThan(0);

      // 4) fatos corretos: nº de fatos > 0 e o claim-canônico (entity=accelera) presente.
      const facts = await e.currentFacts();
      expect(facts.length).toBeGreaterThan(0);
      expect(facts.some((f) => (f.entity || "").toLowerCase().includes("accelera")), "esperado ≥1 fato sobre 'accelera' vindo do lote real").toBe(true);
    },
    1_200_000, // 20 min
  );
});
