/** M23-B/§5.B — gate PURO (sem DB): a cadeia de gates com `entidade_vaga` na ORDEM cravada
 *  (fora_da_receita → entidade_vaga → nao_ancorado/C4 → nao_ancorado/âncora). Molde:
 *  p1c-contrato-gate.test.ts. Asserts medidos contra o comportamento real (LEARNINGS M17/S4). */
import { describe, it, expect } from "vitest";
import { applyRecipeGate } from "../../src/core/ingestion/golden-rule.ts";
import type { SourceRecipe } from "../../src/core/platform/engine.ts";

const RECIPE: SourceRecipe = {
  fields: [{ dimension: "decisoes", label: "Decisões", area: "" }],
  guidance: "",
};

const BODY = "ela escolheu o plano pocket; teobaldo vai ser o mentor da turma";

describe("M23-B — gate de auto-contenção (cadeia de gates, ordem cravada)", () => {
  it("1. claim vago ANCORADO sob receita → entidade_vaga, approved vazio, id determinístico", () => {
    const merged = {
      decisoes: [{ text: "plano", entity: "ela", predicate: "plano", value: "pocket", context_quote: "ela escolheu o plano pocket" }],
    };
    const a = applyRecipeGate(merged, RECIPE, "f1", "pg-1", BODY);
    const b = applyRecipeGate(merged, RECIPE, "f1", "pg-1", BODY);
    expect(a.rejected).toHaveLength(1);
    expect(a.rejected[0].reason).toBe("entidade_vaga");
    expect(a.approved.decisoes).toEqual([]);
    expect(a.rejected[0].id).toBe(b.rejected[0].id); // 2 runs ⇒ mesmo id
  });

  it("2. ORDEM 1×2: claim vago em dimensão FORA da receita → fora_da_receita (a dim vence)", () => {
    const merged = {
      outra_dim: [{ text: "x", entity: "ela", predicate: "plano", value: "pocket", context_quote: "ela escolheu o plano pocket" }],
    };
    const out = applyRecipeGate(merged, RECIPE, "f1", "pg-1", BODY);
    expect(out.rejected).toHaveLength(1);
    expect(out.rejected[0].reason).toBe("fora_da_receita");
  });

  it("3. ORDEM 2×3: claim vago SEM evidência (sem value_num, sem quote) → entidade_vaga (identidade vence o C4)", () => {
    const merged = {
      decisoes: [{ text: "x", entity: "a empresa", predicate: "faturamento", value: "100k" }],
    };
    const out = applyRecipeGate(merged, RECIPE, "f1", "pg-1", BODY);
    expect(out.rejected).toHaveLength(1);
    expect(out.rejected[0].reason).toBe("entidade_vaga");
  });

  it("4. ORDEM 2×4: claim vago com quote NÃO-verbatim → entidade_vaga (identidade vence a ancoragem)", () => {
    const merged = {
      decisoes: [{ text: "x", entity: "ela", predicate: "plano", value: "pocket", context_quote: "isso nunca foi dito no texto" }],
    };
    const out = applyRecipeGate(merged, RECIPE, "f1", "pg-1", BODY);
    expect(out.rejected).toHaveLength(1);
    expect(out.rejected[0].reason).toBe("entidade_vaga");
  });

  it("5. entidade legítima desconhecida ancorada (teobaldo) → aprovado com source_id, rejected vazio", () => {
    const merged = {
      decisoes: [{ text: "mentor", entity: "teobaldo", predicate: "funcao", value: "mentor", context_quote: "teobaldo vai ser o mentor da turma" }],
    };
    const out = applyRecipeGate(merged, RECIPE, "f1", "pg-1", BODY);
    expect(out.approved.decisoes).toHaveLength(1);
    expect(out.approved.decisoes[0].source_id).toBe("f1");
    expect(out.rejected).toEqual([]);
  });

  it("6. registrado (sem triple) com quote verbatim → aprovado (gate de entidade exige hasTriple)", () => {
    const merged = {
      decisoes: [{ text: "obs", entity: "", predicate: "", value: "", context_quote: "ela escolheu o plano pocket" }],
    };
    const out = applyRecipeGate(merged, RECIPE, "f1", "pg-1", BODY);
    expect(out.approved.decisoes).toHaveLength(1);
    expect(out.rejected).toEqual([]);
  });

  it("7. recipe=null → pass-through MESMA referência (golden intacto)", () => {
    const merged = { decisoes: [{ text: "x", entity: "ela", predicate: "plano", value: "pocket" }] };
    const out = applyRecipeGate(merged, null, "", "pg-1", BODY);
    expect(out.approved).toBe(merged);
    expect(out.rejected).toEqual([]);
  });
});
