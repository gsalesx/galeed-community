/** P1-A/C4 (lado indexer): claim com triple, SEM value_num e SEM context_quote = evidência
 *  NENHUMA → status 'nao-verificado' (nunca 'fato' 0.60). quoteIsGrounded("")→true e
 *  valueIsAnchored(sem dígito)→true não penalizam AUSÊNCIA — o predicado `semEvidencia` penaliza.
 *  Função pura (derivePageFacts) — sem DB, monta PageRow/ExtractionRow literais. */
import { describe, it, expect } from "vitest";
import { derivePageFacts, applyBitemporal } from "../../src/core/retrieval/indexer.ts";
import type { PageRow, ExtractionRow, FactRow } from "../../src/core/platform/engine.ts";

const maps = { reconcileMap: {}, entityMap: {} };
const BODY = "Acme fechou o plano em 5000 por mês.";
const page = (): PageRow => ({ slug: "p", type: "reunioes", title: "p", date: "2026-01-01", path: "", body: BODY, content_hash: "p" });
const ex = (item: any): ExtractionRow => ({
  source_slug: "p", type: "reunioes", date: "2026-01-01", content_hash: "p", prompt_version: "t",
  extractions: { facts: [item] },
});

describe("derivePageFacts — C4: triple sem evidência → nao-verificado", () => {
  it("caso 1: triple, value_num null, context_quote '' → nao-verificado 0.30", () => {
    const [f] = derivePageFacts([page()], [ex({ entity: "acme", predicate: "preco_mensal", value: "5000" })], maps);
    expect(f.status).toBe("nao-verificado");
    expect(f.confidence).toBeCloseTo(0.3, 10);
  });

  it("caso 2: mesmo claim COM context_quote verbatim → fato 0.60", () => {
    const [f] = derivePageFacts(
      [page()],
      [ex({ entity: "acme", predicate: "preco_mensal", value: "5000", context_quote: "plano em 5000 por mês" })],
      maps,
    );
    expect(f.status).toBe("fato");
    expect(f.confidence).toBeCloseTo(0.6, 10);
  });

  it("caso 3: sem quote mas COM value_num ancorado no body → fato", () => {
    const [f] = derivePageFacts(
      [page()],
      [ex({ entity: "acme", predicate: "preco_mensal", value: "5000", value_num: 5000 })],
      maps,
    );
    expect(f.status).toBe("fato");
  });

  it("caso 4: value_num presente mas NÃO-verbatim no body → nao-verificado (S3 intacto)", () => {
    const [f] = derivePageFacts(
      [page()],
      [ex({ entity: "acme", predicate: "preco_mensal", value: "9999", value_num: 9999 })],
      maps,
    );
    expect(f.status).toBe("nao-verificado");
  });

  it("caso 5: o fato sem-evidência NÃO supersede um 'fato' vigente do mesmo grupo (R5 + C4)", () => {
    const facts: FactRow[] = derivePageFacts(
      [
        page(),
        { slug: "p2", type: "reunioes", title: "p2", date: "2026-02-01", path: "", body: BODY, content_hash: "p2" },
      ],
      [
        // o vigente, ancorado
        ex({ entity: "acme", predicate: "preco_mensal", value: "5000", value_num: 5000, valid_from: "2026-01-01" }),
        // o alucinado: triple sem evidência, data mais nova
        {
          source_slug: "p2", type: "reunioes", date: "2026-02-01", content_hash: "p2", prompt_version: "t",
          extractions: { facts: [{ entity: "acme", predicate: "preco_mensal", value: "9999", valid_from: "2026-02-01" }] },
        },
      ],
      maps,
    );
    applyBitemporal(facts);
    const vigente = facts.filter((f) => f.status === "fato" && f.valid_to === "");
    expect(vigente).toHaveLength(1);
    expect(vigente[0].value).toBe("5000");
    const halluc = facts.find((f) => f.value === "9999")!;
    expect(halluc.status).toBe("nao-verificado"); // intacto, fora da cadeia
  });
});
