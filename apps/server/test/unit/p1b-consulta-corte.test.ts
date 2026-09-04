/** P1-B (mata A3) — rankSeriesForQuestion: a série do predicado perguntado NÃO é decapitada
 *  (§2.3 / §4.3 da DESIGN-SPEC). Puro, em memória. Reproduz o cenário canônico do preço da
 *  Accelera: `preco` ×5 + ruído (aluno_de ×10, clientes ×30, mrr ×25) que ordena ANTES de
 *  `preco` no alfabeto — exatamente o que o slice(0,60) alfabético velho decapitava. */
import { describe, it, expect } from "vitest";
import { rankSeriesForQuestion } from "../../src/core/retrieval/ask.ts";

interface F {
  entity: string;
  predicate: string;
  tier: string;
  valid_from: string;
  value: string;
  source_slug: string;
}

// 5 degraus de `preco` (a série perguntada) + 65 fatos de ruído (predicados que ordenam ANTES).
function fixture70(): F[] {
  const out: F[] = [];
  const preco: Array<[string, string]> = [
    ["R$ 3 mil", "2023-08-10"],
    ["R$ 5 mil", "2024-01-15"],
    ["R$ 12 mil", "2024-03-20"],
    ["R$ 18 mil", "2024-06-05"],
    ["R$ 30 mil", "2025-01-10"],
  ];
  for (const [value, vf] of preco)
    out.push({ entity: "accelera", predicate: "preco", tier: "", valid_from: vf, value, source_slug: "reuniao-p1b-consulta" });
  // ruído: aluno_de ×10, clientes ×30, mrr ×25 — todos da MESMA entidade, valid_from crescentes.
  const day = (i: number) => `2024-01-${String((i % 28) + 1).padStart(2, "0")}`;
  for (let i = 0; i < 10; i++)
    out.push({ entity: "accelera", predicate: "aluno_de", tier: "", valid_from: day(i), value: `aluno-${i}`, source_slug: "reuniao-p1b-consulta" });
  for (let i = 0; i < 30; i++)
    out.push({ entity: "accelera", predicate: "clientes", tier: "", valid_from: day(i), value: `cliente-${i}`, source_slug: "reuniao-p1b-consulta" });
  for (let i = 0; i < 25; i++)
    out.push({ entity: "accelera", predicate: "mrr", tier: "", valid_from: day(i), value: `mrr-${i}`, source_slug: "reuniao-p1b-consulta" });
  return out;
}

describe("rankSeriesForQuestion — corte por relevância (P1-B)", () => {
  it("1. a série perguntada NÃO é decapitada: 5 fatos de preco, primeiro, cronológico", () => {
    const r = rankSeriesForQuestion("qual o preço da accelera?", fixture70(), 60);
    const precos = r.filter((f) => f.predicate === "preco");
    expect(precos.length).toBe(5);
    // vêm PRIMEIRO (são as 5 primeiras linhas do resultado)
    expect(r.slice(0, 5).every((f) => f.predicate === "preco")).toBe(true);
    // ordem cronológica
    expect(precos.map((f) => f.value)).toEqual(["R$ 3 mil", "R$ 5 mil", "R$ 12 mil", "R$ 18 mil", "R$ 30 mil"]);
    expect(r.length).toBe(60);
  });

  it("2. prova da regressão morta: o corte VELHO (alfabético+slice 60) ZERA preco", () => {
    const fatos = fixture70();
    // controle: o sort velho de factsForQuery — alfabético por entity+predicate+tier, slice 60.
    const velho = [...fatos]
      .sort(
        (a, b) =>
          (a.entity + a.predicate + a.tier).localeCompare(b.entity + b.predicate + b.tier) ||
          a.valid_from.localeCompare(b.valid_from),
      )
      .slice(0, 60);
    expect(velho.filter((f) => f.predicate === "preco").length).toBe(0); // decapitada no código velho
  });

  it("3. sem predicado casado → recência: a 1ª série é a de maior valid_from máximo", () => {
    const r = rankSeriesForQuestion("quanto custava?", fixture70(), 60);
    expect(r.length).toBe(60);
    // preco tem o maior valid_from (2025-01-10) → série mais recente vem primeiro mesmo sem casar.
    expect(r[0].predicate).toBe("preco");
    expect(r[0].valid_from).toBe("2023-08-10"); // dentro da série, cronológica asc
  });

  it("4. série quente maior que o limite entra inteira (e nada frio)", () => {
    const fatos: F[] = [];
    for (let i = 0; i < 65; i++)
      fatos.push({ entity: "accelera", predicate: "preco", tier: "", valid_from: `2024-01-${String((i % 28) + 1).padStart(2, "0")}`, value: `p-${i}`, source_slug: "s" });
    for (let i = 0; i < 10; i++)
      fatos.push({ entity: "accelera", predicate: "mrr", tier: "", valid_from: "2024-02-01", value: `m-${i}`, source_slug: "s" });
    const r = rankSeriesForQuestion("qual o preço?", fatos, 60);
    expect(r.filter((f) => f.predicate === "preco").length).toBe(65);
    expect(r.filter((f) => f.predicate === "mrr").length).toBe(0);
    expect(r.length).toBe(65);
  });

  it("5. determinismo: duas chamadas → toEqual", () => {
    const fatos = fixture70();
    expect(rankSeriesForQuestion("qual o preço?", fatos, 60)).toEqual(rankSeriesForQuestion("qual o preço?", fatos, 60));
  });
});
