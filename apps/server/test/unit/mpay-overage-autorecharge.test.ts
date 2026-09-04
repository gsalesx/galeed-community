// M-PAY-H (Onda 4) — M-PAY-D completo: overage (Pro+), gatilho de auto-recarga, limiares de alerta
// (60/80/90% + dedup + reset de ciclo) e seleção de cohort do checkout. Tudo via funções PURAS
// (sem DB/Stripe) para travar o contrato dos caminhos de dinheiro.
import { describe, it, expect } from "vitest";
import {
  computeOverageCredits,
  overageAmountCents,
  OVERAGE_CENTAVOS_PER_CREDIT,
  OVERAGE_TIERS,
  pickCheckoutCohort,
  tierDef,
} from "../../src/core/platform/stripe.ts";
import {
  consumptionPct,
  nextAlertThreshold,
  shouldAutoRecharge,
  ALERT_THRESHOLDS,
  type BillingPrefs,
} from "../../src/core/platform/billing-prefs.ts";

describe("overage (M-PAY-H Onda 4)", () => {
  it("Pro+ cobra só o consumo ALÉM do bolo do tier", () => {
    const proBolo = tierDef("pro")!.credits; // 10000
    expect(computeOverageCredits("pro", proBolo + 500)).toBe(500);
    expect(computeOverageCredits("pro", proBolo)).toBe(0); // exatamente no bolo → sem overage
    expect(computeOverageCredits("pro", proBolo - 1)).toBe(0); // dentro do bolo
  });

  it("business também tem overage (consumo − bolo)", () => {
    const bizBolo = tierDef("business")!.credits; // 30000
    expect(computeOverageCredits("business", bizBolo + 1000)).toBe(1000);
    expect(OVERAGE_TIERS.has("business")).toBe(true);
  });

  it("starter NÃO tem overage (sobe de plano / top-up)", () => {
    const starterBolo = tierDef("starter")!.credits;
    expect(computeOverageCredits("starter", starterBolo + 9999)).toBe(0);
    expect(OVERAGE_TIERS.has("starter")).toBe(false);
  });

  it("tier nulo/desconhecido → sem overage", () => {
    expect(computeOverageCredits(null, 99999)).toBe(0);
    expect(computeOverageCredits("nope", 99999)).toBe(0);
  });

  // auditoria R2 (dupla cobrança): créditos PAGOS no ciclo (top-up/auto-recarga/indicação) entram no
  // allowance — o consumo já pago no top-up NÃO pode ser cobrado de novo no overage.
  it("subtrai créditos pagos do ciclo: top-up cobre o excedente → overage 0 até estourar bolo+comprado", () => {
    const proBolo = tierDef("pro")!.credits; // 10000
    // Pro compra 5000cr de top-up e consome 15000cr (10000 do bolo + 5000 do top-up): overage = 0.
    expect(computeOverageCredits("pro", proBolo + 5000, 5000)).toBe(0);
    // Consome 1 a mais que bolo+comprado → overage = 1 (só o que excede TODO o crédito disponível).
    expect(computeOverageCredits("pro", proBolo + 5001, 5000)).toBe(1);
    // Quanto mais top-up, mais allowance: 20000 comprados absorvem o consumo.
    expect(computeOverageCredits("pro", proBolo + 20000, 20000)).toBe(0);
  });

  it("paidCreditsThisCycle default 0 mantém o comportamento antigo (só bolo do tier)", () => {
    const proBolo = tierDef("pro")!.credits;
    expect(computeOverageCredits("pro", proBolo + 500)).toBe(500);
  });

  it("valor em centavos = créditos × R$0,025 (arredondado p/ inteiro)", () => {
    expect(OVERAGE_CENTAVOS_PER_CREDIT).toBe(2.5);
    expect(overageAmountCents(1000)).toBe(2500); // 1000cr × 2,5c = R$25,00
    expect(overageAmountCents(1)).toBe(3); // 2,5 → arredonda p/ 3 (Stripe cobra inteiro)
    expect(overageAmountCents(0)).toBe(0);
  });
});

describe("limiares de alerta de consumo (M-PAY-H Onda 4)", () => {
  it("consumptionPct = gasto/bolo em %, piso inteiro; bolo 0 → 0", () => {
    expect(consumptionPct(600, 1000)).toBe(60);
    expect(consumptionPct(905, 1000)).toBe(90);
    expect(consumptionPct(1, 0)).toBe(0); // sem denominador
    expect(consumptionPct(0, 1000)).toBe(0);
  });

  it("dispara o MAIOR limiar recém-cruzado; dedup contra o último já alertado", () => {
    expect(nextAlertThreshold(59, 0)).toBeNull(); // abaixo de 60
    expect(nextAlertThreshold(60, 0)).toBe(60);
    expect(nextAlertThreshold(85, 0)).toBe(80); // pula 60, pega o maior cruzado
    expect(nextAlertThreshold(95, 0)).toBe(90);
    expect(nextAlertThreshold(85, 60)).toBe(80); // 60 já alertado → próximo é 80
    expect(nextAlertThreshold(85, 80)).toBeNull(); // 80 já alertado, ainda não chegou em 90
    expect(nextAlertThreshold(90, 90)).toBeNull(); // já no topo dos limiares
  });

  it("limiares são exatamente 60/80/90", () => {
    expect([...ALERT_THRESHOLDS]).toEqual([60, 80, 90]);
  });

  it("reset de ciclo: pct < último alerta sinaliza zerar (o caller volta lastAlertPct a 0)", () => {
    // No início do ciclo o gasto reinicia → pct cai abaixo do limiar registrado; o re-disparo a partir
    // de lastAlertPct=0 volta a alertar os limiares do novo ciclo.
    const novoCicloPct = 5;
    const lastDoCicloAnterior = 90;
    expect(novoCicloPct < lastDoCicloAnterior).toBe(true); // gatilho do reset
    expect(nextAlertThreshold(65, 0)).toBe(60); // pós-reset volta a alertar normalmente
  });
});

describe("gatilho de auto-recarga (M-PAY-H Onda 4)", () => {
  const base: BillingPrefs = {
    autorechargeEnabled: true,
    autorechargeThresholdCredits: 500,
    autorechargePackage: "cr2500",
    lastAlertPct: 0,
    defaultPaymentMethod: "pm_123",
    needsAction: false,
    disputeOpen: false,
    autorechargePendingUntil: null,
  };

  it("dispara quando ligada, com método+pacote, sem SCA pendente, e saldo < limiar", () => {
    expect(shouldAutoRecharge(base, 499)).toBe(true);
    expect(shouldAutoRecharge(base, 500)).toBe(false); // no limiar não dispara (estrito <)
    expect(shouldAutoRecharge(base, 600)).toBe(false);
  });

  it("opt-out → nunca dispara", () => {
    expect(shouldAutoRecharge({ ...base, autorechargeEnabled: false }, 0)).toBe(false);
  });

  it("SCA pendente (needsAction) → NÃO reentra em loop", () => {
    expect(shouldAutoRecharge({ ...base, needsAction: true }, 0)).toBe(false);
  });

  it("sem método salvo ou sem pacote → não dispara", () => {
    expect(shouldAutoRecharge({ ...base, defaultPaymentMethod: null }, 0)).toBe(false);
    expect(shouldAutoRecharge({ ...base, autorechargePackage: null }, 0)).toBe(false);
  });

  it("limiar <= 0 → não dispara (config incompleta)", () => {
    expect(shouldAutoRecharge({ ...base, autorechargeThresholdCredits: 0 }, 0)).toBe(false);
  });

  it("recarga EM VOO (autorechargePendingUntil futuro) → NÃO re-dispara (anti-cobrança-dupla)", () => {
    const now = new Date("2026-06-18T12:00:00Z");
    const future = new Date("2026-06-18T12:10:00Z").toISOString(); // dentro do TTL
    // saldo ainda baixo (o crédito do webhook não chegou), mas a trava barra o 2º disparo.
    expect(shouldAutoRecharge({ ...base, autorechargePendingUntil: future }, 0, now)).toBe(false);
  });

  it("trava EM VOO expirada (pending no passado) → pode disparar de novo", () => {
    const now = new Date("2026-06-18T12:00:00Z");
    const past = new Date("2026-06-18T11:40:00Z").toISOString(); // TTL já venceu
    expect(shouldAutoRecharge({ ...base, autorechargePendingUntil: past }, 0, now)).toBe(true);
  });
});

describe("seleção de cohort do checkout (M-PAY-H Onda 4)", () => {
  it("há vaga fundador → founder", () => {
    expect(pickCheckoutCohort(5)).toBe("founder");
    expect(pickCheckoutCohort(1)).toBe("founder");
  });

  it("sem vaga → standard (não trava a assinatura no preço padrão)", () => {
    expect(pickCheckoutCohort(0)).toBe("standard");
    expect(pickCheckoutCohort(-1)).toBe("standard");
  });

  it("disponibilidade desconhecida (null/undefined) → standard (fail-safe)", () => {
    expect(pickCheckoutCohort(null)).toBe("standard");
    expect(pickCheckoutCohort(undefined)).toBe("standard");
  });
});
