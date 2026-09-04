/** M24-B/§5.B — detectClusters PURO (sem DB). Label propagation determinístico. */
import { describe, it, expect } from "vitest";
import { detectClusters } from "../../src/core/memory/dream-v2.ts";
import type { GraphData, GraphNode, GraphEdge } from "../../src/core/platform/engine.ts";

function node(id: string): GraphNode {
  return { id, label: id, type: "assunto", date: "", exists: true, factCount: 3 };
}
function edge(src: string, dst: string, weight = 1): GraphEdge {
  return { src, dst, kind: "cooc", weight };
}
function graph(ids: string[], edges: [string, string, number?][]): GraphData {
  return { nodes: ids.map(node), edges: edges.map(([a, b, w]) => edge(a, b, w ?? 1)) };
}
// K4 sobre 4 nós. Arestas internas com weight 2 (como o cooc real do entityGraph, minShared≥2):
// densidade interna > ponte ⇒ LPA não colapsa comunidades distintas (§2.1.4 — peso, não contagem).
function k4(prefix: string): [string[], [string, string, number?][]] {
  const ns = [`${prefix}1`, `${prefix}2`, `${prefix}3`, `${prefix}4`];
  const es: [string, string, number?][] = [];
  for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) es.push([ns[i], ns[j], 2]);
  return [ns, es];
}

describe("detectClusters (M24-B §5.B)", () => {
  it("1. duas comunidades óbvias — dois K4 ligados por 1 ponte", () => {
    const [na, ea] = k4("a");
    const [nb, eb] = k4("b");
    const edges: [string, string, number?][] = [...ea, ...eb, ["a1", "b1"]];
    const g = graph([...na, ...nb], edges);
    const clusters = detectClusters(g, { maxDegree: 60, minClusterSize: 3 });
    expect(clusters.length).toBe(2);
    for (const c of clusters) {
      expect(c.size).toBe(4);
      expect(c.density).toBeCloseTo(1.0, 10); // K4 = 6/6 internas
      expect([...c.members]).toEqual([...c.members].sort());
    }
  });

  it("2. hub fora — não cola comunidades nem aparece em cluster", () => {
    const [na, ea] = k4("a");
    const [nb, eb] = k4("b");
    // hub ligado a todos os 8 ⇒ grau 8 > maxDegree 4
    const hubEdges: [string, string][] = [...na, ...nb].map((n) => ["hub", n] as [string, string]);
    const g = graph([...na, ...nb, "hub"], [...ea, ...eb, ...hubEdges]);
    const clusters = detectClusters(g, { maxDegree: 4, minClusterSize: 3 });
    expect(clusters.length).toBe(2);
    expect(clusters.every((c) => !c.members.includes("hub"))).toBe(true);
  });

  it("3. minClusterSize — componente de 2 não vira cluster", () => {
    const g = graph(["x", "y"], [["x", "y"]]);
    expect(detectClusters(g, { minClusterSize: 3 })).toEqual([]);
  });

  it("4. determinismo — 2 chamadas, mesma partição e ids", () => {
    const [na, ea] = k4("a");
    const [nb, eb] = k4("b");
    const g = graph([...na, ...nb], [...ea, ...eb, ["a1", "b1"]]);
    const c1 = detectClusters(g, { maxDegree: 60 });
    const c2 = detectClusters(g, { maxDegree: 60 });
    expect(c1.map((c) => c.id)).toEqual(c2.map((c) => c.id));
    expect(c1).toEqual(c2);
  });

  it("5. peso conta — fronteira segue maior soma de pesos", () => {
    // Dois triângulos densos A (a1,a2,a3) e B (b1,b2,b3), internos weight 3 (a1 fica ancorado
    // em A: 6 > a aresta-fronteira). Nó fronteira f: f–a1 weight 5 ; f–b1 weight 1 ; f–b2 weight 1.
    // contagem diria B (2 arestas) mas peso diz A (5 > 2) ⇒ f entra no cluster de A.
    const ga: [string, string, number?][] = [["a1", "a2", 3], ["a2", "a3", 3], ["a1", "a3", 3]];
    const gb: [string, string, number?][] = [["b1", "b2", 3], ["b2", "b3", 3], ["b1", "b3", 3]];
    const edges: [string, string, number?][] = [
      ...ga, ...gb,
      ["f", "a1", 5], ["f", "b1", 1], ["f", "b2", 1],
    ];
    const g = graph(["a1", "a2", "a3", "b1", "b2", "b3", "f"], edges);
    const clusters = detectClusters(g, { maxDegree: 60, minClusterSize: 3 });
    // f deve cair no cluster que contém a1
    const withF = clusters.find((c) => c.members.includes("f"));
    expect(withF).toBeTruthy();
    expect(withF!.members).toContain("a1");
    expect(withF!.members).not.toContain("b1");
  });
});
