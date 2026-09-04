/** INTEGRAÇÃO M-PAY-H (Onda 7) — caminhos de DINHEIRO do ledger contra Postgres real. Cobre o que os
 *  testes puros não pegam: gateAndDebit (capHit do teto, saldo insuficiente=402, idempotência por chave),
 *  grantCredits/grantTierCredits (idempotentes por chave/event_id), clawbackTopup (estorno total/parcial/
 *  idempotente), listLedger (summary/daily/entries) e getSpendCap/setSpendCap. CONTA + BRAIN de teste
 *  descartáveis (__mpayh7l_). No-op sem DATABASE_URL/GALEED_DB_URL/SUPABASE_DB_URL (padrão ADR-014). */
import { describe, it, expect, afterAll } from "vitest";
import { hasDb } from "./helpers/db.ts";
import { getSharedSql, closeSharedSql } from "../../src/core/platform/db-conn.ts";
import {
  grantTrial,
  grantCredits,
  grantTierCredits,
  clawbackTopup,
  gateAndDebit,
  listLedger,
  getSpendCap,
  setSpendCap,
  TRIAL_GRANT,
  CREDIT_COST,
} from "../../src/core/platform/credits.ts";
import { tierDef } from "../../src/core/platform/stripe.ts";

const ACCT = "__mpayh7l_acct";
const BRAIN = "__mpayh7l_brain";

let dbOk: Promise<boolean> | null = null;
async function dbAvailable(): Promise<boolean> {
  if (!hasDb()) return false;
  dbOk ??= (async () => {
    try {
      const sql = await getSharedSql();
      await Promise.race([
        sql`select 1`,
        new Promise((_, reject) => setTimeout(() => reject(new Error("db ping timeout")), 7000)),
      ]);
      return true;
    } catch {
      return false;
    }
  })();
  return dbOk;
}

async function reset(sql: any): Promise<void> {
  await sql`delete from galeed_credit_ledger where account_id = ${ACCT}`;
  await sql`delete from galeed_credit_wallet where account_id = ${ACCT}`;
  await sql`delete from galeed_spend_cap where account_id = ${ACCT}`.catch(() => {});
  await sql`delete from galeed_account_brains where account_id = ${ACCT}`.catch(() => {});
  await sql`delete from galeed_subscriptions where account_id = ${ACCT}`.catch(() => {});
  await sql`
    insert into galeed_account_brains (account_id, brain, role) values (${ACCT}, ${BRAIN}, 'owner')
    on conflict do nothing
  `;
}

async function runWithDb(fn: (sql: any) => Promise<void>): Promise<void> {
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

afterAll(async () => {
  if (await dbAvailable()) {
    const sql = await getSharedSql();
    await reset(sql);
  }
  await closeSharedSql();
});

describe("M-PAY-H Onda 7 — gateAndDebit (DB)", () => {
  it("custo 0 nunca gateia (facts/timeline) — permissivo, gated=false", async () => {
    await runWithDb(async () => {
      const r = await gateAndDebit(BRAIN, 0, "facts");
      expect(r.ok).toBe(true);
      expect(r.gated).toBe(false);
    });
  });

  it("conta SEM carteira → permissivo (não-billado), gated=false", async () => {
    await runWithDb(async () => {
      // grantTrial NÃO chamado → não há carteira; o gate passa permissivo.
      const r = await gateAndDebit(BRAIN, CREDIT_COST.ask, "ask");
      expect(r.ok).toBe(true);
      expect(r.gated).toBe(false);
      expect(r.balance).toBeNull();
    });
  });

  it("saldo insuficiente → 402 (ok:false) e a chave fica LIVRE p/ retry futuro", async () => {
    await runWithDb(async (sql) => {
      await grantTrial(ACCT);
      // deixa o saldo abaixo do custo de um ingest (30).
      await sql`update galeed_credit_wallet set balance = 10, trial_remaining = 10 where account_id = ${ACCT}`;
      const r = await gateAndDebit(BRAIN, CREDIT_COST.ingest, "ingest", "ing-1");
      expect(r.ok).toBe(false);
      expect(r.balance).toBe(10);
      // a claim sofreu rollback (saldo insuficiente) → nenhuma linha de uso foi gravada.
      const led = (await sql`select count(*)::int c from galeed_credit_ledger where account_id = ${ACCT} and bucket = 'usage'`) as any[];
      expect(led[0].c).toBe(0);
      // recarrega e retenta com a MESMA chave: agora passa (a chave não foi consumida antes).
      await sql`update galeed_credit_wallet set balance = 100, trial_remaining = 0 where account_id = ${ACCT}`;
      const r2 = await gateAndDebit(BRAIN, CREDIT_COST.ingest, "ingest", "ing-1");
      expect(r2.ok).toBe(true);
      expect(r2.balance).toBe(70);
    });
  });

  it("teto de gasto (kill-switch) → capHit antes de debitar (não consome saldo nem chave)", async () => {
    await runWithDb(async (sql) => {
      await grantTrial(ACCT);
      // teto de 50cr ligado; já gastou 48 no ciclo → o próximo ask (6) estoura.
      await setSpendCap(ACCT, { enabled: true, killSwitch: true, limitCredits: 50 });
      await sql`
        insert into galeed_credit_ledger (account_id, delta, bucket, reason, op, idempotency_key)
        values (${ACCT}, -48, 'usage', 'usage_ask', 'ask', 'seed-spend')
      `;
      await sql`update galeed_credit_wallet set balance = balance - 48 where account_id = ${ACCT}`;
      const r = await gateAndDebit(BRAIN, CREDIT_COST.ask, "ask", "ask-capped");
      expect(r.ok).toBe(false);
      expect(r.capHit).toBe(true);
      // não debitou: o saldo segue o de antes (1000 - 48) e a chave não foi reivindicada.
      expect(r.balance).toBe(TRIAL_GRANT - 48);
      const claimed = (await sql`select count(*)::int c from galeed_credit_ledger where account_id = ${ACCT} and idempotency_key = 'ask-capped'`) as any[];
      expect(claimed[0].c).toBe(0);
    });
  });

  it("teto ligado mas DENTRO do limite → debita normal (capHit não dispara)", async () => {
    await runWithDb(async () => {
      await grantTrial(ACCT);
      await setSpendCap(ACCT, { enabled: true, killSwitch: true, limitCredits: 1000 });
      const r = await gateAndDebit(BRAIN, CREDIT_COST.ask, "ask", "ask-ok");
      expect(r.ok).toBe(true);
      expect(r.capHit).toBeUndefined();
      expect(r.balance).toBe(TRIAL_GRANT - CREDIT_COST.ask);
    });
  });
});

describe("M-PAY-H Onda 7 — grant* (DB, idempotentes)", () => {
  it("grantCredits credita uma vez; mesma chave NÃO re-credita", async () => {
    await runWithDb(async (sql) => {
      await sql.begin(async (tx: any) => {
        const a = await grantCredits(tx, ACCT, 500, "topup", "topup", "k-1");
        const b = await grantCredits(tx, ACCT, 500, "topup", "topup", "k-1");
        expect(a).toBe(500);
        expect(b).toBe(0); // 2ª vez → no-op
      });
      const w = (await sql`select balance from galeed_credit_wallet where account_id = ${ACCT}`) as any[];
      expect(Number(w[0].balance)).toBe(500);
    });
  });

  it("grantCredits ignora valor <= 0", async () => {
    await runWithDb(async (sql) => {
      await sql.begin(async (tx: any) => {
        expect(await grantCredits(tx, ACCT, 0, "topup", "topup", "z-0")).toBe(0);
        expect(await grantCredits(tx, ACCT, -10, "topup", "topup", "z-neg")).toBe(0);
      });
      const w = (await sql`select count(*)::int c from galeed_credit_wallet where account_id = ${ACCT}`) as any[];
      expect(w[0].c).toBe(0); // nenhuma carteira criada
    });
  });

  it("grantTierCredits concede o bolo do tier (idempotente por event_id); tier nulo → 0", async () => {
    await runWithDb(async (sql) => {
      const pro = tierDef("pro")!.credits;
      await sql.begin(async (tx: any) => {
        const g1 = await grantTierCredits(tx, ACCT, "evt_abc", "pro");
        const g2 = await grantTierCredits(tx, ACCT, "evt_abc", "pro"); // mesmo event_id → no-op
        expect(g1).toBe(pro);
        expect(g2).toBe(0);
        const g3 = await grantTierCredits(tx, ACCT, "evt_xyz", null); // sem tier → 0
        expect(g3).toBe(0);
      });
      const w = (await sql`select balance from galeed_credit_wallet where account_id = ${ACCT}`) as any[];
      expect(Number(w[0].balance)).toBe(pro);
      const led = (await sql`select count(*)::int c from galeed_credit_ledger where account_id = ${ACCT} and bucket = 'monthly'`) as any[];
      expect(led[0].c).toBe(1);
    });
  });
});

describe("M-PAY-H Onda 7 — clawbackTopup (DB)", () => {
  it("estorna TOTAL quando há saldo; idempotente por (PI, cumulativo)", async () => {
    await runWithDb(async (sql) => {
      await sql.begin((tx: any) => grantCredits(tx, ACCT, 2500, "topup", "topup", "topup:evt1", "evt1"));
      let removed = 0;
      await sql.begin(async (tx: any) => {
        removed = await clawbackTopup(tx, ACCT, 2500, "refund_evt1", "pi_1");
      });
      expect(removed).toBe(2500);
      const w = (await sql`select balance from galeed_credit_wallet where account_id = ${ACCT}`) as any[];
      expect(Number(w[0].balance)).toBe(0);
      // reprocesso do mesmo PI+cumulativo → no-op (não vira saldo negativo nem dupla linha).
      let again = 0;
      await sql.begin(async (tx: any) => {
        again = await clawbackTopup(tx, ACCT, 2500, "refund_evt1b", "pi_1");
      });
      expect(again).toBe(0);
      const ref = (await sql`select count(*)::int c from galeed_credit_ledger where account_id = ${ACCT} and bucket = 'topup_refund'`) as any[];
      expect(ref[0].c).toBe(1);
    });
  });

  it("estorno PARCIAL: clampa ao saldo restante (resto já gasto)", async () => {
    await runWithDb(async (sql) => {
      await sql.begin((tx: any) => grantCredits(tx, ACCT, 2500, "topup", "topup", "topup:evt2", "evt2"));
      // gastou 2000 → restam 500; pedido de estorno de 2500 só pode remover 500.
      await sql`update galeed_credit_wallet set balance = 500 where account_id = ${ACCT}`;
      let removed = 0;
      await sql.begin(async (tx: any) => {
        removed = await clawbackTopup(tx, ACCT, 2500, "refund_evt2", "pi_2");
      });
      expect(removed).toBe(500);
      const w = (await sql`select balance from galeed_credit_wallet where account_id = ${ACCT}`) as any[];
      expect(Number(w[0].balance)).toBe(0); // nunca negativo
    });
  });

  it("reembolsos PARCIAIS múltiplos (cumulativo): cobra só o DELTA, nunca re-conta [auditoria R3 #2]", async () => {
    await runWithDb(async (sql) => {
      // top-up de 1000cr; 1º estorno cumulativo de 30% (300cr), depois cumulativo de 60% (600cr).
      await sql.begin((tx: any) => grantCredits(tx, ACCT, 1000, "topup", "topup", "topup:evtm", "evtm"));
      let r1 = 0;
      await sql.begin(async (tx: any) => {
        r1 = await clawbackTopup(tx, ACCT, 300, "refund_m1", "pi_m"); // cumulativo 300
      });
      expect(r1).toBe(300);
      let r2 = 0;
      await sql.begin(async (tx: any) => {
        r2 = await clawbackTopup(tx, ACCT, 600, "refund_m2", "pi_m"); // cumulativo 600 → delta 300
      });
      expect(r2).toBe(300); // só o DELTA (600-300), NÃO 600
      const w = (await sql`select balance from galeed_credit_wallet where account_id = ${ACCT}`) as any[];
      expect(Number(w[0].balance)).toBe(400); // 1000 - 600 cumulativo, não 1000-900
      // reentrega do 2º evento (mesmo cumulativo 600) → no-op.
      let r2b = 0;
      await sql.begin(async (tx: any) => {
        r2b = await clawbackTopup(tx, ACCT, 600, "refund_m2b", "pi_m");
      });
      expect(r2b).toBe(0);
      const w2 = (await sql`select balance from galeed_credit_wallet where account_id = ${ACCT}`) as any[];
      expect(Number(w2[0].balance)).toBe(400);
    });
  });
});

describe("M-PAY-H Onda 7 — listLedger / getSpendCap / setSpendCap (DB)", () => {
  it("listLedger: summary (grant=trial sem assinatura), gasto por op, daily e entries", async () => {
    await runWithDb(async () => {
      await grantTrial(ACCT);
      await gateAndDebit(BRAIN, CREDIT_COST.ask, "ask", "v-ask-1");
      await gateAndDebit(BRAIN, CREDIT_COST.ingest, "ingest", "v-ing-1");
      const v = await listLedger(ACCT);
      expect(v.summary.grant).toBe(TRIAL_GRANT); // sem assinatura → denominador é o trial
      expect(v.summary.balance).toBe(TRIAL_GRANT - CREDIT_COST.ask - CREDIT_COST.ingest);
      expect(v.summary.spentAsk).toBe(CREDIT_COST.ask);
      expect(v.summary.spentIngest).toBe(CREDIT_COST.ingest);
      expect(v.summary.spentTotal).toBe(CREDIT_COST.ask + CREDIT_COST.ingest);
      expect(v.summary.readOnly).toBe(false);
      // entries: grant do trial + 2 usos = 3 linhas; daily tem um dia com gasto.
      expect(v.entries.length).toBe(3);
      expect(v.daily.length).toBe(1);
      expect(v.daily[0].ask).toBe(CREDIT_COST.ask);
      expect(v.daily[0].ing).toBe(CREDIT_COST.ingest);
    });
  });

  it("listLedger: com assinatura ativa o denominador vira o bolo do tier", async () => {
    await runWithDb(async (sql) => {
      await grantTrial(ACCT);
      await sql`
        insert into galeed_subscriptions (account_id, tier, status, updated_at)
        values (${ACCT}, 'pro', 'active', now())
        on conflict (account_id) do update set tier = 'pro', status = 'active'
      `;
      const v = await listLedger(ACCT);
      expect(v.summary.grant).toBe(tierDef("pro")!.credits);
    });
  });

  it("setSpendCap grava e getSpendCap reflete o teto + gasto do ciclo", async () => {
    await runWithDb(async () => {
      await grantTrial(ACCT);
      await gateAndDebit(BRAIN, CREDIT_COST.ask, "ask", "cap-ask");
      const saved = await setSpendCap(ACCT, { enabled: true, killSwitch: true, limitCredits: 5000 });
      expect(saved.enabled).toBe(true);
      expect(saved.limitCredits).toBe(5000);
      expect(saved.cycleSpentCredits).toBe(CREDIT_COST.ask);
      const got = await getSpendCap(ACCT);
      expect(got.enabled).toBe(true);
      expect(got.killSwitch).toBe(true);
      expect(got.limitCredits).toBe(5000);
      expect(got.cycleSpentCredits).toBe(CREDIT_COST.ask);
    });
  });

  it("setSpendCap clampa limitCredits negativo p/ 0", async () => {
    await runWithDb(async () => {
      const saved = await setSpendCap(ACCT, { enabled: true, killSwitch: false, limitCredits: -100 });
      expect(saved.limitCredits).toBe(0);
      expect(saved.killSwitch).toBe(false);
    });
  });
});
