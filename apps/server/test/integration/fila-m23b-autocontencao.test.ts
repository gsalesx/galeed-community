/** M23-B/§5.D — gate de auto-contenção fim-a-fim na FILA (DB real :5434). Claim vago vai pra
 *  fila com reason='entidade_vaga'; entidade legítima nova deriva fato; round-trip do motivo
 *  pela coluna text (sem CHECK); aprovar → fato com selo (fluxo M21 intacto). Moldes:
 *  p1c-contrato-reextract + p1c-contrato-aprovacao. llm.ts mocado PARCIAL (vi.mock + vi.hoisted). */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { hasDb, wipeBrain } from "./helpers/db.ts";

const BODY =
  "ata: ela escolheu o plano pocket nesta reunião; teobaldo vai ser o mentor da turma.";

// mock PARCIAL: structured devolve out fixo (1 vago + 1 nome próprio novo, ambos na dim da receita);
// resolveExtractionProvider → "api". vi.hoisted p/ a factory ter o fixture sem TDZ.
const mockOut = vi.hoisted(() => ({
  out: {
    decisions: [
      { text: "plano dela", entity: "ela", predicate: "plano", value: "pocket", context_quote: "ela escolheu o plano pocket" },
      { text: "mentor", entity: "teobaldo", predicate: "funcao", value: "mentor", context_quote: "teobaldo vai ser o mentor da turma" },
    ],
  } as Record<string, any[]>,
}));
vi.mock("../../src/lib/llm.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/llm.ts")>();
  return {
    ...actual,
    structured: vi.fn(async () => mockOut.out),
    resolveExtractionProvider: vi.fn(() => "api" as const),
  };
});

import { getEngine, closeEngines, type SourceRow, type ReviewItemRow } from "../../src/core/platform/engine.ts";
import { extractOne } from "../../src/core/extraction/extract.ts";
import { approveReviewItem } from "../../src/core/ingestion/golden-rule.ts";

const BRAIN = "itest-m23b-autocontencao";
const SRC = "fonte-m23b-autocontencao";
const SLUG = "pag-m23b-autocontencao";

const SOURCE: SourceRow = {
  id: SRC, name: "Fonte M23-B", channel: "upload", type: "nota",
  recipe: { fields: [{ dimension: "decisions", label: "Decisões", area: "" }], guidance: "" },
  default_sensitivity: "restrito", status: "ativa", last_read_at: null,
};

async function seedPage(slug: string) {
  const e = await getEngine(BRAIN);
  await e.upsertPage({
    slug, type: "nota", title: "m23b", date: "2026-01-01", path: "", body: BODY,
    content_hash: `hash-${slug}-${Date.now()}`, tags: [`src:${SRC}`],
  });
  return (await e.getPage(slug))!;
}

describe.skipIf(!hasDb())("M23-B — fila de auto-contenção (DB real, LLM mocado)", () => {
  beforeAll(async () => {
    await wipeBrain(BRAIN);
    const e = await getEngine(BRAIN);
    await e.upsertSource(SOURCE);
  });
  afterAll(async () => {
    await wipeBrain(BRAIN);
    await closeEngines();
  });

  it("1. página semeada → claim vago vira hipótese 'entidade_vaga'; NÃO entra na extração aprovada", async () => {
    const page = await seedPage(SLUG);
    await extractOne(BRAIN, page);
    const e = await getEngine(BRAIN);
    const pend = await e.listReview({ status: "pendente" });
    const vago = pend.find((r) => r.source_slug === SLUG && r.reason === "entidade_vaga");
    expect(vago).toBeTruthy();
    // o claim vago NÃO está na extração aprovada (só o teobaldo)
    const ex = await e.getExtraction(SLUG);
    const arr = (ex!.extractions!.decisions ?? []) as any[];
    expect(arr.some((c) => c.entity === "ela")).toBe(false);
  });

  it("2. round-trip do motivo: addReviewItems → getReviewItem/listReview devolvem 'entidade_vaga' (coluna text, sem CHECK)", async () => {
    const e = await getEngine(BRAIN);
    const item: ReviewItemRow = {
      id: "rev-m23b-roundtrip", source_id: SRC, source_slug: SLUG, dimension: "decisions",
      text: "x", quote: "ela escolheu o plano pocket",
      claim: { text: "x", entity: "ela", predicate: "plano", value: "pocket", context_quote: "ela escolheu o plano pocket" },
      reason: "entidade_vaga", status: "pendente", decided_by: "", decided_at: null,
    };
    await e.addReviewItems([item]);
    expect((await e.getReviewItem("rev-m23b-roundtrip"))!.reason).toBe("entidade_vaga");
    const pend = await e.listReview({ status: "pendente" });
    expect(pend.find((r) => r.id === "rev-m23b-roundtrip")!.reason).toBe("entidade_vaga");
  });

  it("3. aprovar a hipótese vaga → fato com selo (fluxo M21 intacto)", async () => {
    const e = await getEngine(BRAIN);
    // pega a hipótese vaga real gerada pelo extractOne no it.1
    const pend = await e.listReview({ status: "pendente" });
    const vago = pend.find((r) => r.source_slug === SLUG && r.reason === "entidade_vaga" && r.id !== "rev-m23b-roundtrip")!;
    await approveReviewItem(BRAIN, vago.id, "humano-m23b");
    const facts = await e.currentFacts();
    const fato = facts.find((f) => f.source_slug === SLUG && f.entity === "ela");
    expect(fato).toBeTruthy();
    expect(fato!.source_id).toBe(SRC);
  });

  it("4. entidade legítima nova (teobaldo) NÃO vai pra fila; deriva fato", async () => {
    const e = await getEngine(BRAIN);
    const pend = await e.listReview({ status: "pendente" });
    expect(pend.some((r) => r.source_slug === SLUG && (r.claim as any)?.entity === "teobaldo")).toBe(false);
    const facts = await e.currentFacts();
    expect(facts.some((f) => f.source_slug === SLUG && f.entity === "teobaldo")).toBe(true);
  });
});
