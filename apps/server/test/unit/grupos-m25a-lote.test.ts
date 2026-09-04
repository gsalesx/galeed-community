/** M25-A/§5.B — agrupamento da fila por decisão (groupHypotheses) + frase da decisão
 *  (decisaoDoGrupo), PUROS, sem DB. Snapshot literal das 4 frases (mudou = vermelho). */
import { describe, it, expect } from "vitest";
import { groupHypotheses, decisaoDoGrupo } from "../../src/connectors/bff/bff-review.ts";
import type { ReviewItemRow, SourceRow } from "../../src/core/platform/engine.ts";

function item(p: Partial<ReviewItemRow>): ReviewItemRow {
  return {
    id: p.id ?? "i",
    source_id: p.source_id ?? "",
    source_slug: p.source_slug ?? "pg",
    dimension: p.dimension ?? "claims",
    text: p.text ?? "t",
    quote: p.quote ?? "",
    claim: p.claim ?? {},
    reason: p.reason ?? "fora_da_receita",
    status: "pendente",
    decided_by: "",
    decided_at: null,
  };
}

const FONTE_A: SourceRow = {
  id: "fa", name: "Calls", channel: "upload", type: "transcricoes",
  recipe: { fields: [{ dimension: "facts", label: "Fatos", area: "" }], guidance: "" },
  default_sensitivity: "restrito", status: "ativa", last_read_at: null,
};
const FONTE_B: SourceRow = {
  id: "fb", name: "WhatsApp", channel: "upload", type: "mensagens",
  recipe: { fields: [{ dimension: "facts", label: "Fatos", area: "" }], guidance: "" },
  default_sensitivity: "restrito", status: "ativa", last_read_at: null,
};

describe("M25-A — groupHypotheses / decisaoDoGrupo (puro)", () => {
  it("1. 5 itens em 2 grupos: counts/paginas certos, ordenação por count desc", () => {
    const items = [
      item({ id: "1", source_id: "fa", dimension: "claims", source_slug: "p1" }),
      item({ id: "2", source_id: "fa", dimension: "claims", source_slug: "p1" }),
      item({ id: "3", source_id: "fa", dimension: "claims", source_slug: "p2" }),
      item({ id: "4", source_id: "fb", dimension: "facts", reason: "nao_ancorado", source_slug: "q1" }),
      item({ id: "5", source_id: "fb", dimension: "facts", reason: "nao_ancorado", source_slug: "q2" }),
    ];
    const g = groupHypotheses(items, [FONTE_A, FONTE_B]);
    expect(g).toHaveLength(2);
    expect(g[0].count).toBe(3); // grupão primeiro
    expect(g[0].dimension).toBe("claims");
    expect(g[0].paginas).toBe(2); // p1, p2
    expect(g[1].count).toBe(2);
    expect(g[1].paginas).toBe(2); // q1, q2
  });

  it("2. amostra = no máximo 3, na ordem recebida, com source_name resolvido", () => {
    const items = [1, 2, 3, 4].map((n) =>
      item({ id: `x${n}`, source_id: "fa", dimension: "claims", source_slug: `p${n}` }),
    );
    const g = groupHypotheses(items, [FONTE_A]);
    expect(g[0].amostra).toHaveLength(3);
    expect(g[0].amostra.map((a) => a.id)).toEqual(["x1", "x2", "x3"]);
    expect(g[0].amostra[0].source_name).toBe("Calls");
  });

  it("3. grupo sem fonte (conexao_sugerida) → source_name '' e frase própria do sono", () => {
    const items = [item({ id: "c1", source_id: "", reason: "conexao_sugerida", dimension: "conexao", source_slug: "s" })];
    const g = groupHypotheses(items, [FONTE_A]);
    expect(g[0].source_id).toBe("");
    expect(g[0].source_name).toBe("");
    expect(g[0].decisao).toBe(
      "conexões sugeridas pelo sono — aprovar registra a decisão e a aresta entra no grafo.",
    );
  });

  it("4. decisaoDoGrupo — as 4 strings EXATAS (snapshot literal)", () => {
    expect(decisaoDoGrupo("fora_da_receita", "claims", "Calls")).toBe(
      'a receita da fonte "Calls" não tem a dimensão "claims".',
    );
    expect(decisaoDoGrupo("nao_ancorado", "facts", "WhatsApp")).toBe(
      'itens de "facts" da fonte "WhatsApp" sem âncora verificável no texto original.',
    );
    expect(decisaoDoGrupo("entidade_vaga", "relacoes", "Vídeos")).toBe(
      'itens de "relacoes" da fonte "Vídeos" sem dono claro.',
    );
    expect(decisaoDoGrupo("conexao_sugerida", "conexao", "")).toBe(
      "conexões sugeridas pelo sono — aprovar registra a decisão e a aresta entra no grafo.",
    );
    // sem fonte → "(sem fonte)" no template
    expect(decisaoDoGrupo("fora_da_receita", "claims", "")).toBe(
      'a receita da fonte "(sem fonte)" não tem a dimensão "claims".',
    );
  });

  it("5. dimensao_na_receita: true quando a receita tem a dim; false senão; false p/ fonte desconhecida", () => {
    const naReceita = groupHypotheses(
      [item({ source_id: "fa", dimension: "facts" })], [FONTE_A],
    );
    expect(naReceita[0].dimensao_na_receita).toBe(true);
    const fora = groupHypotheses(
      [item({ source_id: "fa", dimension: "claims" })], [FONTE_A],
    );
    expect(fora[0].dimensao_na_receita).toBe(false);
    const desconhecida = groupHypotheses(
      [item({ source_id: "zzz", dimension: "facts" })], [FONTE_A],
    );
    expect(desconhecida[0].dimensao_na_receita).toBe(false);
    expect(desconhecida[0].source_name).toBe("");
  });

  it("6. items:[] → []", () => {
    expect(groupHypotheses([], [FONTE_A])).toEqual([]);
  });
});
