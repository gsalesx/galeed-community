import { describe, expect, it } from "vitest";
import { normalizeLlmChain } from "../../src/core/platform/llm-chain.ts";
import { isTransientLlmError, resolveExtractionProvider } from "../../src/lib/llm.ts";

describe("normalizeLlmChain", () => {
  it("completa slots faltando e ignora id desconhecido", () => {
    const slots = normalizeLlmChain([{ id: "openai", enabled: false }, { id: "foo" }]);
    expect(slots.map((s) => s.id)).toEqual(["openai", "chatgpt", "anthropic", "qwen"]);
    expect(slots[0]?.enabled).toBe(false);
  });
});

describe("isTransientLlmError", () => {
  it("reconhece timeout, 429 e cadeia esgotada", () => {
    expect(isTransientLlmError("OpenAI timeout")).toBe(true);
    expect(isTransientLlmError("Anthropic 429: rate")).toBe(true);
    expect(isTransientLlmError("Todas as IAs da cadeia falharam. chatgpt: 503")).toBe(true);
    expect(isTransientLlmError("o filtro tem um campo sem nome.")).toBe(false);
  });
});

describe("resolveExtractionProvider", () => {
  it("não aborta antes da cadeia — devolve cli ou api, nunca throw", () => {
    expect(() => resolveExtractionProvider("auto")).not.toThrow();
    expect(["cli", "api"]).toContain(resolveExtractionProvider("auto"));
  });
});
