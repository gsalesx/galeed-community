/** INTEGRAÇÃO: esquecer é REVERSÍVEL (M5/R1) — shedCold descarta o peso regenerável (vetores) e
 *  resfria a página; restoreCold a traz de volta. Provamos o round-trip dos FLAGS (tier + archived)
 *  sem depender de OPENAI (a re-embedação numérica é coberta no HTC; aqui travamos a reversibilidade
 *  da máquina de estado, que é a garantia "esquecer sem perder"). Precisa de Postgres. */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { hasDb, wipeBrain } from "./helpers/db.ts";
import { getEngine, closeEngines, type PageRow, type VecRow } from "../../src/core/platform/engine.ts";
import { shedCold, restoreCold } from "../../src/core/memory/tiering.ts";
import { config } from "../../src/core/platform/config.ts";

const BRAIN = "__test_tiering";
const SLUG = "arquivavel";

describe.skipIf(!hasDb())("tiering reversível (shed → restore)", () => {
  beforeAll(async () => {
    await wipeBrain(BRAIN);
    const e = await getEngine(BRAIN);
    const pg: PageRow = { slug: SLUG, type: "notas", title: SLUG, date: "2024-01-01", path: "", body: "conteúdo regenerável", content_hash: "h1" };
    await e.upsertPage(pg);
    // injeta um vetor "manual" (dims do brain) — sem chamar OpenAI; é o peso que o shed descarta.
    const dims = config(BRAIN).embeddings.dims;
    const vec: VecRow = { hash: "vh1", slug: SLUG, chunk_idx: 0, text: "conteúdo regenerável", vec: new Float32Array(dims).fill(0.001) };
    await e.putVectors([vec]);
  });

  afterAll(async () => {
    await wipeBrain(BRAIN);
    await closeEngines();
  });

  it("página arquivada+hot é candidata; shedCold a resfria e descarta os vetores", async () => {
    const e = await getEngine(BRAIN);
    await e.setArchived(SLUG, true); // arquivar não pesa nada por si — vira candidata a shed

    const cand = await e.shedCandidates();
    expect(cand.some((p) => p.slug === SLUG)).toBe(true);

    const r = await shedCold(BRAIN);
    expect(r.pages).toContain(SLUG);
    expect(r.vectorsShed).toBeGreaterThanOrEqual(1);

    const cold = await e.coldPages();
    expect(cold.some((p) => p.slug === SLUG)).toBe(true);
    const hashes = await e.vectorHashes();
    expect(hashes.has("vh1")).toBe(false); // vetor descartado (regenerável)
  });

  it("restoreCold reverte: desarquiva e volta pra hot (body nunca foi perdido)", async () => {
    const e = await getEngine(BRAIN);
    const r = await restoreCold(BRAIN, SLUG);
    expect(r.restored).toBe(true);

    const cold = await e.coldPages();
    expect(cold.some((p) => p.slug === SLUG)).toBe(false); // não está mais cold

    const pg = await e.getPage(SLUG);
    expect(pg).toBeDefined();
    expect(pg!.body).toBe("conteúdo regenerável"); // o body (fonte de verdade) sobreviveu ao ciclo
  });
});
