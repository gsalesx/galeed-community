// M-PAY-F — créditos de indicação. Atribuição no signup (ref = id da conta do indicador) → ao ATIVAR
// (1ª ingestão do indicado), concede ao indicado +1.000cr e ao indicador +1.500cr (BP §4.8). Fail-soft:
// nunca derruba signup/ingest. Idempotente (status pending→activated + chaves de grant determinísticas).
//
// DEFERIDO (documentado): cap anti-abuso (15.000cr/mês no free/trial), tier Embaixador (+2.500), e o
// critério completo de ativação do BP (1 brain real + ≥3 perguntas com proveniência) — aqui a ativação
// é a 1ª ingestão (sinal mais simples de "tirou valor").
import { getSharedSql, sharedSqlGeneration } from "./db-conn.ts";
import { grantCredits } from "./credits.ts";

export const REFERRED_BONUS = 1000; // indicado
export const REFERRER_BONUS = 1500; // indicador (tier base)
export const REFERRAL_MONTHLY_CAP = 15000; // teto anti-farming por indicador/mês (BP §4.8)

export const REFERRAL_DDL = `
  create table if not exists galeed_referrals (
    referred_account text primary key,
    referrer_account text not null,
    status           text not null default 'pending',
    created_at       timestamptz not null default now(),
    activated_at     timestamptz
  );
  create index if not exists galeed_referrals_referrer on galeed_referrals (referrer_account);
`;

let _ready: Promise<void> | null = null;
let _gen = -1;
async function db(): Promise<any> {
  const sql = await getSharedSql();
  const gen = sharedSqlGeneration();
  if (!_ready || _gen !== gen) {
    _gen = gen;
    _ready = sql.unsafe(REFERRAL_DDL);
  }
  await _ready;
  return sql;
}

/** Registra a indicação no signup (pendente). referrerCode = id da conta do indicador. Fail-soft.
 *  Ignora auto-indicação e indicador inexistente. */
export async function recordReferral(referredAccount: string, referrerCode: string | undefined): Promise<void> {
  if (!referrerCode || referrerCode === referredAccount) return;
  try {
    const sql = await db();
    const exists = (await sql`select 1 from galeed_accounts where id = ${referrerCode}`) as any[];
    if (exists.length === 0) return; // indicador inexistente → ignora
    await sql`
      insert into galeed_referrals (referred_account, referrer_account, status)
      values (${referredAccount}, ${referrerCode}, 'pending') on conflict (referred_account) do nothing
    `;
  } catch (e) {
    console.warn("[referral] recordReferral erro (fail-soft):", e instanceof Error ? e.message : e);
  }
}

/** Ativa a indicação pendente do indicado quando ele faz um EVENTO PAGO (assinatura/top-up) — NÃO em
 *  ingestão grátis (anti-farming: cada conta indicada precisa PAGAR p/ render bônus). Concede ao
 *  indicado +REFERRED_BONUS e ao indicador +REFERRER_BONUS (capado a REFERRAL_MONTHLY_CAP/mês).
 *  Idempotente (lock pending→activated + chaves determinísticas). Fail-soft. */
export async function activateReferral(referredAccount: string): Promise<void> {
  try {
    const sql = await db();
    const rows = (await sql`select status from galeed_referrals where referred_account = ${referredAccount}`) as any[];
    if (!rows[0] || rows[0].status !== "pending") return; // sem indicação pendente
    await sql.begin(async (tx: any) => {
      const upd = (await tx`
        update galeed_referrals set status = 'activated', activated_at = now()
        where referred_account = ${referredAccount} and status = 'pending' returning referrer_account
      `) as any[];
      if (upd.length === 0) return; // outra corrida já ativou
      const referrer = upd[0].referrer_account;
      await grantCredits(tx, referredAccount, REFERRED_BONUS, "referral", "referral_referred", `ref:${referredAccount}:referred`);
      // cap mensal por INDICADOR (anti-farming): não concede o bônus do indicador se ele já atingiu o teto.
      const earned = Number(
        ((await tx`
          select coalesce(sum(delta), 0)::bigint as s from galeed_credit_ledger
          where account_id = ${referrer} and reason = 'referral_referrer' and created_at >= date_trunc('month', now())
        `) as any[])[0]?.s ?? 0,
      );
      if (earned + REFERRER_BONUS <= REFERRAL_MONTHLY_CAP) {
        await grantCredits(tx, referrer, REFERRER_BONUS, "referral", "referral_referrer", `ref:${referredAccount}:referrer`);
        console.log(`[referral] ativada: indicado ${referredAccount} (+${REFERRED_BONUS}) / indicador ${referrer} (+${REFERRER_BONUS})`);
      } else {
        console.warn(`[referral] indicador ${referrer} no teto mensal (${REFERRAL_MONTHLY_CAP}cr) — bônus do indicador NÃO concedido.`);
      }
    });
  } catch (e) {
    console.warn("[referral] activateReferral erro (fail-soft):", e instanceof Error ? e.message : e);
  }
}
