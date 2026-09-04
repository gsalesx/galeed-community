/** M23-B/§5.C — gate de auto-contenção no MOTOR (derivePageFacts, função pura): entidade vaga
 *  não-resolvida nunca vira 'fato' (status 'nao-verificado' 0.30, fora da cadeia R5/currentFacts).
 *  Exceções: canonicalização pelo entityMap e marcador review='aprovada' (decisão humana).
 *  Molde: p1a-sem-evidencia.test.ts; asserts MEDIDOS contra o comportamento real (LEARNINGS M17/S4). */
import { describe, it, expect } from "vitest";
import { derivePageFacts, applyBitemporal } from "../../src/core/retrieval/indexer.ts";
import type { PageRow, ExtractionRow, FactRow } from "../../src/core/platform/engine.ts";

const BODY = "ela escolheu o plano pocket; o faturamento da empresa é 5000; teobaldo vai ser o mentor.";
const page = (): PageRow => ({ slug: "p", type: "reunioes", title: "p", date: "2026-01-01", path: "", body: BODY, content_hash: "p" });
const ex = (item: any): ExtractionRow => ({
  source_slug: "p", type: "reunioes", date: "2026-01-01", content_hash: "p", prompt_version: "t",
  extractions: { facts: [item] },
});

describe("derivePageFacts — M23-B: entidade vaga nunca vira fato", () => {
  it("1. claim vago ancorado por quote → nao-verificado 0.30", () => {
    const [f] = derivePageFacts(
      [page()],
      [ex({ entity: "ela", predicate: "plano", value: "pocket", context_quote: "ela escolheu o plano pocket" })],
      { reconcileMap: {}, entityMap: {} },
    );
    expect(f.status).toBe("nao-verificado");
    expect(f.confidence).toBeCloseTo(0.3, 10);
  });

  it("2. claim vago com value_num ancorado no body → nao-verificado (vagueza vence número ancorado)", () => {
    const [f] = derivePageFacts(
      [page()],
      [ex({ entity: "a empresa", predicate: "faturamento", value: "5000", value_num: 5000 })],
      { reconcileMap: {}, entityMap: {} },
    );
    expect(f.status).toBe("nao-verificado");
  });

  it("3. entityMap canonicaliza ANTES do gate → fato 0.60 (resolução contra entidade conhecida escapa)", () => {
    const [f] = derivePageFacts(
      [page()],
      [ex({ entity: "a empresa", predicate: "faturamento", value: "5000", value_num: 5000 })],
      { reconcileMap: {}, entityMap: { "a empresa": "acme" } },
    );
    expect(f.status).toBe("fato");
    expect(f.confidence).toBeCloseTo(0.6, 10);
    expect(f.entity).toBe("acme");
  });

  it("4. claim vago + review='aprovada' + quote verbatim → fato (decisão humana = resolvedor)", () => {
    const [f] = derivePageFacts(
      [page()],
      [ex({ entity: "ela", predicate: "plano", value: "pocket", context_quote: "ela escolheu o plano pocket", review: "aprovada" })],
      { reconcileMap: {}, entityMap: {} },
    );
    expect(f.status).toBe("fato");
  });

  it("5. claim vago + review='aprovada' SEM âncora nenhuma → nao-verificado (aprovação não inventa âncora)", () => {
    // value "premium" NÃO está no body — evidência zero de verdade. (A fixture usava "pocket", que
    // ESTÁ verbatim no body: com o fix do viés numérico residual — criacao-de-fatos #5 — valor
    // textual verbatim na fonte agora É âncora, como número é; o invariante deste teste continua:
    // aprovação humana não INVENTA âncora onde não existe nenhuma.)
    const [f] = derivePageFacts(
      [page()],
      [ex({ entity: "ela", predicate: "plano", value: "premium", review: "aprovada" })],
      { reconcileMap: {}, entityMap: {} },
    );
    expect(f.status).toBe("nao-verificado");
  });

  it("6. nome próprio novo ancorado (teobaldo) → fato (vaga ≠ nova)", () => {
    const [f] = derivePageFacts(
      [page()],
      [ex({ entity: "teobaldo", predicate: "funcao", value: "mentor", context_quote: "teobaldo vai ser o mentor" })],
      { reconcileMap: {}, entityMap: {} },
    );
    expect(f.status).toBe("fato");
  });

  it("7. R5: claim vago datado MAIS NOVO no mesmo grupo de um fato vigente → vigente único, vago fora da cadeia", () => {
    const facts: FactRow[] = derivePageFacts(
      [
        page(),
        { slug: "p2", type: "reunioes", title: "p2", date: "2026-02-01", path: "", body: BODY, content_hash: "p2" },
      ],
      [
        // o vigente: entidade vaga MAS aprovada pelo humano + ancorada → fato (grupo ela·plano)
        ex({ entity: "ela", predicate: "plano", value: "pocket", context_quote: "ela escolheu o plano pocket", review: "aprovada", valid_from: "2026-01-01" }),
        // o vago não-aprovado, data mais nova, mesmo grupo
        {
          source_slug: "p2", type: "reunioes", date: "2026-02-01", content_hash: "p2", prompt_version: "t",
          extractions: { facts: [{ entity: "ela", predicate: "plano", value: "premium", context_quote: "ela escolheu o plano pocket", valid_from: "2026-02-01" }] },
        },
      ],
      { reconcileMap: {}, entityMap: {} },
    );
    applyBitemporal(facts);
    const vigente = facts.filter((f) => f.status === "fato" && f.valid_to === "");
    expect(vigente).toHaveLength(1);
    expect(vigente[0].value).toBe("pocket");
    const vago = facts.find((f) => f.value === "premium")!;
    expect(vago.status).toBe("nao-verificado"); // fora da cadeia
  });
});
