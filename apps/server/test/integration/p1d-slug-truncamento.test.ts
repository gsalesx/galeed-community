/** INTEGRAÇÃO P1-D — slug estável: sufixo de hash DEPOIS do truncamento (A10/L4).
 *  Puro DB (sem LLM): dois conteúdos DIFERENTES com títulos longos colidentes não se sobrescrevem;
 *  o slug final ≤ 80 chars; conteúdo idêntico é determinístico (mesmo slug).
 *  No-op sem DATABASE_URL. Brain `slug-p1d-idempotente`. */
import { describe, it, expect, afterAll } from "vitest";
import { hasDb, rawConnect, wipeBrain } from "./helpers/db.ts";
import { getEngine, closeEngines } from "../../src/core/platform/engine.ts";
import { capture } from "../../src/core/ingestion/capture.ts";

const BRAIN = "slug-p1d-idempotente";

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

async function runWithDb(fn: () => Promise<void>): Promise<void> {
  if (!hasDb()) return;
  const ok = await dbAvailable();
  expect(ok, "DATABASE_URL definido, mas o Postgres de integração não respondeu.").toBe(true);
  if (!ok) return;
  await getEngine(BRAIN);
  await reset();
  try {
    await fn();
  } finally {
    await reset();
  }
}

async function bodyOf(slug: string): Promise<string | undefined> {
  const sql = await rawConnect();
  try {
    const r = await sql.unsafe(`select body from galeed_pages where brain=$1 and slug=$2`, [BRAIN, slug]);
    return r[0]?.body;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

afterAll(async () => {
  await closeEngines();
});

// título de 100+ chars com prefixo idêntico → slug-base trunca para os MESMOS 80 chars.
const TITULO = "Reuniao trimestral de planejamento estrategico e revisao de metas do time comercial regional sul";

describe("P1-D — slug com sufixo pós-truncamento (A10/L4)", () => {
  it("SEM externalId: títulos longos colidentes + corpos diferentes → 2 páginas, ≤80, sem sobrescrita", async () => {
    await runWithDb(async () => {
      const a = await capture({ home: BRAIN, text: "CORPO A — conteudo distinto numero um.", type: "reunioes", title: TITULO, date: "2026-03-03" });
      const b = await capture({ home: BRAIN, text: "CORPO B — conteudo distinto numero dois.", type: "reunioes", title: TITULO, date: "2026-03-03" });
      expect(a.slug).not.toBe(b.slug);
      expect(a.slug.length).toBeLessThanOrEqual(80);
      expect(b.slug.length).toBeLessThanOrEqual(80);
      // a 2ª (colidiu) carrega sufixo -<hash6>
      expect(b.slug).toMatch(/-[0-9a-f]{6}$/);
      // o corpo da 1ª NÃO foi sobrescrito (a perda silenciosa do A10)
      expect(await bodyOf(a.slug)).toBe("CORPO A — conteudo distinto numero um.\n");
      expect(await bodyOf(b.slug)).toBe("CORPO B — conteudo distinto numero dois.\n");
    });
  });

  it("COM externalId distinto por chamada: 2 páginas, slugs distintos ≤80", async () => {
    await runWithDb(async () => {
      const a = await capture({ home: BRAIN, text: "CORPO X distinto.", type: "reunioes", title: TITULO, date: "2026-03-03", externalId: "sl:aaaaaaaaaaaaaaaa" });
      const b = await capture({ home: BRAIN, text: "CORPO Y distinto.", type: "reunioes", title: TITULO, date: "2026-03-03", externalId: "sl:bbbbbbbbbbbbbbbb" });
      expect(a.slug).not.toBe(b.slug);
      expect(a.slug.length).toBeLessThanOrEqual(80);
      expect(b.slug.length).toBeLessThanOrEqual(80);
    });
  });

  it("determinístico: repetir mesmo conteúdo+externalId → skipped, slug idêntico", async () => {
    await runWithDb(async () => {
      const inp = { home: BRAIN, text: "Conteudo deterministico.", type: "reunioes", title: TITULO, date: "2026-03-03", externalId: "sl:cccccccccccccccc" };
      const a = await capture(inp);
      const b = await capture(inp);
      expect(a.skipped).toBe(false);
      expect(b.skipped).toBe(true);
      expect(b.slug).toBe(a.slug);
    });
  });
});
