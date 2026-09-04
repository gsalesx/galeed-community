/** ROBUSTEZ DA FILA — repairTick (varredura de reparo PERIÓDICA; antes runRepairSweep rodava SÓ no
 *  boot/--repair-only — worker de longa duração nunca curava página presa sem Fase B). O timer vive
 *  no main() (setInterval na família reaper/janela/github); aqui testa-se o TICK exportado: flag de
 *  reentrada (passada longa não sobrepõe passada — uma varredura pode levar minutos de LLM) e
 *  fail-soft (rejeição não emperra o próximo tick). Wiring com o scaffold padrão (vi.mock +
 *  vi.hoisted; NUNCA const top-level na factory — espelho do m23d/m24d). */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  claimNextJob: vi.fn(async () => null),
  updateJobProgress: vi.fn(async () => {}),
  markJobDone: vi.fn(async () => {}),
  markJobError: vi.fn(async () => {}),
  markJobFindable: vi.fn(async () => {}),
  markJobDigesting: vi.fn(async () => {}),
  closeIngestQueue: vi.fn(async () => {}),
  getJob: vi.fn(async () => null),
  claimPollableBatches: vi.fn(async () => []),
  updateBatchStatus: vi.fn(async () => {}),
  markJobHarvesting: vi.fn(async () => true),
  clearBatchState: vi.fn(async () => {}),
  reapExpiredJobs: vi.fn(async () => ({ requeued: [], dead: [] })),
  mergeJobResult: vi.fn(async () => {}),
  processBlobJob: vi.fn(async () => ({ total: 0, slugs: [], skipped: 0, message: "" })),
  runRepairSweep: vi.fn(async () => ({})),
  getBatch: vi.fn(async () => ({ processing_status: "ended", request_counts: {} })),
  harvestExtractionBatch: vi.fn(async () => ({ harvested: 0, errored: 0 })),
  closeEngines: vi.fn(async () => {}),
  runConsolidationStep: vi.fn(async () => ({ status: "ok", merges: 0, aliases_mudados: 0, fontes_rederivadas: 0, grupos: 0 })),
  maybeSono: vi.fn(async () => ({ status: "noop", fontes_novas: 0, fatos_novos: 0, budget_k: 10, chamadas_llm: 0 })),
  scanSupersededFacts: vi.fn(async () => ({ scanned: 0, enqueued: 0 })),
}));

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

import { repairTick } from "../../src/connectors/ingest-worker.ts";

const zeroReport = {
  brains: 0,
  pagesDigested: 0,
  pagesSkipped: 0,
  underivedDerived: 0,
  embeddingsRetried: 0,
  jobsEmbeddingsOk: 0,
};
const settle = () => new Promise((r) => setTimeout(r, 0)); // deixa o .finally do tick rodar

beforeEach(() => {
  vi.clearAllMocks();
  h.runRepairSweep.mockResolvedValue(zeroReport);
});

describe("repairTick — varredura periódica com flag de reentrada", () => {
  it("não sobrepõe passadas: tick durante passada em voo é no-op; libera quando ela termina", async () => {
    const deferreds: Array<(v: any) => void> = [];
    h.runRepairSweep.mockImplementation(() => new Promise((res) => deferreds.push(res)));
    repairTick();
    repairTick(); // reentrada — a 1ª passada ainda está em voo (varredura pode levar minutos de LLM)
    expect(h.runRepairSweep).toHaveBeenCalledTimes(1);
    deferreds[0]!(zeroReport);
    await settle();
    repairTick(); // a flag foi solta no finally — passa
    expect(h.runRepairSweep).toHaveBeenCalledTimes(2);
    deferreds[1]!(zeroReport); // higiene: solta a flag pros próximos testes do arquivo
    await settle();
  });

  it("passada que REJEITA não lança nem emperra o próximo tick (flag solta no finally)", async () => {
    h.runRepairSweep.mockRejectedValueOnce(new Error("boom-repair"));
    expect(() => repairTick()).not.toThrow();
    await settle();
    repairTick();
    await settle();
    expect(h.runRepairSweep).toHaveBeenCalledTimes(2);
  });
});
