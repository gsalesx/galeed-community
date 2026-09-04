/** M24-A · §4.2 — D2 (silêncio) puro. */
import { describe, it, expect } from "vitest";
import { detectSilencio, medianaInferior, medianaMad } from "../../src/core/memory/signals/d2-silencio.ts";
import {
  resolveSignalConfig,
  type SeriesGroup,
  type SignalFact,
  type SignalInputs,
} from "../../src/core/memory/signals/types.ts";

const cfg = resolveSignalConfig();

function mkInputs(grupos: SeriesGroup[], hoje: string, pageDates = new Map<string, string>()): SignalInputs {
  return { grupos, pageDates, saliences: new Map(), hoje };
}

function fact(p: Partial<SignalFact> & { valid_from: string }): SignalFact {
  return {
    entity: "cliente-norte", predicate: "pedido", tier: "", value: "", value_num: null, valid_to: "",
    confidence: 0.6, status: "fato", source_slug: "chat-m24a-signals-1", meta: {},
    ...p,
  };
}

function entGrupo(entity: string, datas: string[], source = "chat-m24a-signals-1"): SeriesGroup {
  return {
    entity, predicate: "pedido", tier: "",
    facts: datas.map((d, i) => fact({ entity, valid_from: d, value: `pedido-${i + 1}`, source_slug: source })),
  };
}

const CLIENTE_NORTE = ["2024-06-05", "2024-07-05", "2024-08-04", "2024-09-03", "2024-10-03", "2024-11-02", "2024-12-02"];

describe("D2 — silêncio", () => {
  it("1. flag canônica", () => {
    const sig = detectSilencio(mkInputs([entGrupo("cliente-norte", CLIENTE_NORTE)], "2025-03-01"), cfg);
    expect(sig).toHaveLength(1);
    const s = sig[0];
    expect(s.numeros.eventos).toBe(7);
    expect(s.numeros.mediana).toBe(30);
    expect(s.numeros.mad).toBe(0);
    expect(s.numeros.gapAtual).toBe(89);
    expect(s.numeros.limiar).toBe(60);
    expect(s.numeros.ratio).toBeCloseTo(2.9667, 3);
    expect(s.efeito).toBeCloseTo(0.6556, 3);
    expect(s.severidade).toBe("media");
    expect(s.janela).toEqual({ de: "2024-12-02", ate: "2025-03-01" });
    expect(s.resumo).toBe("cliente-norte: 89 dias sem evento novo (intervalo típico ~30 dias; 3.0× o normal)");
  });

  it("2. anti-FP histórico curto (4 < minEventos)", () => {
    expect(detectSilencio(mkInputs([entGrupo("x", CLIENTE_NORTE.slice(0, 4))], "2025-03-01"), cfg)).toEqual([]);
  });

  it("3. anti-FP cadência regular (MAD=0, gap entre mediana+k·0 e piso)", () => {
    // 7 eventos passo 30d; último 2025-01-01; hoje 38 dias depois → gap 38 ≤ piso 60.
    const datas: string[] = [];
    let day = Date.UTC(2024, 6, 1);
    for (let i = 0; i < 7; i++) { datas.push(new Date(day).toISOString().slice(0, 10)); day += 30 * 86400000; }
    const ultimo = new Date(day - 30 * 86400000).toISOString().slice(0, 10);
    const hoje = new Date(Date.parse(ultimo + "T00:00:00Z") + 38 * 86400000).toISOString().slice(0, 10);
    expect(detectSilencio(mkInputs([entGrupo("x", datas)], hoje), cfg)).toEqual([]);
  });

  it("4. MAD > 0", () => {
    // gaps [10,40,20,50,30,60] → mediana 30, mad 10. 7 eventos.
    const gaps = [10, 40, 20, 50, 30, 60];
    const datas: string[] = ["2024-01-01"];
    let day = Date.parse("2024-01-01T00:00:00Z");
    for (const g of gaps) { day += g * 86400000; datas.push(new Date(day).toISOString().slice(0, 10)); }
    const m = medianaMad(gaps);
    expect(m.mediana).toBe(30);
    expect(m.mad).toBe(10);
    // gapAtual = 75 > max(30+30, 60) = 60 → flag.
    const ultimo = datas[datas.length - 1];
    const hoje = new Date(Date.parse(ultimo + "T00:00:00Z") + 75 * 86400000).toISOString().slice(0, 10);
    const sig = detectSilencio(mkInputs([entGrupo("x", datas)], hoje), cfg);
    expect(sig).toHaveLength(1);
    expect(sig[0].numeros.gapAtual).toBe(75);
  });

  it("5. páginas datadas contam como evento", () => {
    // 4 fatos datados + página-fonte datada numa 5ª data distinta.
    const datas = ["2024-01-01", "2024-02-01", "2024-03-01", "2024-04-01"];
    const g = entGrupo("x", datas, "pag-extra-m24a-signals");
    const pageDates = new Map<string, string>([["pag-extra-m24a-signals", "2024-06-01"]]);
    const sig = detectSilencio(mkInputs([g], "2025-03-01", pageDates), cfg);
    expect(sig).toHaveLength(1);
    expect(sig[0].numeros.eventos).toBe(5);
  });

  it("6. gap dentro do normal", () => {
    const hoje = new Date(Date.parse("2024-12-02T00:00:00Z") + 10 * 86400000).toISOString().slice(0, 10);
    expect(detectSilencio(mkInputs([entGrupo("cliente-norte", CLIENTE_NORTE)], hoje), cfg)).toEqual([]);
  });

  it("7. determinismo", () => {
    const inp = mkInputs([entGrupo("cliente-norte", CLIENTE_NORTE)], "2025-03-01");
    expect(detectSilencio(inp, cfg)).toEqual(detectSilencio(inp, cfg));
  });

  it("medianaInferior", () => {
    expect(medianaInferior([3, 1, 2])).toBe(2);
    expect(medianaInferior([4, 1, 2, 3])).toBe(2); // floor((4-1)/2)=1 → sorted[1]=2
  });
});
