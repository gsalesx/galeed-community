/** M24-E — unit do bloco "PERCEPÇÕES DO CÉREBRO" no ask (§6.1). SEM IO/LLM (vi.mock + vi.hoisted,
 *  LEARNINGS M18/S2). Prova: match positivo monta o bloco; sem match = "" (1 query, zero LLM);
 *  prompt BYTE-IDÊNTICO ao pré-M24 quando não casa (o canário da LEI V); teto K + ordenação;
 *  fail-open; verify/render com [percepção]. verifyAnswer é REAL (puro). */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { retrieve, getPage, semanticSearch, config, resolveProvider, structuredSynthesis, streamProse, getEngine, recordUsage } =
  vi.hoisted(() => ({
    retrieve: vi.fn(),
    getPage: vi.fn(async () => null),
    semanticSearch: vi.fn(async () => []),
    config: vi.fn(() => ({ provider: "api", synthModel: "synth-model", cliModel: "cli-model", apiModel: "haiku" })),
    resolveProvider: vi.fn((p?: string) => (p === "cli" ? "cli" : "api")),
    structuredSynthesis: vi.fn(async () => ({ claims: [], gaps: [] })),
    streamProse: vi.fn(),
    getEngine: vi.fn(),
    recordUsage: vi.fn(async () => {}),
  }));

vi.mock("../../src/core/retrieval/query.ts", () => ({ retrieve, getPage }));
vi.mock("../../src/core/retrieval/embeddings.ts", () => ({ semanticSearch }));
vi.mock("../../src/core/platform/config.ts", () => ({ config }));
vi.mock("../../src/core/platform/engine.ts", () => ({ getEngine }));
vi.mock("../../src/core/platform/usage.ts", () => ({ recordUsage }));
vi.mock("../../src/lib/llm.ts", () => ({ resolveProvider, structuredSynthesis, streamProse }));
// ground/entity-attr: caminho simples (sem decomposição, sem surfacing).
vi.mock("../../src/core/retrieval/ground.ts", () => ({
  detectComposite: () => "simples",
  groundQuestion: async () => null,
  independentEntities: () => [],
}));
vi.mock("../../src/core/retrieval/entity-attr.ts", () => ({ surfaceEntity: async () => undefined }));

import { ask, askStream, percepcoesForQuery } from "../../src/core/retrieval/ask.ts";

const percep = (over: any = {}) => ({
  id: "id1", classe: "tendencia", severidade: "alta", entity: "accelera", predicate: "preco", tier: "",
  texto: "O preço da accelera subiu 900%.", numbers: { pctTotal: 900, magnitude: 900 },
  cites: [{ source_slug: "p1", entity: "accelera", predicate: "preco", tier: "", valid_from: "2025-01-01", quote: "" }],
  estado: "viva", created_at: "2026-06-10T03:12:00.000Z", validated_at: null, ...over,
});

// engine fake: currentFacts/timeline vazios (caminho simples sem fatos), pagesBySlug vazio,
// listPercepcoes controlado por teste.
function mkEngine(percepcoes: any[]) {
  return {
    currentFacts: async () => [],
    timeline: async () => [],
    pagesBySlug: async () => new Map(),
    listPercepcoes: vi.fn(async () => percepcoes),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  config.mockReturnValue({ provider: "api", synthModel: "synth-model", cliModel: "cli-model", apiModel: "haiku" });
  resolveProvider.mockImplementation((p?: string) => (p === "cli" ? "cli" : "api"));
});

describe("M24-E percepcoesForQuery", () => {
  it("1. match positivo: bloco com header, texto, numbers, sono e cites; termina em \\n\\n---\\n\\n", async () => {
    getEngine.mockResolvedValue(mkEngine([percep()]) as any);
    const bloco = await percepcoesForQuery("home", "como evoluiu o preço da accelera?");
    expect(bloco).toContain("PERCEPÇÕES DO CÉREBRO");
    expect(bloco).toContain("O preço da accelera subiu 900%.");
    expect(bloco).toContain("sono de 2026-06-10");
    expect(bloco).toContain("pctTotal=900");
    expect(bloco).toContain("p1");
    expect(bloco.endsWith("\n\n---\n\n")).toBe(true);
  });

  it("2. sem match = vazio (listPercepcoes chamado 1×, zero LLM)", async () => {
    const e = mkEngine([percep()]);
    getEngine.mockResolvedValue(e as any);
    const bloco = await percepcoesForQuery("home", "qual a meta da nortex?");
    expect(bloco).toBe("");
    expect(e.listPercepcoes).toHaveBeenCalledTimes(1);
    expect(structuredSynthesis).not.toHaveBeenCalled();
  });

  it("5. teto K e ordenação: predicado quente (preco) 1º, depois severidade; K linhas", async () => {
    const ps = [
      percep({ id: "a", predicate: "faturamento", severidade: "baixa", texto: "BAIXA-A" }),
      percep({ id: "b", predicate: "preco", severidade: "media", texto: "PRECO-B" }), // predicado quente
      percep({ id: "c", predicate: "outro", severidade: "alta", texto: "ALTA-C" }),
      percep({ id: "d", predicate: "x", severidade: "media", texto: "MEDIA-D" }),
      percep({ id: "e", predicate: "y", severidade: "baixa", texto: "BAIXA-E" }),
    ];
    getEngine.mockResolvedValue(mkEngine(ps) as any);
    const bloco = await percepcoesForQuery("home", "como evoluiu o preço da accelera?");
    const linhas = bloco.split("\n").filter((l) => l.startsWith("- ["));
    expect(linhas.length).toBe(3); // PERCEP_BLOCK_K default
    // o de predicate "preco" (casa a pergunta) vem 1º, mesmo com severidade media.
    expect(linhas[0]).toContain("PRECO-B");
    // entre os não-quentes, severidade alta (ALTA-C) vem antes da media.
    expect(linhas[1]).toContain("ALTA-C");
  });

  it("6. fail-open: listPercepcoes lança → \"\" (não propaga)", async () => {
    getEngine.mockResolvedValue({ ...mkEngine([]), listPercepcoes: async () => { throw new Error("db down"); } } as any);
    const bloco = await percepcoesForQuery("home", "preço accelera");
    expect(bloco).toBe("");
  });
});

describe("M24-E ask — prompt byte-idêntico (LEI V)", () => {
  beforeEach(() => {
    retrieve.mockResolvedValue([{ slug: "fonte-a", date: "2024-01-01", excerpt: "trecho A" }]);
  });

  it("3. sem match: prompt do structuredSynthesis = pré-M24 EXATO (vigentes vazio, sem bloco percep)", async () => {
    // (a) sem percepções
    getEngine.mockResolvedValue(mkEngine([]) as any);
    await ask("home", "qual a meta da nortex?");
    const promptA = structuredSynthesis.mock.calls[0][0].prompt;
    structuredSynthesis.mockClear();
    // (b) percepções que NÃO casam a pergunta
    getEngine.mockResolvedValue(mkEngine([percep({ entity: "outracoisa" })]) as any);
    await ask("home", "qual a meta da nortex?");
    const promptB = structuredSynthesis.mock.calls[0][0].prompt;
    expect(promptA).toBe(promptB);
    // o shape pré-M24: Pergunta + Contexto:\n${vigentes=""}${ctx}
    const ctx = "[1] (fonte-a, 2024-01-01)\ntrecho A";
    expect(promptB).toBe(`Pergunta: qual a meta da nortex?\n\nContexto:\n${ctx}`);
  });

  it("4. com match: o bloco entra ENTRE vigentes e ctx", async () => {
    getEngine.mockResolvedValue(mkEngine([percep()]) as any);
    await ask("home", "como evoluiu o preço da accelera?");
    const prompt = structuredSynthesis.mock.calls[0][0].prompt;
    expect(prompt).toContain("PERCEPÇÕES DO CÉREBRO");
    const ctx = "[1] (fonte-a, 2024-01-01)\ntrecho A";
    // vigentes="" → Contexto:\n<bloco percep>...---\n\n<ctx>
    expect(prompt.startsWith("Pergunta: como evoluiu o preço da accelera?\n\nContexto:\nPERCEPÇÕES DO CÉREBRO")).toBe(true);
    expect(prompt.endsWith(ctx)).toBe(true);
  });

  it("8. render: claim citando __percepcoes__ sobrevive e renderiza [percepção]; sem bloco → no-cite", async () => {
    getEngine.mockResolvedValue(mkEngine([percep()]) as any);
    // monta o quote = a linha do bloco (verbatim) pra passar o verifyAnswer real.
    const bloco = await percepcoesForQuery("home", "como evoluiu o preço da accelera?");
    const linha = bloco.split("\n").find((l) => l.startsWith("- ["))!;
    structuredSynthesis.mockResolvedValue({
      claims: [{ text: "O cérebro percebeu que o preço subiu 900%.", cite_slug: "__percepcoes__", quote: linha }],
      gaps: [],
    });
    const r = await ask("home", "como evoluiu o preço da accelera?");
    expect(r.answer).toContain("[percepção]");
  });
});
