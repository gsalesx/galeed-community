/** P1-B (mata A3 / A2c) — factsForQuery (ask) + seriesForQuery (bff) contra o Postgres REAL
 *  (:5434), §4.5 da DESIGN-SPEC. Invariante #9: dado persistido via engine real (putFacts), o
 *  recorte asOf e o corte por relevância provados ponta-a-ponta. Fixtures sufixadas
 *  `p1b-consulta`; brain descartável `itest-p1b-consulta`; banco COMPARTILHADO (só toca o brain
 *  de teste). */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { hasDb, wipeBrain } from "./helpers/db.ts";
import { getEngine, closeEngines, type FactRow } from "../../src/core/platform/engine.ts";
import { factsForQuery } from "../../src/core/retrieval/ask.ts";
import { seriesForQuery } from "../../src/connectors/bff/bff-m9.ts";

const BRAIN = "itest-p1b-consulta";
const SLUG = "reuniao-p1b-consulta";

function fact(p: Partial<FactRow> & { idx: number; value: string; value_num: number | null; valid_from: string; valid_to: string; predicate: string }): FactRow {
  return {
    source_slug: SLUG, type: "reunioes", dimension: "decisions", text: "", quote: "", meta: {},
    entity: "accelera", unit: "BRL", period: "monthly", tier: "", confidence: 0.7, status: "fato",
    ...p,
  } as FactRow;
}

function seed(): FactRow[] {
  const rows: FactRow[] = [];
  const preco: Array<[string, number, string, string]> = [
    ["R$ 3 mil", 3000, "2023-08-10", "2024-01-15"],
    ["R$ 5 mil", 5000, "2024-01-15", "2024-03-20"],
    ["R$ 12 mil", 12000, "2024-03-20", "2024-06-05"],
    ["R$ 18 mil", 18000, "2024-06-05", "2025-01-10"],
    ["R$ 30 mil", 30000, "2025-01-10", ""],
  ];
  let idx = 0;
  for (const [value, vn, vf, vt] of preco)
    rows.push(fact({ idx: idx++, predicate: "preco", value, value_num: vn, valid_from: vf, valid_to: vt }));
  // 65 fatos de ruído (mesma entidade) que ordenam ANTES de `preco` no alfabeto.
  const day = (i: number) => `2024-01-${String((i % 28) + 1).padStart(2, "0")}`;
  for (let i = 0; i < 10; i++) rows.push(fact({ idx: idx++, predicate: "aluno_de", value: `aluno-${i}`, value_num: null, valid_from: day(i), valid_to: "" }));
  for (let i = 0; i < 30; i++) rows.push(fact({ idx: idx++, predicate: "clientes", value: `cliente-${i}`, value_num: null, valid_from: day(i), valid_to: "" }));
  for (let i = 0; i < 25; i++) rows.push(fact({ idx: idx++, predicate: "mrr", value: `mrr-${i}`, value_num: i, valid_from: day(i), valid_to: "" }));
  return rows;
}

describe.skipIf(!hasDb())("P1-B asOf + corte contra o Postgres real (§4.5)", () => {
  beforeAll(async () => {
    await wipeBrain(BRAIN);
    const e = await getEngine(BRAIN);
    await e.putFacts(seed());
  });
  afterAll(async () => {
    await wipeBrain(BRAIN);
    await closeEngines();
  });

  it("1. factsForQuery + recorte: asOf real, contém 12000, exclui 30000 e o degrau 5000", async () => {
    const r = await factsForQuery(BRAIN, "qual era o preço da accelera em março de 2024?");
    expect(r.entities).toEqual(["accelera"]);
    expect(r.block).toContain("recorte temporal da pergunta: 2024-03");
    expect(r.block).toContain("12000");
    expect(r.block).not.toContain("30000");
    // DESVIO da spec (anotado): a spec sugeria `not.toContain("(desde 2024-01-15")` p/ excluir o
    // degrau 5000, mas o ruído `mrr` real tem um fato com valid_from 2024-01-15 que É vigente no
    // ponto (valid_to "") — então a string aparece legitimamente. A asserção precisa do degrau é
    // `5000` (value_num do degrau superseded em 2024-03-20 ≤ asOf), inequívoco no corpus.
    expect(r.block).not.toContain("5000"); // o degrau 5000 (valid_to 2024-03-20 ≤ asOf) sai
  });

  it("2. série não decapitada com >60 fatos REAIS: 5 degraus de preco, bloco ≤ 60 linhas", async () => {
    const r = await factsForQuery(BRAIN, "qual o preço da accelera?");
    for (const vn of ["3000", "5000", "12000", "18000", "30000"]) expect(r.block).toContain(vn);
    const linhas = r.block.split("\n").filter((l) => l.startsWith("- "));
    expect(linhas.length).toBeLessThanOrEqual(60);
  });

  it("3. seriesForQuery (bff) não decapita e mantém shape tipado", async () => {
    const arr = await seriesForQuery(BRAIN, "qual o preço da accelera?");
    expect(arr.length).toBeLessThanOrEqual(60);
    const precos = arr.filter((f) => f.predicate === "preco");
    expect(precos.length).toBe(5);
    expect(precos.map((f) => f.value_num)).toEqual([3000, 5000, 12000, 18000, 30000]); // cronológica
    const marco = precos.find((f) => f.value_num === 12000)!;
    expect(marco.value_num).toBe(12000);
    expect(marco.unit).toBe("BRL");
  });

  it("4. word-boundary contra o engine real: 'aceleradora' → vazio", async () => {
    const r = await factsForQuery(BRAIN, "o que a aceleradora fez?");
    expect(r).toEqual({ block: "", entities: [] });
  });

  it("5. determinismo ponta-a-ponta: caso 2 duas vezes → block byte-idêntico", async () => {
    const a = await factsForQuery(BRAIN, "qual o preço da accelera?");
    const b = await factsForQuery(BRAIN, "qual o preço da accelera?");
    expect(a.block).toBe(b.block);
  });
});
