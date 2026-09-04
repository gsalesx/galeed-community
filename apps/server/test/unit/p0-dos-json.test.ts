/** P0 (#7) — DoS de JSON.parse por aninhamento profundo. O crash (RangeError de recursão) acontece
 *  DENTRO do JSON.parse, então um guard pós-parse NÃO salva: o processo já estourou a stack antes de
 *  qualquer validação rodar. O fix obrigatório é um SCAN PRÉ-PARSE puro (single-pass na string crua)
 *  que rejeita uma corrida de `[`/`{` consecutivos maior que o teto, ANTES de chamar JSON.parse.
 *  guardJsonShape pós-parse continua como defesa em profundidade (nós/profundidade do já-parseado). */
import { describe, it, expect } from "vitest";
import { scanJsonDepthPreParse, guardJsonShape, HttpError } from "../../src/connectors/web-server.ts";

describe("scanJsonDepthPreParse — barra aninhamento absurdo ANTES do JSON.parse", () => {
  it("(a) JSON profundo demais é rejeitado pelo scan (sem crash) e o JSON.parse nunca é chamado", () => {
    const deep = "[".repeat(5000) + "]".repeat(5000);
    // o scan rejeita; o teste prova que NÃO precisamos chamar JSON.parse (que estouraria a stack)
    expect(() => scanJsonDepthPreParse(deep)).toThrow(HttpError);
    try {
      scanJsonDepthPreParse(deep);
    } catch (e) {
      expect((e as HttpError).code).toBe(400);
    }
  });

  it("(a') objetos profundos (`{`) também são barrados, mesmo com espaços entre as aberturas", () => {
    const deepObj = "{ ".repeat(5000) + "}".repeat(5000);
    expect(() => scanJsonDepthPreParse(deepObj)).toThrow(HttpError);
  });

  it("(b) JSON normal (profundidade baixa) passa pelo scan sem lançar", () => {
    expect(() => scanJsonDepthPreParse(JSON.stringify({ q: "preço", brain: "accelera", nested: { a: [1, 2, 3] } }))).not.toThrow();
    // aninhamento moderado (abaixo do teto de 64) também passa
    expect(() => scanJsonDepthPreParse("[".repeat(60) + "]".repeat(60))).not.toThrow();
    // e o que passa pelo scan é JSON.parse-ável de verdade (não quebramos JSON válido)
    const ok = '{"q":"x","arr":[1,[2,[3]]]}';
    expect(() => scanJsonDepthPreParse(ok)).not.toThrow();
    expect(JSON.parse(ok)).toEqual({ q: "x", arr: [1, [2, [3]]] });
  });

  it("(b') texto com muitos colchetes NÃO-consecutivos (separados por conteúdo) não é falso-positivo", () => {
    // [][]...[] tem milhares de '[' mas a corrida nunca passa de 1 → não dispara
    expect(() => scanJsonDepthPreParse("[],".repeat(5000).replace(/,$/, ""))).not.toThrow();
  });
});

describe("guardJsonShape — defesa em profundidade pós-parse (mantida, não substituída)", () => {
  it("(c) rejeita profundidade excessiva no objeto já parseado", () => {
    // 40 níveis de aninhamento > MAX_JSON_DEPTH(32) — passa pelo scan (<64) mas é barrado pós-parse
    let obj: unknown = 1;
    for (let i = 0; i < 40; i++) obj = { x: obj };
    expect(() => guardJsonShape(obj)).toThrow();
  });

  it("(c') rejeita explosão de nós/chaves no objeto já parseado", () => {
    const wide: Record<string, number> = {};
    for (let i = 0; i < 20000; i++) wide["k" + i] = i; // > MAX_JSON_NODES(10000)
    expect(() => guardJsonShape(wide)).toThrow();
  });

  it("(c'') objeto normal passa em ambos os guards", () => {
    const normal = { q: "preço da accelera", brain: "accelera", filtros: { area: "vendas", tags: ["a", "b"] } };
    expect(() => scanJsonDepthPreParse(JSON.stringify(normal))).not.toThrow();
    expect(() => guardJsonShape(normal)).not.toThrow();
  });
});
