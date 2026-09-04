/** Invariante: confiança-base de um fato derivado (indexer.baseConfidence).
 *  Política do fundador (2026-06-04): a certeza reflete SUPORTE epistêmico (grounded), NÃO
 *  se o item virou um triple estruturado. Antes, registrado nascia 0 hardcoded → 76% do
 *  cérebro (10.389/13.614 no brain Accelera) ficava 0% e a UI escondia. */
import { describe, it, expect } from "vitest";
import { baseConfidence } from "../../src/core/retrieval/indexer.ts";

describe("baseConfidence — certeza-base por suporte, não por estrutura", () => {
  it("triple ancorado = 0.60 (entra na cadeia de corroboração)", () => {
    expect(baseConfidence(true, true, false)).toBe(0.6);
  });

  it("triple NÃO ancorado (número não-verbatim) = 0.30 (nao-verificado)", () => {
    expect(baseConfidence(true, false, false)).toBe(0.3);
  });

  it("registrado ancorado na fonte = 0.45 (suportado, mas sem triple) — NÃO mais 0", () => {
    expect(baseConfidence(false, false, true)).toBe(0.45);
    expect(baseConfidence(false, false, true)).toBeGreaterThan(0); // a regressão que consertamos
  });

  it("registrado SEM âncora (sem quote/quote não-verbatim) = 0.10 (suspeito)", () => {
    expect(baseConfidence(false, false, false)).toBe(0.1);
  });

  it("hierarquia: fato > registrado-grounded > nao-verificado > suspeito", () => {
    const fato = baseConfidence(true, true, false);
    const grounded = baseConfidence(false, false, true);
    const naoVerif = baseConfidence(true, false, false);
    const suspeito = baseConfidence(false, false, false);
    expect(fato).toBeGreaterThan(grounded);
    expect(grounded).toBeGreaterThan(naoVerif);
    expect(naoVerif).toBeGreaterThan(suspeito);
  });

  it("o triple manda na trilha de ancoragem: anchored só importa COM triple", () => {
    // sem triple, `anchored` é ignorado — quem decide é groundedRegistro
    expect(baseConfidence(false, true, false)).toBe(0.1);
    expect(baseConfidence(false, true, true)).toBe(0.45);
  });
});
