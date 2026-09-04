/** M24-D — §7.2.3: wiring do worker (vi.mock + vi.hoisted; NUNCA const top-level na factory).
 *  Mocka sono-step.ts INTEIRO (factory completa, sem importOriginal) — isola o wiring do worker E
 *  evita carregar o sono-step real, cujos imports A/B/C (signal-engine/dream-v2/reflect) AINDA não
 *  existem na base (M24 = spec-only neste tronco). Espelho LITERAL do m23d-consolidacao.test.ts.
 *
 *  O gatilho PURO (sonoConfig/decideGatilho), o ciclo e o maybeSono — que precisam CARREGAR o
 *  sono-step REAL — vivem em m24d-sono-worker-ciclo.test.ts (lá A/B/C são mockados via vi.mock).
 *  Misturar full-mock e import-real do MESMO módulo num arquivo é impossível em ESM (a factory
 *  vence o arquivo inteiro) — por isso a separação. */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => {
  const queueState: { syncJob: any; getJobResult: any; pollableJobs: any[] } = { syncJob: null, getJobResult: null, pollableJobs: [] };
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
    runConsolidationStep: vi.fn(async () => ({ status: "ok", merges: 1, aliases_mudados: 1, fontes_rederivadas: 1, grupos: 1 })),
    maybeSono: vi.fn(async () => ({ status: "noop", fontes_novas: 0, fatos_novos: 0, budget_k: 10, chamadas_llm: 0 })),
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
vi.mock("../../src/core/ingestion/sono-step.ts", () => ({ maybeSono: h.maybeSono }));

import { runIngestWorker, runBatchPoller } from "../../src/connectors/ingest-worker.ts";

const baseJob = { id: "j1", brain: "m24d-sono-worker-wiring", kind: "text", status: "processing" };

beforeEach(() => {
  vi.clearAllMocks();
  h.queueState.syncJob = null;
  h.queueState.getJobResult = null;
  h.queueState.pollableJobs = [];
  h.processBlobJob.mockResolvedValue({ total: 1, slugs: ["s1"], skipped: 0, message: "" });
  h.getBatch.mockResolvedValue({ processing_status: "ended", request_counts: {} });
  h.harvestExtractionBatch.mockResolvedValue({ harvested: 1, errored: 0 });
  h.markJobHarvesting.mockResolvedValue(true);
  h.runConsolidationStep.mockResolvedValue({ status: "ok", merges: 1, aliases_mudados: 1, fontes_rederivadas: 1, grupos: 1 });
  h.maybeSono.mockResolvedValue({ status: "noop", fontes_novas: 0, fatos_novos: 0, budget_k: 10, chamadas_llm: 0 });
});

describe("wiring do worker — sono pós-done (m24d-sono-worker)", () => {
  it("(a) job síncrono total>0 → markJobDone < runConsolidationStep < maybeSono < mergeJobResult.sono", async () => {
    h.queueState.syncJob = { ...baseJob };
    h.queueState.getJobResult = { ...baseJob, status: "done" };
    await runIngestWorker({ once: true });

    expect(h.maybeSono).toHaveBeenCalledWith(baseJob.brain);
    const doneOrder = h.markJobDone.mock.invocationCallOrder[0];
    const consOrder = h.runConsolidationStep.mock.invocationCallOrder[0];
    const sonoOrder = h.maybeSono.mock.invocationCallOrder[0];
    expect(doneOrder).toBeLessThan(consOrder);
    expect(consOrder).toBeLessThan(sonoOrder);
    expect(h.mergeJobResult).toHaveBeenCalledWith(baseJob.id, {
      sono: { status: "noop", fontes_novas: 0, fatos_novos: 0, budget_k: 10, chamadas_llm: 0 },
    });
  });

  it("(b) total===0 → consolidação NÃO chamada, maybeSono CHAMADO (incondicional)", async () => {
    h.queueState.syncJob = { ...baseJob };
    h.queueState.getJobResult = { ...baseJob, status: "done" };
    h.processBlobJob.mockResolvedValue({ total: 0, slugs: [], skipped: 1, message: "" });
    await runIngestWorker({ once: true });
    expect(h.runConsolidationStep).not.toHaveBeenCalled();
    expect(h.maybeSono).toHaveBeenCalledWith(baseJob.brain);
  });

  it("(c) getJob devolve batch_submitted → maybeSono NÃO chamado (quem fecha é o poller)", async () => {
    h.queueState.syncJob = { ...baseJob };
    h.queueState.getJobResult = { ...baseJob, status: "batch_submitted", batchId: "b1" };
    await runIngestWorker({ once: true });
    expect(h.markJobDone).not.toHaveBeenCalled();
    expect(h.maybeSono).not.toHaveBeenCalled();
  });

  it("(d) maybeSono REJEITA → loop não lança; mergeJobResult recebe { sono: { status:'falhou' } }", async () => {
    h.queueState.syncJob = { ...baseJob };
    h.queueState.getJobResult = { ...baseJob, status: "done" };
    h.maybeSono.mockRejectedValue(new Error("boom-sono"));
    await expect(runIngestWorker({ once: true })).resolves.toBeUndefined();
    expect(h.markJobError).not.toHaveBeenCalled(); // o job em si NÃO falhou
    expect(h.mergeJobResult).toHaveBeenCalledWith(baseJob.id, { sono: { status: "falhou", erro: "boom-sono" } });
  });

  it("(e) poller: pós batch-done, maybeSono chamado (com harvest>0 e com harvest===0)", async () => {
    h.queueState.pollableJobs = [{ ...baseJob, batchId: "b1", batchCustomMap: {} }];
    await runBatchPoller({ once: true });
    expect(h.maybeSono).toHaveBeenCalledWith(baseJob.brain);
    const doneOrder = h.markJobDone.mock.invocationCallOrder[0];
    const sonoOrder = h.maybeSono.mock.invocationCallOrder[0];
    expect(doneOrder).toBeLessThan(sonoOrder);

    vi.clearAllMocks();
    h.queueState.pollableJobs = [{ ...baseJob, batchId: "b1", batchCustomMap: {} }];
    h.getBatch.mockResolvedValue({ processing_status: "ended", request_counts: {} });
    h.markJobHarvesting.mockResolvedValue(true);
    h.harvestExtractionBatch.mockResolvedValue({ harvested: 0, errored: 0 });
    h.maybeSono.mockResolvedValue({ status: "noop", fontes_novas: 0, fatos_novos: 0, budget_k: 10, chamadas_llm: 0 });
    await runBatchPoller({ once: true });
    expect(h.runConsolidationStep).not.toHaveBeenCalled();
    expect(h.maybeSono).toHaveBeenCalledWith(baseJob.brain); // incondicional, mesmo harvest===0
  });
});
