/** FIX-A/BUG 3 (lado indexer): o fato REGISTRADO (sem triple) passa a herdar a MESMA cadeia de
 *  fallback de data que o triple — factValidFrom(it, sourceDate) — em vez de receber "" por
 *  construção. Forense 2026-06-12: 3.645/7.299 fatos sem data eram TODOS registrados COM a data
 *  sentada em meta.date. Sem data válida em nenhum elo → "" (limitação honesta; nunca inventa).
 *  Função pura (derivePageFacts) — sem DB, monta PageRow/ExtractionRow literais. */
import { describe, it, expect } from "vitest";
import { derivePageFacts } from "../../src/core/retrieval/indexer.ts";
import type { PageRow, ExtractionRow } from "../../src/core/platform/engine.ts";

const maps = { reconcileMap: {}, entityMap: {} };
// body com a frase verbatim do registro (p/ groundedRegistro = quote ancorado na fonte)
const BODY = "Kelvin usa Claude para estratégia com clientes e automação com IA.";

const page = (date = "2026-01-01"): PageRow => ({
  slug: "p",
  type: "notas",
  title: "p",
  date,
  path: "",
  body: BODY,
  content_hash: "p",
});

const ex = (item: any, date = "2026-01-01"): ExtractionRow => ({
  source_slug: "p",
  type: "notas",
  date,
  content_hash: "p",
  prompt_version: "t",
  extractions: { facts: [item] },
});

describe("FIX-A/BUG 3 — registrado herda a cadeia de valid_from", () => {
  // (a) Registrado com carimbo: extração sem entity/predicate, COM date → registrado COM valid_from.
  it("(a) registrado com carimbo date → valid_from = a data do claim", () => {
    const [f] = derivePageFacts(
      [page()],
      [ex({ text: "Kelvin usa Claude para estratégia com clientes e automação com IA", context_quote: BODY, date: "2025-09-22" })],
      maps,
    );
    expect(f.status).toBe("registrado");
    expect(f.valid_from).toBe("2025-09-22");
  });

  // (b) Registrado sem NENHUMA data (claim sem date, ex.date='') → '' (limitação honesta).
  it("(b) registrado sem data em nenhum elo → '' (nunca inventa)", () => {
    const [f] = derivePageFacts(
      [page("")],
      [ex({ text: "Kelvin usa Claude para estratégia com clientes e automação com IA", context_quote: BODY }, "")],
      maps,
    );
    expect(f.status).toBe("registrado");
    expect(f.valid_from).toBe("");
  });

  // (c) Registrado sem date mas ex.date ISO → valid_from = sourceDate (espelho do triple).
  it("(c) registrado sem date mas ex.date ISO → fallback sourceDate", () => {
    const [f] = derivePageFacts(
      [page("2025-07-15")],
      [ex({ text: "Kelvin usa Claude para estratégia com clientes e automação com IA", context_quote: BODY }, "2025-07-15")],
      maps,
    );
    expect(f.status).toBe("registrado");
    expect(f.valid_from).toBe("2025-07-15");
  });

  // (d) Triple: comportamento BYTE-idêntico ao atual — date do claim vence ex.date.
  it("(d) triple intacto: date do claim ancora valid_from (espelho de p1a-valid-from)", () => {
    const [f] = derivePageFacts(
      [page("2026-01-01")],
      [ex({ entity: "acme", predicate: "preco_mensal", value: "5000", value_num: 5000, date: "2025-09-22" }, "2026-01-01")],
      maps,
    );
    expect(f.entity).toBe("acme");
    expect(f.valid_from).toBe("2025-09-22");
  });
  it("(d) triple sem date nenhum, ex.date ISO → fallback sourceDate (intacto)", () => {
    const [f] = derivePageFacts(
      [page("2026-03-03")],
      [ex({ entity: "acme", predicate: "preco_mensal", value: "5000", value_num: 5000 }, "2026-03-03")],
      maps,
    );
    expect(f.valid_from).toBe("2026-03-03");
  });

  // (e) Data não-ISO no registro → normalizeValidFrom rejeita, cai pro próximo elo (sem parser à mão).
  it("(e) registrado com date não-ISO → cai pro fallback ex.date (nunca interpreta NL)", () => {
    const [f] = derivePageFacts(
      [page("2025-05-01")],
      [ex({ text: "Kelvin usa Claude para estratégia com clientes e automação com IA", context_quote: BODY, date: "março de 2024" }, "2025-05-01")],
      maps,
    );
    expect(f.status).toBe("registrado");
    expect(f.valid_from).toBe("2025-05-01"); // date inválido ignorado → sourceDate
  });
  it("(e) registrado com date não-ISO e SEM ex.date → '' (não inventa)", () => {
    const [f] = derivePageFacts(
      [page("")],
      [ex({ text: "Kelvin usa Claude para estratégia com clientes e automação com IA", context_quote: BODY, date: "março de 2024" }, "")],
      maps,
    );
    expect(f.valid_from).toBe("");
  });
});
