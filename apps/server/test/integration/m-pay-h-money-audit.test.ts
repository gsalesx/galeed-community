/** INTEGRAÇÃO M-PAY-H/N (auditoria — testes de DINHEIRO) contra Postgres real. Cobre os 3 caminhos que
 *  a triagem marcou como mais frágeis no caminho do dinheiro:
 *    (a) débito CONCORRENTE — 2 gateAndDebit simultâneos NUNCA passam do saldo (jamais negativo); o
 *        `update ... where balance >= cost` + check(balance>=0) serializam a corrida.
 *    (b) reembolso PARCIAL — charge.refunded com amount_refunded < amount estorna SÓ o delta (não o
 *        cumulativo), ponta-a-ponta pelo webhook real (PI retrieve espionado, sem rede).
 *    (c) overage NO-OP — re-disparo de invoice.upcoming com o InvoiceItem do ciclo JÁ existente não
 *        duplica (idempotência por marker de ciclo; list espionada devolvendo o item já lançado).
 *  CONTA + customer descartáveis (__mpayhN_). (a) só precisa de DB; (b)/(c) precisam de DB + chaves do
 *  Stripe (padrão ADR-014 — no-op silencioso quando a infra não está presente). */
import { describe, it, expect, afterAll, vi } from "vitest";
import { hasDb } from "./helpers/db.ts";
import { getSharedSql, closeSharedSql } from "../../src/core/platform/db-conn.ts";
import { stripeWebhookHandler } from "../../src/connectors/bff/bff-stripe.ts";
import { stripeEnabled, getStripe, tierDef } from "../../src/core/platform/stripe.ts";
import { gateAndDebit, grantTrial, grantCredits, CREDIT_COST } from "../../src/core/platform/credits.ts";

const ACCT = "__mpayhN_acct";
const BRAIN = "__mpayhN_brain";
const CUST = "cus___mpayhN";

function webhookReady(): boolean {
  return hasDb() && stripeEnabled() && !!process.env.STRIPE_WEBHOOK_SECRET;
}

let dbOk: Promise<boolean> | null = null;
async function dbAvailable(): Promise<boolean> {
  if (!hasDb()) return false;
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
  await sql`delete from galeed_credit_ledger where account_id = ${ACCT}`.catch(() => {});
  await sql`delete from galeed_credit_wallet where account_id = ${ACCT}`.catch(() => {});
  await sql`delete from galeed_spend_cap where account_id = ${ACCT}`.catch(() => {});
  await sql`delete from galeed_subscriptions where account_id = ${ACCT}`.catch(() => {});
  await sql`delete from galeed_billing_prefs where account_id = ${ACCT}`.catch(() => {});
  await sql`delete from galeed_stripe_events where event_id like '%__mpayhN%'`.catch(() => {});
  await sql`delete from galeed_billing_customers where account_id = ${ACCT}`.catch(() => {});
  await sql`delete from galeed_account_brains where account_id = ${ACCT}`.catch(() => {});
  await sql`
    insert into galeed_account_brains (account_id, brain, role) values (${ACCT}, ${BRAIN}, 'owner')
    on conflict do nothing
  `;
}

async function linkCustomer(sql: any): Promise<void> {
  await sql`
    insert into galeed_billing_customers (account_id, stripe_customer_id) values (${ACCT}, ${CUST})
    on conflict (account_id) do update set stripe_customer_id = ${CUST}
  `;
}

async function deliver(event: any): Promise<{ status: number; body: any }> {
  const raw = JSON.stringify(event);
  const header = getStripe().webhooks.generateTestHeaderString({ payload: raw, secret: process.env.STRIPE_WEBHOOK_SECRET! });
  return (await stripeWebhookHandler(raw, { "stripe-signature": header })) as any;
}

function evt(id: string, type: string, object: any): any {
  return { id, type, created: Math.floor(Date.now() / 1000), data: { object } };
}

/** (a) só precisa de DB. */
async function withDb(fn: (sql: any) => Promise<void>): Promise<void> {
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

/** (b)/(c) precisam de DB + Stripe (webhook assinado). */
async function withWebhook(fn: (sql: any) => Promise<void>): Promise<void> {
  if (!webhookReady()) return;
  const ok = await dbAvailable();
  expect(ok, "infra de webhook indisponível").toBe(true);
  if (!ok) return;
  const sql = await getSharedSql();
  await reset(sql);
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

describe("M-PAY-H/N (auditoria) — débito CONCORRENTE nunca passa do saldo", () => {
  it("2 gateAndDebit simultâneos com saldo p/ UM só: 1 passa, 1 nega, saldo nunca negativo", async () => {
    await withDb(async (sql) => {
      await grantTrial(ACCT);
      // deixa o saldo EXATO p/ um único ask (6cr): dois concorrentes disputam o mesmo saldo.
      await sql`update galeed_credit_wallet set balance = ${CREDIT_COST.ask}, trial_remaining = 0 where account_id = ${ACCT}`;
      // chaves de idempotência DISTINTAS (turnos diferentes) → os dois TENTAM debitar de verdade.
      const [r1, r2] = await Promise.all([
        gateAndDebit(BRAIN, CREDIT_COST.ask, "ask", "conc-A"),
        gateAndDebit(BRAIN, CREDIT_COST.ask, "ask", "conc-B"),
      ]);
      const oks = [r1, r2].filter((r) => r.ok).length;
      expect(oks).toBe(1); // EXATAMENTE um passou (o outro = saldo insuficiente)
      const w = (await sql`select balance from galeed_credit_wallet where account_id = ${ACCT}`) as any[];
      expect(Number(w[0].balance)).toBe(0); // nunca negativo
      // só UMA linha de uso foi gravada (a claim do que falhou sofreu rollback).
      const led = (await sql`select count(*)::int c from galeed_credit_ledger where account_id = ${ACCT} and bucket = 'usage'`) as any[];
      expect(led[0].c).toBe(1);
    });
  });

  it("N=5 concorrentes com saldo p/ 3: exatamente 3 passam, saldo final = 0", async () => {
    await withDb(async (sql) => {
      await grantTrial(ACCT);
      await sql`update galeed_credit_wallet set balance = ${CREDIT_COST.ask * 3}, trial_remaining = 0 where account_id = ${ACCT}`;
      const results = await Promise.all(
        Array.from({ length: 5 }, (_, i) => gateAndDebit(BRAIN, CREDIT_COST.ask, "ask", `multi-${i}`)),
      );
      expect(results.filter((r) => r.ok).length).toBe(3);
      const w = (await sql`select balance from galeed_credit_wallet where account_id = ${ACCT}`) as any[];
      expect(Number(w[0].balance)).toBe(0);
    });
  });
});

describe("M-PAY-H/N (auditoria) — reembolso PARCIAL estorna só o delta", () => {
  it("charge.refunded com amount_refunded < amount → estorna só a parte reembolsada (não o cumulativo)", async () => {
    await withWebhook(async (sql) => {
      await linkCustomer(sql);
      // top-up de 2500cr pago (R$5000 centavos = 2500 × 2).
      await sql.begin((tx: any) => grantCredits(tx, ACCT, 2500, "topup", "topup", "topup:seed__mpayhN", "seed"));
      vi.spyOn(getStripe().paymentIntents, "retrieve").mockResolvedValue({
        id: "pi_part", metadata: { kind: "topup", account_id: ACCT, credits: "2500" },
      } as any);
      // reembolso PARCIAL de 40%: amount=5000c, amount_refunded=2000c → 40% de 2500cr = 1000cr.
      const charge = { id: "ch_part", payment_intent: "pi_part", amount: 5000, amount_refunded: 2000 };
      await deliver(evt("evt___mpayhN_refpart", "charge.refunded", charge));
      const w = (await sql`select balance from galeed_credit_wallet where account_id = ${ACCT}`) as any[];
      expect(Number(w[0].balance)).toBe(1500); // 2500 - 1000 (só o delta), NÃO 0
      const ref = (await sql`select coalesce(sum(-delta),0)::int s from galeed_credit_ledger where account_id = ${ACCT} and bucket='topup_refund'`) as any[];
      expect(ref[0].s).toBe(1000); // estornou exatamente o reembolsado
    });
  });

  it("2º reembolso parcial cumulativo (40%→70%) cobra só o INCREMENTO (30%=750cr), nunca re-conta", async () => {
    await withWebhook(async (sql) => {
      await linkCustomer(sql);
      await sql.begin((tx: any) => grantCredits(tx, ACCT, 2500, "topup", "topup", "topup:seed2__mpayhN", "seed2"));
      vi.spyOn(getStripe().paymentIntents, "retrieve").mockResolvedValue({
        id: "pi_cum", metadata: { kind: "topup", account_id: ACCT, credits: "2500" },
      } as any);
      // 1º: 40% cumulativo → 1000cr.
      await deliver(evt("evt___mpayhN_cum1", "charge.refunded", { id: "ch_c1", payment_intent: "pi_cum", amount: 5000, amount_refunded: 2000 }));
      // 2º: 70% cumulativo (amount_refunded=3500c) → cumulativo 1750cr; delta = 750cr.
      await deliver(evt("evt___mpayhN_cum2", "charge.refunded", { id: "ch_c2", payment_intent: "pi_cum", amount: 5000, amount_refunded: 3500 }));
      const w = (await sql`select balance from galeed_credit_wallet where account_id = ${ACCT}`) as any[];
      expect(Number(w[0].balance)).toBe(750); // 2500 - 1750 cumulativo, NÃO 2500-(1000+1750)
      const ref = (await sql`select coalesce(sum(-delta),0)::int s from galeed_credit_ledger where account_id = ${ACCT} and bucket='topup_refund'`) as any[];
      expect(ref[0].s).toBe(1750); // soma dos deltas = cumulativo correto
    });
  });
});

describe("M-PAY-H/N (auditoria) — overage re-disparo NO-OP (não duplica)", () => {
  it("invoice.upcoming pro re-disparado com InvoiceItem do ciclo JÁ existente → não cria 2º item", async () => {
    await withWebhook(async (sql) => {
      await linkCustomer(sql);
      await sql`insert into galeed_subscriptions (account_id, stripe_subscription_id, tier, status, updated_at)
        values (${ACCT}, 'sub___mpayhN', 'pro', 'active', now())
        on conflict (account_id) do update set tier='pro', status='active', stripe_subscription_id='sub___mpayhN'`;
      const over = tierDef("pro")!.credits + 1000; // 1000cr de excedente no ciclo
      await sql`insert into galeed_credit_ledger (account_id, delta, bucket, reason, op, idempotency_key)
        values (${ACCT}, ${-over}, 'usage', 'usage_ask', 'ask', 'over-noop-__mpayhN')`;
      // o marker é estável por (subscription_id, início-do-ciclo-consumido). Sem period na invoice →
      // fallback mês-calendário: marker = `${subId}:cal-YYYY-MM`. Simulamos o item JÁ lançado devolvendo-o
      // no list (como o Stripe faria numa 2ª entrega do mesmo ciclo).
      const month = new Date().toISOString().slice(0, 7);
      const existingMarker = `sub___mpayhN:cal-${month}`;
      const listSpy = vi
        .spyOn(getStripe().invoiceItems, "list")
        .mockResolvedValue({ data: [{ id: "ii_existing", metadata: { overage_for: existingMarker } }] } as any);
      const createSpy = vi.spyOn(getStripe().invoiceItems, "create").mockResolvedValue({ id: "ii_new" } as any);
      await deliver(evt("evt___mpayhN_upnoop", "invoice.upcoming", { id: "in_noop", customer: CUST }));
      expect(listSpy).toHaveBeenCalled();
      expect(createSpy).not.toHaveBeenCalled(); // item do ciclo já existe → no-op (idempotente)
    });
  });

  it("invoice.upcoming pro 1ª vez (list vazio) → cria 1; 2ª vez (list devolve o criado) → não duplica", async () => {
    await withWebhook(async (sql) => {
      await linkCustomer(sql);
      await sql`insert into galeed_subscriptions (account_id, stripe_subscription_id, tier, status, updated_at)
        values (${ACCT}, 'sub___mpayhN', 'pro', 'active', now())
        on conflict (account_id) do update set tier='pro', status='active', stripe_subscription_id='sub___mpayhN'`;
      const over = tierDef("pro")!.credits + 500;
      await sql`insert into galeed_credit_ledger (account_id, delta, bucket, reason, op, idempotency_key)
        values (${ACCT}, ${-over}, 'usage', 'usage_ask', 'ask', 'over-twice-__mpayhN')`;
      const month = new Date().toISOString().slice(0, 7);
      const marker = `sub___mpayhN:cal-${month}`;
      // 1ª entrega: nada lançado ainda → cria.
      vi.spyOn(getStripe().invoiceItems, "list").mockResolvedValueOnce({ data: [] } as any);
      const createSpy = vi.spyOn(getStripe().invoiceItems, "create").mockResolvedValue({ id: "ii_first" } as any);
      await deliver(evt("evt___mpayhN_tw1", "invoice.upcoming", { id: "in_tw1", customer: CUST }));
      expect(createSpy).toHaveBeenCalledTimes(1);
      expect((createSpy.mock.calls[0][0] as any).metadata.overage_for).toBe(marker);
      // 2ª entrega do MESMO ciclo: o list agora devolve o item criado → no-op (sem 2ª criação).
      vi.spyOn(getStripe().invoiceItems, "list").mockResolvedValueOnce({
        data: [{ id: "ii_first", metadata: { overage_for: marker } }],
      } as any);
      await deliver(evt("evt___mpayhN_tw2", "invoice.upcoming", { id: "in_tw2", customer: CUST }));
      expect(createSpy).toHaveBeenCalledTimes(1); // segue 1 — não duplicou
    });
  });
});
