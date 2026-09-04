/** P0-A — carimbo da data da unit no claim (transporte sync). Determinístico, sem DB, sem LLM real.
 *  (1) stampUnitDate puro; (2) extractUnit carimba via o `structured` MOCADO (vi.hoisted — LEARNINGS
 *  M18/S2: NUNCA const top-level na factory do mock; o mock é içado acima dos imports). */
import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock do módulo de LLM: `structured` devolve claims SEM `date`. As fns vivem em vi.hoisted p/ existirem
// quando a factory do vi.mock roda (içada pro topo absoluto). resolveProvider é usado em outros caminhos
// do módulo — devolvemos um stub neutro.
const { mockStructured } = vi.hoisted(() => ({ mockStructured: vi.fn() }));
vi.mock("../../src/lib/llm.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/llm.ts")>();
  return {
    ...actual,
    structured: (...a: any[]) => mockStructured(...a),
  };
});
// recordUsage é fail-soft, mas evitamos qualquer IO de DB no unit mockando-o como no-op.
vi.mock("../../src/core/platform/usage.ts", () => ({ recordUsage: vi.fn(async () => {}) }));

import {
  stampUnitDate,
  extractUnit,
  type ExtractionContext,
  type ExtractionUnit,
} from "../../src/core/extraction/extract.ts";
import type { PageRow } from "../../src/core/platform/engine.ts";

describe("P0-A — stampUnitDate (puro)", () => {
  it("carimba só itens sem date; preserva date existente; não toca valid_from; tolera não-objeto", () => {
    const out: Record<string, any[]> = {
      fatos: [
        { entity: "a", predicate: "p" }, // sem date → carimba
        { entity: "b", predicate: "q", date: "2020-01-01" }, // date existente → preserva
        { entity: "c", predicate: "r", valid_from: "2021-02-02" }, // sem date mas com valid_from → carimba date, NÃO toca valid_from
        "lixo", // não-objeto → ignora sem quebrar
        ["arr"], // array → ignora (não é claim-objeto)
        null, // null → ignora
      ],
    };
    stampUnitDate(out, "2026-04-17");
    expect(out.fatos[0].date).toBe("2026-04-17");
    expect(out.fatos[1].date).toBe("2020-01-01"); // preservado
    expect(out.fatos[2].date).toBe("2026-04-17"); // carimbado
    expect(out.fatos[2].valid_from).toBe("2021-02-02"); // intocado
    expect(out.fatos[3]).toBe("lixo"); // não-objeto inalterado
  });

  it("unitDate vazio → no-op", () => {
    const out = { fatos: [{ entity: "a" }] };
    stampUnitDate(out, "");
    expect((out.fatos[0] as any).date).toBeUndefined();
  });
});

/** ctx fake literal (sem DB): só os campos que extractUnit lê. */
function fakeCtx(): ExtractionContext {
  return {
    tool: { name: "t", description: "", input_schema: { type: "object", properties: {}, required: [] } } as any,
    dims: ["fatos"],
    provider: "api",
    model: "claude-haiku",
    ctxBlock: "",
    hintBlock: "",
  } as unknown as ExtractionContext;
}

const PAGE = { slug: "s-p0a", type: "reunioes" } as unknown as PageRow;

describe("P0-A — extractUnit carimba a data da unit", () => {
  beforeEach(() => mockStructured.mockReset());

  it("claims SEM date herdam unit.date", async () => {
    mockStructured.mockResolvedValue({ fatos: [{ entity: "accelera", predicate: "preco" }] });
    const unit: ExtractionUnit = { header: "h", body: "b", date: "2026-04-22", triageText: "b" };
    const res = await extractUnit("__test_p0a_whatsapp", PAGE, unit, fakeCtx());
    expect(res.fatos[0].date).toBe("2026-04-22");
  });

  it("unit com date='' → claims sem carimbo", async () => {
    mockStructured.mockResolvedValue({ fatos: [{ entity: "accelera", predicate: "preco" }] });
    const unit: ExtractionUnit = { header: "h", body: "b", date: "", triageText: "b" };
    const res = await extractUnit("__test_p0a_whatsapp", PAGE, unit, fakeCtx());
    expect(res.fatos[0].date).toBeUndefined();
  });

  it("claim com date própria do LLM é preservada", async () => {
    mockStructured.mockResolvedValue({ fatos: [{ entity: "accelera", predicate: "preco", date: "2030-12-31" }] });
    const unit: ExtractionUnit = { header: "h", body: "b", date: "2026-04-22", triageText: "b" };
    const res = await extractUnit("__test_p0a_whatsapp", PAGE, unit, fakeCtx());
    expect(res.fatos[0].date).toBe("2030-12-31");
  });
});
