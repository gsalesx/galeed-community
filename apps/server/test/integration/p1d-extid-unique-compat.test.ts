/** INTEGRAÇÃO P1-D — UNIQUE (brain, external_id) + escrita atômica + compat de transição (A6/M9b).
 *  Puro DB (sem LLM): exercita o índice UNIQUE parcial (migração 28), `insertPageIfNew`, o TOCTOU
 *  morto do capture, a migração de formato velho→`sl:` e o dedupe defensivo.
 *  No-op sem DATABASE_URL (padrão ADR-014). Brain único sufixado `p1d-idempotente` (banco compartilhado). */
import { describe, it, expect, afterAll } from "vitest";
import { createHash } from "node:crypto";
import { hasDb, rawConnect, wipeBrain } from "./helpers/db.ts";
import { getEngine, closeEngines } from "../../src/core/platform/engine.ts";
import { capture } from "../../src/core/ingestion/capture.ts";
import { MIGRATIONS } from "../../src/core/platform/migrations.ts";

const BRAIN = "compat-p1d-idempotente";
const sha16 = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

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
  // boot o engine 1× p/ garantir migração 28 aplicada (membership), depois limpa.
  await getEngine(BRAIN);
  await reset();
  try {
    await fn();
  } finally {
    await reset();
  }
}

/** insere uma página direto no DB (sem capture) — controla external_id/content_hash p/ os seeds. */
async function seed(sql: any, row: { slug: string; body: string; content_hash: string; external_id: string | null; extract_version?: string }) {
  await sql.unsafe(
    `insert into galeed_pages (brain, slug, type, title, date, path, body, content_hash, external_id, people, tags, extract_version)
     values ($1,$2,'conversa',$2,'2026-01-01','',$3,$4,$5,'[]'::jsonb,'[]'::jsonb,$6)`,
    [BRAIN, row.slug, row.body, row.content_hash, row.external_id, row.extract_version ?? ""],
  );
}

async function pageCount(sql: any): Promise<number> {
  const r = await sql.unsafe(`select count(*)::int c from galeed_pages where brain=$1`, [BRAIN]);
  return r[0].c;
}

afterAll(async () => {
  await closeEngines();
});

describe("P1-D — UNIQUE external_id + compat de transição", () => {
  it("UNIQUE vivo: (brain, external_id) repetido falha 23505; '' e null convivem", async () => {
    await runWithDb(async () => {
      const sql = await rawConnect();
      try {
        await seed(sql, { slug: "p-a", body: "a\n", content_hash: "aaaa", external_id: "sl:dup" });
        let code = "";
        try {
          await seed(sql, { slug: "p-b", body: "b\n", content_hash: "bbbb", external_id: "sl:dup" });
        } catch (err: any) {
          code = err?.code ?? "";
        }
        expect(code).toBe("23505");
        // external_id '' e null: N linhas convivem (índice parcial)
        await seed(sql, { slug: "p-c", body: "c\n", content_hash: "cccc", external_id: "" });
        await seed(sql, { slug: "p-d", body: "d\n", content_hash: "dddd", external_id: "" });
        await seed(sql, { slug: "p-e", body: "e\n", content_hash: "eeee", external_id: null });
        await seed(sql, { slug: "p-f", body: "f\n", content_hash: "ffff", external_id: null });
        expect(await pageCount(sql)).toBe(5); // p-a + 2 vazias + 2 nulas
      } finally {
        await sql.end({ timeout: 5 });
      }
    });
  });

  it("insertPageIfNew: 1ª=true; 2ª (mesmo external_id, outro slug/corpo)=false e original INTACTA", async () => {
    await runWithDb(async () => {
      const e = await getEngine(BRAIN);
      const first = await e.insertPageIfNew({
        slug: "orig", type: "conversa", title: "orig", date: "2026-01-01", path: "",
        body: "corpo original\n", content_hash: "h1", external_id: "sl:atomic", people: [], tags: [], extract_version: "v1",
      });
      expect(first).toBe(true);
      const second = await e.insertPageIfNew({
        slug: "outro", type: "conversa", title: "outro", date: "2026-01-01", path: "",
        body: "corpo NOVO\n", content_hash: "h2", external_id: "sl:atomic", people: [], tags: [], extract_version: "",
      });
      expect(second).toBe(false);
      // linha original intacta: corpo e extract_version preservados, só 1 linha com esse extid
      const sql = await rawConnect();
      try {
        const r = await sql.unsafe(
          `select body, extract_version from galeed_pages where brain=$1 and external_id='sl:atomic'`,
          [BRAIN],
        );
        expect(r.length).toBe(1);
        expect(r[0].body).toBe("corpo original\n");
        expect(r[0].extract_version).toBe("v1");
      } finally {
        await sql.end({ timeout: 5 });
      }
    });
  });

  it("insertPageIfNew exige external_id não-vazio", async () => {
    await runWithDb(async () => {
      const e = await getEngine(BRAIN);
      await expect(
        e.insertPageIfNew({
          slug: "x", type: "conversa", title: "x", date: "2026-01-01", path: "",
          body: "x\n", content_hash: "h", external_id: "", people: [], tags: [], extract_version: "",
        }),
      ).rejects.toThrow(/external_id/);
    });
  });

  it("TOCTOU morto (M9b): capture(X) concorrente com mesmo externalId → 1 insere, mesmo slug", async () => {
    await runWithDb(async () => {
      const texto = "Conversa real sobre o preço de R$ 30 mil em 2026.";
      const extId = `sl:${sha16(texto)}`;
      const inp = { home: BRAIN, text: texto, type: "conversa", title: "Conversa", date: "2026-02-02", externalId: extId };
      const [a, b] = await Promise.all([capture(inp), capture(inp)]);
      const inserted = [a, b].filter((r) => r.skipped === false);
      expect(inserted.length).toBe(1);
      expect(a.slug).toBe(b.slug);
      const sql = await rawConnect();
      try {
        const r = await sql.unsafe(`select count(*)::int c from galeed_pages where brain=$1 and external_id=$2`, [BRAIN, extId]);
        expect(r[0].c).toBe(1);
      } finally {
        await sql.end({ timeout: 5 });
      }
    });
  });

  it("compat de TRANSIÇÃO (L2): formato velho migra p/ sl:<hash>; re-captura = 0 duplicata", async () => {
    await runWithDb(async () => {
      const sql = await rawConnect();
      try {
        // semeia N páginas no formato VELHO: external_id = content_hash || '#1'.
        // content_hash = sha16(texto) (pré-trim), body = texto.trim()+"\n" — espelha capture.ts:39,69.
        const textos = ["Primeira fatia do export.", "Segunda fatia com fato datado: R$ 30 mil em 2026.", "Terceira fatia final."];
        for (let i = 0; i < textos.length; i++) {
          const h = sha16(textos[i]);
          await seed(sql, { slug: `velha-${i}`, body: textos[i].trim() + "\n", content_hash: h, external_id: `${h}#1`, extract_version: "v-pre" });
        }
        expect(await pageCount(sql)).toBe(textos.length);
        // re-roda o CORPO da migração 28 (idempotente) sobre os seeds
        await sql.unsafe(MIGRATIONS.find((m) => m.id === 28)!.sql);
        // (a) external_id virou sl:<content_hash>
        const formats = await sql.unsafe(`select external_id from galeed_pages where brain=$1 order by slug`, [BRAIN]);
        for (let i = 0; i < textos.length; i++) {
          expect(formats[i].external_id).toBe(`sl:${sha16(textos[i])}`);
        }
        await sql.end({ timeout: 5 });
      } catch (e) {
        await sql.end({ timeout: 5 }).catch(() => {});
        throw e;
      }
      // fecha o engine pra forçar nova conexão limpa pós-migração-manual
      await closeEngines();
      // (b) re-capturar o MESMO texto → skipped, contagem inalterada
      const sql2 = await rawConnect();
      let before = 0;
      try { before = await pageCount(sql2); } finally { await sql2.end({ timeout: 5 }); }
      const textos2 = ["Primeira fatia do export.", "Segunda fatia com fato datado: R$ 30 mil em 2026.", "Terceira fatia final."];
      for (const t of textos2) {
        const cap = await capture({ home: BRAIN, text: t, type: "conversa", title: "x", date: "2026-01-01", externalId: `sl:${sha16(t)}` });
        expect(cap.skipped).toBe(true);
      }
      const sql3 = await rawConnect();
      try { expect(await pageCount(sql3)).toBe(before); } finally { await sql3.end({ timeout: 5 }); }
    });
  });

  it("dedupe defensivo: extids velhos DIFERENTES mas mesmo content_hash → digerida mantém, outra esvazia, nenhuma apagada", async () => {
    await runWithDb(async () => {
      const sql = await rawConnect();
      try {
        const texto = "Fatia duplicada no corpus.";
        const h = sha16(texto);
        const body = texto.trim() + "\n";
        // duas páginas com extid velho DIFERENTE mas que migram pro MESMO sl:<h>
        await seed(sql, { slug: "dup-digerida", body, content_hash: h, external_id: `${h}#1`, extract_version: "v-pre" });
        await seed(sql, { slug: "dup-crua", body, content_hash: h, external_id: `${h}#2`, extract_version: "" });
        expect(await pageCount(sql)).toBe(2);
        await sql.unsafe(MIGRATIONS.find((m) => m.id === 28)!.sql);
        const r = await sql.unsafe(`select slug, external_id from galeed_pages where brain=$1 order by slug`, [BRAIN]);
        const bySlug = Object.fromEntries(r.map((x: any) => [x.slug, x.external_id]));
        expect(bySlug["dup-digerida"]).toBe(`sl:${h}`); // a digerida mantém o sl:<hash>
        expect(bySlug["dup-crua"]).toBe(""); // a outra fica vazia
        expect(await pageCount(sql)).toBe(2); // NENHUMA apagada
      } finally {
        await sql.end({ timeout: 5 });
      }
    });
  });

  it("webhook intocado: external_id declarado pelo cliente atravessa a migração byte-idêntico", async () => {
    await runWithDb(async () => {
      const sql = await rawConnect();
      try {
        await seed(sql, { slug: "evt-page", body: "evento\n", content_hash: "h", external_id: "evt-cliente-123" });
        await sql.unsafe(MIGRATIONS.find((m) => m.id === 28)!.sql);
        const r = await sql.unsafe(`select external_id from galeed_pages where brain=$1 and slug='evt-page'`, [BRAIN]);
        expect(r[0].external_id).toBe("evt-cliente-123");
      } finally {
        await sql.end({ timeout: 5 });
      }
    });
  });
});
