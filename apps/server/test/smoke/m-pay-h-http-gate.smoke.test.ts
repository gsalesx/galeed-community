/** SMOKE M-PAY-H (auditoria R3 #7) — gate HTTP de crédito/entitlement nas BORDAS pagas, ponta-a-ponta.
 *  Sobe o web-server REAL (helpers/bff.ts) e prova a AMARRAÇÃO motor↔borda que protege a receita:
 *   (a) conta com carteira e saldo ZERADO → /api/ask → 402 {reason:'balance'} (ação paga não é servida);
 *   (b) conta com assinatura 'canceled' → /api/ask → 402 {reason:'entitlement'} (inadimplente bloqueia);
 *   (c) ENTITLEMENT é avaliado ANTES do crédito (cancelada COM saldo ainda dá 'entitlement', não 'balance');
 *   (d) ops de 0cr (facts) NUNCA bloqueiam (read-only sobrevive ao saldo zero).
 *  Precisa de DB (signup grava conta+carteira). No-op sem DATABASE_URL. CONTA descartável (__mpayh7g_).
 *  Precisa de BILLING LIGADO (STRIPE_SECRET_KEY): community/self-host sem Stripe tem gate
 *  permissivo POR DESIGN (billingEnabled() falso → 402 nunca acontece) — aqui os asserts de
 *  bloqueio viram no-op, igual ao padrão do test:billing-gate. */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { hasDb } from "../integration/helpers/db.ts";
import { getSharedSql, closeSharedSql } from "../../src/core/platform/db-conn.ts";
import { billingEnabled } from "../../src/core/platform/credits.ts";
import { startSmokeBff, stopBff, bff, login } from "./helpers/bff.ts";

const TAG = "__mpayh7g_";
const EMAIL = `${TAG}user@galeed.test`;
const PASS = "Senha-Forte-123!";
const BRAIN = `${TAG}brain`;

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

let accountId = "";

async function cleanup(): Promise<void> {
  if (!(await dbAvailable())) return;
  const sql = await getSharedSql();
  await sql`delete from galeed_credit_ledger where account_id = ${accountId}`.catch(() => {});
  await sql`delete from galeed_credit_wallet where account_id = ${accountId}`.catch(() => {});
  await sql`delete from galeed_subscriptions where account_id = ${accountId}`.catch(() => {});
  await sql`delete from galeed_account_brains where account_id = ${accountId}`.catch(() => {});
  await sql`delete from galeed_sessions where account_id = ${accountId}`.catch(() => {});
  await sql`delete from galeed_accounts where email = ${EMAIL}`.catch(() => {});
}

describe("M-PAY-H — gate HTTP de crédito/entitlement [auditoria R3 #7]", () => {
  beforeAll(async () => {
    if (!(await dbAvailable())) return;
    await startSmokeBff();
    // signup: cria conta + brain + trial (carteira com 1000cr).
    const r = await bff("/auth/signup", { method: "POST", body: { email: EMAIL, password: PASS, brainName: BRAIN }, auth: false });
    expect(r.status, r.raw).toBe(200);
    const sql = await getSharedSql();
    const acc = (await sql`select id from galeed_accounts where email = ${EMAIL}`) as any[];
    accountId = acc[0].id;
  });

  afterAll(async () => {
    await cleanup();
    await stopBff();
    await closeSharedSql();
  });

  it("(d) op de 0cr (facts) NUNCA bloqueia mesmo com saldo zero", async () => {
    if (!(await dbAvailable())) return;
    const sql = await getSharedSql();
    await sql`update galeed_credit_wallet set balance = 0, trial_remaining = 0 where account_id = ${accountId}`;
    await login(EMAIL, PASS);
    const r = await bff(`/api/facts?brain=${BRAIN}`);
    expect(r.status).toBe(200); // leitura nunca bloqueia
  });

  it("(a) saldo zerado → /api/ask 402 {reason:'balance'}", async () => {
    if (!(await dbAvailable())) return;
    if (!billingEnabled()) return; // sem Stripe o gate é permissivo POR DESIGN — nada a provar aqui
    const sql = await getSharedSql();
    await sql`update galeed_credit_wallet set balance = 0, trial_remaining = 0 where account_id = ${accountId}`;
    await sql`delete from galeed_subscriptions where account_id = ${accountId}`; // sem assinatura → só gate de crédito
    await login(EMAIL, PASS);
    const r = await bff(`/api/ask?brain=${BRAIN}&q=oi`);
    expect(r.status).toBe(402);
    expect(r.json?.reason).toBe("balance");
  });

  it("(b)+(c) assinatura 'canceled' COM saldo → 402 {reason:'entitlement'} (entitlement ANTES do crédito)", async () => {
    if (!(await dbAvailable())) return;
    if (!billingEnabled()) return; // sem Stripe o gate é permissivo POR DESIGN — nada a provar aqui
    const sql = await getSharedSql();
    // saldo CHEIO de propósito: se o crédito fosse avaliado antes, passaria — provar que entitlement vence.
    await sql`update galeed_credit_wallet set balance = 100000, trial_remaining = 0 where account_id = ${accountId}`;
    await sql`
      insert into galeed_subscriptions (account_id, tier, status, updated_at)
      values (${accountId}, 'pro', 'canceled', now())
      on conflict (account_id) do update set tier='pro', status='canceled', grace_until=null, updated_at=now()
    `;
    await login(EMAIL, PASS);
    const r = await bff(`/api/ask?brain=${BRAIN}&q=oi`);
    expect(r.status).toBe(402);
    expect(r.json?.reason).toBe("entitlement"); // entitlement avaliado ANTES do crédito (tinha saldo)
  });

  it("conta SEM assinatura (trial puro) com saldo → NÃO bloqueia por entitlement", async () => {
    if (!(await dbAvailable())) return;
    const sql = await getSharedSql();
    await sql`update galeed_credit_wallet set balance = 100000, trial_remaining = 0 where account_id = ${accountId}`;
    await sql`delete from galeed_subscriptions where account_id = ${accountId}`;
    await login(EMAIL, PASS);
    const r = await bff(`/api/ask?brain=${BRAIN}&q=oi`);
    // com saldo e sem assinatura, o gate libera (entitlement 'none' = entitled). Pode ser 200 (resposta)
    // ou um erro NÃO-402 do motor (sem corpus), mas JAMAIS 402 — a ação paga não é negada.
    expect(r.status).not.toBe(402);
  });
});
