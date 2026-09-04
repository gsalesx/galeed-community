/** M23-A (§4.4) — ask()/askStream() fim-a-fim com módulos MOCADOS (sem rede, sem Postgres).
 *  ground.ts/entity-attr.ts rodam REAIS (detector determinístico de verdade); só `structured`
 *  (grounding/confirm) e a síntese são mocados. Prova: pergunta SIMPLES = zero LLM extra (o
 *  orçamento), composta rotulada (o gate), M17 intacto, fail-open, surfacing, temporal compõe,
 *  askStream recebe o mesmo contexto, ambígua paga 1 Haiku. */
import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  retrieve, getPage, semanticSearch, config, resolveProvider, structuredSynthesis, streamProse, structured, getEngine, recordUsage,
} = vi.hoisted(() => ({
  retrieve: vi.fn(),
  getPage: vi.fn(async () => null),
  semanticSearch: vi.fn(async () => []),
  config: vi.fn(() => ({ provider: "api", apiModel: "claude-haiku-4-5-20251001", synthModel: "synth-model", cliModel: "cli-model" })),
  resolveProvider: vi.fn((p?: string) => (p === "cli" ? "cli" : "api")),
  structuredSynthesis: vi.fn(),
  streamProse: vi.fn(),
  structured: vi.fn(),
  getEngine: vi.fn(),
  recordUsage: vi.fn(async () => {}),
}));

vi.mock("../../src/core/retrieval/query.ts", () => ({ retrieve, getPage }));
vi.mock("../../src/core/retrieval/embeddings.ts", () => ({ semanticSearch }));
vi.mock("../../src/core/platform/config.ts", () => ({ config }));
vi.mock("../../src/core/platform/engine.ts", () => ({ getEngine }));
vi.mock("../../src/core/platform/usage.ts", () => ({ recordUsage }));
vi.mock("../../src/lib/llm.ts", () => ({ resolveProvider, structuredSynthesis, streamProse, structured }));

import { ask, askStream } from "../../src/core/retrieval/ask.ts";

const SLUG = "chat-m23a-consulta-1";

// fixture em memória (shape FactHit) — currentFacts + timeline servem a mesma série.
function factsFixture() {
  const mk = (entity: string, predicate: string, value: string, opts: Partial<any> = {}) => ({
    source_slug: SLUG, type: "reunioes", dimension: "decisions", text: "", quote: "",
    entity, predicate, value, value_num: opts.value_num ?? null, unit: opts.unit ?? "",
    period: opts.period ?? "", tier: "", valid_from: opts.valid_from ?? "2024-01-01",
    valid_to: opts.valid_to ?? "", confidence: 0.7, status: "fato",
  });
  return [
    mk("accelera", "preco", "R$ 3 mil", { value_num: 3000, unit: "BRL", period: "monthly", valid_from: "2023-08-10", valid_to: "2024-01-15" }),
    mk("accelera", "preco", "R$ 5 mil", { value_num: 5000, unit: "BRL", period: "monthly", valid_from: "2024-01-15", valid_to: "2024-03-20" }),
    mk("accelera", "preco", "R$ 12 mil", { value_num: 12000, unit: "BRL", period: "monthly", valid_from: "2024-03-20", valid_to: "2024-06-05" }),
    mk("accelera", "preco", "R$ 18 mil", { value_num: 18000, unit: "BRL", period: "monthly", valid_from: "2024-06-05", valid_to: "2025-01-10" }),
    mk("accelera", "preco", "R$ 30 mil", { value_num: 30000, unit: "BRL", period: "monthly", valid_from: "2025-01-10", valid_to: "" }),
    mk("teobaldo", "aluno_de", "accelera 360", { valid_from: "2024-04-02" }),
    mk("eduardo-marinho", "plano", "Pocket", { valid_from: "2024-05-10" }),
    mk("eduardo-marinho", "aluno_de", "accelera 360", { valid_from: "2024-05-10" }),
  ];
}

function makeEngine() {
  const all = factsFixture();
  const current = all.filter((f) => f.valid_to === "");
  return {
    currentFacts: async () => current,
    timeline: async (entity: string) => all.filter((f) => f.entity === entity),
    pagesBySlug: async () => new Map(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  config.mockReturnValue({ provider: "api", apiModel: "claude-haiku-4-5-20251001", synthModel: "synth-model", cliModel: "cli-model" } as any);
  resolveProvider.mockImplementation((p?: string) => (p === "cli" ? "cli" : "api"));
  getEngine.mockResolvedValue(makeEngine() as any);
  retrieve.mockResolvedValue([{ slug: SLUG, date: "2024-04-02", excerpt: "trecho" }]);
  getPage.mockResolvedValue(null);
  semanticSearch.mockResolvedValue([]);
  structuredSynthesis.mockResolvedValue({ claims: [], gaps: [] });
  streamProse.mockImplementation(async (_o: any, onToken: (d: string) => void) => { onToken("ok"); return "ok"; });
});

function synthPrompt() {
  return structuredSynthesis.mock.calls[0][0].prompt as string;
}

describe("M23-A router (ask/askStream) — §4.4", () => {
  it("1. simples = zero LLM extra (O ORÇAMENTO)", async () => {
    await ask("home", "qual o preço da accelera?");
    expect(structured).toHaveBeenCalledTimes(0);
    expect(structuredSynthesis).toHaveBeenCalledTimes(1);
    const p = synthPrompt();
    expect(p).toContain("FATOS (verdade estruturada");
    for (const vn of ["3000", "5000", "12000", "18000", "30000"]) expect(p).toContain(vn);
  });

  it("2. composta rotulada (O GATE, determinístico)", async () => {
    structured.mockResolvedValue({ composta: true, sub_perguntas: ["quando o teobaldo entrou na accelera?", "qual era o preço da accelera?"] });
    await ask("home", "quanto custava a accelera quando o teobaldo entrou?");
    const p = synthPrompt();
    expect(p).toContain("PERGUNTA COMPOSTA (decomposta em sub-perguntas");
    expect(p).toContain("[S1] quando o teobaldo entrou na accelera?");
    expect(p).toContain("[S2] qual era o preço da accelera?");
    expect(p).toContain("desde 2024-04-02");
    expect(p).toContain("12000");
    expect(structured).toHaveBeenCalledTimes(1);
  });

  it("3. M17 intacto na composta — quote do fato 12000 verifica, resposta cita [fatos]", async () => {
    structured.mockResolvedValue({ composta: true, sub_perguntas: ["quando o teobaldo entrou na accelera?", "qual era o preço da accelera?"] });
    // 1ª passada captura o prompt; depois extraímos a linha EXATA do fato 12000 e respondemos.
    let prompt = "";
    structuredSynthesis.mockImplementation(async (o: any) => {
      prompt = o.prompt;
      const linha = (o.prompt as string).split("\n").find((l: string) => l.includes("12000"))!;
      return { claims: [{ text: "O Teobaldo entrou em 2024-04-02, quando o preço era R$ 12 mil.", cite_slug: "__facts__", quote: linha }], gaps: [] };
    });
    const r = await ask("home", "quanto custava a accelera quando o teobaldo entrou?");
    expect(prompt).toContain("12000");
    expect(r.answer).toContain("R$ 12 mil");
    expect(r.answer).toContain("[fatos]");
  });

  it("4. fail-open — composta=false → single-shot original (FATOS, sem PERGUNTA COMPOSTA)", async () => {
    structured.mockResolvedValue({ composta: false, sub_perguntas: [] });
    await ask("home", "quanto custava a accelera quando o teobaldo entrou?");
    const p = synthPrompt();
    expect(p).toContain("FATOS (verdade estruturada");
    expect(p).not.toContain("PERGUNTA COMPOSTA");
    expect(structured).toHaveBeenCalledTimes(1);
  });

  it("5. surfacing no ask — nota de atributos, fato plano/Pocket, structured 0× (candidata única)", async () => {
    await ask("home", "quem é o aluno que fechou o pocket?");
    const p = synthPrompt();
    expect(p).toContain("(entidade localizada por atributos: eduardo-marinho — a pergunta a descreve sem nomear)");
    expect(p).toContain("Pocket");
    expect(structured).toHaveBeenCalledTimes(0);
  });

  it("6. temporal compõe com grounding — sub-bloco S2 com recorte 2024-03 e 12000, sem 30000", async () => {
    structured.mockResolvedValue({ composta: true, sub_perguntas: ["quando o teobaldo entrou na accelera?", "qual era o preço da accelera em março de 2024?"] });
    await ask("home", "quanto custava a accelera quando o teobaldo entrou?");
    const p = synthPrompt();
    expect(p).toContain("recorte temporal da pergunta: 2024-03");
    expect(p).toContain("12000");
    // o sub-bloco S2 (do "·" de S2 em diante) não contém 30000
    const s2 = p.slice(p.indexOf("[S2]"));
    expect(s2).not.toContain("30000");
  });

  it("7. askStream recebe o MESMO contexto rotulado", async () => {
    structured.mockResolvedValue({ composta: true, sub_perguntas: ["quando o teobaldo entrou na accelera?", "qual era o preço da accelera?"] });
    await askStream("home", "quanto custava a accelera quando o teobaldo entrou?", () => {});
    const p = streamProse.mock.calls[0][0].prompt as string;
    expect(p).toContain("PERGUNTA COMPOSTA");
    expect(p).toContain("[S1]");
    expect(p).toContain("[S2]");
  });

  it("8. ambígua — 2 entidades independentes casadas, composta=false → paga 1 Haiku, caminho atual", async () => {
    structured.mockResolvedValue({ composta: false, sub_perguntas: [] });
    await ask("home", "qual a diferença da accelera para o teobaldo?");
    expect(structured).toHaveBeenCalledTimes(1); // confirmação barata do CTO
    const p = synthPrompt();
    expect(p).not.toContain("PERGUNTA COMPOSTA");
  });
});
