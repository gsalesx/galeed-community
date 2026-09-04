/** M24-B/§5.E — GATE §6.4 do BRIEF no corpus REAL (Accelera, SOMENTE LEITURA). Só entityGraph()
 *  + funções PURAS (predictLinks/detectClusters). NENHUMA escrita: não chama dreamV2,
 *  addReviewItems, putFacts nem setReviewStatus. Asserts ESTRUTURAIS com pisos (o corpus cresce —
 *  não cravar pares/scores exatos; medidos hoje: 213 nós / 860 arestas / 6.484 candidatos). */
import { describe, it, expect, afterAll } from "vitest";
import { hasDb } from "./helpers/db.ts";
import { getEngine, closeEngines, type GraphData } from "../../src/core/platform/engine.ts";
import { predictLinks, detectClusters, DREAM_DEFAULTS } from "../../src/core/memory/dream-v2.ts";

const BRAIN = "Accelera"; // PRODUÇÃO — somente leitura

function degrees(g: GraphData): Map<string, number> {
  const adj = new Map<string, Set<string>>();
  for (const e of g.edges) {
    if (!e.src || !e.dst || e.src === e.dst) continue;
    (adj.get(e.src) ?? adj.set(e.src, new Set()).get(e.src)!).add(e.dst);
    (adj.get(e.dst) ?? adj.set(e.dst, new Set()).get(e.dst)!).add(e.src);
  }
  const deg = new Map<string, number>();
  for (const [n, s] of adj) deg.set(n, s.size);
  return deg;
}

describe.skipIf(!hasDb())("M24-B gate corpus real (§5.E — Accelera SOMENTE LEITURA)", () => {
  afterAll(async () => {
    await closeEngines();
  });

  it("1. grafo real vivo: ≥100 nós, ≥500 arestas", async () => {
    const g = await (await getEngine(BRAIN)).entityGraph();
    expect(g.nodes.length).toBeGreaterThanOrEqual(100);
    expect(g.edges.length).toBeGreaterThanOrEqual(500);
  });

  it("2. predictLinks devolve 1..10 hipóteses (topK default)", async () => {
    const g = await (await getEngine(BRAIN)).entityGraph();
    const h = predictLinks(g);
    expect(h.length).toBeGreaterThanOrEqual(1);
    expect(h.length).toBeLessThanOrEqual(DREAM_DEFAULTS.topK);
  });

  it("3. anti-hub (assert LITERAL do gate §6.4): nenhum top-5 com 'accelera' como justificativa única", async () => {
    const g = await (await getEngine(BRAIN)).entityGraph();
    const top5 = predictLinks(g).slice(0, 5);
    for (const h of top5) {
      expect(h.shared.filter((s) => s !== "accelera").length).toBeGreaterThanOrEqual(1);
    }
  });

  it("4. anti-hub estrutural geral: top-5 com ≥1 vizinho grau ≤ 60 e pontas grau ≤ 60", async () => {
    const g = await (await getEngine(BRAIN)).entityGraph();
    const deg = degrees(g);
    const top5 = predictLinks(g).slice(0, 5);
    for (const h of top5) {
      expect(deg.get(h.a) ?? 0).toBeLessThanOrEqual(DREAM_DEFAULTS.maxDegree);
      expect(deg.get(h.b) ?? 0).toBeLessThanOrEqual(DREAM_DEFAULTS.maxDegree);
      expect(h.shared.some((s) => (deg.get(s) ?? 0) <= DREAM_DEFAULTS.maxDegree)).toBe(true);
    }
  });

  it("5. evidência mínima: top-5 com shared.length ≥ 2 e 0 < score ≤ 1", async () => {
    const g = await (await getEngine(BRAIN)).entityGraph();
    const top5 = predictLinks(g).slice(0, 5);
    for (const h of top5) {
      expect(h.shared.length).toBeGreaterThanOrEqual(2);
      expect(h.score).toBeGreaterThan(0);
      expect(h.score).toBeLessThanOrEqual(1);
    }
  });

  it("6. determinismo no real: 2 chamadas → ids idênticos na mesma ordem", async () => {
    const g = await (await getEngine(BRAIN)).entityGraph();
    const a = predictLinks(g).map((h) => h.id);
    const b = predictLinks(g).map((h) => h.id);
    expect(a).toEqual(b);
  });

  it("7. detectClusters: ≥1 cluster size ≥ 3, 0 < density ≤ 1, partição determinística", async () => {
    const g = await (await getEngine(BRAIN)).entityGraph();
    const c1 = detectClusters(g);
    expect(c1.length).toBeGreaterThanOrEqual(1);
    for (const c of c1) {
      expect(c.size).toBeGreaterThanOrEqual(DREAM_DEFAULTS.minClusterSize);
      expect(c.density).toBeGreaterThan(0);
      expect(c.density).toBeLessThanOrEqual(1);
    }
    const c2 = detectClusters(g);
    expect(c1.map((c) => c.id)).toEqual(c2.map((c) => c.id));
  });
});
