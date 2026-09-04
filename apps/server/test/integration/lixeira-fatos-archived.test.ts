/** Prova de COMPORTAMENTO do fix do vazamento de fatos da lixeira (achado da revisão): arquivar a
 *  página-fonte tira os fatos dela das leituras de VERDADE ATUAL (facts/timeline/currentFacts), e
 *  restaurar traz de volta — SEM reescrita em galeed_facts (reversível de graça).
 *  Espelha o padrão de derive-incremental-equivalence: skipIf(!hasDb()), wipeBrain, brain descartável.
 *  Precisa de Postgres (docker compose up -d). */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { hasDb, wipeBrain } from "./helpers/db.ts";
import { getEngine, closeEngines, type PageRow, type ExtractionRow } from "../../src/core/platform/engine.ts";
import { buildIndex } from "../../src/core/retrieval/indexer.ts";

const BRAIN = "__lixeira_fatos";

const page = (slug: string, date: string, body: string): PageRow => ({
  slug, type: "reunioes", title: slug, date, path: "", body, content_hash: slug,
});

const ex = (slug: string, date: string, entity: string, value: string, quote: string): ExtractionRow => ({
  source_slug: slug, type: "reunioes", date, content_hash: slug, prompt_version: "test",
  extractions: { metricas: [{ entity, predicate: "preco_mensal", value, value_num: Number(value), unit: "BRL", period: "monthly", valid_from: date, context_quote: quote, text: `preco_mensal ${value}` }] },
});

describe.skipIf(!hasDb())("lixeira — fato de página arquivada some da verdade e volta ao restaurar", () => {
  beforeAll(async () => {
    await wipeBrain(BRAIN);
    const e = await getEngine(BRAIN);
    // duas entidades, duas fontes: uma será arquivada, a outra fica de controle.
    await e.upsertPage(page("velha", "2026-01-10", "Acme fechou o plano em R$ 3000 por mês."));
    await e.upsertPage(page("viva", "2026-02-10", "Globex fechou o plano em R$ 9000 por mês."));
    await e.putExtraction(ex("velha", "2026-01-10", "acme", "3000", "plano em R$ 3000 por mês"));
    await e.putExtraction(ex("viva", "2026-02-10", "globex", "9000", "plano em R$ 9000 por mês"));
    await buildIndex(BRAIN);
  });

  afterAll(async () => {
    await wipeBrain(BRAIN);
    await closeEngines();
  });

  async function readAll() {
    const e = await getEngine(BRAIN);
    const facts = await e.facts("metricas", {});
    const tlAcme = await e.timeline("acme", {});
    const cur = await e.currentFacts();
    return {
      facts: facts.map((f) => f.entity),
      tlAcme: tlAcme.length,
      curEnts: cur.map((f) => f.entity),
    };
  }

  it("antes de arquivar: os dois fatos aparecem nas três leituras", async () => {
    const r = await readAll();
    expect(r.facts).toContain("acme");
    expect(r.facts).toContain("globex");
    expect(r.tlAcme).toBeGreaterThan(0);
    expect(r.curEnts).toContain("acme");
    expect(r.curEnts).toContain("globex");
  });

  it("arquivar a página 'velha' remove o fato dela de facts/timeline/currentFacts; o de controle fica", async () => {
    const e = await getEngine(BRAIN);
    await e.setArchived("velha", true);
    const r = await readAll();
    expect(r.facts).not.toContain("acme"); // fonte arquivada → some
    expect(r.facts).toContain("globex"); // controle intacto
    expect(r.tlAcme).toBe(0); // timeline da entidade arquivada zera
    expect(r.curEnts).not.toContain("acme");
    expect(r.curEnts).toContain("globex");
  });

  it("restaurar (archived=false) traz o fato de volta sem reescrever galeed_facts", async () => {
    const e = await getEngine(BRAIN);
    const sql = (e as any).sql;
    const before = (await sql`select count(*)::int c from galeed_facts where brain = ${BRAIN} and entity = 'acme'`)[0].c;
    await e.setArchived("velha", false);
    const r = await readAll();
    expect(r.facts).toContain("acme");
    expect(r.tlAcme).toBeGreaterThan(0);
    expect(r.curEnts).toContain("acme");
    // o fato nunca foi apagado/reescrito — só estava filtrado pela flag da página
    const after = (await sql`select count(*)::int c from galeed_facts where brain = ${BRAIN} and entity = 'acme'`)[0].c;
    expect(after).toBe(before);
  });
});
