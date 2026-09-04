/** INTEGRAÇÃO P1-D — dedup por FATIA no pipeline (A6/L1/L3) + canal na página (B10).
 *  DB real; LLM MOCKADO (vi.mock de extract.ts trocando SÓ extractUnit; buildEmbeddings resolve).
 *  Prova: externalId `sl:<sha16>` por fatia, título sem `/Y`, re-ingestão do MESMO arquivo = 0 LLM,
 *  arquivo crescido = só o delta, tag `canal:<slug>` aditiva quando há fonte.
 *  No-op sem DATABASE_URL. Brain `dedup-p1d-idempotente`. */
import { describe, it, expect, afterAll, vi, beforeEach } from "vitest";

// LEARNINGS M18/S2 — mocke o MÓDULO com importOriginal, contador via vi.hoisted (sem const top-level na factory).
const h = vi.hoisted(() => ({ calls: 0, lastQuotes: [] as string[] }));

vi.mock("../../src/core/extraction/extract.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/core/extraction/extract.ts")>();
  return {
    ...actual,
    // extractUnit devolve 1 claim por dimensão com context_quote VERBATIM do corpo da unit.
    extractUnit: vi.fn(async (_home: string, _page: any, unit: any, ctx: any) => {
      h.calls++;
      const out: Record<string, any[]> = {};
      const quote = String(unit.body || "").split("\n").find((l: string) => l.includes("R$")) || String(unit.body || "").slice(0, 80);
      h.lastQuotes.push(quote);
      for (const d of ctx.dims) {
        out[d] = [{ text: `claim mock de ${d}`, context_quote: quote, value: "R$ 30 mil", entity: "preco", predicate: "custa" }];
      }
      return out;
    }),
  };
});

// embeddings off (sem chamadas de rede); resolve sempre.
vi.mock("../../src/core/retrieval/embeddings.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/core/retrieval/embeddings.ts")>();
  return { ...actual, buildEmbeddings: vi.fn(async () => undefined) };
});

import { hasDb, rawConnect, wipeBrain } from "./helpers/db.ts";
import { getEngine, closeEngines, type SourceRow } from "../../src/core/platform/engine.ts";
import { processBlobJob } from "../../src/core/ingestion/process-blob-job.ts";
import type { IngestJob } from "../../src/core/ingestion/ingest-queue.ts";

const BRAIN = "dedup-p1d-idempotente";

let dbOk: Promise<boolean> | null = null;
async function dbAvailable(): Promise<boolean> {
  if (!hasDb()) return false;
  dbOk ??= (async () => {
    let sql: any;
    try {
      sql = await rawConnect();
      await Promise.race([
        sql`select 1`,
        new Promise((_, reject) => setTimeout(() => reject(new Error("db ping timeout")), 7000)),
      ]);
      return true;
    } catch {
      return false;
    } finally {
      if (sql) await sql.end({ timeout: 5 }).catch(() => {});
    }
  })();
  return dbOk;
}

async function reset(): Promise<void> {
  await wipeBrain(BRAIN);
  await closeEngines();
}

/** texto sintético > 80k chars (≥3 fatias de 40k) com fatos datados pra triagem achar worthy. */
function bigText(suffix = ""): string {
  const lines: string[] = [];
  // ~1200 linhas datadas × ~80 chars ≈ 96k chars → ≥3 fatias.
  for (let i = 0; i < 1200; i++) {
    const dia = String((i % 28) + 1).padStart(2, "0");
    lines.push(`[2026-03-${dia} 09:${String(i % 60).padStart(2, "0")}] Fulano${i % 5}: decidimos o preço de R$ 30 mil pro projeto ${i}.`);
  }
  return lines.join("\n") + suffix;
}

function textJob(id: string, text: string, extra: Partial<IngestJob> = {}): IngestJob {
  return {
    id,
    brain: BRAIN,
    kind: "text",
    status: "queued",
    type: "conversa",
    contentHash: null,
    filename: null,
    mime: null,
    title: "fixture p1d dedup",
    jobDate: "2026-03-01",
    textBody: text,
    progress: 0,
    message: null,
    resultJson: {},
    errorMessage: null,
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    batchId: null,
    batchStatus: null,
    batchCustomMap: null,
    sourceId: null,
    leaseUntil: null,
    attempts: 0,
    ...extra,
  };
}

async function pages() {
  const sql = await rawConnect();
  try {
    const r = await sql.unsafe(
      `select slug, title, external_id, extract_version, tags from galeed_pages where brain=$1 order by slug`,
      [BRAIN],
    );
    return r as any[];
  } finally {
    await sql.end({ timeout: 5 });
  }
}

beforeEach(() => {
  h.calls = 0;
  h.lastQuotes = [];
});

afterAll(async () => {
  await closeEngines();
});

describe("P1-D — dedup por fatia + canal", () => {
  it("Ingestão 1: 3+ páginas, external_id sl:<hash>, título sem /Y, mock chamado", async () => {
    if (!hasDb() || !(await dbAvailable())) return;
    await reset();
    try {
      const text = bigText();
      const res = await processBlobJob(textJob("job1", text));
      expect(res.total).toBeGreaterThanOrEqual(3);
      const ps = await pages();
      expect(ps.length).toBeGreaterThanOrEqual(3);
      for (const p of ps) {
        expect(p.external_id).toMatch(/^sl:[0-9a-f]{16}$/);
        // título "... (parte N)" SEM "/total"
        if (ps.length > 1) {
          expect(p.title).toMatch(/\(parte \d+\)$/);
          expect(p.title).not.toMatch(/\/\d+\)/);
        }
      }
      expect(h.calls).toBeGreaterThan(0);
    } finally {
      await reset();
    }
  });

  it("Mesmo arquivo 2× (L1+L3): skipped=total, msg não dupliquei, 0 chamadas novas", async () => {
    if (!hasDb() || !(await dbAvailable())) return;
    await reset();
    try {
      const text = bigText();
      const r1 = await processBlobJob(textJob("job1", text));
      const before = await pages();
      h.calls = 0; // zera após a 1ª ingestão
      const r2 = await processBlobJob(textJob("job2", text)); // mesmo texto
      expect(r2.skipped).toBe(r2.total);
      expect(r2.message).toContain("já estava no cérebro — não dupliquei");
      expect(h.calls).toBe(0); // 0 chamadas novas de LLM
      const after = await pages();
      expect(after.length).toBe(before.length); // contagem inalterada
      // extract_version preservado (não re-pagou Fase B)
      expect(after.every((p) => (p.extract_version || "") !== "")).toBe(true);
    } finally {
      await reset();
    }
  });

  it("Arquivo CRESCIDO (L1): só fatia(s) de fronteira/delta entram; antigas intactas", async () => {
    if (!hasDb() || !(await dbAvailable())) return;
    await reset();
    try {
      const text = bigText();
      await processBlobJob(textJob("job1", text));
      const before = await pages();
      const beforeSlugs = new Set(before.map((p) => p.slug));
      h.calls = 0;
      const grown = bigText("\n" + Array.from({ length: 60 }, (_, i) => `[2026-06-10 10:${String(i % 60).padStart(2, "0")}] Novo: mensagem nova sobre o preço de R$ 30 mil item ${i}.`).join("\n"));
      const r3 = await processBlobJob(textJob("job3", grown));
      const novos = r3.total - r3.skipped;
      expect(novos).toBeLessThanOrEqual(2); // ≤ 1 fronteira + delta
      // páginas antigas preservadas (mesmos slugs continuam existindo, extract_version intacto)
      const after = await pages();
      const afterSlugs = new Set(after.map((p) => p.slug));
      let preservadas = 0;
      for (const s of beforeSlugs) if (afterSlugs.has(s)) preservadas++;
      // a maioria das fatias antigas continua (só a fronteira pode ter "sumido" como id, mas a página fica)
      expect(preservadas).toBeGreaterThanOrEqual(before.length - 1);
    } finally {
      await reset();
    }
  });

  it("B10: com fonte → tags src:<id> E canal:<slug>, e fonte:upload|paste intactos", async () => {
    if (!hasDb() || !(await dbAvailable())) return;
    await reset();
    try {
      const e = await getEngine(BRAIN);
      const src: SourceRow = {
        id: "11111111-1111-1111-1111-111111111111",
        name: "WhatsApp da Accelera",
        channel: "whatsapp",
        type: "conversa",
        recipe: { fields: [] },
        default_sensitivity: "restrito",
        status: "ativa",
        last_read_at: null,
      };
      await e.upsertSource(src);
      const text = bigText();
      await processBlobJob(textJob("job-src", text, { sourceId: src.id, kind: "text" }));
      const ps = await pages();
      expect(ps.length).toBeGreaterThan(0);
      for (const p of ps) {
        const tags: string[] = p.tags ?? [];
        expect(tags).toContain(`src:${src.id}`);
        expect(tags).toContain("canal:whatsapp");
        // mecanismo de entrada intocado (kind text → fonte:paste)
        expect(tags.some((t) => t === "fonte:paste" || t === "fonte:upload")).toBe(true);
      }
    } finally {
      await reset();
    }
  });

  it("Sem fonte: NENHUMA tag canal:", async () => {
    if (!hasDb() || !(await dbAvailable())) return;
    await reset();
    try {
      const text = bigText();
      await processBlobJob(textJob("job-nosrc", text));
      const ps = await pages();
      for (const p of ps) {
        const tags: string[] = p.tags ?? [];
        expect(tags.some((t) => t.startsWith("canal:"))).toBe(false);
      }
    } finally {
      await reset();
    }
  });
});
