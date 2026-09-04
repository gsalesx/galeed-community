// M-PAY-H (Onda 3) — ENTITLEMENT de assinatura (dunning). Resolve se uma conta COM assinatura ainda
// pode usar ações pagas, separado do gate de CRÉDITO. Regra travada (contrato §Onda 3):
//   • sem assinatura            → reason 'none', entitled=true  (gate é SÓ por crédito; trial puro nunca
//                                  bloqueia por entitlement).
//   • active / trialing         → reason 'active', entitled=true.
//   • past_due + grace vigente  → reason 'grace', entitled=true (janela de 7d setada em payment_failed).
//   • past_due + grace NULL     → reason 'grace', entitled=true (corrida de webhook: subscription.updated
//                                  chegou antes do payment_failed que abre a janela; Smart Retries resolvem).
//   • past_due c/ grace vencida → reason 'lapsed', entitled=false.
//   • incomplete / incomplete_expired / paused (pré-ativação, nunca houve ciclo pago)
//                               → reason 'none', entitled=true (trial puro nunca bloqueia).
//   • unpaid / canceled         → reason 'lapsed', entitled=false.
// Fail-soft: erro de DB → entitled=true (disponibilidade > cobrança; igual ao fail-open do crédito).
import { getSharedSql, sharedSqlGeneration } from "./db-conn.ts";

export type EntitlementReason = "active" | "grace" | "lapsed" | "none";

export interface Entitlement {
  entitled: boolean;
  status: string | null; // status bruto da assinatura (active/past_due/unpaid/canceled/...) ou null
  graceUntil: string | null; // ISO da expiração da graça (só quando past_due em graça); null caso contrário
  reason: EntitlementReason;
}

/** PURA: decide o entitlement a partir do (status, grace_until) projetado. Testável → trava o contrato
 *  das transições sem tocar o DB. `now` injetável p/ testar a fronteira da graça. */
export function decideEntitlement(
  status: string | null,
  graceUntil: Date | null,
  now: Date = new Date(),
): Entitlement {
  // Sem assinatura: nunca bloqueia por entitlement (o trial puro segue só pelo crédito).
  if (!status) return { entitled: true, status: null, graceUntil: null, reason: "none" };
  if (status === "active" || status === "trialing") {
    return { entitled: true, status, graceUntil: null, reason: "active" };
  }
  if (status === "past_due") {
    // Em graça enquanto grace_until > now (a 1ª falha do ciclo abre a janela de 7d no webhook).
    if (graceUntil && graceUntil.getTime() > now.getTime()) {
      return { entitled: true, status, graceUntil: graceUntil.toISOString(), reason: "grace" };
    }
    // M-PAY-H (auditoria): past_due com grace_until NULL = a janela de graça AINDA não foi gravada. Isso
    // acontece numa CORRIDA de ordem de webhook: customer.subscription.updated (status→past_due) chegou
    // ANTES de invoice.payment_failed (que abre os 7d). Bloquear aqui derrubaria um cliente que DEVERIA
    // estar em graça. Tratamos grace-null como 'grace' (entitled): o Smart Retries do Stripe resolve (ou
    // o invoice.payment_failed atrasado grava a janela; ou o pagamento volta a 'active'). Só past_due com
    // grace_until VENCIDA (gravada e expirada) bloqueia.
    if (!graceUntil) {
      return { entitled: true, status, graceUntil: null, reason: "grace" };
    }
    return { entitled: false, status, graceUntil: graceUntil.toISOString(), reason: "lapsed" };
  }
  // Estados TRANSITÓRIOS pré-ativação (o Stripe Checkout em modo subscription CRIA a Subscription como
  // `incomplete` e dispara customer.subscription.created quando o 1º pagamento exige ação/SCA ou falha
  // inicialmente; `incomplete_expired` é o terminal disso ~23h depois; `paused` é uma assinatura sem
  // cobrança ativa). Nenhum desses representa uma cobrança paga que falhou DEPOIS de ativa — a conta
  // NUNCA teve um ciclo pago, então é efetivamente trial-puro: NÃO bloquear (segue só por crédito).
  // Decisão travada 2 (§Onda 3): trial puro nunca bloqueado por entitlement; tentar pagar e abandonar
  // não pode deixar o usuário PIOR do que não ter tentado. (auditoria R2)
  if (status === "incomplete" || status === "incomplete_expired" || status === "paused") {
    return { entitled: true, status, graceUntil: null, reason: "none" };
  }
  // unpaid / canceled / qualquer outro terminal pós-cobrança → bloqueia.
  return { entitled: false, status, graceUntil: null, reason: "lapsed" };
}

let _ready: Promise<void> | null = null;
let _gen = -1;
// Bootstrap idempotente das colunas que esta leitura consome (status, grace_until). A tabela em si é
// criada pelo boot do bff-stripe / migration runner; aqui só garantimos a coluna grace_until (migration
// 47) p/ caminhos que tocam o DB via getSharedSql sem rodar o runner.
async function db(): Promise<any> {
  const sql = await getSharedSql();
  const gen = sharedSqlGeneration();
  if (!_ready || _gen !== gen) {
    _gen = gen;
    _ready = sql.unsafe(`alter table galeed_subscriptions add column if not exists grace_until timestamptz`).then(
      () => {},
      () => {}, // tabela ainda não existe (conta sem billing) → no-op; a leitura abaixo trata ausência.
    );
  }
  await _ready;
  return sql;
}

/** Entitlement resolvido a partir do BRAIN do token (bordas pagas do gateway /v1). Resolve o owner
 *  do brain EXATAMENTE como o gateAndDebit (ownerOfBrain) p/ paridade débito↔gate, e checa o
 *  entitlement da conta dona. Brain sem owner (CLI/admin) → entitled (segue só pelo crédito), igual
 *  ao caminho permissivo do débito. Fail-soft via accountEntitlement. */
export async function assertEntitledByBrain(brain: string): Promise<Entitlement> {
  const { ownerOfBrain } = await import("./credits.ts");
  const accountId = await ownerOfBrain(brain);
  if (!accountId) return { entitled: true, status: null, graceUntil: null, reason: "none" };
  return accountEntitlement(accountId);
}

/** Entitlement da conta (lê a projeção local de galeed_subscriptions). Fail-soft → entitled. */
export async function accountEntitlement(accountId: string): Promise<Entitlement> {
  try {
    const sql = await db();
    const rows = (await sql`
      select status, grace_until from galeed_subscriptions where account_id = ${accountId}
    `) as any[];
    if (rows.length === 0) return { entitled: true, status: null, graceUntil: null, reason: "none" };
    const graceUntil = rows[0].grace_until ? new Date(rows[0].grace_until) : null;
    return decideEntitlement(rows[0].status ?? null, graceUntil);
  } catch (e) {
    console.error("[entitlement] accountEntitlement erro (fail-soft → entitled):", e instanceof Error ? e.message : e);
    return { entitled: true, status: null, graceUntil: null, reason: "none" };
  }
}
