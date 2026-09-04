/** GATE M14 §8.2 — ESCALA FLAT (o invariante ECONÔMICO: custo por documento O(1) no tamanho do
 *  corpus N). Semeia K∈{1k,10k,100k} fatos sintéticos, ingere UMA página FIXA via deriveIncremental,
 *  e mede a métrica DETERMINÍSTICA combinada pelo Arquiteto:
 *    - LINHAS ESCRITAS  = result.facts (+ result.edges) do retorno de deriveIncremental (= linhas
 *      reescritas do lote pela escrita dirigida).
 *    - PICO de FactRow materializado = factsInGroups(G).length (lidas) + derivePageFacts(P).length (lote).
 *  Assert: FLAT em K (não cresce com N) e dentro dos bounds (linhas ≤ 2.000, pico ≤ 5.000 — BRIEF §5).
 *  Se virar O(N) (facts(10k) ≈ 10×facts(1k)) → FALHA o gate.
 *
 *  Por que LINHAS TOCADAS e não wall-clock/heap? A LEI é sobre COMPLEXIDADE; linhas tocadas é o proxy
 *  DETERMINÍSTICO e fiel disso (DESIGN-SPEC §3). Wall-clock é ruidoso (CI/DB) → só log informativo.
 *
 *  K=100k é OPT-IN por env M14_SCALE_100K=1 (lento p/ semear no CI). 1k+10k SEMPRE rodam e já provam
 *  a tendência flat (decisão do Arquiteto/fundador — BRIEF §10c). Precisa de Postgres. */
import { describe, it, expect, afterAll } from "vitest";
import { hasDb, wipeBrain } from "./helpers/db.ts";
import { getEngine, closeEngines } from "../../src/core/platform/engine.ts";
import { deriveIncremental, derivePageFacts } from "../../src/core/retrieval/indexer.ts";
import { syntheticFacts, fixedPageP, P_GROUPS } from "./helpers/synthetic-corpus.ts";

const PREFIX = "__m14_scale";
const KS = process.env.M14_SCALE_100K ? [1000, 10000, 100000] : [1000, 10000];

// bounds do orçamento (BRIEF §5)
const MAX_ROWS_WRITTEN = 2000;
const MAX_FACTROW_PEAK = 5000;
// epsilon p/ "flat": |Δ| entre Ks abaixo disto = não escala com K. Os grupos de P são CONSTANTES,
// então o esperado é Δ≈0; margem pequena p/ robustez.
const EPSILON = 50;

interface Measure {
  k: number;
  rowsWritten: number;   // result.facts (linhas reescritas pelo lote)
  edgesWritten: number;
  factRowPeak: number;   // lidas (factsInGroups(G)) + lote (derivePageFacts(P))
}

/** Semeia K fatos + ingere a página fixa P, devolvendo as métricas determinísticas do write incremental. */
async function measureAt(k: number): Promise<Measure> {
  const brain = `${PREFIX}_${k}`;
  await wipeBrain(brain);
  const e = await getEngine(brain);

  // 1) semeia o ESTADO: K fatos sintéticos (o "corpus já derivado" de tamanho N). Direto via putFacts
  //    (não pelo pipeline — semear K=100k por extração seria proibitivo; medimos o write incremental
  //    SOBRE um estado de tamanho N).
  const seeded = syntheticFacts(k);
  for (let i = 0; i < seeded.length; i += 5000) {
    await e.putFacts(seeded.slice(i, i + 5000));
  }

  // 2) a página NOVA P (pages + extractions) — toca um conjunto PEQUENO e CONSTANTE de grupos.
  const { pages, extractions } = fixedPageP();
  for (const p of pages) await e.upsertPage(p);
  for (const x of extractions) await e.putExtraction(x);

  // 3) PICO de FactRow materializado = lidas (cadeias dos grupos de P, de outras fontes) + lote (raw de P).
  //    Mede ANTES da ingestão pra capturar o que deriveIncremental materializa (factsInGroups(G)+raw(P)).
  const reconcileMap = await e.getReconcile();
  const entityMap = await e.getEntityResolve();
  const rawP = derivePageFacts(pages, extractions, { reconcileMap, entityMap });
  const readChains = await e.factsInGroups(P_GROUPS);
  const factRowPeak = readChains.length + rawP.length;

  // 4) ingere P pelo write-path incremental — o retorno = linhas reescritas do lote.
  const slugs = pages.map((p) => p.slug);
  const result = await deriveIncremental(brain, slugs);

  return { k, rowsWritten: result.facts, edgesWritten: result.edges, factRowPeak };
}

describe.skipIf(!hasDb())("M14 — escala FLAT (custo de ingestão O(1) no tamanho do corpus)", () => {
  const measures: Measure[] = [];

  afterAll(async () => {
    for (const k of KS) await wipeBrain(`${PREFIX}_${k}`);
    await closeEngines();
  });

  for (const k of KS) {
    it(`K=${k}: linhas escritas ≤ ${MAX_ROWS_WRITTEN} e pico FactRow ≤ ${MAX_FACTROW_PEAK} (flat, não O(N))`, async () => {
      const m = await measureAt(k);
      measures.push(m);
      // eslint-disable-next-line no-console
      console.log(
        `[escala] K=${k}: linhas_escritas=${m.rowsWritten} arestas=${m.edgesWritten} pico_FactRow=${m.factRowPeak}`,
      );
      // bounds do orçamento (BRIEF §5): NÃO crescem com K.
      expect(m.rowsWritten).toBeLessThanOrEqual(MAX_ROWS_WRITTEN);
      expect(m.edgesWritten).toBeLessThanOrEqual(MAX_ROWS_WRITTEN);
      expect(m.factRowPeak).toBeLessThanOrEqual(MAX_FACTROW_PEAK);
    });
  }

  it("FLAT: linhas escritas e pico NÃO crescem com K (|Δ| < ε entre o menor e o maior K)", () => {
    expect(measures.length).toBe(KS.length);
    const sorted = [...measures].sort((a, b) => a.k - b.k);
    const lo = sorted[0];
    const hi = sorted[sorted.length - 1];
    // O assert central da LEI: a diferença entre K=1k e o maior K é pequena (não escala com N).
    expect(Math.abs(hi.rowsWritten - lo.rowsWritten)).toBeLessThan(EPSILON);
    expect(Math.abs(hi.factRowPeak - lo.factRowPeak)).toBeLessThan(EPSILON);
    // E NÃO é O(N): se fosse, hi ≈ (hi.k/lo.k) × lo. Garante que estamos LONGE disso.
    const ratio = hi.k / lo.k; // ex.: 10 (10k/1k) ou 100 (100k/1k)
    expect(hi.rowsWritten).toBeLessThan(lo.rowsWritten * ratio * 0.5 + EPSILON);
    // eslint-disable-next-line no-console
    console.log(
      `[escala] FLAT provado: linhas K=${lo.k}→${lo.rowsWritten}, K=${hi.k}→${hi.rowsWritten} ` +
        `(Δ=${Math.abs(hi.rowsWritten - lo.rowsWritten)}); pico ${lo.factRowPeak}→${hi.factRowPeak}. ` +
        `O(N) teria dado ~${lo.rowsWritten * ratio} em K=${hi.k}.`,
    );
  });
});
