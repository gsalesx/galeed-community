/** P0 (#4) — política de senha AUTORITATIVA no servidor (não confia no front, que só checa min 8).
 *  validatePasswordStrength é o choke point real (createAccount + pré-check do signup). Trava aqui o
 *  comportamento: rejeita curtas, tudo-repetido e só-dígitos curtas; aceita senha forte. */
import { describe, it, expect } from "vitest";
import { validatePasswordStrength } from "../../src/core/access/accounts.ts";

describe("validatePasswordStrength — defesa de senha no servidor", () => {
  it("rejeita senha curta demais", () => {
    expect(() => validatePasswordStrength("1")).toThrow(/senha fraca/);
    expect(() => validatePasswordStrength("1234567")).toThrow(/senha fraca/); // 7 chars < 8
  });

  it("rejeita senha de caracteres repetidos ('aaaaaaaa')", () => {
    expect(() => validatePasswordStrength("aaaaaaaa")).toThrow(/senha fraca/);
  });

  it("rejeita senha só de dígitos curta (< 12)", () => {
    expect(() => validatePasswordStrength("12345678")).toThrow(/senha fraca/);
  });

  it("aceita senha forte", () => {
    expect(() => validatePasswordStrength("Galeed!2026seguro")).not.toThrow();
    expect(() => validatePasswordStrength("correct horse battery staple")).not.toThrow();
  });
});
