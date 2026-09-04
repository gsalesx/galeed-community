/** INTEGRAÇÃO M21/S1 — SourceStore + ReviewStore (galeed_sources / galeed_ingest_review).
 *  Cobre o contrato que S2/S3/S4 consomem:
 *   - fonte: upsert/get/list escopados por brain; stats computadas na LEITURA (sem contador derivável);
 *   - fila de revisão: add idempotente, decisão one-shot, item descartado NUNCA some (invariante #5);
 *   - carimbo source_id nos fatos (retrocompat: ausente → '');
 *   - migração 24 idempotente (abrir o engine 2× não erra).
 *  No-op sem DATABASE_URL/GALEED_DB_URL/SUPABASE_DB_URL (padrão ADR-014). */
import { describe, it, expect, afterAll } from "vitest";
import { hasDb, rawConnect, wipeBrain } from "./helpers/db.ts";
import {
  getEngine,
  closeEngines,
  type FactRow,
  type SourceRow,
  type ReviewItemRow,
} from "../../src/core/platform/engine.ts";

const A = "__m21_a";
const B = "__m21_b";

const source = (id: string, extra: Partial<SourceRow> = {}): SourceRow => ({
  id,
  name: `Fonte ${id}`,
  channel: "upload",
  type: "reunioes",
  recipe: { fields: [{ dimension: "decisoes", label: "decisão", area: "reunioes" }] },
  default_sensitivity: "interno",
  status: "ativa",
  last_read_at: null,
  ...extra,
});

const fact = (slug: string, extra: Partial<FactRow> = {}): FactRow => ({
  source_slug: slug,
  type: "reunioes",
  dimension: "decisoes",
  idx: 0,
  text: `claim de ${slug}`,
  quote: `trecho de ${slug}`,
  meta: null,
  entity: "",
  predicate: "",
  value: "",
  valid_from: "2026-01-01",
  valid_to: "",
  confidence: 0.9,
  status: "fato",
  ...extra,
});

const review = (id: string, extra: Partial<ReviewItemRow> = {}): ReviewItemRow => ({
  id,
  source_id: "f1",
  source_slug: "pagina-1",
  dimension: "decisoes",
  text: `hipótese ${id}`,
  quote: `trecho ${id}`,
  claim: { text: `hipótese ${id}` },
  reason: "fora_da_receita",
  status: "pendente",
  decided_by: "",
  ...extra,
});

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

async function resetBrains(): Promise<void> {
  await wipeBrain(A);
  await wipeBrain(B);
  await closeEngines();
}

async function runWithDb(fn: () => Promise<void>): Promise<void> {
  if (!hasDb()) return;
  const ok = await dbAvailable();
  expect(
    ok,
    "DATABASE_URL/GALEED_DB_URL/SUPABASE_DB_URL está definido, mas o Postgres de integração não respondeu.",
  ).toBe(true);
  if (!ok) return;
  await resetBrains();
  try {
    await fn();
  } finally {
    await resetBrains();
  }
}

describe("M21/S1 — SourceStore + ReviewStore", () => {
  afterAll(async () => {
    if (await dbAvailable()) {
      await wipeBrain(A);
      await wipeBrain(B);
    }
    await closeEngines();
  });

  it("fonte: upsert + get + list; isolamento entre brains", async () => {
    await runWithDb(async () => {
      const ea = await getEngine(A);
      const eb = await getEngine(B);
      await ea.upsertSource(source("f1"));

      const got = await ea.getSource("f1");
      expect(got).toBeDefined();
      expect(got!.name).toBe("Fonte f1");
      expect(got!.recipe.fields[0].dimension).toBe("decisoes");
      expect(got!.default_sensitivity).toBe("interno");
      expect(got!.status).toBe("ativa");
      expect(got!.last_read_at).toBeNull();

      // brain B não vê a fonte de A
      expect(await eb.getSource("f1")).toBeUndefined();
      expect(await eb.listSources()).toEqual([]);

      // upsert atualiza sem perder last_read_at/created_at
      await ea.touchSourceRead("f1");
      await ea.upsertSource(source("f1", { name: "Fonte f1 v2", status: "pausada" }));
      const v2 = await ea.getSource("f1");
      expect(v2!.name).toBe("Fonte f1 v2");
      expect(v2!.status).toBe("pausada");
      expect(v2!.last_read_at).not.toBeNull();

      await ea.setSourceStatus("f1", "ativa");
      expect((await ea.getSource("f1"))!.status).toBe("ativa");
    });
  });

  it("listSources computa pages_count/facts_count na leitura", async () => {
    await runWithDb(async () => {
      const e = await getEngine(A);
      await e.upsertSource(source("f1"));
      await e.upsertPage({
        slug: "pagina-1",
        type: "reunioes",
        title: "pagina-1",
        date: "2026-01-01",
        path: "",
        body: "corpo",
        content_hash: "pagina-1",
        tags: ["src:f1"],
      });
      await e.putFacts([fact("pagina-1", { source_id: "f1" })]);

      const list = await e.listSources();
      expect(list).toHaveLength(1);
      expect(list[0].id).toBe("f1");
      expect(list[0].pages_count).toBe(1);
      expect(list[0].facts_count).toBe(1);
    });
  });

  it("putFacts sem source_id → leitura devolve '' (retrocompat)", async () => {
    await runWithDb(async () => {
      const e = await getEngine(A);
      await e.putFacts([fact("pagina-legada")]);
      const hits = await e.facts("decisoes", {});
      expect(hits).toHaveLength(1);
      expect(hits[0].source_id).toBe("");
    });
  });

  it("fila de revisão: counts, decisão one-shot, descartada continua legível (invariante #5)", async () => {
    await runWithDb(async () => {
      const e = await getEngine(A);
      await e.addReviewItems([review("i1"), review("i2")]);
      expect(await e.reviewCounts()).toEqual({ pendente: 2, aprovada: 0, descartada: 0 });

      // re-post do mesmo id não duplica (idempotência de re-harvest)
      await e.addReviewItems([review("i1")]);
      expect(await e.reviewCounts()).toEqual({ pendente: 2, aprovada: 0, descartada: 0 });

      await e.setReviewStatus("i1", "aprovada", "demo@galeed.app");
      expect(await e.reviewCounts()).toEqual({ pendente: 1, aprovada: 1, descartada: 0 });

      // decisão é one-shot: segundo setReviewStatus no MESMO item é no-op
      await e.setReviewStatus("i1", "descartada", "outro@galeed.app");
      const i1 = await e.getReviewItem("i1");
      expect(i1!.status).toBe("aprovada");
      expect(i1!.decided_by).toBe("demo@galeed.app");
      expect(i1!.decided_at).not.toBeNull();

      // descartar não deleta: item segue legível com decided_by/decided_at
      await e.setReviewStatus("i2", "descartada", "demo@galeed.app");
      const descartadas = await e.listReview({ status: "descartada" });
      expect(descartadas.map((r) => r.id)).toEqual(["i2"]);
      expect(descartadas[0].decided_by).toBe("demo@galeed.app");
      expect(descartadas[0].decided_at).not.toBeNull();
      expect(descartadas[0].claim).toEqual({ text: "hipótese i2" });
      expect(await e.reviewCounts()).toEqual({ pendente: 0, aprovada: 1, descartada: 1 });

      // default do listReview = pendentes
      expect(await e.listReview()).toEqual([]);
    });
  });

  it("getExtraction devolve a ExtractionRow completa (undefined se nunca extraída)", async () => {
    await runWithDb(async () => {
      const e = await getEngine(A);
      expect(await e.getExtraction("nao-existe")).toBeUndefined();
      await e.putExtraction({
        source_slug: "pagina-1",
        type: "reunioes",
        date: "2026-01-01",
        content_hash: "h1",
        prompt_version: "v-test",
        extractions: { decisoes: [{ text: "claim" }] },
      });
      const row = await e.getExtraction("pagina-1");
      expect(row).toMatchObject({
        source_slug: "pagina-1",
        type: "reunioes",
        content_hash: "h1",
        prompt_version: "v-test",
      });
      expect(row!.extractions.decisoes).toHaveLength(1);
    });
  });

  it("migração 24 é idempotente: abrir o engine 2× não erra", async () => {
    await runWithDb(async () => {
      await getEngine(A);
      await closeEngines();
      const e = await getEngine(A); // ensureSchema + migrações rodam de novo
      await e.upsertSource(source("f-mig"));
      expect((await e.getSource("f-mig"))!.id).toBe("f-mig");
    });
  });
});
