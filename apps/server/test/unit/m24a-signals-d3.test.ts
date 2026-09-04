/** M24-A · §4.3 — D3 (compromisso vencido) puro. */
import { describe, it, expect } from "vitest";
import { detectCompromissoVencido } from "../../src/core/memory/signals/d3-compromisso.ts";
import {
  resolveSignalConfig,
  type SeriesGroup,
  type SignalFact,
  type SignalInputs,
} from "../../src/core/memory/signals/types.ts";

const cfg = resolveSignalConfig();

function mkInputs(grupos: SeriesGroup[], hoje = "2025-03-01"): SignalInputs {
  return { grupos, pageDates: new Map(), saliences: new Map(), hoje };
}

function compromisso(p: Partial<SignalFact> = {}): SeriesGroup {
  const f: SignalFact = {
    entity: "kelvin", predicate: "compromisso", tier: "",
    value: "enviar a proposta do ERP", value_num: null,
    valid_from: "2024-12-10", valid_to: "", confidence: 0.6, status: "fato",
    source_slug: "chat-m24a-signals-1", meta: { prazo: "2025-01-15", com_quem: "time" },
    ...p,
  };
  return { entity: f.entity, predicate: f.predicate, tier: f.tier, facts: [f] };
}

describe("D3 — compromisso vencido", () => {
  it("1. vencido (gate §6.3)", () => {
    const sig = detectCompromissoVencido(mkInputs([compromisso()]), cfg);
    expect(sig).toHaveLength(1);
    const s = sig[0];
    expect(s.classe).toBe("compromisso_vencido");
    expect(s.numeros.diasVencidos).toBe(45);
    expect(s.efeito).toBe(1);
    expect(s.severidade).toBe("alta");
    expect(s.janela).toEqual({ de: "2024-12-10", ate: "2025-01-15" });
    expect(s.baseFacts).toHaveLength(1);
    expect(s.resumo).toBe('kelvin: compromisso "enviar a proposta do ERP" combinado em 2024-12-10, prazo 2025-01-15 vencido há 45 dias, sem registro de conclusão');
  });

  it("2. prazo futuro → nada", () => {
    expect(detectCompromissoVencido(mkInputs([compromisso({ meta: { prazo: "2025-12-31" } })]), cfg)).toEqual([]);
  });

  it("3. sem prazo em meta → nada", () => {
    expect(detectCompromissoVencido(mkInputs([compromisso({ meta: {} })]), cfg)).toEqual([]);
    expect(detectCompromissoVencido(mkInputs([compromisso({ meta: { prazo: "sexta-feira" } })]), cfg)).toEqual([]);
  });

  it("4. concluído → nada", () => {
    expect(detectCompromissoVencido(mkInputs([compromisso({ meta: { prazo: "2025-01-15", concluido: true } })]), cfg)).toEqual([]);
  });

  it("5. superseded → nada", () => {
    expect(detectCompromissoVencido(mkInputs([compromisso({ valid_to: "2025-02-01" })]), cfg)).toEqual([]);
  });

  it("6. status != fato → nada", () => {
    expect(detectCompromissoVencido(mkInputs([compromisso({ status: "registrado" })]), cfg)).toEqual([]);
  });

  it("7. predicado é config", () => {
    const c = resolveSignalConfig({ d3: { predicado: "promessa" } });
    const sig = detectCompromissoVencido(mkInputs([compromisso({ predicate: "promessa" })]), c);
    expect(sig).toHaveLength(1);
    expect(sig[0].classe).toBe("compromisso_vencido");
  });

  it("8. determinismo", () => {
    const inp = mkInputs([compromisso()]);
    expect(detectCompromissoVencido(inp, cfg)).toEqual(detectCompromissoVencido(inp, cfg));
  });
});
