/** INTEGRAÇÃO M-PAY-H (Onda 3) — Entitlement + dunning. Bate no Postgres real (galeed_subscriptions):
 *  accountEntitlement reflete cada estado da assinatura; a graça é aberta em past_due (e só 1×/ciclo) e
 *  limpa ao voltar a active. Conta SEM assinatura nunca bloqueia. CONTA de teste descartável (__mpayh3_).
 *  No-op sem DATABASE_URL/GALEED_DB_URL/SUPABASE_DB_URL (padrão ADR-014). */
import { describe, it, expect, afterAll } from "vitest";
import { hasDb } from "./helpers/db.ts";
import { getSharedSql, closeSharedSql } from "../../src/core/platform/db-conn.ts";
import { accountEntitlement } from "../../src/core/platform/entitlement.ts";

const ACCT = "__mpayh3_acct";

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

async function ensureSchema(sql: any): Promise<void> {
  // garante a tabela + a coluna grace_until (migration 47) p/ o caminho lazy (sem runner).
  await sql.unsafe(`
    create table if not exists galeed_subscriptions (
      account_id             text primary key,
      stripe_customer_id     text,
      stripe_subscription_id text unique,
      tier                   text,
      cohort                 text default 'standard',
      status                 text,
      current_period_end     timestamptz,
      cancel_at_period_end   boolean default false,
      last_event_at          timestamptz,
      updated_at             timestamptz not null default now()
    );
    alter table galeed_subscriptions add column if not exists grace_until timestamptz;
  `);
}

async function reset(sql: any): Promise<void> {
  await sql`delete from galeed_subscriptions where account_id = ${ACCT}`.catch(() => {});
}

/** Upsert do estado da assinatura como o webhook projeta (status + grace_until). */
async function setSub(sql: any, status: string, graceUntil: Date | null): Promise<void> {
  await sql`
    insert into galeed_subscriptions (account_id, status, grace_until, last_event_at, updated_at)
    values (${ACCT}, ${status}, ${graceUntil}, now(), now())
    on conflict (account_id) do update set status = ${status}, grace_until = ${graceUntil}, updated_at = now()
  `;
}

/** A regra do webhook invoice.payment_failed: abre graça de 7d SÓ se ainda nula (1ª falha do ciclo). */
async function applyPaymentFailed(sql: any): Promise<boolean> {
  const upd = (await sql`
    update galeed_subscriptions set grace_until = now() + interval '7 days', updated_at = now()
     where account_id = ${ACCT} and grace_until is null
     returning grace_until
  `) as any[];
  return upd.length > 0;
}

async function runWithDb(fn: (sql: any) => Promise<void>): Promise<void> {
  if (!hasDb()) return;
  const ok = await dbAvailable();
  expect(ok, "DATABASE_URL definido mas o Postgres de integração não respondeu.").toBe(true);
  if (!ok) return;
  const sql = await getSharedSql();
  await ensureSchema(sql);
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

describe("M-PAY-H Onda 3 — entitlement (DB)", () => {
  it("conta SEM assinatura → entitled, reason none", async () => {
    await runWithDb(async () => {
      const e = await accountEntitlement(ACCT);
      expect(e.entitled).toBe(true);
      expect(e.reason).toBe("none");
    });
  });

  it("active → entitled; past_due+graça → grace; graça vencida → lapsed", async () => {
    await runWithDb(async (sql) => {
      await setSub(sql, "active", null);
      expect((await accountEntitlement(ACCT)).reason).toBe("active");

      // invoice.payment_failed: 1ª falha abre graça (entitled = grace).
      await setSub(sql, "past_due", null);
      const opened = await applyPaymentFailed(sql);
      expect(opened).toBe(true);
      let e = await accountEntitlement(ACCT);
      expect(e.entitled).toBe(true);
      expect(e.reason).toBe("grace");
      expect(e.graceUntil).not.toBeNull();

      // retry do mesmo evento NÃO estende a graça (já vigente).
      const reopened = await applyPaymentFailed(sql);
      expect(reopened).toBe(false);

      // graça vencida → lapsed (bloqueia).
      await sql`update galeed_subscriptions set grace_until = now() - interval '1 day' where account_id = ${ACCT}`;
      e = await accountEntitlement(ACCT);
      expect(e.entitled).toBe(false);
      expect(e.reason).toBe("lapsed");
    });
  });

  it("voltar a active limpa a graça (entitled de novo)", async () => {
    await runWithDb(async (sql) => {
      await setSub(sql, "past_due", new Date(Date.now() + 7 * 86400_000));
      expect((await accountEntitlement(ACCT)).reason).toBe("grace");
      // customer.subscription.updated → active limpa grace_until.
      await setSub(sql, "active", null);
      const e = await accountEntitlement(ACCT);
      expect(e.entitled).toBe(true);
      expect(e.reason).toBe("active");
      expect(e.graceUntil).toBeNull();
    });
  });

  it("canceled bloqueia mesmo com graça residual (entitlement é independente do crédito)", async () => {
    await runWithDb(async (sql) => {
      await setSub(sql, "canceled", new Date(Date.now() + 7 * 86400_000));
      const e = await accountEntitlement(ACCT);
      expect(e.entitled).toBe(false);
      expect(e.reason).toBe("lapsed");
    });
  });
});
