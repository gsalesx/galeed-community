/** INVARIANTE: normalização de valor para COMPARAÇÃO (lib/normalize.ts).
 *  Por que importa: a supersessão bitemporal compara `normalizeValue(a) === normalizeValue(b)`.
 *  Se "R$ 499" e "499" normalizam diferente, o cérebro mantém DUAS crenças concorrentes espúrias
 *  pro mesmo fato. Este arquivo trava as equivalências que JÁ funcionam e DOCUMENTA os buracos
 *  conhecidos (it.fails) pra ninguém shipar uma regressão silenciosa sem ver. */
import { describe, it, expect } from "vitest";
import { normalizeValue } from "../../src/lib/normalize.ts";

describe("normalizeValue — moeda e formato viram a mesma chave", () => {
  it("remove símbolo de moeda e zeros decimais", () => {
    expect(normalizeValue("R$ 499")).toBe("499");
    expect(normalizeValue("499")).toBe("499");
    expect(normalizeValue("R$499,00")).toBe("499");
    expect(normalizeValue("  R$  499  ")).toBe("499");
  });

  it("decimal pt-BR (vírgula) e en (ponto) convergem", () => {
    expect(normalizeValue("2.500,00")).toBe("2500"); // pt-BR: ponto=milhar, vírgula=decimal
    expect(normalizeValue("2,500.00")).toBe("2500"); // en: vírgula=milhar, ponto=decimal
  });

  it("texto livre vira chave estável (lower, sem pontuação final)", () => {
    expect(normalizeValue("Em Negociação.")).toBe("em negociação");
    expect(normalizeValue("ATIVO")).toBe("ativo");
  });

  it("o MESMO valor em formas diferentes colapsa (anti-supersessão-espúria)", () => {
    expect(normalizeValue("R$ 499")).toBe(normalizeValue("499"));
    expect(normalizeValue("R$499,00")).toBe(normalizeValue("499"));
  });
});

describe("normalizeValue — GAPS CONHECIDOS (it.fails: fica VERDE enquanto o bug existe; VERMELHO quando alguém consertar — aí troque por expect normal)", () => {
  // pt-BR usa ponto como separador de MILHAR ("2.700" = 2700), mas parseFloat lê como decimal (2.7).
  // Efeito: "R$ 2.700" e "2700" NÃO colapsam → supersessão espúria no ticket/tráfego (visto na AVALIACAO).
  it.fails("milhar pt-BR sem decimais deveria colapsar com a forma sem separador", () => {
    expect(normalizeValue("R$ 2.700")).toBe(normalizeValue("2700"));
    expect(normalizeValue("497.000")).toBe(normalizeValue("497000"));
  });

  // número por extenso ("497 mil") não é expandido. Discutível se é escopo do normalize ou da busca,
  // mas hoje quebra a equivalência — documentado aqui pra rastrear.
  it.fails("número por extenso deveria colapsar com o numeral", () => {
    expect(normalizeValue("497 mil")).toBe(normalizeValue("497000"));
  });
});
