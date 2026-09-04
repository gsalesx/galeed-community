/** M24-C — integração da REFLEXÃO v2 contra Postgres real :5434 (gates §6.6 + idempotência).
 *  LLM mocado via vi.mock (structured devolve verbalização FIEL; resolveProvider → "api").
 *  Fixture derivada do corpus REAL (invariante #9): a série de preço da accelera é o caso
 *  canônico (3k→30k tipo); aqui semeamos uma série análoga (mesma FORMA: preço subindo, mesmo
 *  grupo bitemporal entity=accelera predicate=preco) num brain de teste descartável.
 *  Brain Accelera (produção) = SOMENTE LEITURA; este teste escreve só em `m24c-percepcao`. */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { hasDb, wipeBrain } from "./helpers/db.ts";

const { structured, resolveProvider } = vi.hoisted(() => ({
  structured: vi.fn(async () => ({ texto: "O preço da accelera subiu 900% no período.", quote: "preço da accelera subiu 900% (pctTotal=900)" })),
  resolveProvider: vi.fn(() => "api" as const),
}));
vi.mock("../../src/lib/llm.ts", async (orig) => {
  const actual = (await orig()) as any;
  return { ...actual, structured, resolveProvider };
});

import { getEngine, type FactRow, type PageRow } from "../../src/core/platform/engine.ts";
import { sonoReflexao, percepcaoId, type SinalCiclo } from "../../src/core/memory/reflect.ts";

const BRAIN = "m24c-percepcao";

// série de preço análoga ao caso canônico — 2 pontos do MESMO grupo bitemporal (accelera/preco/"").
const fact = (over: Partial<FactRow>): FactRow =>
  ({
    source_slug: "", type: "reuniao", dimension: "preco", idx: 0, text: "", quote: "",
    meta: {}, entity: "accelera", predicate: "preco", value: "", value_num: null, unit: "BRL",
    period: "monthly", tier: "", valid_from: "", valid_to: "", confidence: 0.6, status: "fato",
    ...over,
  }) as FactRow;

// RankedSignal D1 montado da série semeada — baseFacts apontam pras chaves estáveis REAIS.
function d1Signal(baseFacts: any[], over: any = {}): any {
  return {
    detector: "d1_tendencia", classe: "tendencia", efeito: 0.9, severidade: "alta",
    entities: ["accelera"], baseFacts, minConfidence: 0.6,
    numeros: { pctTotal: 900, slope: 55.5 }, janela: { de: "2025-01-01", ate: "2026-03-01" },
    resumo: "preço da accelera subiu 900% (pctTotal=900)", score: 0.85, rank: 1, ...over,
  };
}

describe.skipIf(!hasDb())("M24-C reflexão v2 — Postgres real", () => {
  beforeAll(async () => {
    await wipeBrain(BRAIN);
    const e = await getEngine(BRAIN);
    await e.upsertPage({ slug: "preco-2025", type: "reuniao", title: "Preço 2025", date: "2025-01-01", body: "preço inicial 3000", tags: [], people: [], links: [] } as PageRow);
    await e.upsertPage({ slug: "preco-2026", type: "reuniao", title: "Preço 2026", date: "2026-03-01", body: "preço novo 30000", tags: [], people: [], links: [] } as PageRow);
    await e.putFacts([
      fact({ source_slug: "preco-2025", value: "3000", value_num: 3000, valid_from: "2025-01-01", valid_to: "" }),
      fact({ source_slug: "preco-2026", value: "30000", value_num: 30000, valid_from: "2026-03-01", valid_to: "" }),
    ]);
  });
  afterAll(async () => {
    await wipeBrain(BRAIN);
  });

  function baseFactsReais() {
    return [
      { entity: "accelera", predicate: "preco", tier: "", valid_from: "2025-01-01", source_slug: "preco-2025" },
      { entity: "accelera", predicate: "preco", tier: "", valid_from: "2026-03-01", source_slug: "preco-2026" },
    ];
  }

  it("§6.6a nascimento ancorado: percepção viva com cites das chaves estáveis reais", async () => {
    structured.mockClear();
    const r = await sonoReflexao(BRAIN, [d1Signal(baseFactsReais())], { topK: 10 });
    expect(r.nascidas).toBe(1);
    const e = await getEngine(BRAIN);
    const id = percepcaoId(d1Signal(baseFactsReais()));
    const p = await e.getPercepcao(id);
    expect(p).toBeDefined();
    expect(p!.estado).toBe("viva");
    expect(p!.classe).toBe("tendencia");
    expect(p!.cites.map((c) => c.source_slug).sort()).toEqual(["preco-2025", "preco-2026"]);
    expect(p!.numbers.pctTotal).toBe(900);
    expect(p!.validated_at).toBeTruthy();
  });

  it("§6.6 idempotência: 2º sono = 0 nascidas, 0 chamadas verbalize, reaproveitadas≥1", async () => {
    structured.mockClear();
    const r = await sonoReflexao(BRAIN, [d1Signal(baseFactsReais())], { topK: 10 });
    expect(r.nascidas).toBe(0);
    const verbCalls = structured.mock.calls.filter((c: any[]) => c[0]?.tool?.name === "verbalizar_percepcao").length;
    expect(verbCalls).toBe(0);
    expect(r.reaproveitadas).toBeGreaterThanOrEqual(1);
  });

  it("§6.6 invalidação por proveniência: superseder o fato-base PELO MOTOR → stale → arquivada (0 LLM)", async () => {
    const e = await getEngine(BRAIN);
    // supersede o fato-base de 2026-03-01: o bitemporal P1-A fecha o valid_to do antigo e arquiva
    // o status quando um valor mais novo entra no mesmo grupo (replaceDerived = DELETE+INSERT). Aqui
    // reproduzimos o ESTADO PÓS-supersessão direto no banco (o que o motor deixa): o cite estável
    // (source_slug=preco-2026, valid_from=2026-03-01) deixa de ter linha status='fato' E vigente.
    const { rawConnect } = await import("./helpers/db.ts");
    const sql = await rawConnect();
    try {
      await sql`update galeed_facts set valid_to = '2026-05-01', status = 'arquivado'
                where brain = ${BRAIN} and source_slug = 'preco-2026' and predicate = 'preco'`;
    } finally {
      await sql.end({ timeout: 5 });
    }
    structured.mockClear();
    // próximo sono SEM sinal pra esse grupo → varredura detecta cite quebrado → stale → arquivada.
    const r = await sonoReflexao(BRAIN, [], { topK: 10 });
    expect(r.stales_novas).toBeGreaterThanOrEqual(1);
    expect(r.arquivadas).toBeGreaterThanOrEqual(1);
    const verbCalls = structured.mock.calls.filter((c: any[]) => c[0]?.tool?.name === "verbalizar_percepcao").length;
    expect(verbCalls).toBe(0); // ZERO LLM na invalidação determinística.
    const id = percepcaoId(d1Signal(baseFactsReais()));
    const p = await e.getPercepcao(id);
    expect(p!.estado).toBe("arquivada");
  });

  it("§7.3.4 RLS/estado: percepcaoCounts bate; setPercepcaoEstado id inexistente = no-op; nunca DELETE", async () => {
    const e = await getEngine(BRAIN);
    const counts = await e.percepcaoCounts();
    const total = counts.viva + counts.stale + counts.arquivada;
    expect(total).toBeGreaterThanOrEqual(1);
    await e.setPercepcaoEstado("id-que-nao-existe", "viva"); // no-op
    const counts2 = await e.percepcaoCounts();
    expect(counts2.viva + counts2.stale + counts2.arquivada).toBe(total); // total só muda estado, nunca some
  });

  it("§7.3.5 acessores roundtrip: upsert 2× não duplica nem muda created_at; jsonb íntegro", async () => {
    const e = await getEngine(BRAIN);
    const row = {
      id: "rt-test-1", classe: "tendencia" as const, entity: "x", predicate: "p", tier: "",
      texto: "t", severidade: "media" as const, cites: [{ source_slug: "s", entity: "x", predicate: "p", tier: "", valid_from: "2025-01-01", quote: "" }],
      numbers: { magnitude: 5, slope: 1.2 }, estado: "viva" as const, validated_at: null,
    };
    await e.upsertPercepcao(row);
    const a = await e.getPercepcao("rt-test-1");
    await e.upsertPercepcao({ ...row, texto: "t2" });
    const b = await e.getPercepcao("rt-test-1");
    expect(a!.created_at).toBe(b!.created_at);
    expect(b!.texto).toBe("t2");
    expect(b!.cites[0].source_slug).toBe("s");
    expect(b!.numbers.slope).toBe(1.2);
    const list = await e.listPercepcoes({ estado: "viva" });
    expect(list.filter((p) => p.id === "rt-test-1")).toHaveLength(1);
  });

  it("§7.3.6 migração 30 aplicada (galeed_migrations id=30)", async () => {
    const { rawConnect } = await import("./helpers/db.ts");
    const sql = await rawConnect();
    try {
      const rows = (await sql`select id from galeed_migrations where id = 30`) as any[];
      expect(rows).toHaveLength(1);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });
});
