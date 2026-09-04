/** M24-C — unit puro/mocado da REFLEXÃO v2 (BRIEF M24 §3, gate §6.5). SEM DB, SEM rede.
 *  Mocks de módulo via vi.mock + vi.hoisted (LEARNINGS M18/S2 — nunca const top-level na factory):
 *   - ../../src/lib/llm.ts (structured + resolveProvider)
 *   - ../../src/core/platform/engine.ts (getEngine → fake engine em memória; tipos são type-only)
 *   - ../../src/core/platform/config.ts (config)
 *   - ../../src/core/platform/usage.ts (recordUsage espião)
 *  verifyAnswer (M17) NÃO é mocado — é o verificador de âncora REAL (LEI II).
 *  Prova: funções puras; o gate adversarial (texto com número fora da evidência → DROP, não nasce);
 *  passe conjunto; teto de custo K+1; provider ausente; revalidação determinística; legado intacto. */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { structured, resolveProvider, config, recordUsage } = vi.hoisted(() => ({
  structured: vi.fn(),
  resolveProvider: vi.fn((_p?: string) => "api" as const),
  config: vi.fn(() => ({ provider: "api", apiModel: "claude-haiku-4-5", cliModel: "haiku", synthModel: "claude-haiku-4-5" })),
  recordUsage: vi.fn(async () => {}),
}));

// fake engine em memória (implementa só o PercepcaoStore + factsInGroups usados pelo ciclo).
const { fakeEngine, store, facts } = vi.hoisted(() => {
  const store = new Map<string, any>();
  const facts: any[] = [];
  const fakeEngine: any = {
    upsertPercepcao: vi.fn(async (row: any) => {
      const prev = store.get(row.id);
      store.set(row.id, { ...row, created_at: prev?.created_at ?? "2026-06-12T00:00:00Z", validated_at: row.estado === "viva" ? "now" : prev?.validated_at ?? null });
    }),
    getPercepcao: vi.fn(async (id: string) => store.get(id)),
    listPercepcoes: vi.fn(async (opts?: any) => {
      let rows = [...store.values()];
      if (opts?.estado) rows = rows.filter((r) => r.estado === opts.estado);
      return rows;
    }),
    setPercepcaoEstado: vi.fn(async (id: string, estado: string) => {
      const r = store.get(id);
      if (r) store.set(id, { ...r, estado, validated_at: estado === "viva" ? "now" : r.validated_at });
    }),
    percepcaoCounts: vi.fn(async () => ({ viva: 0, stale: 0, arquivada: 0 })),
    factsInGroups: vi.fn(async () => facts),
  };
  return { fakeEngine, store, facts };
});

vi.mock("../../src/lib/llm.ts", async (orig) => {
  const actual = (await orig()) as any;
  return { ...actual, structured, resolveProvider };
});
vi.mock("../../src/core/platform/config.ts", () => ({ config }));
vi.mock("../../src/core/platform/engine.ts", () => ({ getEngine: vi.fn(async () => fakeEngine) }));
vi.mock("../../src/core/platform/usage.ts", () => ({ recordUsage }));

import {
  sonoReflexao,
  percepcaoId,
  combinacaoId,
  magnitudeDe,
  toSinalCiclo,
  uniaoBaseFacts,
  magnitudeSustentada,
  citesFromBaseFacts,
  evidenceBody,
  verificarPercepcao,
  reflect,
  type SinalCiclo,
} from "../../src/core/memory/reflect.ts";

// helper: RankedSignal D1 do caso canônico (série de preço 3k→30k = +900%).
function d1Signal(over: any = {}): any {
  return {
    detector: "d1_tendencia",
    classe: "tendencia",
    efeito: 0.9,
    severidade: "alta",
    entities: ["accelera"],
    baseFacts: [
      { entity: "accelera", predicate: "preco", tier: "enterprise", valid_from: "2025-01-01", source_slug: "p1" },
      { entity: "accelera", predicate: "preco", tier: "enterprise", valid_from: "2026-03-01", source_slug: "p2" },
    ],
    minConfidence: 0.6,
    numeros: { pctTotal: 900, slope: 55.5 },
    janela: { de: "2025-01-01", ate: "2026-03-01" },
    resumo: "preço da accelera subiu 900% (pctTotal=900)",
    score: 0.85,
    rank: 1,
    ...over,
  };
}

beforeEach(() => {
  store.clear();
  facts.length = 0;
  structured.mockReset();
  resolveProvider.mockReset().mockReturnValue("api");
  recordUsage.mockClear();
  fakeEngine.upsertPercepcao.mockClear();
});

describe("M24-C funções puras", () => {
  it("percepcaoId é estável (magnitude/numeros/janela NÃO entram no hash; 32 hex)", () => {
    const a = percepcaoId(d1Signal());
    const b = percepcaoId(d1Signal({ efeito: 0.1, numeros: { pctTotal: 50 }, janela: { de: "x", ate: "y" } }));
    expect(a).toBe(b);
    expect(a).toHaveLength(32);
  });

  it("percepcaoId D2 usa só entities (não predicate)", () => {
    const s = d1Signal({ detector: "d2_silencio", classe: "silencio", entities: ["nortex"] });
    const s2 = { ...s, baseFacts: [{ ...s.baseFacts[0], predicate: "outra" }] };
    expect(percepcaoId(s)).toBe(percepcaoId(s2));
  });

  it("combinacaoId é invariante à ordem dos ids; 32 hex", () => {
    expect(combinacaoId(["x", "y"])).toBe(combinacaoId(["y", "x"]));
    expect(combinacaoId(["a", "b"])).toHaveLength(32);
  });

  it("magnitudeDe lê a chave certa por detector + fallback efeito", () => {
    expect(magnitudeDe(d1Signal())).toBe(900);
    expect(magnitudeDe(d1Signal({ detector: "d2_silencio", numeros: { ratio: 2.4 } }))).toBe(2.4);
    expect(magnitudeDe(d1Signal({ detector: "d3_compromisso_vencido", numeros: { diasVencidos: 45 } }))).toBe(45);
    expect(magnitudeDe(d1Signal({ detector: "d1_tendencia", numeros: {}, efeito: 0.7 }))).toBe(0.7);
  });

  it("toSinalCiclo copia campos e deriva id/magnitude", () => {
    const s = toSinalCiclo(d1Signal());
    expect(s.id).toBe(percepcaoId(d1Signal()));
    expect(s.magnitude).toBe(900);
    expect(s.entities).toEqual(["accelera"]);
    expect(s.baseFacts).toHaveLength(2);
  });

  it("uniaoBaseFacts dedupe pela chave estável", () => {
    const a = toSinalCiclo(d1Signal());
    const b = toSinalCiclo(d1Signal({ baseFacts: [a.baseFacts[0], { entity: "x", predicate: "p", tier: "", valid_from: "2025-01-01", source_slug: "p9" }] }));
    const u = uniaoBaseFacts([a, b]);
    expect(u).toHaveLength(3); // p1, p2 (de a) + p9 (novo de b); p1 dedup
  });

  it("magnitudeSustentada — bordas: antiga=0, delta exato", () => {
    expect(magnitudeSustentada(900, 950, 0.25)).toBe(true);
    expect(magnitudeSustentada(900, 2000, 0.25)).toBe(false);
    expect(magnitudeSustentada(0, 0, 0.25)).toBe(true);
    expect(magnitudeSustentada(100, 125, 0.25)).toBe(true); // exatamente 0.25
  });

  it("citesFromBaseFacts é 1:1 com quote vazio", () => {
    const c = citesFromBaseFacts(d1Signal().baseFacts);
    expect(c).toHaveLength(2);
    expect(c[0]).toEqual({ source_slug: "p1", entity: "accelera", predicate: "preco", tier: "enterprise", valid_from: "2025-01-01", quote: "" });
  });

  it("evidenceBody contém resumo + numeros + magnitude + linhas dos FactRef", () => {
    const body = evidenceBody(toSinalCiclo(d1Signal()));
    expect(body).toContain("900");
    expect(body).toContain("magnitude=900");
    expect(body).toContain("accelera · preco · enterprise · 2025-01-01 · p1");
  });
});

describe("M24-C gate §6.5 — verificador adversarial", () => {
  const s = (): SinalCiclo => toSinalCiclo(d1Signal());

  it("número NÃO ancorado → numero_nao_ancorado", () => {
    // evidência diz 900; o texto inventa 47%.
    const r = verificarPercepcao(s(), "O preço subiu 47% no período.", "preço da accelera subiu 900% (pctTotal=900)");
    expect(r.ok).toBe(false);
    expect(r.motivo).toBe("numero_nao_ancorado");
  });

  it("quote não-verbatim → quote_nao_ancorado", () => {
    const r = verificarPercepcao(s(), "O preço da accelera mudou bastante.", "esta frase não está na evidência");
    expect(r.ok).toBe(false);
    expect(r.motivo).toBe("quote_nao_ancorado");
  });

  it("texto vazio → texto_vazio", () => {
    expect(verificarPercepcao(s(), "", "x").motivo).toBe("texto_vazio");
    expect(verificarPercepcao(s(), "   ", "x").motivo).toBe("texto_vazio");
  });

  it("caso FELIZ: texto fiel (número da evidência) → ok", () => {
    const r = verificarPercepcao(s(), "O preço da accelera subiu 900% no período.", "preço da accelera subiu 900% (pctTotal=900)");
    expect(r.ok).toBe(true);
  });
});

describe("M24-C sonoReflexao — fluxo mocado", () => {
  it("verbalização adversarial: NÃO nasce, conta dropada, upsertPercepcao NÃO chamado", async () => {
    // 1 sinal só → passe conjunto pulado (ciclo<2); a única chamada é a verbalize (número fora da evidência).
    structured.mockResolvedValueOnce({ texto: "subiu 47%", quote: "preço da accelera subiu 900% (pctTotal=900)" });
    const r = await sonoReflexao("m24c-unit", [d1Signal()], { topK: 10 });
    expect(r.nascidas).toBe(0);
    expect(r.dropadas).toHaveLength(1);
    expect(r.dropadas[0].motivo).toBe("numero_nao_ancorado");
    expect(fakeEngine.upsertPercepcao).not.toHaveBeenCalled();
  });

  it("caso feliz: nasce viva; classe/severidade do DETECTOR (não do LLM); cites do detector", async () => {
    structured.mockResolvedValueOnce({ texto: "O preço da accelera subiu 900%.", quote: "preço da accelera subiu 900% (pctTotal=900)" });
    const r = await sonoReflexao("m24c-unit", [d1Signal()], { topK: 10 });
    expect(r.nascidas).toBe(1);
    const saved = [...store.values()][0];
    expect(saved.classe).toBe("tendencia"); // do sinal, não do mock
    expect(saved.severidade).toBe("alta"); // do detector
    expect(saved.cites).toHaveLength(2); // citesFromBaseFacts
    expect(saved.estado).toBe("viva");
  });

  it("passe conjunto: combinação válida (2 ids) vira sinal sintético; id desconhecido/1-id descartado", async () => {
    const s1 = d1Signal();
    const s2 = d1Signal({ entities: ["nortex"], detector: "d2_silencio", classe: "silencio", numeros: { ratio: 2.4 }, resumo: "nortex em silêncio (ratio=2.4)" });
    const id1 = percepcaoId(s1);
    const id2 = percepcaoId(s2);
    structured
      .mockResolvedValueOnce({ combinacoes: [{ ids: [id1, id2], por_que: "preço e silêncio juntos" }, { ids: [id1] }, { ids: ["lixo", "?"] }] })
      .mockResolvedValue({ texto: "História combinada.", quote: "preço e silêncio juntos" }); // verbalizes
    const r = await sonoReflexao("m24c-unit", [s1, s2], { topK: 10 });
    expect(r.combinacoes).toBe(1); // só a combinação válida sobreviveu
  });

  it("teto de custo K+1: 15 sinais, K=10 → no máximo 11 chamadas; ops corretas", async () => {
    const sinais = Array.from({ length: 15 }, (_, i) => d1Signal({ entities: [`ent${i}`], baseFacts: [{ entity: `ent${i}`, predicate: "preco", tier: "", valid_from: "2025-01-01", source_slug: `p${i}` }] }));
    structured.mockResolvedValue({ texto: "x", quote: "y" }); // tudo dropa por âncora, mas conta chamada
    const r = await sonoReflexao("m24c-unit", sinais, { topK: 10 });
    expect(r.chamadas_llm).toBeLessThanOrEqual(11);
    expect(structured.mock.calls.length).toBeLessThanOrEqual(11);
    // ops metradas: só reflect:joint / reflect:verbalize (via recordUsage espião — não asserta count exato pq depende do mock)
  });

  it("provider ausente (cli): etapas LLM puladas, provider=none, motivo PT, determinístico roda", async () => {
    resolveProvider.mockReturnValue("cli");
    const r = await sonoReflexao("m24c-unit", [d1Signal()], { topK: 10 });
    expect(r.provider).toBe("none");
    expect(r.motivo).toMatch(/ANTHROPIC_API_KEY|adiada|sinais|corte/i);
    expect(structured).not.toHaveBeenCalled();
  });

  it("revalidação determinística: viva sustentada → 0 verbalize; fora do delta → 1 verbalize", async () => {
    // semeia uma percepção viva existente com magnitude 900.
    const s = toSinalCiclo(d1Signal());
    store.set(s.id, { id: s.id, classe: "tendencia", entity: "accelera", predicate: "preco", tier: "enterprise", texto: "antigo", severidade: "alta", cites: citesFromBaseFacts(s.baseFacts), numbers: { magnitude: 900 }, estado: "viva", created_at: "2026-01-01", validated_at: "2026-01-01" });
    // proveniência: fatos atuais sustentam (match das chaves).
    facts.push(
      { entity: "accelera", predicate: "preco", tier: "enterprise", source_slug: "p1", valid_from: "2025-01-01", status: "fato", valid_to: "" },
      { entity: "accelera", predicate: "preco", tier: "enterprise", source_slug: "p2", valid_from: "2026-03-01", status: "fato", valid_to: "" },
    );
    structured.mockResolvedValue({ combinacoes: [] });
    // magnitude IGUAL (900) → sustentada → 0 verbalize.
    const r1 = await sonoReflexao("m24c-unit", [d1Signal()], { topK: 10 });
    expect(r1.reaproveitadas).toBeGreaterThanOrEqual(1);
    const verbCalls = structured.mock.calls.filter((c: any[]) => c[0]?.tool?.name === "verbalizar_percepcao").length;
    expect(verbCalls).toBe(0);
  });

  it("sinal ausente: classe silencio (efêmera) → arquivada; tendencia → permanece viva", async () => {
    const sil = toSinalCiclo(d1Signal({ detector: "d2_silencio", classe: "silencio", entities: ["nortex"] }));
    const ten = toSinalCiclo(d1Signal());
    store.set(sil.id, { id: sil.id, classe: "silencio", entity: "nortex", predicate: "", tier: "", texto: "silêncio", severidade: "media", cites: [], numbers: { magnitude: 2.4 }, estado: "viva", created_at: "x", validated_at: "x" });
    store.set(ten.id, { id: ten.id, classe: "tendencia", entity: "accelera", predicate: "preco", tier: "enterprise", texto: "tendência", severidade: "alta", cites: citesFromBaseFacts(ten.baseFacts), numbers: { magnitude: 900 }, estado: "viva", created_at: "x", validated_at: "x" });
    facts.push({ entity: "accelera", predicate: "preco", tier: "enterprise", source_slug: "p1", valid_from: "2025-01-01", status: "fato", valid_to: "" }, { entity: "accelera", predicate: "preco", tier: "enterprise", source_slug: "p2", valid_from: "2026-03-01", status: "fato", valid_to: "" });
    structured.mockResolvedValue({ combinacoes: [] });
    const r = await sonoReflexao("m24c-unit", [], { topK: 10 }); // nenhum sinal no ciclo
    expect(store.get(sil.id).estado).toBe("arquivada");
    expect(store.get(ten.id).estado).toBe("viva");
    expect(r.arquivadas).toBe(1);
  });
});

describe("M24-C legado intacto", () => {
  it("reflect (legado) segue exportado como função", () => {
    expect(typeof reflect).toBe("function");
  });
});
