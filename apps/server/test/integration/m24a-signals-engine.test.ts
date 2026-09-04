/** M24-A · §4.6 — fim-a-fim contra o Postgres real :5434 (invariante #9). */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { detectSignals } from "../../src/core/memory/signals/index.ts";
import { loadSignalInputs } from "../../src/core/memory/signals/load.ts";
import { closeEngines } from "../../src/core/platform/engine.ts";
import { hasDb, rawConnect, wipeBrain } from "./helpers/db.ts";
import { seedM24aSignals } from "./helpers/seed-m24a-signals.ts";

const BRAIN = "itest-m24a-signals";
const VAZIO = "itest-m24a-signals-vazio";
const NOW = new Date("2025-03-01T12:00:00Z");

describe.skipIf(!hasDb())("M24-A signal-engine (DB real)", () => {
  beforeAll(async () => {
    await seedM24aSignals(BRAIN);
  });
  afterAll(async () => {
    await wipeBrain(BRAIN);
    await wipeBrain(VAZIO);
    await closeEngines();
  });

  it("1. fim-a-fim → 3 sinais", async () => {
    const r = await detectSignals(BRAIN, { now: NOW });
    expect(r).toHaveLength(3);
    for (let i = 0; i < r.length; i++) {
      expect(r[i].baseFacts.length).toBeGreaterThanOrEqual(1);
      expect(Object.keys(r[i].numeros).length).toBeGreaterThan(0);
      expect(r[i].resumo.length).toBeGreaterThan(0);
      expect(r[i].rank).toBe(i + 1);
    }
    for (let i = 1; i < r.length; i++) expect(r[i].score).toBeLessThanOrEqual(r[i - 1].score);
    // os 3 detectores presentes
    expect(new Set(r.map((s) => s.detector))).toEqual(
      new Set(["d1_tendencia", "d2_silencio", "d3_compromisso_vencido"]),
    );
  });

  it("2. D1 com números do gate §6.1", async () => {
    const r = await detectSignals(BRAIN, { now: NOW });
    const d1 = r.find((s) => s.detector === "d1_tendencia")!;
    expect(d1).toBeTruthy();
    expect(d1.numeros.slopePorDia).toBeCloseTo(55.5685, 3);
    expect(d1.numeros.pctTotal).toBeCloseTo(900, 6);
    expect(d1.resumo).toBe("preco de accelera: 3000 → 30000 (+900.0% em 519 dias; slope 55.57/dia)");
  });

  it("3. load dirigido — cadeia completa + pageDates", async () => {
    const inp = await loadSignalInputs(BRAIN, NOW);
    const g = inp.grupos.find((x) => x.entity === "accelera" && x.predicate === "preco" && x.tier === "");
    expect(g).toBeTruthy();
    expect(g!.facts).toHaveLength(5); // superseded incluídos
    expect(inp.pageDates.get("chat-m24a-signals-1")).toBe("");
  });

  it("4. NOOP (LEI VI) — brain vazio", async () => {
    await wipeBrain(VAZIO);
    const r = await detectSignals(VAZIO, { now: NOW });
    expect(r).toEqual([]);
  });

  it("5. ZERO LLM — galeed_llm_usage do brain == 0", async () => {
    const sql = await rawConnect();
    try {
      await detectSignals(BRAIN, { now: NOW });
      const rows = (await sql`select count(*)::int c from galeed_llm_usage where brain = ${BRAIN}`) as any[];
      expect(rows[0].c).toBe(0);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it("6. Accelera SOMENTE LEITURA (smoke read-only)", async () => {
    const sql = await rawConnect();
    try {
      const fc = (await sql`select count(*)::int c from galeed_facts where brain = 'Accelera'`) as any[];
      if (fc[0].c === 0) return; // skip se Accelera não existe neste DB
      const snap = async () => ({
        facts: ((await sql`select count(*)::int c from galeed_facts where brain = 'Accelera'`) as any[])[0].c,
        pages: ((await sql`select count(*)::int c from galeed_pages where brain = 'Accelera'`) as any[])[0].c,
        llm: ((await sql`select count(*)::int c from galeed_llm_usage where brain = 'Accelera'`) as any[])[0].c,
      });
      const antes = await snap();
      const r = await detectSignals("Accelera", { now: NOW });
      const depois = await snap();
      expect(depois).toEqual(antes); // nada escrito
      for (const s of r) {
        expect(s.baseFacts.length).toBeGreaterThanOrEqual(1);
        expect(s.resumo.length).toBeGreaterThan(0);
      }
    } finally {
      await sql.end({ timeout: 5 });
    }
  });
});
