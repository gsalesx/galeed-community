/** Decaimento→lixeira (achado decaimento-lixeira#2): página ARQUIVADA fica FORA da recuperação.
 *  O SQL do vectorSearch/FTS já filtra archived no engine; aqui travamos a 3ª porta — a
 *  graph-expansion do retrieve, que injeta vizinhos de galeed_edges (arestas pra página arquivada
 *  PERSISTEM) via pagesBySlug. Sem o check de p.archived, a lixeira voltava via 'grafo' com selo
 *  'registrado'. Sem banco: engine/embeddings/reranker mockados. */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  ftsHits: [] as any[],
  neighbors: new Map<string, string[]>(),
  pages: new Map<string, any>(),
}));

vi.mock("../../src/core/platform/engine.ts", async (importOriginal) => {
  const mod = await importOriginal<any>();
  return {
    ...mod,
    getEngine: vi.fn(async () => ({
      search: async () => h.ftsHits,
      neighbors: async (slugs: string[]) => {
        const out = new Map<string, string[]>();
        for (const s of slugs) if (h.neighbors.has(s)) out.set(s, h.neighbors.get(s)!);
        return out;
      },
      pagesBySlug: async (slugs: string[]) => {
        const out = new Map<string, any>();
        for (const s of slugs) if (h.pages.has(s)) out.set(s, h.pages.get(s));
        return out;
      },
    })),
  };
});
vi.mock("../../src/core/retrieval/embeddings.ts", () => ({ semanticSearch: vi.fn(async () => null) }));
vi.mock("../../src/core/retrieval/reranker.ts", () => ({ rerankAvailable: () => false, rerank: vi.fn(async () => null) }));
vi.mock("../../src/lib/openai.ts", () => ({ chatComplete: vi.fn(async () => ""), embed: vi.fn(), hasOpenAIKey: () => false }));

import { retrieve } from "../../src/core/retrieval/query.ts";

const page = (slug: string, archived: boolean) => ({
  slug, type: "notas", title: slug, date: "2026-01-01", path: "", body: `corpo de ${slug}`,
  people: [], tags: [], tier: "hot", sensitivity: "restrito", salience: 0, archived,
});

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.GALEED_QUERY_EXPANSION;
  h.ftsHits = [{ slug: "viva", type: "notas", title: "viva", date: "2026-01-01", excerpt: "corpo", score: 1 }];
  h.neighbors = new Map([["viva", ["vizinha-arquivada", "vizinha-viva"]]]);
  h.pages = new Map([
    ["viva", page("viva", false)],
    ["vizinha-viva", page("vizinha-viva", false)],
    ["vizinha-arquivada", page("vizinha-arquivada", true)],
  ]);
});

describe("retrieve — graph-expansion não reinjeta página arquivada", () => {
  it("vizinho ARQUIVADO fica fora; vizinho vivo entra via 'grafo'", async () => {
    const hits = await retrieve("b", "corpo", 6);
    const slugs = hits.map((x) => x.slug);
    expect(slugs).toContain("viva");
    expect(slugs).toContain("vizinha-viva");
    expect(slugs).not.toContain("vizinha-arquivada");
    expect(hits.find((x) => x.slug === "vizinha-viva")?.via).toBe("grafo");
  });

  it("controle: o MESMO vizinho sem archived entra (prova que o filtro é o flag, não outra coisa)", async () => {
    h.pages.set("vizinha-arquivada", page("vizinha-arquivada", false));
    const hits = await retrieve("b", "corpo", 6);
    expect(hits.map((x) => x.slug)).toContain("vizinha-arquivada");
  });
});
