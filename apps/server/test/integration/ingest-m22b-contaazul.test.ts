/** INTEGRAÇÃO M22-B — conector Conta Azul end-to-end no DB real (:5434), ZERO LLM. É o gate §5.2
 *  do BRIEF executável: fato carimbado pela fonte com sensibilidade restrito; valid_from = data do
 *  EVENTO (nunca hoje); supersessão bitemporal por série tier (update supersede, venda nova não
 *  apaga antiga); re-sync = zero duplicata; claim fora da receita/entidade vaga → fila; ZERO linha
 *  em galeed_llm_usage; fail-closed em fonte pausada. Brains descartáveis sufixados — NUNCA o
 *  Accelera. No-op sem DATABASE_URL (ADR-014). */
import { describe, it, expect, afterAll } from "vitest";
import { hasDb, rawConnect, wipeBrain } from "./helpers/db.ts";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getEngine, closeEngines } from "../../src/core/platform/engine.ts";
import {
  seedContaAzulSource,
  ingestContaAzulBatch,
  ingestContaAzulPages,
  normalizeContaAzulBatch,
  type ContaAzulBatch,
} from "../../src/core/ingestion/connectors/conta-azul.ts";

const BRAIN = "__m22b_contaazul";
const BRAIN_PAUSADA = "__m22b_contaazul_pausada";

function fixture(name: string): any {
  const p = fileURLToPath(new URL(`../unit/fixtures/conta-azul/${name}`, import.meta.url));
  return JSON.parse(readFileSync(p, "utf-8"));
}
const VENDAS = fixture("vendas.json").itens as any[]; // [1001, 1002, 1001-update]
const PAGAR = fixture("contas-a-pagar.json").itens as any[];

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

async function run(brains: string[], fn: () => Promise<void>): Promise<void> {
  if (!hasDb()) return;
  const ok = await dbAvailable();
  expect(ok, "DATABASE_URL definido mas o Postgres de integração não respondeu.").toBe(true);
  if (!ok) return;
  for (const b of brains) await wipeBrain(b);
  await closeEngines();
  try {
    await fn();
  } finally {
    for (const b of brains) await wipeBrain(b);
    await closeEngines();
  }
}

async function countRows(brain: string, table: string): Promise<number> {
  const sql = await rawConnect();
  try {
    const rows = await sql.unsafe(`select count(*)::int as n from ${table} where brain = $1`, [brain]);
    return rows[0].n;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

describe("M22-B — conector Conta Azul (DB real, zero LLM)", () => {
  afterAll(async () => {
    if (await dbAvailable()) {
      await wipeBrain(BRAIN);
      await wipeBrain(BRAIN_PAUSADA);
    }
    await closeEngines();
  });

  it("fato carimbado, valid_from do evento, supersessão por série, re-sync sem duplicata, gate e zero LLM", async () => {
    await run([BRAIN], async () => {
      await seedContaAzulSource(BRAIN);

      // 1º lote: vendas 1001 e 1002 (SEM o record de update)
      const loteInicial: ContaAzulBatch = { model: "vendas", records: [VENDAS[0], VENDAS[1]] };
      const r1 = await ingestContaAzulBatch(BRAIN, "conta-azul", loteInicial);
      expect(r1.paginasNovas).toBe(2);
      expect(r1.claimsAprovados).toBe(2);

      const sql = await rawConnect();
      try {
        // (1) fato carimbado com a fonte + tags + sensibilidade restrito
        const facts = await sql.unsafe(
          `select entity, predicate, tier, status, source_id, valid_from, value_num
             from galeed_facts where brain = $1 and predicate = 'venda' order by tier`,
          [BRAIN],
        );
        expect(facts.length).toBe(2);
        for (const f of facts) expect(f.source_id).toBe("conta-azul");

        const pages = await sql.unsafe(
          `select slug, tags, sensitivity from galeed_pages where brain = $1`,
          [BRAIN],
        );
        expect(pages.length).toBe(2);
        for (const pg of pages) {
          expect(pg.tags).toContain("src:conta-azul");
          expect(pg.tags).toContain("area:financeiro");
          expect(pg.sensitivity).toBe("restrito");
        }

        // (2) valid_from = data do EVENTO (2026-03-10), NUNCA hoje
        const v1001 = facts.find((f: any) => f.tier === "venda-1001");
        expect(String(v1001.valid_from)).toContain("2026-03-10");
        const hoje = new Date().toISOString().slice(0, 10);
        if (hoje !== "2026-03-10") expect(String(v1001.valid_from)).not.toContain(hoje);
        expect(Number(v1001.value_num)).toBe(1250);
      } finally {
        await sql.end({ timeout: 5 });
      }

      // 2º lote: UPDATE da venda 1001 (total 1250→1500, data_alteracao posterior)
      const loteUpdate: ContaAzulBatch = { model: "vendas", records: [VENDAS[2]] };
      const r2 = await ingestContaAzulBatch(BRAIN, "conta-azul", loteUpdate);
      expect(r2.paginasNovas).toBe(1); // body novo → página nova (idempotência por conteúdo)

      const sql2 = await rawConnect();
      try {
        // (3) timeline bitemporal: série venda-1001 tem o antigo com valid_to preenchido (NÃO
        // deletado) e o novo vigente; venda-1002 segue vigente e intocada
        const serie1001 = await sql2.unsafe(
          `select value_num, status, valid_to from galeed_facts
             where brain = $1 and predicate = 'venda' and tier = 'venda-1001'
             order by valid_to desc nulls last`,
          [BRAIN],
        );
        expect(serie1001.length).toBe(2); // antigo + novo coexistem (antigo não some)
        const vigente1001 = serie1001.find((f: any) => !f.valid_to || f.valid_to === "");
        const antigo1001 = serie1001.find((f: any) => f.valid_to && f.valid_to !== "");
        expect(vigente1001, "deve haver exatamente 1 vigente na série").toBeTruthy();
        expect(Number(vigente1001.value_num)).toBe(1500); // o update vence
        expect(antigo1001, "o fato antigo permanece como histórico").toBeTruthy();
        expect(Number(antigo1001.value_num)).toBe(1250);
        expect(String(antigo1001.valid_to)).not.toBe(""); // valid_to preenchido, não deletado

        const serie1002 = await sql2.unsafe(
          `select value_num, valid_to from galeed_facts
             where brain = $1 and predicate = 'venda' and tier = 'venda-1002'`,
          [BRAIN],
        );
        expect(serie1002.length).toBe(1);
        expect(serie1002[0].valid_to ?? "").toBe(""); // venda nova intocada, vigente
        expect(Number(serie1002[0].value_num)).toBe(9800);
      } finally {
        await sql2.end({ timeout: 5 });
      }

      // (4) re-sync = zero duplicata: repetir os dois lotes → tudo inalterado
      const pagesAntes = await countRows(BRAIN, "galeed_pages");
      const factsAntes = await countRows(BRAIN, "galeed_facts");
      const reInicial = await ingestContaAzulBatch(BRAIN, "conta-azul", loteInicial);
      const reUpdate = await ingestContaAzulBatch(BRAIN, "conta-azul", loteUpdate);
      expect(reInicial.paginasNovas).toBe(0);
      expect(reInicial.paginasInalteradas).toBe(2);
      expect(reUpdate.paginasNovas).toBe(0);
      expect(reUpdate.paginasInalteradas).toBe(1);
      expect(await countRows(BRAIN, "galeed_pages")).toBe(pagesAntes);
      expect(await countRows(BRAIN, "galeed_facts")).toBe(factsAntes);

      // (5) gate aplicado: parcela de entity vaga (descricao "Fornecedor") → fila entidade_vaga
      const loteParcela: ContaAzulBatch = { model: "contas_a_pagar", records: PAGAR };
      const r3 = await ingestContaAzulBatch(BRAIN, "conta-azul", loteParcela);
      expect(r3.claimsParaRevisao).toBeGreaterThanOrEqual(1);
      const sql3 = await rawConnect();
      try {
        const review = await sql3.unsafe(
          `select reason, status from galeed_ingest_review where brain = $1`,
          [BRAIN],
        );
        expect(review.length).toBeGreaterThanOrEqual(1);
        const vaga = review.find((r: any) => r.reason === "entidade_vaga");
        expect(vaga, "a parcela só-descrição vaga deve ir pra fila").toBeTruthy();
        expect(vaga.status).toBe("pendente");
        // o claim vago NÃO virou fato
        const fatoVago = await sql3.unsafe(
          `select count(*)::int as n from galeed_facts where brain = $1 and entity = 'fornecedor'`,
          [BRAIN],
        );
        expect(fatoVago[0].n).toBe(0);
      } finally {
        await sql3.end({ timeout: 5 });
      }

      // (6) ZERO LLM: o caminho determinístico não chama provider nenhum
      expect(await countRows(BRAIN, "galeed_llm_usage")).toBe(0);
    });
  });

  it("fail-closed: fonte pausada lança mensagem PT e não grava nada", async () => {
    await run([BRAIN_PAUSADA], async () => {
      const e = await getEngine(BRAIN_PAUSADA);
      await e.upsertSource({
        id: "conta-azul",
        name: "Conta Azul (ERP)",
        channel: "conta-azul",
        type: "erp",
        recipe: { fields: [{ dimension: "vendas", label: "venda realizada", area: "financeiro" }] },
        default_sensitivity: "restrito",
        status: "pausada",
        last_read_at: null,
      });
      const { pages } = normalizeContaAzulBatch({ model: "vendas", records: [VENDAS[0]] });
      await expect(ingestContaAzulPages(BRAIN_PAUSADA, "conta-azul", pages)).rejects.toThrow(
        /pausada/,
      );
      expect(await countRows(BRAIN_PAUSADA, "galeed_pages")).toBe(0);
      expect(await countRows(BRAIN_PAUSADA, "galeed_facts")).toBe(0);
    });
  });

  it("fail-closed: fonte inexistente lança mensagem PT (rode o seed)", async () => {
    await run([BRAIN], async () => {
      const { pages } = normalizeContaAzulBatch({ model: "vendas", records: [VENDAS[0]] });
      await expect(ingestContaAzulPages(BRAIN, "conta-azul", pages)).rejects.toThrow(/não existe/);
    });
  });
});
