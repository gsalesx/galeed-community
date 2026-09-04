/** M23-B/§5.A — predicado entityIsVague (puro, sem DB). Trava a LEI II e a decisão
 *  de "contrato" FORA da lista (canários P1-C). */
import { describe, it, expect } from "vitest";
import { entityIsVague } from "../../src/lib/vague-entity.ts";

describe("entityIsVague (M23-B auto-contenção)", () => {
  it("1. pronomes exatos → true", () => {
    for (const e of ["ele", "ela", "eles", "isso", "a gente", "você", "voce"]) {
      expect(entityIsVague(e), e).toBe(true);
    }
  });

  it("2. genéricos com artigo → true", () => {
    for (const e of ["o cliente", "a empresa", "o produto", "uma empresa"]) {
      expect(entityIsVague(e), e).toBe(true);
    }
  });

  it("3. genéricos sem artigo → true", () => {
    for (const e of ["cliente", "empresa"]) {
      expect(entityIsVague(e), e).toBe(true);
    }
  });

  it("4. nome próprio desconhecido → false (vaga ≠ nova)", () => {
    for (const e of ["teobaldo", "nortex"]) {
      expect(entityIsVague(e), e).toBe(false);
    }
  });

  it("5. forma vaga como PARTE de composto → false", () => {
    for (const e of ["ela transportes", "o cliente acme", "empresa brasileira de aeronautica"]) {
      expect(entityIsVague(e), e).toBe(false);
    }
  });

  it("6. normalização case/espaços colapsados → true", () => {
    expect(entityIsVague("  ELA  ")).toBe(true);
    expect(entityIsVague("O   Cliente")).toBe(true);
  });

  it("7. \"\" → false (vazio não é vago — é sem-triple)", () => {
    expect(entityIsVague("")).toBe(false);
  });

  it("8. \"contrato\"/\"o contrato\" → false (FORA da lista — canários P1-C)", () => {
    expect(entityIsVague("contrato")).toBe(false);
    expect(entityIsVague("o contrato")).toBe(false);
  });
});
