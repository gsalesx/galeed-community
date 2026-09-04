/** Decaimento→lixeira (achado decaimento-lixeira#5): consolidateCold na 2ª rodada da MESMA entidade
 *  ATUALIZA o body da página-resumo (o capture é skip-on-exists e deixava as fontes novas irem pra
 *  lixeira com resumo VELHO). Invariante restaurado: NUNCA arquiva sem resumo ATUAL gravado — e o
 *  resumo eventualmente podado pelo prune é des-arquivado junto. Sem banco: engine/capture mockados. */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "node:crypto";

const h = vi.hoisted(() => ({
  facts: [] as any[],
  pages: [] as any[],
  resumoSlug: undefined as string | undefined,
  getPage: vi.fn(async (_slug: string) => undefined as any),
  upsertPage: vi.fn(async () => {}),
  setArchived: vi.fn(async () => {}),
  capture: vi.fn(async () => ({ slug: "resumo-novo", skipped: false })),
}));

vi.mock("../../src/core/platform/engine.ts", async (importOriginal) => {
  const mod = await importOriginal<any>();
  return {
    ...mod,
    getEngine: vi.fn(async () => ({
      currentFacts: async () => h.facts,
      allPages: async () => h.pages,
      pageByExternalId: async (_id: string) => h.resumoSlug,
      getPage: h.getPage,
      upsertPage: h.upsertPage,
      setArchived: h.setArchived,
    })),
  };
});
vi.mock("../../src/core/ingestion/capture.ts", () => ({ capture: h.capture }));
vi.mock("../../src/lib/llm.ts", () => ({ resolveProvider: () => "none", prose: vi.fn(async () => "") }));

import { consolidateCold } from "../../src/core/memory/sleep.ts";

const fato = (predicate: string, value: string, slug: string) => ({
  source_slug: slug, type: "notas", dimension: "facts", text: `${predicate} ${value}`, quote: "",
  entity: "acme", predicate, value, valid_from: "2026-02-01", valid_to: "", confidence: 0.9, status: "fato",
});

beforeEach(() => {
  vi.clearAllMocks();
  // 3 fatos (minFacts default) de 2 fontes FRIAS (datas < olderThan), um deles NOVO (2ª rodada)
  h.facts = [fato("preco", "100", "fonte-jan"), fato("plano", "pro", "fonte-jan"), fato("sede", "sp", "fonte-mai")];
  h.pages = [
    { slug: "fonte-jan", type: "notas", title: "jan", date: "2026-01-10", path: "", body: "" },
    { slug: "fonte-mai", type: "notas", title: "mai", date: "2026-05-10", path: "", body: "" },
  ];
  h.resumoSlug = undefined;
});

describe("consolidateCold — resumo sempre ATUAL antes de arquivar", () => {
  it("1ª rodada (resumo não existe) → capture cria; fontes frias arquivadas", async () => {
    const r = await consolidateCold("b", { olderThan: "2026-06-01" });
    expect(h.capture).toHaveBeenCalledTimes(1);
    expect(h.capture.mock.calls[0][0]).toMatchObject({ externalId: "resumo:acme", type: "conceitos" });
    expect(h.upsertPage).not.toHaveBeenCalled();
    expect(r.summaries).toBe(1);
    expect(h.setArchived).toHaveBeenCalledWith("fonte-jan", true);
    expect(h.setArchived).toHaveBeenCalledWith("fonte-mai", true);
  });

  it("2ª rodada (resumo já existe) → NÃO skipa: upsertPage com body NOVO + des-arquiva o resumo", async () => {
    h.resumoSlug = "resumo-acme";
    h.getPage.mockResolvedValue({
      slug: "resumo-acme", type: "conceitos", title: "Resumo: acme", date: "2026-01-15", path: "",
      body: "Estado atual de acme (VELHO)\n", content_hash: "velho", external_id: "resumo:acme",
      people: [], tags: ["consolidado"], extract_version: "v1", tier: "hot", archived: true,
    });
    const r = await consolidateCold("b", { olderThan: "2026-06-01" });

    expect(h.capture).not.toHaveBeenCalled(); // não passa pelo skip-on-exists
    expect(h.upsertPage).toHaveBeenCalledTimes(1);
    const row = h.upsertPage.mock.calls[0][0] as any;
    expect(row.slug).toBe("resumo-acme");
    expect(row.body).toContain("sede: sp"); // o fato NOVO da 2ª rodada entrou no resumo
    expect(row.body.endsWith("\n")).toBe(true); // espelha capture.ts (idempotência semântica)
    // content_hash espelha capture.ts: sha256(text) hex 16 — conteúdo idêntico → upsert no-op
    expect(row.content_hash).toBe(createHash("sha256").update(row.body.trim()).digest("hex").slice(0, 16));
    expect(row.extract_version).toBe(""); // re-enfileira a extração como capture fresco
    expect(row.date).toBe(new Date().toISOString().slice(0, 10)); // não vira candidato imediato de prune
    // resumo podado pelo prune volta visível (upsertPage não toca archived)
    expect(h.setArchived).toHaveBeenCalledWith("resumo-acme", false);
    // e só ENTÃO as fontes frias do momento atual são arquivadas
    expect(h.setArchived).toHaveBeenCalledWith("fonte-jan", true);
    expect(h.setArchived).toHaveBeenCalledWith("fonte-mai", true);
    expect(r.summaries).toBe(1); // conta o resumo realmente atualizado
  });

  it("sem olderThan → nada é frio, nada arquivado (comportamento preservado)", async () => {
    const r = await consolidateCold("b", {});
    expect(r.summaries).toBe(0);
    expect(h.setArchived).not.toHaveBeenCalled();
  });
});
