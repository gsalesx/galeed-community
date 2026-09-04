// M-PAY-A — wrapper fino do SDK do Stripe: client lazy + verificação de assinatura de webhook.
// FAIL-SOFT: sem STRIPE_SECRET_KEY o billing fica DESLIGADO (stripeEnabled() === false) — o app
// sobe normal e a rota de webhook responde 503. A chave LIVE vive só no env do servidor de prod;
// em dev usa-se a sk_test_. Nada de chave em código nem em git.
import Stripe from "stripe";

let _client: Stripe | null = null;

/** Há billing configurado? (gate fail-soft: sem secret key, billing off.) */
export function stripeEnabled(): boolean {
  return !!process.env.STRIPE_SECRET_KEY;
}

/** Client lazy do Stripe. LANÇA se chamado sem STRIPE_SECRET_KEY — proteja com stripeEnabled(). */
export function getStripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY ausente — billing desabilitado");
  if (!_client) {
    // apiVersion omitida de propósito: usa a fixada pelo SDK (suficiente p/ M-PAY-A, que só
    // recebe/verifica webhook). maxNetworkRetries dá idempotência da lib em erro de rede.
    _client = new Stripe(key, { maxNetworkRetries: 2 });
  }
  return _client;
}

/** Verifica a assinatura do webhook (HMAC sobre o corpo RAW + janela de 5min) e devolve o evento
 *  tipado. LANÇA em assinatura/segredo inválidos ou header ausente — o caller traduz em 400. */
export function constructStripeEvent(rawBody: string, signature: string | undefined): Stripe.Event {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error("STRIPE_WEBHOOK_SECRET ausente");
  if (!signature) throw new Error("header stripe-signature ausente");
  return getStripe().webhooks.constructEvent(rawBody, signature, secret);
}

// ---------- M-PAY-B: tiers, preços e customer ----------
// Fonte dos números: BP §4.0 (tabela canônica). Valores em CENTAVOS de BRL. Enterprise é sales-led
// (sem self-serve checkout). credits/brains aqui são informativos (o débito de crédito é M-PAY-C).

export interface TierDef {
  tier: "starter" | "pro" | "business";
  name: string;
  brl: number; // preço PADRÃO mensal, em centavos
  founderBrl: number; // preço FUNDADOR (travado vitalício), em centavos
  credits: number; // bolo mensal de créditos
  brains: number; // nº de brains do tier
}

export const TIERS: TierDef[] = [
  { tier: "starter", name: "Starter", brl: 11900, founderBrl: 4500, credits: 4000, brains: 1 },
  { tier: "pro", name: "Pro", brl: 32900, founderBrl: 12900, credits: 10000, brains: 3 },
  { tier: "business", name: "Business", brl: 119700, founderBrl: 37900, credits: 30000, brains: 5 },
];

export type Cohort = "standard" | "founder";

export function tierDef(tier: string): TierDef | undefined {
  return TIERS.find((t) => t.tier === tier);
}

// M-PAY-H (Onda 4) — OVERAGE: crédito consumido ALÉM do bolo do tier no ciclo é cobrado na fatura do
// próximo período (InvoiceItem em invoice.upcoming), SÓ para Pro+ (starter sem overage). Preço por
// crédito de overage é PADRÃO (> R$0,02 do bolo): R$0,025/cr = 2,5 centavos. Em centavos de BRL.
export const OVERAGE_CENTAVOS_PER_CREDIT = 2.5;

/** Tiers que SÃO cobrados por overage (consumo além do bolo). Starter sobe de plano/faz top-up. */
export const OVERAGE_TIERS = new Set(["pro", "business"]);

/** PURA: créditos de overage do ciclo, só para Pro+. <=0 ou tier sem overage → 0. Trava o contrato do
 *  cálculo sem tocar DB/Stripe (testável).
 *
 *  Overage = consumo de uso − bolo do tier − créditos PAGOS concedidos no MESMO ciclo (top-up,
 *  auto-recarga, indicação). Subtrair os créditos pagos é OBRIGATÓRIO (auditoria R2): sem isso, um
 *  cliente que compra top-up (R$0,02/cr) e consome além do bolo pagaria DE NOVO pelo MESMO consumo via
 *  InvoiceItem de overage (R$0,025/cr) — dupla cobrança da mesma operação. Só cobramos overage quando o
 *  consumo excede TODO o crédito disponível no ciclo (bolo + comprado). */
export function computeOverageCredits(
  tier: string | null | undefined,
  usageCreditsThisCycle: number,
  paidCreditsThisCycle = 0,
): number {
  if (!tier || !OVERAGE_TIERS.has(tier)) return 0;
  const def = tierDef(tier);
  if (!def) return 0;
  const allowance = def.credits + Math.max(0, paidCreditsThisCycle);
  const over = usageCreditsThisCycle - allowance;
  return over > 0 ? over : 0;
}

/** PURA: valor em CENTAVOS de BRL do overage (arredondado p/ inteiro — Stripe cobra em centavos). */
export function overageAmountCents(overageCredits: number): number {
  return Math.round(overageCredits * OVERAGE_CENTAVOS_PER_CREDIT);
}

/** PURA — M-PAY-H (Onda 4): cohort do checkout por DISPONIBILIDADE de vaga fundador. Há vaga
 *  (remaining > 0) → 'founder' (preço vitalício); senão 'standard' (preço padrão, resolvePriceId(tier,
 *  'standard')). remaining null/desconhecido → 'standard' (fail-safe: nunca promete o desconto sem
 *  confirmar vaga). Sem vaga NÃO trava a assinatura — só cai no preço padrão. */
export function pickCheckoutCohort(founderRemaining: number | null | undefined): Cohort {
  return typeof founderRemaining === "number" && founderRemaining > 0 ? "founder" : "standard";
}

/** lookup_key estável do Price — idempotência entre o setup e o runtime. */
export function priceLookupKey(tier: string, cohort: Cohort): string {
  return cohort === "founder" ? `galeed_${tier}_monthly_founder` : `galeed_${tier}_monthly`;
}

const _priceCache = new Map<string, string>();
/** Resolve tier+cohort → price_id via lookup_key (cacheado no processo). LANÇA se não existir
 *  (rode apps/server/scripts/stripe-setup.ts). NUNCA aceitar price_id vindo do cliente. */
export async function resolvePriceId(tier: string, cohort: Cohort): Promise<string> {
  const key = priceLookupKey(tier, cohort);
  const cached = _priceCache.get(key);
  if (cached) return cached;
  const list = await getStripe().prices.list({ lookup_keys: [key], active: true, limit: 1 });
  const price = list.data[0];
  if (!price) throw new Error(`Price ausente p/ lookup_key=${key} — rode o stripe-setup.`);
  _priceCache.set(key, price.id);
  return price.id;
}

/** Cria o Stripe Customer da conta (idempotency key derivada da conta → retry não duplica).
 *  O caller persiste o customer.id em galeed_accounts.stripe_customer_id. */
export async function createCustomer(accountId: string, email: string, name?: string): Promise<string> {
  const c = await getStripe().customers.create(
    { email, name: name || undefined, metadata: { account_id: accountId } },
    { idempotencyKey: `cust:${accountId}` },
  );
  return c.id;
}
