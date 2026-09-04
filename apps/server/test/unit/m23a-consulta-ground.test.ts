/** M23-A (§4.2) — groundQuestion com `structured` MOCADO (zero LLM real, zero DB). Prova: bound
 *  de 4, fail-open em toda falha, model = apiModel (não synthModel), meter → M20 op ask:ground,
 *  ≤1 chamada (bounded, não-loop). */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { structured, resolveProvider, config, recordUsage } = vi.hoisted(() => ({
  structured: vi.fn(),
  resolveProvider: vi.fn((p?: string) => (p === "cli" ? "cli" : "api")),
  config: vi.fn(() => ({ provider: "api", apiModel: "claude-haiku-4-5-20251001", cliModel: "haiku", synthModel: "synth-model" })),
  recordUsage: vi.fn(async () => {}),
}));

vi.mock("../../src/lib/llm.ts", () => ({ structured, resolveProvider }));
vi.mock("../../src/core/platform/config.ts", () => ({ config }));
vi.mock("../../src/core/platform/usage.ts", () => ({ recordUsage }));

import { groundQuestion } from "../../src/core/retrieval/ground.ts";

beforeEach(() => {
  vi.clearAllMocks();
  resolveProvider.mockImplementation((p?: string) => (p === "cli" ? "cli" : "api"));
  config.mockReturnValue({ provider: "api", apiModel: "claude-haiku-4-5-20251001", cliModel: "haiku", synthModel: "synth-model" } as any);
});

describe("groundQuestion (§2.1)", () => {
  it("1. decomposição válida → 2 subs; structured 1× com tool/model corretos", async () => {
    structured.mockResolvedValue({ composta: true, sub_perguntas: ["quando o teobaldo entrou na accelera?", "qual era o preço da accelera?"] });
    const g = await groundQuestion("home", "quanto custava a accelera quando o teobaldo entrou?");
    expect(g).toEqual({ subs: ["quando o teobaldo entrou na accelera?", "qual era o preço da accelera?"] });
    expect(structured).toHaveBeenCalledTimes(1);
    const [opts] = structured.mock.calls[0];
    expect(opts.tool.name).toBe("decompor_pergunta");
    expect(opts.model).toBe("claude-haiku-4-5-20251001"); // apiModel, NÃO synthModel
  });

  it("2. bound de 4 — 6 subs → slice para 4", async () => {
    structured.mockResolvedValue({ composta: true, sub_perguntas: ["a", "b", "c", "d", "e", "f"] });
    const g = await groundQuestion("home", "q");
    expect(g?.subs.length).toBe(4);
    expect(structured).toHaveBeenCalledTimes(1);
  });

  it("3. fail-open — composta=false / <2 subs / throw / filtra não-string-vazia", async () => {
    structured.mockResolvedValue({ composta: false, sub_perguntas: [] });
    expect(await groundQuestion("home", "q")).toBeNull();

    structured.mockResolvedValue({ composta: true, sub_perguntas: ["só uma"] });
    expect(await groundQuestion("home", "q")).toBeNull();

    structured.mockRejectedValue(new Error("boom"));
    expect(await groundQuestion("home", "q")).toBeNull();

    structured.mockResolvedValue({ composta: true, sub_perguntas: [42, "", "ok", "ok2"] });
    expect((await groundQuestion("home", "q"))?.subs).toEqual(["ok", "ok2"]);
  });

  it("4. meter → recordUsage op ask:ground", async () => {
    let captured: ((ev: any) => void) | undefined;
    structured.mockImplementation(async (opts: any) => {
      captured = opts.meter;
      return { composta: true, sub_perguntas: ["a", "b"] };
    });
    await groundQuestion("home", "q");
    expect(captured).toBeTypeOf("function");
    captured!({ provider: "api", model: "m", tokensIn: 1, tokensOut: 2 });
    expect(recordUsage).toHaveBeenCalledWith("home", expect.objectContaining({ op: "ask:ground" }));
  });

  it("5. bounded — structured no máximo 1× em todos os casos", async () => {
    structured.mockResolvedValue({ composta: true, sub_perguntas: ["a", "b"] });
    await groundQuestion("home", "q");
    expect(structured.mock.calls.length).toBeLessThanOrEqual(1);
  });
});
