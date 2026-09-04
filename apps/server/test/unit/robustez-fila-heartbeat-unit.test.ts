/** ROBUSTEZ DA FILA — heartbeat por UNIT na Fase B síncrona (antes o report — que renova o lease
 *  via updateJobProgress — só rodava ao FIM de cada página; uma página de conversa com ~50 units no
 *  provider cli ou sob backoff 429 estourava os 15 min do lease e o reaper re-enfileirava um job
 *  VIVO: extração duplicada, dead falso, dead→done). Agora extractWorthyUnitsSync reporta ANTES de
 *  cada chamada LLM. Testado pela borda pública (processBlobJob com onProgress espião) — todos os
 *  vizinhos com I/O mockados (vi.mock + vi.hoisted; NUNCA const top-level na factory). */
import { describe, it, expect, vi } from "vitest";

const h = vi.hoisted(() => {
  const page = { slug: "pg-1", body: "corpo da conversa", type: "nota", date: "", content_hash: "h1", tags: [] as string[] };
  const units = [
    { triageText: "fala um", date: "" },
    { triageText: "fala dois", date: "" },
    { triageText: "fala três", date: "" },
  ];
  const engine = {
    getSource: vi.fn(async () => undefined),
    getPage: vi.fn(async () => page),
    allPages: vi.fn(async () => []),
    putExtraction: vi.fn(async () => {}),
    markExtracted: vi.fn(async () => {}),
    touchSourceRead: vi.fn(async () => {}),
  };
  return {
    page,
    units,
    engine,
    markJobBatchSubmitted: vi.fn(async () => {}),
    getBlobStore: vi.fn(() => ({ get: vi.fn() })),
    sliceForIngest: vi.fn((t: string) => [{ text: t, part: 1 }]),
    extractDocText: vi.fn(),
    capture: vi.fn(async () => ({ slug: "pg-1", skipped: false })),
    extractOne: vi.fn(),
    buildExtractionContext: vi.fn(async () => ({ dims: ["decisoes"] })),
    extractUnit: vi.fn(async () => ({ decisoes: [] })), // ← a "chamada LLM" espiada
    buildExtractionUnits: vi.fn(() => units),
    entityHints: vi.fn(async () => []),
    freshVersion: vi.fn(async () => "v-test"),
    ensureSchemaPack: vi.fn(async () => {}),
    deriveIncremental: vi.fn(async () => {}),
    shouldUseBatch: vi.fn(async () => false), // força o caminho SÍNCRONO (o do heartbeat)
    buildBatchRequests: vi.fn(),
    submitExtractionBatch: vi.fn(),
    buildEmbeddings: vi.fn(async () => {}),
    getEngine: vi.fn(async () => engine),
    applyRecipeGate: vi.fn(() => ({ approved: {}, rejected: [], counts: { approved: 0, rejected: 0 } })),
    recipeGuidance: vi.fn(() => ""),
    addReviewItemsAndNotify: vi.fn(async () => {}),
    scoreSegment: vi.fn(() => ({ worthy: true, score: 5, signals: [], profile: "t" })),
    resolveTriageProfile: vi.fn(async () => ({})),
    classify: vi.fn(() => ({ confident: false })),
    slugify: vi.fn((s: string) => s),
  };
});

vi.mock("../../src/core/ingestion/ingest-queue.ts", () => ({ markJobBatchSubmitted: h.markJobBatchSubmitted }));
vi.mock("../../src/core/ingestion/blob-store.ts", () => ({ getBlobStore: h.getBlobStore }));
vi.mock("../../src/core/ingestion/ingest-doc.ts", () => ({ sliceForIngest: h.sliceForIngest }));
vi.mock("../../src/lib/extract-doc.ts", () => ({ extractDocText: h.extractDocText }));
vi.mock("../../src/core/ingestion/capture.ts", () => ({ capture: h.capture }));
vi.mock("../../src/core/extraction/extract.ts", () => ({
  extractOne: h.extractOne,
  buildExtractionContext: h.buildExtractionContext,
  extractUnit: h.extractUnit,
  buildExtractionUnits: h.buildExtractionUnits,
  entityHints: h.entityHints,
  freshVersion: h.freshVersion,
}));
vi.mock("../../src/core/extraction/schema-pack.ts", () => ({ ensureSchemaPack: h.ensureSchemaPack }));
vi.mock("../../src/core/retrieval/indexer.ts", () => ({ deriveIncremental: h.deriveIncremental }));
vi.mock("../../src/core/ingestion/batch-extract.ts", () => ({
  shouldUseBatch: h.shouldUseBatch,
  buildBatchRequests: h.buildBatchRequests,
  submitExtractionBatch: h.submitExtractionBatch,
}));
vi.mock("../../src/core/retrieval/embeddings.ts", () => ({ buildEmbeddings: h.buildEmbeddings }));
vi.mock("../../src/core/platform/engine.ts", () => ({ getEngine: h.getEngine }));
vi.mock("../../src/core/ingestion/golden-rule.ts", () => ({
  applyRecipeGate: h.applyRecipeGate,
  recipeGuidance: h.recipeGuidance,
  addReviewItemsAndNotify: h.addReviewItemsAndNotify,
}));
vi.mock("../../src/core/ingestion/triage.ts", () => ({
  scoreSegment: h.scoreSegment,
  resolveTriageProfile: h.resolveTriageProfile,
}));
vi.mock("../../src/core/ingestion/classify.ts", () => ({ classify: h.classify }));
vi.mock("../../src/lib/slug.ts", () => ({ slugify: h.slugify }));

import { processBlobJob } from "../../src/core/ingestion/process-blob-job.ts";

const job: any = {
  id: "j1",
  brain: "robustez-heartbeat",
  kind: "text",
  status: "processing",
  type: "",
  contentHash: null,
  filename: null,
  mime: null,
  title: "Conversa",
  jobDate: null,
  textBody: "linha 1\nlinha 2",
  progress: 0,
  message: null,
  resultJson: {},
  errorMessage: null,
  createdAt: "",
  startedAt: null,
  finishedAt: null,
  batchId: null,
  batchStatus: null,
  batchCustomMap: null,
  sourceId: null,
  leaseUntil: null,
  attempts: 1,
};

describe("Fase B síncrona — heartbeat por unit (lease renovado DENTRO da página)", () => {
  it("reporta 1× por unit ANTES de cada chamada LLM, com progresso monotônico", async () => {
    const onProgress = vi.fn(async (_f: number, _m: string) => {});
    const result = await processBlobJob(job, onProgress);
    expect(result.total).toBe(1);
    expect(h.extractUnit).toHaveBeenCalledTimes(3);

    // 1 report por unit, com a posição legível (página 1/1, unit k/3)
    const unitCalls = onProgress.mock.calls
      .map((c, i) => ({ f: c[0] as number, m: c[1] as string, order: onProgress.mock.invocationCallOrder[i] }))
      .filter((x) => /\(unit \d\/3\)/.test(x.m));
    expect(unitCalls.map((x) => x.m)).toEqual([
      "digerindo 1/1 (unit 1/3)…",
      "digerindo 1/1 (unit 2/3)…",
      "digerindo 1/1 (unit 3/3)…",
    ]);

    // o k-ésimo heartbeat precede a k-ésima chamada LLM (renova o lease ANTES da parte longa)
    // e vem DEPOIS da chamada anterior (é heartbeat de verdade, não um burst no início da página)
    const llmOrders = h.extractUnit.mock.invocationCallOrder;
    for (let k = 0; k < 3; k++) {
      expect(unitCalls[k].order).toBeLessThan(llmOrders[k]);
      if (k > 0) expect(unitCalls[k].order).toBeGreaterThan(llmOrders[k - 1]);
    }

    // progresso NUNCA regride (converge pro report por página, que segue existindo)
    const fs = onProgress.mock.calls.map((c) => c[0] as number);
    for (let i = 1; i < fs.length; i++) expect(fs[i]).toBeGreaterThanOrEqual(fs[i - 1]);
  });
});
