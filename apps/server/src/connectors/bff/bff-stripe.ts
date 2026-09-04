// M-PAY-A/B — borda de billing do Stripe.
//   • Webhook m2m (auth = assinatura do Stripe), idempotente + EXCLUSIVO via transação + SELECT FOR
//     UPDATE no event_id (uma entrega processa; concorrentes/retries bloqueiam e viram no-op).
//   • Endpoints account-scoped: criar Checkout de assinatura, abrir Customer Portal, ler estado.
// Stripe = fonte da verdade do PAGAMENTO; o DB local é projeção sincronizada por webhook.
// NUNCA confia em preço/price_id vindo do cliente (só o nome do tier; price_id resolvido server-side
// por lookup_key). O handler do webhook NUNCA lança — devolve {status, body}.
import type { IncomingHttpHeaders } from "node:http";
import type Stripe from "stripe";
import { getSharedSql, sharedSqlGeneration } from "../../core/platform/db-conn.ts";
import {
  stripeEnabled,
  constructStripeEvent,
  getStripe,
  resolvePriceId,
  createCustomer,
  tierDef,
  computeOverageCredits,
  overageAmountCents,
  OVERAGE_CENTAVOS_PER_CREDIT,
  type Cohort,
} from "../../core/platform/stripe.ts";
import { CREDIT_DDL, grantTierCredits, grantCredits, clawbackTopup, accountCreditBalance, topupPackage, TOPUP_PACKAGES, CENTAVOS_PER_CREDIT } from "../../core/platform/credits.ts";
import { emitNfse } from "../../core/platform/nfse.ts";
import { activateReferral } from "../../core/platform/referral.ts";
import {
  flagBillingPrefInTx,
  getBillingPrefs,
  setAutorecharge,
  setDefaultPaymentMethod,
  shouldAutoRecharge,
  setAutorechargePending,
  clearAutorechargePendingInTx,
  AUTORECHARGE_PENDING_TTL_MS,
  type BillingPrefs,
} from "../../core/platform/billing-prefs.ts";

type Acct = { id: string; email: string; name?: string };

export interface StripeWebhookOutcome {
  status: number;
  body: unknown;
}

function appUrl(): string {
  return (process.env.GALEED_APP_URL || "http://localhost:5173").replace(/\/+$/, "");
}

// Bootstrap idempotente do schema de billing sobre a pool compartilhada — ESPELHA as migrations 36/37/38
// (o webhook/billing usam getSharedSql, que NÃO roda o migration runner do PostgresEngine). Tabelas
// GLOBAIS (sem brain → FORA do RLS; isolamento é por account_id na query, não por RLS). Sem FK p/
// galeed_accounts: o boot lazy não garante ordem de criação. Mantém em sincronia com migrations.ts.
let _ready: Promise<void> | null = null;
let _readyGeneration = -1;
async function db(): Promise<any> {
  const sql = await getSharedSql();
  const gen = sharedSqlGeneration();
  if (!_ready || _readyGeneration !== gen) {
    _readyGeneration = gen;
    _ready = (async () => {
      await sql.unsafe(`
        create table if not exists galeed_stripe_events (
          event_id     text primary key,
          type         text not null,
          received_at  timestamptz not null default now(),
          processed_at timestamptz
        );
        create table if not exists galeed_billing_customers (
          account_id         text primary key,
          stripe_customer_id text unique,
          created_at         timestamptz not null default now()
        );
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
        alter table galeed_subscriptions add column if not exists last_event_at timestamptz;
        -- M-PAY-H (migration 47): janela de graça de inadimplência (entitlement). Setada em
        -- invoice.payment_failed (+7d, só na 1ª falha do ciclo); limpa quando volta a 'active'.
        alter table galeed_subscriptions add column if not exists grace_until timestamptz;
        create table if not exists galeed_founder_reservations (
          account_id text primary key,
          created_at timestamptz not null default now()
        );
        ${CREDIT_DDL}
      `);
    })();
  }
  await _ready;
  return sql;
}

/** Customer do Stripe da conta (cria + persiste na 1ª vez). Idempotente: idempotency key no Stripe
 *  (createCustomer, params estáveis derivados da conta) + on conflict no DB; concorrência converge
 *  p/ o mesmo customer. */
async function ensureCustomer(sql: any, account: Acct): Promise<string> {
  const rows = (await sql`
    select stripe_customer_id from galeed_billing_customers where account_id = ${account.id}
  `) as any[];
  if (rows[0]?.stripe_customer_id) return rows[0].stripe_customer_id;
  const customerId = await createCustomer(account.id, account.email, account.name);
  await sql`
    insert into galeed_billing_customers (account_id, stripe_customer_id)
    values (${account.id}, ${customerId}) on conflict (account_id) do nothing
  `;
  const r2 = (await sql`
    select stripe_customer_id from galeed_billing_customers where account_id = ${account.id}
  `) as any[];
  return r2[0].stripe_customer_id;
}

// ---------- endpoints (account-scoped; o caller já validou a sessão) ----------

/** Checkout Session de assinatura de um tier. O preço FUNDADOR exige contagem de vagas server-side
 *  (M-PAY-F): cohort='founder' RESERVA uma vaga atômica; se não houver vaga, DEGRADA para 'standard' e
 *  segue o checkout no preço padrão (gap #5 — o checkout padrão é sempre acessível; vaga esgotada nunca
 *  trava a assinatura). price_id resolvido server-side por lookup_key (nunca confiando no cliente). */
export async function createCheckoutHandler(account: Acct, tier: string, cohort: string): Promise<StripeWebhookOutcome> {
  if (!stripeEnabled()) return { status: 503, body: { error: "billing desabilitado." } };
  if (!tierDef(tier)) return { status: 400, body: { error: `tier inválido: ${tier}` } };
  try {
    const sql = await db();
    // GUARDA ANTI-DUPLA-ASSINATURA (auditoria R2): checkout `mode:subscription` SEMPRE instancia uma
    // NOVA Subscription no Stripe — nunca troca a existente. Se a conta já tem assinatura vigente
    // (active/trialing/past_due), criar outro checkout cobraria DUAS assinaturas no mesmo customer (a
    // projeção local com PK account_id esconderia a duplicata). A troca de plano CORRETA é via Customer
    // Portal (com proration). Então: conta COM assinatura vigente → abre o Portal (troca/cancela lá);
    // checkout só p/ contas SEM assinatura vigente.
    const existing = (await sql`
      select status from galeed_subscriptions where account_id = ${account.id}
    `) as any[];
    const liveStatus = existing[0]?.status as string | undefined;
    if (liveStatus && ["active", "trialing", "past_due"].includes(liveStatus)) {
      const customer = await ensureCustomer(sql, account);
      const portal = await getStripe().billingPortal.sessions.create({ customer, return_url: `${appUrl()}/` });
      return { status: 200, body: { url: portal.url, portal: true } };
    }
    let c: Cohort = "standard";
    if (cohort === "founder") {
      // M-PAY-F: Turma Fundadora — RESERVA atômica de vaga (advisory lock fecha a corrida + a janela
      // checkout→ativo). O cliente nunca pega o preço vitalício sem haver vaga reservada.
      // M-PAY-H (auditoria gap #5): vaga esgotada NÃO trava a venda — DEGRADA p/ 'standard' e segue o
      // checkout no preço padrão (resolvePriceId(tier,'standard')). Antes retornava 400 "esgotada".
      if (await reserveFounderSeat(sql, account.id)) {
        c = "founder";
      } else {
        console.log(`[stripe] Turma Fundadora esgotada — conta ${account.id} segue no preço padrão (standard).`);
      }
    }
    const customer = await ensureCustomer(sql, account);
    const price = await resolvePriceId(tier, c);
    const session = await getStripe().checkout.sessions.create({
      mode: "subscription",
      customer,
      line_items: [{ price, quantity: 1 }],
      // M-PAY-H (NFS-e Caminho A): a Spedy emite a nota lendo o Customer no Stripe (integração nativa
      // Spedy↔Stripe, no-code). Então o checkout PRECISA coletar CPF/CNPJ + endereço e PERSISTIR no
      // Customer — customer_update salva os campos coletados no Customer já existente. Sem isso a Spedy
      // não tem dados fiscais p/ emitir.
      billing_address_collection: "required",
      tax_id_collection: { enabled: true },
      customer_update: { address: "auto", name: "auto" },
      // subscription_data.metadata é o que aterrissa no objeto Subscription que o webhook lê.
      subscription_data: { metadata: { account_id: account.id, tier, cohort: c } },
      success_url: `${appUrl()}/?checkout=success`,
      cancel_url: `${appUrl()}/?checkout=cancel`,
      allow_promotion_codes: c === "standard", // não empilha cupom sobre o preço fundador
      // sem idempotencyKey estável: este caminho só roda p/ conta SEM assinatura vigente (a guarda acima
      // desvia quem já tem p/ o Portal). Uma 2ª tentativa do mesmo checkout abandonado é legítima (cria
      // nova session; não há assinatura ativa p/ duplicar).
    });
    return { status: 200, body: { url: session.url } };
  } catch (e) {
    console.error("[stripe] checkout falhou:", e instanceof Error ? e.message : e);
    return { status: 502, body: { error: "falha ao criar checkout." } };
  }
}

const FOUNDER_SEATS = () => Number(process.env.GALEED_FOUNDER_SEATS || 100);
const FOUNDER_LOCK = 919191; // advisory lock que serializa os checkouts fundador (anti-overshoot)

/** Vagas usadas (display): assinaturas fundador ativas/trial + reservas não-expiradas (TTL 60min). */
async function founderSeatsUsed(sql: any): Promise<number> {
  const r = (await sql`
    select (select count(*) from galeed_subscriptions where cohort = 'founder' and status in ('active','trialing'))
         + (select count(*) from galeed_founder_reservations where created_at > now() - interval '60 minutes') as n
  `) as any[];
  return Number(r[0]?.n ?? 0);
}

/** Reserva ATÔMICA de vaga fundador — fecha a janela checkout→ativo E a corrida de checkouts
 *  concorrentes: o advisory lock serializa; conta ativos+reservas de OUTRAS contas; se há vaga, grava/
 *  renova a reserva desta conta e retorna true. A reserva é apagada quando a assinatura fundador vira
 *  ativa (upsertSubscription) ou expira por TTL. */
async function reserveFounderSeat(sql: any, accountId: string): Promise<boolean> {
  return await sql.begin(async (tx: any) => {
    await tx`select pg_advisory_xact_lock(${FOUNDER_LOCK})`;
    const r = (await tx`
      select (select count(*) from galeed_subscriptions where cohort='founder' and status in ('active','trialing') and account_id != ${accountId})
           + (select count(*) from galeed_founder_reservations where created_at > now() - interval '60 minutes' and account_id != ${accountId}) as n
    `) as any[];
    if (Number(r[0]?.n ?? 0) >= FOUNDER_SEATS()) return false;
    await tx`insert into galeed_founder_reservations (account_id) values (${accountId}) on conflict (account_id) do update set created_at = now()`;
    return true;
  });
}

/** M-PAY-F — vagas da Turma Fundadora (público: a landing mostra "X vagas restantes"). */
export async function getFounderSeatsHandler(): Promise<unknown> {
  try {
    const sql = await db();
    const total = FOUNDER_SEATS();
    const used = await founderSeatsUsed(sql);
    return { total, used, remaining: Math.max(0, total - used) };
  } catch {
    return { total: null, used: null, remaining: null };
  }
}

/** Customer Portal (trocar cartão, cancelar, faturas). Requer config de portal no Dashboard
 *  (test mode: criar a config default uma vez). */
export async function createPortalHandler(account: Acct): Promise<StripeWebhookOutcome> {
  if (!stripeEnabled()) return { status: 503, body: { error: "billing desabilitado." } };
  try {
    const sql = await db();
    const customer = await ensureCustomer(sql, account);
    const session = await getStripe().billingPortal.sessions.create({
      customer,
      return_url: `${appUrl()}/`,
    });
    return { status: 200, body: { url: session.url } };
  } catch (e) {
    console.error("[stripe] portal falhou:", e instanceof Error ? e.message : e);
    return { status: 502, body: { error: "falha ao abrir portal (configurar o Customer Portal no Dashboard)." } };
  }
}

/** Estado da assinatura da conta (projeção local, alimentada por webhooks). Isolamento por account_id
 *  (estas tabelas estão FORA do RLS). */
export async function getSubscriptionHandler(account: Acct): Promise<unknown> {
  try {
    const sql = await db();
    const rows = (await sql`
      select tier, cohort, status, current_period_end, cancel_at_period_end, grace_until
      from galeed_subscriptions where account_id = ${account.id}
    `) as any[];
    return rows[0] || { status: null, tier: null };
  } catch {
    return { status: null, tier: null };
  }
}

/** Saldo de créditos da conta (M-PAY-C). null = conta sem carteira (não-billada). */
export async function getCreditsHandler(account: Acct): Promise<unknown> {
  return accountCreditBalance(account.id);
}

/** M-PAY-H (Onda 4) — preferências de billing (auto-recarga opt-in + sinais de dunning). NUNCA devolve
 *  o id do método salvo cru — só um booleano `hasPaymentMethod` (não vaza identificador do PM). */
export async function getBillingPrefsHandler(account: Acct): Promise<unknown> {
  const p = await getBillingPrefs(account.id);
  return {
    autorechargeEnabled: p.autorechargeEnabled,
    autorechargeThresholdCredits: p.autorechargeThresholdCredits,
    autorechargePackage: p.autorechargePackage,
    hasPaymentMethod: !!p.defaultPaymentMethod,
    needsAction: p.needsAction,
    disputeOpen: p.disputeOpen,
  };
}

/** M-PAY-H (Onda 4) — grava as prefs de auto-recarga (opt-in). Ligar exige um pacote de top-up válido
 *  E um método salvo (capturado num top-up anterior); senão 400 (o front leva o usuário a fazer 1 top-up
 *  primeiro). O cliente nunca informa price/PM cru. */
export async function setBillingPrefsHandler(
  account: Acct,
  body: { enabled: boolean; thresholdCredits: number; package: string | null },
): Promise<StripeWebhookOutcome> {
  const enabled = !!body.enabled;
  if (enabled) {
    if (!body.package || !topupPackage(body.package)) {
      return { status: 400, body: { error: `pacote de recarga inválido: ${body.package}` } };
    }
    const cur = await getBillingPrefs(account.id);
    if (!cur.defaultPaymentMethod) {
      return { status: 400, body: { error: "sem método de pagamento salvo — faça uma compra de créditos primeiro." } };
    }
  }
  const p = await setAutorecharge(account.id, {
    enabled,
    thresholdCredits: Number(body.thresholdCredits) || 0,
    package: body.package ?? null,
  });
  return {
    status: 200,
    body: {
      autorechargeEnabled: p.autorechargeEnabled,
      autorechargeThresholdCredits: p.autorechargeThresholdCredits,
      autorechargePackage: p.autorechargePackage,
      hasPaymentMethod: !!p.defaultPaymentMethod,
      needsAction: p.needsAction,
      disputeOpen: p.disputeOpen,
    },
  };
}

/** M-PAY-D — Checkout de COMPRA AVULSA de créditos (top-up, mode payment). O webhook
 *  checkout.session.completed credita o bucket 'topup'. Preço = créditos × R$0,02. */
export async function createTopupHandler(account: Acct, packageId: string): Promise<StripeWebhookOutcome> {
  if (!stripeEnabled()) return { status: 503, body: { error: "billing desabilitado." } };
  const pkg = topupPackage(packageId);
  if (!pkg) return { status: 400, body: { error: `pacote inválido: ${packageId}` } };
  try {
    const sql = await db();
    const customer = await ensureCustomer(sql, account);
    const session = await getStripe().checkout.sessions.create(
      {
        mode: "payment",
        customer,
        // M-PAY-H (auditoria): SÓ CARTÃO. O webhook de top-up só trata payment_status='paid' síncrono;
        // métodos assíncronos (Pix/boleto) pagariam DEPOIS do checkout sem creditar (o crédito ficaria
        // perdido). Travar em 'card' alinha com o MVP (só cartão recorrente) e garante crédito imediato.
        payment_method_types: ["card"],
        line_items: [
          {
            price_data: {
              currency: "brl",
              unit_amount: pkg.credits * CENTAVOS_PER_CREDIT,
              product_data: { name: `${pkg.credits} créditos Galeed` },
            },
            quantity: 1,
          },
        ],
        // M-PAY-H (NFS-e Caminho A): top-up também é venda tributável → coletar CPF/CNPJ + endereço e
        // persistir no Customer p/ a Spedy emitir a nota (vale p/ quem só compra top-up, sem assinatura).
        billing_address_collection: "required",
        tax_id_collection: { enabled: true },
        customer_update: { address: "auto", name: "auto" },
        // setup_future_usage: salva o método p/ a AUTO-RECARGA off_session (M-PAY-H Onda 4). O PM é
        // capturado em galeed_billing_prefs.default_payment_method no checkout.session.completed.
        payment_intent_data: { metadata: { account_id: account.id, credits: String(pkg.credits), kind: "topup" }, setup_future_usage: "off_session" },
        metadata: { account_id: account.id, credits: String(pkg.credits), kind: "topup" },
        success_url: `${appUrl()}/?topup=success`,
        cancel_url: `${appUrl()}/?topup=cancel`,
      },
      // SEM idempotencyKey estável: top-up é compra recorrente (a 2ª compra do mesmo pacote precisa de
      // uma sessão NOVA). A anti-duplicação do crédito vive no webhook (grantCredits por 'topup:'+event).
    );
    return { status: 200, body: { url: session.url } };
  } catch (e) {
    console.error("[stripe] topup falhou:", e instanceof Error ? e.message : e);
    return { status: 502, body: { error: "falha ao criar top-up." } };
  }
}

// ---------- webhook ----------

export interface SubProjection {
  accountId: string | null;
  customerId: string;
  subscriptionId: string;
  tier: string | null;
  cohort: string;
  status: string;
  periodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
}

/** PURA (sem DB): extrai a projeção de um objeto Subscription do Stripe. Testável → trava o contrato
 *  do SDK (ex.: current_period_end migrou do Subscription p/ o ITEM no v22/API dahlia). */
export function projectSubscription(sub: Stripe.Subscription): SubProjection {
  const meta = (sub.metadata || {}) as Record<string, string>;
  const item = sub.items?.data?.[0];
  const priceMeta = (item?.price?.metadata || {}) as Record<string, string>;
  const customer: any = sub.customer;
  return {
    accountId: meta.account_id || null,
    customerId: typeof customer === "string" ? customer : customer?.id,
    subscriptionId: sub.id,
    tier: meta.tier || priceMeta.galeed_tier || null,
    cohort: meta.cohort || priceMeta.galeed_cohort || "standard",
    status: sub.status,
    // v22 (API 2026-05-27.dahlia): current_period_end saiu do Subscription e foi p/ cada ITEM.
    periodEnd: item?.current_period_end ? new Date(item.current_period_end * 1000) : null,
    cancelAtPeriodEnd: !!sub.cancel_at_period_end,
  };
}

async function upsertSubscription(tx: any, sub: Stripe.Subscription, eventAt: Date, eventType: string): Promise<void> {
  const p = projectSubscription(sub);
  if (!p.accountId) {
    console.warn(`[stripe] subscription ${sub.id} sem account_id no metadata — ignorada.`);
    return;
  }
  if (!p.tier) console.warn(`[stripe] subscription ${sub.id} sem tier resolvido (out-of-band?).`);

  // Confused-deputy (defesa em profundidade): o par (account, customer) tem que bater com o vínculo
  // estabelecido no checkout. account_id é setado por nós (server-side) e o evento é assinado pelo
  // Stripe, mas validar o vínculo evita que um metadata divergente aponte a sub p/ outra conta.
  const link = (await tx`
    select account_id from galeed_billing_customers where stripe_customer_id = ${p.customerId}
  `) as any[];
  if (link[0] && link[0].account_id !== p.accountId) {
    console.error(`[stripe] sub ${sub.id}: account_id ${p.accountId} != dono do customer ${link[0].account_id} — ignorada.`);
    return;
  }

  if (eventType === "customer.subscription.deleted") {
    // Só cancela a assinatura ATUALMENTE gravada (não clobbera uma nova por deleted atrasado de uma
    // antiga, no churn/troca de plano) e respeita a ordem (last_event_at).
    await tx`
      update galeed_subscriptions
         set status = ${p.status}, cancel_at_period_end = ${p.cancelAtPeriodEnd},
             current_period_end = ${p.periodEnd}, last_event_at = ${eventAt}, updated_at = now()
       where account_id = ${p.accountId} and stripe_subscription_id = ${p.subscriptionId}
         and (last_event_at is null or last_event_at <= ${eventAt})
    `;
    return;
  }

  // M-PAY-H (Onda 3): ao voltar a 'active'/'trialing', LIMPA a graça (dunning resolvido); em qualquer
  // outro status, PRESERVA a grace_until vigente (setada em invoice.payment_failed). Computado no insert.
  const clearGrace = p.status === "active" || p.status === "trialing";
  // created/updated: upsert com GUARDA DE FRESCOR — evento mais novo vence; mais velho vira no-op.
  await tx`
    insert into galeed_subscriptions
      (account_id, stripe_customer_id, stripe_subscription_id, tier, cohort, status, current_period_end, cancel_at_period_end, grace_until, last_event_at, updated_at)
    values (${p.accountId}, ${p.customerId}, ${p.subscriptionId}, ${p.tier}, ${p.cohort}, ${p.status}, ${p.periodEnd}, ${p.cancelAtPeriodEnd}, ${null}, ${eventAt}, now())
    on conflict (account_id) do update set
      stripe_customer_id     = excluded.stripe_customer_id,
      stripe_subscription_id = excluded.stripe_subscription_id,
      tier                   = excluded.tier,
      cohort                 = excluded.cohort,
      status                 = excluded.status,
      current_period_end     = excluded.current_period_end,
      cancel_at_period_end   = excluded.cancel_at_period_end,
      grace_until            = case when ${clearGrace} then null else galeed_subscriptions.grace_until end,
      last_event_at          = excluded.last_event_at,
      updated_at             = now()
    where galeed_subscriptions.last_event_at is null or galeed_subscriptions.last_event_at <= excluded.last_event_at
  `;
  // M-PAY-F: assinatura fundador projetada → libera a reserva (o seat agora é a própria assinatura).
  if (p.cohort === "founder") await tx`delete from galeed_founder_reservations where account_id = ${p.accountId}`;
}

/** Conta dona do customer do Stripe (na tx do webhook). null se o customer não está vinculado. */
async function accountOfCustomerInTx(tx: any, customer: unknown): Promise<string | null> {
  const customerId = typeof customer === "string" ? customer : (customer as any)?.id;
  if (!customerId) return null;
  const r = (await tx`select account_id from galeed_billing_customers where stripe_customer_id = ${customerId}`) as any[];
  return r[0]?.account_id ?? null;
}

// Roteia o evento p/ o efeito de negócio, DENTRO da transação. Idempotente. Eventos de invoice/payment
// vão p/ M-PAY-C (créditos) e M-PAY-F/H (dunning + entitlement); ganchos da Onda 4 ficam marcados.
async function routeEvent(tx: any, event: Stripe.Event): Promise<void> {
  const eventAt = event.created ? new Date(event.created * 1000) : new Date(0);
  switch (event.type) {
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      await upsertSubscription(tx, event.data.object as Stripe.Subscription, eventAt, event.type);
      break;
    case "invoice.paid": {
      // M-PAY-C/H: concede o bolo do tier APENAS em renovação de ciclo (subscription_create =
      // 1ª fatura; subscription_cycle = renovação). Faturas de subscription_update/proration (troca de
      // plano no Customer Portal), threshold ou manual NÃO concedem bolo — senão um cliente que troca
      // de plano no meio do ciclo (ou faz upgrade→downgrade) ganharia um bolo CHEIO a cada proration
      // paga (farming de créditos). Defesa extra: idempotência por PERÍODO (subscription+period_start),
      // não por event_id — múltiplas faturas no mesmo ciclo dão UM bolo só. Na MESMA tx.
      const invoice = event.data.object as Stripe.Invoice;
      const inv: any = invoice;
      // M-PAY-H (auditoria): QUALQUER fatura paga FECHA o dunning — limpa a grace_until na MESMA tx. Vale
      // antes do gate de billing_reason: um pagamento de recuperação (retry do Smart Retries) pode chegar
      // como subscription_cycle OU como reason fora do conjunto de grant; em qualquer caso a graça acabou.
      // (O status volta a 'active' por customer.subscription.updated, que também limpa — aqui é defesa
      // contra corrida de ordem de webhook: o invoice.paid pode chegar ANTES do subscription.updated.)
      {
        const recovered = await accountOfCustomerInTx(tx, invoice.customer);
        if (recovered) {
          await tx`update galeed_subscriptions set grace_until = null, updated_at = now() where account_id = ${recovered} and grace_until is not null`;
        }
      }
      const billingReason: string | null = inv.billing_reason ?? null;
      const GRANT_REASONS = new Set(["subscription_create", "subscription_cycle"]);
      if (billingReason !== null && !GRANT_REASONS.has(billingReason)) {
        console.log(`[credits] invoice.paid ${event.id} billing_reason='${billingReason}' — não concede bolo (só create/cycle).`);
        break;
      }
      const cust: any = invoice.customer;
      const customerId = typeof cust === "string" ? cust : cust?.id;
      if (customerId) {
        const link = (await tx`
          select account_id from galeed_billing_customers where stripe_customer_id = ${customerId}
        `) as any[];
        const accountId = link[0]?.account_id;
        if (accountId) {
          // tier pela projeção local; se invoice.paid chegou ANTES de subscription.created (ordem de
          // webhook não garantida), resolve direto no Stripe p/ NÃO perder o bolo do 1º ciclo.
          let tier = ((await tx`select tier from galeed_subscriptions where account_id = ${accountId}`) as any[])[0]?.tier;
          if (!tier) {
            const subIdR = inv.subscription || inv.parent?.subscription_details?.subscription;
            if (subIdR) {
              try {
                const s = await getStripe().subscriptions.retrieve(subIdR);
                tier = (s.metadata as any)?.tier || ((s.items?.data?.[0]?.price?.metadata as any) || {}).galeed_tier;
              } catch (e) {
                console.warn(`[credits] retrieve sub ${subIdR} falhou:`, e instanceof Error ? e.message : e);
              }
            }
          }
          // Chave de idempotência por CICLO de cobrança: subscription_id + period_start da line. Garante
          // 1 bolo por ciclo mesmo se chegarem múltiplas faturas pagas (event_id distinto cada). Fallback
          // p/ event_id quando o ciclo não puder ser resolvido (não perde o 1º bolo).
          const subId = inv.subscription || inv.parent?.subscription_details?.subscription || null;
          const line0: any = inv.lines?.data?.[0];
          const periodStart =
            line0?.period?.start ?? inv.period_start ?? line0?.current_period_start ?? null;
          const periodKey = subId && periodStart != null ? `${subId}:${periodStart}` : null;
          const granted = await grantTierCredits(tx, accountId, event.id, tier, periodKey);
          if (granted) console.log(`[credits] +${granted}cr conta ${accountId} (invoice.paid ${event.id}, reason=${billingReason}, period=${periodKey ?? "evt"})`);
        }
      }
      break;
    }
    case "invoice.payment_failed": {
      // M-PAY-H dunning: 1ª falha do ciclo abre a janela de GRAÇA de 7 dias (entitlement = 'grace';
      // a conta ainda usa). Os retries do Stripe (Smart Retries) reentregam este evento — NÃO estendemos
      // a graça a cada retry: só seta se grace_until ainda estiver nula (1ª falha). A assinatura vai p/
      // past_due via customer.subscription.updated (já projetado). O renovo do bolo só em invoice.paid.
      const invoice = event.data.object as Stripe.Invoice;
      const accountId = await accountOfCustomerInTx(tx, invoice.customer);
      if (accountId) {
        const upd = (await tx`
          update galeed_subscriptions
             set grace_until = now() + interval '7 days', updated_at = now()
           where account_id = ${accountId} and grace_until is null
           returning grace_until
        `) as any[];
        if (upd.length > 0) console.warn(`[stripe] invoice.payment_failed (${event.id}) — graça de 7d aberta p/ conta ${accountId}.`);
        else console.warn(`[stripe] invoice.payment_failed (${event.id}) — graça já vigente p/ conta ${accountId} (retry; não estende).`);
      } else {
        console.warn(`[stripe] invoice.payment_failed (${event.id}) — sem conta vinculada ao customer.`);
      }
      break;
    }
    case "invoice.payment_action_required": {
      // M-PAY-H: 3DS/SCA pendente — a cobrança precisa de ação do cliente. Sinaliza needs_action nas
      // prefs (a UI mostra "ação necessária"; a auto-recarga da Onda 4 não reentra em loop). Sem efeito
      // de cobrança aqui (o entitlement segue pelo status da assinatura/graça).
      const invoice = event.data.object as Stripe.Invoice;
      const accountId = await accountOfCustomerInTx(tx, invoice.customer);
      if (accountId) {
        await flagBillingPrefInTx(tx, accountId, "needs_action", true);
        console.warn(`[stripe] invoice.payment_action_required (${event.id}) — 3DS/SCA pendente conta ${accountId}.`);
      }
      break;
    }
    case "charge.dispute.created": {
      // M-PAY-H: chargeback aberto — sinaliza dispute_open nas prefs (flag/log). Sem efeito de crédito
      // aqui (o estorno propriamente dito vem por charge.refunded). Resolve a conta pelo customer da
      // disputa quando presente.
      const dispute = event.data.object as Stripe.Dispute;
      const accountId = await accountOfCustomerInTx(tx, (dispute as any).customer);
      if (accountId) {
        await flagBillingPrefInTx(tx, accountId, "dispute_open", true);
        console.warn(`[stripe] charge.dispute.created (${event.id}) — disputa aberta conta ${accountId}.`);
      } else {
        console.warn(`[stripe] charge.dispute.created (${event.id}) — disputa aberta (sem conta vinculada).`);
      }
      break;
    }
    case "invoice.upcoming": {
      // M-PAY-H (Onda 4): OVERAGE — a fatura do próximo ciclo está sendo montada. Computa o consumo
      // de USO do ciclo (bucket 'usage', mês corrente) ALÉM do bolo do tier; se >0 e tier ∈ {pro,
      // business}, anexa um InvoiceItem à fatura próxima. Idempotente por invoice id (o InvoiceItem
      // carrega metadata.overage_for=invoice.id; checamos antes de criar p/ não duplicar). Starter:
      // sem overage. Side-effect externo (cria InvoiceItem no Stripe), mas a leitura/decisão é local.
      const invoice = event.data.object as Stripe.Invoice;
      await applyOverageInvoiceItem(tx, invoice);
      break;
    }
    case "customer.subscription.trial_will_end":
      // N/A: não usamos trial do Stripe (nosso trial é de CRÉDITO, expira via expireTrialIfNeeded em
      // credits.ts). No-op documentado — só registrado p/ rastro.
      console.log(`[stripe] customer.subscription.trial_will_end (${event.id}) — N/A (trial é de crédito).`);
      break;
    case "checkout.session.completed": {
      // Assinatura: projetada por customer.subscription.created (success_url NÃO é autoritativo).
      // M-PAY-D TOP-UP (mode payment): credita 'topup' SÓ se pago + o valor cobrado (server-side) bate
      // com os créditos prometidos + o customer pertence à conta (confused-deputy). Idempotente.
      const cs = event.data.object as Stripe.Checkout.Session;
      if (cs.mode === "payment" && (cs.metadata as any)?.kind === "topup" && cs.payment_status === "paid") {
        const accountId = (cs.metadata as any)?.account_id;
        const credits = Number((cs.metadata as any)?.credits || 0);
        const csCust: any = cs.customer;
        const customerId = typeof csCust === "string" ? csCust : csCust?.id;
        if (!accountId || credits <= 0 || cs.amount_total !== credits * CENTAVOS_PER_CREDIT || cs.currency !== "brl") {
          console.error(`[credits] top-up ${event.id} DIVERGENTE (account=${accountId} credits=${credits} amount_total=${cs.amount_total} cur=${cs.currency}) — NÃO creditado.`);
        } else {
          const link = (await tx`select account_id from galeed_billing_customers where stripe_customer_id = ${customerId}`) as any[];
          if (link[0] && link[0].account_id !== accountId) {
            console.error(`[credits] top-up ${event.id}: customer ${customerId} (conta ${link[0].account_id}) != metadata ${accountId} — NÃO creditado.`);
          } else {
            const granted = await grantCredits(tx, accountId, credits, "topup", "topup", "topup:" + event.id, event.id);
            if (granted) console.log(`[credits] top-up +${granted}cr conta ${accountId} (${event.id})`);
            // M-PAY-H (Onda 4): captura o método salvo (setup_future_usage) p/ a auto-recarga off_session.
            const piRef: any = cs.payment_intent;
            const piId = typeof piRef === "string" ? piRef : piRef?.id;
            if (piId) {
              try {
                const intent = await getStripe().paymentIntents.retrieve(piId);
                const pm = typeof intent.payment_method === "string" ? intent.payment_method : (intent.payment_method as any)?.id;
                if (pm) await setDefaultPaymentMethod(accountId, pm);
              } catch (e) {
                console.warn(`[credits] top-up ${event.id}: captura de PM falhou:`, e instanceof Error ? e.message : e);
              }
            }
          }
        }
      }
      break;
    }
    case "charge.refunded": {
      // M-PAY-D: estorna créditos de top-up no reembolso/chargeback (proporcional ao valor estornado).
      const charge = event.data.object as Stripe.Charge;
      const pi: any = charge.payment_intent;
      const piId = typeof pi === "string" ? pi : pi?.id;
      if (piId && charge.amount > 0) {
        try {
          const intent = await getStripe().paymentIntents.retrieve(piId);
          const m = (intent.metadata || {}) as any;
          if (m.kind === "topup" && m.account_id) {
            // charge.amount_refunded é CUMULATIVO (total já reembolsado no charge). Convertendo p/ créditos
            // dá o cumulativo DESEJADO; o clawback debita só o DELTA sobre o que já foi estornado p/ este PI
            // (auditoria R3 #2) — múltiplos parciais não re-contam o já estornado.
            const desiredCumulative = Math.round((Number(m.credits || 0) * (charge.amount_refunded || 0)) / charge.amount);
            if (desiredCumulative > 0) {
              const removed = await clawbackTopup(tx, m.account_id, desiredCumulative, event.id, piId);
              console.log(`[credits] estorno -${removed}cr conta ${m.account_id} (charge.refunded ${event.id}, cumulativo ${desiredCumulative}cr)`);
            }
          }
        } catch (e) {
          console.warn(`[credits] charge.refunded ${event.id}: retrieve PI falhou:`, e instanceof Error ? e.message : e);
        }
      }
      break;
    }
    case "payment_intent.succeeded": {
      // M-PAY-H (Onda 4): AUTO-RECARGA confirmada — o PaymentIntent off_session (kind=autorecharge)
      // pagou. Credita o bucket 'topup' (idempotente por PI id). SÓ se o valor cobrado bate com os
      // créditos prometidos (defesa contra metadata adulterado) e o customer pertence à conta. Limpa
      // qualquer needs_action (a cobrança passou). NÃO confunde com top-up via checkout (kind=topup,
      // creditado em checkout.session.completed).
      const pi = event.data.object as Stripe.PaymentIntent;
      const m = (pi.metadata || {}) as any;
      if (m.kind === "autorecharge" && m.account_id) {
        const credits = Number(m.credits || 0);
        const cust: any = pi.customer;
        const customerId = typeof cust === "string" ? cust : cust?.id;
        if (credits > 0 && pi.amount_received === credits * CENTAVOS_PER_CREDIT && pi.currency === "brl") {
          const link = (await tx`select account_id from galeed_billing_customers where stripe_customer_id = ${customerId}`) as any[];
          if (link[0] && link[0].account_id !== m.account_id) {
            console.error(`[credits] auto-recarga ${event.id}: customer ${customerId} (conta ${link[0].account_id}) != metadata ${m.account_id} — NÃO creditado.`);
          } else {
            const granted = await grantCredits(tx, m.account_id, credits, "autorecharge", "autorecharge", "autorecharge:" + pi.id, event.id);
            if (granted) console.log(`[credits] auto-recarga +${granted}cr conta ${m.account_id} (${event.id})`);
            // crédito chegou: limpa needs_action E a trava EM VOO (libera a próxima auto-recarga).
            await tx`
              insert into galeed_billing_prefs (account_id, needs_action, autorecharge_pending_until, updated_at) values (${m.account_id}, false, ${null}, now())
              on conflict (account_id) do update set needs_action = false, autorecharge_pending_until = null, updated_at = now()
            `;
          }
        } else {
          console.error(`[credits] auto-recarga ${event.id} DIVERGENTE (credits=${credits} amount_received=${pi.amount_received} cur=${pi.currency}) — NÃO creditado.`);
        }
      }
      break;
    }
    case "payment_intent.payment_failed": {
      // M-PAY-H (Onda 4): a auto-recarga off_session FALHOU (cartão recusado / SCA requerido). Liga
      // needs_action nas prefs → a UI pede ação E o gatilho da auto-recarga NÃO reentra em loop (a
      // decisão pura shouldAutoRecharge barra enquanto needs_action=true). Sem efeito de crédito.
      const pi = event.data.object as Stripe.PaymentIntent;
      const m = (pi.metadata || {}) as any;
      if (m.kind === "autorecharge" && m.account_id) {
        await flagBillingPrefInTx(tx, m.account_id, "needs_action", true);
        // recarga resolvida (falhou): limpa a trava EM VOO. needs_action continua barrando o loop até
        // o cliente reabilitar; a trava não precisa mais segurar.
        await clearAutorechargePendingInTx(tx, m.account_id);
        console.warn(`[stripe] payment_intent.payment_failed (${event.id}) — auto-recarga falhou conta ${m.account_id} (needs_action).`);
      }
      break;
    }
    default:
      break;
  }
}

/** M-PAY-H (Onda 4) — OVERAGE: cria o InvoiceItem de consumo excedente na fatura próxima, idempotente
 *  por invoice id. RODA DENTRO da tx do webhook (leitura local) mas cria o InvoiceItem no Stripe (efeito
 *  externo dentro da seção crítica — se a tx der rollback o Stripe reentrega invoice.upcoming? NÃO: o
 *  Stripe NÃO reentrega invoice.upcoming; por isso a idempotência é por busca de InvoiceItem existente
 *  ANTES de criar). Pro+ apenas; starter sem overage. Fail-soft via try interno (não derruba o webhook). */
async function applyOverageInvoiceItem(tx: any, invoice: Stripe.Invoice): Promise<void> {
  try {
    const cust: any = invoice.customer;
    const customerId = typeof cust === "string" ? cust : cust?.id;
    if (!customerId) return;
    const link = (await tx`select account_id from galeed_billing_customers where stripe_customer_id = ${customerId}`) as any[];
    const accountId = link[0]?.account_id;
    if (!accountId) return;
    const sub = (await tx`select tier from galeed_subscriptions where account_id = ${accountId}`) as any[];
    const tier = sub[0]?.tier ?? null;
    // JANELA = o CICLO QUE TERMINOU, não o que vai começar (auditoria R2). Em invoice.upcoming a line
    // carrega o PRÓXIMO período (o que será faturado): [current_period_start, current_period_end) é o
    // ciclo FUTURO. Medir o overage nesse intervalo dá used≈0 (ainda não houve consumo) → overage nunca
    // cobrado. O consumo a cobrar é o do ciclo que acabou: [cps - duração, cps), onde cps é o início do
    // próximo ciclo (= fim do ciclo consumido) e duração = cpe - cps. Fallback p/ mês-calendário só se a
    // Stripe não trouxer o período (defensivo) — aí mede o mês corrente até agora.
    const inv: any = invoice;
    const line0: any = inv.lines?.data?.[0];
    const cps =
      line0?.period?.start ?? line0?.current_period_start ?? inv.period_start ?? null;
    const cpe =
      line0?.period?.end ?? line0?.current_period_end ?? inv.period_end ?? null;
    // Início do ciclo CONSUMIDO = início do próximo ciclo − duração de 1 ciclo. Fim = início do próximo.
    const consumedEndSec = cps;
    const consumedStartSec = cps != null && cpe != null ? cps - (cpe - cps) : null;
    const cycleStart = consumedStartSec != null ? new Date(consumedStartSec * 1000) : null;
    const cycleEnd = consumedEndSec != null ? new Date(consumedEndSec * 1000) : null;
    // Consumo de USO + créditos PAGOS (top-up/auto-recarga/indicação) no MESMO ciclo consumido. O
    // overage subtrai os pagos do consumo (anti-dupla-cobrança): a mesma operação não pode ser cobrada
    // no top-up E de novo no overage. Buckets pagos: 'topup', 'autorecharge', 'referral'.
    const PAID_BUCKETS = ["topup", "autorecharge", "referral"];
    const rows = cycleStart
      ? ((await tx`
          select
            coalesce(sum(-delta) filter (where bucket = 'usage'), 0)::bigint as used,
            coalesce(sum(delta)  filter (where bucket = any(${PAID_BUCKETS})), 0)::bigint as paid
          from galeed_credit_ledger
          where account_id = ${accountId}
            and created_at >= ${cycleStart}
            ${cycleEnd ? tx`and created_at < ${cycleEnd}` : tx``}
        `) as any[])
      : ((await tx`
          select
            coalesce(sum(-delta) filter (where bucket = 'usage'), 0)::bigint as used,
            coalesce(sum(delta)  filter (where bucket = any(${PAID_BUCKETS})), 0)::bigint as paid
          from galeed_credit_ledger
          where account_id = ${accountId} and created_at >= date_trunc('month', now())
        `) as any[]);
    const used = Number(rows[0]?.used ?? 0);
    const paid = Number(rows[0]?.paid ?? 0);
    const overageCredits = computeOverageCredits(tier, used, paid);
    if (overageCredits <= 0) return; // Pro+ dentro do bolo+comprado OU starter (sem overage)
    const amount = overageAmountCents(overageCredits);
    if (amount <= 0) return;
    // Idempotência por CICLO — NÃO por invoice.id (auditoria R3 #1/#3): em invoice.upcoming o objeto é
    // um PREVIEW e seu `id` é null (Stripe.Invoice.id = string|null). `invoice.id || "draft"` colapsava
    // p/ a CONSTANTE "draft" em TODO ciclo de TODA conta → (a) idempotencyKey global "overage:draft"
    // colidia entre contas (params diferentes → o Stripe rejeita o 2º; o overage daquela conta caía no
    // catch fail-soft e NUNCA era cobrado); (b) o pré-check `overage_for === "draft"` casava o item do
    // ciclo ANTERIOR (invoiceItems.list inclui itens já faturados) → no-op a partir do 2º ciclo (overage
    // cobrado no máximo 1×/cliente). O marker estável e único por conta+ciclo vem do que JÁ é computado:
    // subscription_id (ou conta) + início do ciclo CONSUMIDO (consumedEndSec). É o mesmo eixo do
    // periodKey usado em invoice.paid → 1 overage por ciclo, sem colisão entre contas.
    const subRow = (await tx`select stripe_subscription_id from galeed_subscriptions where account_id = ${accountId}`) as any[];
    const subId = subRow[0]?.stripe_subscription_id ?? accountId;
    const marker = `${subId}:${consumedEndSec ?? "cal-" + new Date().toISOString().slice(0, 7)}`;
    // pending:true exclui itens já faturados de ciclos anteriores (defesa extra: mesmo que dois ciclos
    // gerassem o mesmo marker por algum motivo, o item do ciclo passado já está numa fatura finalizada).
    const existing = await getStripe().invoiceItems.list({ customer: customerId, pending: true, limit: 100 });
    if (existing.data.some((ii) => (ii.metadata as any)?.overage_for === marker)) {
      console.log(`[stripe] overage já lançado p/ ciclo ${marker} (conta ${accountId}) — no-op.`);
      return;
    }
    await getStripe().invoiceItems.create(
      {
        customer: customerId,
        currency: "brl",
        amount,
        description: `Galeed — consumo excedente (${overageCredits} créditos × R$${(OVERAGE_CENTAVOS_PER_CREDIT / 100).toFixed(3)})`,
        metadata: { account_id: accountId, kind: "overage", overage_for: marker, credits: String(overageCredits) },
      },
      { idempotencyKey: `overage:${marker}` },
    );
    console.log(`[stripe] overage +${amount}c (${overageCredits}cr) conta ${accountId} ciclo ${marker}.`);
  } catch (e) {
    console.warn(`[stripe] applyOverageInvoiceItem erro (fail-soft):`, e instanceof Error ? e.message : e);
  }
}

/** M-PAY-H (Onda 4) — AUTO-RECARGA off_session: dispara um PaymentIntent no método salvo quando o saldo
 *  cai abaixo do limiar (opt-in). Best-effort, fail-soft, FORA da transação do débito (chamada pelo
 *  gateAndDebit após um débito). O crédito acontece só em payment_intent.succeeded (idempotente por PI
 *  id); aqui só DISPARA. SCA requerido (requires_action) ou erro → liga needs_action (não reentra em
 *  loop) e NÃO credita. Idempotência do disparo: idempotencyKey por (conta, dia-do-saldo). */
export async function maybeAutoRecharge(accountId: string, balance: number): Promise<void> {
  if (!stripeEnabled()) return;
  let prefs: BillingPrefs;
  try {
    prefs = await getBillingPrefs(accountId);
  } catch {
    return; // fail-soft: sem prefs, não recarrega
  }
  if (!shouldAutoRecharge(prefs, balance)) return;
  const pkg = topupPackage(prefs.autorechargePackage as string);
  if (!pkg) {
    console.warn(`[stripe] auto-recarga conta ${accountId}: pacote ${prefs.autorechargePackage} inválido — ignorada.`);
    return;
  }
  try {
    const sql = await db();
    const link = (await sql`select stripe_customer_id from galeed_billing_customers where account_id = ${accountId}`) as any[];
    const customerId = link[0]?.stripe_customer_id;
    if (!customerId) return;
    // TRAVA EM VOO: marca a recarga como pendente ANTES de disparar. shouldAutoRecharge barra novos
    // disparos enquanto a trava vigora (até o webhook payment_intent.succeeded/failed limpar, ou o TTL
    // expirar). Sem isso, débitos em minutos diferentes (antes do crédito do webhook chegar) cobrariam
    // o cartão N vezes por uma única queda de saldo. A re-leitura das prefs em cada débito vê a trava.
    const pendingUntil = new Date(Date.now() + AUTORECHARGE_PENDING_TTL_MS);
    await setAutorechargePending(accountId, pendingUntil);
    // idempotência do DISPARO: chave estável pela JANELA da trava (não por minuto) — colapsa qualquer
    // disparo concorrente da mesma queda de saldo. O crédito é idempotente por PI id de qualquer forma.
    const windowBucket = Math.floor(pendingUntil.getTime() / AUTORECHARGE_PENDING_TTL_MS);
    const pi = await getStripe().paymentIntents.create(
      {
        customer: customerId,
        amount: pkg.credits * CENTAVOS_PER_CREDIT,
        currency: "brl",
        payment_method: prefs.defaultPaymentMethod as string,
        off_session: true,
        confirm: true,
        metadata: { account_id: accountId, credits: String(pkg.credits), kind: "autorecharge" },
      },
      { idempotencyKey: `autorecharge:${accountId}:${windowBucket}` },
    );
    // sucesso síncrono: o crédito ainda vem por webhook (payment_intent.succeeded) — fonte única.
    if (pi.status === "requires_action") {
      await setNeedsActionLazy(accountId);
      console.warn(`[stripe] auto-recarga conta ${accountId}: SCA requerido (requires_action) — needs_action.`);
    } else {
      console.log(`[stripe] auto-recarga disparada conta ${accountId} (PI ${pi.id}, status ${pi.status}).`);
    }
  } catch (e: any) {
    // off_session com SCA requerido lança StripeCardError com code 'authentication_required'.
    await setNeedsActionLazy(accountId);
    console.warn(`[stripe] auto-recarga conta ${accountId} falhou (needs_action):`, e?.message ?? e);
  }
}

/** Liga needs_action fora de tx (caminho da auto-recarga). Fail-soft. */
async function setNeedsActionLazy(accountId: string): Promise<void> {
  try {
    const sql = await db();
    await sql.begin((tx: any) => flagBillingPrefInTx(tx, accountId, "needs_action", true));
  } catch {
    /* fail-soft */
  }
}

/** Conta que fez um EVENTO PAGO (assinatura via invoice.paid OU top-up via checkout). null caso contrário. */
async function paidAccountOf(event: Stripe.Event): Promise<string | null> {
  try {
    if (event.type === "invoice.paid") {
      const inv = event.data.object as Stripe.Invoice;
      const cust: any = inv.customer;
      const customerId = typeof cust === "string" ? cust : cust?.id;
      if (!customerId) return null;
      const sql = await db();
      const r = (await sql`select account_id from galeed_billing_customers where stripe_customer_id = ${customerId}`) as any[];
      return r[0]?.account_id ?? null;
    }
    if (event.type === "checkout.session.completed") {
      const cs = event.data.object as Stripe.Checkout.Session;
      if (cs.mode === "payment" && (cs.metadata as any)?.kind === "topup" && cs.payment_status === "paid") {
        return (cs.metadata as any)?.account_id ?? null;
      }
    }
  } catch {
    /* fail-soft */
  }
  return null;
}

export async function stripeWebhookHandler(raw: string, headers: IncomingHttpHeaders): Promise<StripeWebhookOutcome> {
  if (!stripeEnabled()) {
    return { status: 503, body: { error: "billing desabilitado (sem STRIPE_SECRET_KEY)." } };
  }
  const sig = headers["stripe-signature"];
  let event: Stripe.Event;
  try {
    event = constructStripeEvent(raw, typeof sig === "string" ? sig : undefined);
  } catch {
    return { status: 400, body: { error: "assinatura do webhook inválida." } };
  }

  let duplicate = false;
  try {
    const sql = await db();
    // SEÇÃO CRÍTICA EXCLUSIVA: insert(dedup) + lock(for update) + routeEvent + processed_at numa
    // ÚNICA transação. Entregas concorrentes/retries do mesmo event_id serializam no lock; se
    // routeEvent falhar, TUDO faz rollback (inclusive o registro do evento) → o Stripe reentrega e
    // reprocessa do zero. É o gate anti-duplo-efeito que o M-PAY-C (créditos) vai herdar.
    await sql.begin(async (tx: any) => {
      await tx`
        insert into galeed_stripe_events (event_id, type) values (${event.id}, ${event.type})
        on conflict (event_id) do nothing
      `;
      const locked = (await tx`
        select processed_at from galeed_stripe_events where event_id = ${event.id} for update
      `) as any[];
      if (locked[0]?.processed_at) {
        duplicate = true;
        return;
      }
      await routeEvent(tx, event);
      await tx`update galeed_stripe_events set processed_at = now() where event_id = ${event.id}`;
    });
  } catch (e) {
    console.error(`[stripe] processamento falhou ${event.type} (${event.id}):`, e instanceof Error ? e.message : e);
    return { status: 500, body: { error: "falha ao processar — reentregar." } };
  }

  if (duplicate) return { status: 200, body: { received: true, duplicate: true } };

  // M-PAY-F: ativa a indicação pendente do INDICADO em EVENTO PAGO (assinatura/top-up). Fora da tx,
  // fail-soft, idempotente. Farming fica antieconômico (só pagamento do indicado gera bônus).
  const paidAcct = await paidAccountOf(event);
  if (paidAcct) await activateReferral(paidAcct);

  // M-PAY-E: NFS-e emitida FORA da transação do billing (side-effect externo, fail-soft, idempotente
  // por event_id). No-op enquanto SPEDY_API_TOKEN estiver vazio.
  if (event.type === "invoice.paid") {
    const inv = event.data.object as Stripe.Invoice;
    const taxId = ((inv.customer_tax_ids?.[0] as any) || {}).value;
    await emitNfse({
      eventId: event.id,
      accountId: null,
      amountCents: (inv.amount_paid ?? inv.total ?? 0) as number,
      description: "Galeed — assinatura",
      receiver: { name: inv.customer_name ?? undefined, email: inv.customer_email ?? undefined, taxId },
    });
  }

  console.log(`[stripe] evento ${event.type} (${event.id})`);
  return { status: 200, body: { received: true } };
}
