/** P1-C/itens 2a/2b — o lote honra o contrato (DB real :5434 + batch-client mocado, padrão
 *  m16-batch-gate). (a) fonte sumida/pausada no harvest = FAIL-CLOSED, nada persistido, job 'error'.
 *  (b) harvest parcial NÃO sela o frescor (prompt_version '+parcial', extract_version segue ''). */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { hasDb, wipeBrain, rawConnect } from "./helpers/db.ts";
import { fakeBatchResult, fakeErroredResult, fakeHandle } from "./helpers/batch-fixtures/index.ts";

const mockGetBatchResults = vi.fn();
vi.mock("../../src/lib/batch-client.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/batch-client.ts")>();
  return { ...actual, getBatchResults: (...a: any[]) => mockGetBatchResults(...a) };
});

import { getEngine, closeEngines, type SourceRow } from "../../src/core/platform/engine.ts";
import { harvestExtractionBatch, makeCustomId } from "../../src/core/ingestion/batch-extract.ts";
import { isFresh as isFreshExtract } from "../../src/core/extraction/extract.ts";
import { enqueueIngestJob, getJob, markJobBatchSubmitted } from "../../src/core/ingestion/ingest-queue.ts";

const BRAIN = "itest-p1c-contrato-batch";
const RECIPE = { fields: [{ dimension: "facts", label: "Fatos", area: "" }], guidance: "" };
const BODY = "A Accelera cobra R$ 30 mil por mês no plano enterprise.";

function srcRow(id: string, status = "ativa"): SourceRow {
  return { id, name: `Fonte ${id}`, channel: "upload", type: "nota", recipe: RECIPE,
    default_sensitivity: "restrito", status, last_read_at: null };
}

async function seedPage(slug: string, srcId: string) {
  const e = await getEngine(BRAIN);
  await e.upsertPage({
    slug, type: "nota", title: "batch", date: "2026-01-01", path: "", body: BODY,
    content_hash: `hash-${slug}`, tags: [`src:${srcId}`],
  });
}

async function deleteSource(srcId: string) {
  const sql = await rawConnect();
  try {
    await sql`delete from galeed_sources where brain = ${BRAIN} and id = ${srcId}`;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

describe.skipIf(!hasDb())("P1-C itens 2a/2b — o lote honra o contrato (DB real, batch mocado)", () => {
  beforeAll(async () => {
    await wipeBrain(BRAIN);
  });
  afterAll(async () => {
    await wipeBrain(BRAIN);
    await closeEngines();
  });
  beforeEach(() => {
    mockGetBatchResults.mockReset();
  });

  // ─────────────────────────── (a) fail-closed ───────────────────────────
  it("2a.1 fonte SUMIDA → rejeita, job 'error', nada persistido", async () => {
    const e = await getEngine(BRAIN);
    await e.upsertSource(srcRow("src-p1c-batch-a"));
    await seedPage("pag-p1c-batch-a", "src-p1c-batch-a");
    const cid = makeCustomId("pag-p1c-batch-a", 0);
    const { jobId } = await enqueueIngestJob({ brain: BRAIN, kind: "text", type: "nota", textBody: BODY, sourceId: "src-p1c-batch-a" });
    await markJobBatchSubmitted(jobId, "batch-p1c-contrato-a", { [cid]: "pag-p1c-batch-a" });
    await deleteSource("src-p1c-batch-a"); // fonte some entre submit e harvest

    const handle = fakeHandle({ id: "batch-p1c-contrato-a", status: "ended" });
    await expect(harvestExtractionBatch(BRAIN, handle, { [cid]: "pag-p1c-batch-a" })).rejects.toThrow(
      "fonte do job não existe mais — a digestão do lote foi bloqueada pelo contrato.",
    );
    const job = await getJob(BRAIN, jobId);
    expect(job!.status).toBe("error");
    expect(job!.errorMessage).toBe("fonte do job não existe mais — a digestão do lote foi bloqueada pelo contrato.");
    expect(await e.getExtraction("pag-p1c-batch-a")).toBeUndefined(); // NADA persistido
    expect(mockGetBatchResults).not.toHaveBeenCalled(); // fail-closed ANTES de getBatchResults
  });

  it("2a.2 fonte PAUSADA → rejeita com a mensagem da pausa, job 'error'", async () => {
    const e = await getEngine(BRAIN);
    await e.upsertSource(srcRow("src-p1c-batch-a2", "pausada"));
    await seedPage("pag-p1c-batch-a2", "src-p1c-batch-a2");
    const cid = makeCustomId("pag-p1c-batch-a2", 0);
    const { jobId } = await enqueueIngestJob({ brain: BRAIN, kind: "text", type: "nota", textBody: BODY, sourceId: "src-p1c-batch-a2" });
    await markJobBatchSubmitted(jobId, "batch-p1c-contrato-a2", { [cid]: "pag-p1c-batch-a2" });

    const handle = fakeHandle({ id: "batch-p1c-contrato-a2", status: "ended" });
    await expect(harvestExtractionBatch(BRAIN, handle, { [cid]: "pag-p1c-batch-a2" })).rejects.toThrow(
      `a fonte "Fonte src-p1c-batch-a2" está pausada — retome a leitura pra digerir o lote.`,
    );
    const job = await getJob(BRAIN, jobId);
    expect(job!.status).toBe("error");
  });

  // ─────────────────────────── (b) parcial não sela ───────────────────────────
  it("2b.1 unit perdida → página parcial: prompt_version '+parcial', extract_version segue '', isFresh false", async () => {
    const e = await getEngine(BRAIN);
    await e.upsertSource(srcRow("src-p1c-batch-b"));
    await seedPage("pag-p1c-batch-b", "src-p1c-batch-b");
    const cid0 = makeCustomId("pag-p1c-batch-b", 0);
    const cid1 = makeCustomId("pag-p1c-batch-b", 1);
    const customMap = { [cid0]: "pag-p1c-batch-b", [cid1]: "pag-p1c-batch-b" };
    const { jobId } = await enqueueIngestJob({ brain: BRAIN, kind: "text", type: "nota", textBody: BODY, sourceId: "src-p1c-batch-b" });
    await markJobBatchSubmitted(jobId, "batch-p1c-contrato-b", customMap);

    mockGetBatchResults.mockResolvedValue([
      fakeBatchResult(cid0, { facts: [{ text: "preço enterprise", context_quote: "R$ 30 mil por mês", entity: "accelera", predicate: "preco", value: "R$ 30 mil", value_num: 30000 }] }),
      fakeErroredResult(cid1), // unit 1 perdida → PARCIAL
    ]);

    const out = await harvestExtractionBatch(BRAIN, fakeHandle({ id: "batch-p1c-contrato-b", status: "ended" }), customMap);
    expect(out.errored).toBe(1);
    const ex = await e.getExtraction("pag-p1c-batch-b");
    expect(ex).toBeTruthy(); // o que chegou derivou
    expect(ex!.prompt_version.endsWith("+parcial")).toBe(true);

    const pages = await e.allPages();
    const pg = pages.find((p) => p.slug === "pag-p1c-batch-b")!;
    expect(pg.extract_version || "").toBe(""); // re-extraível pela retomada P0-C
    expect(await isFreshExtract(BRAIN, pg)).toBe(false);
  });

  it("2b.2 controle: TODAS as units succeeded → prompt_version SEM sufixo, extract_version selado", async () => {
    const e = await getEngine(BRAIN);
    await e.upsertSource(srcRow("src-p1c-batch-c"));
    await seedPage("pag-p1c-batch-c", "src-p1c-batch-c");
    const cid0 = makeCustomId("pag-p1c-batch-c", 0);
    const customMap = { [cid0]: "pag-p1c-batch-c" };
    const { jobId } = await enqueueIngestJob({ brain: BRAIN, kind: "text", type: "nota", textBody: BODY, sourceId: "src-p1c-batch-c" });
    await markJobBatchSubmitted(jobId, "batch-p1c-contrato-c", customMap);

    mockGetBatchResults.mockResolvedValue([
      fakeBatchResult(cid0, { facts: [{ text: "preço enterprise", context_quote: "R$ 30 mil por mês", entity: "accelera", predicate: "preco", value: "R$ 30 mil", value_num: 30000 }] }),
    ]);
    await harvestExtractionBatch(BRAIN, fakeHandle({ id: "batch-p1c-contrato-c", status: "ended" }), customMap);
    const ex = await e.getExtraction("pag-p1c-batch-c");
    expect(ex!.prompt_version.endsWith("+parcial")).toBe(false);
    const pages = await e.allPages();
    const pg = pages.find((p) => p.slug === "pag-p1c-batch-c")!;
    expect(pg.extract_version || "").not.toBe(""); // selado
  });

  it("2b.3 P0-A intacto: chave d:<custom_id> no customMap → claim carrega a data da unit", async () => {
    const e = await getEngine(BRAIN);
    await e.upsertSource(srcRow("src-p1c-batch-d"));
    await seedPage("pag-p1c-batch-d", "src-p1c-batch-d");
    const cid0 = makeCustomId("pag-p1c-batch-d", 0);
    const customMap = { [cid0]: "pag-p1c-batch-d", [`d:${cid0}`]: "2026-03-15" };
    const { jobId } = await enqueueIngestJob({ brain: BRAIN, kind: "text", type: "nota", textBody: BODY, sourceId: "src-p1c-batch-d" });
    await markJobBatchSubmitted(jobId, "batch-p1c-contrato-d", customMap);

    mockGetBatchResults.mockResolvedValue([
      fakeBatchResult(cid0, { facts: [{ text: "preço enterprise", context_quote: "R$ 30 mil por mês", entity: "accelera", predicate: "preco", value: "R$ 30 mil", value_num: 30000 }] }),
    ]);
    await harvestExtractionBatch(BRAIN, fakeHandle({ id: "batch-p1c-contrato-d", status: "ended" }), customMap);
    const ex = await e.getExtraction("pag-p1c-batch-d");
    expect(ex!.extractions!.facts[0].date).toBe("2026-03-15"); // data da unit carimbada (P0-A)
  });
});
