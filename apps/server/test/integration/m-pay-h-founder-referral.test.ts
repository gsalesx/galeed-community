/** INTEGRAÇÃO M-PAY-H (Onda 7) — corrida de vaga FUNDADOR (advisory lock anti-overshoot) e INDICAÇÃO
 *  (recordReferral/activateReferral + cap mensal). Bate no Postgres real. A reserva de vaga é exercitada
 *  pela borda createCheckoutHandler (a função de reserva é privada), com a API do Stripe ESPIONADA (sem
 *  rede): checkouts CONCORRENTES nunca passam do limite de vagas. Contas de teste descartáveis (__mpayh7f_).
 *  No-op sem DB ou sem chaves do Stripe (padrão ADR-014). */
import { describe, it, expect, afterAll, beforeAll, vi } from "vitest";
import { hasDb } from "./helpers/db.ts";
import { getSharedSql, closeSharedSql } from "../../src/core/platform/db-conn.ts";
import { createCheckoutHandler, getFounderSeatsHandler } from "../../src/connectors/bff/bff-stripe.ts";
import { stripeEnabled, getStripe } from "../../src/core/platform/stripe.ts";
import {
  recordReferral,
  activateReferral,
  REFERRED_BONUS,
  REFERRER_BONUS,
  REFERRAL_MONTHLY_CAP,
} from "../../src/core/platform/referral.ts";

const PREFIX = "__mpayh7f_";
const REFERRER = PREFIX + "referrer";
const REFERRED = PREFIX + "referred";

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

async function resetAll(sql: any): Promise<void> {
  await sql`delete from galeed_founder_reservations where account_id like ${PREFIX + "%"}`.catch(() => {});
  await sql`delete from galeed_subscriptions where account_id like ${PREFIX + "%"}`.catch(() => {});
  await sql`delete from galeed_billing_customers where account_id like ${PREFIX + "%"}`.catch(() => {});
  await sql`delete from galeed_referrals where referred_account like ${PREFIX + "%"} or referrer_account like ${PREFIX + "%"}`.catch(() => {});
  await sql`delete from galeed_credit_ledger where account_id like ${PREFIX + "%"}`.catch(() => {});
  await sql`delete from galeed_credit_wallet where account_id like ${PREFIX + "%"}`.catch(() => {});
  await sql`delete from galeed_accounts where id like ${PREFIX + "%"}`.catch(() => {});
}

/** Stub da API do Stripe usada pelo checkout (customer + price + session) — sem rede. */
function stubStripeForCheckout(): void {
  vi.spyOn(getStripe().customers, "create").mockImplementation((async (p: any) => ({ id: "cus_" + (p?.metadata?.account_id ?? "x") })) as any);
  vi.spyOn(getStripe().prices, "list").mockResolvedValue({ data: [{ id: "price_founder" }] } as any);
  vi.spyOn(getStripe().checkout.sessions, "create").mockResolvedValue({ url: "https://checkout.test/x" } as any);
}

async function withDb(fn: (sql: any) => Promise<void>): Promise<void> {
  if (!ready()) return;
  const ok = await dbAvailable();
  expect(ok, "infra indisponível").toBe(true);
  if (!ok) return;
  const sql = await getSharedSql();
  await resetAll(sql);
  try {
    await fn(sql);
  } finally {
    await resetAll(sql);
    vi.restoreAllMocks();
  }
}

const SEATS_BEFORE = process.env.GALEED_FOUNDER_SEATS;
beforeAll(() => {
  process.env.GALEED_FOUNDER_SEATS = "2"; // limite baixo p/ provar o anti-overshoot
});
afterAll(async () => {
  if (SEATS_BEFORE === undefined) delete process.env.GALEED_FOUNDER_SEATS;
  else process.env.GALEED_FOUNDER_SEATS = SEATS_BEFORE;
  if (await dbAvailable()) await resetAll(await getSharedSql());
  await closeSharedSql();
});

describe("M-PAY-H Onda 7 — corrida de vaga fundador (advisory lock)", () => {
  it("checkouts CONCORRENTES nunca passam do limite de VAGAS reservadas (anti-overshoot); excedente degrada p/ standard", async () => {
    await withDb(async (sql) => {
      stubStripeForCheckout();
      // 5 contas distintas tentando reservar 2 vagas, em paralelo. M-PAY-H/N (auditoria gap #5): quem
      // não pega vaga NÃO é recusado — DEGRADA p/ standard e o checkout segue (todos 200). O invariante é
      // que só 2 RESERVAS fundador são gravadas (o advisory lock fecha a corrida), nunca mais.
      const accounts = Array.from({ length: 5 }, (_, i) => ({ id: `${PREFIX}race${i}`, email: `race${i}@t.test` }));
      const results = await Promise.all(accounts.map((a) => createCheckoutHandler(a, "pro", "founder")));
      expect(results.every((r) => r.status === 200)).toBe(true); // ninguém é travado: vende sempre
      const res = (await sql`select count(*)::int c from galeed_founder_reservations where account_id like ${PREFIX + "race%"}`) as any[];
      expect(res[0].c).toBe(2); // só 2 reservas fundador gravadas (anti-overshoot) — os outros 3 viraram standard
    });
  });

  it("vaga esgotada → checkout DEGRADA p/ standard (200, NÃO trava a venda) [auditoria gap #5]", async () => {
    await withDb(async (sql) => {
      stubStripeForCheckout();
      // preenche as 2 vagas com reservas frescas.
      await sql`insert into galeed_founder_reservations (account_id) values (${PREFIX + "s0"}), (${PREFIX + "s1"})`;
      const r = await createCheckoutHandler({ id: PREFIX + "late", email: "l@t.test" }, "pro", "founder");
      expect(r.status).toBe(200); // segue o checkout no preço padrão (não retorna 400 "esgotada")
      expect((r.body as any).url).toBeTruthy();
      // não gravou uma 3ª reserva fundador (a conta tardia caiu no caminho standard).
      const res = (await sql`select count(*)::int c from galeed_founder_reservations where account_id = ${PREFIX + "late"}`) as any[];
      expect(res[0].c).toBe(0);
    });
  });

  it("getFounderSeatsHandler reporta total/used/remaining", async () => {
    await withDb(async (sql) => {
      await sql`insert into galeed_founder_reservations (account_id) values (${PREFIX + "u0"})`;
      const seats = (await getFounderSeatsHandler()) as any;
      expect(seats.total).toBe(2);
      expect(seats.used).toBeGreaterThanOrEqual(1);
      expect(seats.remaining).toBe(Math.max(0, seats.total - seats.used));
    });
  });
});

describe("M-PAY-H Onda 7 — indicação (referral)", () => {
  async function seedAccounts(sql: any): Promise<void> {
    // galeed_accounts precisa existir p/ recordReferral validar o indicador.
    await sql.unsafe(`create table if not exists galeed_accounts (id text primary key, email text, created_at timestamptz default now())`);
    await sql`insert into galeed_accounts (id, email) values (${REFERRER}, 'ref@t.test'), (${REFERRED}, 'rd@t.test')
      on conflict (id) do nothing`;
  }

  it("recordReferral grava pendente; ignora auto-indicação e indicador inexistente", async () => {
    await withDb(async (sql) => {
      await seedAccounts(sql);
      await recordReferral(REFERRED, REFERRER);
      let rows = (await sql`select status from galeed_referrals where referred_account = ${REFERRED}`) as any[];
      expect(rows[0].status).toBe("pending");
      // auto-indicação → ignorada.
      await recordReferral(REFERRER, REFERRER);
      rows = (await sql`select count(*)::int c from galeed_referrals where referred_account = ${REFERRER}`) as any[];
      expect(rows[0].c).toBe(0);
      // indicador inexistente → ignorado.
      await recordReferral(PREFIX + "x", PREFIX + "naoexiste");
      rows = (await sql`select count(*)::int c from galeed_referrals where referred_account = ${PREFIX + "x"}`) as any[];
      expect(rows[0].c).toBe(0);
    });
  });

  it("activateReferral concede bônus aos dois lados e é idempotente", async () => {
    await withDb(async (sql) => {
      await seedAccounts(sql);
      await recordReferral(REFERRED, REFERRER);
      await activateReferral(REFERRED);
      const referredBal = (await sql`select coalesce(sum(delta),0)::int s from galeed_credit_ledger where account_id = ${REFERRED} and bucket='referral'`) as any[];
      const referrerBal = (await sql`select coalesce(sum(delta),0)::int s from galeed_credit_ledger where account_id = ${REFERRER} and bucket='referral'`) as any[];
      expect(referredBal[0].s).toBe(REFERRED_BONUS);
      expect(referrerBal[0].s).toBe(REFERRER_BONUS);
      // status virou activated.
      const st = (await sql`select status from galeed_referrals where referred_account = ${REFERRED}`) as any[];
      expect(st[0].status).toBe("activated");
      // re-ativar → no-op (status já activated).
      await activateReferral(REFERRED);
      const again = (await sql`select coalesce(sum(delta),0)::int s from galeed_credit_ledger where account_id = ${REFERRER} and bucket='referral'`) as any[];
      expect(again[0].s).toBe(REFERRER_BONUS); // não dobrou
    });
  });

  it("cap mensal do INDICADOR: bônus do indicador NÃO concedido se estoura o teto (indicado ainda recebe)", async () => {
    await withDb(async (sql) => {
      await seedAccounts(sql);
      // o indicador já está no teto neste mês (lança um ledger 'referral_referrer' = CAP).
      await sql`insert into galeed_credit_ledger (account_id, delta, bucket, reason, idempotency_key)
        values (${REFERRER}, ${REFERRAL_MONTHLY_CAP}, 'referral', 'referral_referrer', 'seed-cap-__mpayh7f')`;
      await recordReferral(REFERRED, REFERRER);
      await activateReferral(REFERRED);
      // indicado recebe o bônus normalmente.
      const referredBal = (await sql`select coalesce(sum(delta),0)::int s from galeed_credit_ledger where account_id = ${REFERRED} and reason='referral_referred'`) as any[];
      expect(referredBal[0].s).toBe(REFERRED_BONUS);
      // indicador NÃO recebe o segundo bônus (estouraria o cap): segue só com o seed.
      const referrerBonus = (await sql`select coalesce(sum(delta),0)::int s from galeed_credit_ledger where account_id = ${REFERRER} and reason='referral_referrer'`) as any[];
      expect(referrerBonus[0].s).toBe(REFERRAL_MONTHLY_CAP);
    });
  });
});
