/** P1-C/item 4 — extractOne re-extrai SOB o contrato (mata A8a): MESMO gate do pipeline, source_id
 *  carimbado, fail-closed se a fonte sumiu/pausou, pass-through byte-idêntico sem tag src:. DB real
 *  :5434 + llm.ts mocado PARCIAL (vi.mock + vi.hoisted: structured fixo + resolveExtractionProvider). */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { hasDb, wipeBrain, rawConnect } from "./helpers/db.ts";

// mock PARCIAL de llm.ts: structured devolve out fixo; resolveExtractionProvider devolve "api"
// (item 6 já provado no unit). vi.hoisted p/ a factory ter o fixture sem TDZ.
const mockOut = vi.hoisted(() => ({
  out: {
    decisions: [
      { text: "status fechado", entity: "contrato", predicate: "status", value: "fechado", context_quote: "o status do contrato é fechado" },
    ],
    facts: [
      { text: "fofoca solta", entity: "alguem", predicate: "humor", value: "bom", context_quote: "o status do contrato é fechado" },
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

import { getEngine, closeEngines, type SourceRow } from "../../src/core/platform/engine.ts";
import { extractOne } from "../../src/core/extraction/extract.ts";
import { reextractRun } from "../../src/connectors/bff/bff-context-edit.ts";

const BRAIN = "itest-p1c-contrato-reex";
const SRC = "fonte-p1c-reex";
const SLUG = "pag-p1c-reex";
const BODY = "ata: o status do contrato é fechado, conforme combinado.";

// receita SÓ com 'decisions' (dim default extractable → entra no ctx.dims sem merge de pack).
const SOURCE: SourceRow = {
  id: SRC, name: "Fonte Reex", channel: "upload", type: "nota",
  recipe: { fields: [{ dimension: "decisions", label: "Decisões", area: "" }], guidance: "" },
  default_sensitivity: "restrito", status: "ativa", last_read_at: null,
};

async function seedPage(slug: string, tags: string[]) {
  const e = await getEngine(BRAIN);
  await e.upsertPage({
    slug, type: "nota", title: "reex", date: "2026-01-01", path: "", body: BODY,
    content_hash: `hash-${slug}-${Date.now()}`, tags,
  });
  return (await e.getPage(slug))!;
}

describe.skipIf(!hasDb())("P1-C item 4 — extractOne gateado + fail-closed (DB real, LLM mocado)", () => {
  beforeAll(async () => {
    await wipeBrain(BRAIN);
    const e = await getEngine(BRAIN);
    await e.upsertSource(SOURCE);
  });
  afterAll(async () => {
    await wipeBrain(BRAIN);
    await closeEngines();
  });
  beforeEach(async () => {
    // re-garante a fonte ativa entre os its que a deletam/pausam
    const e = await getEngine(BRAIN);
    await e.upsertSource({ ...SOURCE, status: "ativa" });
  });

  it("1. gate na re-extração: source_id carimbado em decisions; dim fora da receita vai pra fila", async () => {
    const page = await seedPage(SLUG, [`src:${SRC}`]);
    await extractOne(BRAIN, page);
    const e = await getEngine(BRAIN);
    const ex = await e.getExtraction(SLUG);
    expect(ex!.extractions!.decisions[0].source_id).toBe(SRC);
    expect((ex!.extractions!.facts ?? [])).toHaveLength(0); // fora da receita → não aprovado
    const pend = await e.listReview({ status: "pendente" });
    expect(pend.some((r) => r.dimension === "facts" && r.reason === "fora_da_receita")).toBe(true);
  });

  it("2. fonte pausada → fail-closed", async () => {
    const e = await getEngine(BRAIN);
    await e.upsertSource({ ...SOURCE, status: "pausada" });
    const page = await seedPage("pag-p1c-reex-pausada", [`src:${SRC}`]);
    await expect(extractOne(BRAIN, page)).rejects.toThrow(/está pausada/);
  });

  it("3. fonte sumida → fail-closed com mensagem do contrato", async () => {
    const page = await seedPage("pag-p1c-reex-sumida", ["src:fonte-inexistente-p1c"]);
    await expect(extractOne(BRAIN, page)).rejects.toThrow(
      "a fonte desta página não existe mais — re-extração bloqueada pelo contrato.",
    );
  });

  it("4. página SEM tag src: → pass-through (merged cru, sem gate, sem review novo)", async () => {
    const e = await getEngine(BRAIN);
    const before = (await e.listReview({ status: "pendente", limit: 999 })).length;
    const page = await seedPage("pag-p1c-reex-semtag", []);
    await extractOne(BRAIN, page);
    const ex = await e.getExtraction("pag-p1c-reex-semtag");
    // pass-through: a dim 'facts' (fora de qualquer receita) AINDA está nas extrações (não gateada)
    expect(ex!.extractions!.facts).toHaveLength(1);
    expect(ex!.extractions!.decisions).toHaveLength(1);
    const after = (await e.listReview({ status: "pendente", limit: 999 })).length;
    expect(after).toBe(before); // nenhum review novo
  });

  it("5. reextractRun não aborta o lote: 1 bloqueada (pausada) + 1 re-extraível → reextracted=1, blocked=1", async () => {
    const e = await getEngine(BRAIN);
    // página A: fonte pausada → bloqueia
    await e.upsertSource({ ...SOURCE, id: "fonte-pausada-p1c", status: "pausada" });
    await seedPage("pag-p1c-reex-A", ["src:fonte-pausada-p1c"]);
    // página B: sem fonte → pass-through, re-extraível
    await seedPage("pag-p1c-reex-B", []);
    const r = await reextractRun(BRAIN);
    expect(r.reextracted).toBeGreaterThanOrEqual(1);
    expect(r.blocked).toBeGreaterThanOrEqual(1);
    expect(r.message).toMatch(/fic(ou|aram) de fora/);
  });
});
