/** UNIT — tags TÉCNICAS (fonte:/src:/canal:/area:/doc:) ficam FORA do vocabulário vivo (tagVocab)
 *  e do selo epistêmico (montarSelo): `src:<uuid>` com contagem alta enterrava as tags reais do
 *  negócio, e o header do selo saía `[#src:3f2a… #doc:ab12…]` — ruído técnico apresentado à LLM
 *  como semântica. Engine MOCADO pro vocabulário (zero DB); selo é função pura. */
import { describe, it, expect, vi } from "vitest";

const { pages } = vi.hoisted(() => ({ pages: [] as any[] }));

vi.mock("../../src/core/platform/engine.ts", async (importActual) => {
  const real = await importActual<any>();
  return { ...real, getEngine: async () => ({ allPages: async () => pages }) };
});

import { isTechTag, tagVocab } from "../../src/core/ingestion/tags.ts";
import { montarSelo, seloHeader } from "../../src/core/retrieval/query.ts";

describe("isTechTag — os 5 prefixos reservados", () => {
  it("técnicas: fonte:/src:/canal:/area:/doc:; semânticas passam", () => {
    for (const t of ["fonte:paste", "src:3f2a-uuid", "canal:gmail", "area:financeiro", "doc:ab12cd34"])
      expect(isTechTag(t)).toBe(true);
    for (const t of ["cliente-vip", "pricing", "docs-do-produto", "areas-de-risco"]) // prefixo ≠ substring
      expect(isTechTag(t)).toBe(false);
  });
});

describe("tagVocab — vocabulário vivo sem ruído técnico", () => {
  it("página cheia de tags de contrato → só as semânticas contam (antes: src:/doc:/canal:/area: entravam)", async () => {
    pages.length = 0;
    pages.push(
      { tags: ["src:3f2a", "canal:gmail", "area:financeiro", "fonte:paste", "cliente-vip", "Pricing"] },
      { tags: ["doc:ab12", "cliente-vip"] },
      { tags: [] },
    );
    const { total, tags } = await tagVocab("t");
    expect(total).toBe(3);
    expect(tags).toEqual([
      { tag: "cliente-vip", count: 2, ratio: 2 / 3 },
      { tag: "pricing", count: 1, ratio: 1 / 3 },
    ]);
  });
});

describe("montarSelo/seloHeader — selo epistêmico só com semântica do negócio", () => {
  it("filtra TODAS as técnicas (não só fonte:) e preserva as do negócio, minúsculas", () => {
    const selo = montarSelo("reunioes", "2026-07-01", "slug-1", "vec",
      ["src:3f2a", "doc:ab12", "canal:gmail", "area:financeiro", "fonte:paste", "Pricing", "cliente-vip"]);
    expect(selo.tags).toEqual(["pricing", "cliente-vip"]);
    const header = seloHeader(selo);
    expect(header).toContain("#pricing #cliente-vip");
    expect(header).not.toContain("src:");
    expect(header).not.toContain("area:");
  });

  it("sem tag semântica → selo sem bloco de tags (header limpo)", () => {
    const selo = montarSelo("notas", "", "s", "fts", ["src:x", "area:y"]);
    expect(selo.tags).toEqual([]);
    expect(seloHeader(selo)).not.toContain("#");
  });
});
