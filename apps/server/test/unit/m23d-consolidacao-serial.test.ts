/** M23-D — §6.2.4: serialização por brain do runConsolidationStep REAL, com o miolo instrumentado.
 *  Arquivo separado: aqui mockamos as DEPENDÊNCIAS do consolidate-step (entities/indexer/engine) e
 *  exercitamos o módulo de verdade — diferente do m23d-consolidacao.test.ts, que mocka o próprio
 *  consolidate-step para testar o wiring do worker. */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => {
  const state = { active: 0, maxSameBrain: 0, log: [] as string[] };
  return {
    state,
    resolveEntities: vi.fn(async (brain: string) => {
      state.active++;
      state.log.push(`enter:${brain}`);
      if (brain === "x") state.maxSameBrain = Math.max(state.maxSameBrain, state.active);
      await new Promise((r) => setTimeout(r, 10));
      state.log.push(`exit:${brain}`);
      state.active--;
      return { entities: 0, merges: [], provider: "deterministico" as const };
    }),
    deriveIncremental: vi.fn(async () => ({ groups: 0, facts: 0, edges: 0 })),
    getEngine: vi.fn(async () => ({
      getEntityResolve: vi.fn(async () => ({})),
      allExtractions: vi.fn(async () => []),
    })),
  };
});

vi.mock("../../src/core/memory/entities.ts", () => ({ resolveEntities: h.resolveEntities }));
vi.mock("../../src/core/retrieval/indexer.ts", () => ({ deriveIncremental: h.deriveIncremental }));
vi.mock("../../src/core/platform/engine.ts", () => ({ getEngine: h.getEngine }));

import {
  runConsolidationStep,
  diffEntityMaps,
  slugsAffectedByEntities,
} from "../../src/core/ingestion/consolidate-step.ts";
import type { ExtractionRow } from "../../src/core/platform/engine.ts";

// ---------------------------------------------------------------------------
// §6.2.1 — diffEntityMaps (puro)
// ---------------------------------------------------------------------------
describe("diffEntityMaps (m23d-consolidacao)", () => {
  it("captura adicionado, alterado e removido; ignora inalterado; saída ordenada/única", () => {
    const before = { mantido: "x", alterado: "a", removido: "r" };
    const after = { mantido: "x", alterado: "b", adicionado: "y" };
    expect(diffEntityMaps(before, after)).toEqual(["adicionado", "alterado", "removido"]);
  });
  it("canônico antigo que vira alias do novo entra (before ausente, after presente)", () => {
    expect(diffEntityMaps({}, { old: "new" })).toEqual(["old"]);
  });
  it("{}×{} → []", () => {
    expect(diffEntityMaps({}, {})).toEqual([]);
  });
  it("mapas idênticos → []", () => {
    expect(diffEntityMaps({ a: "c", b: "c" }, { a: "c", b: "c" })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// §6.2.2 — slugsAffectedByEntities (puro)
// ---------------------------------------------------------------------------
describe("slugsAffectedByEntities (m23d-consolidacao)", () => {
  const ex = (slug: string, dim: any): ExtractionRow => ({
    source_slug: slug,
    type: "notas",
    date: "2026-01-01",
    content_hash: "h",
    prompt_version: "v",
    extractions: dim,
  });
  it("casa por lowercase+trim", () => {
    expect(slugsAffectedByEntities([ex("s1", { preco: [{ entity: "  ACELERA  " }] })], new Set(["acelera"]))).toEqual(["s1"]);
  });
  it("dimensão como STRING-JSON é parseada (tolerância do derivePageFacts)", () => {
    expect(slugsAffectedByEntities([ex("s2", { preco: JSON.stringify([{ entity: "acelera" }]) })], new Set(["acelera"]))).toEqual(["s2"]);
  });
  it("STRING não-JSON / não-array é ignorada", () => {
    const rows = [ex("s3", { preco: "nao e json" }), ex("s4", { preco: JSON.stringify({ entity: "acelera" }) })];
    expect(slugsAffectedByEntities(rows, new Set(["acelera"]))).toEqual([]);
  });
  it("item sem entity é ignorado", () => {
    expect(slugsAffectedByEntities([ex("s5", { preco: [{ value: "x" }, { entity: "" }] })], new Set(["acelera"]))).toEqual([]);
  });
  it("slugs deduplicados e ordenados; entidade fora do changed não puxa o slug", () => {
    const rows = [
      ex("zzz", { preco: [{ entity: "acelera" }] }),
      ex("zzz", { outra: [{ entity: "acelera" }] }),
      ex("aaa", { preco: [{ entity: "acelera" }] }),
      ex("bbb", { preco: [{ entity: "outra-coisa" }] }),
    ];
    expect(slugsAffectedByEntities(rows, new Set(["acelera"]))).toEqual(["aaa", "zzz"]);
  });
});

beforeEach(() => {
  h.state.active = 0;
  h.state.maxSameBrain = 0;
  h.state.log = [];
});

describe("serialização por brain (m23d-consolidacao)", () => {
  it("duas chamadas concorrentes no MESMO brain nunca se sobrepõem", async () => {
    await Promise.all([runConsolidationStep("x"), runConsolidationStep("x")]);
    expect(h.state.maxSameBrain).toBe(1); // nunca 2 runs simultâneos no mesmo brain
    expect(h.state.log).toEqual(["enter:x", "exit:x", "enter:x", "exit:x"]);
  });

  it("brains diferentes não deadlockam (podem sobrepor)", async () => {
    await Promise.all([runConsolidationStep("a"), runConsolidationStep("b")]);
    // ambos completam; a ordem entre brains distintos não é serializada por contrato
    expect(h.state.log.filter((l) => l.startsWith("enter")).sort()).toEqual(["enter:a", "enter:b"]);
  });
});
