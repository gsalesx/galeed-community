// M-PAY-H (Onda 3) — entitlement (dunning). Testa a função PURA decideEntitlement: todas as transições
// active→past_due→grace→lapsed, canceled/unpaid bloqueiam, e trial puro (sem assinatura) NUNCA bloqueia.
import { describe, it, expect } from "vitest";
import { decideEntitlement } from "../../src/core/platform/entitlement.ts";

const NOW = new Date("2026-06-18T12:00:00Z");
const future = (h: number) => new Date(NOW.getTime() + h * 3600_000);
const past = (h: number) => new Date(NOW.getTime() - h * 3600_000);

describe("decideEntitlement (M-PAY-H Onda 3)", () => {
  it("sem assinatura → none, entitled (trial puro nunca bloqueia por entitlement)", () => {
    const e = decideEntitlement(null, null, NOW);
    expect(e).toEqual({ entitled: true, status: null, graceUntil: null, reason: "none" });
  });

  it("active → entitled, reason active", () => {
    const e = decideEntitlement("active", null, NOW);
    expect(e.entitled).toBe(true);
    expect(e.reason).toBe("active");
  });

  it("trialing → entitled, reason active", () => {
    const e = decideEntitlement("trialing", null, NOW);
    expect(e.entitled).toBe(true);
    expect(e.reason).toBe("active");
  });

  it("past_due com graça vigente → entitled, reason grace (expõe graceUntil)", () => {
    const g = future(72);
    const e = decideEntitlement("past_due", g, NOW);
    expect(e.entitled).toBe(true);
    expect(e.reason).toBe("grace");
    expect(e.graceUntil).toBe(g.toISOString());
  });

  it("past_due com graça VENCIDA → bloqueia, reason lapsed", () => {
    const e = decideEntitlement("past_due", past(1), NOW);
    expect(e.entitled).toBe(false);
    expect(e.reason).toBe("lapsed");
  });

  // M-PAY-H/N (auditoria): past_due com grace_until NULL = corrida de ordem de webhook (subscription.updated
  // marcou past_due ANTES de invoice.payment_failed abrir a janela de 7d). NÃO bloquear: trata como grace
  // (entitled) — os Smart Retries do Stripe resolvem (ou o payment_failed atrasado grava a janela, ou volta
  // a active). Bloquear aqui derrubaria um cliente que DEVERIA estar em graça.
  it("past_due SEM graça (corrida de webhook) → entitled, reason grace (não bloqueia)", () => {
    const e = decideEntitlement("past_due", null, NOW);
    expect(e.entitled).toBe(true);
    expect(e.reason).toBe("grace");
    expect(e.graceUntil).toBeNull();
  });

  it("canceled → bloqueia (saldo não salva: entitlement é independente do crédito)", () => {
    const e = decideEntitlement("canceled", null, NOW);
    expect(e.entitled).toBe(false);
    expect(e.reason).toBe("lapsed");
  });

  it("unpaid → bloqueia", () => {
    const e = decideEntitlement("unpaid", null, NOW);
    expect(e.entitled).toBe(false);
    expect(e.reason).toBe("lapsed");
  });

  // auditoria R2: checkout abandonado / 3DS pendente cria a sub como `incomplete` e dispara
  // subscription.created → o trial puro NÃO pode ser bloqueado por uma assinatura que nunca pagou.
  it("incomplete (checkout abandonado / SCA pendente) → entitled, reason none (trial segue)", () => {
    const e = decideEntitlement("incomplete", null, NOW);
    expect(e.entitled).toBe(true);
    expect(e.reason).toBe("none");
  });

  it("incomplete_expired (terminal do incomplete ~23h) → entitled, reason none (nunca houve ciclo pago)", () => {
    const e = decideEntitlement("incomplete_expired", null, NOW);
    expect(e.entitled).toBe(true);
    expect(e.reason).toBe("none");
  });

  it("paused (sem cobrança ativa) → entitled, reason none", () => {
    const e = decideEntitlement("paused", null, NOW);
    expect(e.entitled).toBe(true);
    expect(e.reason).toBe("none");
  });

  it("fronteira da graça: grace_until exatamente == now → vencida (bloqueia)", () => {
    const e = decideEntitlement("past_due", new Date(NOW), NOW);
    expect(e.entitled).toBe(false); // > now é estrito; igual não está mais em graça
    expect(e.reason).toBe("lapsed");
  });

  it("transição completa active → past_due(graça) → past_due(lapsed)", () => {
    expect(decideEntitlement("active", null, NOW).reason).toBe("active");
    const g = future(168); // +7d
    expect(decideEntitlement("past_due", g, NOW).reason).toBe("grace");
    expect(decideEntitlement("past_due", g, future(200)).reason).toBe("lapsed"); // graça já passou
  });
});
