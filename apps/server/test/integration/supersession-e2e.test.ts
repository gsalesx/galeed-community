/** INTEGRAÇÃO: supersessão ponta-a-ponta pelo caminho REAL do banco (capture → extract → organize).
 *  Garante que o `buildIndex` (não só a função pura) deriva a verdade bitemporal correta e a grava
 *  ATOMICAMENTE via replaceDerived. Precisa de Postgres. Skip automático sem DATABASE_URL. */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { hasDb, wipeBrain } from "./helpers/db.ts";
import { getEngine, closeEngines, type PageRow, type ExtractionRow } from "../../src/core/platform/engine.ts";
import { buildIndex } from "../../src/core/retrieval/indexer.ts";

const BRAIN = "__test_supersession";

const page = (slug: string, date: string, body: string): PageRow => ({
  slug, type: "reunioes", title: slug, date, path: "", body, content_hash: slug,
});

const extraction = (slug: string, date: string, value: string, quote: string): ExtractionRow => ({
  source_slug: slug, type: "reunioes", date, content_hash: slug, prompt_version: "test",
  extractions: { facts: [{ entity: "acme", predicate: "preco_mensal", value, valid_from: date, context_quote: quote, text: `preço ${value}` }] },
});

describe.skipIf(!hasDb())("supersessão e2e (buildIndex sobre o banco real)", () => {
  beforeAll(async () => {
    await wipeBrain(BRAIN);
    const e = await getEngine(BRAIN);
    // duas fontes, mesma entidade/predicado, valores e datas distintos — quote ANCORADO no body.
    await e.upsertPage(page("jan", "2026-01-10", "Acme fechou o plano em R$ 499 por mês em janeiro."));
    await e.upsertPage(page("mar", "2026-03-10", "Acme renegociou o plano para R$ 599 por mês em março."));
    await e.putExtraction(extraction("jan", "2026-01-10", "499", "plano em R$ 499 por mês"));
    await e.putExtraction(extraction("mar", "2026-03-10", "599", "plano para R$ 599 por mês"));
    await buildIndex(BRAIN);
  });

  afterAll(async () => {
    await wipeBrain(BRAIN);
    await closeEngines();
  });

  it("o valor mais recente é a verdade vigente (valid_to vazio)", async () => {
    const e = await getEngine(BRAIN);
    const tl = await e.timeline("acme", { predicate: "preco_mensal" });
    const vigente = tl.filter((f) => f.valid_to === "");
    expect(vigente).toHaveLength(1);
    expect(vigente[0].value).toBe("599");
  });

  it("o valor antigo foi arquivado e sua janela fechada na data do novo", async () => {
    const e = await getEngine(BRAIN);
    const tl = await e.timeline("acme", { predicate: "preco_mensal" });
    const antigo = tl.find((f) => f.value === "499");
    expect(antigo).toBeDefined();
    expect(antigo!.status).toBe("arquivado");
    expect(antigo!.valid_to).toBe("2026-03-10");
  });

  it("buildIndex é idempotente — rodar de novo não duplica a verdade vigente", async () => {
    await buildIndex(BRAIN);
    const e = await getEngine(BRAIN);
    const tl = await e.timeline("acme", { predicate: "preco_mensal" });
    expect(tl.filter((f) => f.valid_to === "")).toHaveLength(1);
  });
});
