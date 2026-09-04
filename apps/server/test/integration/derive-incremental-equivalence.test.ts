/** GATE M14 §8.1 + §8.3 + §8.4 — EQUIVALÊNCIA byte-idêntica (incremental ≡ full), IDEMPOTÊNCIA,
 *  ISOLAMENTO e SEAM (mudança de mapa → full reconverge). A obrigação de CORREÇÃO: a derivação
 *  incremental é OTIMIZAÇÃO, nunca mudança de comportamento (ADR-008 (d)).
 *
 *  Caminho FULL:        buildIndex(C ∪ P)               → galeed_facts/galeed_edges
 *  Caminho INCREMENTAL: buildIndex(C); deriveIncremental(home,[P])  → galeed_facts/galeed_edges
 *  Assert: snapshot(full) deep-equal snapshot(incr) p/ FATOS e ARESTAS (ordenados deterministicamente).
 *
 *  Espelha test/integration/supersession-e2e.test.ts: skipIf(!hasDb()), wipeBrain, closeEngines,
 *  brains com prefixo descartável (__m14_*). Precisa de Postgres (docker compose up -d). */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { hasDb, wipeBrain } from "./helpers/db.ts";
import { getEngine, closeEngines, type PageRow, type ExtractionRow } from "../../src/core/platform/engine.ts";
import { buildIndex, deriveIncremental } from "../../src/core/retrieval/indexer.ts";

const PREFIX = "__m14_equiv";

/** Lê galeed_facts/galeed_edges CRUS da TABELA (SQL direto via (engine as any).sql) e devolve uma
 *  representação canônica ORDENADA p/ deep-equal. A LEI fala de galeed_facts/galeed_edges byte-idênticos,
 *  então lemos a TABELA (não os métodos públicos, que filtram/projetam). Inclui SÓ os campos que a
 *  equivalência exige (DESIGN-SPEC §2 / BRIEF §8.1):
 *    fato  → [entity,predicate,tier,value,value_num,valid_from,valid_to,confidence,status,source_slug]
 *    aresta→ [src,dst,kind,weight]
 *  A ordem de inserção pode diferir entre os caminhos — ordenamos por JSON.stringify(linha) antes de
 *  comparar; o CONJUNTO de linhas é o que deve ser idêntico. */
async function snapshot(brain: string): Promise<{ facts: unknown[]; edges: unknown[] }> {
  const e = await getEngine(brain);
  const sql = (e as any).sql;
  const factRows = (await sql`
    select entity, predicate, tier, value, value_num, valid_from, valid_to, confidence, status, source_slug
    from galeed_facts where brain = ${brain}
  `) as any[];
  const edgeRows = (await sql`
    select src, dst, kind, weight from galeed_edges where brain = ${brain}
  `) as any[];
  const facts = factRows
    .map((r) => [
      r.entity ?? "",
      r.predicate ?? "",
      r.tier ?? "",
      r.value ?? "",
      r.value_num == null ? null : Number(r.value_num),
      r.valid_from ?? "",
      r.valid_to ?? "",
      Number(r.confidence ?? 0),
      r.status ?? "",
      r.source_slug ?? "",
    ])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const edges = edgeRows
    .map((r) => [r.src ?? "", r.dst ?? "", r.kind ?? "", Number(r.weight ?? 0)])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return { facts, edges };
}

const page = (slug: string, date: string, body: string): PageRow => ({
  slug, type: "reunioes", title: slug, date, path: "", body, content_hash: slug,
});

/** extração com 1 triple ancorado (entity/predicate/value) — quote ANCORADO no body. */
const exTriple = (
  slug: string, date: string, entity: string, predicate: string, value: string, valueNum: number | null, quote: string,
): ExtractionRow => ({
  source_slug: slug, type: "reunioes", date, content_hash: slug, prompt_version: "test",
  extractions: { metricas: [{ entity, predicate, value, value_num: valueNum, unit: "BRL", period: "monthly", valid_from: date, context_quote: quote, text: `${predicate} ${value}` }] },
});

/** Semeia o CORPUS C (≥2 fontes, ≥1 grupo com supersessão) num brain. Cobre:
 *  - série de PREÇO (caso-canônico, §5): 3 fontes datadas, mesmo grupo, valores crescentes.
 *  - um grupo de OUTRA entidade (p/ provar ISOLAMENTO — não muda quando P toca só o grupo de preço).
 *  - um wikilink (p/ ter ARESTA no snapshot). */
async function seedCorpusC(brain: string): Promise<void> {
  const e = await getEngine(brain);
  // grupo de preço (acme · preco_mensal) — 3 pontos no tempo (3k→5k→12k na FORMA do caso real)
  await e.upsertPage(page("jan", "2026-01-10", "Acme fechou o plano em R$ 3000 por mês. Ver [[mar]]."));
  await e.upsertPage(page("mar", "2026-03-10", "Acme renegociou para R$ 5000 por mês."));
  await e.upsertPage(page("jun", "2026-06-10", "Acme subiu para R$ 12000 por mês."));
  await e.putExtraction(exTriple("jan", "2026-01-10", "acme", "preco_mensal", "3000", 3000, "plano em R$ 3000 por mês"));
  await e.putExtraction(exTriple("mar", "2026-03-10", "acme", "preco_mensal", "5000", 5000, "para R$ 5000 por mês"));
  await e.putExtraction(exTriple("jun", "2026-06-10", "acme", "preco_mensal", "12000", 12000, "para R$ 12000 por mês"));
  // grupo de OUTRA entidade — não deve mudar quando P toca só o grupo de preço (isolamento)
  await e.upsertPage(page("hc", "2026-02-01", "Globex reportou headcount de 50 pessoas."));
  await e.putExtraction({
    source_slug: "hc", type: "reunioes", date: "2026-02-01", content_hash: "hc", prompt_version: "test",
    extractions: { metricas: [{ entity: "globex", predicate: "headcount", value: "50", value_num: 50, unit: "people", valid_from: "2026-02-01", context_quote: "headcount de 50 pessoas", text: "headcount 50" }] },
  });
}

/** A página NOVA P: um 4º ponto na série de preço (R$ 18000) — supersede o vigente (12000). */
async function seedPageP(brain: string): Promise<void> {
  const e = await getEngine(brain);
  await e.upsertPage(page("set", "2026-09-10", "Acme subiu o plano para R$ 18000 por mês."));
  await e.putExtraction(exTriple("set", "2026-09-10", "acme", "preco_mensal", "18000", 18000, "para R$ 18000 por mês"));
}

describe.skipIf(!hasDb())("M14 — derivação incremental: equivalência byte-idêntica (incr ≡ full)", () => {
  const FULL = `${PREFIX}_full`;
  const INCR = `${PREFIX}_incr`;
  let full: { facts: unknown[]; edges: unknown[] };
  let incr: { facts: unknown[]; edges: unknown[] };

  beforeAll(async () => {
    await wipeBrain(FULL);
    await wipeBrain(INCR);
    // FULL: C ∪ P de uma vez, então buildIndex.
    await seedCorpusC(FULL);
    await seedPageP(FULL);
    await buildIndex(FULL);
    full = await snapshot(FULL);
    // INCREMENTAL: buildIndex(C), DEPOIS deriveIncremental(home,[P]).
    await seedCorpusC(INCR);
    await buildIndex(INCR);
    await seedPageP(INCR);
    await deriveIncremental(INCR, ["set"]);
    incr = await snapshot(INCR);
  });

  afterAll(async () => {
    await wipeBrain(FULL);
    await wipeBrain(INCR);
    await closeEngines();
  });

  it("galeed_facts são byte-idênticos entre full e incremental", () => {
    expect(incr.facts).toEqual(full.facts);
  });

  it("galeed_edges são byte-idênticas entre full e incremental", () => {
    expect(incr.edges).toEqual(full.edges);
  });

  it("a série de preço supersede igual nos dois caminhos: 1 vigente (18000) + 3 arquivados com valid_to", async () => {
    for (const brain of [FULL, INCR]) {
      const e = await getEngine(brain);
      const tl = await e.timeline("acme", { predicate: "preco_mensal" });
      const vigente = tl.filter((f) => f.valid_to === "");
      expect(vigente).toHaveLength(1);
      expect(vigente[0].value).toBe("18000");
      // os 3 anteriores arquivados, janelas fechadas na data do sucessor
      const v3000 = tl.find((f) => f.value === "3000")!;
      expect(v3000.status).toBe("arquivado");
      expect(v3000.valid_to).toBe("2026-03-10");
      const v12000 = tl.find((f) => f.value === "12000")!;
      expect(v12000.status).toBe("arquivado");
      expect(v12000.valid_to).toBe("2026-09-10"); // fechado pela data de P
    }
  });

  it("IDEMPOTÊNCIA: re-rodar deriveIncremental(home,[P]) 2× não muda o estado", async () => {
    const before = await snapshot(INCR);
    await deriveIncremental(INCR, ["set"]);
    await deriveIncremental(INCR, ["set"]);
    const after = await snapshot(INCR);
    expect(after.facts).toEqual(before.facts);
    expect(after.edges).toEqual(before.edges);
  });

  it("ISOLAMENTO: o grupo NÃO tocado por P (globex·headcount) fica idêntico ao full", async () => {
    const e = await getEngine(INCR);
    const tl = await e.timeline("globex", { predicate: "headcount" });
    const vigente = tl.filter((f) => f.valid_to === "");
    expect(vigente).toHaveLength(1);
    expect(vigente[0].value).toBe("50");
  });
});

describe.skipIf(!hasDb())("M14 — SEAM: mudança de entityMap → full rebuild reconverge", () => {
  const BRAIN = `${PREFIX}_seam`;

  beforeAll(async () => {
    await wipeBrain(BRAIN);
  });
  afterAll(async () => {
    await wipeBrain(BRAIN);
    await closeEngines();
  });

  it("um alias resolvido por entityMap funde duas cadeias num só grupo no full rebuild", async () => {
    const e = await getEngine(BRAIN);
    // 'acme' e o alias 'acme corp' falam do MESMO preço em datas distintas, mas como entidades
    // distintas → 2 grupos separados, 2 vigentes.
    await e.upsertPage(page("a1", "2026-01-10", "Acme fechou o plano em R$ 3000 por mês."));
    await e.upsertPage(page("a2", "2026-05-10", "Acme corp renegociou para R$ 9000 por mês."));
    await e.putExtraction(exTriple("a1", "2026-01-10", "acme", "preco_mensal", "3000", 3000, "plano em R$ 3000 por mês"));
    await e.putExtraction(exTriple("a2", "2026-05-10", "acme corp", "preco_mensal", "9000", 9000, "para R$ 9000 por mês"));
    await buildIndex(BRAIN);

    // antes do mapa: 2 grupos distintos (acme, acme corp), cada um com seu vigente.
    const distinctBefore = new Set(
      (await (e as any).sql`select distinct entity from galeed_facts where brain = ${BRAIN} and entity <> ''`).map((r: any) => r.entity),
    );
    expect(distinctBefore.has("acme")).toBe(true);
    expect(distinctBefore.has("acme corp")).toBe(true);

    // muda o entityMap (alias→canônico) e roda o FULL rebuild — o seam (ADR-008 (c)): mudança de mapa
    // é caminho de consolidação (buildIndex), não write-path incremental.
    await e.putEntityResolve({ "acme corp": "acme" });
    await buildIndex(BRAIN);

    // depois: tudo canonicaliza p/ 'acme' → 1 grupo, 1 vigente (o mais recente: 9000), 3000 arquivado.
    const distinctAfter = new Set(
      (await (e as any).sql`select distinct entity from galeed_facts where brain = ${BRAIN} and entity <> ''`).map((r: any) => r.entity),
    );
    expect(distinctAfter.has("acme corp")).toBe(false);
    expect([...distinctAfter]).toEqual(["acme"]);
    const tl = await e.timeline("acme", { predicate: "preco_mensal" });
    const vigente = tl.filter((f) => f.valid_to === "");
    expect(vigente).toHaveLength(1);
    expect(vigente[0].value).toBe("9000");
    const v3000 = tl.find((f) => f.value === "3000")!;
    expect(v3000.status).toBe("arquivado");
    expect(v3000.valid_to).toBe("2026-05-10");
  });
});
