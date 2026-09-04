/** INTEGRAÇÃO M-PAY-H/10 (DECISÃO DO FUNDADOR) — crédito PRÉ-PAGO (top-up) usável com a assinatura
 *  LAPSED. O gate de entitlement bloqueia o BOLO da assinatura, mas NÃO confisca o que o cliente
 *  comprou avulso. Bate no Postgres real (galeed_credit_wallet/ledger/subscriptions/account_brains).
 *  Cobre:
 *    (a) conta lapsed COM topup_remaining >= custo → ação PASSA e debita do TOPUP (onlyTopup).
 *    (b) conta lapsed com topup insuficiente → bloqueia (deny/entitlement).
 *    (c) conta lapsed gasta TODO o pré-pago e depois é bloqueada.
 *    (d) conta ENTITLED gasta monthly ANTES do topup (topup preservado).
 *    (e) grant de top-up incrementa topup_remaining; clawback decrementa.
 *  CONTA + BRAIN descartáveis (__mpayh10_). No-op sem DATABASE_URL (padrão ADR-014). */
import { describe, it, expect, afterAll } from "vitest";
import { hasDb } from "./helpers/db.ts";
import { getSharedSql, closeSharedSql } from "../../src/core/platform/db-conn.ts";
import {
  grantTrial,
  grantCredits,
  clawbackTopup,
  gateAndDebit,
  topupRemainingOfBrain,
  CREDIT_COST,
} from "../../src/core/platform/credits.ts";
import { assertEntitledByBrain } from "../../src/core/platform/entitlement.ts";

const ACCT = "__mpayh10_acct";
const BRAIN = "__mpayh10_brain";

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
  await sql`delete from galeed_credit_ledger where account_id = ${ACCT}`.catch(() => {});
  await sql`delete from galeed_credit_wallet where account_id = ${ACCT}`.catch(() => {});
  await sql`delete from galeed_spend_cap where account_id = ${ACCT}`.catch(() => {});
  await sql`delete from galeed_subscriptions where account_id = ${ACCT}`.catch(() => {});
  await sql`delete from galeed_account_brains where account_id = ${ACCT}`.catch(() => {});
  await sql`
    insert into galeed_account_brains (account_id, brain, role) values (${ACCT}, ${BRAIN}, 'owner')
    on conflict do nothing
  `;
}

/** Marca a assinatura como LAPSED (canceled = bloqueada pelo entitlement, fora de qualquer graça). */
async function setLapsed(sql: any): Promise<void> {
  await sql`
    insert into galeed_subscriptions (account_id, status, updated_at)
    values (${ACCT}, 'canceled', now())
    on conflict (account_id) do update set status = 'canceled', grace_until = null, updated_at = now()
  `;
  const e = await assertEntitledByBrain(BRAIN);
  expect(e.entitled).toBe(false); // sanidade: a conta está de fato lapsed
}

/** Mesmo gate topup-aware que as bordas pagas aplicam (web-server.entitlementGate / gateway). */
async function entitlementGate(brain: string, cost: number): Promise<{ deny?: boolean; onlyTopup?: boolean }> {
  const e = await assertEntitledByBrain(brain);
  if (e.entitled) return {};
  const prepaid = await topupRemainingOfBrain(brain);
  if (prepaid !== null && prepaid >= cost) return { onlyTopup: true };
  return { deny: true };
}

/** Simula a borda PAGA ponta-a-ponta: gate de entitlement (topup-aware) → débito (onlyTopup sob lapsed). */
async function pagedEdge(brain: string, cost: number, op: string, idem?: string) {
  const ent = await entitlementGate(brain, cost);
  if (ent.deny) return { denied: true as const };
  const credit = await gateAndDebit(brain, cost, op, idem, { onlyTopup: ent.onlyTopup });
  return { denied: false as const, credit };
}

async function wallet(sql: any): Promise<{ balance: number; trial: number; topup: number } | null> {
  const r = (await sql`select balance, trial_remaining, topup_remaining from galeed_credit_wallet where account_id = ${ACCT}`) as any[];
  if (!r[0]) return null;
  return { balance: Number(r[0].balance), trial: Number(r[0].trial_remaining), topup: Number(r[0].topup_remaining) };
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

describe("M-PAY-H/10 — pré-pago usável sob lapsed (DB)", () => {
  it("(e) grant de top-up incrementa topup_remaining; clawback decrementa", async () => {
    await runWithDb(async (sql) => {
      await sql.begin((tx: any) => grantCredits(tx, ACCT, 1000, "topup", "topup", "topup:e1", "e1"));
      let w = await wallet(sql);
      expect(w).not.toBeNull();
      expect(w!.balance).toBe(1000);
      expect(w!.topup).toBe(1000); // pré-pago = todo o saldo

      // auto-recarga também é pré-paga.
      await sql.begin((tx: any) => grantCredits(tx, ACCT, 500, "autorecharge", "autorecharge", "ar:e1", "e1b"));
      w = await wallet(sql);
      expect(w!.balance).toBe(1500);
      expect(w!.topup).toBe(1500);

      // clawback (estorno) baixa balance E topup_remaining.
      await sql.begin((tx: any) => clawbackTopup(tx, ACCT, 1000, "refund_e1", "pi_e1"));
      w = await wallet(sql);
      expect(w!.balance).toBe(500);
      expect(w!.topup).toBe(500);
    });
  });

  it("monthly/trial NÃO tocam topup_remaining", async () => {
    await runWithDb(async (sql) => {
      await grantTrial(ACCT); // bucket trial → topup_remaining fica 0
      await sql.begin((tx: any) => grantCredits(tx, ACCT, 5000, "monthly", "subscription_grant", "grant:m1", "m1"));
      const w = await wallet(sql);
      expect(w!.topup).toBe(0);
      expect(w!.balance).toBe(1000 + 5000);
      expect(w!.trial).toBe(1000);
    });
  });

  it("(d) conta ENTITLED gasta monthly ANTES do topup (pré-pago preservado)", async () => {
    await runWithDb(async (sql) => {
      // bolo mensal (5000) + top-up (1000); SEM trial. Assinatura ativa → entitled.
      await sql.begin((tx: any) => grantCredits(tx, ACCT, 5000, "monthly", "subscription_grant", "grant:d1", "d1"));
      await sql.begin((tx: any) => grantCredits(tx, ACCT, 1000, "topup", "topup", "topup:d1", "d1b"));
      await sql`
        insert into galeed_subscriptions (account_id, tier, status, updated_at)
        values (${ACCT}, 'pro', 'active', now())
        on conflict (account_id) do update set tier = 'pro', status = 'active', grace_until = null
      `;
      // um ask (6cr) entitled → sai do bolo, topup intacto.
      const r = await pagedEdge(BRAIN, CREDIT_COST.ask, "ask", "d-ask-1");
      expect(r.denied).toBe(false);
      const w = await wallet(sql);
      expect(w!.balance).toBe(6000 - CREDIT_COST.ask);
      expect(w!.topup).toBe(1000); // pré-pago PRESERVADO enquanto há bolo
    });
  });

  it("(a) conta LAPSED com topup >= custo → ação PASSA e debita do TOPUP", async () => {
    await runWithDb(async (sql) => {
      // bolo de 5000 (bloqueado por lapsed) + top-up de 1000 (gastável).
      await sql.begin((tx: any) => grantCredits(tx, ACCT, 5000, "monthly", "subscription_grant", "grant:a1", "a1"));
      await sql.begin((tx: any) => grantCredits(tx, ACCT, 1000, "topup", "topup", "topup:a1", "a1b"));
      await setLapsed(sql);

      const before = await wallet(sql);
      expect(before!.topup).toBe(1000);

      const r = await pagedEdge(BRAIN, CREDIT_COST.ingest, "ingest", "a-ing-1");
      expect(r.denied).toBe(false);
      expect(r.credit!.ok).toBe(true);

      const after = await wallet(sql);
      // o débito saiu SÓ do topup; o bolo (5000) intacto.
      expect(after!.topup).toBe(1000 - CREDIT_COST.ingest);
      expect(after!.balance).toBe(6000 - CREDIT_COST.ingest);
      // sanidade: o bolo (balance - topup) não foi tocado.
      expect(after!.balance - after!.topup).toBe(5000);
    });
  });

  it("(b) conta LAPSED com topup INSUFICIENTE → 402 entitlement (nada debitado)", async () => {
    await runWithDb(async (sql) => {
      // bolo de 5000 (bloqueado) + top-up de só 5cr (< ask=6 e < ingest=30).
      await sql.begin((tx: any) => grantCredits(tx, ACCT, 5000, "monthly", "subscription_grant", "grant:b1", "b1"));
      await sql.begin((tx: any) => grantCredits(tx, ACCT, 5, "topup", "topup", "topup:b1", "b1b"));
      await setLapsed(sql);

      const r = await pagedEdge(BRAIN, CREDIT_COST.ask, "ask", "b-ask-1");
      expect(r.denied).toBe(true); // bloqueado: o pré-pago (5) não cobre ask (6)

      const w = await wallet(sql);
      expect(w!.balance).toBe(5005); // nada debitado
      expect(w!.topup).toBe(5);
      // nenhuma linha de uso (a borda nem chamou o débito).
      const led = (await sql`select count(*)::int c from galeed_credit_ledger where account_id = ${ACCT} and bucket = 'usage'`) as any[];
      expect(led[0].c).toBe(0);
    });
  });

  it("(c) conta LAPSED gasta TODO o pré-pago e depois é bloqueada", async () => {
    await runWithDb(async (sql) => {
      // bolo de 5000 (bloqueado) + top-up de exatamente 2 asks (12cr).
      await sql.begin((tx: any) => grantCredits(tx, ACCT, 5000, "monthly", "subscription_grant", "grant:c1", "c1"));
      await sql.begin((tx: any) => grantCredits(tx, ACCT, CREDIT_COST.ask * 2, "topup", "topup", "topup:c1", "c1b"));
      await setLapsed(sql);

      const r1 = await pagedEdge(BRAIN, CREDIT_COST.ask, "ask", "c-ask-1");
      expect(r1.denied).toBe(false);
      const r2 = await pagedEdge(BRAIN, CREDIT_COST.ask, "ask", "c-ask-2");
      expect(r2.denied).toBe(false);

      let w = await wallet(sql);
      expect(w!.topup).toBe(0); // pré-pago esgotado
      expect(w!.balance).toBe(5000); // só o bolo bloqueado sobrou

      // 3º ask: o pré-pago acabou → bloqueado (o bolo está confiscado por lapsed).
      const r3 = await pagedEdge(BRAIN, CREDIT_COST.ask, "ask", "c-ask-3");
      expect(r3.denied).toBe(true);

      w = await wallet(sql);
      expect(w!.balance).toBe(5000); // o 3º não debitou
      expect(w!.topup).toBe(0);
    });
  });

  it("invariante: topup_remaining nunca negativo nem acima do balance após débitos", async () => {
    await runWithDb(async (sql) => {
      // só pré-pago, sem bolo; gasta tudo sob lapsed.
      await sql.begin((tx: any) => grantCredits(tx, ACCT, 12, "topup", "topup", "topup:i1", "i1"));
      await setLapsed(sql);
      await pagedEdge(BRAIN, CREDIT_COST.ask, "ask", "i-ask-1"); // -6
      const w = await wallet(sql);
      expect(w!.topup).toBe(6);
      expect(w!.balance).toBe(6);
      expect(w!.topup).toBeLessThanOrEqual(w!.balance);
      expect(w!.topup).toBeGreaterThanOrEqual(0);
    });
  });
});
