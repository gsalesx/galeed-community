/** INTEGRAÇÃO M-PAY-H (Onda 7) — WEBHOOK do Stripe ponta-a-ponta contra Postgres real: dedup por
 *  event_id (seção crítica exclusiva) + CADA case do routeEvent. Assina o payload com o SDK
 *  (generateTestHeaderString) usando o STRIPE_WEBHOOK_SECRET do .env, então exercita o caminho REAL
 *  (constructStripeEvent → insert dedup → lock → routeEvent → processed_at). Os poucos cases que tocam a
 *  API do Stripe (charge.refunded / overage) têm o MÉTODO do client espionado (sem rede). CONTA + customer
 *  de teste descartáveis (__mpayh7w_). No-op sem DB ou sem chaves do Stripe (padrão ADR-014). */
import { describe, it, expect, afterAll, vi } from "vitest";
import { hasDb } from "./helpers/db.ts";
import { getSharedSql, closeSharedSql } from "../../src/core/platform/db-conn.ts";
import { stripeWebhookHandler } from "../../src/connectors/bff/bff-stripe.ts";
import { stripeEnabled, getStripe, tierDef } from "../../src/core/platform/stripe.ts";
import { getBillingPrefs } from "../../src/core/platform/billing-prefs.ts";

const ACCT = "__mpayh7w_acct";
const CUST = "cus___mpayh7w";

function ready(): boolean {
  return hasDb() && stripeEnabled() && !!process.env.STRIPE_WEBHOOK_SECRET;
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
  await sql`delete from galeed_credit_ledger where account_id = ${ACCT}`.catch(() => {});
  await sql`delete from galeed_credit_wallet where account_id = ${ACCT}`.catch(() => {});
  await sql`delete from galeed_billing_prefs where account_id = ${ACCT}`.catch(() => {});
  await sql`delete from galeed_subscriptions where account_id = ${ACCT}`.catch(() => {});
  await sql`delete from galeed_founder_reservations where account_id = ${ACCT}`.catch(() => {});
  await sql`delete from galeed_stripe_events where event_id like '%__mpayh7w%'`.catch(() => {});
  await sql`delete from galeed_billing_customers where account_id = ${ACCT}`.catch(() => {});
}

/** Vincula o customer de teste à conta (defesa confused-deputy do webhook). */
async function linkCustomer(sql: any): Promise<void> {
  await sql`
    insert into galeed_billing_customers (account_id, stripe_customer_id) values (${ACCT}, ${CUST})
    on conflict (account_id) do update set stripe_customer_id = ${CUST}
  `;
}

/** Assina e entrega um evento como o Stripe faria (corpo RAW + header HMAC). */
async function deliver(event: any): Promise<{ status: number; body: any }> {
  const raw = JSON.stringify(event);
  const header = getStripe().webhooks.generateTestHeaderString({ payload: raw, secret: process.env.STRIPE_WEBHOOK_SECRET! });
  return (await stripeWebhookHandler(raw, { "stripe-signature": header })) as any;
}

function evt(id: string, type: string, object: any): any {
  return { id, type, created: Math.floor(Date.now() / 1000), data: { object } };
}

async function withDb(fn: (sql: any) => Promise<void>): Promise<void> {
  if (!ready()) return;
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

describe("M-PAY-H Onda 7 — webhook dedup", () => {
  it("reentrega do MESMO event_id → no-op (duplicate:true), efeito aplicado 1×", async () => {
    await withDb(async (sql) => {
      await linkCustomer(sql);
      const e = evt("evt___mpayh7w_dedup", "invoice.paid", { id: "in_1", customer: CUST });
      // tier projetado localmente p/ não tocar subscriptions.retrieve.
      await sql`insert into galeed_subscriptions (account_id, tier, status, updated_at) values (${ACCT}, 'pro', 'active', now())
        on conflict (account_id) do update set tier='pro', status='active'`;
      const r1 = await deliver(e);
      expect(r1.status).toBe(200);
      expect(r1.body.duplicate).toBeUndefined();
      const r2 = await deliver(e);
      expect(r2.status).toBe(200);
      expect(r2.body.duplicate).toBe(true);
      // o bolo do tier foi concedido UMA vez (idempotência do grant casa com o dedup do evento).
      const led = (await sql`select count(*)::int c from galeed_credit_ledger where account_id = ${ACCT} and bucket='monthly'`) as any[];
      expect(led[0].c).toBe(1);
    });
  });

  it("assinatura inválida → 400 (não processa)", async () => {
    if (!ready()) return;
    const raw = JSON.stringify(evt("evt___mpayh7w_badsig", "invoice.paid", { id: "x", customer: CUST }));
    const r = (await stripeWebhookHandler(raw, { "stripe-signature": "t=1,v1=deadbeef" })) as any;
    expect(r.status).toBe(400);
  });
});

describe("M-PAY-H Onda 7 — billing_reason (anti credit-farming em proration/troca de plano) [auditoria R3 #8]", () => {
  it("invoice.paid billing_reason='subscription_update' → NÃO concede bolo (0 linhas 'monthly')", async () => {
    await withDb(async (sql) => {
      await linkCustomer(sql);
      await sql`insert into galeed_subscriptions (account_id, tier, status, updated_at) values (${ACCT}, 'pro', 'active', now())
        on conflict (account_id) do update set tier='pro', status='active'`;
      await deliver(evt("evt___mpayh7w_upd", "invoice.paid", { id: "in_upd", customer: CUST, billing_reason: "subscription_update" }));
      const led = (await sql`select count(*)::int c from galeed_credit_ledger where account_id = ${ACCT} and bucket='monthly'`) as any[];
      expect(led[0].c).toBe(0); // troca de plano no meio do ciclo (proration) não dá bolo cheio
    });
  });

  it("invoice.paid billing_reason='proration' → NÃO concede bolo", async () => {
    await withDb(async (sql) => {
      await linkCustomer(sql);
      await sql`insert into galeed_subscriptions (account_id, tier, status, updated_at) values (${ACCT}, 'pro', 'active', now())
        on conflict (account_id) do update set tier='pro', status='active'`;
      await deliver(evt("evt___mpayh7w_pror", "invoice.paid", { id: "in_pror", customer: CUST, billing_reason: "proration" }));
      const led = (await sql`select count(*)::int c from galeed_credit_ledger where account_id = ${ACCT} and bucket='monthly'`) as any[];
      expect(led[0].c).toBe(0);
    });
  });

  it("invoice.paid billing_reason='subscription_cycle' → concede 1 bolo do tier", async () => {
    await withDb(async (sql) => {
      await linkCustomer(sql);
      await sql`insert into galeed_subscriptions (account_id, tier, status, updated_at) values (${ACCT}, 'pro', 'active', now())
        on conflict (account_id) do update set tier='pro', status='active'`;
      await deliver(evt("evt___mpayh7w_cyc", "invoice.paid", { id: "in_cyc", customer: CUST, billing_reason: "subscription_cycle" }));
      const led = (await sql`select count(*)::int c, coalesce(sum(delta),0)::int s from galeed_credit_ledger where account_id = ${ACCT} and bucket='monthly'`) as any[];
      expect(led[0].c).toBe(1);
      expect(led[0].s).toBe(tierDef("pro")!.credits); // bolo cheio do Pro
    });
  });
});

describe("M-PAY-H Onda 7 — routeEvent por case", () => {
  it("customer.subscription.created → projeta tier/status/cohort", async () => {
    await withDb(async (sql) => {
      await linkCustomer(sql);
      const sub = {
        id: "sub___mpayh7w",
        customer: CUST,
        status: "active",
        cancel_at_period_end: false,
        metadata: { account_id: ACCT, tier: "pro", cohort: "standard" },
        items: { data: [{ current_period_end: 1893456000, price: { metadata: {} } }] },
      };
      await deliver(evt("evt___mpayh7w_subcreate", "customer.subscription.created", sub));
      const row = (await sql`select tier, status, cohort from galeed_subscriptions where account_id = ${ACCT}`) as any[];
      expect(row[0].tier).toBe("pro");
      expect(row[0].status).toBe("active");
    });
  });

  it("invoice.payment_failed → abre graça de 7d só na 1ª falha; updated → active limpa a graça", async () => {
    await withDb(async (sql) => {
      await linkCustomer(sql);
      await sql`insert into galeed_subscriptions (account_id, stripe_subscription_id, tier, status, updated_at)
        values (${ACCT}, 'sub___mpayh7w', 'pro', 'past_due', now())
        on conflict (account_id) do update set status='past_due'`;
      await deliver(evt("evt___mpayh7w_pf1", "invoice.payment_failed", { id: "in_pf", customer: CUST }));
      let row = (await sql`select grace_until from galeed_subscriptions where account_id = ${ACCT}`) as any[];
      const grace1 = row[0].grace_until;
      expect(grace1).not.toBeNull();
      // retry (Smart Retries) → NÃO estende a graça (event_id novo, mas grace_until já setada).
      await deliver(evt("evt___mpayh7w_pf2", "invoice.payment_failed", { id: "in_pf", customer: CUST }));
      row = (await sql`select grace_until from galeed_subscriptions where account_id = ${ACCT}`) as any[];
      expect(new Date(row[0].grace_until).getTime()).toBe(new Date(grace1).getTime());
      // voltou a active (customer.subscription.updated) → limpa a graça.
      const sub = {
        id: "sub___mpayh7w", customer: CUST, status: "active", cancel_at_period_end: false,
        metadata: { account_id: ACCT, tier: "pro", cohort: "standard" },
        items: { data: [{ current_period_end: 1893456000, price: { metadata: {} } }] },
      };
      await deliver(evt("evt___mpayh7w_active", "customer.subscription.updated", sub));
      row = (await sql`select status, grace_until from galeed_subscriptions where account_id = ${ACCT}`) as any[];
      expect(row[0].status).toBe("active");
      expect(row[0].grace_until).toBeNull();
    });
  });

  it("invoice.payment_action_required → liga needs_action nas prefs", async () => {
    await withDb(async (sql) => {
      await linkCustomer(sql);
      await deliver(evt("evt___mpayh7w_3ds", "invoice.payment_action_required", { id: "in_3ds", customer: CUST }));
      const p = await getBillingPrefs(ACCT);
      expect(p.needsAction).toBe(true);
    });
  });

  it("charge.dispute.created → liga dispute_open nas prefs", async () => {
    await withDb(async (sql) => {
      await linkCustomer(sql);
      await deliver(evt("evt___mpayh7w_disp", "charge.dispute.created", { id: "dp_1", customer: CUST }));
      const p = await getBillingPrefs(ACCT);
      expect(p.disputeOpen).toBe(true);
    });
  });

  it("invoice.upcoming starter → sem overage (no-op, nenhum InvoiceItem)", async () => {
    await withDb(async (sql) => {
      await linkCustomer(sql);
      await sql`insert into galeed_subscriptions (account_id, tier, status, updated_at) values (${ACCT}, 'starter', 'active', now())
        on conflict (account_id) do update set tier='starter', status='active'`;
      // gasto bem acima do bolo do starter — mas starter NÃO tem overage.
      await sql`insert into galeed_credit_ledger (account_id, delta, bucket, reason, op, idempotency_key)
        values (${ACCT}, -99999, 'usage', 'usage_ask', 'ask', 'big-spend-__mpayh7w')`;
      const spy = vi.spyOn(getStripe().invoiceItems, "create");
      await deliver(evt("evt___mpayh7w_up", "invoice.upcoming", { id: "in_up", customer: CUST }));
      expect(spy).not.toHaveBeenCalled(); // starter → applyOverageInvoiceItem retorna antes de criar
    });
  });

  it("invoice.upcoming pro com consumo > bolo → cria 1 InvoiceItem de overage (API espionada)", async () => {
    await withDb(async (sql) => {
      await linkCustomer(sql);
      await sql`insert into galeed_subscriptions (account_id, tier, status, updated_at) values (${ACCT}, 'pro', 'active', now())
        on conflict (account_id) do update set tier='pro', status='active'`;
      const over = tierDef("pro")!.credits + 1000; // 1000 de excedente
      await sql`insert into galeed_credit_ledger (account_id, delta, bucket, reason, op, idempotency_key)
        values (${ACCT}, ${-over}, 'usage', 'usage_ask', 'ask', 'over-spend-__mpayh7w')`;
      const listSpy = vi.spyOn(getStripe().invoiceItems, "list").mockResolvedValue({ data: [] } as any);
      const createSpy = vi.spyOn(getStripe().invoiceItems, "create").mockResolvedValue({ id: "ii_1" } as any);
      await deliver(evt("evt___mpayh7w_upover", "invoice.upcoming", { id: "in_upover", customer: CUST }));
      expect(listSpy).toHaveBeenCalled();
      expect(createSpy).toHaveBeenCalledTimes(1);
      const arg = createSpy.mock.calls[0][0] as any;
      expect(arg.metadata.kind).toBe("overage");
      expect(arg.metadata.credits).toBe("1000");
      expect(arg.amount).toBe(2500); // 1000cr × R$0,025 = 2500 centavos
    });
  });

  it("invoice.upcoming com period FUTURO → mede o ciclo que TERMINOU (não o futuro vazio) [auditoria R2 #6]", async () => {
    await withDb(async (sql) => {
      await linkCustomer(sql);
      await sql`insert into galeed_subscriptions (account_id, tier, status, updated_at) values (${ACCT}, 'pro', 'active', now())
        on conflict (account_id) do update set tier='pro', status='active'`;
      // A line da invoice.upcoming carrega o PRÓXIMO ciclo (futuro): [agora, agora+30d). O consumo do
      // ciclo ENCERRADO ([agora-30d, agora)) é que deve ser cobrado. Sem o fix, a janela futura tem
      // used=0 → overage nunca cobrado.
      const day = 86400;
      const nextStart = Math.floor(Date.now() / 1000); // início do próximo ciclo = agora
      const nextEnd = nextStart + 30 * day;
      const over = tierDef("pro")!.credits + 1000; // 1000 de excedente no ciclo encerrado
      // consumo datado DENTRO do ciclo encerrado (ex.: 5 dias atrás).
      await sql`insert into galeed_credit_ledger (account_id, delta, bucket, reason, op, idempotency_key, created_at)
        values (${ACCT}, ${-over}, 'usage', 'usage_ask', 'ask', 'over-past-__mpayh7w', now() - interval '5 days')`;
      const listSpy = vi.spyOn(getStripe().invoiceItems, "list").mockResolvedValue({ data: [] } as any);
      const createSpy = vi.spyOn(getStripe().invoiceItems, "create").mockResolvedValue({ id: "ii_past" } as any);
      const inv = { id: "in_future", customer: CUST, lines: { data: [{ period: { start: nextStart, end: nextEnd } }] } };
      await deliver(evt("evt___mpayh7w_upfut", "invoice.upcoming", inv));
      expect(createSpy).toHaveBeenCalledTimes(1); // mediu o ciclo passado, NÃO o futuro vazio
      const arg = createSpy.mock.calls[0][0] as any;
      expect(arg.metadata.credits).toBe("1000");
      expect(listSpy).toHaveBeenCalled();
    });
  });

  it("invoice.upcoming pro com TOP-UP no ciclo → overage 0 até estourar bolo+comprado [auditoria R2 #1]", async () => {
    await withDb(async (sql) => {
      await linkCustomer(sql);
      await sql`insert into galeed_subscriptions (account_id, tier, status, updated_at) values (${ACCT}, 'pro', 'active', now())
        on conflict (account_id) do update set tier='pro', status='active'`;
      const bolo = tierDef("pro")!.credits; // 10000
      // Cliente comprou 5000cr de top-up E consumiu 15000cr (10000 bolo + 5000 top-up): overage = 0.
      // Sem o fix, o overage seria sobre 5000cr JÁ PAGOS no top-up (dupla cobrança).
      await sql`insert into galeed_credit_ledger (account_id, delta, bucket, reason, idempotency_key)
        values (${ACCT}, 5000, 'topup', 'topup', 'topup-cycle-__mpayh7w')`;
      await sql`insert into galeed_credit_ledger (account_id, delta, bucket, reason, op, idempotency_key)
        values (${ACCT}, ${-(bolo + 5000)}, 'usage', 'usage_ask', 'ask', 'usage-cycle-__mpayh7w')`;
      const createSpy = vi.spyOn(getStripe().invoiceItems, "create");
      vi.spyOn(getStripe().invoiceItems, "list").mockResolvedValue({ data: [] } as any);
      // sem period → fallback mês-calendário (cobre tudo do mês corrente, onde estão os inserts).
      await deliver(evt("evt___mpayh7w_uptopup", "invoice.upcoming", { id: "in_topup", customer: CUST }));
      expect(createSpy).not.toHaveBeenCalled(); // consumo coberto por bolo+top-up → sem overage

      // Agora consome 1 a MAIS que bolo+comprado → overage = 1.
      await sql`insert into galeed_credit_ledger (account_id, delta, bucket, reason, op, idempotency_key)
        values (${ACCT}, -1, 'usage', 'usage_ask', 'ask', 'usage-over1-__mpayh7w')`;
      const createSpy2 = vi.spyOn(getStripe().invoiceItems, "create").mockResolvedValue({ id: "ii_over1" } as any);
      vi.spyOn(getStripe().invoiceItems, "list").mockResolvedValue({ data: [] } as any);
      await deliver(evt("evt___mpayh7w_uptopup2", "invoice.upcoming", { id: "in_topup2", customer: CUST }));
      expect(createSpy2).toHaveBeenCalledTimes(1);
      expect((createSpy2.mock.calls[0][0] as any).metadata.credits).toBe("1");
    });
  });

  it("customer.subscription.trial_will_end → no-op documentado (sem efeito)", async () => {
    await withDb(async (sql) => {
      const r = await deliver(evt("evt___mpayh7w_twe", "customer.subscription.trial_will_end", { id: "sub___mpayh7w", metadata: { account_id: ACCT } }));
      expect(r.status).toBe(200);
      const sub = (await sql`select count(*)::int c from galeed_subscriptions where account_id = ${ACCT}`) as any[];
      expect(sub[0].c).toBe(0); // não criou nem alterou assinatura
    });
  });

  it("checkout.session.completed (top-up pago, valor casa) → credita bucket topup", async () => {
    await withDb(async (sql) => {
      await linkCustomer(sql);
      const cs = {
        id: "cs___mpayh7w", mode: "payment", payment_status: "paid",
        amount_total: 2500 * 2, currency: "brl", customer: CUST,
        metadata: { account_id: ACCT, credits: "2500", kind: "topup" },
        // sem payment_intent → pula a captura de PM (não toca a API)
      };
      await deliver(evt("evt___mpayh7w_topup", "checkout.session.completed", cs));
      const w = (await sql`select balance from galeed_credit_wallet where account_id = ${ACCT}`) as any[];
      expect(Number(w[0].balance)).toBe(2500);
      const led = (await sql`select count(*)::int c from galeed_credit_ledger where account_id = ${ACCT} and bucket='topup'`) as any[];
      expect(led[0].c).toBe(1);
    });
  });

  it("checkout.session.completed com valor DIVERGENTE → NÃO credita (defesa)", async () => {
    await withDb(async (sql) => {
      await linkCustomer(sql);
      const cs = {
        id: "cs___mpayh7w2", mode: "payment", payment_status: "paid",
        amount_total: 1, currency: "brl", customer: CUST, // amount não bate com 2500×2
        metadata: { account_id: ACCT, credits: "2500", kind: "topup" },
      };
      await deliver(evt("evt___mpayh7w_topupbad", "checkout.session.completed", cs));
      const w = (await sql`select count(*)::int c from galeed_credit_wallet where account_id = ${ACCT}`) as any[];
      expect(w[0].c).toBe(0); // nenhuma carteira/crédito
    });
  });

  it("charge.refunded (top-up) → estorna proporcional (PI retrieve espionado)", async () => {
    await withDb(async (sql) => {
      await linkCustomer(sql);
      // saldo de top-up pré-existente p/ ser estornado.
      await sql.begin((tx: any) => import("../../src/core/platform/credits.ts").then((m) => m.grantCredits(tx, ACCT, 2500, "topup", "topup", "topup:seed__mpayh7w", "seed")));
      vi.spyOn(getStripe().paymentIntents, "retrieve").mockResolvedValue({
        id: "pi_ref", metadata: { kind: "topup", account_id: ACCT, credits: "2500" },
      } as any);
      const charge = { id: "ch_1", payment_intent: "pi_ref", amount: 5000, amount_refunded: 5000 };
      await deliver(evt("evt___mpayh7w_refund", "charge.refunded", charge));
      const w = (await sql`select balance from galeed_credit_wallet where account_id = ${ACCT}`) as any[];
      expect(Number(w[0].balance)).toBe(0); // estorno total (amount_refunded == amount)
      const ref = (await sql`select count(*)::int c from galeed_credit_ledger where account_id = ${ACCT} and bucket='topup_refund'`) as any[];
      expect(ref[0].c).toBe(1);
    });
  });

  it("payment_intent.succeeded (auto-recarga, valor casa) → credita bucket autorecharge e limpa needs_action", async () => {
    await withDb(async (sql) => {
      await linkCustomer(sql);
      // simula SCA pendente anterior (needs_action=true) que a recarga bem-sucedida deve limpar.
      await sql`insert into galeed_billing_prefs (account_id, needs_action, updated_at) values (${ACCT}, true, now())
        on conflict (account_id) do update set needs_action=true`;
      const pi = {
        id: "pi_ar", customer: CUST, amount_received: 2500 * 2, currency: "brl",
        metadata: { account_id: ACCT, credits: "2500", kind: "autorecharge" },
      };
      await deliver(evt("evt___mpayh7w_ar", "payment_intent.succeeded", pi));
      const w = (await sql`select balance from galeed_credit_wallet where account_id = ${ACCT}`) as any[];
      expect(Number(w[0].balance)).toBe(2500);
      const led = (await sql`select count(*)::int c from galeed_credit_ledger where account_id = ${ACCT} and bucket='autorecharge'`) as any[];
      expect(led[0].c).toBe(1);
      const p = await getBillingPrefs(ACCT);
      expect(p.needsAction).toBe(false);
    });
  });

  it("payment_intent.payment_failed (auto-recarga) → liga needs_action (trava-loop)", async () => {
    await withDb(async (sql) => {
      await linkCustomer(sql);
      const pi = { id: "pi_arf", customer: CUST, metadata: { account_id: ACCT, credits: "2500", kind: "autorecharge" } };
      await deliver(evt("evt___mpayh7w_arf", "payment_intent.payment_failed", pi));
      const p = await getBillingPrefs(ACCT);
      expect(p.needsAction).toBe(true);
    });
  });
});
