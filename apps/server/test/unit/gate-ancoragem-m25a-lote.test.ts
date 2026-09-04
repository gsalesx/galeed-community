/** M25-A/§5.A — gate DETERMINÍSTICO de ancoragem de claim SALVO (gateClaimAnchoring), PURO,
 *  sem DB. A LEI: decisão humana é por LOTE, ancoragem é por ITEM — este gate é a cadeia M23-B
 *  SEM o passo 1 (fora_da_receita). Fixture 9 é o ESPELHO: pra um claim DENTRO da receita,
 *  applyRecipeGate aprova ⇔ gateClaimAnchoring === null (trava a deriva entre as duas cadeias).
 *  Molde: gate-m23b-autocontencao.test.ts. */
import { describe, it, expect } from "vitest";
import {
  gateClaimAnchoring,
  applyRecipeGate,
  LOTE_PORQUE,
} from "../../src/core/ingestion/golden-rule.ts";
import type { SourceRecipe } from "../../src/core/platform/engine.ts";

// quote verbatim conhecido plantado no body:
const QUOTE = "você tá no ramo de clínicas também, não tá?";
const BODY = `Eh, eu tenho brevemente assim lembrança de qual que é teu negócio. ${QUOTE}`;
const BODY_NUM = `o plano custou 30 mil reais no fechamento. ${QUOTE}`;

describe("M25-A — gateClaimAnchoring (cadeia de ancoragem, ordem cravada, zero LLM)", () => {
  it("1. claim SEM triple (shape do grupão) com quote verbatim → null (passa)", () => {
    const claim = {
      text: "André está no ramo de clínicas",
      entity: "andre-mikaelian",
      context_quote: QUOTE,
    };
    expect(gateClaimAnchoring(claim, BODY)).toBeNull();
  });

  it("2. claim sem triple com quote NÃO-verbatim → LOTE_PORQUE.nao_ancorado", () => {
    const claim = {
      text: "qualquer coisa",
      entity: "andre",
      context_quote: "uma frase totalmente inventada que jamais consta nesta página xyzzy",
    };
    expect(gateClaimAnchoring(claim, BODY)).toBe(LOTE_PORQUE.nao_ancorado);
  });

  it("3. claim sem triple SEM quote → LOTE_PORQUE.nao_ancorado (sem âncora não passa)", () => {
    const claim = { text: "algo", entity: "andre" };
    expect(gateClaimAnchoring(claim, BODY)).toBe(LOTE_PORQUE.nao_ancorado);
  });

  it("4. triple ancorado (entity/predicate/quote verbatim) → null", () => {
    const claim = {
      text: "andré no ramo de clínicas",
      entity: "andre-mikaelian",
      predicate: "ramo",
      value: "clínicas",
      context_quote: QUOTE,
    };
    expect(gateClaimAnchoring(claim, BODY)).toBeNull();
  });

  it("5. triple com entity vaga ('ela') MESMO ancorado → LOTE_PORQUE.entidade_vaga (ordem 2 vence)", () => {
    const claim = {
      text: "x",
      entity: "ela",
      predicate: "ramo",
      value: "clínicas",
      context_quote: QUOTE,
    };
    expect(gateClaimAnchoring(claim, BODY)).toBe(LOTE_PORQUE.entidade_vaga);
  });

  it("6. triple sem value_num, sem quote e com value AUSENTE do body → LOTE_PORQUE.sem_evidencia (C4)", () => {
    // value "advocacia" NÃO está no body — evidência nenhuma. (Antes o caso usava "clínicas", que
    // ESTÁ no body: com o fix do viés numérico residual — criacao-de-fatos #5 — valor textual
    // verbatim no body agora ANCORA, como número ancora; ver caso 6b.)
    const claim = { text: "x", entity: "andre", predicate: "ramo", value: "advocacia" };
    expect(gateClaimAnchoring(claim, BODY)).toBe(LOTE_PORQUE.sem_evidencia);
  });

  it("6b. triple sem value_num e sem quote mas com value TEXTUAL verbatim no body → null (simetria com o número)", () => {
    const claim = { text: "x", entity: "andre", predicate: "ramo", value: "clínicas" };
    expect(gateClaimAnchoring(claim, BODY)).toBeNull();
  });

  it("7. triple com value_num que NÃO está no body → LOTE_PORQUE.nao_ancorado", () => {
    const claim = {
      text: "preço 999",
      entity: "plano",
      predicate: "preco",
      value: "999",
      value_num: 999,
      context_quote: QUOTE,
    };
    expect(gateClaimAnchoring(claim, BODY)).toBe(LOTE_PORQUE.nao_ancorado);
  });

  it("8. pageBody vazio (página sumida) com quote presente → LOTE_PORQUE.nao_ancorado", () => {
    const claim = { text: "x", entity: "andre", context_quote: QUOTE };
    expect(gateClaimAnchoring(claim, "")).toBe(LOTE_PORQUE.nao_ancorado);
  });

  it("9. ESPELHO do applyRecipeGate: com a dim NA receita, applyRecipeGate aprova ⇔ gate === null", () => {
    const recipe: SourceRecipe = {
      fields: [{ dimension: "claims", label: "Claims", area: "" }],
      guidance: "",
    };
    const fixtures: { claim: any; body: string }[] = [
      { claim: { text: "a", entity: "andre-mikaelian", context_quote: QUOTE }, body: BODY }, // 1
      { claim: { text: "b", entity: "andre", context_quote: "frase inventada xyzzy" }, body: BODY }, // 2
      { claim: { text: "c", entity: "andre" }, body: BODY }, // 3
      { claim: { text: "d", entity: "andre-mikaelian", predicate: "ramo", value: "clínicas", context_quote: QUOTE }, body: BODY }, // 4
      { claim: { text: "e", entity: "ela", predicate: "ramo", value: "clínicas", context_quote: QUOTE }, body: BODY }, // 5
      { claim: { text: "f", entity: "andre", predicate: "ramo", value: "advocacia" }, body: BODY }, // 6 (value ausente do body)
      { claim: { text: "f2", entity: "andre", predicate: "ramo", value: "clínicas" }, body: BODY }, // 6b (value verbatim → ambos aprovam)
      { claim: { text: "g", entity: "plano", predicate: "preco", value: "999", value_num: 999, context_quote: QUOTE }, body: BODY }, // 7
      { claim: { text: "h", entity: "andre", context_quote: QUOTE }, body: "" }, // 8
      // extra: triple numérico ANCORADO (30 mil no body) → ambos aprovam
      { claim: { text: "i", entity: "plano", predicate: "preco", value: "30 mil", value_num: 30000, context_quote: QUOTE }, body: BODY_NUM }, // 9
    ];
    for (const { claim, body } of fixtures) {
      const gatePassa = gateClaimAnchoring(claim, body) === null;
      const recipeAprova =
        applyRecipeGate({ claims: [claim] }, recipe, "f1", "pg-1", body).counts.approved === 1;
      expect(gatePassa).toBe(recipeAprova);
    }
  });
});
