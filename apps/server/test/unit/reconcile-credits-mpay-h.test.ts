// M-PAY-H (Onda 6) — RECONCILIAÇÃO do ledger de créditos. Prova a INVARIANTE de dinheiro do contrato:
// `sum(ledger.delta) == wallet.balance` e `trial_remaining` coerente (nunca acima do saldo). Carteira
// consistente → consistent=true; drift sintético (saldo ≠ soma do razão; trial > saldo) → detecta.
import { describe, it, expect } from "vitest";
import { reconcileWalletRow } from "../../src/core/platform/credits.ts";

describe("reconcileWalletRow (PURA) — invariante sum(ledger.delta) == balance", () => {
  it("carteira consistente → consistent=true, drift zero", () => {
    // razão: +1000 trial, -994 gasto → soma 6; carteira balance=6, trial_remaining=0 (gastou tudo).
    const d = reconcileWalletRow({
      accountId: "acc_ok",
      balance: 6,
      ledgerSum: 6,
      trialRemaining: 0,
      trialGrant: 1000,
      trialExpired: -1000, // (modelado como expiração/gasto do trial)
    });
    expect(d.consistent).toBe(true);
    expect(d.balanceDrift).toBe(0);
    expect(d.trialDrift).toBe(0);
    expect(d.trialOverBalance).toBe(false);
  });

  it("trial vivo coerente (grant 1000, nada expirado, balance 1000) → consistente", () => {
    const d = reconcileWalletRow({
      accountId: "acc_trial",
      balance: 1000,
      ledgerSum: 1000,
      trialRemaining: 1000,
      trialGrant: 1000,
      trialExpired: 0,
    });
    expect(d.consistent).toBe(true);
    expect(d.trialExpected).toBe(1000);
  });

  it("DRIFT de saldo: carteira diz 500 mas o razão soma 480 → detecta balanceDrift=20", () => {
    const d = reconcileWalletRow({
      accountId: "acc_drift",
      balance: 500,
      ledgerSum: 480,
      trialRemaining: 0,
      trialGrant: 1000,
      trialExpired: -1000,
    });
    expect(d.consistent).toBe(false);
    expect(d.balanceDrift).toBe(20);
  });

  it("DRIFT de trial: trial_remaining acima do saldo → trialOverBalance + inconsistente", () => {
    const d = reconcileWalletRow({
      accountId: "acc_trial_over",
      balance: 100,
      ledgerSum: 100,
      trialRemaining: 300, // não pode haver mais trial vivo do que saldo total
      trialGrant: 1000,
      trialExpired: 0,
    });
    expect(d.trialOverBalance).toBe(true);
    expect(d.consistent).toBe(false);
    // esperado é clampado ao saldo (100); drift = 300 - 100 = 200
    expect(d.trialExpected).toBe(100);
    expect(d.trialDrift).toBe(200);
  });
});
