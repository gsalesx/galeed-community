/** M23-D — §6.2.3: wiring do worker (vi.mock + vi.hoisted; NUNCA const top-level na factory).
 *  Mocka o próprio consolidate-step para isolar o WIRING do worker. As funções PURAS (§6.2.1/.2)
 *  e a serialização (§6.2.4) vivem em m23d-consolidacao-serial.test.ts (lá o módulo é REAL —
 *  mockar consolidate-step aqui torna diffEntityMaps/slugsAffectedByEntities indisponíveis). */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// §6.2.3 — wiring do worker (vi.mock + vi.hoisted; NUNCA const top-level na factory)
// ---------------------------------------------------------------------------
const h = vi.hoisted(() => {
  const queueState: { syncJob: any; getJobResult: any; pollableJobs: any[] } = {
    syncJob: null,
    getJobResult: null,
    pollableJobs: [],
  };
  return {
    queueState,
    claimNextJob: vi.fn(async () => queueState.syncJob),
    updateJobProgress: vi.fn(async () => {}),
    markJobDone: vi.fn(async () => {}),
    markJobError: vi.fn(async () => {}),
    markJobFindable: vi.fn(async () => {}),
    markJobDigesting: vi.fn(async () => {}),
    closeIngestQueue: vi.fn(async () => {}),
    getJob: vi.fn(async () => queueState.getJobResult),
    claimPollableBatches: vi.fn(async () => queueState.pollableJobs),
    updateBatchStatus: vi.fn(async () => {}),
    markJobHarvesting: vi.fn(async () => true),
    clearBatchState: vi.fn(async () => {}),
    reapExpiredJobs: vi.fn(async () => ({ requeued: [], dead: [] })),
    mergeJobResult: vi.fn(async () => {}),
    processBlobJob: vi.fn(async () => ({ total: 1, slugs: ["s1"], skipped: 0, message: "" })),
    runRepairSweep: vi.fn(async () => ({})),
    getBatch: vi.fn(async () => ({ processing_status: "ended", request_counts: {} })),
    harvestExtractionBatch: vi.fn(async () => ({ harvested: 1, errored: 0 })),
    closeEngines: vi.fn(async () => {}),
    runConsolidationStep: vi.fn(async () => ({
      status: "ok",
      merges: 1,
      aliases_mudados: 1,
      fontes_rederivadas: 1,
      grupos: 1,
    })),
  };
});

vi.mock("../../src/core/ingestion/ingest-queue.ts", () => ({
  claimNextJob: h.claimNextJob,
  updateJobProgress: h.updateJobProgress,
  markJobDone: h.markJobDone,
  markJobError: h.markJobError,
  markJobFindable: h.markJobFindable,
  markJobDigesting: h.markJobDigesting,
  closeIngestQueue: h.closeIngestQueue,
  getJob: h.getJob,
  claimPollableBatches: h.claimPollableBatches,
  updateBatchStatus: h.updateBatchStatus,
  markJobHarvesting: h.markJobHarvesting,
  clearBatchState: h.clearBatchState,
  reapExpiredJobs: h.reapExpiredJobs,
  mergeJobResult: h.mergeJobResult,
}));
vi.mock("../../src/core/ingestion/process-blob-job.ts", () => ({ processBlobJob: h.processBlobJob }));
vi.mock("../../src/core/ingestion/repair.ts", () => ({ runRepairSweep: h.runRepairSweep }));
vi.mock("../../src/lib/batch-client.ts", () => ({ getBatch: h.getBatch }));
vi.mock("../../src/core/ingestion/batch-extract.ts", () => ({ harvestExtractionBatch: h.harvestExtractionBatch }));
vi.mock("../../src/core/platform/engine.ts", () => ({ closeEngines: h.closeEngines }));
vi.mock("../../src/core/ingestion/consolidate-step.ts", () => ({ runConsolidationStep: h.runConsolidationStep }));

import { runIngestWorker, runBatchPoller } from "../../src/connectors/ingest-worker.ts";

const baseJob = {
  id: "j1",
  brain: "m23d-consolidacao-wiring",
  kind: "text",
  status: "processing",
};

beforeEach(() => {
  vi.clearAllMocks();
  h.queueState.syncJob = null;
  h.queueState.getJobResult = null;
  h.queueState.pollableJobs = [];
  h.processBlobJob.mockResolvedValue({ total: 1, slugs: ["s1"], skipped: 0, message: "" });
  h.getBatch.mockResolvedValue({ processing_status: "ended", request_counts: {} });
  h.harvestExtractionBatch.mockResolvedValue({ harvested: 1, errored: 0 });
  h.markJobHarvesting.mockResolvedValue(true);
  h.runConsolidationStep.mockResolvedValue({
    status: "ok",
    merges: 1,
    aliases_mudados: 1,
    fontes_rederivadas: 1,
    grupos: 1,
  });
});

describe("wiring do worker — consolidação pós-done (m23d-consolidacao)", () => {
  it("(a) job síncrono total>0 → markJobDone ANTES de runConsolidationStep ANTES de mergeJobResult.consolidacao", async () => {
    h.queueState.syncJob = { ...baseJob };
    h.queueState.getJobResult = { ...baseJob, status: "done" }; // não-batch
    await runIngestWorker({ once: true });

    expect(h.runConsolidationStep).toHaveBeenCalledWith(baseJob.brain);
    // ordem: markJobDone < runConsolidationStep < mergeJobResult
    const doneOrder = h.markJobDone.mock.invocationCallOrder[0];
    const consOrder = h.runConsolidationStep.mock.invocationCallOrder[0];
    const mergeOrder = h.mergeJobResult.mock.invocationCallOrder[0];
    expect(doneOrder).toBeLessThan(consOrder);
    expect(consOrder).toBeLessThan(mergeOrder);
    expect(h.mergeJobResult).toHaveBeenCalledWith(baseJob.id, {
      consolidacao: { status: "ok", merges: 1, aliases_mudados: 1, fontes_rederivadas: 1, grupos: 1 },
    });
  });

  it("(b) total===0 (re-ingestão idempotente) → runConsolidationStep NÃO chamado", async () => {
    h.queueState.syncJob = { ...baseJob };
    h.queueState.getJobResult = { ...baseJob, status: "done" };
    h.processBlobJob.mockResolvedValue({ total: 0, slugs: [], skipped: 1, message: "" });
    await runIngestWorker({ once: true });
    expect(h.runConsolidationStep).not.toHaveBeenCalled();
  });

  it("(c) getJob devolve batch_submitted → NÃO consolida no loop de jobs (quem consolida é o poller)", async () => {
    h.queueState.syncJob = { ...baseJob };
    h.queueState.getJobResult = { ...baseJob, status: "batch_submitted", batchId: "b1" };
    await runIngestWorker({ once: true });
    expect(h.markJobDone).not.toHaveBeenCalled();
    expect(h.runConsolidationStep).not.toHaveBeenCalled();
  });

  it("(d) runConsolidationStep REJEITA → loop não lança; mergeJobResult recebe consolidacao.status=falhou", async () => {
    h.queueState.syncJob = { ...baseJob };
    h.queueState.getJobResult = { ...baseJob, status: "done" };
    h.runConsolidationStep.mockRejectedValue(new Error("boom"));
    await expect(runIngestWorker({ once: true })).resolves.toBeUndefined();
    expect(h.markJobError).not.toHaveBeenCalled(); // o job em si NÃO falhou
    expect(h.mergeJobResult).toHaveBeenCalledWith(baseJob.id, {
      consolidacao: { status: "falhou", erro: "boom" },
    });
  });

  it("(e) poller: harvested>0 consolida após markJobDone; harvested===0 não", async () => {
    // harvested > 0
    h.queueState.pollableJobs = [{ ...baseJob, batchId: "b1", batchCustomMap: {} }];
    await runBatchPoller({ once: true });
    expect(h.runConsolidationStep).toHaveBeenCalledWith(baseJob.brain);
    const doneOrder = h.markJobDone.mock.invocationCallOrder[0];
    const consOrder = h.runConsolidationStep.mock.invocationCallOrder[0];
    expect(doneOrder).toBeLessThan(consOrder);

    // harvested === 0
    vi.clearAllMocks();
    h.queueState.pollableJobs = [{ ...baseJob, batchId: "b1", batchCustomMap: {} }];
    h.getBatch.mockResolvedValue({ processing_status: "ended", request_counts: {} });
    h.markJobHarvesting.mockResolvedValue(true);
    h.harvestExtractionBatch.mockResolvedValue({ harvested: 0, errored: 0 });
    await runBatchPoller({ once: true });
    expect(h.runConsolidationStep).not.toHaveBeenCalled();
  });
});

