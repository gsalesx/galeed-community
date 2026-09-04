/** INTEGRAÇÃO M23-C/S4 — o SINAL da fila pro corpus real, no GATE da regra de ouro (DB real, SEM LLM).
 *  Prova mecânica do BRIEF item (6)/(4): sob a receita das 3 classes não-numéricas, o que casa
 *  (quote verbatim ancorado) vira FATO carimbado pela fonte; o que não casa (quote parafraseado →
 *  nao_ancorado; dimensão fora da receita → fora_da_receita) vira HIPÓTESE com motivo na fila.
 *  Determinística: roda applyRecipeGate (gate PURO) + putExtraction + deriveIncremental + a fila.
 *  Brain de teste descartável `__m23c_fila` — NUNCA o Accelera. No-op sem DATABASE_URL (ADR-014). */
import { describe, it, expect, afterAll } from "vitest";
import { hasDb, rawConnect, wipeBrain } from "./helpers/db.ts";
import { getEngine, closeEngines, type SourceRow } from "../../src/core/platform/engine.ts";
import { applyRecipeGate } from "../../src/core/ingestion/golden-rule.ts";
import { deriveIncremental } from "../../src/core/retrieval/indexer.ts";

const BRAIN = "__m23c_fila";
const SOURCE_ID = "m23c-fonte-fila";
const SLUG = "excertos-fila-m23c";

// envelope com excertos REAIS do S0: cit.2 de compromisso (prazo dia 17) + cit.3 de decisão (cold call).
const BODY =
  "Grupo de alunos — recados\n" +
  "[2025-09-12 11:03:55] Kelvin: Pessoal, time me passou o prazo aqui, quarta dia 17 teremos ela full rodando\n" +
  "[2025-08-21 18:45:02] Marcos: Pensei fazer cold call mas desisti.";

const RECIPE: SourceRow["recipe"] = {
  fields: [
    { dimension: "relacoes", label: "vínculo declarado", area: "" },
    { dimension: "decisoes", label: "decisão tomada ou descartada", area: "" },
    { dimension: "compromissos", label: "promessa assumida (com prazo)", area: "" },
  ],
};

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

describe("M23-C/S4 — sinal da fila (gate da regra de ouro, DB real, sem LLM)", () => {
  afterAll(async () => {
    if (await dbAvailable()) await wipeBrain(BRAIN);
    await closeEngines();
  });

  it("o que casa vira fato carimbado; o que não casa vira hipótese com motivo", async () => {
    await run(async () => {
      const e = await getEngine(BRAIN);

      // 1) fonte com a receita das 3 classes
      await e.upsertSource({
        id: SOURCE_ID,
        name: "Fonte M23-C fila",
        channel: "upload",
        type: "notas",
        recipe: RECIPE,
        default_sensitivity: "restrito",
        status: "ativa",
        last_read_at: null,
      });

      // 2) página notas carimbada pela fonte, com os excertos reais do S0
      await e.upsertPage({
        slug: SLUG,
        type: "notas",
        title: SLUG,
        date: "2025-09-12",
        path: "",
        body: BODY,
        content_hash: SLUG,
        tags: [`src:${SOURCE_ID}`],
        sensitivity: "restrito",
      });

      // 3) merged = o que o LLM produziria; roda o gate REAL
      const merged: Record<string, any[]> = {
        compromissos: [
          {
            // (a) quote VERBATIM do body, entidade nome próprio → APPROVED
            text: "Kelvin combinou ter o sistema full rodando na quarta dia 17",
            entity: "kelvin",
            predicate: "compromisso",
            value: "ter o sistema full rodando",
            context_quote: "quarta dia 17 teremos ela full rodando",
            prazo: "2025-09-17",
            com_quem: "time",
            valid_from: "2025-09-12",
          },
        ],
        decisoes: [
          {
            // (b) quote PARAFRASEADO (não-substring, sem overlap de tokens) → REJECTED nao_ancorado
            text: "Marcos decidiu abandonar a prospecção telefônica",
            entity: "marcos",
            predicate: "decisao",
            value: "nao fazer cold call",
            sentido: "descartada",
            context_quote: "resolveu abandonar definitivamente aquela abordagem ativa por ligações",
            valid_from: "2025-08-21",
          },
        ],
        precos: [
          {
            // (c) dimensão FORA da receita → REJECTED fora_da_receita
            text: "mensalidade subiu",
            entity: "kelvin",
            predicate: "preco",
            value_num: 2790,
            context_quote: "a mensalidade sobe pra 2790",
            valid_from: "2025-09-12",
          },
        ],
      };

      const gate = applyRecipeGate(merged, RECIPE, SOURCE_ID, SLUG, BODY);
      expect(gate.counts.approved).toBe(1);
      expect(gate.counts.rejected).toBe(2);
      const byDim = Object.fromEntries(gate.rejected.map((r) => [r.dimension, r.reason]));
      expect(byDim["decisoes"]).toBe("nao_ancorado");
      expect(byDim["precos"]).toBe("fora_da_receita");
      expect(gate.approved.compromissos).toHaveLength(1);
      expect(gate.approved.compromissos[0].source_id).toBe(SOURCE_ID);

      // 4) persiste o aprovado → deriva → o claim (a) vira FATO carimbado, valid_from = data da MENSAGEM
      await e.putExtraction({
        source_slug: SLUG,
        type: "notas",
        date: "2025-09-12",
        content_hash: SLUG,
        prompt_version: "m23c-test",
        extractions: gate.approved,
      });
      await deriveIncremental(BRAIN, [SLUG]);

      const sql = await rawConnect();
      try {
        const rows = await sql.unsafe(
          `select entity, predicate, status, source_id, valid_from, meta
             from galeed_facts
            where brain = $1 and predicate = 'compromisso'`,
          [BRAIN],
        );
        expect(rows.length).toBe(1);
        const f = rows[0];
        expect(f.status).toBe("fato");
        expect(f.predicate).toBe("compromisso");
        expect(f.source_id).toBe(SOURCE_ID);
        expect(String(f.valid_from)).toContain("2025-09-12"); // data da MENSAGEM, NÃO o prazo dia 17
        expect(f.meta?.prazo).toBe("2025-09-17"); // o prazo viaja em meta
        expect(f.meta?.com_quem).toBe("time");
      } finally {
        await sql.end({ timeout: 5 });
      }

      // 5) persiste a fila → os 2 rejeitados ficam pendentes com os motivos; re-rodar NÃO duplica
      await e.addReviewItems(gate.rejected);
      await e.addReviewItems(gate.rejected); // idempotente (on conflict do nothing)
      const pend = await e.listReview({ status: "pendente" });
      expect(pend.length).toBe(2);
      const reasons = new Set(pend.map((p) => p.reason));
      expect(reasons.has("nao_ancorado")).toBe(true);
      expect(reasons.has("fora_da_receita")).toBe(true);
      // ids determinísticos: re-gate produz os MESMOS ids
      const gate2 = applyRecipeGate(merged, RECIPE, SOURCE_ID, SLUG, BODY);
      expect(gate2.rejected.map((r) => r.id).sort()).toEqual(gate.rejected.map((r) => r.id).sort());
    });
  });
});
