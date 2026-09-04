// M-PAY-H (Onda 7) — INVARIANTE de disponibilidade: gateAndDebit faz FAIL-OPEN quando o DB falha
// (erro real, não saldo insuficiente). Decisão documentada do contrato (§Invariantes): "nunca derruba
// o produto por billing; o kill-switch de COGS em cost-quota é o backstop". Aqui mockamos a pool
// compartilhada p/ LANÇAR e provamos que o gate libera (ok:true, gated:false) sem propagar o erro.
// Também cobre o curto-circuito de custo 0 (facts/timeline nunca gateiam) sem tocar o DB.
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock da fronteira de conexão: getSharedSql lança → exercita o catch externo (fail-open).
vi.mock("../../src/core/platform/db-conn.ts", () => ({
  getSharedSql: vi.fn(async () => {
    throw new Error("db indisponível (simulado)");
  }),
  sharedSqlGeneration: () => 0,
}));

import { gateAndDebit, CREDIT_COST } from "../../src/core/platform/credits.ts";

describe("gateAndDebit — fail-open (M-PAY-H Onda 7)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("erro de DB no gate → LIBERA (fail-open: ok:true, gated:false, balance:null)", async () => {
    const r = await gateAndDebit("__brain_x", CREDIT_COST.ask, "ask", "k-1");
    expect(r.ok).toBe(true);
    expect(r.gated).toBe(false);
    expect(r.balance).toBeNull();
  });

  it("custo 0 (facts/timeline) curto-circuita ANTES do DB → passa livre sem tocar a pool", async () => {
    const r = await gateAndDebit("__brain_x", 0, "facts");
    expect(r.ok).toBe(true);
    expect(r.gated).toBe(false);
  });

  it("ingest com DB caído também libera (não bloqueia ingestão por falha de billing)", async () => {
    const r = await gateAndDebit("__brain_x", CREDIT_COST.ingest, "ingest");
    expect(r.ok).toBe(true);
    expect(r.gated).toBe(false);
  });
});
