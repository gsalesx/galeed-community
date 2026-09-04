/** M23-A (§4.1) — detector DETERMINÍSTICO puro (zero DB, zero LLM). detectComposite +
 *  independentEntities. Pronomes interrogativos PT = vocabulário do IDIOMA (ADR-002), não negócio. */
import { describe, it, expect } from "vitest";
import { detectComposite, independentEntities } from "../../src/core/retrieval/ground.ts";

describe("detectComposite (§2.1)", () => {
  it("1. D1 — 'quando' subordinado dispara composta", () => {
    expect(detectComposite("quanto custava a accelera quando o teobaldo entrou?")).toBe("composta");
  });
  it("2. D2 — ≥2 pronomes interrogativos dispara composta", () => {
    expect(detectComposite("qual o preço da accelera e quem fechou o pocket?")).toBe("composta");
  });
  it("3. D3 — ≥2 meses nomeados dispara composta (e variante só-D3)", () => {
    expect(detectComposite("de janeiro a março de 2024, o que mudou no preço?")).toBe("composta");
    expect(detectComposite("o preço mudou de janeiro a março de 2024, certo?")).toBe("composta");
  });
  it("4. D3 — faixa de anos com preposição dispara composta", () => {
    expect(detectComposite("o preço mudou entre 2023 e 2024, certo?")).toBe("composta");
  });
  it("5. 'quando' INICIAL não dispara D1 → simples", () => {
    expect(detectComposite("Quando o teobaldo entrou?")).toBe("simples");
  });
  it("6. pergunta simples nomeada → simples", () => {
    expect(detectComposite("qual o preço da accelera?")).toBe("simples");
  });
  it("7. 1 interrogativo + 1 mês (temporal explícito é P1-B) → simples", () => {
    expect(detectComposite("quanto custava em março de 2024?")).toBe("simples");
  });
  it("8. descrição (S2, não S1) — 'o que' não casa dentro de 'aluno que' → simples", () => {
    expect(detectComposite("quem é o aluno que fechou o pocket?")).toBe("simples");
  });
  it("9. determinismo — cada caso 2× → mesmo resultado", () => {
    const casos = [
      "quanto custava a accelera quando o teobaldo entrou?",
      "qual o preço da accelera e quem fechou o pocket?",
      "o preço mudou de janeiro a março de 2024, certo?",
      "o preço mudou entre 2023 e 2024, certo?",
      "Quando o teobaldo entrou?",
      "qual o preço da accelera?",
      "quanto custava em março de 2024?",
      "quem é o aluno que fechou o pocket?",
    ];
    for (const c of casos) expect(detectComposite(c)).toBe(detectComposite(c));
  });
});

describe("independentEntities (§2.1)", () => {
  it("10. subset absorvido — accelera ⊂ accelera 360", () => {
    expect(independentEntities(["accelera", "accelera 360"])).toEqual(["accelera 360"]);
  });
  it("11. entidades independentes — ambas sobrevivem", () => {
    expect(independentEntities(["accelera", "teobaldo"])).toEqual(["accelera", "teobaldo"]);
  });
  it("12. casos triviais", () => {
    expect(independentEntities(["accelera"])).toEqual(["accelera"]);
    expect(independentEntities([])).toEqual([]);
  });
});
