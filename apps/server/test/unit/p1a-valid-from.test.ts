/** P1-A/A1d: só ISO entra na cadeia bitemporal. `normalizeValidFrom` é uma WHITELIST
 *  (YYYY | YYYY-MM | YYYY-MM-DD; timestamp ISO truncado pra data), NÃO um parser de linguagem
 *  natural (invariante #9). `factValidFrom` encadeia os candidatos válidos com fallback
 *  determinístico. Função pura — sem DB. */
import { describe, it, expect } from "vitest";
import { normalizeValidFrom, factValidFrom } from "../../src/core/retrieval/indexer.ts";

describe("normalizeValidFrom — aceita e normaliza ISO", () => {
  it("YYYY / YYYY-MM / YYYY-MM-DD passam intactos", () => {
    expect(normalizeValidFrom("2024")).toBe("2024");
    expect(normalizeValidFrom("2024-03")).toBe("2024-03");
    expect(normalizeValidFrom("2024-03-12")).toBe("2024-03-12");
  });
  it("timestamp ISO é truncado pra data", () => {
    expect(normalizeValidFrom("2024-03-12T14:30:15Z")).toBe("2024-03-12");
    expect(normalizeValidFrom("2024-03-12 14:30")).toBe("2024-03-12");
  });
  it("trim de espaços nas bordas", () => {
    expect(normalizeValidFrom(" 2024-03-12 ")).toBe("2024-03-12");
  });
});

describe("normalizeValidFrom — rejeita não-ISO (→ '')", () => {
  const rejeitados: Array<[string, unknown]> = [
    ["linguagem natural", "março de 2024"],
    ["dd/mm/yyyy", "12/03/2024"],
    ["barra no mês", "2024/03"],
    ["mês 13", "2024-13"],
    ["mês 00", "2024-00-10"],
    ["dia 32", "2024-03-32"],
    ["trimestre", "Q1 2024"],
    ["relativo", "ontem"],
    ["vazio", ""],
    ["null", null],
    ["undefined", undefined],
    ["number vira string inválida", 42],
  ];
  for (const [nome, raw] of rejeitados) {
    it(`rejeita ${nome}`, () => {
      expect(normalizeValidFrom(raw)).toBe("");
    });
  }
});

describe("factValidFrom — fallback determinístico", () => {
  it("valid_from lixo + date ISO → devolve o date (carimbo da unit, P0-A)", () => {
    expect(factValidFrom({ valid_from: "março de 2024", date: "2026-04-10" }, "")).toBe("2026-04-10");
  });
  it("tudo lixo + sourceDate ISO → devolve o sourceDate", () => {
    expect(factValidFrom({ valid_from: "ontem", date: "Q1", since: "" }, "2026-05-10")).toBe("2026-05-10");
  });
  it("tudo lixo → ''", () => {
    expect(factValidFrom({ valid_from: "ontem", date: "Q1", since: "amanhã" }, "nunca")).toBe("");
  });
  it("valid_from ISO ganha de date ISO (ordem dos candidatos preservada)", () => {
    expect(factValidFrom({ valid_from: "2024-01-01", date: "2026-04-10" }, "")).toBe("2024-01-01");
  });
});
