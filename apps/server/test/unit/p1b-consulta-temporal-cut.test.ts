/** P1-B (mata A3) — gramática do RECORTE TEMPORAL EXPLÍCITO (src/lib/temporal-cut.ts), §4.1 da
 *  DESIGN-SPEC. Puro, sem DB, sem LLM: prova que a extração do ponto asOf é 100% determinística e
 *  fail-closed nos casos de suposição (mês sem ano, faixa, ano sem preposição) — esses são M23. */
import { describe, it, expect } from "vitest";
import { temporalCutPt } from "../../src/lib/temporal-cut.ts";

describe("temporalCutPt — gramática fechada do recorte (P1-B)", () => {
  it("1. <mês> de <aaaa> → mês (asOf = último dia)", () => {
    const c = temporalCutPt("quanto custava em março de 2024?");
    expect(c).toEqual({ asOf: "2024-03-31", label: "2024-03", matched: expect.stringContaining("marco de 2024") });
  });

  it("2. mês/aa e mm/aaaa → mesmo label 2024-03", () => {
    expect(temporalCutPt("e em março/24?")?.label).toBe("2024-03");
    expect(temporalCutPt("mar/2024")?.label).toBe("2024-03");
    expect(temporalCutPt("em 03/2024")?.label).toBe("2024-03");
  });

  it("3. ano com preposição → ano (asOf = 31/12)", () => {
    expect(temporalCutPt("qual era o preço em 2023?")).toMatchObject({ asOf: "2023-12-31", label: "2023" });
    expect(temporalCutPt("durante 2023")?.label).toBe("2023");
    expect(temporalCutPt("no ano de 2023")?.label).toBe("2023");
  });

  it("4. bissexto: fevereiro de 2024 → 29; 2023 → 28", () => {
    expect(temporalCutPt("fevereiro de 2024")?.asOf).toBe("2024-02-29");
    expect(temporalCutPt("fevereiro de 2023")?.asOf).toBe("2023-02-28");
  });

  it("5. fold de acento/caixa: MARÇO == marco", () => {
    const a = temporalCutPt("EM MARÇO DE 2024");
    const b = temporalCutPt("em marco de 2024");
    expect(a).toEqual(b);
    expect(a?.label).toBe("2024-03");
  });

  it("6. fail-closed → null", () => {
    expect(temporalCutPt("quanto custa hoje?")).toBeNull(); // sem recorte
    expect(temporalCutPt("em março?")).toBeNull(); // mês sem ano
    expect(temporalCutPt("o plano 2024 está pronto")).toBeNull(); // ano sem preposição
    expect(temporalCutPt("de janeiro a março de 2024")).toBeNull(); // G1 — 2 meses nomeados
    expect(temporalCutPt("em 2023 e em 2024")).toBeNull(); // G2 — 2 labels
    expect(temporalCutPt("em 13/2024")).toBeNull(); // mês inválido
    expect(temporalCutPt("12/03/2024 foi a reunião")).toBeNull(); // dd/mm/aaaa não é recorte (guarda R3)
  });

  it("7. determinismo: mesma string 2× → toEqual", () => {
    const q = "qual era o preço em março de 2024?";
    expect(temporalCutPt(q)).toEqual(temporalCutPt(q));
  });
});
