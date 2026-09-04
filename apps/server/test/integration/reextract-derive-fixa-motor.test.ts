/** FIX-A/BUG 2 — reextractRun DERIVA: extractOne re-extrai (putExtraction+markExtracted) mas NÃO
 *  deriva (o derive é do CHAMADOR). reextractRun era o único chamador que esquecia → claims
 *  aprovados pelo gate paravam em galeed_extractions até um organize manual. O fix faz reextractRun
 *  chamar deriveIncremental(lote) — os fatos NASCEM sem organize. DB real :5434 + llm.ts mocado. */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { hasDb, wipeBrain, rawConnect } from "./helpers/db.ts";

// mock PARCIAL de llm.ts: structured devolve um claim NOVO ancorado; resolveExtractionProvider="api".
// vi.hoisted p/ a factory ter o fixture sem TDZ. mutável entre fases (base → re-extração).
const mock = vi.hoisted(() => ({
  out: {
    decisions: [
      { text: "preço definido em 5000", entity: "acme", predicate: "preco_mensal", value: "5000", value_num: 5000, context_quote: "o preço ficou em 5000 por mês", valid_from: "2026-01-01" },
    ],
  } as Record<string, any[]>,
}));
vi.mock("../../src/lib/llm.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/llm.ts")>();
  return {
    ...actual,
    structured: vi.fn(async () => mock.out),
    resolveExtractionProvider: vi.fn(() => "api" as const),
  };
});

import { getEngine, closeEngines, type SourceRow } from "../../src/core/platform/engine.ts";
import { extractOne } from "../../src/core/extraction/extract.ts";
import { deriveIncremental } from "../../src/core/retrieval/indexer.ts";
import { reextractRun } from "../../src/connectors/bff/bff-context-edit.ts";
import { saveBrainContext } from "../../src/core/extraction/brain-context.ts";

const BRAIN = "reextract-fixa-motor";
const SRC = "fonte-reextract-fixa-motor";
const SLUG = "pag-reextract-fixa-motor";
// body contém o quote E o número 5000 (groundedRegistro / valueIsAnchored) — claim vira 'fato'.
const BODY = "ata da call: o preço ficou em 5000 por mês, conforme combinado com a acme.";

const SOURCE: SourceRow = {
  id: SRC, name: "Fonte Reextract", channel: "upload", type: "nota",
  recipe: { fields: [{ dimension: "decisions", label: "Decisões", area: "" }], guidance: "" },
  default_sensitivity: "restrito", status: "ativa", last_read_at: null,
};

async function seedPage(slug: string, tags: string[], body = BODY) {
  const e = await getEngine(BRAIN);
  await e.upsertPage({
    slug, type: "nota", title: "reex", date: "2026-01-01", path: "", body,
    content_hash: `hash-${slug}`, tags,
  });
  return (await e.getPage(slug))!;
}

async function countFacts(): Promise<number> {
  const sql = await rawConnect();
  try {
    const r = (await sql.unsafe(`select count(*)::int c from galeed_facts where brain=$1`, [BRAIN])) as any[];
    return r[0].c;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function factValues(): Promise<Array<{ value: string; status: string; valid_from: string }>> {
  const sql = await rawConnect();
  try {
    return (await sql.unsafe(
      `select value, status, valid_from from galeed_facts where brain=$1 and predicate='preco_mensal' order by valid_from`,
      [BRAIN],
    )) as any[];
  } finally {
    await sql.end({ timeout: 5 });
  }
}

describe.skipIf(!hasDb())("FIX-A/BUG 2 — reextractRun deriva sem organize manual (DB real, LLM mocado)", () => {
  beforeAll(async () => {
    await wipeBrain(BRAIN);
    const e = await getEngine(BRAIN);
    await e.upsertSource(SOURCE);
  });
  afterAll(async () => {
    await wipeBrain(BRAIN);
    await closeEngines();
  });
  beforeEach(async () => {
    const e = await getEngine(BRAIN);
    await e.upsertSource({ ...SOURCE, status: "ativa" });
  });

  it("re-extração organiza os fatos: galeed_facts reflete o claim novo SEM organize manual", async () => {
    // 1. estado base: extractOne + deriveIncremental (N fatos)
    const page = await seedPage(SLUG, [`src:${SRC}`]);
    await extractOne(BRAIN, page);
    await deriveIncremental(BRAIN, [SLUG]);
    const baseValores = await factValues();
    expect(baseValores.length).toBeGreaterThanOrEqual(1);
    expect(baseValores.some((v) => v.value === "5000")).toBe(true);

    // 2. muda o contexto → contextVersion sobe → isFresh=false (página fica stale)
    await saveBrainContext(BRAIN, {
      self: { slug: "acme", label: "Acme", aliases: [] },
      purpose: "vendas atualizadas",
      roles: [],
      sourceTypes: [{ type: "nota", label: "Fonte", otherRole: "other" as const }],
    });

    // 3. o mock devolve um claim NOVO (preço supersede 5000 → 7000). reextractRun re-extrai E deriva.
    mock.out = {
      decisions: [
        { text: "preço subiu pra 7000", entity: "acme", predicate: "preco_mensal", value: "7000", value_num: 7000, context_quote: "o preço subiu pra 7000", valid_from: "2026-03-01" },
      ],
    };
    // body precisa conter o novo número/quote pra ancorar (S3) → re-seed o body da página.
    await seedPage(SLUG, [`src:${SRC}`], "ata da call 2: o preço subiu pra 7000 por mês, acme confirmou.");

    const r = await reextractRun(BRAIN);

    // 4. PROVA do BUG 2: derivou no mesmo passo; galeed_facts reflete o claim novo
    expect(r.reextracted).toBeGreaterThanOrEqual(1);
    expect(r.derivedFacts).toBeGreaterThan(0);
    expect(r.message).toMatch(/organizei os fatos/);
    const depois = await factValues();
    expect(depois.some((v) => v.value === "7000")).toBe(true);
    // supersessão: o 5000 (mesmo grupo, valor antigo) foi arquivado; o vigente é o 7000.
    const vigente = depois.find((v) => v.valid_to === undefined || v.status === "fato");
    const novo = depois.find((v) => v.value === "7000")!;
    expect(novo.status).toBe("fato");
    const antigo = depois.find((v) => v.value === "5000");
    if (antigo) expect(antigo.status).toBe("arquivado");
  });

  it("página com fonte pausada no lote → blocked=1 e slug FORA do derive", async () => {
    const e = await getEngine(BRAIN);
    // fonte pausada → página A bloqueia
    await e.upsertSource({ ...SOURCE, id: "fonte-pausada-reex", status: "pausada" });
    const factsBefore = await countFacts();
    await seedPage("pag-reex-pausada", ["src:fonte-pausada-reex"], "outra ata: algo aconteceu aqui.");
    // bumpa contexto p/ a página A ficar stale (re-extraível-candidata, mas bloqueada pela fonte)
    await saveBrainContext(BRAIN, {
      self: { slug: "acme", label: "Acme", aliases: [] },
      purpose: "vendas atualizadas v3",
      roles: [],
      sourceTypes: [{ type: "nota", label: "Fonte", otherRole: "other" as const }],
    });
    mock.out = { decisions: [{ text: "nada", entity: "x", predicate: "y", value: "z", context_quote: "algo aconteceu aqui" }] };
    const r = await reextractRun(BRAIN);
    expect(r.blocked).toBeGreaterThanOrEqual(1);
    // a página bloqueada não contribui fato novo (slug fora do derive); nenhum fato do grupo 'x y' nasce.
    const sql = await rawConnect();
    try {
      const bad = (await sql.unsafe(`select count(*)::int c from galeed_facts where brain=$1 and predicate='y'`, [BRAIN])) as any[];
      expect(bad[0].c).toBe(0);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });
});
