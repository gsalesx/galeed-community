/** INVARIANTE: fator de recência (recency.ts) — multiplicador determinístico do score de retrieve.
 *  "a verdade atual ganha". Função pura de (date, type, now). `now` é injetado pra teste estável. */
import { describe, it, expect } from "vitest";
import { recencyFactor, DECAY_BY_TYPE } from "../../src/core/memory/recency.ts";

const NOW = new Date("2026-06-02T00:00:00Z");

describe("recencyFactor — casos neutros (fator 1.0)", () => {
  it("tipos evergreen não decaem nunca", () => {
    expect(recencyFactor("2000-01-01", "conceitos", NOW)).toBe(1.0);
    expect(recencyFactor("2000-01-01", "produtos", NOW)).toBe(1.0);
    expect(recencyFactor("2000-01-01", "pessoas", NOW)).toBe(1.0);
  });

  it("data ausente/inválida/futura → neutro", () => {
    expect(recencyFactor("", "reunioes", NOW)).toBe(1.0);
    expect(recencyFactor("not-a-date", "reunioes", NOW)).toBe(1.0);
    expect(recencyFactor("2026-06-02", "reunioes", NOW)).toBe(1.0); // hoje
    expect(recencyFactor("2030-01-01", "reunioes", NOW)).toBe(1.0); // futuro
  });
});

describe("recencyFactor — decaimento", () => {
  it("uma meia-vida atrás dá o ponto médio esperado (reunioes: hl=120, coeff=0.5)", () => {
    // 2026-02-02 = 120 dias antes de 2026-06-02. raw=120/240=0.5 → 1 - 0.5*(1-0.5) = 0.75
    expect(recencyFactor("2026-02-02", "reunioes", NOW)).toBeCloseTo(0.75, 2);
  });

  it("é monotônico: mais antigo → fator menor", () => {
    const recente = recencyFactor("2026-05-01", "reunioes", NOW);
    const medio = recencyFactor("2026-01-01", "reunioes", NOW);
    const antigo = recencyFactor("2024-01-01", "reunioes", NOW);
    expect(recente).toBeGreaterThan(medio);
    expect(medio).toBeGreaterThan(antigo);
  });

  it("nunca cai abaixo do piso (1 - coeff) nem passa de 1", () => {
    for (const [type, cfg] of Object.entries(DECAY_BY_TYPE)) {
      const f = recencyFactor("2000-01-01", type, NOW); // muito antigo
      expect(f).toBeLessThanOrEqual(1.0);
      expect(f).toBeGreaterThanOrEqual(1 - cfg.coeff - 1e-9);
    }
  });
});
