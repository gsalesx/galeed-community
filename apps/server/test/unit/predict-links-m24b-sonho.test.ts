/** M24-B/§5.A — predictLinks PURO (sem DB). Grafo sintético como GraphData literal. */
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { predictLinks } from "../../src/core/memory/dream-v2.ts";
import type { GraphData, GraphNode, GraphEdge } from "../../src/core/platform/engine.ts";

function node(id: string): GraphNode {
  return { id, label: id, type: "assunto", date: "", exists: true, factCount: 3 };
}
function edge(src: string, dst: string, weight = 2): GraphEdge {
  return { src, dst, kind: "cooc", weight };
}
function graph(ids: string[], edges: [string, string][]): GraphData {
  return { nodes: ids.map(node), edges: edges.map(([a, b]) => edge(a, b)) };
}
const pairId = (a: string, b: string) => createHash("sha256").update(`sonho|${a}|${b}`).digest("hex").slice(0, 32);

describe("predictLinks (M24-B §5.A)", () => {
  it("1. AA/RA na unha + score = média das normalizações", () => {
    // a e b compartilham v1 (grau 2) e v2 (grau 2): vizinhos só de a e b.
    // c e d compartilham só v3 (grau 2) — 1 vizinho.
    const g = graph(["a", "b", "v1", "v2", "c", "d", "v3"], [
      ["a", "v1"], ["b", "v1"], ["a", "v2"], ["b", "v2"],
      ["c", "v3"], ["d", "v3"],
    ]);
    const out = predictLinks(g, { minShared: 1, maxDegree: 60 });
    const ab = out.find((h) => h.a === "a" && h.b === "b")!;
    expect(ab).toBeTruthy();
    // v1,v2 graus = 2 → aa = 2 * (1/ln2), ra = 2 * (1/2) = 1
    expect(ab.aa).toBeCloseTo(2 / Math.log(2), 10);
    expect(ab.ra).toBeCloseTo(1.0, 10);
    // cd: v3 grau 2 → aa = 1/ln2, ra = 0.5
    const cd = out.find((h) => h.a === "c" && h.b === "d")!;
    expect(cd.aa).toBeCloseTo(1 / Math.log(2), 10);
    expect(cd.ra).toBeCloseTo(0.5, 10);
    // maxAA = ab.aa, maxRA = ab.ra ⇒ ab.score = (1+1)/2 = 1
    expect(ab.score).toBeCloseTo(1.0, 10);
    // cd.score = (0.5 + 0.5)/2 = 0.5
    expect(cd.score).toBeCloseTo(0.5, 10);
  });

  it("2. par já ligado diretamente é excluído", () => {
    const g = graph(["a", "b", "x", "y", "z"], [
      ["a", "b"], // aresta direta
      ["a", "x"], ["b", "x"], ["a", "y"], ["b", "y"], ["a", "z"], ["b", "z"],
    ]);
    const out = predictLinks(g, { minShared: 1, maxDegree: 60 });
    expect(out.find((h) => (h.a === "a" && h.b === "b") || (h.a === "b" && h.b === "a"))).toBeUndefined();
  });

  it("3. cap por grau — nó com deg > maxDegree não vira ponta de par", () => {
    // hub com 4 vizinhos; maxDegree=3 ⇒ hub fora. v1,v2 ligam a e b.
    const g = graph(["hub", "a", "b", "c", "d", "v1", "v2"], [
      ["hub", "a"], ["hub", "b"], ["hub", "c"], ["hub", "d"],
      ["a", "v1"], ["b", "v1"], ["a", "v2"], ["b", "v2"],
    ]);
    const out = predictLinks(g, { minShared: 1, maxDegree: 3 });
    // hub tem grau 4 > 3 ⇒ não aparece como ponta
    expect(out.every((h) => h.a !== "hub" && h.b !== "hub")).toBe(true);
  });

  it("4. anti-hub estrutural", () => {
    // hub com grau 4 (>maxDegree 3). a–b só compartilham hub ⇒ NÃO candidato.
    // c–d compartilham hub + w (não-hub) com minShared 2 ⇒ candidato.
    const g = graph(["hub", "a", "b", "c", "d", "w", "e", "f"], [
      ["hub", "a"], ["hub", "b"], ["hub", "c"], ["hub", "d"],
      ["c", "w"], ["d", "w"],
      // padding pra hub ter grau 4 já satisfeito acima
    ]);
    const out = predictLinks(g, { minShared: 2, maxDegree: 3 });
    // a-b: único compartilhado seria hub, mas minShared 2 já barra; mesmo com 1, anti-hub barra
    expect(out.find((h) => h.a === "a" && h.b === "b")).toBeUndefined();
    // c-d: shared = {hub, w}, w não-hub ⇒ candidato
    expect(out.find((h) => h.a === "c" && h.b === "d")).toBeTruthy();
  });

  it("5. minShared — 1 vizinho com minShared 2 fica fora", () => {
    const g = graph(["a", "b", "v1"], [["a", "v1"], ["b", "v1"]]);
    const out = predictLinks(g, { minShared: 2, maxDegree: 60 });
    expect(out.find((h) => h.a === "a" && h.b === "b")).toBeUndefined();
  });

  it("6. topK — 5 candidatos com topK 3 → 3 hipóteses ordenadas por score DESC", () => {
    // 5 pares independentes (p{i}a,p{i}b) cada com i vizinhos em comum.
    const ids: string[] = [];
    const edges: [string, string][] = [];
    for (let i = 1; i <= 5; i++) {
      const a = `p${i}a`, b = `p${i}b`;
      ids.push(a, b);
      for (let v = 0; v < i + 1; v++) {
        const vid = `p${i}v${v}`;
        ids.push(vid);
        edges.push([a, vid], [b, vid]);
      }
    }
    const out = predictLinks(graph(ids, edges), { minShared: 2, maxDegree: 60, topK: 3 });
    expect(out.length).toBe(3);
    for (let i = 1; i < out.length; i++) expect(out[i - 1].score).toBeGreaterThanOrEqual(out[i].score);
  });

  it("7. determinismo — 2 chamadas idênticas", () => {
    const ids: string[] = [];
    const edges: [string, string][] = [];
    for (let i = 1; i <= 4; i++) {
      const a = `q${i}a`, b = `q${i}b`;
      ids.push(a, b);
      for (let v = 0; v < 2; v++) { const vid = `q${i}v${v}`; ids.push(vid); edges.push([a, vid], [b, vid]); }
    }
    const g = graph(ids, edges);
    const a = predictLinks(g, { minShared: 2 });
    const b = predictLinks(g, { minShared: 2 });
    expect(a.map((h) => h.id)).toEqual(b.map((h) => h.id));
    expect(a).toEqual(b);
  });

  it("8. id por par — a<b normalizado, ordem de aresta não importa", () => {
    const g1 = graph(["a", "b", "v1", "v2"], [["a", "v1"], ["b", "v1"], ["a", "v2"], ["b", "v2"]]);
    const g2 = graph(["a", "b", "v1", "v2"], [["v1", "b"], ["v1", "a"], ["v2", "b"], ["v2", "a"]]);
    const h1 = predictLinks(g1, { minShared: 1 }).find((h) => h.a === "a" && h.b === "b")!;
    const h2 = predictLinks(g2, { minShared: 1 }).find((h) => h.a === "a" && h.b === "b")!;
    expect(h1.id).toBe(pairId("a", "b"));
    expect(h2.id).toBe(h1.id);
  });

  it("9. grafo sem candidato → [] sem throw", () => {
    const g = graph(["a", "b"], [["a", "b"]]); // só ligados diretamente
    expect(predictLinks(g)).toEqual([]);
    expect(predictLinks({ nodes: [], edges: [] })).toEqual([]);
  });

  it("10. template do texto bate o §2.1.2-8", () => {
    const g = graph(["a", "b", "v1", "v2"], [["a", "v1"], ["b", "v1"], ["a", "v2"], ["b", "v2"]]);
    const h = predictLinks(g, { minShared: 1 }).find((x) => x.a === "a" && x.b === "b")!;
    const expected = `${h.a} e ${h.b} compartilham ${h.shared.length} vizinhos (${h.shared.slice(0, 3).join(", ")}) sem ligação direta no mapa — pode existir relação. Sinal: AA ${h.aa.toFixed(2)} · RA ${h.ra.toFixed(3)} · score ${h.score.toFixed(2)}.`;
    expect(h.text).toBe(expected);
  });
});
