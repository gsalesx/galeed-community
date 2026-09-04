/** Achado criacao-de-fatos #6 — número por EXTENSO não ancorava: fonte "o prazo é de trinta dias",
 *  claim value='30 dias'/value_num=30 com quote perfeita → rebaixado a 'nao-verificado' porque
 *  numberSurfaceForms só gera grafias com dígito. Fix: numberWordForms (tabela pt-BR mínima) num 2º
 *  loop de valueIsAnchored, casando com FRONTEIRA DE PALAVRA (nunca includes cru — "dez"⊂"dezembro",
 *  "cem"⊂"recém" seriam âncoras falsas; ADR-003). Puro, sem DB/LLM. */
import { describe, it, expect } from "vitest";
import { valueIsAnchored, numberWordForms } from "../../src/lib/value-anchor.ts";

describe("valueIsAnchored — número por extenso pt-BR ancora", () => {
  it("'trinta dias' na fonte ancora value_num=30", () => {
    expect(valueIsAnchored("30 dias", 30, "o prazo é de trinta dias")).toBe(true);
  });

  it("'cem mil reais' na fonte ancora value_num=100000 (composição de magnitude)", () => {
    expect(valueIsAnchored("R$ 100 mil", 100000, "orçamento de cem mil reais aprovado")).toBe(true);
  });

  it("'quinze dias' ancora value_num=15; 'dois milhões' ancora 2000000", () => {
    expect(valueIsAnchored("15 dias", 15, "entrega em quinze dias úteis")).toBe(true);
    expect(valueIsAnchored("2 milhões", 2_000_000, "faturamento de dois milhões no ano")).toBe(true);
  });

  it("NEGATIVO: value_num=1 com body contendo só o artigo 'um' NÃO ancora (n=1 excluído de propósito)", () => {
    expect(valueIsAnchored("1 sócio", 1, "um detalhe importante do contrato")).toBe(false);
  });

  it("NEGATIVO: value_num=10 com 'dezembro' no body NÃO ancora (fronteira de palavra)", () => {
    expect(valueIsAnchored("10 unidades", 10, "em dezembro fechamos o balanço")).toBe(false);
  });

  it("NEGATIVO: composto 'cem mil' NÃO casa dentro de outra palavra ('recem mil')", () => {
    expect(valueIsAnchored("100 mil", 100_000, "o recem mil vezes citado relatório")).toBe(false);
  });

  it("regressão: grafias com dígito continuam ancorando como antes (surface forms intactas)", () => {
    expect(valueIsAnchored("R$ 30 mil", 30000, "o plano custa 30 mil por mês")).toBe(true);
    expect(valueIsAnchored("R$ 30 mil", 30000, "o plano custa R$ 28 mil por mês")).toBe(false);
  });
});

describe("numberWordForms — tabela mínima e guardas", () => {
  it("formas simples: 30→trinta; 100→cem; 1000→mil; 3→três/tres (variante sem acento)", () => {
    expect(numberWordForms(30)).toContain("trinta");
    expect(numberWordForms(100)).toContain("cem");
    expect(numberWordForms(1000)).toContain("mil");
    expect(numberWordForms(3)).toEqual(expect.arrayContaining(["três", "tres"]));
  });

  it("composição: 30000→'trinta mil'; 100000→'cem mil'; 2000000→'dois milhões'", () => {
    expect(numberWordForms(30000)).toContain("trinta mil");
    expect(numberWordForms(100000)).toContain("cem mil");
    expect(numberWordForms(2_000_000)).toContain("dois milhões");
  });

  it("guardas: n=1 → [] (artigo); 1000000 NÃO gera 'mil mil'; não-inteiro/fora da tabela → []", () => {
    expect(numberWordForms(1)).toEqual([]);
    expect(numberWordForms(1_000_000)).toEqual([]);
    expect(numberWordForms(1.5)).toEqual([]);
    expect(numberWordForms(45)).toEqual([]); // não exaustivo por decisão (sem "quarenta e cinco")
  });

  it("pares de gênero: 2 → dois E duas ('duas parcelas' ancora value_num=2)", () => {
    expect(numberWordForms(2)).toEqual(expect.arrayContaining(["dois", "duas"]));
    expect(valueIsAnchored("2 parcelas", 2, "pagamento em duas parcelas iguais")).toBe(true);
  });
});
