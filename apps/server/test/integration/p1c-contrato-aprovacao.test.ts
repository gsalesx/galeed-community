/** P1-C/item 3 — aprovação humana ATÔMICA, IDEMPOTENTE e DURÁVEL (DB real :5434). O trigger
 *  galeed_extractions_keep_approved (migração 27) é o gate da durabilidade: claim aprovado por
 *  humano NUNCA é apagado por putExtraction/re-extração. */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { hasDb, wipeBrain, rawConnect } from "./helpers/db.ts";
import { getEngine, closeEngines, type SourceRow, type ReviewItemRow } from "../../src/core/platform/engine.ts";
import { approveReviewItem, discardReviewItem } from "../../src/core/ingestion/golden-rule.ts";

const BRAIN = "itest-p1c-contrato-aprova";
const SOURCE_ID = "fonte-p1c-contrato";
const SLUG = "pag-p1c-contrato";
const REV_ID = "rev-p1c-contrato-1";
const BODY = "ficou decidido: o status do contrato é fechado, conforme a diretoria.";

const SOURCE: SourceRow = {
  id: SOURCE_ID,
  name: "Fonte P1-C",
  channel: "upload",
  type: "nota",
  recipe: { fields: [{ dimension: "decisoes", label: "Decisões", area: "" }], guidance: "" },
  default_sensitivity: "restrito",
  status: "ativa",
  last_read_at: null,
};

const REVIEW_ITEM: ReviewItemRow = {
  id: REV_ID,
  source_id: SOURCE_ID,
  source_slug: SLUG,
  dimension: "decisoes",
  text: "status do contrato fechado",
  quote: "o status do contrato é fechado",
  claim: {
    text: "status do contrato fechado",
    entity: "contrato",
    predicate: "status",
    value: "fechado",
    context_quote: "o status do contrato é fechado",
  },
  reason: "nao_ancorado",
  status: "pendente",
  decided_by: "",
  decided_at: null,
};

async function seed() {
  await wipeBrain(BRAIN);
  const e = await getEngine(BRAIN);
  await e.upsertSource(SOURCE);
  await e.upsertPage({
    slug: SLUG, type: "nota", title: "P1-C", date: "2026-01-01", path: "", body: BODY,
    content_hash: "hash-p1c-aprova", tags: [`src:${SOURCE_ID}`],
  });
  await e.addReviewItems([REVIEW_ITEM]);
}

describe.skipIf(!hasDb())("P1-C item 3 — aprovação atômica/idempotente/durável (DB real)", () => {
  beforeAll(async () => {
    await seed();
  });
  afterAll(async () => {
    await wipeBrain(BRAIN);
    await closeEngines();
  });

  it("1. aprovar deriva e marca: claim na extração com review/review_id + status aprovada + fato derivado", async () => {
    await approveReviewItem(BRAIN, REV_ID, "humano-p1c");
    const e = await getEngine(BRAIN);
    const ex = await e.getExtraction(SLUG);
    const arr = ex!.extractions!.decisoes as any[];
    expect(arr).toHaveLength(1);
    expect(arr[0].review).toBe("aprovada");
    expect(arr[0].review_id).toBe(REV_ID);

    const item = await e.getReviewItem(REV_ID);
    expect(item!.status).toBe("aprovada");

    // o STATUS epistêmico do fato é o que o MOTOR der; só asseguramos que derivou da página.
    const facts = await e.currentFacts();
    expect(facts.some((f) => f.source_slug === SLUG)).toBe(true);
  });

  it("2. aprovar 2× = no-op: resolve sem lançar e o claim segue único", async () => {
    await expect(approveReviewItem(BRAIN, REV_ID, "humano-p1c")).resolves.toBeUndefined();
    const e = await getEngine(BRAIN);
    const arr = (await e.getExtraction(SLUG))!.extractions!.decisoes as any[];
    expect(arr).toHaveLength(1);
  });

  it("3. sobrevive a putExtraction (o trigger é o gate): re-extração que 'esquece' o claim NÃO o apaga", async () => {
    const e = await getEngine(BRAIN);
    const ex = (await e.getExtraction(SLUG))!;
    await e.putExtraction({
      source_slug: SLUG, type: ex.type, date: ex.date,
      content_hash: ex.content_hash, prompt_version: "v-reextract", extractions: { decisoes: [] },
    });
    const after = (await e.getExtraction(SLUG))!.extractions!.decisoes as any[];
    expect(after).toHaveLength(1);
    expect(after[0].review_id).toBe(REV_ID);
  });

  it("4. retomada pós-crash: status volta a 'pendente', re-aprovar não duplica e re-fecha o status", async () => {
    const sql = await rawConnect();
    try {
      await sql`update galeed_ingest_review set status = 'pendente', decided_by = '', decided_at = null
                where brain = ${BRAIN} and id = ${REV_ID}`;
    } finally {
      await sql.end({ timeout: 5 });
    }
    await approveReviewItem(BRAIN, REV_ID, "humano-p1c");
    const e = await getEngine(BRAIN);
    const arr = (await e.getExtraction(SLUG))!.extractions!.decisoes as any[];
    expect(arr).toHaveLength(1); // append pulou por review_id
    expect((await e.getReviewItem(REV_ID))!.status).toBe("aprovada");
  });

  it("5. item inexistente lança 'não encontrado'; item descartado lança 'já foi decidido'", async () => {
    await expect(approveReviewItem(BRAIN, "nao-existe-p1c", "x")).rejects.toThrow(
      "item de revisão não encontrado.",
    );
    const e = await getEngine(BRAIN);
    const segundo: ReviewItemRow = { ...REVIEW_ITEM, id: "rev-p1c-contrato-2", status: "pendente" };
    await e.addReviewItems([segundo]);
    await discardReviewItem(BRAIN, "rev-p1c-contrato-2", "humano-p1c");
    await expect(approveReviewItem(BRAIN, "rev-p1c-contrato-2", "x")).rejects.toThrow(
      "este item já foi decidido.",
    );
  });
});
