/** INTEGRAÇÃO M-PAY-H (Onda 2) — Trial de boas-vindas: concessão idempotente, débito trial-first,
 *  expiração lazy → read-only. Bate no Postgres real (galeed_credit_wallet / galeed_credit_ledger /
 *  galeed_account_brains), usando uma CONTA + BRAIN de teste descartáveis (prefixo __mpayh_).
 *  No-op sem DATABASE_URL/GALEED_DB_URL/SUPABASE_DB_URL (padrão ADR-014). */
import { describe, it, expect, afterAll } from "vitest";
import { hasDb } from "./helpers/db.ts";
import { getSharedSql, closeSharedSql } from "../../src/core/platform/db-conn.ts";
import {
  grantTrial,
  gateAndDebit,
  expireTrialIfNeeded,
  listLedger,
  getSpendCap,
  TRIAL_GRANT,
  CREDIT_COST,
} from "../../src/core/platform/credits.ts";

const ACCT = "__mpayh_acct";
const BRAIN = "__mpayh_brain";

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

/** Zera a conta/brain de teste (todas as tabelas de crédito) e garante o vínculo de owner. */
async function reset(sql: any): Promise<void> {
  await sql`delete from galeed_credit_ledger where account_id = ${ACCT}`;
  await sql`delete from galeed_credit_wallet where account_id = ${ACCT}`;
  await sql`delete from galeed_spend_cap where account_id = ${ACCT}`.catch(() => {});
  await sql`delete from galeed_account_brains where account_id = ${ACCT}`.catch(() => {});
  await sql`delete from galeed_subscriptions where account_id = ${ACCT}`.catch(() => {});
  await sql`
    insert into galeed_account_brains (account_id, brain, role) values (${ACCT}, ${BRAIN}, 'owner')
    on conflict do nothing
  `;
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

describe("M-PAY-H Onda 2 — trial", () => {
  it("concede o trial (carteira nova com trial_remaining=TRIAL_GRANT) e é idempotente", async () => {
    await runWithDb(async (sql) => {
      await grantTrial(ACCT);
      let w = (await sql`select balance, trial_remaining from galeed_credit_wallet where account_id = ${ACCT}`) as any[];
      expect(Number(w[0].balance)).toBe(TRIAL_GRANT);
      expect(Number(w[0].trial_remaining)).toBe(TRIAL_GRANT);
      const led = (await sql`select count(*)::int c from galeed_credit_ledger where account_id = ${ACCT} and bucket = 'trial'`) as any[];
      expect(led[0].c).toBe(1);

      // 2ª concessão (retry / 2º signup): NÃO credita de novo.
      await grantTrial(ACCT);
      w = (await sql`select balance, trial_remaining from galeed_credit_wallet where account_id = ${ACCT}`) as any[];
      expect(Number(w[0].balance)).toBe(TRIAL_GRANT);
      expect(Number(w[0].trial_remaining)).toBe(TRIAL_GRANT);
      const led2 = (await sql`select count(*)::int c from galeed_credit_ledger where account_id = ${ACCT} and bucket = 'trial'`) as any[];
      expect(led2[0].c).toBe(1);
    });
  });

  it("gasto debita trial-first: balance e trial_remaining caem juntos", async () => {
    await runWithDb(async (sql) => {
      await grantTrial(ACCT);
      const r = await gateAndDebit(BRAIN, CREDIT_COST.ask, "ask");
      expect(r.ok).toBe(true);
      expect(r.balance).toBe(TRIAL_GRANT - CREDIT_COST.ask);
      const w = (await sql`select balance, trial_remaining from galeed_credit_wallet where account_id = ${ACCT}`) as any[];
      expect(Number(w[0].balance)).toBe(TRIAL_GRANT - CREDIT_COST.ask);
      expect(Number(w[0].trial_remaining)).toBe(TRIAL_GRANT - CREDIT_COST.ask);
    });
  });

  it("débito idempotente (mesma idemKey) não re-debita nem o trial", async () => {
    await runWithDb(async (sql) => {
      await grantTrial(ACCT);
      const a = await gateAndDebit(BRAIN, CREDIT_COST.ask, "ask", "turn-1");
      const b = await gateAndDebit(BRAIN, CREDIT_COST.ask, "ask", "turn-1");
      expect(a.balance).toBe(TRIAL_GRANT - CREDIT_COST.ask);
      expect(b.balance).toBe(TRIAL_GRANT - CREDIT_COST.ask); // mesmo saldo
      const w = (await sql`select trial_remaining from galeed_credit_wallet where account_id = ${ACCT}`) as any[];
      expect(Number(w[0].trial_remaining)).toBe(TRIAL_GRANT - CREDIT_COST.ask);
    });
  });

  it("expiração lazy: trial vencido zera trial_remaining e o saldo → read-only", async () => {
    await runWithDb(async (sql) => {
      await grantTrial(ACCT);
      // gasta um pouco, depois força a expiração no passado.
      await gateAndDebit(BRAIN, CREDIT_COST.ask, "ask");
      await sql`update galeed_credit_wallet set trial_expires_at = now() - interval '1 day' where account_id = ${ACCT}`;

      await expireTrialIfNeeded(ACCT);
      const w = (await sql`select balance, trial_remaining from galeed_credit_wallet where account_id = ${ACCT}`) as any[];
      expect(Number(w[0].balance)).toBe(0);
      expect(Number(w[0].trial_remaining)).toBe(0);
      // posta exatamente um débito de expiração.
      const exp = (await sql`select count(*)::int c, coalesce(sum(delta),0)::int s from galeed_credit_ledger where account_id = ${ACCT} and bucket = 'trial_expire'`) as any[];
      expect(exp[0].c).toBe(1);
      expect(exp[0].s).toBe(-(TRIAL_GRANT - CREDIT_COST.ask));

      // idempotente: rodar de novo não posta segundo débito.
      await expireTrialIfNeeded(ACCT);
      const exp2 = (await sql`select count(*)::int c from galeed_credit_ledger where account_id = ${ACCT} and bucket = 'trial_expire'`) as any[];
      expect(exp2[0].c).toBe(1);

      // read-only exposto na leitura (saldo 0 + sem assinatura).
      const cap = await getSpendCap(ACCT);
      expect(cap.readOnly).toBe(true);
      const led = await listLedger(ACCT);
      expect(led.summary.readOnly).toBe(true);
      expect(led.summary.balance).toBe(0);
    });
  });

  it("gate nega (402) após expiração: ações pagas bloqueiam em read-only", async () => {
    await runWithDb(async (sql) => {
      await grantTrial(ACCT);
      await sql`update galeed_credit_wallet set trial_expires_at = now() - interval '1 day' where account_id = ${ACCT}`;
      const r = await gateAndDebit(BRAIN, CREDIT_COST.ask, "ask");
      expect(r.ok).toBe(false);
      expect(r.balance).toBe(0);
    });
  });

  it("expiração lazy é disparada pelo próprio gateAndDebit (sem chamada explícita)", async () => {
    await runWithDb(async (sql) => {
      await grantTrial(ACCT);
      await sql`update galeed_credit_wallet set trial_expires_at = now() - interval '1 day' where account_id = ${ACCT}`;
      await gateAndDebit(BRAIN, CREDIT_COST.ask, "ask"); // dispara o expirar lazy no topo
      const exp = (await sql`select count(*)::int c from galeed_credit_ledger where account_id = ${ACCT} and bucket = 'trial_expire'`) as any[];
      expect(exp[0].c).toBe(1);
    });
  });
});
