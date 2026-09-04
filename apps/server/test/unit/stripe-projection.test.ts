// M-PAY-B — trava o contrato do SDK do Stripe na projeção de assinatura. O bug que a revisão
// adversarial pegou: no SDK v22 (API 2026-05-27.dahlia) current_period_end saiu do Subscription e
// foi p/ o ITEM; ler do topo grava NULL silenciosamente. Este teste FALHA com o código antigo.
import { describe, it, expect } from "vitest";
import { projectSubscription } from "../../src/connectors/bff/bff-stripe.ts";
import { priceLookupKey, tierDef, TIERS } from "../../src/core/platform/stripe.ts";
import { CREDIT_COST } from "../../src/core/platform/credits.ts";

describe("projectSubscription (M-PAY-B)", () => {
  it("lê current_period_end do ITEM (v22), não do Subscription", () => {
    const periodEndUnix = 1893456000; // 2030-01-01Z
    const sub: any = {
      id: "sub_x",
      customer: "cus_x",
      status: "active",
      cancel_at_period_end: false,
      metadata: { account_id: "acc_1", tier: "pro", cohort: "standard" },
      // v22: o topo NÃO tem current_period_end (era aqui que o bug lia → undefined → null)
      items: {
        data: [{ current_period_end: periodEndUnix, price: { metadata: { galeed_tier: "pro", galeed_cohort: "standard" } } }],
      },
    };
    const p = projectSubscription(sub);
    expect(p.accountId).toBe("acc_1");
    expect(p.tier).toBe("pro");
    expect(p.status).toBe("active");
    expect(p.customerId).toBe("cus_x");
    expect(p.cancelAtPeriodEnd).toBe(false);
    expect(p.periodEnd).not.toBeNull();
    expect(p.periodEnd?.getTime()).toBe(periodEndUnix * 1000);
  });

  it("tier vem do price.metadata como fallback; cohort default standard", () => {
    const sub: any = {
      id: "s",
      customer: "c",
      status: "active",
      metadata: { account_id: "a" }, // sem tier no metadata da sub
      items: { data: [{ current_period_end: 1, price: { metadata: { galeed_tier: "business" } } }] },
    };
    const p = projectSubscription(sub);
    expect(p.tier).toBe("business");
    expect(p.cohort).toBe("standard");
  });

  it("customer expandido não vira [object Object]", () => {
    const sub: any = {
      id: "s",
      customer: { id: "cus_exp", object: "customer" },
      status: "active",
      metadata: { account_id: "a" },
      items: { data: [{ current_period_end: 1, price: { metadata: {} } }] },
    };
    expect(projectSubscription(sub).customerId).toBe("cus_exp");
  });

  it("sem account_id no metadata → accountId null (handler ignora)", () => {
    const sub: any = { id: "s", customer: "c", status: "active", metadata: {}, items: { data: [{ current_period_end: 1, price: { metadata: {} } }] } };
    expect(projectSubscription(sub).accountId).toBeNull();
  });
});

describe("tiers (M-PAY-B)", () => {
  it("lookup_key estável por tier+cohort", () => {
    expect(priceLookupKey("pro", "standard")).toBe("galeed_pro_monthly");
    expect(priceLookupKey("pro", "founder")).toBe("galeed_pro_monthly_founder");
  });
  it("tierDef bate com a tabela canônica do BP (centavos)", () => {
    expect(tierDef("starter")?.brl).toBe(11900);
    expect(tierDef("pro")?.brl).toBe(32900);
    expect(tierDef("business")?.brl).toBe(119700);
    expect(tierDef("pro")?.founderBrl).toBe(12900);
    expect(tierDef("nope")).toBeUndefined();
    expect(TIERS).toHaveLength(3);
  });
});

describe("créditos (M-PAY-C)", () => {
  it("custo por operação de valor bate com o BP §4.2", () => {
    expect(CREDIT_COST.ask).toBe(6);
    expect(CREDIT_COST.ingest).toBe(30);
    expect(CREDIT_COST.capture).toBe(2);
  });
});
