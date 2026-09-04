/** INTEGRAÇÃO M-PAY-H (auditoria R3 #6) — maybeAutoRecharge: o caminho que EFETIVAMENTE cobra o cartão
 *  off_session (paymentIntents.create confirm:true). Os testes puros só cobrem shouldAutoRecharge (a
 *  decisão). Aqui provamos o DISPARO contra Postgres real com getStripe().paymentIntents.create
 *  ESPIONADO (sem rede):
 *    1. a TRAVA EM VOO (autorecharge_pending_until) é gravada ANTES do create (defesa anti-cobrança-dupla);
 *    2. 2 chamadas na MESMA janela → 1 só PaymentIntent (idempotencyKey estável + trava barra a 2ª);
 *    3. requires_action → needs_action ligado e o 2º disparo barrado;
 *    4. StripeCardError authentication_required → needs_action + sem crédito.
 *  CONTA + customer descartáveis (__mpayh7ar_). No-op sem DB ou sem chaves do Stripe. */
import { describe, it, expect, afterAll, vi } from "vitest";
import { hasDb } from "./helpers/db.ts";
import { getSharedSql, closeSharedSql } from "../../src/core/platform/db-conn.ts";
import { maybeAutoRecharge } from "../../src/connectors/bff/bff-stripe.ts";
import { stripeEnabled, getStripe } from "../../src/core/platform/stripe.ts";
import { getBillingPrefs } from "../../src/core/platform/billing-prefs.ts";

const ACCT = "__mpayh7ar_acct";
const CUST = "cus___mpayh7ar";
const PM = "pm___mpayh7ar";
const PKG = "cr2500"; // 2500cr → threshold 500 > balance => dispara

function ready(): boolean {
  return hasDb() && stripeEnabled();
}

let dbOk: Promise<boolean> | null = null;
async function dbAvailable(): Promise<boolean> {
  if (!ready()) return false;
  dbOk ??= (async () => {
    try {
      const sql = await getSharedSql();
      await Promise.race([sql`select 1`, new Promise((_, r) => setTimeout(() => r(new Error("timeout")), 7000))]);
      return true;
    } catch {
      return false;
    }
  })();
  return dbOk;
}

async function reset(sql: any): Promise<void> {
  await sql`delete from galeed_billing_prefs where account_id = ${ACCT}`.catch(() => {});
  await sql`delete from galeed_billing_customers where account_id = ${ACCT}`.catch(() => {});
}

/** Conta com auto-recarga ligada, método salvo, customer vinculado e SEM trava em voo. */
async function setupEnabled(sql: any): Promise<void> {
  await reset(sql);
  await sql`
    insert into galeed_billing_customers (account_id, stripe_customer_id) values (${ACCT}, ${CUST})
    on conflict (account_id) do update set stripe_customer_id = ${CUST}
  `;
  await sql`
    insert into galeed_billing_prefs
      (account_id, autorecharge_enabled, autorecharge_threshold_credits, autorecharge_package, default_payment_method, needs_action, autorecharge_pending_until, updated_at)
    values (${ACCT}, true, 500, ${PKG}, ${PM}, false, ${null}, now())
    on conflict (account_id) do update set
      autorecharge_enabled=true, autorecharge_threshold_credits=500, autorecharge_package=${PKG},
      default_payment_method=${PM}, needs_action=false, autorecharge_pending_until=null, updated_at=now()
  `;
}

async function withDb(fn: (sql: any) => Promise<void>): Promise<void> {
  if (!ready()) return;
  const ok = await dbAvailable();
  expect(ok, "infra de auto-recarga indisponível").toBe(true);
  if (!ok) return;
  const sql = await getSharedSql();
  try {
    await fn(sql);
  } finally {
    await reset(sql);
    vi.restoreAllMocks();
  }
}

afterAll(async () => {
  if (await dbAvailable()) await reset(await getSharedSql());
  await closeSharedSql();
});

describe("M-PAY-H — maybeAutoRecharge (disparo off_session) [auditoria R3 #6]", () => {
  it("(1) grava a TRAVA EM VOO ANTES do paymentIntents.create (ordem)", async () => {
    await withDb(async (sql) => {
      await setupEnabled(sql);
      let pendingAtCreate: any = null;
      const spy = vi.spyOn(getStripe().paymentIntents, "create").mockImplementation(async () => {
        // no momento do create, a trava JÁ deve estar gravada (defesa anti-cobrança-dupla).
        const r = (await sql`select autorecharge_pending_until from galeed_billing_prefs where account_id = ${ACCT}`) as any[];
        pendingAtCreate = r[0]?.autorecharge_pending_until ?? null;
        return { id: "pi_ar1", status: "succeeded" } as any;
      });
      await maybeAutoRecharge(ACCT, 100); // saldo 100 < threshold 500
      expect(spy).toHaveBeenCalledTimes(1);
      expect(pendingAtCreate).not.toBeNull(); // trava gravada ANTES do create
    });
  });

  it("(2) 2 disparos na mesma janela → 1 só PaymentIntent (trava barra o 2º)", async () => {
    await withDb(async (sql) => {
      await setupEnabled(sql);
      const spy = vi.spyOn(getStripe().paymentIntents, "create").mockResolvedValue({ id: "pi_ar2", status: "succeeded" } as any);
      await maybeAutoRecharge(ACCT, 100);
      await maybeAutoRecharge(ACCT, 80); // outro débito antes do webhook creditar
      expect(spy).toHaveBeenCalledTimes(1); // a trava em voo barra o 2º disparo
      // idempotencyKey estável por janela (defesa extra mesmo se a trava falhasse).
      const opts = spy.mock.calls[0][1] as any;
      expect(typeof opts?.idempotencyKey).toBe("string");
      expect(opts.idempotencyKey).toContain(ACCT);
    });
  });

  it("(3) requires_action → liga needs_action e o 2º disparo é barrado", async () => {
    await withDb(async (sql) => {
      await setupEnabled(sql);
      const spy = vi.spyOn(getStripe().paymentIntents, "create").mockResolvedValue({ id: "pi_ar3", status: "requires_action" } as any);
      await maybeAutoRecharge(ACCT, 100);
      expect(spy).toHaveBeenCalledTimes(1);
      const p = await getBillingPrefs(ACCT);
      expect(p.needsAction).toBe(true);
      // segundo disparo: needs_action barra (não reentra em loop).
      await maybeAutoRecharge(ACCT, 90);
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  it("(4) StripeCardError authentication_required → needs_action, sem crédito", async () => {
    await withDb(async (sql) => {
      await setupEnabled(sql);
      const err: any = new Error("authentication required");
      err.code = "authentication_required";
      const spy = vi.spyOn(getStripe().paymentIntents, "create").mockRejectedValue(err);
      await maybeAutoRecharge(ACCT, 100); // não lança (fail-soft)
      expect(spy).toHaveBeenCalledTimes(1);
      const p = await getBillingPrefs(ACCT);
      expect(p.needsAction).toBe(true);
      // nenhuma carteira/crédito criado (o crédito só viria por webhook payment_intent.succeeded).
      const w = (await sql`select count(*)::int c from galeed_credit_wallet where account_id = ${ACCT}`) as any[];
      expect(w[0].c).toBe(0);
    });
  });

  it("não dispara quando shouldAutoRecharge=false (saldo acima do limiar)", async () => {
    await withDb(async (sql) => {
      await setupEnabled(sql);
      const spy = vi.spyOn(getStripe().paymentIntents, "create");
      await maybeAutoRecharge(ACCT, 999); // 999 >= 500 → não dispara
      expect(spy).not.toHaveBeenCalled();
    });
  });
});
