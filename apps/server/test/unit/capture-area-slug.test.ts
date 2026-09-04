/** UNIT — capture normaliza a `area` explícita do webhook com o MESMO slugify dos caminhos por
 *  fonte (process-blob-job/connector-ingest). Sem isso, POST /ingest {"area":"Financeiro"} virava
 *  a tag literal `area:Financeiro` — que nenhum grant slugificado casa (comparação por igualdade
 *  em scope.ts e na RLS) → página invisível fail-closed pra todo token escopado, sem aviso.
 *  Engine MOCADO (zero DB): o stub grava o row que o capture montaria. */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { rows, sens } = vi.hoisted(() => ({
  rows: [] as any[],
  sens: [] as Array<{ slug: string; level: string }>,
}));

vi.mock("../../src/core/platform/engine.ts", async (importActual) => {
  const real = await importActual<any>();
  const stub = {
    pageByExternalId: async () => null,
    getPage: async () => null,
    upsertPage: async (row: any) => { rows.push(row); },
    insertPageIfNew: async (row: any) => { rows.push(row); return true; },
    setSensitivity: async (slug: string, level: string) => { sens.push({ slug, level }); },
  };
  return { ...real, getEngine: async () => stub };
});

import { capture } from "../../src/core/ingestion/capture.ts";
import { inScope, scopeFromGrant } from "../../src/core/access/scope.ts";

beforeEach(() => { rows.length = 0; sens.length = 0; });

describe("capture — normalização da área explícita (M7)", () => {
  it("area 'Financeiro' (case/acento livres do webhook) → tag area:financeiro", async () => {
    const r = await capture({ home: "t", text: "nota qualquer", area: "Financeiro", source: "webhook" });
    expect(r.area).toBe("financeiro");
    expect(rows[0].tags).toContain("area:financeiro");
    expect(rows[0].tags).not.toContain("area:Financeiro");
  });

  it("área composta com acento/símbolo → slug ('Operações & Vendas' → operacoes-vendas)", async () => {
    await capture({ home: "t", text: "nota", area: "Operações & Vendas" });
    expect(rows[0].tags).toContain("area:operacoes-vendas");
  });

  it("área já slugificada é idempotente (retrocompat: tags existentes não mudam de forma)", async () => {
    const r = await capture({ home: "t", text: "nota", area: "financeiro" });
    expect(r.area).toBe("financeiro");
    expect(rows[0].tags).toContain("area:financeiro");
  });

  it("SEM área + canal não mapeado → NENHUMA tag area: (nunca area:sem-titulo — slugify de vazio)", async () => {
    const r = await capture({ home: "t", text: "nota", source: "canal-desconhecido" });
    expect(r.area).toBe("");
    expect(rows[0].tags.some((t: string) => t.startsWith("area:"))).toBe(false);
    // fail-closed do canal desconhecido preservado: sensibilidade 'restrito'
    expect(sens[0].level).toBe("restrito");
  });

  it("ponta a ponta com o grant: a tag normalizada CASA com grant slugificado (o beco que motivou o fix)", async () => {
    await capture({ home: "t", text: "nota", area: "Financeiro", sensitivity: "interno" });
    const scope = scopeFromGrant("p1", {
      principal_id: "p1", areas: ["financeiro"], sensitivity_max: "interno", deny_types: [], scope: "read",
    });
    const page = { type: rows[0].type, tags: rows[0].tags, sensitivity: sens[0].level };
    expect(inScope(page, scope)).toBe(true); // antes do fix: area:Financeiro ∉ ['financeiro'] → invisível
  });
});
