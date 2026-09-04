/** INVARIANTE: ancoragem de quote (quote-check.ts) — anti-alucinação R4. Um fato cujo context_quote
 *  não aparece na fonte é suspeito e nasce 'nao-verificado' (não entra na cadeia de supersessão).
 *  Esta é a porta que decide o status; testá-la protege a verdade na entrada. */
import { describe, it, expect } from "vitest";
import { quoteIsGrounded } from "../../src/lib/quote-check.ts";

const BODY =
  "Na reunião de janeiro a Acme fechou o plano em R$ 499 por mês. " +
  "O Ronaldo confirmou o contrato de R$ 497 mil para o ano.";

describe("quoteIsGrounded", () => {
  it("quote vazio não penaliza (ausência ≠ alucinação)", () => {
    expect(quoteIsGrounded("", BODY)).toBe(true);
  });

  it("substring exata (após normalizar espaço) é ancorada", () => {
    expect(quoteIsGrounded("o plano em R$ 499 por mês", BODY)).toBe(true);
    expect(quoteIsGrounded("o   plano   em   R$ 499", BODY)).toBe(true); // espaços colapsam
  });

  it("≥70% dos tokens significativos presentes → ancorada", () => {
    expect(quoteIsGrounded("Acme fechou contrato confirmado Ronaldo", BODY)).toBe(true);
  });

  it("quote inventado (<70% dos tokens na fonte) → NÃO ancorado (alucinação)", () => {
    expect(quoteIsGrounded("a Globo cancelou a parceria internacional europeia", BODY)).toBe(false);
  });
});
