/** M15/S1 — GATE MULTI-FONTE (a obrigação #1 do BRIEF §7 / DESIGN-SPEC §6). A PROVA da genericidade:
 *  fixtures rotuladas de ≥5 fontes (call/PDF/csv/email/chat) com fatos de alto valor marcados à mão
 *  (oráculo determinístico, SEM LLM). Assere que a triagem DETERMINÍSTICA, usando SÓ o
 *  DEFAULT_TRIAGE_PROFILE (genérico, sem nenhum override por formato):
 *    1) recupera ≥95% dos fatos highValue POR TIPO (recall por tipo — não só na média);
 *    2) corta ≥50% das chamadas no AGREGADO.
 *
 *  É barato e reprodutível (input rotulado determinístico, invariante #9) — não roda LLM. O recall por
 *  tipo é o que prova que o porteiro NÃO superajustou à chat: corta o ruído de chat E preserva o fato
 *  denso de call/PDF/csv/email com o MESMO algoritmo. */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { scoreSegment, DEFAULT_TRIAGE_PROFILE, type TriageInput } from "../../src/core/ingestion/triage.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "helpers", "triage-fixtures");

interface Fixture {
  text: string;
  channel: string;
  type: string;
  highValue: boolean;
  entityHints?: string[];
}

const TYPES = ["call", "PDF", "csv", "email", "chat"] as const;

function loadFixture(tipo: string): Fixture[] {
  const raw = readFileSync(join(FIXTURES, `${tipo}.jsonl`), "utf8");
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Fixture);
}

function verdictOf(s: Fixture) {
  const input: TriageInput = {
    text: s.text,
    entityHints: s.entityHints ?? [],
    channel: s.channel,
    type: s.type,
    confident: true,
  };
  // O gate prova o DEFAULT GENÉRICO (sem override) — a invariante III: um motor, zero ramo por formato.
  return scoreSegment(input, DEFAULT_TRIAGE_PROFILE);
}

describe("M15/S1 — gate multi-fonte (genericidade + recall ≥0.95 por tipo, corte ≥50% agregado)", () => {
  it("cada fonte tem fixtures rotuladas suficientes (≥25 segmentos, mix de highValue)", () => {
    for (const tipo of TYPES) {
      const segs = loadFixture(tipo);
      expect(segs.length, `${tipo}: poucos segmentos`).toBeGreaterThanOrEqual(25);
      const hv = segs.filter((s) => s.highValue).length;
      expect(hv, `${tipo}: sem highValue`).toBeGreaterThan(0);
      expect(hv, `${tipo}: sem ruído (todos highValue)`).toBeLessThan(segs.length);
    }
  });

  it("recall de highValue ≥0.95 POR TIPO (a triagem NUNCA derruba fato real, em nenhuma fonte)", () => {
    for (const tipo of TYPES) {
      const segs = loadFixture(tipo);
      const hv = segs.filter((s) => s.highValue);
      const recovered = hv.filter((s) => verdictOf(s).worthy).length;
      const recall = recovered / hv.length;
      // diagnóstico explícito de qual highValue caiu (facilita ajuste de pesos do DEFAULT).
      if (recall < 0.95) {
        const dropped = hv.filter((s) => !verdictOf(s).worthy).map((s) => s.text);
        throw new Error(`recall ${tipo}=${recall.toFixed(3)} < 0.95; highValue cortados: ${JSON.stringify(dropped)}`);
      }
      expect(recall, `${tipo}`).toBeGreaterThanOrEqual(0.95);
    }
  });

  it("corte AGREGADO ≥50% (o porteiro poupa ≥metade das chamadas LLM)", () => {
    const all: Fixture[] = TYPES.flatMap((t) => loadFixture(t));
    const cut = all.filter((s) => !verdictOf(s).worthy).length;
    const ratio = cut / all.length;
    expect(ratio, `corte agregado=${ratio.toFixed(3)}`).toBeGreaterThanOrEqual(0.5);
  });

  it("não corta NENHUM segmento com number OU entity (salvaguarda do golden M9)", () => {
    const all: Fixture[] = TYPES.flatMap((t) => loadFixture(t));
    for (const s of all) {
      const v = verdictOf(s);
      const strong = v.signals.includes("number") || v.signals.includes("entity");
      if (strong) expect(v.worthy, `cortou um segmento forte: ${s.text}`).toBe(true);
    }
  });

  it("scoreSegment é PURA/determinística (mesmo input → mesmo verdict)", () => {
    const all: Fixture[] = TYPES.flatMap((t) => loadFixture(t));
    for (const s of all) {
      const a = JSON.stringify(verdictOf(s));
      const b = JSON.stringify(verdictOf(s));
      expect(a).toBe(b);
    }
  });
});
