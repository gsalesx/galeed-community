/** INTEGRAÇÃO M22-C — e-mail (record Gmail) → normalizador → seam → pipeline → fato carimbado.
 *  DB real :5434; LLM MOCKADO (vi.mock de extract.ts trocando SÓ extractUnit; buildEmbeddings resolve).
 *  Padrão do p1d-dedup-fatia.test.ts (vi.hoisted, IngestJob literal COMPLETO, processBlobJob direto).
 *  Prova: página com a DATA DO E-MAIL (≠ hoje); fato com valid_from=data-do-email (fallback page.date,
 *  P1-A); claim fora_da_receita (facts) na fila de revisão; re-sync = 0 duplicata / 0 LLM; html-only não
 *  quebra; fonte pausada falha fechado. Brain __m22c_gmail (wipe antes/depois). No-op sem DATABASE_URL. */
import { describe, it, expect, afterAll, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// LEARNINGS M18/S2 — mocke o MÓDULO; contador via vi.hoisted (sem const top-level na factory).
const h = vi.hoisted(() => ({ calls: 0 }));

vi.mock("../../src/core/extraction/extract.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/core/extraction/extract.ts")>();
  return {
    ...actual,
    // 1 claim por dim da receita: context_quote VERBATIM da linha ancorável do corpo, entity "maria",
    // SEM valid_from/date (prova a âncora P1-A no page.date). precos = numérico (R$ 30 mil → ancorado);
    // demais = textual (não-numérico → grounded basta). `facts` (fora da receita) também emitido.
    extractUnit: vi.fn(async (_home: string, _page: any, unit: any, ctx: any) => {
      h.calls++;
      const quote =
        String(unit.body || "")
          .split("\n")
          .find((l: string) => l.includes("R$ 30 mil")) || "A proposta do tier 2 fica em R$ 30 mil por ano.";
      const out: Record<string, any[]> = {};
      const byDim: Record<string, { predicate: string; value: string }> = {
        relacoes: { predicate: "relacao", value: "cliente" },
        decisoes: { predicate: "decisao", value: "fechar proposta tier 2" },
        compromissos: { predicate: "compromisso", value: "enviar contrato" },
        precos: { predicate: "preco", value: "R$ 30 mil" },
        facts: { predicate: "observacao", value: "tom cordial" },
      };
      for (const d of ctx.dims) {
        const spec = byDim[d] ?? { predicate: "obs", value: "x" };
        out[d] = [
          { text: `claim mock de ${d}`, context_quote: quote, entity: "maria", predicate: spec.predicate, value: spec.value },
        ];
      }
      return out;
    }),
  };
});

vi.mock("../../src/core/retrieval/embeddings.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/core/retrieval/embeddings.ts")>();
  return { ...actual, buildEmbeddings: vi.fn(async () => undefined) };
});

import { hasDb, rawConnect, wipeBrain } from "./helpers/db.ts";
import { getEngine, closeEngines } from "../../src/core/platform/engine.ts";
import { processBlobJob } from "../../src/core/ingestion/process-blob-job.ts";
import type { IngestJob } from "../../src/core/ingestion/ingest-queue.ts";
import {
  normalizeGmailMessage,
  emailSourceSeed,
  type GmailMessageRecord,
} from "../../src/core/ingestion/connectors/gmail.ts";

const BRAIN = "__m22c_gmail";
const SOURCE_ID = "m22c-fonte-email";

function fix(name: string): GmailMessageRecord {
  const p = fileURLToPath(new URL(`../unit/fixtures/gmail/${name}.json`, import.meta.url));
  return JSON.parse(readFileSync(p, "utf8")) as GmailMessageRecord;
}

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

/** Job literal COMPLETO (todos os campos — LEARNINGS M16-reconcile) pro doc normalizado de um e-mail. */
function emailJob(id: string, doc: { content: string; title: string; timestamp: string }): IngestJob {
  return {
    id,
    brain: BRAIN,
    kind: "text",
    status: "queued",
    type: "email",
    contentHash: null,
    filename: null,
    mime: null,
    title: doc.title,
    jobDate: doc.timestamp.slice(0, 10), // a DATA DO E-MAIL (seam M22-A: jobDate = timestamp.slice(0,10))
    textBody: doc.content,
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
    sourceId: SOURCE_ID,
    leaseUntil: null,
    attempts: 0,
  };
}

async function queryFacts() {
  const sql = await rawConnect();
  try {
    return (await sql.unsafe(
      `select entity, predicate, value, status, valid_from, source_id from galeed_facts where brain=$1 order by predicate`,
      [BRAIN],
    )) as any[];
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function queryReview() {
  const sql = await rawConnect();
  try {
    return (await sql.unsafe(
      `select dimension, reason, status, source_id from galeed_ingest_review where brain=$1`,
      [BRAIN],
    )) as any[];
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function countPages(): Promise<number> {
  const sql = await rawConnect();
  try {
    const r = (await sql.unsafe(`select count(*)::int n from galeed_pages where brain=$1`, [BRAIN])) as any[];
    return r[0]?.n ?? 0;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

beforeEach(() => {
  h.calls = 0;
});

afterAll(async () => {
  await closeEngines();
});

describe("M22-C pipeline — e-mail → fato carimbado com a data do e-mail", () => {
  it("1. página com a DATA DO E-MAIL (≠ hoje), body começa com 'De: ', tags src+canal, sensitivity interno", async () => {
    if (!hasDb() || !(await dbAvailable())) return;
    await reset();
    try {
      const e = await getEngine(BRAIN);
      await e.upsertSource(emailSourceSeed(SOURCE_ID));
      const doc = normalizeGmailMessage(fix("message-multipart"))!;
      const res = await processBlobJob(emailJob("job1", doc));
      expect(res.total).toBeGreaterThanOrEqual(1);
      const slug = res.slugs[0];
      const page = await e.getPage(slug);
      expect(page).toBeDefined();
      expect(page!.date).toBe("2025-05-14"); // a data DO E-MAIL, não hoje
      expect(new Date().toISOString().slice(0, 10)).not.toBe("2025-05-14");
      expect(page!.body.startsWith("De: ")).toBe(true);
      expect(page!.tags).toContain(`src:${SOURCE_ID}`);
      expect(page!.tags).toContain("canal:gmail");
      expect(page!.sensitivity).toBe("interno");
    } finally {
      await reset();
    }
  });

  it("2. fato carimbado: valid_from = data do e-mail (P1-A page.date); claim fora_da_receita (facts) na fila", async () => {
    if (!hasDb() || !(await dbAvailable())) return;
    await reset();
    try {
      const e = await getEngine(BRAIN);
      await e.upsertSource(emailSourceSeed(SOURCE_ID));
      const doc = normalizeGmailMessage(fix("message-multipart"))!;
      await processBlobJob(emailJob("job1", doc));

      const facts = await queryFacts();
      const fatos = facts.filter((f) => f.status === "fato" && f.source_id === SOURCE_ID);
      expect(fatos.length).toBeGreaterThan(0);
      // todo fato vigente ancora na data do e-mail (mock sem valid_from → fallback page.date, P1-A)
      for (const f of fatos) expect(f.valid_from).toBe("2025-05-14");

      // o claim da dim `facts` (fora da receita do e-mail) cai na fila como fora_da_receita
      const review = await queryReview();
      const fora = review.filter((r) => r.dimension === "facts" && r.reason === "fora_da_receita");
      expect(fora.length).toBeGreaterThan(0);
      expect(fora[0].source_id).toBe(SOURCE_ID);
    } finally {
      await reset();
    }
  });

  it("3. re-sync = zero duplicata: skipped=total, 0 LLM, contagem de páginas inalterada", async () => {
    if (!hasDb() || !(await dbAvailable())) return;
    await reset();
    try {
      const e = await getEngine(BRAIN);
      await e.upsertSource(emailSourceSeed(SOURCE_ID));
      const doc = normalizeGmailMessage(fix("message-multipart"))!;
      await processBlobJob(emailJob("job1", doc));
      const pagesBefore = await countPages();
      h.calls = 0;

      const r2 = await processBlobJob(emailJob("job2", doc)); // MESMO textBody
      expect(r2.skipped).toBe(r2.total);
      expect(h.calls).toBe(0); // zero chamadas de LLM
      expect(await countPages()).toBe(pagesBefore); // nada novo
    } finally {
      await reset();
    }
  });

  it("4. html-only não quebra: página criada, body com a frase ancorável, tags da fonte", async () => {
    if (!hasDb() || !(await dbAvailable())) return;
    await reset();
    try {
      const e = await getEngine(BRAIN);
      await e.upsertSource(emailSourceSeed(SOURCE_ID));
      const doc = normalizeGmailMessage(fix("message-html-only"))!;
      const res = await processBlobJob(emailJob("job-html", doc));
      const page = await e.getPage(res.slugs[0]);
      expect(page).toBeDefined();
      expect(page!.body).toContain("A proposta do tier 2 fica em R$ 30 mil por ano.");
      expect(page!.body).not.toContain("<p");
      expect(page!.tags).toContain("canal:gmail");
    } finally {
      await reset();
    }
  });

  it("5. fonte pausada falha fechado (espelho conservado de process-blob-job)", async () => {
    if (!hasDb() || !(await dbAvailable())) return;
    await reset();
    try {
      const e = await getEngine(BRAIN);
      await e.upsertSource({ ...emailSourceSeed(SOURCE_ID), status: "pausada" });
      const doc = normalizeGmailMessage(fix("message-multipart"))!;
      await expect(processBlobJob(emailJob("job-pausada", doc))).rejects.toThrow(/pausada/);
    } finally {
      await reset();
    }
  });
});
