/** M24-A · §4.1 — D1 (tendência/ruptura) puro. SignalInputs montado em memória. */
import { describe, it, expect } from "vitest";
import { detectTendencia } from "../../src/core/memory/signals/d1-tendencia.ts";
import {
  resolveSignalConfig,
  type SeriesGroup,
  type SignalFact,
  type SignalInputs,
} from "../../src/core/memory/signals/types.ts";

const cfg = resolveSignalConfig();

function mkInputs(grupos: SeriesGroup[]): SignalInputs {
  return { grupos, pageDates: new Map(), saliences: new Map(), hoje: "2025-03-01" };
}

function fact(p: Partial<SignalFact> & { valid_from: string; value_num: number | null }): SignalFact {
  return {
    entity: "accelera", predicate: "preco", tier: "", value: "", valid_to: "",
    confidence: 0.7, status: "fato", source_slug: "chat-m24a-signals-1", meta: {},
    ...p,
  };
}

function grupo(entity: string, predicate: string, tier: string, pts: Array<[string, number | null, number?]>): SeriesGroup {
  return {
    entity, predicate, tier,
    facts: pts.map(([vf, vn, conf]) => fact({ entity, predicate, tier, valid_from: vf, value_num: vn, confidence: conf ?? 0.7 })),
  };
}

// canônica: 3k→5k→12k→18k→30k
const CANON: Array<[string, number, number]> = [
  ["2023-08-10", 3000, 0.7],
  ["2024-01-15", 5000, 0.7],
  ["2024-03-20", 12000, 0.7],
  ["2024-06-05", 18000, 0.7],
  ["2025-01-10", 30000, 0.6],
];

describe("D1 — tendência e ruptura", () => {
  it("1. caso canônico (gate §6.1)", () => {
    const sig = detectTendencia(mkInputs([grupo("accelera", "preco", "", CANON)]), cfg);
    expect(sig).toHaveLength(1);
    const s = sig[0];
    expect(s.classe).toBe("tendencia");
    expect(s.numeros.slopePorDia).toBeCloseTo(55.5685, 3);
    expect(s.numeros.pctTotal).toBeCloseTo(900, 6);
    expect(s.numeros.pctAnualizada).toBeCloseTo(632.948, 2);
    expect(s.numeros.spanDias).toBe(519);
    expect(s.numeros.pontos).toBe(5);
    expect(s.numeros.cusumIdx).toBe(-1);
    expect(s.efeito).toBe(1);
    expect(s.severidade).toBe("alta");
    expect(s.entities).toEqual(["accelera"]);
    expect(s.janela).toEqual({ de: "2023-08-10", ate: "2025-01-10" });
    expect(s.baseFacts).toHaveLength(5);
    expect(s.baseFacts[0]).toEqual({
      entity: "accelera", predicate: "preco", tier: "", valid_from: "2023-08-10", source_slug: "chat-m24a-signals-1",
    });
    expect(s.minConfidence).toBe(0.6);
    expect(s.resumo).toBe("preco de accelera: 3000 → 30000 (+900.0% em 519 dias; slope 55.57/dia)");
  });

  it("2. ruptura — CUSUM trip", () => {
    const vals = [100, 102, 98, 101, 99, 100, 200, 205, 210];
    const pts: Array<[string, number]> = vals.map((v, i) => {
      const d = new Date(Date.UTC(2026, 0, 1) + i * 30 * 86400000);
      return [d.toISOString().slice(0, 10), v];
    });
    const sig = detectTendencia(mkInputs([grupo("x", "v", "", pts)]), cfg);
    expect(sig).toHaveLength(1);
    const s = sig[0];
    expect(s.classe).toBe("ruptura");
    expect(s.numeros.cusumIdx).toBe(5);
    expect(s.efeito).toBe(0.8);
    expect(s.resumo).toContain("; ruptura no ponto 6 de 9 (~");
  });

  it("3. estável = NOOP", () => {
    const vals = [100, 101, 99, 100, 102, 98, 100];
    const pts: Array<[string, number]> = vals.map((v, i) => {
      const d = new Date(Date.UTC(2026, 0, 1) + i * 30 * 86400000);
      return [d.toISOString().slice(0, 10), v];
    });
    expect(detectTendencia(mkInputs([grupo("x", "v", "", pts)]), cfg)).toEqual([]);
  });

  it("4. guards", () => {
    // (a) 2 pontos
    expect(detectTendencia(mkInputs([grupo("x", "v", "", [["2024-01-01", 100], ["2024-06-01", 200]])]), cfg)).toEqual([]);
    // (b) 5 pontos com TODAS as datas iguais → dedupe → 1 ponto
    const same: Array<[string, number]> = [3500, 4333, 4997, 5333, 5500].map((v) => ["2026-06-04", v]);
    expect(detectTendencia(mkInputs([grupo("x", "v", "", same)]), cfg)).toEqual([]);
    // (c) span 10 dias < minSpanDias
    const short: Array<[string, number]> = [
      ["2024-01-01", 100], ["2024-01-05", 200], ["2024-01-10", 400],
    ];
    expect(detectTendencia(mkInputs([grupo("x", "v", "", short)]), cfg)).toEqual([]);
    // (d) first === 0
    const zero: Array<[string, number]> = [
      ["2024-01-01", 0], ["2024-03-01", 100], ["2024-06-01", 200],
    ];
    expect(detectTendencia(mkInputs([grupo("x", "v", "", zero)]), cfg)).toEqual([]);
  });

  it("5. dedupe por data — fica o último", () => {
    const g: SeriesGroup = {
      entity: "x", predicate: "v", tier: "",
      facts: [
        fact({ entity: "x", predicate: "v", valid_from: "2024-01-01", value_num: 100 }),
        fact({ entity: "x", predicate: "v", valid_from: "2024-04-01", value_num: 4997 }),
        fact({ entity: "x", predicate: "v", valid_from: "2024-04-01", value_num: 5333 }),
        fact({ entity: "x", predicate: "v", valid_from: "2024-08-01", value_num: 9000 }),
      ],
    };
    const sig = detectTendencia(mkInputs([g]), cfg);
    expect(sig).toHaveLength(1);
    expect(sig[0].numeros.pontos).toBe(3);
    // último ponto = 9000, primeiro = 100 → +8900.0%
    expect(sig[0].resumo).toContain("100 → 9000");
  });

  it("6. value_num null ignorado", () => {
    const g: SeriesGroup = {
      entity: "x", predicate: "v", tier: "",
      facts: [
        fact({ entity: "x", predicate: "v", valid_from: "2024-01-01", value_num: 100 }),
        fact({ entity: "x", predicate: "v", valid_from: "2024-02-01", value_num: null }),
        fact({ entity: "x", predicate: "v", valid_from: "2024-04-01", value_num: 200 }),
        fact({ entity: "x", predicate: "v", valid_from: "2024-05-01", value_num: null }),
        fact({ entity: "x", predicate: "v", valid_from: "2024-08-01", value_num: 400 }),
      ],
    };
    const sig = detectTendencia(mkInputs([g]), cfg);
    expect(sig).toHaveLength(1);
    expect(sig[0].numeros.pontos).toBe(3);
  });

  it("7. config (invariante III)", () => {
    const c = resolveSignalConfig({ d1: { minPctTotal: 1000 } });
    expect(detectTendencia(mkInputs([grupo("accelera", "preco", "", CANON)]), c)).toEqual([]);
  });

  it("8. determinismo", () => {
    const inp = mkInputs([grupo("accelera", "preco", "", CANON)]);
    expect(detectTendencia(inp, cfg)).toEqual(detectTendencia(inp, cfg));
  });
});
