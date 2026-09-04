/** P1-B (mata A3 / A2c) — ask() fim-a-fim com módulos mocados (vi.mock + vi.hoisted, padrão de
 *  ask-stream-payload.test.ts): o caso canônico TEMPORAL do preço da Accelera (§2.4/§2.5 / §4.4
 *  da DESIGN-SPEC). Prova, sem rede e sem Postgres, que o recorte asOf chega ao prompt, que a
 *  série não é decapitada, que o dedupe de fatosVigentes é determinístico, e que verifyAnswer/
 *  M17 seguem intactos. */
import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  retrieve, getPage, semanticSearch, config, resolveProvider, structuredSynthesis, streamProse, getEngine,
} = vi.hoisted(() => ({
  retrieve: vi.fn(),
  getPage: vi.fn(async () => null),
  semanticSearch: vi.fn(async () => []),
  config: vi.fn(() => ({ provider: "api", synthModel: "synth-model", cliModel: "cli-model" })),
  resolveProvider: vi.fn((p?: string) => (p === "cli" ? "cli" : "api")),
  structuredSynthesis: vi.fn(),
  streamProse: vi.fn(),
  getEngine: vi.fn(),
}));

vi.mock("../../src/core/retrieval/query.ts", () => ({ retrieve, getPage }));
vi.mock("../../src/core/retrieval/embeddings.ts", () => ({ semanticSearch }));
vi.mock("../../src/core/platform/config.ts", () => ({ config }));
vi.mock("../../src/core/platform/engine.ts", () => ({ getEngine }));
vi.mock("../../src/lib/llm.ts", () => ({ resolveProvider, structuredSynthesis, streamProse }));

import { ask } from "../../src/core/retrieval/ask.ts";

interface FH {
  source_slug: string;
  type: string;
  dimension: string;
  text: string;
  quote: string;
  entity: string;
  predicate: string;
  value: string;
  value_num: number | null;
  unit: string;
  period: string;
  tier: string;
  valid_from: string;
  valid_to: string;
  confidence: number;
  status: string;
}

const SLUG = "reuniao-p1b-consulta";
function fh(p: Partial<FH>): FH {
  return {
    source_slug: SLUG, type: "reunioes", dimension: "decisions", text: "", quote: "",
    entity: "accelera", predicate: "preco", value: "", value_num: null, unit: "BRL",
    period: "monthly", tier: "", valid_from: "", valid_to: "", confidence: 0.7, status: "fato", ...p,
  };
}

// 5 degraus de preco (com valid_to encadeado) + 65 de ruído (mesma entidade).
function fixture70(): FH[] {
  const out: FH[] = [];
  const preco: Array<[string, number, string, string]> = [
    ["R$ 3 mil", 3000, "2023-08-10", "2024-01-15"],
    ["R$ 5 mil", 5000, "2024-01-15", "2024-03-20"],
    ["R$ 12 mil", 12000, "2024-03-20", "2024-06-05"],
    ["R$ 18 mil", 18000, "2024-06-05", "2025-01-10"],
    ["R$ 30 mil", 30000, "2025-01-10", ""],
  ];
  for (const [value, vn, vf, vt] of preco)
    out.push(fh({ predicate: "preco", value, value_num: vn, valid_from: vf, valid_to: vt }));
  const day = (i: number) => `2024-01-${String((i % 28) + 1).padStart(2, "0")}`;
  for (let i = 0; i < 10; i++) out.push(fh({ predicate: "aluno_de", value: `aluno-${i}`, valid_from: day(i) }));
  for (let i = 0; i < 30; i++) out.push(fh({ predicate: "clientes", value: `cliente-${i}`, valid_from: day(i) }));
  for (let i = 0; i < 25; i++) out.push(fh({ predicate: "mrr", value: `mrr-${i}`, valid_from: day(i) }));
  return out;
}

// currentFacts() = só os vigentes (valid_to == ""). Aqui: o degrau 30000 + os de ruído com valid_to "".
// Pra simplificar e bater com o engine, currentFacts devolve os vigentes; timeline devolve TUDO.
function currentOf(all: FH[]): FH[] {
  return all.filter((f) => f.valid_to === "");
}

function mockEngine(all: FH[]) {
  getEngine.mockResolvedValue({
    currentFacts: async () => currentOf(all),
    timeline: async (_e: string, _o: any) => all,
    pagesBySlug: async () => new Map(),
  } as any);
}

beforeEach(() => {
  vi.clearAllMocks();
  config.mockReturnValue({ provider: "api", synthModel: "synth-model", cliModel: "cli-model" });
  resolveProvider.mockImplementation((p?: string) => (p === "cli" ? "cli" : "api"));
  retrieve.mockResolvedValue([{ slug: SLUG, date: "2024-03-20", excerpt: "trecho" }]);
  semanticSearch.mockResolvedValue([]);
  structuredSynthesis.mockResolvedValue({ claims: [], gaps: [] });
});

// captura o prompt enviado à síntese
function lastPrompt(): string {
  return structuredSynthesis.mock.calls[0][0].prompt as string;
}

describe("ask() — recorte temporal + corte por relevância (P1-B/§4.4)", () => {
  it("1+2. caso canônico: prompt recortado em 2024-03, contém 12000, exclui 30000/5000; resposta cita [fatos]", async () => {
    mockEngine(fixture70());
    // o claim usa a linha EXATA do fato 12000 extraída do prompt capturado (verifyAnswer precisa do quote literal)
    structuredSynthesis.mockImplementation(async (opts: any) => {
      const linha = (opts.prompt as string).split("\n").find((l: string) => l.includes("12000"))!;
      return { claims: [{ text: "Em março de 2024 o preço era R$ 12 mil.", cite_slug: "__facts__", quote: linha }], gaps: [] };
    });

    const r = await ask("home", "qual era o preço da accelera em março de 2024?");
    const prompt = lastPrompt();

    expect(prompt).toContain("FATOS (recorte temporal da pergunta: 2024-03");
    expect(prompt).toContain("12000");
    expect(prompt).not.toContain("30000");
    expect(prompt).not.toContain("(5000"); // o degrau 5000 (valid_to 2024-03-20 ≤ asOf) sai
    // resposta fim-a-fim: verifyAnswer aceitou o quote contra __facts__
    expect(r.answer).toContain("R$ 12 mil");
    expect(r.answer).toContain("[fatos]");
  });

  it("3. 'em 2023' → degrau de 2023 (3000), exclui 12000/30000", async () => {
    mockEngine(fixture70());
    await ask("home", "qual era o preço da accelera em 2023?");
    const prompt = lastPrompt();
    expect(prompt).toContain("3000");
    expect(prompt).not.toContain("12000");
    expect(prompt).not.toContain("30000");
  });

  it("4. sem recorte → header normal, TODOS os 5 degraus presentes (série não decapitada)", async () => {
    mockEngine(fixture70());
    await ask("home", "qual o preço da accelera?");
    const prompt = lastPrompt();
    expect(prompt).toContain("FATOS (verdade estruturada");
    for (const vn of ["3000", "5000", "12000", "18000", "30000"]) expect(prompt).toContain(vn);
  });

  it("5. recorte sem fato no ponto → fallback (header normal)", async () => {
    mockEngine(fixture70());
    await ask("home", "qual era o preço da accelera em março de 2020?");
    const prompt = lastPrompt();
    expect(prompt).toContain("FATOS (verdade estruturada");
  });

  it("6. substring morta no fluxo real: 'aceleradora' não casa entidade → sem header de fatos estruturados", async () => {
    mockEngine(fixture70());
    await ask("home", "o que a aceleradora fez?");
    const prompt = lastPrompt();
    expect(prompt).not.toContain("FATOS (verdade estruturada");
  });

  it("7. dedupe determinístico do fatosVigentes (A2c): vence o valid_from mais recente nas 2 ordens", async () => {
    // entidade que a pergunta NÃO casa (cai no fatosVigentes via sources do retrieve), mesmo
    // (entity,predicate,tier) vigente em DUPLICATA com valid_from distintos e source_slugs distintos.
    const dupA = fh({ entity: "fulano", predicate: "cargo", value: "diretor", source_slug: "dup-a-p1b-consulta", valid_from: "2023-01-01", valid_to: "" });
    const dupB = fh({ entity: "fulano", predicate: "cargo", value: "ceo", source_slug: "dup-b-p1b-consulta", valid_from: "2024-01-01", valid_to: "" });
    retrieve.mockResolvedValue([
      { slug: "dup-a-p1b-consulta", date: "2023-01-01", excerpt: "t" },
      { slug: "dup-b-p1b-consulta", date: "2024-01-01", excerpt: "t" },
    ]);

    // pergunta que NÃO casa nenhuma entidade → cai no caminho fatosVigentes (via sources do retrieve).
    const runV = async (arr: FH[]) => {
      vi.clearAllMocks();
      retrieve.mockResolvedValue([
        { slug: "dup-a-p1b-consulta", date: "2023-01-01", excerpt: "t" },
        { slug: "dup-b-p1b-consulta", date: "2024-01-01", excerpt: "t" },
      ]);
      semanticSearch.mockResolvedValue([]);
      config.mockReturnValue({ provider: "api", synthModel: "synth-model", cliModel: "cli-model" });
      resolveProvider.mockImplementation((p?: string) => (p === "cli" ? "cli" : "api"));
      structuredSynthesis.mockResolvedValue({ claims: [], gaps: [] });
      getEngine.mockResolvedValue({
        currentFacts: async () => arr,
        timeline: async () => arr,
        pagesBySlug: async () => new Map(),
      } as any);
      await ask("home", "qual a novidade?"); // não casa nenhuma entidade → fatosVigentes
      return structuredSynthesis.mock.calls[0][0].prompt as string;
    };

    const p1 = await runV([dupA, dupB]);
    const p2 = await runV([dupB, dupA]);
    // vence o mais recente (ceo, 2024) em AMBAS as ordens
    for (const p of [p1, p2]) {
      expect(p).toContain("FATOS VIGENTES");
      expect(p).toContain("ceo");
      expect(p).not.toContain("diretor");
    }
  });
});
