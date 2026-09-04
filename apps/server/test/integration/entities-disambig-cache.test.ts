/** Fix sobre-fusão de entidades (#R3) — INTEGRAÇÃO (Postgres real :5434). Prova o cache do desempate
 *  (galeed_entity_disambig, migração 54) ponta a ponta: migração aplica, jsonb round-trip via
 *  sql.json (NÃO dupla-serializa — pegadinha do repo), miss→null, upsert por (brain, group_key) e
 *  isolamento por brain. Skip sem DATABASE_URL. Brain dedicado descartável — nunca toca produção. */
import { describe, it, expect, afterAll } from "vitest";
import { hasDb, wipeBrain } from "./helpers/db.ts";
import { getEngine, closeEngines } from "../../src/core/platform/engine.ts";

const BRAIN = "entities-disambig-cache";
const OTHER = "entities-disambig-cache-other";

describe.skipIf(!hasDb())("galeed_entity_disambig — cache do desempate (DB real :5434)", () => {
  afterAll(async () => {
    await wipeBrain(BRAIN);
    await wipeBrain(OTHER);
    await closeEngines();
  });

  it("miss → null; put+get round-trip fiel do jsonb (string[][], sem dupla-serialização)", async () => {
    const e = await getEngine(BRAIN);
    await wipeBrain(BRAIN);
    expect(await e.getEntityDisambig("naoexiste")).toBeNull();

    const decision = [["joão", "joão silva"], ["joão souza"]];
    await e.putEntityDisambig("k1", decision);
    const hit = await e.getEntityDisambig("k1");
    expect(hit).toEqual(decision); // jsonb parseado = a MESMA estrutura (não string, não escapado 2×)
    expect(Array.isArray(hit) && Array.isArray(hit[0])).toBe(true);
  });

  it("upsert por (brain, group_key): 2ª escrita sobrescreve a decisão", async () => {
    const e = await getEngine(BRAIN);
    await e.putEntityDisambig("k2", [["a", "b"]]);
    await e.putEntityDisambig("k2", [["a"], ["b"]]);
    expect(await e.getEntityDisambig("k2")).toEqual([["a"], ["b"]]);
  });

  it("isolamento por brain: a mesma group_key não vaza entre brains", async () => {
    const e = await getEngine(BRAIN);
    const other = await getEngine(OTHER);
    await wipeBrain(OTHER);
    await e.putEntityDisambig("shared", [["x", "y"]]);
    expect(await other.getEntityDisambig("shared")).toBeNull(); // outro brain não vê
  });
});
