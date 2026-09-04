/** INVARIANTE (M18/S2, LEI III): `askStream` é o IRMÃO STREAMADO do ask() — recuperação IDÊNTICA, mas
 *  síntese em PROSA streamada (streamProse + SYSTEM_STREAM), NÃO a SYNTH_TOOL/verifyAnswer. Estes testes
 *  provam, SEM rede e SEM Postgres (mocks dos módulos que ask.ts importa), que:
 *   1. carga vazia honesta: home sem hits (retrieve→[]) → { sources:[], gaps:["nenhuma fonte encontrada"] }
 *      e `streamProse` NÃO é chamado (nenhum token de prosa).
 *   2. fluxo de tokens: retrieve com slugs + streamProse emitindo 3 deltas → onToken recebe os 3 na ORDEM;
 *      retorno traz sources = os slugs, gaps:[], provider.
 *   3. SYSTEM_STREAM ≠ SYNTH_TOOL: a síntese streamada usa streamProse com SYSTEM_STREAM (prosa) e NUNCA
 *      invoca structuredSynthesis (o caminho verificado do ask()). ask() M17 permanece intocado.
 *  Sem LLM real (invariante #9: o stream REAL é o HTC do M18). */
import { describe, it, expect, vi, beforeEach } from "vitest";

// --- mocks dos módulos que ask.ts importa (vi.mock é HOISTADO; vi.hoisted cria as fns antes) ---
const {
  retrieve, getPage, semanticSearch, config, resolveProvider, structuredSynthesis, streamProse, getEngine,
} = vi.hoisted(() => ({
  retrieve: vi.fn(),
  getPage: vi.fn(async () => null),
  semanticSearch: vi.fn(async () => []),
  config: vi.fn(() => ({ provider: "api", synthModel: "synth-model", cliModel: "cli-model" })),
  resolveProvider: vi.fn((p?: string) => (p === "cli" ? "cli" : "api")),
  structuredSynthesis: vi.fn(), // o caminho VERIFICADO do ask() — NÃO deve ser chamado por askStream
  streamProse: vi.fn(),
  // engine sem fatos: currentFacts/timeline vazios → factsForQuery/fatosVigentes devolvem bloco vazio.
  getEngine: vi.fn(async () => ({
    currentFacts: async () => [],
    timeline: async () => [],
    pagesBySlug: async () => new Map(),
  })),
}));

vi.mock("../../src/core/retrieval/query.ts", () => ({ retrieve, getPage }));
vi.mock("../../src/core/retrieval/embeddings.ts", () => ({ semanticSearch }));
vi.mock("../../src/core/platform/config.ts", () => ({ config }));
vi.mock("../../src/core/platform/engine.ts", () => ({ getEngine }));
vi.mock("../../src/lib/llm.ts", () => ({ resolveProvider, structuredSynthesis, streamProse }));

import { askStream } from "../../src/core/retrieval/ask.ts";

beforeEach(() => {
  vi.clearAllMocks();
  config.mockReturnValue({ provider: "api", synthModel: "synth-model", cliModel: "cli-model" });
  resolveProvider.mockImplementation((p?: string) => (p === "cli" ? "cli" : "api"));
  getEngine.mockResolvedValue({
    currentFacts: async () => [],
    timeline: async () => [],
    pagesBySlug: async () => new Map(),
  } as any);
});

describe("askStream — carga ancorada + tokens streamados (M18/S2)", () => {
  it("1. carga vazia honesta: sem hits → não chama streamProse, devolve gap honesto", async () => {
    retrieve.mockResolvedValue([]);
    const tokens: string[] = [];

    const payload = await askStream("home", "qualquer coisa", (d) => tokens.push(d));

    expect(payload).toEqual({ sources: [], gaps: ["nenhuma fonte encontrada"] });
    expect(streamProse).not.toHaveBeenCalled();
    expect(structuredSynthesis).not.toHaveBeenCalled();
    expect(tokens).toEqual([]);
  });

  it("2. fluxo de tokens: 3 deltas repassados na ordem; sources = slugs; gaps:[]", async () => {
    retrieve.mockResolvedValue([
      { slug: "fonte-a", date: "2024-01-01", excerpt: "trecho A" },
      { slug: "fonte-b", date: "2024-02-01", excerpt: "trecho B" },
    ]);
    // streamProse emite 3 deltas via onToken (incremental) e devolve a concatenação.
    streamProse.mockImplementation(async (_opts: any, onToken: (d: string) => void) => {
      for (const d of ["Bru", "no", " Canguçu"]) onToken(d);
      return "Bruno Canguçu";
    });
    const tokens: string[] = [];

    const payload = await askStream("home", "Quem é o Bruno?", (d) => tokens.push(d));

    expect(tokens).toEqual(["Bru", "no", " Canguçu"]); // na ORDEM, incremental
    expect(payload.sources).toEqual(["fonte-a", "fonte-b"]); // = hits.map(h=>h.slug), idêntico ao ask()
    expect(payload.gaps).toEqual([]);
    expect(payload.provider).toBe("api");
    expect(streamProse).toHaveBeenCalledTimes(1);
  });

  it("3. SYSTEM_STREAM (prosa) — NÃO usa structuredSynthesis/verifyAnswer; modelo = synthModel (api)", async () => {
    retrieve.mockResolvedValue([{ slug: "fonte-a", date: "2024-01-01", excerpt: "trecho A" }]);
    streamProse.mockImplementation(async (_opts: any, onToken: (d: string) => void) => {
      onToken("ok");
      return "ok";
    });

    await askStream("home", "pergunta", () => {});

    expect(structuredSynthesis).not.toHaveBeenCalled(); // caminho verificado do ask() NÃO é tocado
    const [opts] = streamProse.mock.calls[0];
    expect(opts.model).toBe("synth-model"); // right-size: synthModel no provider api (igual ao ask())
    expect(opts.provider).toBe("api");
    // SYSTEM_STREAM é prosa ancorada (cita [n], seção Lacunas) — NÃO o system de claims/quote do M17.
    expect(opts.system).toMatch(/Cite as fontes como \[n\]/);
    expect(opts.system).toMatch(/Lacunas:/);
    expect(opts.system).not.toMatch(/CLAIMS/); // não é o SYSTEM estruturado/verificado
    expect(opts.prompt).toContain("pergunta"); // a pergunta vai no prompt
  });

  it("4. provider cli → modelo = cliModel (mesmo right-size do ask())", async () => {
    config.mockReturnValue({ provider: "cli", synthModel: "synth-model", cliModel: "cli-model" } as any);
    resolveProvider.mockReturnValue("cli");
    retrieve.mockResolvedValue([{ slug: "fonte-a", date: "2024-01-01", excerpt: "trecho A" }]);
    streamProse.mockImplementation(async (_opts: any, onToken: (d: string) => void) => {
      onToken("full");
      return "full";
    });

    const payload = await askStream("home", "pergunta", () => {});

    const [opts] = streamProse.mock.calls[0];
    expect(opts.model).toBe("cli-model");
    expect(opts.provider).toBe("cli");
    expect(payload.provider).toBe("cli");
  });
});
