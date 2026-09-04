/** M24-B/§5.D — fila + aprovar→aresta (DB real :5434). Moldes: fila-m23b-autocontencao +
 *  p1c-contrato-aprovacao. Brain itest-m24b-sonho. Seed por putFacts (entityGraph lê galeed_facts):
 *  dois grupos onde co-ocorrência pareia entidades NÃO-adjacentes:
 *   - ana/beto compartilham {m1,m2} (cada um co-ocorre com m1,m2 em ≥2 fontes; ana e beto NUNCA
 *     juntos; m1 e m2 são DIRETAMENTE ligados ⇒ excluídos como par) → par elegível (ana,beto);
 *   - x1/x2 compartilham {n1,n2} → par elegível (x1,x2).
 *  LEI III: aprovar cria ARESTA no entityGraph, NUNCA fato. NOOP / re-sono / descartar provados. */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { hasDb, wipeBrain, rawConnect } from "./helpers/db.ts";
import { getEngine, closeEngines, type FactRow } from "../../src/core/platform/engine.ts";
import { dreamV2 } from "../../src/core/memory/dream-v2.ts";
import { approveReviewItem, discardReviewItem } from "../../src/core/ingestion/golden-rule.ts";

const BRAIN = "itest-m24b-sonho";
const VF = "2026-01-01";

// 1 fato (standalone, sem supersessão) — entity na coluna canônica; cada página tem várias entidades.
function fact(slug: string, entity: string, predicate: string, idx: number): FactRow {
  return {
    source_slug: slug, type: "nota", dimension: "decisions", idx,
    text: `${entity} em ${slug}`, quote: "", meta: {},
    entity, predicate, value: `v-${slug}-${entity}-${predicate}`, value_num: null,
    unit: "", period: "", tier: "", valid_from: VF, valid_to: "",
    confidence: 0.8, status: "fato",
  };
}

// Em cada página, todas as entidades co-ocorrem (mesmo source_slug). Cada par junto em 2 páginas.
// Cada entidade aparece em 2 páginas × 2 predicados = 4 fatos ⇒ acima de minFacts (3) do entityGraph.
const PAGES: Record<string, string[]> = {
  "p1": ["ana", "m1", "m2"], "p2": ["ana", "m1", "m2"], // ana–m1, ana–m2, m1–m2 (×2)
  "p3": ["beto", "m1", "m2"], "p4": ["beto", "m1", "m2"], // beto–m1, beto–m2, m1–m2 (×2)
  "p5": ["x1", "n1", "n2"], "p6": ["x1", "n1", "n2"],
  "p7": ["x2", "n1", "n2"], "p8": ["x2", "n1", "n2"],
};
const PREDS = ["mencao", "papel"]; // 2 fatos por (entidade,página) → ≥3 fatos/entidade

function seed(): FactRow[] {
  const rows: FactRow[] = [];
  for (const [slug, ents] of Object.entries(PAGES)) {
    let idx = 0;
    for (const e of ents) for (const p of PREDS) rows.push(fact(slug, e, p, idx++));
  }
  return rows;
}

const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
const hasEdge = (edges: { src: string; dst: string; kind: string; weight?: number }[], a: string, b: string, kind: string) =>
  edges.find((ed) => kind === ed.kind && pairKey(ed.src, ed.dst) === pairKey(a, b));

describe.skipIf(!hasDb())("M24-B fila + aresta (§5.D)", () => {
  beforeAll(async () => {
    await wipeBrain(BRAIN);
    const e = await getEngine(BRAIN);
    await e.putFacts(seed());
  });
  afterAll(async () => {
    await wipeBrain(BRAIN);
    await closeEngines();
  });

  it("1. sonho → fila (gate §6.4-parte): par (ana,beto) vira item conexao_sugerida pendente", async () => {
    const r = await dreamV2(BRAIN);
    expect(r.enqueued).toBeGreaterThanOrEqual(1);
    const e = await getEngine(BRAIN);
    const pend = await e.listReview({ status: "pendente", limit: 100 });
    const mine = pend.filter((p) => p.reason === "conexao_sugerida");
    const anaBeto = mine.find((p) => p.claim?.a && pairKey(p.claim.a, p.claim.b) === pairKey("ana", "beto"));
    expect(anaBeto).toBeTruthy();
    expect(anaBeto!.status).toBe("pendente");
    const shared: string[] = anaBeto!.claim.shared;
    expect(shared).toEqual(expect.arrayContaining(["m1", "m2"]));
    expect(anaBeto!.dimension).toBe("conexao");
    expect(anaBeto!.source_id).toBe("");
  });

  it("2. dedup de re-sono: mesmos ids → contagem de pendentes estável", async () => {
    const e = await getEngine(BRAIN);
    const before = await e.listReview({ status: "pendente", limit: 100 });
    const beforeMine = before.filter((p) => p.reason === "conexao_sugerida").length;
    const beforeCounts = await e.reviewCounts();
    await dreamV2(BRAIN);
    const after = await e.listReview({ status: "pendente", limit: 100 });
    const afterMine = after.filter((p) => p.reason === "conexao_sugerida").length;
    expect(afterMine).toBe(beforeMine);
    const afterCounts = await e.reviewCounts();
    expect(afterCounts.pendente).toBe(beforeCounts.pendente);
  });

  it("3. aprovar → ARESTA, NUNCA fato (LEI III)", async () => {
    const e = await getEngine(BRAIN);
    const pend = await e.listReview({ status: "pendente", limit: 100 });
    const anaBeto = pend.find((p) => p.reason === "conexao_sugerida" && p.claim?.a && pairKey(p.claim.a, p.claim.b) === pairKey("ana", "beto"))!;
    const factsBefore = (await e.currentFacts()).length;

    await approveReviewItem(BRAIN, anaBeto.id, "itest@galeed");

    const item = await e.getReviewItem(anaBeto.id);
    expect(item!.status).toBe("aprovada");
    const g = await e.entityGraph();
    const edge = hasEdge(g.edges, "ana", "beto", "conexao");
    expect(edge).toBeTruthy();
    expect(edge!.weight).toBe(2);
    // LEI III: nenhum fato novo, nenhuma extração criada
    expect((await e.currentFacts()).length).toBe(factsBefore);
    expect(await e.getExtraction("")).toBeUndefined();
  });

  it("4. re-sono pós-decisão não ressuscita: item segue aprovada, sem duplicar", async () => {
    const e = await getEngine(BRAIN);
    const pendBefore = await e.listReview({ status: "pendente", limit: 100 });
    const anaBetoId = pendBefore.find((p) => p.reason === "conexao_sugerida" && p.claim?.a && pairKey(p.claim.a, p.claim.b) === pairKey("ana", "beto"))?.id;
    expect(anaBetoId).toBeUndefined(); // já saiu de pendente (aprovada no teste 3)
    await dreamV2(BRAIN);
    // o item aprovado permanece aprovado (id determinístico → on conflict do nothing)
    const aprovadas = await e.listReview({ status: "aprovada", limit: 100 });
    const anaBeto = aprovadas.find((p) => p.reason === "conexao_sugerida" && p.claim?.a && pairKey(p.claim.a, p.claim.b) === pairKey("ana", "beto"));
    expect(anaBeto).toBeTruthy();
    expect(anaBeto!.status).toBe("aprovada");
  });

  it("5. descartar registrado: linha íntegra, sem aresta (invariante #5)", async () => {
    const e = await getEngine(BRAIN);
    const pend = await e.listReview({ status: "pendente", limit: 100 });
    const x1x2 = pend.find((p) => p.reason === "conexao_sugerida" && p.claim?.a && pairKey(p.claim.a, p.claim.b) === pairKey("x1", "x2"))!;
    expect(x1x2).toBeTruthy();
    await discardReviewItem(BRAIN, x1x2.id, "itest@galeed");
    const item = await e.getReviewItem(x1x2.id);
    expect(item).toBeTruthy();
    expect(item!.status).toBe("descartada");
    const g = await e.entityGraph();
    expect(hasEdge(g.edges, "x1", "x2", "conexao")).toBeUndefined();
  });

  it("6. custo zero de LLM (LEI I/V): galeed_llm_usage do brain === 0", async () => {
    const sql = await rawConnect();
    try {
      const rows = (await sql`select count(*)::int c from galeed_llm_usage where brain = ${BRAIN}`) as any[];
      expect(Number(rows[0]?.c ?? 0)).toBe(0);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });
});
