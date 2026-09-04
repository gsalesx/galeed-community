/** M24-D — §7.3: orquestração do ciclo (A/B/C MOCKADOS) + maybeSono isolado (§7.2.4 movido pra cá,
 *  onde engine + estado já estão mockados — ANOTADO em ARTIFACTS). vi.mock + vi.hoisted.
 *  Mocka signals/index.ts (A), dream-v2.ts (B), reflect.ts (C), reconcile.ts, consolidate-step.ts,
 *  sleep.ts (recomputeSalience/prune), engine.ts e o ESTADO durável (db-conn → SQL in-memory).
 *  Prova: ordem cravada, budget de ponta a ponta, NOOP, fail-soft por fase, dormiu, teto pós-ciclo,
 *  serialização por brain, e o veto de fila do maybeSono. */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => {
  const calls: string[] = [];
  const state = {
    // estado durável in-memory por brain (substitui o galeed_sono_state)
    rows: new Map<string, { last_sleep_at: string | null; baseline: any; last_trace: any }>(),
    // stats por brain (engine.stats())
    stats: new Map<string, { pages: number; facts: number; edges: number; vectors: number }>(),
    // hooks de instrumentação
    sonhoGate: null as null | Promise<void>,
  };
  const refl = {
    noop: true, top_k: 0, combinacoes: 0, nascidas: 0, dropadas: [] as any[],
    reaproveitadas: 0, stales_novas: 0, revalidadas: 0, reverbalizadas: 0,
    arquivadas: 0, chamadas_llm: 0, provider: "none",
  };
  const dream = { hypotheses: [] as any[], clusters: [] as any[], enqueued: 0, noop: true, graph: { nodes: 0, edges: 0, candidates: 0 } };
  return {
    calls,
    state,
    refl,
    dream,
    // A/B/C
    detectSignals: vi.fn(async (_brain: string, _opts: any) => {
      calls.push("detectores");
      return [] as any[];
    }),
    dreamV2: vi.fn(async (_brain: string, _opts: any) => {
      calls.push("sonho");
      if (state.sonhoGate) await state.sonhoGate;
      return { ...dream };
    }),
    sonoReflexao: vi.fn(async (_brain: string, _signals: any[], _opts: any) => {
      calls.push("reflexao");
      return { ...refl };
    }),
    // legados
    reconcile: vi.fn(async () => {
      calls.push("reconcile");
      return { entities: 0, merges: [], provider: "deterministico" };
    }),
    runConsolidationStep: vi.fn(async () => {
      calls.push("consolidacao");
      return { status: "ok", merges: 0, aliases_mudados: 0, fontes_rederivadas: 0, grupos: 0 };
    }),
    recomputeSalience: vi.fn(async () => {
      calls.push("salience");
      return { pages: 0, updated: 0 };
    }),
    prune: vi.fn(async () => {
      calls.push("prune");
      return { candidates: [], archived: 0 };
    }),
    // decaimento→lixeira (achado decaimento-lixeira#1): fase shed nova no ciclo
    shedCold: vi.fn(async () => {
      calls.push("shed");
      return { cooled: 0, vectorsShed: 0, pages: [], dryRun: false };
    }),
    // engine
    getEngine: vi.fn(async (brain: string) => ({
      stats: vi.fn(async () => state.stats.get(brain) ?? { pages: 0, facts: 0, edges: 0, vectors: 0 }),
    })),
  };
});

vi.mock("../../src/core/memory/signals/index.ts", () => ({ detectSignals: h.detectSignals }));
vi.mock("../../src/core/memory/signals/types.ts", () => ({}));
vi.mock("../../src/core/memory/dream-v2.ts", () => ({ dreamV2: h.dreamV2 }));
vi.mock("../../src/core/memory/reflect.ts", () => ({ sonoReflexao: h.sonoReflexao }));
vi.mock("../../src/core/memory/reconcile.ts", () => ({ reconcile: h.reconcile }));
vi.mock("../../src/core/ingestion/consolidate-step.ts", () => ({ runConsolidationStep: h.runConsolidationStep }));
vi.mock("../../src/core/memory/sleep.ts", () => ({ recomputeSalience: h.recomputeSalience, prune: h.prune }));
vi.mock("../../src/core/memory/tiering.ts", () => ({ shedCold: h.shedCold }));
vi.mock("../../src/core/platform/engine.ts", () => ({ getEngine: h.getEngine }));

// db-conn: SQL falso que lê/escreve o Map in-memory de h.state.rows. Suporta os 3 usos do módulo:
//  - sql`create table ...` (via sql.unsafe no DDL lazy)
//  - sql`select last_sleep_at, baseline from galeed_sono_state where brain = ${brain} limit 1`
//  - sql`insert into galeed_sono_state ... on conflict ...` (upsert)
vi.mock("../../src/core/platform/db-conn.ts", () => {
  const tag = (strings: TemplateStringsArray, ...vals: any[]) => {
    const q = strings.join("?").toLowerCase();
    if (q.includes("select") && q.includes("galeed_sono_state")) {
      const brain = vals[0];
      const row = h.state.rows.get(brain);
      return Promise.resolve(row ? [row] : []);
    }
    if (q.includes("insert into galeed_sono_state")) {
      // vals em ordem: brain, lastSleepAt, baselineJson, lastTraceJson
      const [brain, lastSleepAt, baselineJson, lastTraceJson] = vals;
      h.state.rows.set(brain, {
        last_sleep_at: lastSleepAt,
        baseline: JSON.parse(baselineJson),
        last_trace: JSON.parse(lastTraceJson),
      });
      return Promise.resolve([]);
    }
    return Promise.resolve([]);
  };
  (tag as any).unsafe = async () => []; // create table if not exists
  return {
    getSharedSql: vi.fn(async () => tag),
    sharedSqlGeneration: vi.fn(() => 1),
    closeSharedSql: vi.fn(async () => {}),
  };
});

import {
  runSonoCycle,
  maybeSono,
  getSonoState,
  putSonoState,
  sonoConfig,
  decideGatilho,
  type SonoState,
  type SonoConfig,
} from "../../src/core/ingestion/sono-step.ts";

beforeEach(() => {
  vi.clearAllMocks();
  h.calls.length = 0;
  h.state.rows.clear();
  h.state.stats.clear();
  h.state.sonhoGate = null;
  // reset mocks dos retornos A/B/C
  h.detectSignals.mockImplementation(async () => { h.calls.push("detectores"); return []; });
  h.dreamV2.mockImplementation(async () => { h.calls.push("sonho"); if (h.state.sonhoGate) await h.state.sonhoGate; return { hypotheses: [], clusters: [], enqueued: 0, noop: true, graph: { nodes: 0, edges: 0, candidates: 0 } }; });
  h.sonoReflexao.mockImplementation(async () => { h.calls.push("reflexao"); return { ...h.refl }; });
  // restaura env
  delete process.env.GALEED_SONO;
  delete process.env.GALEED_SONO_K;
  delete process.env.GALEED_SONO_MIN_FONTES;
  delete process.env.GALEED_SONO_MIN_FATOS;
  delete process.env.GALEED_SONO_COOLDOWN_MS;
  delete process.env.GALEED_SONO_PRUNE_APPLY;
  delete process.env.GALEED_SONO_PRUNE_OLDER_DIAS;
});

describe("runSonoCycle — orquestração (m24d-sono-worker-ciclo)", () => {
  it("1. ordem CRAVADA: reconcile → consolidação → salience → detectores → sonho → reflexão → prune → shed", async () => {
    await runSonoCycle("b1");
    expect(h.calls).toEqual(["reconcile", "consolidacao", "salience", "detectores", "sonho", "reflexao", "prune", "shed"]);
  });

  it("1b. prune do ciclo roda com apply LIGADO + critério conservador + cutoff derivado do relógio injetado (achado decaimento-lixeira#1)", async () => {
    const fixado = new Date("2026-07-01T00:00:00.000Z"); // − 180d = 2026-01-02
    await runSonoCycle("b1b", { now: () => fixado });
    expect(h.prune).toHaveBeenCalledWith("b1b", { apply: true, olderThan: "2026-01-02", conservador: true });
    expect(h.shedCold).toHaveBeenCalledWith("b1b", { dryRun: false });
  });

  it("1c. GALEED_SONO_PRUNE_APPLY=0 → prune volta ao dry-run e a fase shed NÃO roda", async () => {
    process.env.GALEED_SONO_PRUNE_APPLY = "0";
    const t = await runSonoCycle("b1c");
    expect(h.prune).toHaveBeenCalledWith("b1c", expect.objectContaining({ apply: false, conservador: true }));
    expect(h.shedCold).not.toHaveBeenCalled();
    expect(t.fases?.shed).toBeUndefined();
    expect(h.calls).toEqual(["reconcile", "consolidacao", "salience", "detectores", "sonho", "reflexao", "prune"]);
  });

  it("2. budget de ponta a ponta: GALEED_SONO_K=3 → detectSignals config.k=3 e sonoReflexao topK=3 com os MESMOS sinais", async () => {
    process.env.GALEED_SONO_K = "3";
    const sinais = [{ rank: 1 }, { rank: 2 }] as any[];
    h.detectSignals.mockImplementation(async () => { h.calls.push("detectores"); return sinais; });
    await runSonoCycle("b2");
    expect(h.detectSignals).toHaveBeenCalledWith("b2", { config: { k: 3 } });
    expect(h.dreamV2).toHaveBeenCalledWith("b2", { topK: 3 });
    // mesmos sinais, sem fatiar/reordenar
    expect(h.sonoReflexao).toHaveBeenCalledWith("b2", sinais, { topK: 3 });
  });

  it("3. NOOP (LEI VI): A=[], B enfileiradas:0, C nascidas:0/chamadas:0 → status noop, chamadas_llm:0, estado ATUALIZADO", async () => {
    h.state.stats.set("b3", { pages: 5, facts: 9, edges: 0, vectors: 0 });
    const t = await runSonoCycle("b3");
    expect(t.status).toBe("noop");
    expect(t.chamadas_llm).toBe(0);
    // estado foi atualizado (lastSleepAt + baseline = stats pós-ciclo)
    const st = await getSonoState("b3");
    expect(st.lastSleepAt).toBe(t.inicio);
    expect(st.baseline).toEqual({ pages: 5, facts: 9 });
  });

  it("4. fail-soft por fase: dreamV2 rejeita → fases.sonho.falhou, reflexão+prune AINDA rodam, parcial, nada lança", async () => {
    h.dreamV2.mockImplementation(async () => { h.calls.push("sonho"); throw new Error("dream-boom"); });
    const t = await runSonoCycle("b4");
    expect(t.status).toBe("parcial");
    expect(t.fases?.sonho?.status).toBe("falhou");
    expect((t.fases?.sonho as any)?.erro).toBe("dream-boom");
    expect(t.fases?.reflexao?.status).toBe("ok"); // reflexão rodou
    expect(t.fases?.prune?.status).toBe("ok"); // prune rodou
    expect(t.fases?.shed?.status).toBe("ok"); // shed rodou
    expect(h.calls).toEqual(["reconcile", "consolidacao", "salience", "detectores", "sonho", "reflexao", "prune", "shed"]);
  });

  it("5. dormiu: C nascidas:2 → status dormiu, chamadas_llm ecoado", async () => {
    h.sonoReflexao.mockImplementation(async () => { h.calls.push("reflexao"); return { ...h.refl, noop: false, nascidas: 2, chamadas_llm: 3, provider: "api" }; });
    const t = await runSonoCycle("b5");
    expect(t.status).toBe("dormiu");
    expect(t.chamadas_llm).toBe(3);
    expect((t.fases?.reflexao as any)?.nascidas).toBe(2);
  });

  it("5b. dormiu via sonho: enfileiradas>0 (sem percepção) → dormiu", async () => {
    h.dreamV2.mockImplementation(async () => { h.calls.push("sonho"); return { hypotheses: [{}], clusters: [], enqueued: 1, noop: false, graph: { nodes: 1, edges: 0, candidates: 1 } }; });
    const t = await runSonoCycle("b5b");
    expect(t.status).toBe("dormiu");
    expect((t.fases?.sonho as any)?.enfileiradas).toBe(1);
  });

  it("6. teto pós-ciclo: após runSonoCycle, maybeSono +1h+acúmulo alto → cooldown; +25h → dorme de novo", async () => {
    // stats com acúmulo alto desde baseline 0
    h.state.stats.set("b6", { pages: 100, facts: 100, edges: 0, vectors: 0 });
    const fixedInicio = new Date("2026-06-12T00:00:00.000Z");
    const t = await runSonoCycle("b6", { now: () => fixedInicio });
    expect(t.status).toBe("noop"); // nada escrito, mas estado gravado com lastSleepAt=inicio
    // baseline pós-ciclo = 100/100; pra haver acúmulo, sobe stats
    h.state.stats.set("b6", { pages: 200, facts: 200, edges: 0, vectors: 0 });

    const mais1h = new Date(fixedInicio.getTime() + 60 * 60_000);
    const r1 = await maybeSono("b6", { now: () => mais1h, filaVazia: async () => true });
    expect(r1.status).toBe("cooldown");

    const mais25h = new Date(fixedInicio.getTime() + 25 * 60 * 60_000);
    const r2 = await maybeSono("b6", { now: () => mais25h, filaVazia: async () => true });
    expect(r2.status).toBe("noop"); // dormiu de novo (ciclo rodou; nada escrito → noop)
    expect(h.detectSignals).toHaveBeenCalledTimes(2); // 2 ciclos: o manual + o re-disparo
  });

  it("7. serialização por brain: duas chamadas concorrentes no MESMO brain nunca sobrepõem", async () => {
    let release!: () => void;
    h.state.sonhoGate = new Promise<void>((r) => (release = r));
    const seq: string[] = [];
    h.detectSignals.mockImplementation(async () => { seq.push("enter"); h.calls.push("detectores"); return []; });
    h.prune.mockImplementation(async () => { seq.push("exit"); h.calls.push("prune"); return { candidates: [], archived: 0 }; });

    const p1 = runSonoCycle("bser");
    const p2 = runSonoCycle("bser");
    // libera o gate do sonho do primeiro ciclo após um tick
    await new Promise((r) => setTimeout(r, 5));
    release();
    await Promise.all([p1, p2]);
    // serializado: enter/exit do 1º fecham antes do enter do 2º
    expect(seq).toEqual(["enter", "exit", "enter", "exit"]);
  });

  it("7b. brains diferentes podem sobrepor (não deadlockam)", async () => {
    const a = runSonoCycle("ba");
    const b = runSonoCycle("bb");
    await Promise.all([a, b]);
    expect(h.detectSignals).toHaveBeenCalledTimes(2);
  });
});

describe("maybeSono isolado — veto de fila (§7.2.4) (m24d-sono-worker-ciclo)", () => {
  it("filaVazia=false → fila_ocupada e o ciclo NÃO roda", async () => {
    h.state.stats.set("bf", { pages: 100, facts: 100, edges: 0, vectors: 0 }); // acúmulo alto, lastSleepAt null
    const t = await maybeSono("bf", { filaVazia: async () => false });
    expect(t.status).toBe("fila_ocupada");
    expect(h.detectSignals).not.toHaveBeenCalled(); // ciclo não rodou
  });
  it("filaVazia=true → ciclo roda", async () => {
    h.state.stats.set("bt", { pages: 100, facts: 100, edges: 0, vectors: 0 });
    const t = await maybeSono("bt", { filaVazia: async () => true });
    expect(t.status).toBe("noop"); // ciclo rodou e nada escreveu
    expect(h.detectSignals).toHaveBeenCalledWith("bt", { config: { k: 10 } });
  });
  it("desligado (GALEED_SONO=0) → desligado, ciclo NÃO roda, estado NÃO gravado", async () => {
    process.env.GALEED_SONO = "0";
    const t = await maybeSono("bd", { filaVazia: async () => true });
    expect(t.status).toBe("desligado");
    expect(h.detectSignals).not.toHaveBeenCalled();
    expect(h.state.rows.has("bd")).toBe(false);
  });
});

// guard: putSonoState/getSonoState round-trip via SQL in-memory
describe("estado durável (in-memory) (m24d-sono-worker-ciclo)", () => {
  it("getSonoState ausente → null/zeros; putSonoState grava e getSonoState lê de volta", async () => {
    expect(await getSonoState("bx")).toEqual({ lastSleepAt: null, baseline: { pages: 0, facts: 0 } });
    const s: SonoState = { lastSleepAt: "2026-06-12T00:00:00.000Z", baseline: { pages: 7, facts: 11 } };
    await putSonoState("bx", s, { status: "noop", fontes_novas: 0, fatos_novos: 0, budget_k: 10, chamadas_llm: 0 });
    expect(await getSonoState("bx")).toEqual(s);
  });
});

// ===========================================================================
// §7.2.1-2 — gatilho PURO (sonoConfig + decideGatilho). Vivem aqui (e não no arquivo de wiring)
// porque carregam o sono-step REAL; o wiring (m24d-sono-worker.test.ts) mocka o sono-step inteiro.
// ===========================================================================
const baseState: SonoState = { lastSleepAt: null, baseline: { pages: 0, facts: 0 } };

describe("sonoConfig (m24d-sono-worker-ciclo)", () => {
  it("§7.2.1 — env ausente → defaults (1/12/50/86400000/10 + prune apply LIGADO/180d — achado decaimento-lixeira#1)", () => {
    expect(sonoConfig({})).toEqual({ ligado: true, minFontes: 12, minFatos: 50, cooldownMs: 86_400_000, budgetK: 10, pruneApply: true, pruneOlderDias: 180 });
  });
  it("§7.2.1 — env setado → lido", () => {
    const env = {
      GALEED_SONO: "0",
      GALEED_SONO_MIN_FONTES: "3",
      GALEED_SONO_MIN_FATOS: "7",
      GALEED_SONO_COOLDOWN_MS: "1000",
      GALEED_SONO_K: "4",
      GALEED_SONO_PRUNE_APPLY: "0",
      GALEED_SONO_PRUNE_OLDER_DIAS: "90",
    } as NodeJS.ProcessEnv;
    expect(sonoConfig(env)).toEqual({ ligado: false, minFontes: 3, minFatos: 7, cooldownMs: 1000, budgetK: 4, pruneApply: false, pruneOlderDias: 90 });
  });
});

describe("decideGatilho (m24d-sono-worker-ciclo) — relógio mockado, função pura", () => {
  const cfg: SonoConfig = { ligado: true, minFontes: 12, minFatos: 50, cooldownMs: 86_400_000, budgetK: 10, pruneApply: true, pruneOlderDias: 180 };
  const agora = new Date("2026-06-12T12:00:00Z");

  it("§7.2.2a — ligado:false → desligado (mesmo com acúmulo enorme)", () => {
    expect(decideGatilho({ agora, state: baseState, atual: { pages: 9999, facts: 9999 }, cfg: { ...cfg, ligado: false } })).toEqual({ dorme: false, motivo: "desligado" });
  });

  it("§7.2.2b — acúmulo abaixo nos DOIS eixos → aguardando_acumulo", () => {
    expect(decideGatilho({ agora, state: baseState, atual: { pages: 11, facts: 49 }, cfg })).toEqual({ dorme: false, motivo: "aguardando_acumulo" });
  });
  it("§7.2.2b — ≥minFontes só em pages → dorme (OU, não E)", () => {
    expect(decideGatilho({ agora, state: baseState, atual: { pages: 12, facts: 0 }, cfg })).toEqual({ dorme: true });
  });
  it("§7.2.2b — ≥minFatos só em facts → dorme (OU, não E)", () => {
    expect(decideGatilho({ agora, state: baseState, atual: { pages: 0, facts: 50 }, cfg })).toEqual({ dorme: true });
  });

  it("§7.2.2c — lastSleepAt = agora − 23h59m → cooldown", () => {
    const last = new Date(agora.getTime() - (23 * 60 + 59) * 60_000).toISOString();
    expect(decideGatilho({ agora, state: { lastSleepAt: last, baseline: { pages: 0, facts: 0 } }, atual: { pages: 100, facts: 100 }, cfg })).toEqual({ dorme: false, motivo: "cooldown" });
  });
  it("§7.2.2c — lastSleepAt = agora − 24h01m → dorme", () => {
    const last = new Date(agora.getTime() - (24 * 60 + 1) * 60_000).toISOString();
    expect(decideGatilho({ agora, state: { lastSleepAt: last, baseline: { pages: 0, facts: 0 } }, atual: { pages: 100, facts: 100 }, cfg })).toEqual({ dorme: true });
  });
  it("§7.2.2c — lastSleepAt null → nunca veta por cooldown", () => {
    expect(decideGatilho({ agora, state: baseState, atual: { pages: 100, facts: 100 }, cfg })).toEqual({ dorme: true });
  });

  it("§7.2.2d — ordem dos vetos: desligado vence acúmulo vence cooldown", () => {
    const last = new Date(agora.getTime() - 60_000).toISOString();
    const state: SonoState = { lastSleepAt: last, baseline: { pages: 0, facts: 0 } };
    expect(decideGatilho({ agora, state, atual: { pages: 0, facts: 0 }, cfg: { ...cfg, ligado: false } })).toEqual({ dorme: false, motivo: "desligado" });
    expect(decideGatilho({ agora, state, atual: { pages: 1, facts: 1 }, cfg })).toEqual({ dorme: false, motivo: "aguardando_acumulo" });
    expect(decideGatilho({ agora, state, atual: { pages: 100, facts: 100 }, cfg })).toEqual({ dorme: false, motivo: "cooldown" });
  });
});
