/** P1-C/item 1 — gate PURO (sem DB): triple não-numérico SEM context_quote NUNCA vira fato sob
 *  contrato (mata C4, lado gate). Espelho EXATO do predicado CANÔNICO do P1-A no indexer
 *  (hasTriple && value_num === null && quote === "" — fix-1 do reconcile P1; value_num 0 É
 *  numérico e segue pro ramo de ancoragem). recipe=null segue pass-through byte-idêntico. */
import { describe, it, expect } from "vitest";
import { applyRecipeGate } from "../../src/core/ingestion/golden-rule.ts";
import type { SourceRecipe } from "../../src/core/platform/engine.ts";

const RECIPE: SourceRecipe = {
  fields: [{ dimension: "decisoes", label: "Decisões", area: "" }],
  guidance: "",
};

const BODY = "ficou decidido: o plano sobe pra R$ 30 mil em março";

describe("P1-C item 1 — triple não-numérico sem quote → fila (gate puro)", () => {
  it("1. triple NÃO-numérico SEM quote → rejeitado 'nao_ancorado', approved vazio", () => {
    const merged = { decisoes: [{ text: "x", entity: "acme", predicate: "status", value: "fechado" }] };
    const out = applyRecipeGate(merged, RECIPE, "f1", "pg-1", BODY);
    expect(out.rejected).toHaveLength(1);
    expect(out.rejected[0].reason).toBe("nao_ancorado");
    expect(out.approved.decisoes).toEqual([]);
  });

  it("2. triple NÃO-numérico COM quote verbatim → aprovado com source_id carimbado", () => {
    const merged = {
      decisoes: [{ text: "x", entity: "acme", predicate: "status", value: "fechado", context_quote: "ficou decidido" }],
    };
    const out = applyRecipeGate(merged, RECIPE, "f1", "pg-1", BODY);
    expect(out.approved.decisoes).toHaveLength(1);
    expect(out.approved.decisoes[0].source_id).toBe("f1");
    expect(out.rejected).toEqual([]);
  });

  it("3. triple NUMÉRICO ancorado SEM quote → aprovado (o número É a âncora — inalterado)", () => {
    const merged = {
      decisoes: [{ text: "plano", entity: "acme", predicate: "preco", value: "R$ 30 mil", value_num: 30000 }],
    };
    const out = applyRecipeGate(merged, RECIPE, "f1", "pg-1", BODY);
    expect(out.approved.decisoes).toHaveLength(1);
    expect(out.approved.decisoes[0].source_id).toBe("f1");
    expect(out.rejected).toEqual([]);
  });

  // fix-1 do reconcile P1: 0 É numérico (predicado canônico do P1-A: value_num === null) —
  // o claim com value_num=0 NÃO cai na regra C4; segue pro ramo de ANCORAGEM, igual ao indexer.
  // Asserts medidos contra o comportamento real (LEARNINGS M17/S4).
  it("4a. value_num=0 sem quote, grafia de 0 presente no body → APROVADO (0 é numérico e ancora)", () => {
    const merged = {
      decisoes: [{ text: "x", entity: "acme", predicate: "saldo", value: "0 pendências", value_num: 0 }],
    };
    const out = applyRecipeGate(merged, RECIPE, "f1", "pg-1", "tudo certo: 0 pendências no fechamento");
    expect(out.approved.decisoes).toHaveLength(1);
    expect(out.approved.decisoes[0].source_id).toBe("f1");
    expect(out.rejected).toEqual([]);
  });

  it("4b. value_num=0 sem quote, body SEM grafia de 0 → fila por NÃO-ancorado (ramo de ancoragem, não o C4)", () => {
    const merged = {
      decisoes: [{ text: "x", entity: "acme", predicate: "saldo", value: "zerado", value_num: 0 }],
    };
    const out = applyRecipeGate(merged, RECIPE, "f1", "pg-1", "ficou decidido: o plano sobe pra R$ 31 mil em março");
    expect(out.rejected).toHaveLength(1);
    expect(out.rejected[0].reason).toBe("nao_ancorado");
    expect(out.approved.decisoes).toEqual([]);
  });

  it("5. recipe=null → pass-through byte-idêntico (MESMA referência), rejected=[]", () => {
    const merged = { decisoes: [{ text: "x", entity: "acme", predicate: "status", value: "fechado" }] };
    const out = applyRecipeGate(merged, null, "", "pg-1", BODY);
    expect(out.approved).toBe(merged); // MESMA referência — prova que o golden não muda
    expect(out.rejected).toEqual([]);
  });

  it("6. ids determinísticos: 2 runs sobre o MESMO input → rejected[0].id idêntico", () => {
    const merged = { decisoes: [{ text: "x", entity: "acme", predicate: "status", value: "fechado" }] };
    const a = applyRecipeGate(merged, RECIPE, "f1", "pg-1", BODY);
    const b = applyRecipeGate(merged, RECIPE, "f1", "pg-1", BODY);
    expect(a.rejected[0].id).toBe(b.rejected[0].id);
  });
});
