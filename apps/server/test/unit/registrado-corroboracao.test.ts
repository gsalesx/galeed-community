/** Achado criacao-de-fatos #7 — fato SEM triple ('registrado') era cidadão de segunda classe POR
 *  CONSTRUÇÃO: teto 0.45, fora do applyBitemporal (exige entity+predicate) → repetição em N fontes
 *  distintas = N linhas a 0.45, sem corroboração nem dedupe. applyRegistradoCorroboration espelha a
 *  mecânica dos runs para registrados GROUNDED, agrupando por texto normalizado: mesma fonte
 *  colapsa em duplicata; fontes distintas sobem confiança com teto 0.75 (deliberadamente < triple
 *  corroborado — registrado não compete de igual com claim ancorado). Puro, sem DB
 *  (molde supersession.test.ts). */
import { describe, it, expect } from "vitest";
import { applyRegistradoCorroboration } from "../../src/core/retrieval/indexer.ts";
import type { FactRow } from "../../src/core/platform/engine.ts";

/** registrado grounded (0.45) com defaults sãos. */
function reg(p: Partial<FactRow>): FactRow {
  return {
    source_slug: "s1",
    type: "reunioes",
    dimension: "decisions",
    idx: 0,
    text: "decidiu focar no atendimento premium",
    quote: "focar no atendimento premium",
    meta: {},
    entity: "",
    predicate: "",
    value: "",
    valid_from: "",
    valid_to: "",
    confidence: 0.45,
    status: "registrado",
    ...p,
  };
}

describe("applyRegistradoCorroboration — texto repetido em fontes distintas SOBE (como número sobe)", () => {
  it("5 fontes distintas com o mesmo texto → 0.45 + 4×0.15 CAPADO em 0.75 (teto < triple corroborado)", () => {
    const fs = [1, 2, 3, 4, 5].map((i) => reg({ source_slug: `src${i}` }));
    applyRegistradoCorroboration(fs);
    for (const f of fs) {
      expect(f.status).toBe("registrado");
      expect(f.confidence).toBeCloseTo(0.75, 10);
    }
  });

  it("2 fontes distintas → 0.60; fonte única → 0.45 inalterado", () => {
    const duas = [reg({ source_slug: "a" }), reg({ source_slug: "b" })];
    applyRegistradoCorroboration(duas);
    expect(duas[0].confidence).toBeCloseTo(0.6, 10);
    expect(duas[1].confidence).toBeCloseTo(0.6, 10);

    const uma = [reg({ source_slug: "a" })];
    applyRegistradoCorroboration(uma);
    expect(uma[0].confidence).toBeCloseTo(0.45, 10);
  });

  it("repetição na MESMA fonte → duplicata (colapsa, não infla) — antes registrado nem dedupe tinha", () => {
    const fs = [reg({ source_slug: "a", idx: 0 }), reg({ source_slug: "a", idx: 1 }), reg({ source_slug: "b" })];
    applyRegistradoCorroboration(fs);
    expect(fs[0].status).toBe("registrado");
    expect(fs[1].status).toBe("duplicata"); // 2ª ocorrência da mesma fonte
    expect(fs[0].confidence).toBeCloseTo(0.6, 10); // 2 fontes DISTINTAS (a,b) — a duplicata não conta
    expect(fs[2].confidence).toBeCloseTo(0.6, 10);
  });

  it("paráfrase de FORMA (case/pontuação final) agrupa via normalizeValue — mesma lib do dupKey", () => {
    const fs = [
      reg({ source_slug: "a", text: "Decidiu focar no atendimento premium." }),
      reg({ source_slug: "b", text: "decidiu focar no atendimento premium" }),
    ];
    applyRegistradoCorroboration(fs);
    expect(fs[0].confidence).toBeCloseTo(0.6, 10);
    expect(fs[1].confidence).toBeCloseTo(0.6, 10);
  });

  it("UNGROUNDED (0.10) fica FORA: corroborar suspeita não é corroborar", () => {
    const fs = [
      reg({ source_slug: "a", confidence: 0.1 }),
      reg({ source_slug: "b", confidence: 0.1 }),
      reg({ source_slug: "c" }), // grounded, sozinho no grupo dele
    ];
    applyRegistradoCorroboration(fs);
    expect(fs[0].confidence).toBeCloseTo(0.1, 10);
    expect(fs[1].confidence).toBeCloseTo(0.1, 10);
    expect(fs[2].confidence).toBeCloseTo(0.45, 10); // só 1 fonte grounded → sem corroboração
  });

  it("fatos com TRIPLE não são tocados (a cadeia deles é o applyBitemporal)", () => {
    const triple = reg({ entity: "acme", predicate: "preco", value: "5000", confidence: 0.6, status: "fato" });
    const fs = [triple, reg({ source_slug: "b" })];
    applyRegistradoCorroboration(fs);
    expect(triple.confidence).toBeCloseTo(0.6, 10);
    expect(triple.status).toBe("fato");
  });

  it("idempotência: aplicar 2× não infla (recomputa do zero, nunca +=)", () => {
    const fs = [reg({ source_slug: "a" }), reg({ source_slug: "b" })];
    applyRegistradoCorroboration(fs);
    const snap1 = fs.map((f) => f.confidence);
    // 2ª passada: confidence já está 0.60 ≠ CONF_REGISTERED → o filtro de entrada não re-agrupa,
    // e NADA muda (mesma disciplina "nunca += sobre confiança armazenada" do applyBitemporal).
    applyRegistradoCorroboration(fs);
    expect(fs.map((f) => f.confidence)).toEqual(snap1);
  });
});
