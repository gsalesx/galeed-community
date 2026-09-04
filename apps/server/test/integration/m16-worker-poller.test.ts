/** M16/S4 — SMOKE do worker-poller (2º loop de poll dos lotes no ingest-worker). Prova o CICLO de
 *  orquestração SEM Anthropic real: getBatch (S1) e harvestExtractionBatch (S3) são MOCADOS, e os
 *  helpers de fila (S2) também — o foco é a LÓGICA do poller (claim → getBatch → ended? harvest+done :
 *  updateBatchStatus). Cobre os 4 cenários do CONTRACT:
 *    (1) in_progress → updateBatchStatus chamado, NÃO fecha (não chama markJobHarvesting/harvest/done);
 *    (2) ended + markJobHarvesting(true) → harvestExtractionBatch → clearBatchState → markJobDone (status done);
 *    (3) ended + markJobHarvesting(false) → NÃO chama harvest (guarda anti-harvest-duplo);
 *    (4) RESILIÊNCIA: getBatch de um job lança → loga e segue; os OUTROS lotes do tick processam (loop vivo).
 *    (5) RESUMIBILIDADE: o poller NUNCA chama submitBatch — só GET (claim lê batch_id do banco; restart retoma).
 *    (6) backoff: tick sem lote pollável retorna em once:true sem martelar.
 *
 *  Tudo via vi.mock (determinístico, sem rede, sem DB) — o ciclo REAL (lote pequeno Anthropic) é o gate do S5.
 *  O ajuste do loop de JOBS (markJobDone condicional via getJob) é provado dirigindo runIngestWorker({once})
 *  com processBlobJob deixando o job em batch_submitted. */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { IngestJob } from "../../src/core/ingestion/ingest-queue.ts";

// ── MOCKs dos colaboradores (S1/S2/S3). O worker importa esses módulos por path — mockamos os símbolos
//    que o poller usa, mantendo o resto via importOriginal (mock parcial). ──
const mockClaimPollableBatches = vi.fn();
const mockUpdateBatchStatus = vi.fn();
const mockMarkJobHarvesting = vi.fn();
const mockClearBatchState = vi.fn();
const mockMarkJobDone = vi.fn();
const mockMarkJobError = vi.fn();
const mockGetJob = vi.fn();
const mockClaimNextJob = vi.fn();
const mockMarkJobFindable = vi.fn();
const mockMarkJobDigesting = vi.fn();
const mockUpdateJobProgress = vi.fn();
const mockCloseIngestQueue = vi.fn();

vi.mock("../../src/core/ingestion/ingest-queue.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/core/ingestion/ingest-queue.ts")>();
  return {
    ...actual,
    claimPollableBatches: (...a: any[]) => mockClaimPollableBatches(...a),
    updateBatchStatus: (...a: any[]) => mockUpdateBatchStatus(...a),
    markJobHarvesting: (...a: any[]) => mockMarkJobHarvesting(...a),
    clearBatchState: (...a: any[]) => mockClearBatchState(...a),
    markJobDone: (...a: any[]) => mockMarkJobDone(...a),
    markJobError: (...a: any[]) => mockMarkJobError(...a),
    getJob: (...a: any[]) => mockGetJob(...a),
    claimNextJob: (...a: any[]) => mockClaimNextJob(...a),
    markJobFindable: (...a: any[]) => mockMarkJobFindable(...a),
    markJobDigesting: (...a: any[]) => mockMarkJobDigesting(...a),
    updateJobProgress: (...a: any[]) => mockUpdateJobProgress(...a),
    closeIngestQueue: (...a: any[]) => mockCloseIngestQueue(...a),
  };
});

const mockGetBatch = vi.fn();
const mockSubmitBatch = vi.fn(); // p/ provar RESUMIBILIDADE: o poller NUNCA o chama.
vi.mock("../../src/lib/batch-client.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/batch-client.ts")>();
  return { ...actual, getBatch: (...a: any[]) => mockGetBatch(...a), submitBatch: (...a: any[]) => mockSubmitBatch(...a) };
});

const mockHarvest = vi.fn();
vi.mock("../../src/core/ingestion/batch-extract.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/core/ingestion/batch-extract.ts")>();
  return { ...actual, harvestExtractionBatch: (...a: any[]) => mockHarvest(...a) };
});

const mockProcessBlobJob = vi.fn();
vi.mock("../../src/core/ingestion/process-blob-job.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/core/ingestion/process-blob-job.ts")>();
  return { ...actual, processBlobJob: (...a: any[]) => mockProcessBlobJob(...a) };
});

// não fechar engines de verdade no teardown indireto (não é exercido aqui de qualquer forma).
vi.mock("../../src/core/platform/engine.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/core/platform/engine.ts")>();
  return { ...actual, closeEngines: vi.fn() };
});

import { runBatchPoller, runIngestWorker } from "../../src/connectors/ingest-worker.ts";

/** Fabrica um IngestJob mínimo com lote pendente. */
function batchJob(over: Partial<IngestJob> = {}): IngestJob {
  return {
    id: over.id ?? "job-1",
    brain: over.brain ?? "__test_m16_s4",
    batchId: over.batchId ?? "msgbatch_abc",
    batchStatus: over.batchStatus ?? "in_progress",
    batchCustomMap: over.batchCustomMap ?? { "slug__0": "slug" },
    status: over.status ?? "batch_submitted",
    ...over,
  } as IngestJob;
}

function handle(status: "in_progress" | "ended", over: Record<string, any> = {}) {
  return {
    id: "msgbatch_abc",
    processing_status: status,
    request_counts: { processing: 0, succeeded: 1, errored: 0, canceled: 0, expired: 0 },
    results_url: status === "ended" ? "https://api.anthropic.com/v1/.../results" : null,
    created_at: "2026-06-04T00:00:00Z",
    expires_at: "2026-06-05T00:00:00Z",
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("M16/S4 — runBatchPoller (poll de lotes)", () => {
  it("(1) in_progress → updateBatchStatus + NÃO fecha (sem harvest/markJobHarvesting/done)", async () => {
    mockClaimPollableBatches.mockResolvedValueOnce([batchJob()]);
    mockGetBatch.mockResolvedValueOnce(handle("in_progress"));

    await runBatchPoller({ once: true, pollMs: 1 });

    expect(mockGetBatch).toHaveBeenCalledWith("msgbatch_abc");
    expect(mockUpdateBatchStatus).toHaveBeenCalledWith("job-1", "in_progress");
    expect(mockMarkJobHarvesting).not.toHaveBeenCalled();
    expect(mockHarvest).not.toHaveBeenCalled();
    expect(mockMarkJobDone).not.toHaveBeenCalled();
    expect(mockClearBatchState).not.toHaveBeenCalled();
  });

  it("(2) ended + markJobHarvesting(true) → harvest → clearBatchState → markJobDone(done)", async () => {
    mockClaimPollableBatches.mockResolvedValueOnce([batchJob({ batchCustomMap: { "slug__0": "slug" } })]);
    mockGetBatch.mockResolvedValueOnce(handle("ended"));
    mockMarkJobHarvesting.mockResolvedValueOnce(true);
    mockHarvest.mockResolvedValueOnce({ harvested: 3, errored: 1 });

    await runBatchPoller({ once: true, pollMs: 1 });

    expect(mockUpdateBatchStatus).toHaveBeenCalledWith("job-1", "ended");
    expect(mockMarkJobHarvesting).toHaveBeenCalledWith("job-1");
    // harvest recebe brain, handle (com results_url) e o customMap do banco — orquestração pura.
    expect(mockHarvest).toHaveBeenCalledTimes(1);
    const [brain, h, customMap] = mockHarvest.mock.calls[0];
    expect(brain).toBe("__test_m16_s4");
    expect(h.processing_status).toBe("ended");
    expect(customMap).toEqual({ "slug__0": "slug" });
    expect(mockClearBatchState).toHaveBeenCalledWith("job-1");
    expect(mockMarkJobDone).toHaveBeenCalledTimes(1);
    const [doneId, doneResult] = mockMarkJobDone.mock.calls[0];
    expect(doneId).toBe("job-1");
    expect(doneResult.total).toBe(3);
    expect(doneResult.message).toContain("1 com erro");
    // ORDEM: harvest ANTES de clearBatchState ANTES de markJobDone.
    expect(mockHarvest.mock.invocationCallOrder[0]).toBeLessThan(mockClearBatchState.mock.invocationCallOrder[0]);
    expect(mockClearBatchState.mock.invocationCallOrder[0]).toBeLessThan(mockMarkJobDone.mock.invocationCallOrder[0]);
  });

  it("(3) ended + markJobHarvesting(false) → guarda anti-harvest-duplo: NÃO chama harvest/done", async () => {
    mockClaimPollableBatches.mockResolvedValueOnce([batchJob()]);
    mockGetBatch.mockResolvedValueOnce(handle("ended"));
    mockMarkJobHarvesting.mockResolvedValueOnce(false); // outro poll/worker já ganhou a transição

    await runBatchPoller({ once: true, pollMs: 1 });

    expect(mockMarkJobHarvesting).toHaveBeenCalledWith("job-1");
    expect(mockHarvest).not.toHaveBeenCalled();
    expect(mockClearBatchState).not.toHaveBeenCalled();
    expect(mockMarkJobDone).not.toHaveBeenCalled();
  });

  it("(4) RESILIÊNCIA: getBatch de um lote lança → loga e segue; os outros lotes processam", async () => {
    const j1 = batchJob({ id: "job-boom", batchId: "msgbatch_boom" });
    const j2 = batchJob({ id: "job-ok", batchId: "msgbatch_ok", batchCustomMap: { "s__0": "s" } });
    mockClaimPollableBatches.mockResolvedValueOnce([j1, j2]);
    mockGetBatch
      .mockRejectedValueOnce(new Error("network blip")) // j1 explode
      .mockResolvedValueOnce(handle("ended", { id: "msgbatch_ok" })); // j2 ok
    mockMarkJobHarvesting.mockResolvedValueOnce(true);
    mockHarvest.mockResolvedValueOnce({ harvested: 1, errored: 0 });

    // NÃO deve lançar (resiliência: erro num lote não derruba o loop)
    await expect(runBatchPoller({ once: true, pollMs: 1 })).resolves.toBeUndefined();

    // j2 (ok) foi processado até o fim apesar do j1 ter falhado
    expect(mockHarvest).toHaveBeenCalledTimes(1);
    expect(mockMarkJobDone).toHaveBeenCalledWith("job-ok", expect.objectContaining({ total: 1 }));
    // erro transitório de poll NÃO vira markJobError (a rede falha, o lote segue na Anthropic)
    expect(mockMarkJobError).not.toHaveBeenCalled();
  });

  it("(5) RESUMIBILIDADE: o poller NUNCA submete lote — só GET (claim lê batch_id do banco)", async () => {
    mockClaimPollableBatches.mockResolvedValueOnce([batchJob()]);
    mockGetBatch.mockResolvedValueOnce(handle("in_progress"));

    await runBatchPoller({ once: true, pollMs: 1 });

    expect(mockSubmitBatch).not.toHaveBeenCalled(); // submit é exclusivo do S3 no processBlobJob
    expect(mockGetBatch).toHaveBeenCalledTimes(1); // só GET — restart retoma do batch_id persistido
  });

  it("(6) tick sem lote pollável retorna (once) sem getBatch/harvest", async () => {
    mockClaimPollableBatches.mockResolvedValueOnce([]);
    await runBatchPoller({ once: true, pollMs: 1 });
    expect(mockGetBatch).not.toHaveBeenCalled();
    expect(mockHarvest).not.toHaveBeenCalled();
  });
});

describe("M16/S4 — ajuste do loop de jobs (markJobDone condicional)", () => {
  it("processBlobJob deixou batch_submitted → NÃO chama markJobDone (o poller fecha)", async () => {
    mockClaimNextJob.mockResolvedValueOnce(batchJob({ id: "job-batch", status: "processing" }));
    mockProcessBlobJob.mockResolvedValueOnce({ total: 0, slugs: [], skipped: 0, message: "lote submetido" });
    // pós-processBlobJob o status no banco é batch_submitted (S3 transicionou)
    mockGetJob.mockResolvedValueOnce(batchJob({ id: "job-batch", status: "batch_submitted" }));

    await runIngestWorker({ once: true });

    expect(mockGetJob).toHaveBeenCalledWith("__test_m16_s4", "job-batch");
    expect(mockMarkJobDone).not.toHaveBeenCalled(); // o poller fecha esse job, não o loop de jobs
    expect(mockMarkJobError).not.toHaveBeenCalled();
  });

  it("job SÍNCRONO (status != batch_*) → markJobDone como hoje (M15 intacto)", async () => {
    mockClaimNextJob.mockResolvedValueOnce(batchJob({ id: "job-sync", status: "processing" }));
    const result = { total: 2, slugs: ["a", "b"], skipped: 0, message: "ok" };
    mockProcessBlobJob.mockResolvedValueOnce(result);
    mockGetJob.mockResolvedValueOnce(batchJob({ id: "job-sync", status: "digested" })); // caminho síncrono

    await runIngestWorker({ once: true });

    expect(mockMarkJobDone).toHaveBeenCalledWith("job-sync", result);
  });
});
