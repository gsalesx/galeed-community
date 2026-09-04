/** INVARIANTE: decay de confiança e salience (health.ts). É decay de LEITURA — projeta a confiança
 *  no tempo SEM alterar o valor armazenado. Propriedades: nunca sobe, respeita piso, identidade
 *  não decai. Função pura com `now` injetável. */
import { describe, it, expect } from "vitest";
import { effectiveConfidence, salienceScore, CONF_HALFLIFE } from "../../src/core/memory/health.ts";

const NOW = new Date("2026-06-02T00:00:00Z");

describe("effectiveConfidence — decay de leitura", () => {
  it("hoje (idade 0) → confiança intacta", () => {
    expect(effectiveConfidence(0.9, "2026-06-02", "decisions", NOW)).toBe(0.9);
  });

  it("identidade (entities) não decai — hl=0", () => {
    expect(effectiveConfidence(0.8, "2000-01-01", "entities", NOW)).toBe(0.8);
  });

  it("nunca SOBE e nunca passa do piso*confidence", () => {
    for (const [dim, cfg] of Object.entries(CONF_HALFLIFE)) {
      const eff = effectiveConfidence(0.9, "2010-01-01", dim, NOW); // bem antigo
      expect(eff).toBeLessThanOrEqual(0.9 + 1e-9);
      expect(eff).toBeGreaterThanOrEqual(cfg.floor * 0.9 - 1e-9);
    }
  });

  it("decisions (hl=540) a uma meia-vida cai pro fator esperado", () => {
    // 2024-12-09 ≈ 540 dias antes de 2026-06-02. factor = 0.4 + 0.6*(540/1080) = 0.7
    expect(effectiveConfidence(1.0, "2024-12-09", "decisions", NOW)).toBeCloseTo(0.7, 1);
  });

  it("action_items decai mais rápido que decisions na mesma idade", () => {
    const ai = effectiveConfidence(1.0, "2026-01-01", "action_items", NOW);
    const dec = effectiveConfidence(1.0, "2026-01-01", "decisions", NOW);
    expect(ai).toBeLessThan(dec);
  });
});

describe("salienceScore — importância em [0,1]", () => {
  it("sempre clampa em [0,1]", () => {
    const hi = salienceScore({ factCount: 9999, degree: 9999, type: "clientes", date: "2026-06-02" }, NOW);
    const lo = salienceScore({ factCount: 0, degree: 0, type: "notas", date: "2000-01-01" }, NOW);
    expect(hi).toBeLessThanOrEqual(1);
    expect(lo).toBeGreaterThanOrEqual(0);
  });

  it("mais fatos e mais conexões → mais saliente", () => {
    const rico = salienceScore({ factCount: 20, degree: 10, type: "notas", date: "2026-06-02" }, NOW);
    const pobre = salienceScore({ factCount: 1, degree: 1, type: "notas", date: "2026-06-02" }, NOW);
    expect(rico).toBeGreaterThan(pobre);
  });

  it("tipo âncora (clientes/pessoas/conceitos) ganha boost vs tipo comum, tudo igual", () => {
    const base = { factCount: 5, degree: 3, date: "2026-06-02" };
    const ancora = salienceScore({ ...base, type: "clientes" }, NOW);
    const comum = salienceScore({ ...base, type: "notas" }, NOW);
    expect(ancora).toBeGreaterThan(comum);
  });
});
