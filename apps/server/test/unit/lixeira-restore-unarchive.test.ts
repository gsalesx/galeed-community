/** Decaimento→lixeira (achado decaimento-lixeira#3): restoreCold é o "unarchive" de verdade —
 *  restaura página COLD (pós-shed) E página ARCHIVED+HOT (pós-prune/consolidate sem shed). Antes o
 *  guard exigia tier='cold' e a arquivada-hot não tinha NENHUM caminho de restauração (o
 *  arrependimento imediato do `prune --apply` ficava preso). Sem banco: engine e embeddings mockados. */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  pages: new Map<string, any>(),
  setArchived: vi.fn(async () => {}),
  setTier: vi.fn(async () => {}),
  buildEmbeddings: vi.fn(async () => ({ embedded: 2, reused: 0, pruned: 0 })),
}));

vi.mock("../../src/core/platform/engine.ts", async (importOriginal) => {
  const mod = await importOriginal<any>();
  return {
    ...mod,
    getEngine: vi.fn(async () => ({
      getPage: async (slug: string) => h.pages.get(slug),
      setArchived: h.setArchived,
      setTier: h.setTier,
    })),
  };
});
vi.mock("../../src/core/retrieval/embeddings.ts", () => ({ buildEmbeddings: h.buildEmbeddings }));

import { restoreCold } from "../../src/core/memory/tiering.ts";

const page = (slug: string, tier: string, archived: boolean) => ({
  slug, type: "notas", title: slug, date: "2024-01-01", path: "", body: "corpo", tier, archived,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.pages.clear();
});

describe("restoreCold — des-arquivar qualquer página arquivada", () => {
  it("página inexistente → restored:false, nada mutado", async () => {
    const r = await restoreCold("b", "nao-existe");
    expect(r).toEqual({ slug: "nao-existe", restored: false, vectorsRebuilt: 0 });
    expect(h.setArchived).not.toHaveBeenCalled();
  });

  it("página ATIVA (hot, não arquivada) → restored:false (nada a restaurar)", async () => {
    h.pages.set("ativa", page("ativa", "hot", false));
    const r = await restoreCold("b", "ativa");
    expect(r.restored).toBe(false);
    expect(h.setArchived).not.toHaveBeenCalled();
    expect(h.setTier).not.toHaveBeenCalled();
  });

  it("página ARCHIVED+HOT (prune --apply sem shed) → restaura: desarquiva + tier hot + re-embeda", async () => {
    h.pages.set("presa", page("presa", "hot", true));
    const r = await restoreCold("b", "presa");
    expect(r.restored).toBe(true);
    expect(h.setArchived).toHaveBeenCalledWith("presa", false);
    expect(h.setTier).toHaveBeenCalledWith("presa", "hot"); // no-op idempotente no caso hot
    expect(h.buildEmbeddings).toHaveBeenCalled(); // re-embeda o que o pruneVectors tiver levado
    expect(r.vectorsRebuilt).toBe(2);
  });

  it("página COLD (pós-shed) → caminho original preservado", async () => {
    h.pages.set("fria", page("fria", "cold", true));
    const r = await restoreCold("b", "fria");
    expect(r.restored).toBe(true);
    expect(h.setArchived).toHaveBeenCalledWith("fria", false);
    expect(h.setTier).toHaveBeenCalledWith("fria", "hot");
  });

  it("página COLD sem archived (estado raro) → também restaura (guard é cold OU arquivada)", async () => {
    h.pages.set("so-fria", page("so-fria", "cold", false));
    const r = await restoreCold("b", "so-fria");
    expect(r.restored).toBe(true);
  });
});
