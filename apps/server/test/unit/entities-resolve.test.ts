/** Fix sobre-fusão de entidades (#R3) — desempate + orquestração (engine/LLM/config MOCKADOS).
 *  Cobre: normalizePartition (pura), disambiguateGroup (conservador ZERO-LLM, LLM aplica, cache hit,
 *  fail-soft) e resolveEntities (forte sempre; ambíguo conservador vs desempatado; ANTI-UNDER-MERGE).
 *  Padrão do repo: vi.hoisted p/ mocks; vi.mock de lib/llm.ts (structured/prose/resolveProvider),
 *  config.ts e engine.ts (getEngine). Nada toca banco. */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => {
  const state = {
    extractions: [] as any[],
    resolveMap: {} as Record<string, string>,
    disambigCache: new Map<string, string[][]>(),
  };
  const engine = {
    allExtractions: vi.fn(async () => state.extractions),
    putEntityResolve: vi.fn(async (m: Record<string, string>) => {
      state.resolveMap = m;
    }),
    getEntityDisambig: vi.fn(async (k: string) => state.disambigCache.get(k) ?? null),
    putEntityDisambig: vi.fn(async (k: string, d: string[][]) => {
      state.disambigCache.set(k, d);
    }),
  };
  return {
    state,
    engine,
    structured: vi.fn(),
    prose: vi.fn(),
    resolveProvider: vi.fn((_p?: string) => "api"),
    config: vi.fn(() => ({ provider: "api", apiModel: "claude-haiku-4-5", cliModel: "haiku", synthModel: "s" })),
    getEngine: vi.fn(async (_home: string) => engine),
  };
});

vi.mock("../../src/lib/llm.ts", () => ({ structured: h.structured, prose: h.prose, resolveProvider: h.resolveProvider }));
vi.mock("../../src/core/platform/config.ts", () => ({ config: h.config }));
vi.mock("../../src/core/platform/engine.ts", () => ({ getEngine: h.getEngine }));

import { disambiguateGroup, normalizePartition, resolveEntities } from "../../src/core/memory/entities.ts";

/** monta uma extração cujas contagens por entidade batem `counts` (base da entityFrequency). */
function extractionsFor(counts: Record<string, number>): any[] {
  const items: any[] = [];
  for (const [ent, n] of Object.entries(counts)) for (let i = 0; i < n; i++) items.push({ entity: ent });
  return [{ source_slug: "s1", extractions: { fatos: items } }];
}

beforeEach(() => {
  vi.clearAllMocks();
  h.state.extractions = [];
  h.state.resolveMap = {};
  h.state.disambigCache = new Map();
  h.resolveProvider.mockReturnValue("api");
  h.config.mockReturnValue({ provider: "api", apiModel: "claude-haiku-4-5", cliModel: "haiku", synthModel: "s" } as any);
});

// ---------------------------------------------------------------------------
// normalizePartition (pura)
// ---------------------------------------------------------------------------
describe("normalizePartition", () => {
  it("ignora nome INVENTADO e completa o faltante como singleton", () => {
    // "zzz" ∉ uniq → descartado (subgrupo vira vazio, sumido); "c" não citado → singleton.
    expect(normalizePartition([["a", "b", "zzz"]], ["a", "b", "c"])).toEqual([["a", "b"], ["c"]]);
  });
  it("deduplica entre subgrupos (1º vence)", () => {
    expect(normalizePartition([["a", "b"], ["b", "c"]], ["a", "b", "c"])).toEqual([["a", "b"], ["c"]]);
  });
  it("normaliza caixa/trim dos nomes da LLM", () => {
    expect(normalizePartition([["A ", " b"]], ["a", "b"])).toEqual([["a", "b"]]);
  });
  it("entrada não-array / lixo → cada nome singleton (não funde)", () => {
    expect(normalizePartition(null, ["a", "b"])).toEqual([["a"], ["b"]]);
    expect(normalizePartition([{}, "x", ["nope"]], ["a"])).toEqual([["a"]]);
  });
});

// ---------------------------------------------------------------------------
// disambiguateGroup
// ---------------------------------------------------------------------------
describe("disambiguateGroup", () => {
  const GRP = ["joão", "joão silva", "joão souza"];

  it("sem provider usável → conservador (cada nome sozinho), ZERO chamada de LLM", async () => {
    const parts = await disambiguateGroup("home", GRP, { provider: "none", allow: true });
    expect(parts).toEqual([["joão"], ["joão silva"], ["joão souza"]]);
    expect(h.structured).toHaveBeenCalledTimes(0);
    expect(h.getEngine).toHaveBeenCalledTimes(0); // nem abre engine no caminho conservador
  });

  it("allow=false → conservador, ZERO chamada de LLM (mesmo com provider api)", async () => {
    const parts = await disambiguateGroup("home", GRP, { provider: "api", allow: false });
    expect(parts).toEqual([["joão"], ["joão silva"], ["joão souza"]]);
    expect(h.structured).toHaveBeenCalledTimes(0);
  });

  it("structured devolve partição → aplica (e cacheia)", async () => {
    h.structured.mockResolvedValue({ grupos: [["joão", "joão silva"], ["joão souza"]] });
    const parts = await disambiguateGroup("home", GRP, { provider: "api", allow: true });
    expect(parts).toEqual([["joão", "joão silva"], ["joão souza"]]);
    expect(h.structured).toHaveBeenCalledTimes(1);
    expect(h.engine.putEntityDisambig).toHaveBeenCalledTimes(1);
  });

  it("cache hit → NÃO chama a LLM na 2ª vez (pergunta 1× e estável)", async () => {
    h.structured.mockResolvedValue({ grupos: [["joão", "joão silva"], ["joão souza"]] });
    const a = await disambiguateGroup("home", GRP, { provider: "api", allow: true });
    const b = await disambiguateGroup("home", GRP, { provider: "api", allow: true });
    expect(b).toEqual(a);
    expect(h.structured).toHaveBeenCalledTimes(1); // só a 1ª chamada bateu na LLM
  });

  it("LLM lança → conservador e NÃO cacheia (re-tenta quando houver LLM)", async () => {
    h.structured.mockRejectedValue(new Error("cli down"));
    const parts = await disambiguateGroup("home", GRP, { provider: "api", allow: true });
    expect(parts).toEqual([["joão"], ["joão silva"], ["joão souza"]]);
    expect(h.engine.putEntityDisambig).toHaveBeenCalledTimes(0); // NÃO cacheou o fracasso
    // 2ª tentativa volta a chamar a LLM (não ficou preso num cache ruim)
    await disambiguateGroup("home", GRP, { provider: "api", allow: true });
    expect(h.structured).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// resolveEntities (mapa alias→canônico)
// ---------------------------------------------------------------------------
describe("resolveEntities — 2 tiers", () => {
  it("FORTE aplica sempre; ANTI-UNDER-MERGE: silvia/sílvia e banco brasil fundem SEM LLM", async () => {
    h.resolveProvider.mockReturnValue("none"); // sem provider → prova que é 100% determinístico
    h.state.extractions = extractionsFor({
      "silvia": 5,
      "sílvia": 2,
      "banco brasil": 4,
      "banco do brasil": 1,
    });
    const r = await resolveEntities("home", { disambiguate: true });
    expect(h.state.resolveMap).toEqual({ "sílvia": "silvia", "banco do brasil": "banco brasil" });
    expect(r.provider).toBe("deterministico");
    expect(h.structured).toHaveBeenCalledTimes(0); // sinal FORTE nunca chama LLM
    expect(h.engine.putEntityResolve).toHaveBeenCalledTimes(1);
  });

  it("AMBÍGUO sem provider = CONSERVADOR: joão souza NÃO funde, ZERO chamada de LLM", async () => {
    h.resolveProvider.mockReturnValue("none");
    h.state.extractions = extractionsFor({ "joão": 3, "joão silva": 2, "joão souza": 1 });
    const r = await resolveEntities("home", { disambiguate: true });
    expect(h.state.resolveMap).toEqual({}); // nada funde — na dúvida não funde
    expect(h.state.resolveMap["joão souza"]).toBeUndefined();
    expect(r.provider).toBe("deterministico");
    expect(h.structured).toHaveBeenCalledTimes(0);
  });

  it("AMBÍGUO com LLM = funde conforme a partição (joão+joão silva; joão souza separado)", async () => {
    h.resolveProvider.mockReturnValue("api");
    h.structured.mockResolvedValue({ grupos: [["joão", "joão silva"], ["joão souza"]] });
    h.state.extractions = extractionsFor({ "joão": 3, "joão silva": 2, "joão souza": 1 });
    const r = await resolveEntities("home", { disambiguate: true });
    expect(h.state.resolveMap).toEqual({ "joão silva": "joão" }); // canônico = mais frequente
    expect(h.state.resolveMap["joão souza"]).toBeUndefined(); // NÃO fundiu o homônimo
    expect(r.provider).toBe("api");
    expect(h.structured).toHaveBeenCalledTimes(1);
    expect(h.engine.putEntityDisambig).toHaveBeenCalledTimes(1); // cacheou a decisão
  });

  it("disambiguate:false desliga o desempate mesmo com provider (0 LLM, não funde ambíguo)", async () => {
    h.resolveProvider.mockReturnValue("api");
    h.state.extractions = extractionsFor({ "joão": 3, "joão silva": 2, "joão souza": 1 });
    const r = await resolveEntities("home", { disambiguate: false });
    expect(h.state.resolveMap).toEqual({});
    expect(r.provider).toBe("deterministico");
    expect(h.structured).toHaveBeenCalledTimes(0);
  });

  it("mistura: FORTE funde deterministicamente e AMBÍGUO vai pro desempate na MESMA passada", async () => {
    h.resolveProvider.mockReturnValue("api");
    h.structured.mockResolvedValue({ grupos: [["joão", "joão silva"], ["joão souza"]] });
    h.state.extractions = extractionsFor({
      "silvia": 5,
      "sílvia": 2, // forte
      "joão": 3,
      "joão silva": 2,
      "joão souza": 1, // ambíguo
    });
    await resolveEntities("home", { disambiguate: true });
    expect(h.state.resolveMap).toEqual({ "sílvia": "silvia", "joão silva": "joão" });
    expect(h.structured).toHaveBeenCalledTimes(1); // só o grupo ambíguo consultou a LLM
  });
});
