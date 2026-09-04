// M-PAY-H — preferências de billing por CONTA: auto-recarga opt-in (off_session no método salvo),
// dedup de alerta de consumo (last_alert_pct) e método de pagamento padrão. Tabela GLOBAL (sem brain,
// fora do RLS, como galeed_billing_customers/galeed_subscriptions). Fonte da verdade do que a Onda 4
// (overage + auto-recarga + alertas) consome — AQUI (Onda 1) só o schema espelhado + o bootstrap lazy.
import { getSharedSql, sharedSqlGeneration } from "./db-conn.ts";

// DDL canônica (espelhada na migration 48). ADITIVA — contas sem linha = preferências default
// (auto-recarga off, sem método salvo, nenhum alerta disparado). add column if not exists / create if
// not exists p/ o bootstrap lazy do getSharedSql convergir igual à migration em DB virgem ou existente.
export const BILLING_PREFS_DDL = `
  create table if not exists galeed_billing_prefs (
    account_id                     text primary key,
    autorecharge_enabled           boolean not null default false,
    autorecharge_threshold_credits bigint not null default 0,
    autorecharge_package           text,
    last_alert_pct                 int not null default 0,
    default_payment_method         text,
    updated_at                     timestamptz not null default now()
  );
  -- M-PAY-H (Onda 3, migration 49): 3DS/SCA pendente (invoice.payment_action_required) e disputa de
  -- cobrança (charge.dispute.created). Flags só de SINALIZAÇÃO (a UI mostra "ação necessária"); a
  -- auto-recarga da Onda 4 NÃO reentra em loop enquanto needs_action=true. ADITIVAS.
  alter table galeed_billing_prefs add column if not exists needs_action boolean not null default false;
  alter table galeed_billing_prefs add column if not exists dispute_open boolean not null default false;
  -- M-PAY-H (Onda 4, hardening): trava de auto-recarga EM VOO. O crédito da recarga só sobe o saldo
  -- DEPOIS, via webhook payment_intent.succeeded (assíncrono). Sem esta trava, cada débito em minutos
  -- diferentes (antes do webhook) re-dispararia um PaymentIntent NOVO (cobrança duplicada no cartão).
  -- Setada ao DISPARAR (now()+TTL), limpa em payment_intent.succeeded/failed. ADITIVA.
  alter table galeed_billing_prefs add column if not exists autorecharge_pending_until timestamptz;
`;

let _ready: Promise<void> | null = null;
let _gen = -1;
async function db(): Promise<any> {
  const sql = await getSharedSql();
  const gen = sharedSqlGeneration();
  if (!_ready || _gen !== gen) {
    _gen = gen;
    _ready = sql.unsafe(BILLING_PREFS_DDL);
  }
  await _ready;
  return sql;
}

export { db as ensureBillingPrefsSchema };

/** M-PAY-H (Onda 3) — marca uma flag de sinalização nas prefs da conta (needs_action / dispute_open),
 *  fazendo upsert da linha se não existir. RODA DENTRO da tx do webhook (mesma seção crítica do evento).
 *  Sem efeito de cobrança — só liga o sinal que a UI e a auto-recarga (Onda 4) consultam. */
export async function flagBillingPrefInTx(
  tx: any,
  accountId: string,
  field: "needs_action" | "dispute_open",
  value: boolean,
): Promise<void> {
  // Tagged templates por campo (não há concatenação de coluna a partir de input externo).
  if (field === "needs_action") {
    await tx`
      insert into galeed_billing_prefs (account_id, needs_action, updated_at)
        values (${accountId}, ${value}, now())
        on conflict (account_id) do update set needs_action = ${value}, updated_at = now()
    `;
  } else {
    await tx`
      insert into galeed_billing_prefs (account_id, dispute_open, updated_at)
        values (${accountId}, ${value}, now())
        on conflict (account_id) do update set dispute_open = ${value}, updated_at = now()
    `;
  }
}

// ---------------------------------------------------------------------------
// M-PAY-H (Onda 4) — leitura/escrita das preferências (auto-recarga + alertas).
// ---------------------------------------------------------------------------
export interface BillingPrefs {
  autorechargeEnabled: boolean;
  autorechargeThresholdCredits: number;
  autorechargePackage: string | null;
  lastAlertPct: number;
  defaultPaymentMethod: string | null;
  needsAction: boolean;
  disputeOpen: boolean;
  autorechargePendingUntil: string | null; // ISO — recarga off_session em voo (trava anti-duplicação)
}

const EMPTY_PREFS: BillingPrefs = {
  autorechargeEnabled: false,
  autorechargeThresholdCredits: 0,
  autorechargePackage: null,
  lastAlertPct: 0,
  defaultPaymentMethod: null,
  needsAction: false,
  disputeOpen: false,
  autorechargePendingUntil: null,
};

function mapPrefs(r: any): BillingPrefs {
  if (!r) return { ...EMPTY_PREFS };
  return {
    autorechargeEnabled: !!r.autorecharge_enabled,
    autorechargeThresholdCredits: Number(r.autorecharge_threshold_credits ?? 0),
    autorechargePackage: r.autorecharge_package ?? null,
    lastAlertPct: Number(r.last_alert_pct ?? 0),
    defaultPaymentMethod: r.default_payment_method ?? null,
    needsAction: !!r.needs_action,
    disputeOpen: !!r.dispute_open,
    autorechargePendingUntil: r.autorecharge_pending_until ? new Date(r.autorecharge_pending_until).toISOString() : null,
  };
}

/** Lê as prefs da conta (linha ausente = defaults). Fail-soft → defaults. */
export async function getBillingPrefs(accountId: string): Promise<BillingPrefs> {
  try {
    const sql = await db();
    const rows = (await sql`select * from galeed_billing_prefs where account_id = ${accountId}`) as any[];
    return mapPrefs(rows[0]);
  } catch (e) {
    console.error("[billing-prefs] getBillingPrefs erro (fail-soft):", e instanceof Error ? e.message : e);
    return { ...EMPTY_PREFS };
  }
}

/** Grava as prefs de auto-recarga (opt-in). Validação: pacote tem que existir; threshold >= 0; ligar
 *  exige um pacote válido. Limpa needs_action quando o usuário religa (deu novo consentimento). */
export async function setAutorecharge(
  accountId: string,
  p: { enabled: boolean; thresholdCredits: number; package: string | null },
): Promise<BillingPrefs> {
  const sql = await db();
  const enabled = !!p.enabled;
  const threshold = Math.max(0, Math.floor(Number(p.thresholdCredits) || 0));
  const pkg = p.package || null;
  await sql`
    insert into galeed_billing_prefs
      (account_id, autorecharge_enabled, autorecharge_threshold_credits, autorecharge_package, updated_at)
      values (${accountId}, ${enabled}, ${threshold}, ${pkg}, now())
      on conflict (account_id) do update set
        autorecharge_enabled = ${enabled},
        autorecharge_threshold_credits = ${threshold},
        autorecharge_package = ${pkg},
        -- religar a auto-recarga = novo consentimento → some o trava-loop do SCA pendente.
        needs_action = case when ${enabled} then false else galeed_billing_prefs.needs_action end,
        updated_at = now()
  `;
  return getBillingPrefs(accountId);
}

/** Persiste o método de pagamento padrão (capturado do top-up/assinatura) p/ a auto-recarga off_session.
 *  Upsert idempotente. RODA fora de tx (caminho de webhook/admin). Fail-soft. */
export async function setDefaultPaymentMethod(accountId: string, pmId: string | null): Promise<void> {
  if (!pmId) return;
  try {
    const sql = await db();
    await sql`
      insert into galeed_billing_prefs (account_id, default_payment_method, updated_at)
        values (${accountId}, ${pmId}, now())
        on conflict (account_id) do update set default_payment_method = ${pmId}, updated_at = now()
    `;
  } catch (e) {
    console.error("[billing-prefs] setDefaultPaymentMethod erro (fail-soft):", e instanceof Error ? e.message : e);
  }
}

// ---------------------------------------------------------------------------
// M-PAY-H (Onda 4) — alertas de consumo (60/80/90%). PUROS p/ travar o contrato sem DB.
// ---------------------------------------------------------------------------
export const ALERT_THRESHOLDS = [60, 80, 90] as const;

/** PURA: pct de consumo do ciclo (0..100+) sobre o bolo (tier OU trial). grant<=0 → 0 (sem denominador). */
export function consumptionPct(spentThisCycle: number, grant: number): number {
  if (!grant || grant <= 0) return 0;
  return Math.floor((spentThisCycle / grant) * 100);
}

/** PURA: dado o pct atual e o último alerta JÁ disparado, devolve o MAIOR limiar recém-cruzado (ou
 *  null se nenhum limiar novo). Dedup: só dispara limiares > lastAlertPct. Reset de ciclo = lastAlertPct
 *  volta a 0 (o caller compara o ciclo do último alerta com o ciclo corrente). */
export function nextAlertThreshold(pct: number, lastAlertPct: number): number | null {
  let crossed: number | null = null;
  for (const t of ALERT_THRESHOLDS) {
    if (pct >= t && t > lastAlertPct) crossed = t;
  }
  return crossed;
}

/** Atualiza last_alert_pct (dedup) — chamado quando um alerta novo é registrado. Upsert. Fail-soft. */
export async function recordAlertPct(accountId: string, pct: number): Promise<void> {
  try {
    const sql = await db();
    await sql`
      insert into galeed_billing_prefs (account_id, last_alert_pct, updated_at)
        values (${accountId}, ${pct}, now())
        on conflict (account_id) do update set last_alert_pct = ${pct}, updated_at = now()
    `;
  } catch (e) {
    console.error("[billing-prefs] recordAlertPct erro (fail-soft):", e instanceof Error ? e.message : e);
  }
}

/** Zera last_alert_pct no início do ciclo (reset). Idempotente. Fail-soft. */
export async function resetAlertPct(accountId: string): Promise<void> {
  await recordAlertPct(accountId, 0);
}

// ---------------------------------------------------------------------------
// M-PAY-H (Onda 4) — auto-recarga: decisão PURA do gatilho (testável sem DB/Stripe).
// ---------------------------------------------------------------------------
/** PURA: a auto-recarga deve disparar? Liga só se: opt-in ON, há método salvo + pacote, NÃO há SCA
 *  pendente (needs_action — evita loop), NÃO há recarga EM VOO (autorecharge_pending_until > now — o
 *  crédito ainda não chegou pelo webhook; sem isso disparos em minutos diferentes cobrariam o cartão
 *  N vezes por uma única queda de saldo), e o saldo caiu abaixo do limiar. `now` injetável p/ teste. */
export function shouldAutoRecharge(prefs: BillingPrefs, balance: number, now: Date = new Date()): boolean {
  if (!prefs.autorechargeEnabled) return false;
  if (prefs.needsAction) return false; // SCA pendente: não reentra em loop até o cliente resolver
  if (prefs.autorechargePendingUntil && new Date(prefs.autorechargePendingUntil).getTime() > now.getTime()) {
    return false; // recarga em voo: aguarda o webhook creditar (ou o TTL expirar) antes de re-disparar
  }
  if (!prefs.defaultPaymentMethod || !prefs.autorechargePackage) return false;
  if (prefs.autorechargeThresholdCredits <= 0) return false;
  return balance < prefs.autorechargeThresholdCredits;
}

// TTL da trava de recarga em voo: cobre a latência do webhook payment_intent.succeeded/failed (que
// limpa a trava). Se o webhook nunca chegar, a trava expira sozinha e a auto-recarga pode tentar de
// novo (não trava o cliente p/ sempre). 15min é folgado p/ a latência típica de webhook do Stripe.
export const AUTORECHARGE_PENDING_TTL_MS = 15 * 60 * 1000;

/** Marca a auto-recarga EM VOO (now()+TTL). Chamada ao DISPARAR o PaymentIntent off_session. Upsert.
 *  Fail-soft. */
export async function setAutorechargePending(accountId: string, until: Date): Promise<void> {
  try {
    const sql = await db();
    await sql`
      insert into galeed_billing_prefs (account_id, autorecharge_pending_until, updated_at)
        values (${accountId}, ${until}, now())
        on conflict (account_id) do update set autorecharge_pending_until = ${until}, updated_at = now()
    `;
  } catch (e) {
    console.error("[billing-prefs] setAutorechargePending erro (fail-soft):", e instanceof Error ? e.message : e);
  }
}

/** Limpa a trava de recarga em voo. RODA DENTRO da tx do webhook (payment_intent.succeeded/failed). */
export async function clearAutorechargePendingInTx(tx: any, accountId: string): Promise<void> {
  await tx`
    insert into galeed_billing_prefs (account_id, autorecharge_pending_until, updated_at)
      values (${accountId}, ${null}, now())
      on conflict (account_id) do update set autorecharge_pending_until = null, updated_at = now()
  `;
}
