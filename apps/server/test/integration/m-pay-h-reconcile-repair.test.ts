/** INTEGRAÇÃO M-PAY-H (auditoria R2) — RECONCILE --repair contra Postgres real. O reconcileWalletRow
 *  PURO já é testado em unit; aqui cobrimos o caminho de WRITE do `reconcileCredits({repair:true})`, que
 *  o achado #2 mostrou ser um no-op que COMPOUNDAVA o drift (postava um ajuste no razão E mexia no
 *  balance, cancelando-se → mesma divergência reaberta, pior a cada dia). O reparo correto CASA a
 *  carteira ao razão (fonte da verdade append-only): balance = sum(ledger.delta), SEM postar entrada.
 *  Prova: drift sintético → após repair, sum(ledger)==balance E re-rodar é no-op (idempotente).
 *  No-op sem DATABASE_URL (padrão ADR-014). */
import { describe, it, expect, afterAll } from "vitest";
import { hasDb } from "./helpers/db.ts";
import { getSharedSql, closeSharedSql } from "../../src/core/platform/db-conn.ts";
import { reconcileCredits } from "../../src/core/platform/credits.ts";

const ACCT = "__mpayh_recpair_acct";

let dbOk: Promise<boolean> | null = null;
async function dbAvailable(): Promise<boolean> {
  if (!hasDb()) return false;
  dbOk ??= (async () => {
    try {
      const sql = await getSharedSql();
      await Promise.race([
        sql`select 1`,
        new Promise((_, reject) => setTimeout(() => reject(new Error("db ping timeout")), 7000)),
      ]);
      return true;
    } catch {
      return false;
    }
  })();
  return dbOk;
}

async function reset(sql: any): Promise<void> {
  await sql`delete from galeed_credit_ledger where account_id = ${ACCT}`;
  await sql`delete from galeed_credit_wallet where account_id = ${ACCT}`;
}

async function runWithDb(fn: (sql: any) => Promise<void>): Promise<void> {
  if (!hasDb()) return;
  const ok = await dbAvailable();
  expect(ok, "DATABASE_URL definido mas o Postgres de integração não respondeu.").toBe(true);
  if (!ok) return;
  const sql = await getSharedSql();
  await reset(sql);
  try {
    await fn(sql);
  } finally {
    await reset(sql);
  }
}

afterAll(async () => {
  if (await dbAvailable()) {
    const sql = await getSharedSql();
    await reset(sql);
  }
  await closeSharedSql();
});

async function ledgerSum(sql: any): Promise<number> {
  const r = (await sql`select coalesce(sum(delta),0)::bigint s from galeed_credit_ledger where account_id = ${ACCT}`) as any[];
  return Number(r[0].s);
}
async function walletBalance(sql: any): Promise<number> {
  const r = (await sql`select balance::bigint b from galeed_credit_wallet where account_id = ${ACCT}`) as any[];
  return Number(r[0].b);
}

describe("M-PAY-H — reconcileCredits({repair:true}) (DB)", () => {
  it("drift sintético: após repair, sum(ledger)==balance E não posta entrada no razão", async () => {
    await runWithDb(async (sql) => {
      // razão soma 480 (verdade); carteira diz 500 (drift de +20 — saldo a mais que o razão).
      await sql`insert into galeed_credit_ledger (account_id, delta, bucket, reason, idempotency_key) values (${ACCT}, 1000, 'trial', 'trial', 'l1')`;
      await sql`insert into galeed_credit_ledger (account_id, delta, bucket, reason, idempotency_key) values (${ACCT}, -520, 'usage', 'usage_ask', 'l2')`;
      await sql`insert into galeed_credit_wallet (account_id, balance, trial_remaining) values (${ACCT}, 500, 480)`;

      expect(await ledgerSum(sql)).toBe(480);
      expect(await walletBalance(sql)).toBe(500);

      const rep = await reconcileCredits({ repair: true });
      expect(rep.repaired).toBeGreaterThanOrEqual(1);

      // INVARIANTE restaurada: carteira casa com o razão (fonte da verdade).
      expect(await walletBalance(sql)).toBe(480);
      expect(await ledgerSum(sql)).toBe(480); // razão NÃO foi tocado (sem entrada 'reconcile')
      const recon = (await sql`select count(*)::int c from galeed_credit_ledger where account_id = ${ACCT} and bucket = 'reconcile'`) as any[];
      expect(recon[0].c).toBe(0);
      // trial_remaining clampado p/ caber no novo saldo (<= balance).
      const w = (await sql`select trial_remaining::bigint t from galeed_credit_wallet where account_id = ${ACCT}`) as any[];
      expect(Number(w[0].t)).toBeLessThanOrEqual(480);
    });
  });

  it("re-rodar o repair é NO-OP (não compounda): 2ª passada não acha mais drift", async () => {
    await runWithDb(async (sql) => {
      await sql`insert into galeed_credit_ledger (account_id, delta, bucket, reason, idempotency_key) values (${ACCT}, 1000, 'trial', 'trial', 'k1')`;
      await sql`insert into galeed_credit_wallet (account_id, balance, trial_remaining) values (${ACCT}, 1234, 0)`; // drift grande

      await reconcileCredits({ repair: true });
      expect(await walletBalance(sql)).toBe(1000);
      expect(await ledgerSum(sql)).toBe(1000);

      // 2ª passada: a carteira já bate com o razão → nada a reparar p/ esta conta.
      const rep2 = await reconcileCredits({ repair: true });
      const stillDrifted = rep2.drifted.some((d) => d.accountId === ACCT);
      expect(stillDrifted).toBe(false);
      expect(await walletBalance(sql)).toBe(1000);
      expect(await ledgerSum(sql)).toBe(1000);
    });
  });
});
