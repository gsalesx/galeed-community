/** P1-B (mata A3) — matchEntities por WORD-BOUNDARY (não substring) + matchPredicates nova
 *  (§2.2 da DESIGN-SPEC). Puro. O bug "aceleradora"→"accelera" morre; o caso documentado
 *  `inject_system`↔"Inject" NÃO regride. */
import { describe, it, expect } from "vitest";
import { matchEntities, matchPredicates } from "../../src/core/retrieval/ask.ts";

describe("matchEntities — word-boundary (P1-B)", () => {
  it("1. o bug morre: 'aceleradora' NÃO casa a entidade 'accelera'", () => {
    expect(matchEntities("o que a aceleradora fez em 2024?", ["accelera"])).toEqual([]);
  });

  it("2. palavra inteira casa; pontuação é fronteira", () => {
    expect(matchEntities("qual o preço da accelera?", ["accelera"])).toEqual(["accelera"]);
    expect(matchEntities("...da accelera, hoje?", ["accelera"])).toEqual(["accelera"]);
    expect(matchEntities("(accelera)", ["accelera"])).toEqual(["accelera"]);
  });

  it("3. não-regressão do JSDoc: 'Inject' casa 'inject_system'", () => {
    expect(matchEntities("Inject", ["inject_system"])).toEqual(["inject_system"]);
  });

  it("4. multi-token: token distintivo presente/ausente", () => {
    expect(matchEntities("a accelera 360 cresceu", ["accelera 360"])).toEqual(["accelera 360"]);
    expect(matchEntities("um projeto 360 qualquer", ["accelera 360"])).toEqual([]);
  });
});

describe("matchPredicates — tokens + word-boundary + fold (P1-B)", () => {
  it("5. 'preço' (acento) casa o predicado 'preco'", () => {
    expect(
      matchPredicates("qual o preço da accelera em março de 2024?", ["preco", "aluno_de", "clientes", "mrr"]),
    ).toEqual(["preco"]);
  });

  it("6. sinônimo NÃO casa (M23): 'custava' não acha 'preco'", () => {
    expect(matchPredicates("quanto custava em março de 2024?", ["preco", "aluno_de", "clientes", "mrr"])).toEqual([]);
  });

  it("7. token curto que casou inteiro: 'mrr'", () => {
    expect(matchPredicates("qual o mrr atual?", ["mrr", "preco"])).toEqual(["mrr"]);
  });

  it("8. 'aluno de' casa 'aluno_de' ('de' filtrado por len<3)", () => {
    expect(matchPredicates("quem é aluno de quem?", ["aluno_de"])).toEqual(["aluno_de"]);
  });
});
