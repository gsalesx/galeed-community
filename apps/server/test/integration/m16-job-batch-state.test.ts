/** M16/S2 — SMOKE do estado de lote (Batch API) na fila de ingestão. Prova:
 *   (1) a migração 19 / DDL do boot-lazy aplica idempotente (boot duplo sem erro);
 *   (2) markJobBatchSubmitted grava batch_id + custom_map + status=batch_submitted (round-trip via rowToJob);
 *   (3) claimPollableBatches devolve só jobs com batch_id not null E status in (batch_submitted,batch_harvesting);
 *   (4) markJobHarvesting é a GUARDA anti-harvest-duplo (1ª vez true, 2ª false — UPDATE condicional);
 *   (5) markJobDone tira o job do claim de poll.
 *
 *  Precisa de Postgres (docker compose up -d → :5434) — skip automático sem DATABASE_URL (espelha
 *  m15-budget-gate.test.ts). Brain descartável `__test_m16_s2` (NUNCA Accelera). Sem Anthropic (puro DB). */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { hasDb } from "./helpers/db.ts";
import {
  enqueueIngestJob,
  markJobBatchSubmitted,
  claimPollableBatches,
  updateBatchStatus,
  markJobHarvesting,
  clearBatchState,
  markJobDone,
  getJob,
  closeIngestQueue,
  type IngestJobResult,
} from "../../src/core/ingestion/ingest-queue.ts";
import { rawConnect } from "./helpers/db.ts";

const BRAIN = "__test_m16_s2";

/** Apaga os jobs do brain de teste (galeed_ingest_jobs NÃO está no wipeBrain padrão). */
async function wipeJobs(): Promise<void> {
  const sql = await rawConnect();
  try {
    await sql.unsafe(`delete from galeed_ingest_jobs where brain = $1`, [BRAIN]).catch(() => {});
  } finally {
    await sql.end({ timeout: 5 });
  }
}

const DONE_RESULT: IngestJobResult = { total: 1, slugs: ["s"], skipped: 0, message: "ok" };

describe.skipIf(!hasDb())("M16/S2 — estado de lote na fila (batch_id + helpers de poll)", () => {
  beforeAll(async () => {
    await wipeJobs();
  });
  afterAll(async () => {
    await wipeJobs();
    await closeIngestQueue();
  });

  it("migração 19 / DDL do boot-lazy é idempotente (boot duplo sem erro — colunas batch_*)", async () => {
    // O boot-lazy de db() roda as colunas batch_* (ADD COLUMN IF NOT EXISTS). Forçar dois boots: fechar
    // a conexão e enfileirar de novo re-executa o DDL idempotente. Sem erro = idempotente.
    await enqueueIngestJob({ brain: BRAIN, kind: "text", type: "conversa", textBody: "a" });
    await closeIngestQueue();
    const r = await enqueueIngestJob({ brain: BRAIN, kind: "text", type: "conversa", textBody: "b" });
    expect(r.status).toBe("queued");
  });

  it("markJobBatchSubmitted grava batch_id + custom_map + status=batch_submitted; claimPollableBatches o devolve", async () => {
    await wipeJobs();
    const { jobId } = await enqueueIngestJob({ brain: BRAIN, kind: "text", type: "conversa", textBody: "x" });
    const customMap = { slug__0: "slug", slug__1: "slug" };

    await markJobBatchSubmitted(jobId, "msgbatch_x", customMap);

    const got = await getJob(BRAIN, jobId);
    expect(got?.status).toBe("batch_submitted");
    expect(got?.batchId).toBe("msgbatch_x");
    expect(got?.batchStatus).toBe("in_progress");
    expect(got?.batchCustomMap).toEqual(customMap);
    expect(got!.progress).toBeGreaterThanOrEqual(0.55);

    const pollable = await claimPollableBatches();
    const mine = pollable.find((j) => j.id === jobId);
    expect(mine, "job submetido deve estar no claim de poll").toBeTruthy();
    expect(mine?.batchId).toBe("msgbatch_x");
    expect(mine?.batchCustomMap).toEqual(customMap);
  });

  it("claimPollableBatches IGNORA jobs sem batch (queued) e jobs done", async () => {
    await wipeJobs();
    // job síncrono (sem batch) — não deve aparecer
    await enqueueIngestJob({ brain: BRAIN, kind: "text", type: "conversa", textBody: "sync" });
    // job batch submetido — deve aparecer
    const { jobId: batchJob } = await enqueueIngestJob({ brain: BRAIN, kind: "text", type: "conversa", textBody: "batch" });
    await markJobBatchSubmitted(batchJob, "msgbatch_only", { slug__0: "slug" });

    const pollable = await claimPollableBatches();
    const ids = pollable.map((j) => j.id);
    expect(ids).toContain(batchJob);
    // todo job devolvido tem batch_id não-nulo e status de poll
    for (const j of pollable) {
      expect(j.batchId).toBeTruthy();
      expect(["batch_submitted", "batch_harvesting"]).toContain(j.status);
    }
  });

  it("markJobHarvesting é RETOMÁVEL: job pollável (submitted/harvesting) → true; já fechado (done) → false", async () => {
    await wipeJobs();
    const { jobId } = await enqueueIngestJob({ brain: BRAIN, kind: "text", type: "conversa", textBody: "h" });
    await markJobBatchSubmitted(jobId, "msgbatch_h", { slug__0: "slug" });

    // 1ª transição (batch_submitted → batch_harvesting): ganha o direito de derivar.
    const first = await markJobHarvesting(jobId);
    expect(first, "1ª transição: submitted → harvesting").toBe(true);

    // RETOMADA pós-crash: o worker morreu antes do markJobDone; o restart re-claima o job (ainda
    // batch_harvesting) e PRECISA poder re-harvestar. É seguro: harvest idempotente (gap-S5-1/DECISION).
    const second = await markJobHarvesting(jobId);
    expect(second, "retomada: job em batch_harvesting ainda é pollável → true").toBe(true);

    const got = await getJob(BRAIN, jobId);
    expect(got?.status).toBe("batch_harvesting");
    expect(got?.batchStatus).toBe("ended");

    // Job JÁ FECHADO não re-harvesta: markJobDone → markJobHarvesting → false.
    await markJobDone(jobId, DONE_RESULT);
    const afterDone = await markJobHarvesting(jobId);
    expect(afterDone, "job done não é pollável → não re-harvesta").toBe(false);
  });

  it("updateBatchStatus grava o processing_status sem mudar o status do job", async () => {
    await wipeJobs();
    const { jobId } = await enqueueIngestJob({ brain: BRAIN, kind: "text", type: "conversa", textBody: "u" });
    await markJobBatchSubmitted(jobId, "msgbatch_u", { slug__0: "slug" });

    await updateBatchStatus(jobId, "in_progress");
    const got = await getJob(BRAIN, jobId);
    expect(got?.status).toBe("batch_submitted"); // status do job intacto
    expect(got?.batchStatus).toBe("in_progress");
  });

  it("markJobDone + clearBatchState fecham o job: claimPollableBatches NÃO o retorna mais; custom_map limpo", async () => {
    await wipeJobs();
    const { jobId } = await enqueueIngestJob({ brain: BRAIN, kind: "text", type: "conversa", textBody: "d" });
    await markJobBatchSubmitted(jobId, "msgbatch_d", { slug__0: "slug" });
    await markJobHarvesting(jobId);

    await markJobDone(jobId, DONE_RESULT);
    await clearBatchState(jobId);

    const pollable = await claimPollableBatches();
    expect(pollable.map((j) => j.id)).not.toContain(jobId);

    const got = await getJob(BRAIN, jobId);
    expect(got?.status).toBe("done");
    expect(got?.batchCustomMap).toBeNull();
    expect(got?.batchId, "batch_id preservado pra auditoria").toBe("msgbatch_d");
  });
});
