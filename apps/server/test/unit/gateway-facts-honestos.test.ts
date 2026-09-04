/** Borda pública /v1 HONESTA (achados consulta-e-saida):
 *  (1) claim 'nao-verificado' (quote não ancorado — suspeito de alucinação) NÃO sai por /v1:
 *      `publishable()` o exclui ANTES da tradução (cobre /v1/facts E o facts[] do /v1/ask no
 *      mesmo ponto — o toPublic do gateway-server). Antes, publicStatus o rotulava "fact".
 *  (2) `dim` público do /v1/facts: valida só o FORMATO (DIM_RE) — as dims reais são definidas
 *      por receita/pack (inclusive em PT), então allowlist estática estaria errada.
 *  Testes PUROS (gateway-shape.ts não tem HTTP/IO) — nenhum teste pinava esse comportamento. */
import { describe, it, expect } from "vitest";
import { publishable, DIM_RE, toPublicFact, publicStatus } from "../../src/connectors/gateway-shape.ts";
import type { FactItem } from "../../src/connectors/bff/bff-m9.ts";

const fato = (over: Partial<FactItem> = {}): FactItem => ({
  source_slug: "call-2026-06-01",
  text: "decidimos migrar o posicionamento",
  entity: "acme",
  predicate: "posicionamento",
  value: "premium",
  valid_from: "2026-06-01",
  valid_to: "",
  status: "fato",
  confidence: 0.9,
  ...over,
});

describe("publishable — 'nao-verificado' nunca sai pela borda /v1", () => {
  it("exclui o fato 'nao-verificado' VIGENTE (valid_to='' — a supersessão o ignora pra sempre)", () => {
    const rows = [
      fato(),
      fato({ status: "nao-verificado", confidence: 0.3, valid_to: "", text: "claim não ancorado" }),
    ];
    const out = publishable(rows);
    expect(out).toHaveLength(1);
    expect(out[0].status).toBe("fato");
  });

  it("é case-insensitive e tolera status ausente (só 'nao-verificado' cai)", () => {
    const rows = [
      fato({ status: "NAO-VERIFICADO" }),
      fato({ status: undefined }),
      fato({ status: "registrado" }),
      fato({ status: "arquivado" }),
    ];
    const out = publishable(rows);
    expect(out.map((f) => f.status)).toEqual([undefined, "registrado", "arquivado"]);
  });

  it("integração com a tradução: o publicável segue virando fact/archived normalmente", () => {
    const kept = publishable([fato(), fato({ status: "nao-verificado" })]);
    const pub = kept.map((f) => toPublicFact(f, undefined));
    expect(pub).toHaveLength(1);
    expect(pub[0].status).toBe("fact");
    // sanidade do mapeamento temporal (inalterado): superado → archived
    expect(publicStatus("fato", "2020-01-01")).toBe("archived");
  });
});

describe("DIM_RE — formato do parâmetro público dim do /v1/facts", () => {
  it("aceita dims default (EN) e dims de pack/receita (PT)", () => {
    for (const d of ["decisions", "facts", "quotes", "decisoes", "compromissos", "precos", "open_questions"]) {
      expect(DIM_RE.test(d), d).toBe(true);
    }
  });
  it("rejeita formato inválido (injeção/typo/abuso de tamanho)", () => {
    for (const d of ["", "Decisions", "decisões", "a b", "1abc", "x".repeat(41), "drop;table"]) {
      expect(DIM_RE.test(d), JSON.stringify(d)).toBe(false);
    }
  });
});
