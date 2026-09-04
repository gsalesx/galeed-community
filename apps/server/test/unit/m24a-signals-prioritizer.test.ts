/** M24-A · §4.4 — priorizador puro. */
import { describe, it, expect } from "vitest";
import { prioritizeSignals, recencia, salienceDe } from "../../src/core/memory/signals/prioritizer.ts";
import { salienceScore } from "../../src/core/memory/health.ts";
import {
  resolveSignalConfig,
  type EntitySalienceInfo,
  type Signal,
  type SignalInputs,
} from "../../src/core/memory/signals/types.ts";

const cfg = resolveSignalConfig();
const HOJE = "2025-03-01";

function mkInputs(saliences = new Map<string, EntitySalienceInfo>()): SignalInputs {
  return { grupos: [], pageDates: new Map(), saliences, hoje: HOJE };
}

function sig(p: Partial<Signal> & { resumo: string }): Signal {
  return {
    detector: "d1_tendencia", classe: "tendencia", efeito: 1, severidade: "alta",
    entities: ["accelera"], baseFacts: [], minConfidence: 0.6, numeros: {},
    janela: { de: "2024-01-01", ate: HOJE },
    ...p,
  };
}

describe("priorizador", () => {
  it("1. fórmula (reuso de salienceScore)", () => {
    const ate = HOJE;
    const firstSeen = "2025-01-30"; // hoje−30d
    const info: EntitySalienceInfo = { factCount: 8, degree: 6, role: "org", firstSeen };
    const inp = mkInputs(new Map([["accelera", info]]));
    const r = prioritizeSignals([sig({ resumo: "s1", efeito: 1, minConfidence: 0.6, janela: { de: "2024-01-01", ate } })], inp, cfg);
    const sal = salienceScore({ factCount: 8, degree: 6, type: "org", date: firstSeen });
    expect(r[0].score).toBeCloseTo(1 * 1 * sal * 0.6, 10);
  });

  it("2. recência", () => {
    expect(recencia(HOJE, HOJE, 90)).toBe(1);
    const d90 = new Date(Date.parse(HOJE + "T00:00:00Z") - 90 * 86400000).toISOString().slice(0, 10);
    expect(recencia(d90, HOJE, 90)).toBe(0.5);
    const fut = new Date(Date.parse(HOJE + "T00:00:00Z") + 10 * 86400000).toISOString().slice(0, 10);
    expect(recencia(fut, HOJE, 90)).toBe(1);
  });

  it("3. fallback de salience", () => {
    expect(salienceDe(["fora-do-mapa"], new Map(), cfg)).toBe(0.3);
  });

  it("4. NOOP (LEI VI)", () => {
    expect(prioritizeSignals([], mkInputs(), cfg)).toEqual([]);
  });

  it("5. top-K", () => {
    const c = resolveSignalConfig({ k: 2 });
    const sals = new Map<string, EntitySalienceInfo>([["accelera", { factCount: 8, degree: 6, role: "org", firstSeen: HOJE }]]);
    const sigs = [
      sig({ resumo: "a", efeito: 0.9 }),
      sig({ resumo: "b", efeito: 0.5 }),
      sig({ resumo: "c", efeito: 0.2 }),
    ];
    const r = prioritizeSignals(sigs, mkInputs(sals), c);
    expect(r).toHaveLength(2);
    expect(r[0].rank).toBe(1);
    expect(r[1].rank).toBe(2);
    expect(r[0].score).toBeGreaterThanOrEqual(r[1].score);
  });

  it("6. tie-break total", () => {
    const sals = new Map<string, EntitySalienceInfo>([["accelera", { factCount: 8, degree: 6, role: "org", firstSeen: HOJE }]]);
    // mesmo efeito/conf/janela → score idêntico; difere só detector/resumo.
    const sigs = [
      sig({ resumo: "zzz", detector: "d2_silencio", classe: "silencio" }),
      sig({ resumo: "aaa", detector: "d1_tendencia" }),
    ];
    const r1 = prioritizeSignals(sigs, mkInputs(sals), cfg);
    const r2 = prioritizeSignals(sigs, mkInputs(sals), cfg);
    expect(r1.map((s) => s.detector)).toEqual(["d1_tendencia", "d2_silencio"]);
    expect(r1).toEqual(r2);
  });

  it("7. multi-entidade = MAX", () => {
    const sals = new Map<string, EntitySalienceInfo>([
      ["baixa", { factCount: 1, degree: 0, role: "assunto", firstSeen: "2020-01-01" }],
      ["alta", { factCount: 20, degree: 10, role: "org", firstSeen: HOJE }],
    ]);
    const max = salienceDe(["baixa", "alta"], sals, cfg);
    const soBaixa = salienceDe(["baixa"], sals, cfg);
    const soAlta = salienceDe(["alta"], sals, cfg);
    expect(max).toBe(Math.max(soBaixa, soAlta));
    expect(max).toBe(soAlta);
  });
});
