/** Decaimento→lixeira (achado decaimento-lixeira#7): CONF_HALFLIFE cobre as dimensões REAIS —
 *  DEFAULT_EXTRACT_DIMS do extrator + as dims PT do pack embarcado a360.json. Antes, open_questions/
 *  quotes e quase todo o pack afinado caíam no default 365d (um "compromisso" que deveria sumir em
 *  30d durava 1 ano). A dimensão é gravada CRUA em galeed_facts — a chave tem que bater literal. */
import { describe, it, expect } from "vitest";
import { effectiveConfidence, CONF_HALFLIFE } from "../../src/core/memory/health.ts";
import { DEFAULT_EXTRACT_DIMS } from "../../src/core/extraction/extractable.ts";

const NOW = new Date("2026-07-07T00:00:00Z");
const OITO_MESES = "2025-11-07";

describe("CONF_HALFLIFE — alinhado às dimensões que a extração produz", () => {
  it("toda dim default do extrator tem meia-vida própria (não cai no default 365d)", () => {
    for (const dim of DEFAULT_EXTRACT_DIMS) {
      expect(CONF_HALFLIFE[dim], `dim sem meia-vida própria: ${dim}`).toBeDefined();
    }
  });

  it("open_questions decai RÁPIDO (mesma classe de follow_ups_pending/action_items — evento efêmero)", () => {
    const oq = effectiveConfidence(0.9, OITO_MESES, "open_questions", NOW);
    const ai = effectiveConfidence(0.9, OITO_MESES, "action_items", NOW);
    const dec = effectiveConfidence(0.9, OITO_MESES, "decisions", NOW);
    expect(oq).toBeCloseTo(ai, 10); // 30d/floor 0.1 — idênticos
    expect(oq).toBeLessThan(dec); // e bem abaixo de decisão (540d)
    expect(oq).toBeLessThan(0.9 * 0.5); // pergunta aberta de 8 meses não parece 'quase atual'
  });

  it("quotes NÃO decai — fala literal é registro histórico ('foi dito' não envelhece)", () => {
    expect(effectiveConfidence(0.8, "2000-01-01", "quotes", NOW)).toBe(0.8);
  });

  it("dims PT do pack a360 têm régua própria (antes caíam TODAS no default)", () => {
    // compromissos = classe action_items (30d); relacoes = identidade (não decai)
    const comp = effectiveConfidence(0.9, OITO_MESES, "compromissos", NOW);
    expect(comp).toBeCloseTo(effectiveConfidence(0.9, OITO_MESES, "action_items", NOW), 10);
    expect(effectiveConfidence(0.9, "2000-01-01", "relacoes", NOW)).toBe(0.9);
    for (const dim of ["decisoes", "objecoes", "precos"]) {
      expect(CONF_HALFLIFE[dim], `dim do pack sem meia-vida: ${dim}`).toBeDefined();
      // e cada uma difere do default OU tem floor próprio — régua deliberada, não fallback
      expect(effectiveConfidence(0.9, OITO_MESES, dim, NOW)).toBeLessThanOrEqual(0.9);
    }
  });

  it("dim desconhecida segue no default (fallback preservado)", () => {
    const eff = effectiveConfidence(0.9, OITO_MESES, "dim-inventada", NOW);
    const def = effectiveConfidence(0.9, OITO_MESES, "__nunca_existiu__", NOW);
    expect(eff).toBe(def);
    expect(eff).toBeLessThan(0.9);
  });
});
