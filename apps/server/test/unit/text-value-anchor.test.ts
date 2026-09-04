/** Achado criacao-de-fatos #5 — viés numérico RESIDUAL no gate C4: número tinha caminho próprio de
 *  ancoragem (value no body via numberSurfaceForms, sem quote) que o fato QUALITATIVO não tinha —
 *  perfil de evidência IDÊNTICO (valor no body, quote ausente): numérico aprovado, textual
 *  enfileirado/rebaixado. Fix: textValueIsAnchored nos TRÊS espelhos do C4 (applyRecipeGate,
 *  gateClaimAnchoring, derivePageFacts) — valor textual verbatim no body ancora como número ancora.
 *  Puro, sem DB/LLM (molde p1a-sem-evidencia.test.ts + m21-golden-rule.test.ts). */
import { describe, it, expect } from "vitest";
import { textValueIsAnchored } from "../../src/lib/value-anchor.ts";
import { applyRecipeGate } from "../../src/core/ingestion/golden-rule.ts";
import { derivePageFacts } from "../../src/core/retrieval/indexer.ts";
import type { PageRow, ExtractionRow, SourceRecipe } from "../../src/core/platform/engine.ts";

const maps = { reconcileMap: {}, entityMap: {} };
const BODY = "na call de maio ficou definido: vamos focar no premium, sim, porque as clientes citam confiança.";
const page = (): PageRow => ({
  slug: "p", type: "reunioes", title: "p", date: "2026-05-01", path: "", body: BODY, content_hash: "p",
});
const ex = (item: any): ExtractionRow => ({
  source_slug: "p", type: "reunioes", date: "2026-05-01", content_hash: "p", prompt_version: "t",
  extractions: { facts: [item] },
});

describe("textValueIsAnchored — o helper (guardas anti-coincidência)", () => {
  it("value textual verbatim no body (normalizado, case-insensitive) → true", () => {
    expect(textValueIsAnchored("premium", BODY)).toBe(true);
    expect(textValueIsAnchored("PREMIUM", BODY)).toBe(true);
    expect(textValueIsAnchored("focar   no   premium", BODY)).toBe(true); // espaço colapsado
  });

  it("value ausente do body → false", () => {
    expect(textValueIsAnchored("popular", BODY)).toBe(false);
  });

  it("guarda de tamanho: 'sim'/'ok' NÃO ancoram mesmo presentes no body", () => {
    expect(textValueIsAnchored("sim", BODY)).toBe(false);
    expect(textValueIsAnchored("ok", "ok combinado")).toBe(false);
  });

  it("guarda alfabética: value só-dígitos NÃO ancora por aqui (fica no caminho numérico/C4)", () => {
    expect(textValueIsAnchored("5000", "o plano custa 5000 por mês")).toBe(false);
  });
});

describe("derivePageFacts — C4 simétrico (motor, modo livre)", () => {
  it("triple textual SEM quote com value verbatim no body → 'fato' 0.60 (igual ao numérico sem quote)", () => {
    const [f] = derivePageFacts(
      [page()],
      [ex({ entity: "accelera", predicate: "posicionamento", value: "premium" })],
      maps,
    );
    expect(f.status).toBe("fato");
    expect(f.confidence).toBeCloseTo(0.6, 10);
  });

  it("triple textual SEM quote com value AUSENTE do body → 'nao-verificado' 0.30 (C4 continua penalizando)", () => {
    const [f] = derivePageFacts(
      [page()],
      [ex({ entity: "accelera", predicate: "posicionamento", value: "popular" })],
      maps,
    );
    expect(f.status).toBe("nao-verificado");
    expect(f.confidence).toBeCloseTo(0.3, 10);
  });

  it("value curto ('sim') presente no body → continua 'nao-verificado' (guarda de tamanho)", () => {
    const [f] = derivePageFacts(
      [page()],
      [ex({ entity: "accelera", predicate: "aceite", value: "sim" })],
      maps,
    );
    expect(f.status).toBe("nao-verificado");
  });
});

describe("applyRecipeGate — C4 simétrico (gate sob contrato, espelho expressão-a-expressão)", () => {
  const RECIPE: SourceRecipe = { fields: [{ dimension: "facts", label: "Fatos", area: "" }] };

  it("triple textual sem quote com value verbatim no body → APROVADO (antes: fila 'nao_ancorado')", () => {
    const merged = { facts: [{ text: "t", entity: "accelera", predicate: "posicionamento", value: "premium" }] };
    const out = applyRecipeGate(merged, RECIPE, "f1", "pg-1", BODY);
    expect(out.rejected).toEqual([]);
    expect(out.approved.facts).toHaveLength(1);
    expect(out.approved.facts[0].source_id).toBe("f1");
  });

  it("triple textual sem quote com value ausente do body → fila 'nao_ancorado' (nada afrouxou)", () => {
    const merged = { facts: [{ text: "t", entity: "accelera", predicate: "posicionamento", value: "popular" }] };
    const out = applyRecipeGate(merged, RECIPE, "f1", "pg-1", BODY);
    expect(out.rejected).toHaveLength(1);
    expect(out.rejected[0].reason).toBe("nao_ancorado");
  });
});
