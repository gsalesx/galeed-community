/** INTEGRAÇÃO M23-C/S4 — "o que foi combinado com X?" respondível por FATO via router (DB real, SEM LLM).
 *  Prova o gate BRIEF §6.6 de forma determinística: um compromisso da convenção §2.1, semeado pelo
 *  MOTOR (não INSERT direto), é roteado por factsForQuery e aparece no bloco de fatos com selo de fonte.
 *  A síntese fim-a-fim (Sonnet) é o e2e manual §4.4. Brain descartável `__m23c_router` — NUNCA Accelera. */
import { describe, it, expect, afterAll } from "vitest";
import { hasDb, rawConnect, wipeBrain } from "./helpers/db.ts";
import { getEngine, closeEngines } from "../../src/core/platform/engine.ts";
import { deriveIncremental } from "../../src/core/retrieval/indexer.ts";
import { factsForQuery } from "../../src/core/retrieval/ask.ts";

const BRAIN = "__m23c_router";
const SLUG = "compromisso-kelvin-m23c";

// excerto cit.5 de compromisso (a cobrança dos documentos que o Kelvin ia disponibilizar) +
// a mensagem onde kelvin promete, com timestamp. O quote do claim é VERBATIM da fala do Kelvin.
const BODY =
  "Grupo de alunos — mapeamento de nichos\n" +
  "[2025-10-03 09:20:11] Ana: Alguém tem aqueles documentos que o Kelvin ia disponibilizar, sobre o mapeamento de alguns nichos específicos?\n" +
  "[2025-10-03 10:05:42] Kelvin: vou disponibilizar os documentos do mapeamento de nichos pra vocês";

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

async function run(fn: () => Promise<void>): Promise<void> {
  if (!hasDb()) return;
  const ok = await dbAvailable();
  expect(ok, "DATABASE_URL definido mas o Postgres de integração não respondeu.").toBe(true);
  if (!ok) return;
  await wipeBrain(BRAIN);
  await closeEngines();
  try {
    await fn();
  } finally {
    await wipeBrain(BRAIN);
    await closeEngines();
  }
}

describe("M23-C/S4 — router de fatos: 'o que foi combinado com X?' (DB real, sem LLM)", () => {
  afterAll(async () => {
    if (await dbAvailable()) await wipeBrain(BRAIN);
    await closeEngines();
  });

  it("o compromisso do kelvin é roteado por fato com selo de fonte; controle não dispara", async () => {
    await run(async () => {
      const e = await getEngine(BRAIN);

      await e.upsertPage({
        slug: SLUG,
        type: "notas",
        title: SLUG,
        date: "2025-10-03",
        path: "",
        body: BODY,
        content_hash: SLUG,
        sensitivity: "publico", // sem scope no teste; público p/ leitura limpa
      });

      await e.putExtraction({
        source_slug: SLUG,
        type: "notas",
        date: "2025-10-03",
        content_hash: SLUG,
        prompt_version: "m23c-test",
        extractions: {
          compromissos: [
            {
              text: "Kelvin se comprometeu a disponibilizar os documentos do mapeamento de nichos",
              entity: "kelvin",
              predicate: "compromisso",
              value: "disponibilizar os documentos do mapeamento de nichos",
              context_quote: "vou disponibilizar os documentos do mapeamento de nichos pra vocês",
              valid_from: "2025-10-03",
            },
          ],
        },
      });
      await deriveIncremental(BRAIN, [SLUG]);

      // o fato precisa ter virado 'fato' (quote verbatim ancorado) p/ o router servir
      const sql = await rawConnect();
      try {
        const rows = await sql.unsafe(
          `select status from galeed_facts where brain=$1 and predicate='compromisso'`,
          [BRAIN],
        );
        expect(rows.length).toBe(1);
        expect(rows[0].status).toBe("fato");
      } finally {
        await sql.end({ timeout: 5 });
      }

      const r = await factsForQuery(BRAIN, "o que foi combinado com kelvin?");
      expect(r.entities).toContain("kelvin");
      expect(r.block).toContain("kelvin · compromisso");
      expect(r.block).toContain(`cite:${SLUG}`);

      // pergunta-controle: nenhuma entidade casa → router não dispara
      const ctrl = await factsForQuery(BRAIN, "qual o preço da tabela nova?");
      expect(ctrl.block).toBe("");
    });
  });
});
