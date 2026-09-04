/** ROBUSTEZ DA FILA — dead-letter do poller de lote (antes: erro DEFINITIVO de poll — 401 de chave
 *  revogada, 404 de lote sumido — virava loop infinito de 12s que deixava o job 'organizing' pra
 *  sempre E bloqueava o repair do brain inteiro, porque listRepairableBrains exclui jobs batch_*).
 *  Agora: 4xx (exceto 408/429) embutido na mensagem do batch-client conta em result_json.poll_failures
 *  (mergeJobResult); no teto (GALEED_BATCH_POLL_MAX_FAILURES, default 5) o job vira 'error' com
 *  mensagem legível — o brain se destrava e a varredura re-digere as páginas extract_version=''.
 *  Wiring do worker (vi.mock + vi.hoisted; NUNCA const top-level na factory — espelho do m24d). */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => {
  const queueState: { pollableJobs: any[] } = { pollableJobs: [] };
  return {
    queueState,
    claimNextJob: vi.fn(async () => null),
    updateJobProgress: vi.fn(async () => {}),
    markJobDone: vi.fn(async () => {}),
    markJobError: vi.fn(async () => {}),
    markJobFindable: vi.fn(async () => {}),
    markJobDigesting: vi.fn(async () => {}),
    closeIngestQueue: vi.fn(async () => {}),
    getJob: vi.fn(async () => null),
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
    runConsolidationStep: vi.fn(async () => ({ status: "ok", merges: 0, aliases_mudados: 0, fontes_rederivadas: 0, grupos: 0 })),
    maybeSono: vi.fn(async () => ({ status: "noop", fontes_novas: 0, fatos_novos: 0, budget_k: 10, chamadas_llm: 0 })),
    scanSupersededFacts: vi.fn(async () => ({ scanned: 0, enqueued: 0 })),
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
vi.mock("../../src/core/platform/webhook-emit.ts", () => ({
  scanSupersededFacts: h.scanSupersededFacts,
  emitWebhookEvent: vi.fn(async () => {}),
}));

import { runBatchPoller, definitivePollErrorStatus } from "../../src/connectors/ingest-worker.ts";

const batchJob = () => ({
  id: "j1",
  brain: "robustez-dead-letter",
  kind: "text",
  status: "batch_submitted",
  batchId: "bat-1",
  batchCustomMap: {},
  resultJson: {} as Record<string, unknown>,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.queueState.pollableJobs = [];
  h.getBatch.mockResolvedValue({ processing_status: "ended", request_counts: {} });
  h.harvestExtractionBatch.mockResolvedValue({ harvested: 1, errored: 0 });
  h.markJobHarvesting.mockResolvedValue(true);
  h.mergeJobResult.mockResolvedValue(undefined);
});

afterEach(() => {
  delete process.env.GALEED_BATCH_POLL_MAX_FAILURES;
});

describe("definitivePollErrorStatus — classificação PURA do erro de poll", () => {
  it("4xx do batch-client é definitivo; 408/429/5xx/rede/submit são transitórios (null)", () => {
    expect(definitivePollErrorStatus("Batch get 401: chave inválida")).toBe(401);
    expect(definitivePollErrorStatus("Batch results 404: sumiu")).toBe(404);
    expect(definitivePollErrorStatus("Batch get 403: proibido")).toBe(403);
    expect(definitivePollErrorStatus("Batch get 408: timeout")).toBeNull();
    expect(definitivePollErrorStatus("Batch get 429: rate limit")).toBeNull();
    expect(definitivePollErrorStatus("Batch get 500: oops")).toBeNull();
    expect(definitivePollErrorStatus("Batch submit 400: x")).toBeNull(); // submit não é poll
    expect(definitivePollErrorStatus("fetch failed")).toBeNull(); // rede sem status
  });
});

describe("runBatchPoller — dead-letter de lote inacessível", () => {
  it("falha DEFINITIVA incrementa poll_failures (com a mensagem) sem matar o job antes do teto", async () => {
    h.queueState.pollableJobs = [batchJob()];
    h.getBatch.mockRejectedValue(new Error("Batch get 401: chave revogada"));
    await runBatchPoller({ once: true });
    expect(h.markJobError).not.toHaveBeenCalled();
    expect(h.mergeJobResult).toHaveBeenCalledWith("j1", {
      poll_failures: 1,
      poll_last_error: "Batch get 401: chave revogada",
    });
  });

  it("no teto (5ª falha definitiva) → markJobError com mensagem legível que aponta a varredura", async () => {
    h.queueState.pollableJobs = [{ ...batchJob(), resultJson: { poll_failures: 4 } }];
    h.getBatch.mockRejectedValue(new Error("Batch get 404: lote não existe"));
    await runBatchPoller({ once: true });
    expect(h.markJobError).toHaveBeenCalledTimes(1);
    const [id, msg] = h.markJobError.mock.calls[0] as [string, string];
    expect(id).toBe("j1");
    expect(msg).toContain("HTTP 404");
    expect(msg).toContain("varredura de reparo"); // legível: diz o que acontece com as páginas
    expect(h.mergeJobResult).not.toHaveBeenCalled();
  });

  it("erro TRANSITÓRIO (rede sem status, 5xx, 429) mantém o comportamento atual: só loga", async () => {
    for (const m of ["fetch failed", "Batch get 500: oops", "Batch get 429: rate limit"]) {
      vi.clearAllMocks();
      h.queueState.pollableJobs = [batchJob()];
      h.getBatch.mockRejectedValue(new Error(m));
      await runBatchPoller({ once: true });
      expect(h.markJobError).not.toHaveBeenCalled();
      expect(h.mergeJobResult).not.toHaveBeenCalled();
    }
  });

  it("GALEED_BATCH_POLL_MAX_FAILURES=1 → dead-letter já na primeira falha definitiva", async () => {
    process.env.GALEED_BATCH_POLL_MAX_FAILURES = "1";
    h.queueState.pollableJobs = [batchJob()];
    h.getBatch.mockRejectedValue(new Error("Batch get 403: proibido"));
    await runBatchPoller({ once: true });
    expect(h.markJobError).toHaveBeenCalledTimes(1);
  });

  it("tick BEM-SUCEDIDO zera o contador quando presente (blips espaçados não acumulam)", async () => {
    h.queueState.pollableJobs = [{ ...batchJob(), resultJson: { poll_failures: 2 } }];
    h.getBatch.mockResolvedValue({ processing_status: "in_progress", request_counts: {} });
    await runBatchPoller({ once: true });
    expect(h.mergeJobResult).toHaveBeenCalledWith("j1", { poll_failures: 0 });
    expect(h.markJobError).not.toHaveBeenCalled();
  });

  it("tick bem-sucedido SEM contador não gasta UPDATE (mergeJobResult não é chamado)", async () => {
    h.queueState.pollableJobs = [batchJob()];
    h.getBatch.mockResolvedValue({ processing_status: "in_progress", request_counts: {} });
    await runBatchPoller({ once: true });
    expect(h.mergeJobResult).not.toHaveBeenCalled();
  });

  it("bookkeeping é FAIL-SOFT: mergeJobResult/markJobError rejeitando não derruba o poller", async () => {
    h.queueState.pollableJobs = [batchJob()];
    h.getBatch.mockRejectedValue(new Error("Batch get 401: x"));
    h.mergeJobResult.mockRejectedValue(new Error("db caiu"));
    await expect(runBatchPoller({ once: true })).resolves.toBeUndefined();

    vi.clearAllMocks();
    h.queueState.pollableJobs = [{ ...batchJob(), resultJson: { poll_failures: 4 } }];
    h.getBatch.mockRejectedValue(new Error("Batch get 401: x"));
    h.markJobError.mockRejectedValue(new Error("db caiu"));
    await expect(runBatchPoller({ once: true })).resolves.toBeUndefined();
  });
});
