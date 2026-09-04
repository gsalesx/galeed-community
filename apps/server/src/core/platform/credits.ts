// M-PAY-C — ledger de créditos: fonte da verdade do SALDO no Postgres do Galeed (gate síncrono <5ms).
// Stripe só MOVE dinheiro (assinatura → grant; webhook em bff-stripe). Aqui: gate+débito por operação
// de VALOR (ask/ingest/capture — NÃO por chamada de LLM), e o grant do bolo do tier.
//
// Backward-compatible / fail-soft: brain SEM conta dona (CLI/admin) ou conta SEM carteira (não-billada)
// → PERMISSIVO. Erro de DB → fail-OPEN (disponibilidade > cobrança estrita; kill-switch de COGS em
// cost-quota.ts é o backstop). Carteira por CONTA (o bolo do tier é compartilhado entre os brains).
//
// Idempotência (revisão): se o caller passa uma idemKey (ex.: header Idempotency-Key / id do turno),
// retry com a MESMA chave NÃO debita 2x. Sem chave → uuid por chamada (cada request debita 1×).
// Invariante de não-negatividade garantido em 2 camadas: `where balance >= cost` no UPDATE + a
// constraint `check (balance >= 0)` no schema.
import { randomUUID } from "node:crypto";
import { getSharedSql, sharedSqlGeneration } from "./db-conn.ts";
import { tierDef } from "./stripe.ts";
import { consumptionPct as computeConsumptionPct, nextAlertThreshold, getBillingPrefs, recordAlertPct } from "./billing-prefs.ts";

// Conversão operação→créditos (BP §4.2). facts/timeline/graph/stats = 0 (nunca gateados).
// `capture`: RESERVADO — NÃO-GATEADO HOJE (ver bloco de COBERTURA abaixo). Mantido na tabela para o dia
// que houver um caminho de capture cobrado diretamente; nenhuma borda chama gateAndDebit(...,"capture").
export const CREDIT_COST: Record<string, number> = { ask: 6, ingest: 30, capture: 2 };

// ── COBERTURA DE DÉBITO (M-PAY-H Onda 6 + auditoria) — onde o crédito é (e NÃO é) debitado ───────────
// O débito de uso acontece UMA vez, na BORDA HTTP, no enqueue:
//   • ask     → gateAndDebit no `/api/ask` (e `/api/ask/stream`) — web-server.ts.
//   • ingest  → gateAndDebit no `/api/ingest` (NO ENQUEUE) — web-server.ts.
// CAPTURE não tem gate HTTP próprio. capture() roda em DOIS lugares e NENHUM chama gateAndDebit:
//   1) WORKER de ingestão (process-blob-job → capture, via doc/connector): JÁ COBRADO no enqueue de
//      `/api/ingest` (30cr). Debitar de novo no capture do worker duplicaria o custo (e o retry do
//      worker re-debitaria). O débito é do request que ENFILEIRA, nunca do consumidor da fila.
//   2) CAMINHO INTERNO: o conector universal `ingest-server.ts` (POST /ingest, auth por INGEST_TOKEN) e
//      o CLI/MCP chamam capture() do core DIRETO, sem a borda HTTP billada. É NÃO COBRADO — decisão
//      consciente: tráfego de conector/operação interna, não consumo de cliente da carteira.
// Por isso CREDIT_COST.capture é RESERVADO (definido, mas sem gate ativo). O reconciliador (Onda 6)
// confere a integridade desse modelo: sum(ledger.delta) == wallet.balance.

// Créditos de boas-vindas (teste sem cartão). Denominador do anel de saldo quando a conta não tem
// assinatura ativa (com assinatura, o denominador é o bolo do tier, via tierDef).
export const TRIAL_GRANT = 1000;

/** Self-host/community: billing só existe COM Stripe configurado. Sem STRIPE_SECRET_KEY não há como
 *  recarregar/assinar — cobrar créditos seria um beco sem saída (trial expira e a conta morre em 402).
 *  Então: sem a key o gate é permissivo e o signup não cria carteira. `GALEED_BILLING=off` desliga
 *  explicitamente mesmo com a key presente (ex.: staging com Stripe no env mas sem cobrança). */
export function billingEnabled(): boolean {
  if (process.env.GALEED_BILLING === "off") return false;
  return !!process.env.STRIPE_SECRET_KEY;
}

// DDL canônica (espelhada na migration 39 + check via migration 40). Saldo materializado + razão
// append-only idempotente. A constraint de não-negatividade vive no schema (defesa em profundidade).
export const CREDIT_DDL = `
  create table if not exists galeed_credit_wallet (
    account_id text primary key,
    balance    bigint not null default 0,
    updated_at timestamptz not null default now(),
    constraint galeed_credit_wallet_balance_nonneg check (balance >= 0)
  );
  -- garante o check tambem em tabelas JA criadas sem ele (o create-if-not-exists acima nao adiciona).
  do $$ begin
    if not exists (select 1 from pg_constraint where conname = 'galeed_credit_wallet_balance_nonneg') then
      alter table galeed_credit_wallet add constraint galeed_credit_wallet_balance_nonneg check (balance >= 0);
    end if;
  end $$;
  -- M-PAY-H (migration 46): expiração de trial. trial_remaining = parte de balance que expira;
  -- trial_expires_at = quando expira. balance segue sendo o TOTAL (trial + pago, não expira).
  alter table galeed_credit_wallet add column if not exists trial_remaining bigint not null default 0;
  alter table galeed_credit_wallet add column if not exists trial_expires_at timestamptz;
  -- M-PAY-H/10 (migration 51): parcela PRÉ-PAGA do balance (top-up/auto-recarga avulsos). Análogo a
  -- trial_remaining: rastreia QUANTO do balance é dinheiro comprado pelo cliente. DECISÃO DO FUNDADOR:
  -- o pré-pago é GASTÁVEL mesmo com a assinatura lapsed (o gate de entitlement bloqueia o bolo da
  -- assinatura, mas NÃO confisca o que o cliente comprou avulso). Ordem de gasto: trial → bolo/monthly
  -- → topup por ÚLTIMO (preserva o pré-pago enquanto houver outro fundo); sob lapsed, o gate só
  -- permite gastar do topup. Invariante: 0 <= topup_remaining <= balance.
  alter table galeed_credit_wallet add column if not exists topup_remaining bigint not null default 0;
  create table if not exists galeed_credit_ledger (
    id              bigserial primary key,
    account_id      text not null,
    delta           bigint not null,
    bucket          text not null,
    reason          text not null,
    brain           text,
    op              text,
    stripe_event_id text,
    idempotency_key text not null,
    created_at      timestamptz not null default now()
  );
  create unique index if not exists galeed_credit_ledger_idem on galeed_credit_ledger (account_id, idempotency_key);
  -- stripe_event_id é só AUDITORIA (a idempotência é por (account_id, idempotency_key)); índice
  -- NÃO-único p/ um mesmo event_id poder gerar >1 linha (ex.: grant + clawback) sem colidir.
  create index if not exists galeed_credit_ledger_evt on galeed_credit_ledger (stripe_event_id) where stripe_event_id is not null;
  create index if not exists galeed_credit_ledger_acct on galeed_credit_ledger (account_id, created_at desc);
  -- M-PAY-H (migration 46): rastro do grant que expira (trial). Índice parcial p/ varredura barata.
  alter table galeed_credit_ledger add column if not exists expires_at timestamptz;
  create index if not exists galeed_credit_ledger_expires on galeed_credit_ledger (expires_at) where expires_at is not null;
  -- M-PAY: teto de gasto por CONTA. limit em CRÉDITOS (UI mostra R$ = créditos × R$0,02). kill_switch
  -- on = ao bater o teto no ciclo (mês corrente), o gate pausa jogar/perguntar. GLOBAL (fora do RLS).
  create table if not exists galeed_spend_cap (
    account_id    text primary key,
    enabled       boolean not null default false,
    kill_switch   boolean not null default true,
    limit_credits bigint not null default 0,
    updated_at    timestamptz not null default now()
  );
`;

// Sentinela: saldo insuficiente faz ROLLBACK da claim (a chave não é consumida → retry futuro com
// mais saldo pode passar) sem virar "erro" (que cairia no fail-open).
class InsufficientBalance extends Error {}

let _ready: Promise<void> | null = null;
let _gen = -1;
async function db(): Promise<any> {
  const sql = await getSharedSql();
  const gen = sharedSqlGeneration();
  if (!_ready || _gen !== gen) {
    _gen = gen;
    _ready = sql.unsafe(CREDIT_DDL);
  }
  await _ready;
  return sql;
}

/** Conta DONA do brain. ORDER BY p/ ser DETERMINÍSTICO se (por bug) houver >1 owner — nunca oscila
 *  a conta cobrada. (O schema não impõe 1 owner/brain; a ordem estável é a defesa do código.) */
async function ownerAccount(sql: any, brain: string): Promise<string | null> {
  const rows = (await sql`
    select account_id from galeed_account_brains
    where brain = ${brain} and role = 'owner' order by account_id limit 1
  `) as any[];
  return rows[0]?.account_id ?? null;
}

/** Conta DONA do brain (mesma resolução determinística que o débito usa). Exposta p/ o gate de
 *  entitlement das bordas pagas resolver o owner EXATAMENTE como o gateAndDebit (paridade débito↔gate).
 *  null = brain sem owner (CLI/admin) ou erro de DB (fail-soft → o caller trata como não-gateado). */
export async function ownerOfBrain(brain: string): Promise<string | null> {
  try {
    const sql = await db();
    return await ownerAccount(sql, brain);
  } catch (e) {
    console.error("[credits] ownerOfBrain erro (fail-soft):", e instanceof Error ? e.message : e);
    return null;
  }
}

export interface GateResult {
  ok: boolean; // true = pode servir (debitado/idempotente OU não-billado); false = saldo insuficiente (402)
  balance: number | null; // saldo restante (null = não-billado/permissivo)
  gated: boolean; // a conta tem carteira (foi efetivamente cobrada)?
  capHit?: boolean; // false por teto de gasto (não por saldo) — a UI mostra "teto atingido", não "recarregue"
}

/** Gate síncrono + débito ATÔMICO e IDEMPOTENTE por operação de valor. cost 0 → passa livre. Conta
 *  sem carteira → permissivo. Saldo insuficiente → ok:false (402). idemKey opcional: retry com a
 *  mesma chave não re-debita (reusa o saldo). Race-free: `update ... where balance >= cost` trava a
 *  linha; com o `check (balance >= 0)` no schema, nunca fica negativo.
 *
 *  ORDEM DE GASTO (mesma tx atômica): trial_remaining → restante NÃO-topup (monthly/bolo) →
 *  topup_remaining por ÚLTIMO. Preserva o crédito PRÉ-PAGO enquanto houver outro fundo (DECISÃO DO
 *  FUNDADOR M-PAY-H/10): o pré-pago é o único fundo gastável com a assinatura LAPSED, então não o
 *  queimamos antes do bolo da assinatura.
 *
 *  `opts.onlyTopup` = true (passado pela borda quando a conta está LAPSED): o débito SÓ pode sair do
 *  topup_remaining (o fundo não-topup é o bolo da assinatura, que está bloqueado). A guarda vira
 *  `where topup_remaining >= cost` — se o pré-pago não cobre, ok:false e nada é debitado. */
export async function gateAndDebit(
  brain: string,
  cost: number,
  op: string,
  idemKey?: string,
  opts?: { onlyTopup?: boolean },
): Promise<GateResult> {
  if (!cost || cost <= 0) return { ok: true, balance: null, gated: false };
  if (!billingEnabled()) return { ok: true, balance: null, gated: false }; // self-host sem Stripe: nunca cobra

  try {
    const sql = await db();
    const accountId = await ownerAccount(sql, brain);
    if (!accountId) return { ok: true, balance: null, gated: false };
    // M-PAY-H (Onda 2): expira o trial vencido ANTES do gate (lazy) — saldo/teto já refletem o zerado.
    await sql.begin((tx: any) => expireTrialInTx(tx, accountId));
    const w = (await sql`select 1 from galeed_credit_wallet where account_id = ${accountId}`) as any[];
    if (w.length === 0) return { ok: true, balance: null, gated: false }; // não-billado

    // Teto de gasto (M-PAY): com kill-switch ligado, se o gasto do CICLO (mês corrente) + este custo
    // passar do teto, PAUSA antes de debitar (não reivindica a chave). Lookup por PK; a soma só roda
    // quando o teto está ligado (custo extra ~0 no caso comum sem teto).
    const cap = (await sql`select kill_switch, limit_credits from galeed_spend_cap where account_id = ${accountId} and enabled = true`) as any[];
    if (cap[0]?.kill_switch) {
      const cs = (await sql`
        select coalesce(sum(-delta), 0)::bigint s from galeed_credit_ledger
        where account_id = ${accountId} and delta < 0 and created_at >= date_trunc('month', now())
      `) as any[];
      if (Number(cs[0]?.s ?? 0) + cost > Number(cap[0].limit_credits)) {
        const bal = (await sql`select balance from galeed_credit_wallet where account_id = ${accountId}`) as any[];
        return { ok: false, balance: Number(bal[0]?.balance ?? 0), gated: true, capHit: true };
      }
    }

    const key = idemKey || randomUUID();
    let result: GateResult = { ok: false, balance: 0, gated: true };
    try {
      await sql.begin(async (tx: any) => {
        // 1) reivindica a chave de idempotência (a linha do ledger). Já reivindicada → já debitado.
        const claim = (await tx`
          insert into galeed_credit_ledger (account_id, delta, bucket, reason, brain, op, idempotency_key)
          values (${accountId}, ${-cost}, 'usage', ${"usage_" + op}, ${brain}, ${op}, ${key})
          on conflict (account_id, idempotency_key) do nothing returning id
        `) as any[];
        if (claim.length === 0) {
          const cur = (await tx`select balance from galeed_credit_wallet where account_id = ${accountId}`) as any[];
          result = { ok: true, balance: Number(cur[0]?.balance ?? 0), gated: true }; // retry idempotente
          return;
        }
        // 2) aplica o débito à carteira com a guarda de não-negatividade. `balance` é o TOTAL (trial +
        // bolo/monthly + topup); cai por inteiro. Decrementamos as PARCELAS na ordem de gasto:
        //   • onlyTopup (conta LAPSED): SÓ do topup_remaining. O fundo não-topup é o bolo da assinatura,
        //     bloqueado pelo entitlement; a borda já garantiu topup_remaining >= cost. Guarda
        //     `topup_remaining >= cost` (e balance >= cost por construção). trial NÃO é tocado.
        //   • normal (ENTITLED): trial PRIMEIRO, depois bolo/monthly, topup por ÚLTIMO — preserva o
        //     pré-pago enquanto houver outro fundo (decisão do fundador M-PAY-H/10). A parcela que sai
        //     do topup = max(0, custo_após_trial − (balance − trial_remaining − topup_remaining)).
        const deb = opts?.onlyTopup
          ? ((await tx`
              update galeed_credit_wallet set
                balance = balance - ${cost},
                topup_remaining = greatest(0, topup_remaining - ${cost}),
                updated_at = now()
              where account_id = ${accountId} and balance >= ${cost} and topup_remaining >= ${cost}
              returning balance
            `) as any[])
          : ((await tx`
              update galeed_credit_wallet set
                balance = balance - ${cost},
                trial_remaining = greatest(0, trial_remaining - least(trial_remaining, ${cost})),
                topup_remaining = greatest(0, topup_remaining - greatest(0,
                  greatest(0, ${cost} - least(trial_remaining, ${cost}))
                    - greatest(0, balance - trial_remaining - topup_remaining)
                )),
                updated_at = now()
              where account_id = ${accountId} and balance >= ${cost} returning balance
            `) as any[]);
        if (deb.length === 0) {
          const cur = (await tx`select balance from galeed_credit_wallet where account_id = ${accountId}`) as any[];
          result = { ok: false, balance: Number(cur[0]?.balance ?? 0), gated: true };
          throw new InsufficientBalance(); // rollback da claim → chave livre p/ retry futuro
        }
        result = { ok: true, balance: Number(deb[0].balance), gated: true };
      });
    } catch (e) {
      if (!(e instanceof InsufficientBalance)) throw e; // erro real → fail-open no catch externo
    }
    // M-PAY-H (Onda 4) — AUTO-RECARGA best-effort: após um débito que reduziu o saldo, se a conta
    // tem opt-in e o saldo caiu abaixo do limiar, dispara um PaymentIntent off_session. FORA da
    // transação do débito (nunca bloqueia a ação): fire-and-forget, fail-soft. Import dinâmico p/ não
    // criar dependência estática credits→bff-stripe (bff-stripe já importa credits).
    if (result.ok && result.gated && typeof result.balance === "number") {
      const bal = result.balance;
      import("../../connectors/bff/bff-stripe.ts")
        .then((m) => m.maybeAutoRecharge(accountId, bal))
        .catch((e) => console.error("[credits] auto-recarga (fail-soft):", e instanceof Error ? e.message : e));
    }
    return result;
  } catch (e) {
    console.error("[credits] gateAndDebit erro (fail-open):", e instanceof Error ? e.message : e);
    return { ok: true, balance: null, gated: false };
  }
}

// M-PAY-H (Onda 2) — janela do trial. Conta nova ganha TRIAL_GRANT créditos no bucket `trial`, com
// expiração em 14 dias; ao expirar, o que sobrou é zerado e a conta vira read-only (sem assinatura).
export const TRIAL_DAYS = 14;

/** Concede o trial de boas-vindas no CADASTRO (idempotente por conta). Cria a carteira se não existir
 *  — a conta nova passa a TER carteira (deixa de cair no caminho permissivo "não-billado" do gate),
 *  credita +TRIAL_GRANT no bucket `trial`, marca `trial_remaining` e `trial_expires_at=now()+14d`.
 *  Fail-soft: erro de DB não derruba o signup (só loga; a conta segue criada). */
export async function grantTrial(accountId: string): Promise<void> {
  if (!billingEnabled()) return; // sem billing não há carteira: a conta segue no caminho não-billado
  try {
    const sql = await db();
    const key = "trial:" + accountId;
    const expiresAt = new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000);
    await sql.begin(async (tx: any) => {
      // 1) reivindica a chave do grant (idempotente): retry/2º signup não credita 2×.
      const ins = (await tx`
        insert into galeed_credit_ledger (account_id, delta, bucket, reason, idempotency_key, expires_at)
        values (${accountId}, ${TRIAL_GRANT}, 'trial', 'trial_grant', ${key}, ${expiresAt})
        on conflict (account_id, idempotency_key) do nothing returning id
      `) as any[];
      if (ins.length === 0) return; // já concedido → no-op
      // 2) cria/credita a carteira e marca o bucket que expira.
      await tx`
        insert into galeed_credit_wallet (account_id, balance, trial_remaining, trial_expires_at)
        values (${accountId}, ${TRIAL_GRANT}, ${TRIAL_GRANT}, ${expiresAt})
        on conflict (account_id) do update set
          balance = galeed_credit_wallet.balance + ${TRIAL_GRANT},
          trial_remaining = galeed_credit_wallet.trial_remaining + ${TRIAL_GRANT},
          trial_expires_at = ${expiresAt}, updated_at = now()
      `;
    });
  } catch (e) {
    console.error("[credits] grantTrial erro (fail-soft):", e instanceof Error ? e.message : e);
  }
}

/** Expiração LAZY do trial (sem cron): se o trial venceu e ainda há saldo de trial, posta um débito do
 *  `trial_remaining` (bucket `trial_expire`, idempotente) e zera `trial_remaining`. O `balance` cai
 *  junto (o trial é parte dele). Barato: só toca o DB quando há trial a expirar. RODA DENTRO de uma
 *  tx (passada pelo caller) para serializar com o débito concorrente. */
async function expireTrialInTx(tx: any, accountId: string): Promise<void> {
  const w = (await tx`
    select trial_remaining, trial_expires_at from galeed_credit_wallet
    where account_id = ${accountId} for update
  `) as any[];
  const remaining = Number(w[0]?.trial_remaining ?? 0);
  const expiresAt = w[0]?.trial_expires_at ? new Date(w[0].trial_expires_at) : null;
  if (remaining <= 0 || !expiresAt || expiresAt.getTime() > Date.now()) return; // nada a expirar
  // idempotente: a chave carrega o ms da expiração (uma expiração por janela; um novo trial reabre).
  const key = "trial-expire:" + accountId + ":" + expiresAt.getTime();
  const ins = (await tx`
    insert into galeed_credit_ledger (account_id, delta, bucket, reason, idempotency_key)
    values (${accountId}, ${-remaining}, 'trial_expire', 'trial_expired', ${key})
    on conflict (account_id, idempotency_key) do nothing returning id
  `) as any[];
  if (ins.length === 0) return; // já expirado → no-op
  await tx`
    update galeed_credit_wallet
    set balance = greatest(0, balance - ${remaining}), trial_remaining = 0, updated_at = now()
    where account_id = ${accountId}
  `;
}

/** Wrapper transacional do expirar-lazy (chamado fora de uma tx aberta: gate/leitura). Fail-soft. */
export async function expireTrialIfNeeded(accountId: string): Promise<void> {
  try {
    const sql = await db();
    await sql.begin((tx: any) => expireTrialInTx(tx, accountId));
  } catch (e) {
    console.error("[credits] expireTrialIfNeeded erro (fail-soft):", e instanceof Error ? e.message : e);
  }
}

// 1 crédito = R$ 0,02 → unit_amount em centavos de BRL = créditos × 2.
export const CENTAVOS_PER_CREDIT = 2;

// Pacotes de top-up avulso (compra única). Preço derivado de CENTAVOS_PER_CREDIT.
export const TOPUP_PACKAGES: { id: string; credits: number }[] = [
  { id: "cr2500", credits: 2500 },
  { id: "cr10000", credits: 10000 },
  { id: "cr50000", credits: 50000 },
];
export function topupPackage(id: string): { id: string; credits: number } | undefined {
  return TOPUP_PACKAGES.find((p) => p.id === id);
}

/** Concede créditos (genérico, qualquer bucket), idempotente por (account_id, idempotency_key). RODA
 *  DENTRO de uma transação (tx). Usado por grantTierCredits (assinatura) e pelo top-up/indicação. */
export async function grantCredits(
  tx: any,
  accountId: string,
  amount: number,
  bucket: string,
  reason: string,
  idempotencyKey: string,
  stripeEventId?: string,
): Promise<number> {
  if (!amount || amount <= 0) return 0;
  const ins = (await tx`
    insert into galeed_credit_ledger (account_id, delta, bucket, reason, stripe_event_id, idempotency_key)
    values (${accountId}, ${amount}, ${bucket}, ${reason}, ${stripeEventId ?? null}, ${idempotencyKey})
    on conflict (account_id, idempotency_key) do nothing returning id
  `) as any[];
  if (ins.length === 0) return 0; // já concedido → no-op
  // M-PAY-H/10: buckets PRÉ-PAGOS (top-up/auto-recarga) também incrementam topup_remaining — a parcela
  // do balance gastável mesmo sob lapsed. trial/monthly/referral/reconcile NÃO tocam topup_remaining.
  const isTopup = bucket === "topup" || bucket === "autorecharge";
  await tx`
    insert into galeed_credit_wallet (account_id, balance, topup_remaining)
    values (${accountId}, ${amount}, ${isTopup ? amount : 0})
    on conflict (account_id) do update set
      balance = galeed_credit_wallet.balance + ${amount},
      topup_remaining = galeed_credit_wallet.topup_remaining + ${isTopup ? amount : 0},
      updated_at = now()
  `;
  return amount;
}

/** Concede o bolo mensal do tier. Idempotência por PERÍODO de cobrança (não por event_id): a chave é
 *  `grant:<subscriptionId>:<periodStart>` quando o caller resolve o ciclo — assim múltiplas faturas
 *  pagas no MESMO ciclo (ex.: subscription_update/proration emitindo invoice.paid extra com event_id
 *  novo) concedem UM ÚNICO bolo. Fallback `grant:<eventId>` só quando o ciclo não pôde ser resolvido
 *  (preserva o comportamento antigo p/ não perder o 1º bolo). `tier` resolvido pelo caller. */
export async function grantTierCredits(
  tx: any,
  accountId: string,
  eventId: string,
  tier?: string | null,
  periodKey?: string | null,
): Promise<number> {
  const def = tier ? tierDef(tier) : undefined;
  if (!def) {
    console.warn(`[credits] grant sem tier resolvido p/ conta ${accountId} (evento ${eventId}) — ignorado.`);
    return 0;
  }
  const idemKey = periodKey ? "grant:" + periodKey : "grant:" + eventId;
  return grantCredits(tx, accountId, def.credits, "monthly", "subscription_grant", idemKey, eventId);
}

/** M-PAY-D — estorna créditos de top-up no reembolso/chargeback. Cobra sobre o DELTA do reembolso, não
 *  o cumulativo (auditoria R3 #2): o Stripe entrega charge.amount_refunded ACUMULADO, então o caller
 *  passa `desiredCumulative` = créditos correspondentes ao total já reembolsado naquele charge/PI. AQUI
 *  somamos o que JÁ foi estornado no ledger para este PI (bucket 'topup_refund' do mesmo PI) e debitamos
 *  só a diferença `desiredCumulative - jaEstornado`. Assim 2 reembolsos parciais (30% depois 60% cum.)
 *  removem 300 e depois +300 (total 600), nunca 300+600=900. Idempotência por (PI, cumulativo): a chave
 *  carrega o `desiredCumulative` → reentrega do MESMO evento (mesmo cumulativo) é no-op; um cumulativo
 *  novo (estorno adicional) posta o delta. Debita só o que AINDA há (clamp >= 0; o resto pode já ter
 *  sido gasto). RODA DENTRO da tx do webhook (lock da carteira p/ serializar). */
export async function clawbackTopup(
  tx: any,
  accountId: string,
  desiredCumulative: number,
  eventId: string,
  paymentIntentId: string,
): Promise<number> {
  if (!desiredCumulative || desiredCumulative <= 0) return 0;
  const w = (await tx`select balance from galeed_credit_wallet where account_id = ${accountId} for update`) as any[];
  // já estornado p/ este PI (soma dos deltas negativos do bucket de refund que carregam o PI na chave).
  const prev = (await tx`
    select coalesce(sum(-delta), 0)::bigint s from galeed_credit_ledger
    where account_id = ${accountId} and bucket = 'topup_refund' and idempotency_key like ${"refund:" + paymentIntentId + ":%"}
  `) as any[];
  const alreadyClawed = Number(prev[0]?.s ?? 0);
  const deltaWanted = desiredCumulative - alreadyClawed; // só o INCREMENTO deste estorno
  if (deltaWanted <= 0) return 0; // nada novo a estornar (reentrega ou cumulativo não cresceu)
  const balance = Number(w[0]?.balance ?? 0);
  const removed = Math.min(deltaWanted, balance);
  // chave por (PI, cumulativo): idempotente p/ reentrega do mesmo cumulativo; permite delta novo.
  const key = "refund:" + paymentIntentId + ":" + desiredCumulative;
  const ins = (await tx`
    insert into galeed_credit_ledger (account_id, delta, bucket, reason, stripe_event_id, idempotency_key)
    values (${accountId}, ${-removed}, 'topup_refund', 'refund', ${eventId}, ${key})
    on conflict (account_id, idempotency_key) do nothing returning id
  `) as any[];
  if (ins.length === 0) return 0; // já estornado este cumulativo → no-op
  if (removed > 0) {
    // M-PAY-H/10: o estorno é de crédito PRÉ-PAGO → baixa topup_remaining junto (clamp >=0; o cliente
    // pode já ter GASTO parte do pré-pago, então topup_remaining < removed é possível).
    await tx`
      update galeed_credit_wallet set
        balance = balance - ${removed},
        topup_remaining = greatest(0, topup_remaining - ${removed}),
        updated_at = now()
      where account_id = ${accountId}
    `;
  }
  if (removed < deltaWanted) {
    console.warn(`[credits] estorno parcial conta ${accountId}: delta ${deltaWanted}cr, removido ${removed}cr (resto já gasto).`);
  }
  return removed;
}

/** M-PAY-H/10 — saldo PRÉ-PAGO (topup_remaining) da conta DONA do brain. Usado pelo gate de
 *  entitlement das bordas pagas: sob assinatura LAPSED, a ação só passa se o pré-pago cobre o custo
 *  (o bolo da assinatura está bloqueado, mas o que o cliente comprou avulso continua gastável).
 *  Resolve o owner EXATAMENTE como o gateAndDebit (paridade gate↔débito). null = brain sem owner
 *  (CLI/admin), conta sem carteira (não-billado) ou erro (fail-soft). Expira o trial vencido antes
 *  (lazy, igual ao gate) para o número refletir o estado pós-expiração. */
export async function topupRemainingOfBrain(brain: string): Promise<number | null> {
  try {
    const sql = await db();
    const accountId = await ownerAccount(sql, brain);
    if (!accountId) return null;
    await sql.begin((tx: any) => expireTrialInTx(tx, accountId));
    const rows = (await sql`select topup_remaining from galeed_credit_wallet where account_id = ${accountId}`) as any[];
    return rows[0] ? Number(rows[0].topup_remaining) : null;
  } catch (e) {
    console.error("[credits] topupRemainingOfBrain erro (fail-soft):", e instanceof Error ? e.message : e);
    return null;
  }
}

/** Saldo da conta (p/ display). null = sem carteira (não-billado) OU erro (logado). Fail-soft. */
export async function accountCreditBalance(accountId: string): Promise<{ balance: number | null }> {
  try {
    const sql = await db();
    const rows = (await sql`select balance from galeed_credit_wallet where account_id = ${accountId}`) as any[];
    return { balance: rows[0] ? Number(rows[0].balance) : null };
  } catch (e) {
    console.error("[credits] accountCreditBalance erro:", e instanceof Error ? e.message : e);
    return { balance: null };
  }
}

// ---------------------------------------------------------------------------
// Leitura p/ a tela Plano (M-PAY front): UMA query-set alimenta saldo+split, gráfico de consumo e
// histórico. Os "números" (grant/gasto) são computados AQUI (fonte canônica) — a UI só renderiza.
// ---------------------------------------------------------------------------
export interface LedgerEntry {
  id: number;
  delta: number; // <0 gasto, >0 ganho (recarga/bolo/boas-vindas)
  bucket: string;
  reason: string;
  brain: string | null;
  op: string | null; // ask | ingest | capture | null
  created_at: string; // ISO
}
export interface LedgerSummary {
  grant: number; // denominador do anel: bolo do tier (se assinado) ou TRIAL_GRANT
  balance: number | null;
  spentIngest: number; // gasto no CICLO (mês corrente), por op
  spentAsk: number;
  spentTotal: number;
  trialExpiresAt: string | null; // ISO — quando o trial expira (null = sem trial pendente)
  readOnly: boolean; // saldo 0 e sem assinatura ativa → conta em modo leitura (ações pagas bloqueiam)
  consumptionPct: number; // M-PAY-H (Onda 4) — % do bolo já consumido no ciclo (0..100+)
  alertPct: number; // M-PAY-H (Onda 4) — maior limiar de alerta JÁ disparado (0/60/80/90)
  topupRemaining: number; // M-PAY-H/10 — parcela PRÉ-PAGA do balance (gastável mesmo sob lapsed)
}
export interface LedgerView {
  summary: LedgerSummary;
  daily: { date: string; ing: number; ask: number }[]; // série dos últimos N dias (só dias com gasto)
  entries: LedgerEntry[]; // recentes (p/ o histórico)
}

const EMPTY_LEDGER: LedgerView = {
  summary: { grant: TRIAL_GRANT, balance: null, spentIngest: 0, spentAsk: 0, spentTotal: 0, trialExpiresAt: null, readOnly: false, consumptionPct: 0, alertPct: 0, topupRemaining: 0 },
  daily: [],
  entries: [],
};

/** M-PAY-H (Onda 4) — avalia o alerta de consumo (60/80/90%) e devolve o limiar de alerta vigente.
 *  Dedup via `last_alert_pct` das prefs; RESET de ciclo = quando o pct corrente cai ABAIXO do último
 *  alerta (início do mês zera o gasto → pct→0 < lastAlertPct), zera o marcador. In-app (sem SMTP): só
 *  registra o limiar; o front mostra o banner via `alertPct`/`consumptionPct`. Fail-soft. */
async function evaluateConsumptionAlert(accountId: string, pct: number): Promise<number> {
  try {
    const prefs = await getBillingPrefs(accountId);
    let last = prefs.lastAlertPct;
    // Reset de ciclo: o gasto reiniciou (pct caiu abaixo do limiar já alertado) → zera o marcador.
    if (pct < last) {
      await recordAlertPct(accountId, 0);
      last = 0;
    }
    const crossed = nextAlertThreshold(pct, last);
    if (crossed !== null) {
      await recordAlertPct(accountId, crossed);
      console.log(`[credits] alerta de consumo ${crossed}% conta ${accountId} (pct=${pct}).`);
      return crossed;
    }
    return last;
  } catch (e) {
    console.error("[credits] evaluateConsumptionAlert erro (fail-soft):", e instanceof Error ? e.message : e);
    return 0;
  }
}

/** Visão do ledger p/ a tela Plano. Fail-soft (erro → visão vazia). */
export async function listLedger(accountId: string, opts?: { limit?: number; days?: number }): Promise<LedgerView> {
  const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 200);
  const days = Math.min(Math.max(opts?.days ?? 30, 1), 90);
  try {
    const sql = await db();
    // M-PAY-H (Onda 2): expira o trial vencido antes de ler (a UI vê o saldo já zerado + read-only).
    await sql.begin((tx: any) => expireTrialInTx(tx, accountId));

    // denominador do anel: bolo do tier vigente (canônico via tierDef); senão o teste.
    const sub = (await sql`select tier, status from galeed_subscriptions where account_id = ${accountId}`) as any[];
    const active = sub[0] && ["active", "trialing"].includes(sub[0].status);
    const def = active ? tierDef(sub[0].tier) : undefined;
    const grant = def?.credits ?? TRIAL_GRANT;

    const wallet = (await sql`select balance, trial_expires_at, topup_remaining from galeed_credit_wallet where account_id = ${accountId}`) as any[];
    const balance = wallet[0] ? Number(wallet[0].balance) : null;
    const trialExpiresAt = wallet[0]?.trial_expires_at ? new Date(wallet[0].trial_expires_at).toISOString() : null;
    const topupRemaining = wallet[0] ? Number(wallet[0].topup_remaining) : 0; // M-PAY-H/10 — pré-pago
    // read-only: saldo zerado e SEM assinatura ativa → ações pagas (ask/ingest/capture) bloqueiam.
    const readOnly = balance === 0 && !active;

    const spend = (await sql`
      select
        coalesce(sum(case when op = 'ingest' then -delta else 0 end), 0)::bigint ing,
        coalesce(sum(case when op = 'ask'    then -delta else 0 end), 0)::bigint ask,
        coalesce(sum(-delta), 0)::bigint tot
      from galeed_credit_ledger
      where account_id = ${accountId} and delta < 0 and created_at >= date_trunc('month', now())
    `) as any[];

    const daily = (await sql`
      select to_char(date_trunc('day', created_at), 'YYYY-MM-DD') as date,
        coalesce(sum(case when op = 'ingest' then -delta else 0 end), 0)::bigint ing,
        coalesce(sum(case when op = 'ask'    then -delta else 0 end), 0)::bigint ask
      from galeed_credit_ledger
      where account_id = ${accountId} and delta < 0 and created_at >= now() - make_interval(days => ${days})
      group by 1 order by 1
    `) as any[];

    const entries = (await sql`
      select id, delta, bucket, reason, brain, op,
        to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as created_at
      from galeed_credit_ledger where account_id = ${accountId}
      order by created_at desc limit ${limit}
    `) as any[];

    const spentTotal = Number(spend[0]?.tot ?? 0);
    // M-PAY-H (Onda 4) — pct de consumo do ciclo sobre o bolo + alerta de limiar (60/80/90%, dedup).
    const pct = computeConsumptionPct(spentTotal, grant);
    const alertPct = await evaluateConsumptionAlert(accountId, pct);

    return {
      summary: {
        grant,
        balance,
        spentIngest: Number(spend[0]?.ing ?? 0),
        spentAsk: Number(spend[0]?.ask ?? 0),
        spentTotal,
        trialExpiresAt,
        readOnly,
        consumptionPct: pct,
        alertPct,
        topupRemaining,
      },
      daily: daily.map((d) => ({ date: d.date, ing: Number(d.ing), ask: Number(d.ask) })),
      entries: entries.map((e) => ({
        id: Number(e.id),
        delta: Number(e.delta),
        bucket: e.bucket,
        reason: e.reason,
        brain: e.brain ?? null,
        op: e.op ?? null,
        created_at: e.created_at,
      })),
    };
  } catch (e) {
    console.error("[credits] listLedger erro:", e instanceof Error ? e.message : e);
    return EMPTY_LEDGER;
  }
}

// ---------------------------------------------------------------------------
// Teto de gasto (M-PAY): limite por CONTA em créditos + gasto do ciclo (mês). Enforce no gateAndDebit.
// ---------------------------------------------------------------------------
export interface SpendCap {
  enabled: boolean;
  killSwitch: boolean;
  limitCredits: number;
  cycleSpentCredits: number; // gasto no mês corrente (p/ o medidor)
  trialExpiresAt: string | null; // M-PAY-H — ISO da expiração do trial (null = sem trial pendente)
  readOnly: boolean; // M-PAY-H — saldo 0 e sem assinatura ativa → conta em modo leitura
  topupRemaining: number; // M-PAY-H/10 — parcela PRÉ-PAGA do balance (gastável mesmo sob lapsed)
}

/** Lê o teto + o gasto do ciclo. Fail-soft (erro → teto desligado). */
export async function getSpendCap(accountId: string): Promise<SpendCap> {
  try {
    const sql = await db();
    // M-PAY-H (Onda 2): expira o trial vencido antes de ler o estado (read-only reflete o zerado).
    await sql.begin((tx: any) => expireTrialInTx(tx, accountId));
    const rows = (await sql`select enabled, kill_switch, limit_credits from galeed_spend_cap where account_id = ${accountId}`) as any[];
    const cs = (await sql`
      select coalesce(sum(-delta), 0)::bigint s from galeed_credit_ledger
      where account_id = ${accountId} and delta < 0 and created_at >= date_trunc('month', now())
    `) as any[];
    const wallet = (await sql`select balance, trial_expires_at, topup_remaining from galeed_credit_wallet where account_id = ${accountId}`) as any[];
    const sub = (await sql`select status from galeed_subscriptions where account_id = ${accountId}`) as any[];
    const active = sub[0] && ["active", "trialing"].includes(sub[0].status);
    const balance = wallet[0] ? Number(wallet[0].balance) : null;
    const r = rows[0];
    return {
      enabled: !!r?.enabled,
      killSwitch: r ? !!r.kill_switch : true,
      limitCredits: Number(r?.limit_credits ?? 0),
      cycleSpentCredits: Number(cs[0]?.s ?? 0),
      trialExpiresAt: wallet[0]?.trial_expires_at ? new Date(wallet[0].trial_expires_at).toISOString() : null,
      readOnly: balance === 0 && !active,
      topupRemaining: wallet[0] ? Number(wallet[0].topup_remaining) : 0,
    };
  } catch (e) {
    console.error("[credits] getSpendCap erro:", e instanceof Error ? e.message : e);
    return { enabled: false, killSwitch: true, limitCredits: 0, cycleSpentCredits: 0, trialExpiresAt: null, readOnly: false, topupRemaining: 0 };
  }
}

/** Grava o teto (upsert). limitCredits clampado >= 0. Retorna o estado já com o gasto do ciclo. */
export async function setSpendCap(
  accountId: string,
  p: { enabled: boolean; killSwitch: boolean; limitCredits: number },
): Promise<SpendCap> {
  const sql = await db();
  const limit = Math.max(0, Math.floor(Number(p.limitCredits) || 0));
  await sql`
    insert into galeed_spend_cap (account_id, enabled, kill_switch, limit_credits, updated_at)
    values (${accountId}, ${!!p.enabled}, ${!!p.killSwitch}, ${limit}, now())
    on conflict (account_id) do update set
      enabled = excluded.enabled, kill_switch = excluded.kill_switch,
      limit_credits = excluded.limit_credits, updated_at = now()
  `;
  return getSpendCap(accountId);
}

// ---------------------------------------------------------------------------
// M-PAY-H (Onda 6) — RECONCILIAÇÃO do ledger. INVARIANTE de dinheiro: o saldo materializado
// (`galeed_credit_wallet.balance`) DEVE ser igual a `sum(galeed_credit_ledger.delta)` por conta (o
// razão é append-only; a carteira é a projeção que o gate lê <5ms). E `trial_remaining` DEVE ser
// consistente com os buckets de trial (grant `trial` menos o que já foi gasto/expirado), nunca acima
// do `balance`. Este job CONFERE e RELATA drift; com `--repair` CASA a carteira ao razão (fonte da
// verdade): `balance = sum(ledger.delta)`. NÃO roda em request path (é CLI/job, fora da borda).
// ---------------------------------------------------------------------------
export interface WalletDrift {
  accountId: string;
  balance: number; // saldo materializado (carteira)
  ledgerSum: number; // soma do razão (verdade append-only)
  balanceDrift: number; // balance - ledgerSum (0 = consistente)
  trialRemaining: number; // trial_remaining materializado
  trialExpected: number; // trial vivo esperado pelo razão (grant - gasto/expiração de trial)
  trialDrift: number; // trial_remaining - trialExpected (0 = consistente)
  trialOverBalance: boolean; // trial_remaining > balance (inconsistência sempre inválida)
  consistent: boolean; // balanceDrift==0 && trialDrift==0 && !trialOverBalance
}
export interface ReconcileReport {
  walletsChecked: number;
  drifted: WalletDrift[]; // só as carteiras com divergência (consistent=false)
  repaired: number; // nº de ajustes postados (0 se sem --repair)
}

/** Avalia uma carteira a partir das somas do razão (PURA — testável sem DB). `trialExpected` = soma
 *  dos deltas dos buckets de trial (`trial` grant + `trial_expire`/`usage` que tocaram o trial). Como o
 *  razão não marca QUAL gasto saiu do trial (trial-first é só na carteira), usamos a regra documentada:
 *  o trial vivo esperado nunca é negativo e nunca passa do saldo total — então clampamos
 *  `trialExpected = max(0, min(balance, grantedTrial + expiredTrial))`. */
export function reconcileWalletRow(input: {
  accountId: string;
  balance: number;
  ledgerSum: number;
  trialRemaining: number;
  trialGrant: number; // soma dos deltas do bucket 'trial' (>=0)
  trialExpired: number; // soma dos deltas do bucket 'trial_expire' (<=0)
}): WalletDrift {
  const { accountId, balance, ledgerSum, trialRemaining, trialGrant, trialExpired } = input;
  const balanceDrift = balance - ledgerSum;
  // trial vivo esperado: o concedido menos o já expirado, clampado a [0, balance]. Não tentamos
  // reconstruir o gasto trial-first do razão (não é marcado lá); a invariante forte é trial<=balance.
  const trialExpected = Math.max(0, Math.min(balance, trialGrant + trialExpired));
  const trialDrift = trialRemaining - trialExpected;
  const trialOverBalance = trialRemaining > balance;
  return {
    accountId,
    balance,
    ledgerSum,
    balanceDrift,
    trialRemaining,
    trialExpected,
    trialDrift,
    trialOverBalance,
    consistent: balanceDrift === 0 && trialDrift === 0 && !trialOverBalance,
  };
}

/** Job de reconciliação. Para cada carteira: confere `balance == sum(ledger.delta)` e a consistência
 *  do `trial_remaining`; relata as que divergiram. Com `repair=true`, CASA a carteira ao razão (fonte
 *  da verdade append-only): `balance = sum(ledger.delta)` e baixa `trial_remaining` para caber no novo
 *  saldo. NÃO posta entrada no razão (isso mexeria na própria verdade); o reparo é idempotente por
 *  construção (re-rodar é no-op porque a carteira já bate). NÃO roda em request path. */
export async function reconcileCredits(opts?: { repair?: boolean }): Promise<ReconcileReport> {
  const repair = !!opts?.repair;
  const sql = await db();
  // somas do razão por conta (verdade append-only) + buckets de trial, em UMA varredura.
  const rows = (await sql`
    select
      w.account_id,
      w.balance::bigint                                                        as balance,
      w.trial_remaining::bigint                                               as trial_remaining,
      coalesce(l.ledger_sum, 0)::bigint                                       as ledger_sum,
      coalesce(l.trial_grant, 0)::bigint                                      as trial_grant,
      coalesce(l.trial_expired, 0)::bigint                                    as trial_expired
    from galeed_credit_wallet w
    left join (
      select account_id,
        sum(delta)                                          as ledger_sum,
        sum(delta) filter (where bucket = 'trial')          as trial_grant,
        sum(delta) filter (where bucket = 'trial_expire')   as trial_expired
      from galeed_credit_ledger group by account_id
    ) l on l.account_id = w.account_id
  `) as any[];

  const drifts = rows.map((r) =>
    reconcileWalletRow({
      accountId: r.account_id,
      balance: Number(r.balance),
      ledgerSum: Number(r.ledger_sum),
      trialRemaining: Number(r.trial_remaining),
      trialGrant: Number(r.trial_grant),
      trialExpired: Number(r.trial_expired),
    }),
  );
  const drifted = drifts.filter((d) => !d.consistent);

  let repaired = 0;
  if (repair) {
    for (const d of drifted) {
      // FONTE DA VERDADE = o RAZÃO (append-only; invariante §"O razão é append-only / sum(ledger.delta)
      // == wallet.balance"). O reparo CASA a carteira ao razão: `balance = ledgerSum`. NÃO postamos
      // entrada de ajuste no razão — fazer isso mexeria na soma que é justamente a verdade, e o repair
      // antigo (postar adjust=ledgerSum-balance E setar balance=balance+adjust) se cancelava: deixava
      // balance=ledgerSum mas a soma virava 2*ledgerSum-balance, reabrindo o MESMO drift e compoundando
      // a cada dia (idempotência era por (conta, dia)). Agora o reparo é uma simples projeção idempotente:
      // re-rodar (mesmo dia ou outro) é no-op porque balance já bate com ledgerSum. (auditoria R2)
      const target = d.ledgerSum; // a carteira deve refletir o razão
      const newTrial = Math.max(0, Math.min(d.trialExpected, target));
      try {
        // M-PAY-H/10: ao casar balance ao razão, mantém topup_remaining dentro do novo saldo
        // (invariante 0 <= topup_remaining <= balance). Clampa em SQL (sem reconstruir a parcela
        // pré-paga do razão — o trial-first/topup-last é só na carteira, não marcado no razão).
        await sql`
          update galeed_credit_wallet
          set balance = ${target}, trial_remaining = ${newTrial},
              topup_remaining = least(topup_remaining, ${target}), updated_at = now()
          where account_id = ${d.accountId}
        `;
        repaired++;
      } catch (e) {
        console.error(`[credits] reconcile --repair falhou p/ conta ${d.accountId}:`, e instanceof Error ? e.message : e);
      }
    }
  }

  return { walletsChecked: rows.length, drifted, repaired };
}
