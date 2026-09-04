/** Achado criacao-de-fatos #8 — o exemplo de COMPROMISSO do prompt de extração aponta para
 *  'action_items', mas o schema DEFAULT não tinha essa dimensão: claim emitido fora de ctx.dims era
 *  descartado SEM log em install limpo (pack vazio), e duas superfícies já construídas ficavam
 *  mortas pra sempre — a seção 'compromissos' do espelho GitHub (github-sync.ts filtra
 *  dimension==='action_items') e a curva de decay de action_items (health.ts). Compromisso é
 *  universal de negócio, não domínio → entra no default. Sem DB. */
import { describe, it, expect } from "vitest";
import { DEFAULT_EXTRACT_DIMS } from "../../src/core/extraction/extractable.ts";

describe("DEFAULT_EXTRACT_DIMS — action_items é dimensão default (compromisso é universal)", () => {
  it("contém 'action_items' (o exemplo do prompt e o downstream deixam de apontar pro vazio)", () => {
    expect(DEFAULT_EXTRACT_DIMS).toContain("action_items");
  });

  it("as 5 dims originais continuam presentes (mudança ADITIVA — nada foi removido)", () => {
    for (const d of ["facts", "decisions", "entities", "open_questions", "quotes"]) {
      expect(DEFAULT_EXTRACT_DIMS).toContain(d);
    }
    expect(DEFAULT_EXTRACT_DIMS).toHaveLength(6);
  });
});
