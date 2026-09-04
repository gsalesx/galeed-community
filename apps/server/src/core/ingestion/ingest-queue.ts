/** M12/S1 — FILA de ingestão assíncrona (ADR-006). Durável no Postgres, claim ATÔMICO (for update skip
 *  locked → vários workers nunca pegam o mesmo job). Usa a pool compartilhada de platform/db-conn.ts:
 *  brain-independente na conexão, escopada por `brain` na query. NÃO toca o Engine. Tenant-neutro (ADR-002). */
import { randomUUID } from "node:crypto";
import { closeSharedSql, getSharedSql, sharedSqlGeneration } from "../platform/db-conn.ts";
import { emitWebhookEvent } from "../platform/webhook-emit.ts"; // C2 — gancho ingest.organized (fail-soft)

/** M15/S2 — máquina de estados ampliada com as DUAS FASES (encontrável → digestão). O `status` é texto
 *  livre (sem CHECK, migração 15) → ampliar o domínio é retrocompatível: jobs M12–M14 gravados com
 *  `processing`/`done` seguem válidos. `findable`/`digesting` são as fases novas; `digested` é o terminal
 *  de sucesso conceitual (o worker mantém `done` como terminal real — ver markJobDone). ADR-009.
 *
 *  P0-C (auditoria 2026-06-11, C3) — STATUS-MACHINE COMPLETA (a fila sobrevive a crash):
 *
 *                       claim (lease_until = now()+lease, attempts+1)
 *  queued ────────────────────────────────▶ processing ──▶ findable ──▶ digesting ──┬──▶ done
 *    ▲                                          │              │            │       │
 *    │   reaper: lease expirado, attempts < N   │              │            │       ├──▶ error      (falha definitiva; sem retry — markJobError)
 *    └──────────────(backoff exponencial)───────┴──────────────┴────────────┘       │
 *                                                                                   └──▶ batch_submitted ──▶ batch_harvesting ──▶ done
 *        reaper: lease expirado, attempts ≥ N ──▶ dead   (terminal, motivo legível)         (SEM lease: resumível via batch_id — M16)
 *
 *  • lease_until tem DOIS sentidos pelo status: em processing/findable/digesting = "claim válido até";
 *    em queued = "inelegível pra claim até" (backoff do reaper). null em queued = elegível já.
 *  • batch_submitted/batch_harvesting NÃO são governados por lease (esperam a Anthropic por minutos/horas;
 *    a resumibilidade deles é o batch_id persistido + claimPollableBatches). markJobBatchSubmitted LIMPA o lease.
 *  • done/error/dead/digested são terminais; o reaper nunca os toca. error continua SEM retry automático (v1).
 *  • attempts = nº de vezes que o job foi CLAIMADO (incrementa no claim, não no reaper). */
export type IngestJobStatus =
  | "queued"
  | "processing" // PRESERVADOS (retrocompat M12–M14)
  | "findable"
  | "digesting"
  | "digested" // M15 — as duas fases + terminal de sucesso novo
  | "batch_submitted" // M16 — lote submetido, aguardando poll (RESUMÍVEL via batch_id)
  | "batch_harvesting" // M16 — lote ended, recuperando resultados
  | "done" // PRESERVADO (terminal de sucesso real do worker)
  | "error"
  | "dead"; // P0-C — estourou as tentativas após interrupções repetidas (reaper). Terminal, visível.
export type IngestJobKind = "file" | "text";

/** Uma linha da fila. Espelha galeed_ingest_jobs (migração 15). O worker recebe ISTO em processBlobJob. */
export interface IngestJob {
  id: string;
  brain: string;
  kind: IngestJobKind;
  status: IngestJobStatus;
  type: string; // tipo DECLARADO (D4)
  contentHash: string | null; // file: hash do blob; text: hash do texto
  filename: string | null;
  mime: string | null;
  title: string | null;
  jobDate: string | null; // YYYY-MM-DD
  textBody: string | null; // kind='text': o texto; kind='file': null
  progress: number; // 0..1
  message: string | null;
  resultJson: Record<string, unknown>;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  // M16 — estado de lote (Batch API). ADITIVOS: jobs M12–M15 têm os 3 null = caminho síncrono.
  batchId: string | null; // job.batch_id — null ⇒ caminho síncrono (resumibilidade via batch_id)
  batchStatus: string | null; // último processing_status visto no poll
  batchCustomMap: Record<string, string> | null; // custom_id → page.slug (S3 reconstrói o harvest)
  // M21 — fonte do job (ADR-016). null ⇒ job sem contrato: pipeline byte-idêntico ao M20 (a LEI do S2).
  sourceId: string | null;
  // P0-C — lease/retry (migração 25). REQUIRED no tipo (espelha a coluna not null/0).
  leaseUntil: string | null; // ISO; validade do claim OU backoff do queued (ver §1)
  attempts: number;          // nº de vezes que o job foi claimado
}

/** Entrada do enqueue. `kind` decide os campos relevantes. Sempre escopado por `brain`. */
export interface EnqueueInput {
  brain: string;
  kind: IngestJobKind;
  type: string;
  contentHash?: string; // file: hash do blob já gravado (via putBlobOnly, S2)
  filename?: string;
  mime?: string;
  title?: string;
  jobDate?: string;
  textBody?: string; // text: o texto colado
  sourceId?: string; // M21 — fonte (galeed_sources.id) sob cujo CONTRATO este job ingere. Ausente = sem contrato.
}

/** Resumo gravado em result_json no done (legível pro front). */
export interface IngestJobResult {
  total: number; // nº de slices/páginas criadas
  slugs: string[];
  skipped: number; // slices já existentes (idempotência)
  message: string; // resumo legível ("Entrou 1 documento (3 partes).")
  // P0-C/M3a — rastro de embeddings: 'failed' quando buildEmbeddings falhou na Fase A (a varredura
  // re-tenta e flipa pra 'ok'). Ausente = nunca falhou (retrocompat: jobs antigos não têm a chave).
  embeddings?: "ok" | "failed";
  embeddings_error?: string; // mensagem da falha (legível, sem stack)
}

/** P0-C — resultado de uma passada do reaper. */
export interface ReapResult {
  requeued: Array<{ id: string; attempts: number }>;
  dead: Array<{ id: string; attempts: number }>;
}

/** Resultado do enqueue (devolvido pelo BFF como 202). */
export interface EnqueueResult {
  jobId: string;
  status: IngestJobStatus;
}

// ---------- schema lazy sobre a conexão compartilhada ----------
// Brain-independente na conexão, escopada por `brain` na query. NÃO mexe no Engine (dono único, fora do
// território). A tabela vem da migração id 15 (migrations.ts); aqui um `create table if not exists`
// idempotente no boot lazy, pra não depender da ordem de execução das migrações do engine.

let _ready: Promise<void> | null = null;
let _readyGeneration = -1;

async function db(): Promise<any> {
  const sql = await getSharedSql();
  const gen = sharedSqlGeneration();
  if (_ready && _readyGeneration === gen) {
    await _ready;
    return sql;
  }
  _readyGeneration = gen;
  _ready = (async () => {
    // idempotente — espelha a migração id 15 (migrations.ts). Boot lazy não depende da ordem do engine.
    await sql.unsafe(`
      create table if not exists galeed_ingest_jobs (
        id text primary key,
        brain text not null,
        kind text not null,
        status text not null default 'queued',
        type text,
        content_hash text,
        filename text,
        mime text,
        title text,
        job_date text,
        text_body text,
        progress real not null default 0,
        message text,
        result_json jsonb default '{}'::jsonb,
        error_message text,
        created_at timestamptz default now(),
        started_at timestamptz,
        finished_at timestamptz
      );
      create index if not exists galeed_ingest_jobs_queue on galeed_ingest_jobs(status, created_at);
      create index if not exists galeed_ingest_jobs_brain on galeed_ingest_jobs(brain, created_at desc);
      -- M16/S2: estado de lote (Batch API) — espelha a migração id 19 (boot lazy não depende da ordem do engine).
      alter table galeed_ingest_jobs add column if not exists batch_id text;
      alter table galeed_ingest_jobs add column if not exists batch_status text;
      alter table galeed_ingest_jobs add column if not exists batch_custom_map jsonb;
      create index if not exists galeed_ingest_jobs_batch on galeed_ingest_jobs(batch_id) where batch_id is not null;
      -- M21/S2: fonte do job — espelha a migração id 24 (S1); boot lazy não depende da ordem do engine.
      alter table galeed_ingest_jobs add column if not exists source_id text;
      -- P0-C: lease + tentativas — espelha a migração id 25 (boot lazy não depende da ordem do engine).
      alter table galeed_ingest_jobs add column if not exists lease_until timestamptz;
      alter table galeed_ingest_jobs add column if not exists attempts integer not null default 0;
      create index if not exists galeed_ingest_jobs_lease on galeed_ingest_jobs(lease_until) where lease_until is not null;
    `);
  })();
  await _ready;
  return sql;
}

/** Fecha a conexão do módulo (testes/shutdown). No-op se nunca abriu. */
export async function closeIngestQueue(): Promise<void> {
  _ready = null;
  _readyGeneration = -1;
  await closeSharedSql();
}

// ---------- mapeamento linha → IngestJob (snake → camel) ----------
function toIso(v: any): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

function rowToJob(r: any): IngestJob {
  return {
    id: r.id,
    brain: r.brain,
    kind: r.kind as IngestJobKind,
    status: r.status as IngestJobStatus,
    type: r.type ?? "",
    contentHash: r.content_hash ?? null,
    filename: r.filename ?? null,
    mime: r.mime ?? null,
    title: r.title ?? null,
    jobDate: r.job_date ?? null,
    textBody: r.text_body ?? null,
    progress: Number(r.progress ?? 0),
    message: r.message ?? null,
    resultJson: (r.result_json ?? {}) as Record<string, unknown>,
    errorMessage: r.error_message ?? null,
    createdAt: toIso(r.created_at) ?? "",
    startedAt: toIso(r.started_at),
    finishedAt: toIso(r.finished_at),
    batchId: r.batch_id ?? null,
    batchStatus: r.batch_status ?? null,
    batchCustomMap: (r.batch_custom_map ?? null) as Record<string, string> | null,
    sourceId: r.source_id ?? null,
    leaseUntil: toIso(r.lease_until),
    attempts: Number(r.attempts ?? 0),
  };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

// ---------- API da fila ----------

/** Cria 1 linha `queued`. `jobId` = uuid. Devolve `{ jobId, status:'queued' }`. */
export async function enqueueIngestJob(input: EnqueueInput): Promise<EnqueueResult> {
  const sql = await db();
  const id = randomUUID();
  await sql`
    insert into galeed_ingest_jobs
      (id, brain, kind, status, type, content_hash, filename, mime, title, job_date, text_body, source_id)
    values (
      ${id}, ${input.brain}, ${input.kind}, 'queued', ${input.type ?? ""},
      ${input.contentHash ?? null}, ${input.filename ?? null}, ${input.mime ?? null},
      ${input.title ?? null}, ${input.jobDate ?? null}, ${input.textBody ?? null}, ${input.sourceId ?? null}
    )`;
  return { jobId: id, status: "queued" };
}

/** P0-C — lease default em ms (GALEED_JOB_LEASE_MS, 15 min). */
function defaultLeaseMs(): number {
  const n = Number(process.env.GALEED_JOB_LEASE_MS);
  return Number.isFinite(n) && n > 0 ? n : 900_000; // 15 min
}

/** Claim ATÔMICO do próximo job queued ELEGÍVEL (lease_until null ou vencido — backoff do reaper).
 *  Grava lease_until = now()+leaseMs e attempts+1. Default do lease: GALEED_JOB_LEASE_MS (15 min).
 *  `for update skip locked` garante que dois claims concorrentes nunca pegam o mesmo job. */
export async function claimNextJob(leaseMs = defaultLeaseMs()): Promise<IngestJob | null> {
  const sql = await db();
  const rows = (await sql.unsafe(
    `update galeed_ingest_jobs
        set status = 'processing', started_at = now(),
            attempts = attempts + 1,
            lease_until = now() + make_interval(secs => $1)
      where id = (
        select id from galeed_ingest_jobs
         where status = 'queued'
           and (lease_until is null or lease_until <= now())
         order by created_at
         limit 1
         for update skip locked
      )
      returning *`,
    [leaseMs / 1000],
  )) as any[];
  if (!rows.length) return null;
  return rowToJob(rows[0]);
}

/** Atualiza `progress` (clamp [0,1]) e `message` (coalesce: mantém o anterior se message=undefined). */
export async function updateJobProgress(jobId: string, progress: number, message?: string): Promise<void> {
  const sql = await db();
  // message ausente → preserva o valor atual (coalesce($, message)); presente → sobrescreve.
  // P0-C — o report de progresso é o HEARTBEAT de graça: renova o lease enquanto o job está em voo
  // (processing/findable/digesting). Em outros status (terminal/batch) o lease fica como está.
  await sql`
    update galeed_ingest_jobs
       set progress = ${clamp01(progress)},
           message = coalesce(${message ?? null}, message),
           lease_until = case when status in ('processing','findable','digesting')
                              then now() + make_interval(secs => ${defaultLeaseMs() / 1000})
                              else lease_until end
     where id = ${jobId}`;
}

/** Fecha em `done`: progress=1, result_json, message do resultado, finished_at.
 *  P0-C — result_json agora MERGEIA (jsonb ||) em vez de substituir: preserva um flag `embeddings:'failed'`
 *  gravado antes (pelo poller/mergeJobResult) sobrevive ao done. lease_until = null (higiene de terminal).
 *  GUARDA de terminal (`status <> 'dead'`, defesa em profundidade do reaper): o worker original pode
 *  terminar DEPOIS do reaper declarar o job morto (lease estourado em voo) — sem a guarda o status
 *  oscilava dead→done e o gancho ingest.organized disparava num job já dado como morto (com a guarda,
 *  rows vazio ⇒ o gancho abaixo nem monta payload). */
export async function markJobDone(jobId: string, result: IngestJobResult): Promise<void> {
  const sql = await db();
  const rows = (await sql`
    update galeed_ingest_jobs
       set status = 'done',
           progress = 1,
           result_json = coalesce(result_json, '{}'::jsonb) || ${sql.json(result as any)},
           message = ${result.message},
           finished_at = now(),
           lease_until = null
     where id = ${jobId} and status <> 'dead'
     returning brain, result_json`) as any[];

  // C2 — GANCHO ingest.organized: o job virou 'done' ⇒ um lote terminou de ser organizado. FAIL-SOFT
  // (igual recordUsage): try/catch + console.error; emitWebhookEvent já é fail-soft, este try é o
  // cinto-e-suspensório (montar o payload nunca pode derrubar o fechamento do job). Os números vêm do
  // result (total/skipped); pending_review do result_json se o pipeline o registrou (chave aditiva).
  try {
    const row = rows[0];
    if (row?.brain) {
      const rj = (row.result_json ?? {}) as Record<string, unknown>;
      const pendingReview =
        typeof rj.pending_review === "number" ? (rj.pending_review as number) : undefined;
      const payload: Record<string, unknown> = {
        batch_id: jobId,
        result: {
          facts: result.total,
          ...(pendingReview !== undefined ? { pending_review: pendingReview } : {}),
        },
        at: new Date().toISOString(),
      };
      await emitWebhookEvent(row.brain as string, "ingest.organized", payload);
    }
  } catch (err) {
    console.error(
      `[ingest-queue] gancho ingest.organized falhou (fail-soft) jobId=${jobId}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

/** M15/S2 — Fase A concluída: o cérebro está BUSCÁVEL (FTS + embeddings), digestão em andamento. O front
 *  (polling) lê `findable` e mostra "buscável já · digerindo…". `greatest(progress, 0.5)` nunca regride o
 *  progresso; `coalesce(message, …)` preserva uma mensagem mais específica já gravada. Status texto-livre
 *  (migração 15, sem CHECK) → gravar `findable` é aceito sem ALTER. */
export async function markJobFindable(jobId: string): Promise<void> {
  const sql = await db();
  await sql`
    update galeed_ingest_jobs
       set status = 'findable',
           progress = greatest(progress, 0.5),
           message = coalesce(message, 'buscável — digerindo fatos…'),
           lease_until = now() + make_interval(secs => ${defaultLeaseMs() / 1000})
     where id = ${jobId}`;
}

/** M15/S2 — Entrando na Fase B (digestão LLM nas units worthy). Só transiciona o status; progress/message
 *  ficam por conta do report do pipeline. Terminal de sucesso segue sendo `done` (markJobDone). */
export async function markJobDigesting(jobId: string): Promise<void> {
  const sql = await db();
  // P0-C — renova o lease na transição (a Fase B pode demorar; o report do pipeline renova de novo).
  await sql`
    update galeed_ingest_jobs
       set status = 'digesting',
           lease_until = now() + make_interval(secs => ${defaultLeaseMs() / 1000})
     where id = ${jobId}`;
}

// ---------- M16/S2 — estado de lote (Batch API) na fila (RESUMIBILIDADE, LEI I, ADR-010) ----------

/** M16 — marca o job como lote submetido (RESUMIBILIDADE): grava batch_id + o mapa custom_id→slug +
 *  status='batch_submitted'. progress fica em ~0.55 (entre findable 0.5 e done 1) sem regredir. */
export async function markJobBatchSubmitted(
  jobId: string,
  batchId: string,
  customMap: Record<string, string>,
): Promise<void> {
  const sql = await db();
  await sql`
    update galeed_ingest_jobs
       set status = 'batch_submitted',
           batch_id = ${batchId},
           batch_status = 'in_progress',
           batch_custom_map = ${sql.json(customMap as any)},
           progress = greatest(progress, 0.55),
           message = coalesce(message, 'digestão em lote enviada — processando…'),
           lease_until = null
     where id = ${jobId}`;
}

/** M16 — claim dos jobs com lote PENDENTE de poll: batch_id not null E status in (batch_submitted,
 *  batch_harvesting). Para o poller (S4). Devolve até `limit` (default 10), mais antigos primeiro. NÃO usa
 *  skip-locked agressivo nem muda status no claim — o poll é idempotente (getBatch é só leitura) e um
 *  segundo worker pollando o mesmo lote é inócuo; o harvest é guardado por status (S4 transiciona p/
 *  batch_harvesting antes de derivar). */
export async function claimPollableBatches(limit = 10): Promise<IngestJob[]> {
  const sql = await db();
  const rows = (await sql`
    select * from galeed_ingest_jobs
     where batch_id is not null
       and status in ('batch_submitted', 'batch_harvesting')
     order by started_at nulls first, created_at
     limit ${limit}`) as any[];
  return rows.map(rowToJob);
}

/** M16 — atualiza o batch_status observado no poll, sem mudar o status do job (continua batch_submitted).
 *  Quando o lote vira 'ended', o S4 chama markJobHarvesting (abaixo) antes de derivar. */
export async function updateBatchStatus(jobId: string, batchStatus: string): Promise<void> {
  const sql = await db();
  await sql`update galeed_ingest_jobs set batch_status = ${batchStatus} where id = ${jobId}`;
}

/** M16 — transição p/ a recuperação do lote (ended → harvesting). RETOMÁVEL: devolve true enquanto o job
 *  estiver POLLÁVEL (status batch_submitted = 1ª transição, OU batch_harvesting = retomada pós-crash do
 *  worker entre esta transição e o markJobDone). É seguro re-harvestar porque o write-path é IDEMPOTENTE:
 *  putExtraction é upsert por (brain, source_slug) e deriveIncremental (M14) é função pura das extrações
 *  (mesma entrada → mesma saída, sem inflar confiança). NÃO é um lock de exclusão — é o sinal de "este poll
 *  pode derivar"; jobs já fechados (done/error) devolvem false (não re-harvestam). Ver gap-S5-1/DECISION. */
export async function markJobHarvesting(jobId: string): Promise<boolean> {
  const sql = await db();
  const rows = (await sql`
    update galeed_ingest_jobs
       set status = 'batch_harvesting', batch_status = 'ended'
     where id = ${jobId} and status in ('batch_submitted', 'batch_harvesting')
     returning id`) as any[];
  return rows.length > 0;
}

/** M16 — limpa o estado de lote (chamado junto do markJobDone no fim do harvest). Zera o batch_custom_map
 *  (payload grande) por higiene; batch_id/batch_status ficam pra auditoria. (markJobDone já seta
 *  status='done', fora do claim de poll — não re-claima.) */
export async function clearBatchState(jobId: string): Promise<void> {
  const sql = await db();
  await sql`update galeed_ingest_jobs set batch_custom_map = null where id = ${jobId}`;
}

/** Fecha em `error`: error_message + message + finished_at. (falha-fechado, sem retry automático em v1)
 *  Mesma GUARDA de terminal do markJobDone: job já 'dead' não vira 'error' silenciosamente. */
export async function markJobError(jobId: string, message: string): Promise<void> {
  const sql = await db();
  await sql`
    update galeed_ingest_jobs
       set status = 'error',
           error_message = ${message},
           message = ${message},
           finished_at = now(),
           lease_until = null
     where id = ${jobId} and status <> 'dead'`;
}

/** M21/S2 — resolve o job dono de um lote (batch_id é único por submit). É como o harvest
 *  (batch-extract.ts) recupera o `sourceId` do job SEM mudar a assinatura pública de
 *  harvestExtractionBatch (o caller ingest-worker/S4 e os testes M16 não mudam). null = lote
 *  desconhecido (handle fake de teste, job já limpo) ⇒ gate vira pass-through (byte-idêntico). */
export async function getJobByBatchId(batchId: string): Promise<IngestJob | null> {
  if (!batchId) return null;
  const sql = await db();
  const rows = (await sql`
    select * from galeed_ingest_jobs
     where batch_id = ${batchId}
     order by created_at desc
     limit 1`) as any[];
  if (!rows.length) return null;
  return rowToJob(rows[0]);
}

/** Jobs DO BRAIN, mais recentes primeiro (default limit 50). Escopado — não vaza cross-tenant. */
export async function listJobs(home: string, limit = 50): Promise<IngestJob[]> {
  const sql = await db();
  const rows = (await sql`
    select * from galeed_ingest_jobs
     where brain = ${home}
     order by created_at desc
     limit ${limit}`) as any[];
  return rows.map(rowToJob);
}

/** 1 job DO BRAIN (null se não existe OU não é do brain — o `brain` no WHERE evita vazamento). */
export async function getJob(home: string, jobId: string): Promise<IngestJob | null> {
  const sql = await db();
  const rows = (await sql`
    select * from galeed_ingest_jobs
     where brain = ${home} and id = ${jobId}
     limit 1`) as any[];
  if (!rows.length) return null;
  return rowToJob(rows[0]);
}

// ---------- P0-C — reaper (a fila sobrevive a crash) + reparo (detecção) ----------

/** P0-C — defaults do reaper. */
function defaultMaxAttempts(): number {
  const n = Number(process.env.GALEED_JOB_MAX_ATTEMPTS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 3;
}
function defaultBackoffMs(): number {
  const n = Number(process.env.GALEED_JOB_BACKOFF_MS);
  return Number.isFinite(n) && n > 0 ? n : 60_000;
}

/** P0-C — re-enfileira jobs com lease EXPIRADO (worker morreu no meio); attempts ≥ maxAttempts →
 *  'dead' com motivo legível. Também resgata jobs LEGADOS presos (processing/findable/digesting com
 *  lease_until null e started_at mais velho que o lease — o backlog do C3a). Idempotente; barato
 *  (índice parcial id 25). Defaults: GALEED_JOB_MAX_ATTEMPTS=3, GALEED_JOB_BACKOFF_MS=60000.
 *  Dois UPDATEs nesta ORDEM (dead primeiro, pra um job estourado não ser re-enfileirado). */
export async function reapExpiredJobs(
  opts: { maxAttempts?: number; backoffBaseMs?: number; leaseMs?: number } = {},
): Promise<ReapResult> {
  const sql = await db();
  const max = opts.maxAttempts ?? defaultMaxAttempts();
  const base = opts.backoffBaseMs ?? defaultBackoffMs();
  const leaseSecs = (opts.leaseMs ?? defaultLeaseMs()) / 1000;

  // (1) DEAD: lease expirado (ou legado preso sem lease) E já foi claimado maxAttempts vezes.
  //     No SET, referências a colunas usam o valor ANTIGO (Postgres) → a mensagem registra o último estado.
  const deadRows = (await sql.unsafe(
    `update galeed_ingest_jobs
        set status = 'dead', finished_at = now(), lease_until = null,
            error_message = 'O processamento foi interrompido ' || attempts ||
                            '× sem completar — marquei como morto. Último estado: ' || status || '.',
            message       = 'O processamento foi interrompido ' || attempts ||
                            '× sem completar — marquei como morto. Último estado: ' || status || '.'
      where status in ('processing','findable','digesting')
        and ( (lease_until is not null and lease_until <= now())
           or (lease_until is null and coalesce(started_at, created_at) <= now() - make_interval(secs => $1)) )
        and attempts >= $2
      returning id, attempts`,
    [leaseSecs, max],
  )) as any[];

  // (2) REQUEUE com backoff exponencial: volta pra 'queued', inelegível até now()+base*2^(attempts-1).
  const requeuedRows = (await sql.unsafe(
    `update galeed_ingest_jobs
        set status = 'queued',
            message = 'O processamento foi interrompido — voltou pra fila (tentativa ' ||
                      (attempts + 1) || ' de ' || $2 || ').',
            lease_until = now() + make_interval(secs => ($3 / 1000.0) * power(2, greatest(attempts, 1) - 1))
      where status in ('processing','findable','digesting')
        and ( (lease_until is not null and lease_until <= now())
           or (lease_until is null and coalesce(started_at, created_at) <= now() - make_interval(secs => $1)) )
        and attempts < $2
      returning id, attempts`,
    [leaseSecs, max, base],
  )) as any[];

  return {
    dead: deadRows.map((r) => ({ id: r.id, attempts: Number(r.attempts ?? 0) })),
    requeued: requeuedRows.map((r) => ({ id: r.id, attempts: Number(r.attempts ?? 0) })),
  };
}

/** P0-C — mergeia chaves em result_json SEM substituir o objeto (jsonb ||). Pra o worker registrar
 *  o rastro de embeddings em jobs que seguem pro caminho batch (o pipeline não conhece a fila). */
export async function mergeJobResult(jobId: string, patch: Record<string, unknown>): Promise<void> {
  const sql = await db();
  await sql`
    update galeed_ingest_jobs
       set result_json = coalesce(result_json, '{}'::jsonb) || ${sql.json(patch as any)}
     where id = ${jobId}`;
}

/** P0-C — brains com ≥1 job na fila e NENHUM job ativo (queued/processing/findable/digesting/
 *  batch_*). Só esses são seguros pra varredura de reparo (não corre contra um job em voo). */
export async function listRepairableBrains(): Promise<string[]> {
  const sql = await db();
  const rows = (await sql`
    select distinct brain from galeed_ingest_jobs j
     where not exists (select 1 from galeed_ingest_jobs a
                        where a.brain = j.brain
                          and a.status in ('queued','processing','findable','digesting','batch_submitted','batch_harvesting'))`) as any[];
  return rows.map((r) => r.brain as string);
}

/** P0-C/M3a — jobs terminais com rastro de embeddings falho (result_json->>'embeddings'='failed'). */
export async function listJobsWithFailedEmbeddings(): Promise<Array<{ id: string; brain: string }>> {
  const sql = await db();
  const rows = (await sql`
    select id, brain from galeed_ingest_jobs
     where status in ('done','error','dead') and result_json->>'embeddings' = 'failed'`) as any[];
  return rows.map((r) => ({ id: r.id as string, brain: r.brain as string }));
}
