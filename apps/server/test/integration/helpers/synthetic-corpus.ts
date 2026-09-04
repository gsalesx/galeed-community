/** GERADOR DETERMINÍSTICO de corpus sintético p/ o budget-gate do M14 (S4).
 *
 *  Invariante #9 (EMPRESA.md): nada "pronto" sem input REAL — aqui o input é SINTÉTICO
 *  DETERMINÍSTICO (mesmo K → mesmo array, deep-equal em runs repetidos; sem `Math.random`
 *  não-semeado). Tenant-neutro (ADR-002): entidades `e<i>`, predicados `p<j>`, valores
 *  derivados do índice — zero domínio.
 *
 *  Dois produtos:
 *   - `syntheticFacts(k)`  → K FactRow[] prontos p/ `engine.putFacts` (semeia o ESTADO do brain:
 *                            o "corpus já derivado" de tamanho N). NÃO passa pelo pipeline (semear
 *                            K=100k por extração seria proibitivo — semeamos o estado, que é o que
 *                            importa pra MEDIR o custo do write incremental sobre N).
 *   - `fixedPageP()`       → a "página nova" FIXA (pages + extractions) que o gate ingere via
 *                            `deriveIncremental`. Toca um conjunto PEQUENO e CONSTANTE de grupos
 *                            (independente de K) — entidades dedicadas `pe<i>` que NÃO colidem com
 *                            as `e<i>` semeadas, p/ que o custo de ingestão seja flat em N. */
import type { PageRow, ExtractionRow, FactRow } from "../../../src/core/platform/engine.ts";

/** densidade real do Accelera: ~127 fatos por "fonte" (107 págs / 13.614 fatos). */
const FACTS_PER_SOURCE = 127;

/** Quantos grupos (entity,predicate,tier) distintos as K linhas semeadas cobrem. Mantém os grupos
 *  VARIADOS (entidades e0..e<n>) p/ que o estado pareça um corpus real espalhado — e p/ garantir que
 *  os grupos que P toca (pe<i>) NÃO estão entre eles (custo de ingestão independe de K). */
function seededEntity(i: number): string {
  // ~16 fatos por entidade → muitos grupos distintos, série temporal curta por grupo.
  return `e${Math.floor(i / 16)}`;
}

/** Gera K fatos sintéticos DETERMINÍSTICOS. Cada fato é um triple ancorado já no formato final de
 *  galeed_facts (status "fato", vigente). Derivado SÓ do índice `i` — reprodutível bit-a-bit. */
export function syntheticFacts(k: number): FactRow[] {
  const out: FactRow[] = [];
  for (let i = 0; i < k; i++) {
    const source = `s${Math.floor(i / FACTS_PER_SOURCE)}`; // ~127 fatos por fonte (densidade Accelera)
    const entity = seededEntity(i); // ~16 fatos por entidade → vários grupos
    const predicate = `p${i % 4}`; // 4 predicados por entidade
    const valueNum = i % 1000; // derivado do índice (sem aleatoriedade)
    out.push({
      source_slug: source,
      type: "synthetic",
      dimension: "metricas",
      idx: i,
      text: `fato sintetico ${i}`,
      quote: "",
      meta: null,
      entity,
      predicate,
      value: String(valueNum),
      value_num: valueNum,
      unit: "un",
      period: "",
      tier: "",
      // datas estáveis derivadas do índice — não colidem com a data de P (2030-*).
      valid_from: `2020-01-${String((i % 27) + 1).padStart(2, "0")}`,
      valid_to: "", // vigente
      confidence: 0.6,
      status: "fato",
    });
  }
  return out;
}

/** Os grupos (entity,predicate,tier) que `fixedPageP` toca — CONSTANTE, independente de K.
 *  Exposto p/ o teste de escala medir `factsInGroups(P_GROUPS)` (linhas LIDAS) sem reconstruir. */
export const P_GROUPS = [
  { entity: "pe0", predicate: "preco_mensal", tier: "" },
  { entity: "pe1", predicate: "headcount", tier: "" },
  { entity: "pe2", predicate: "preco_mensal", tier: "enterprise" },
];

/** A página P FIXA do gate: 1 página + 1 extração que toca um conjunto PEQUENO e CONSTANTE de grupos
 *  (as entidades `pe0..pe2`, dedicadas — NÃO colidem com as `e<i>` semeadas). É o "documento novo"
 *  cujo custo de ingestão medimos. Quotes ANCORADOS no body (R4) p/ status "fato". */
export function fixedPageP(): { pages: PageRow[]; extractions: ExtractionRow[] } {
  const slug = "__p_fixed";
  const date = "2030-06-01";
  const body = [
    "pe0 fechou o preco_mensal em 4200 por mes.",
    "pe1 informou o headcount de 37 pessoas.",
    "pe2 no tier enterprise tem preco_mensal de 99000.",
  ].join(" ");
  const pages: PageRow[] = [
    { slug, type: "reunioes", title: slug, date, path: "", body, content_hash: slug },
  ];
  const extractions: ExtractionRow[] = [
    {
      source_slug: slug,
      type: "reunioes",
      date,
      content_hash: slug,
      prompt_version: "test",
      extractions: {
        metricas: [
          {
            entity: "pe0",
            predicate: "preco_mensal",
            value: "4200",
            value_num: 4200,
            unit: "BRL",
            period: "monthly",
            valid_from: date,
            context_quote: "preco_mensal em 4200 por mes",
            text: "preco_mensal 4200",
          },
          {
            entity: "pe1",
            predicate: "headcount",
            value: "37",
            value_num: 37,
            unit: "people",
            valid_from: date,
            context_quote: "headcount de 37 pessoas",
            text: "headcount 37",
          },
          {
            entity: "pe2",
            predicate: "preco_mensal",
            value: "99000",
            value_num: 99000,
            unit: "BRL",
            period: "monthly",
            tier: "enterprise",
            valid_from: date,
            context_quote: "preco_mensal de 99000",
            text: "preco_mensal enterprise 99000",
          },
        ],
      },
    },
  ];
  return { pages, extractions };
}
