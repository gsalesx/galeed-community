/** Arestas semânticas sobrevivem ao buildIndex (achado tags-e-organizacao#4).
 *  (a) buildSemanticLinks SUBSTITUI via replaceEdgesOfKind("semantic", …) — não appenda com
 *      putEdges (que acumularia duplicata agora que o replaceDerived as poupa).
 *  (b) Invariantes de SQL no fonte do engine (padrão postgres-boundary.test.ts — sem banco):
 *      os deletes do replaceDerived/replaceFactsForSourcesAndGroups são escopados
 *      `kind <> 'semantic'`, o vectorSearch filtra archived nos DOIS ramos e o pruneVectors
 *      nunca deleta vetor de página arquivada (achados decaimento-lixeira#2/#4). */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  vectors: [] as any[],
  replaceEdgesOfKind: vi.fn(async () => {}),
  putEdges: vi.fn(async () => {}),
}));

vi.mock("../../src/core/platform/engine.ts", async (importOriginal) => {
  const mod = await importOriginal<any>();
  return {
    ...mod,
    getEngine: vi.fn(async () => ({
      allVectors: async () => h.vectors,
      replaceEdgesOfKind: h.replaceEdgesOfKind,
      putEdges: h.putEdges,
    })),
  };
});

import { buildSemanticLinks } from "../../src/core/memory/link.ts";

const vec = (slug: string, v: number[]) => ({ hash: `h-${slug}`, slug, chunk_idx: 0, text: "t", vec: Float32Array.from(v) });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("buildSemanticLinks — substitui (idempotente), não acumula", () => {
  it("grava via replaceEdgesOfKind('semantic', …) com kind tipado; putEdges NÃO é usado", async () => {
    // dois pares: (a,b) idênticos (sim 1.0) e c ortogonal (sim 0 < limiar)
    h.vectors = [vec("a", [1, 0]), vec("b", [1, 0]), vec("c", [0, 1])];
    const r = await buildSemanticLinks("brain");
    expect(r.added).toBe(1);
    expect(h.putEdges).not.toHaveBeenCalled();
    expect(h.replaceEdgesOfKind).toHaveBeenCalledTimes(1);
    const [kind, edges] = h.replaceEdgesOfKind.mock.calls[0] as any[];
    expect(kind).toBe("semantic");
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ src: "a", dst: "b", kind: "semantic" });
    expect(edges[0].weight).toBeCloseTo(1, 2);
  });

  it("sem vetores → no-op (não zera as semânticas existentes)", async () => {
    h.vectors = [];
    const r = await buildSemanticLinks("brain");
    expect(r.added).toBe(0);
    expect(h.replaceEdgesOfKind).not.toHaveBeenCalled();
  });
});

describe("invariantes de SQL do engine (fonte, sem banco)", () => {
  const src = readFileSync(
    resolve(new URL("../..", import.meta.url).pathname, "src/core/engines/postgres.ts"),
    "utf8",
  );
  /** recorta o trecho entre dois marcadores EXISTENTES (falha alto se o engine for reorganizado). */
  const between = (startMarker: string, endMarker: string) => {
    const i = src.indexOf(startMarker);
    expect(i, `marcador ausente: ${startMarker}`).toBeGreaterThan(-1);
    const j = src.indexOf(endMarker, i);
    expect(j, `marcador ausente: ${endMarker}`).toBeGreaterThan(i);
    return src.slice(i, j);
  };

  it("replaceDerived: delete de arestas escopado kind <> 'semantic' (não é dono das semânticas)", () => {
    const body = between("async replaceDerived(", "private rowToFact(");
    expect(body).toContain("delete from galeed_edges");
    expect(body).toMatch(/delete from galeed_edges[^`]*kind <> 'semantic'/);
  });

  it("replaceFactsForSourcesAndGroups: delete escopado por src TAMBÉM poupa kind='semantic'", () => {
    const body = between("async replaceFactsForSourcesAndGroups(", "async putFacts(");
    expect(body).toMatch(/delete from galeed_edges[^`]*kind <> 'semantic'/);
  });

  it("replaceEdgesOfKind: transacional — delete por kind + insert", () => {
    const body = between("async replaceEdgesOfKind(", "async allVectors(");
    expect(body).toContain("this.sql.begin");
    expect(body).toMatch(/delete from galeed_edges[^`]*kind = \$\{kind\}/);
    expect(body).toContain("insert into galeed_edges");
  });

  it("vectorSearch: os DOIS ramos filtram coalesce(p.archived, false) = false", () => {
    const body = between("async vectorSearch(", "async search(");
    const hits = body.match(/coalesce\(p\.archived, false\) = false/g) ?? [];
    expect(hits.length).toBe(2);
  });

  it("pruneVectors: nunca deleta vetor de página arquivada (guard not exists)", () => {
    const body = between("async pruneVectors(", "async hasVectors(");
    expect(body).toMatch(/not exists[\s\S]*coalesce\(p\.archived, false\) = true/);
  });
});
