/** GATE M16/S8 (HOTFIX do M14) — ESCALA do `groupKeyMatch` / `factsInGroups`.
 *
 *  O bug: `PostgresEngine.groupKeyMatch` juntava os grupos `(entity,predicate,tier)` com um OR-reduce
 *  que ANINHAVA fragmentos (`sql\`${acc} or ${t}\``). O driver `postgres` serializa esse aninhamento
 *  RECURSIVAMENTE (stringify -> fragment -> stringify por nível, types.js) -> com milhares de grupos a
 *  profundidade da recursão excede a pilha do V8 -> `RangeError: Maximum call stack size exceeded`
 *  (stack disparado por `factsInGroups`). Aparecia no harvest do lote (M16): uma `deriveIncremental`
 *  sobre 107 slugs materializa G com centenas de grupos -> factsInGroups(G) -> crash; o pollOne caía no
 *  catch e re-tentava a cada 12s, eternamente (facts=0, job preso em batch_harvesting).
 *
 *  O fix (postgres.ts `groupKeyMatch`): UM `= any($text[])` sobre a chave composta concatenada
 *  (SEP = US 0x1F) -> UM fragmento, UM parâmetro array -> profundidade de serialização CONSTANTE,
 *  independente de N. Semântica IDÊNTICA (coalesce('') preservado, bijetivo com a tripla).
 *
 *  Este gate prova:
 *   1. NÃO-RECURSÃO: factsInGroups com um número ENORME de grupos (50k >> qualquer pilha razoável) NÃO
 *      estoura a pilha. Sem o fix, isto CRASHA em qualquer máquina (a serialização recursa por grupo).
 *      É o teste que prova o fix de forma determinística (independe do tamanho da pilha da máquina).
 *   2. VERDADE em escala: factsInGroups(>=500 grupos semeados) devolve EXATAMENTE as linhas semeadas.
 *   3. EQUIVALÊNCIA: conjunto pequeno -> casa só os grupos pedidos, inclusive grupos com tier/predicate
 *      VAZIOS (o caminho coalesce('')) e NÃO casa grupos não-pedidos. Mesma semântica do código antigo.
 *   4. deriveIncremental(home, <muitos slugs>) roda sem crash e gera facts>0 (o caminho real do harvest:
 *      G com centenas de grupos -> factsInGroups(G)).
 *
 *  Espelha os outros testes de integração: skipIf(!hasDb()), wipeBrain, closeEngines, brain descartável
 *  com prefixo dedicado (__test_m16_s8 — NUNCA toca Accelera). Precisa de Postgres (docker compose up -d). */
import { describe, it, expect, afterAll } from "vitest";
import { hasDb, wipeBrain } from "./helpers/db.ts";
import { getEngine, closeEngines, type FactRow, type FactGroupKey, type PageRow, type ExtractionRow } from "../../src/core/platform/engine.ts";
import { deriveIncremental } from "../../src/core/retrieval/indexer.ts";

const PREFIX = "__test_m16_s8";

/** Um FactRow ancorado, vigente, no formato final de galeed_facts — derivado só do par (entity,predicate)
 *  e do índice (determinístico). Tier vazio por padrão (o caminho coalesce('')). */
function seedFact(entity: string, predicate: string, idx: number, tier = ""): FactRow {
  return {
    source_slug: `src_${idx}`,
    type: "synthetic",
    dimension: "metricas",
    idx,
    text: `fato ${entity} ${predicate} ${idx}`,
    quote: "",
    meta: null,
    entity,
    predicate,
    value: String(idx),
    value_num: idx,
    unit: "un",
    period: "",
    tier,
    valid_from: "2020-01-01",
    valid_to: "",
    confidence: 0.6,
    status: "fato",
  };
}

/** Chave canônica (entity|predicate|tier) p/ comparar conjuntos sem depender de ordem. */
function keyOf(f: { entity: string | null; predicate: string | null; tier: string | null }): string {
  return `${f.entity ?? ""}${f.predicate ?? ""}${f.tier ?? ""}`;
}

describe.skipIf(!hasDb())("M16/S8 — groupKeyMatch escala (nao recursa) e mantem a semantica", () => {
  afterAll(async () => {
    await wipeBrain(`${PREFIX}_scale`);
    await wipeBrain(`${PREFIX}_equiv`);
    await wipeBrain(`${PREFIX}_derive`);
    await closeEngines();
  });

  it("NAO-RECURSAO: factsInGroups com 50.000 grupos NAO estoura a pilha (o OR-reduce antigo CRASHA)", async () => {
    // ESTE e o teste que prova o fix. O groupKeyMatch antigo juntava as keys com um OR-reduce que
    // ANINHAVA fragmentos; o driver `postgres` serializa recursivamente (stringify->fragment->stringify
    // por nivel) -> com alguns milhares de grupos a profundidade da recursao excede a pilha do V8 ->
    // RangeError: Maximum call stack size exceeded. O fix (UM `= any($text[])`) e UM fragmento, UM
    // parametro array -> profundidade de serializacao CONSTANTE, independente de N. 50k >> qualquer
    // pilha razoavel: o codigo antigo crasha aqui em QUALQUER maquina; o novo roda em ~100ms.
    // Nao precisa semear: o ponto e a SERIALIZACAO da query (onde a recursao acontece), nao as linhas.
    const brain = `${PREFIX}_scale`;
    await wipeBrain(brain);
    const e = await getEngine(brain);

    const HUGE = 50000;
    const keys: FactGroupKey[] = [];
    for (let i = 0; i < HUGE; i++) keys.push({ entity: `z${i}`, predicate: "q", tier: "" });

    // Sem o fix: lanca RangeError na serializacao. Com o fix: resolve normalmente (0 linhas — esses
    // grupos nao foram semeados; o que importa e NAO crashar).
    const rows = await e.factsInGroups(keys);
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBe(0);
  }, 60000);

  it("VERDADE em escala: factsInGroups(>=500 grupos semeados) devolve EXATAMENTE as linhas semeadas", async () => {
    const brain = `${PREFIX}_scale`;
    await wipeBrain(brain);
    const e = await getEngine(brain);

    // Semeia 600 grupos (entity,predicate,tier) DISTINTOS: 600 entidades x 1 predicado, 1 fato cada
    // (>500, o limiar do aceite). Le por factsInGroups(600 keys) e compara com a verdade semeada.
    const N = 600;
    const seeded: FactRow[] = [];
    for (let i = 0; i < N; i++) seeded.push(seedFact(`e${i}`, "p", i));
    for (let i = 0; i < seeded.length; i += 500) await e.putFacts(seeded.slice(i, i + 500));

    const keys: FactGroupKey[] = [];
    for (let i = 0; i < N; i++) keys.push({ entity: `e${i}`, predicate: "p", tier: "" });

    // Devolve as 600 linhas — exatamente os grupos pedidos (conjunto identico, sem ruido nem perda).
    const rows = await e.factsInGroups(keys);
    expect(rows.length).toBe(N);
    const got = new Set(rows.map(keyOf));
    expect(got.size).toBe(N);
    for (let i = 0; i < N; i++) expect(got.has(keyOf({ entity: `e${i}`, predicate: "p", tier: "" }))).toBe(true);
  }, 60000);

  it("EQUIVALENCIA: conjunto pequeno — casa so os grupos pedidos, incl. tier/predicate vazios (coalesce)", async () => {
    const brain = `${PREFIX}_equiv`;
    await wipeBrain(brain);
    const e = await getEngine(brain);

    // Semeia grupos VARIADOS, incl. casos de borda do coalesce('') (predicate vazio, tier vazio/preenchido).
    const facts: FactRow[] = [
      seedFact("alpha", "preco", 1, ""), // tier vazio
      seedFact("alpha", "preco", 2, "enterprise"), // mesmo (entity,predicate), tier diferente -> grupo distinto
      seedFact("beta", "headcount", 3, ""),
      seedFact("gamma", "", 4, ""), // predicate VAZIO -> coalesce('') tem que casar standalone
      seedFact("delta", "naoPedido", 5, ""), // NAO esta nas keys -> nao pode aparecer
    ];
    await e.putFacts(facts);

    const keys: FactGroupKey[] = [
      { entity: "alpha", predicate: "preco", tier: "" },
      { entity: "alpha", predicate: "preco", tier: "enterprise" },
      { entity: "beta", predicate: "headcount", tier: "" },
      { entity: "gamma", predicate: "", tier: "" }, // exercita o coalesce('') no predicate vazio
    ];

    const rows = await e.factsInGroups(keys);
    const got = new Set(rows.map(keyOf));

    // casou EXATAMENTE os 4 grupos pedidos…
    expect(got).toEqual(
      new Set([
        keyOf({ entity: "alpha", predicate: "preco", tier: "" }),
        keyOf({ entity: "alpha", predicate: "preco", tier: "enterprise" }),
        keyOf({ entity: "beta", predicate: "headcount", tier: "" }),
        keyOf({ entity: "gamma", predicate: "", tier: "" }),
      ]),
    );
    // …e NAO trouxe o grupo nao-pedido (delta/naoPedido), nem inchou.
    expect(rows.length).toBe(4);
    expect(rows.some((r) => r.entity === "delta")).toBe(false);
  }, 60000);

  it("deriveIncremental(home, <muitos slugs>) — caminho do harvest do lote: sem crash, facts>0", async () => {
    const brain = `${PREFIX}_derive`;
    await wipeBrain(brain);
    const e = await getEngine(brain);

    // Semeia M paginas + extracoes, cada uma com SEU proprio grupo (entity,predicate) -> deriveIncremental
    // materializa G com M grupos distintos e chama factsInGroups(G) (o ponto exato do crash no harvest).
    const M = 200; // centenas de grupos no caminho real do harvest do lote.
    const slugs: string[] = [];
    for (let i = 0; i < M; i++) {
      const slug = `doc_${i}`;
      slugs.push(slug);
      const ent = `ent${i}`;
      const date = "2030-06-01";
      const body = `${ent} fechou o preco_mensal em ${1000 + i} por mes.`;
      const page: PageRow = { slug, type: "reunioes", title: slug, date, path: "", body, content_hash: slug };
      const ex: ExtractionRow = {
        source_slug: slug,
        type: "reunioes",
        date,
        content_hash: slug,
        prompt_version: "test",
        extractions: {
          metricas: [
            {
              entity: ent,
              predicate: "preco_mensal",
              value: String(1000 + i),
              value_num: 1000 + i,
              unit: "BRL",
              period: "monthly",
              valid_from: date,
              context_quote: `preco_mensal em ${1000 + i} por mes`,
              text: `preco_mensal ${1000 + i}`,
            },
          ],
        },
      };
      await e.upsertPage(page);
      await e.putExtraction(ex);
    }

    // O caminho do harvest do lote: UMA deriveIncremental sobre TODOS os slugs -> G com M grupos ->
    // factsInGroups(G). Sem o fix, CRASHA aqui (RangeError). Com o fix, roda e grava os fatos.
    const result = await deriveIncremental(brain, slugs);
    expect(result.facts).toBeGreaterThan(0);
    expect(result.groups).toBe(M);

    // sanidade: os fatos foram realmente persistidos e sao lidos de volta pelos grupos (mesmo match).
    const keys: FactGroupKey[] = [];
    for (let i = 0; i < M; i++) keys.push({ entity: `ent${i}`, predicate: "preco_mensal", tier: "" });
    const rows = await e.factsInGroups(keys);
    expect(rows.length).toBe(M);
  }, 120000);
});
