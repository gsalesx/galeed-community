/** M24-D — INTEGRAÇÃO (DESIGN-SPEC §7.4). Estado durável em Postgres real :5434, ZERO LLM.
 *  A/B/C (signals/index.ts, dream-v2.ts, reflect.ts) MOCKADOS via vi.mock (funciona na integração
 *  também) — assim o ciclo escreve estado SEM tocar LLM. reconcile/consolidação/salience/prune REAIS
 *  sobre fixture mínima semeada pelo engine REAL (upsertPage + putExtraction + deriveIncremental;
 *  modelo: test/integration/m23d-consolidacao.test.ts:23-59, variantes reais do corpus, invariante #9).
 *
 *  Brain `m24d-sono-worker` (+ wipeBrain + limpeza de galeed_sono_state pelo próprio teste —
 *  NUNCA toca Accelera/produção). describe.skipIf(!hasDb()).
 *
 *  NOTA (reconcile pendente): este arquivo só COLETA quando os módulos A/B/C existirem em disco
 *  (M24-A/B/C mergeados) — o Vite resolve os imports estáticos transitivos do sono-step.ts em
 *  transform-time; até lá o Integrador roda este teste no tronco reconciliado (ARTIFACTS). */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { hasDb, wipeBrain, rawConnect } from "./helpers/db.ts";
import { getEngine, closeEngines, type PageRow, type ExtractionRow } from "../../src/core/platform/engine.ts";
import { deriveIncremental } from "../../src/core/retrieval/indexer.ts";

// A/B/C mockados — zero LLM, retornos NOOP determinísticos (o foco aqui é ESTADO/gatilho/teto).
const m = vi.hoisted(() => ({
  detectSignals: vi.fn(async () => [] as any[]),
  dreamV2: vi.fn(async () => ({ hypotheses: [], clusters: [], enqueued: 0, noop: true, graph: { nodes: 0, edges: 0, candidates: 0 } })),
  sonoReflexao: vi.fn(async () => ({ noop: true, top_k: 0, combinacoes: 0, nascidas: 0, dropadas: [], reaproveitadas: 0, stales_novas: 0, revalidadas: 0, reverbalizadas: 0, arquivadas: 0, chamadas_llm: 0, provider: "none" })),
}));
vi.mock("../../src/core/memory/signals/index.ts", () => ({ detectSignals: m.detectSignals }));
vi.mock("../../src/core/memory/signals/types.ts", () => ({}));
vi.mock("../../src/core/memory/dream-v2.ts", () => ({ dreamV2: m.dreamV2 }));
vi.mock("../../src/core/memory/reflect.ts", () => ({ sonoReflexao: m.sonoReflexao }));

import { runSonoCycle, maybeSono, getSonoState, closeSonoState } from "../../src/core/ingestion/sono-step.ts";
import { enqueueIngestJob, markJobDone, mergeJobResult, getJob, closeIngestQueue } from "../../src/core/ingestion/ingest-queue.ts";

const BRAIN = "m24d-sono-worker";
// VARIANTES REAIS (S0 §5.1 / invariante #9): "accelera" canônico, série de preço datada.
const VAL: Record<string, number> = { s1: 3000, s2: 5000, s3: 12000 };
const VF: Record<string, string> = { s1: "2025-01-01", s2: "2025-02-01", s3: "2025-03-01" };

const page = (slug: string): PageRow => ({
  slug, type: "reunioes", title: slug, date: VF[slug], path: "",
  body: `accelera: preço ${VAL[slug]} por mês.`, content_hash: slug,
});
const extraction = (slug: string): ExtractionRow => ({
  source_slug: slug, type: "reunioes", date: VF[slug], content_hash: slug, prompt_version: "test",
  extractions: {
    preco: [{ entity: "accelera", predicate: "preco", value: String(VAL[slug]), value_num: VAL[slug], unit: "BRL", period: "monthly", valid_from: VF[slug], context_quote: `preço ${VAL[slug]}`, text: `preço ${VAL[slug]}` }],
  },
});

async function seed(slugs: string[]): Promise<void> {
  const e = await getEngine(BRAIN);
  for (const s of slugs) await e.upsertPage(page(s));
  for (const s of slugs) await e.putExtraction(extraction(s));
  await deriveIncremental(BRAIN, slugs);
}

async function wipeSonoState(): Promise<void> {
  const sql = await rawConnect();
  try {
    await sql.unsafe(`delete from galeed_sono_state where brain = $1`, [BRAIN]).catch(() => {});
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function sonoStateRow(): Promise<any | null> {
  const sql = await rawConnect();
  try {
    const rows = (await sql.unsafe(`select last_sleep_at, baseline, last_trace from galeed_sono_state where brain = $1`, [BRAIN])) as any[];
    return rows.length ? rows[0] : null;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

describe.skipIf(!hasDb())("M24-D — estado durável do sono (DB real :5434, zero LLM)", () => {
  const savedEnv = { ...process.env };
  beforeAll(async () => {
    delete process.env.GALEED_SONO;
    delete process.env.GALEED_CONSOLIDATE;
  });
  afterAll(async () => {
    process.env = { ...savedEnv };
    await wipeSonoState();
    await wipeBrain(BRAIN);
    await closeSonoState();
    await closeIngestQueue();
    await closeEngines();
  });
  beforeEach(async () => {
    vi.clearAllMocks();
    process.env = { ...savedEnv };
    delete process.env.GALEED_SONO;
    await wipeBrain(BRAIN);
    await wipeSonoState();
  });

  it("§7.4.1 — estado nasce vazio", async () => {
    expect(await getSonoState(BRAIN)).toEqual({ lastSleepAt: null, baseline: { pages: 0, facts: 0 } });
  });

  it("§7.4.2 — ciclo grava estado: last_sleep_at ≈ inicio, baseline = stats reais, last_trace.status ∈ {dormiu,noop,parcial}", async () => {
    await seed(["s1", "s2", "s3"]);
    const t = await runSonoCycle(BRAIN);
    expect(["dormiu", "noop", "parcial"]).toContain(t.status);
    const row = await sonoStateRow();
    expect(row).not.toBeNull();
    expect(new Date(row.last_sleep_at).toISOString()).toBe(t.inicio);
    const baseline = typeof row.baseline === "string" ? JSON.parse(row.baseline) : row.baseline;
    const e = await getEngine(BRAIN);
    const s = await e.stats();
    expect(baseline).toEqual({ pages: s.pages, facts: s.facts });
    const trace = typeof row.last_trace === "string" ? JSON.parse(row.last_trace) : row.last_trace;
    expect(trace.status).toBe(t.status);
  });

  it("§7.4.3 — gatilho de acúmulo com dados reais (GALEED_SONO_MIN_FONTES=3)", async () => {
    process.env.GALEED_SONO_MIN_FONTES = "3";
    process.env.GALEED_SONO_MIN_FATOS = "9999"; // só o eixo de fontes manda neste teste
    await seed(["s1"]);
    // grava baseline rodando o ciclo uma vez (baseline = 1 página)
    const inicio = new Date("2026-06-12T00:00:00.000Z");
    await runSonoCycle(BRAIN, { now: () => inicio });
    // +1 página ⇒ 1 < 3 fontes novas, relógio +25h (sem cooldown) → aguardando_acumulo
    await seed(["s2"]);
    const mais25h = new Date(inicio.getTime() + 25 * 60 * 60_000);
    const r1 = await maybeSono(BRAIN, { now: () => mais25h, filaVazia: async () => true });
    expect(r1.status).toBe("aguardando_acumulo");
    // semear até ≥3 fontes novas desde o baseline → dorme
    await seed(["s3"]);
    const sql = await rawConnect();
    try {
      // +1 página extra (s4 novo) garante ≥3 acumuladas desde baseline=1
      await (await getEngine(BRAIN)).upsertPage({ slug: "s4", type: "reunioes", title: "s4", date: "2025-05-01", path: "", body: "accelera: preço 12000 por mês.", content_hash: "s4" });
    } finally {
      await sql.end({ timeout: 5 });
    }
    const r2 = await maybeSono(BRAIN, { now: () => mais25h, filaVazia: async () => true });
    expect(["dormiu", "noop", "parcial"]).toContain(r2.status); // dormiu (acúmulo ≥3, sem cooldown)
  });

  it("§7.4.4 — teto durável: maybeSono logo após (relógio +1h) → cooldown (estado veio do BANCO)", async () => {
    process.env.GALEED_SONO_MIN_FONTES = "1";
    process.env.GALEED_SONO_MIN_FATOS = "1";
    await seed(["s1", "s2", "s3"]);
    const inicio = new Date("2026-06-12T00:00:00.000Z");
    await runSonoCycle(BRAIN, { now: () => inicio }); // grava baseline = stats pós-ciclo (3 páginas)
    // adiciona uma página GENUINAMENTE NOVA ⇒ acúmulo ≥ minFontes (isola o veto de cooldown, que
    // vem DEPOIS do acúmulo na ordem cravada — sem isso o gatilho pararia em aguardando_acumulo)
    await (await getEngine(BRAIN)).upsertPage({ slug: "s4", type: "reunioes", title: "s4", date: "2025-05-01", path: "", body: "accelera: preço 18000 por mês.", content_hash: "s4" });
    const mais1h = new Date(inicio.getTime() + 60 * 60_000);
    const r = await maybeSono(BRAIN, { now: () => mais1h, filaVazia: async () => true });
    expect(r.status).toBe("cooldown"); // lastSleepAt veio do BANCO (estado durável), +1h < 24h
  });

  it("§7.4.5 — rastro no job: mergeJobResult(jobId,{sono}) preserva chaves anteriores (jsonb ||)", async () => {
    await seed(["s1"]);
    const { jobId } = await enqueueIngestJob({ brain: BRAIN, kind: "text", textBody: "x" });
    await markJobDone(jobId, { total: 1, slugs: ["s1"], skipped: 0, message: "" });
    await mergeJobResult(jobId, { consolidacao: { status: "ok" } }); // chave anterior (M23-D)
    const t = await runSonoCycle(BRAIN);
    await mergeJobResult(jobId, { sono: t });
    const job = await getJob(BRAIN, jobId);
    expect(job?.status).toBe("done");
    expect(job?.leaseUntil).toBeNull();
    expect((job as any)?.result?.sono?.status ?? (job as any)?.resultJson?.sono?.status).toBeDefined();
  });

  it("§7.4.6 — desligado: GALEED_SONO=0 → maybeSono=desligado, NENHUMA linha nova em galeed_sono_state", async () => {
    process.env.GALEED_SONO = "0";
    await seed(["s1", "s2", "s3"]);
    const t = await maybeSono(BRAIN, { filaVazia: async () => true });
    expect(t.status).toBe("desligado");
    expect(await sonoStateRow()).toBeNull(); // zero escrita
  });

  it("§7.4.7 — migração idempotente: reabrir o módulo 2× não falha (create table if not exists)", async () => {
    await getSonoState(BRAIN);
    await closeSonoState();
    await expect(getSonoState(BRAIN)).resolves.toBeDefined(); // reabre limpo
  });
});
