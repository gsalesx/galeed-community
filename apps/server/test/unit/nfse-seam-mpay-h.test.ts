// M-PAY-H (Onda 5) — endurecimento do seam NFS-e (Spedy). Prova o contrato com fetch + DB mockados
// (sem credenciais reais): (a) no-op 'skipped' sem token; (b) com token faz POST com payload correto;
// (c) idempotente por event_id (reprocesso → 'duplicate', sem 2º POST); (d) fail-soft em erro
// ('error', NUNCA lança). Mantém flagado por SPEDY_API_TOKEN.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Fake do `sql` tagged-template compartilhado: guarda 1 linha por event_id em memória para honrar o
// `on conflict (event_id) do nothing` (idempotência) e os `update ... where event_id`.
const rows = new Map<string, any>();
function fakeSql(strings: TemplateStringsArray, ...values: any[]): any {
  const q = strings.join("?").toLowerCase();
  if (q.includes("insert into galeed_nfse_emissions")) {
    const [eventId, accountId, , amountCents] = values; // (event_id, account_id, 'pending', amount)
    if (rows.has(eventId)) return Promise.resolve([]); // do nothing → claim vazio
    rows.set(eventId, { event_id: eventId, account_id: accountId, status: "pending", amount_cents: amountCents });
    return Promise.resolve([{ event_id: eventId }]);
  }
  if (q.includes("update galeed_nfse_emissions")) {
    const eventId = values[values.length - 1]; // último binding é o where event_id
    const row = rows.get(eventId);
    if (row) {
      if (q.includes("set status = 'skipped'")) row.status = "skipped";
      else if (q.includes("set status = 'failed'")) row.status = "failed";
      else if (q.includes("set status = 'error'")) row.status = "error";
      else if (q.includes("set status = 'requested'")) row.status = "requested";
    }
    return Promise.resolve([]);
  }
  return Promise.resolve([]);
}
(fakeSql as any).unsafe = vi.fn(async () => {}); // DDL idempotente no boot lazy

vi.mock("../../src/core/platform/db-conn.ts", () => ({
  getSharedSql: vi.fn(async () => fakeSql),
  sharedSqlGeneration: vi.fn(() => 0),
}));

import { emitNfse } from "../../src/core/platform/nfse.ts";

const baseInput = {
  accountId: "acct_1",
  amountCents: 11900, // R$119,00
  description: "Galeed — assinatura",
  receiver: { name: "Fulano", email: "f@ex.com", taxId: "12345678000190" },
};

describe("seam NFS-e Spedy (M-PAY-H Onda 5)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    rows.clear();
    delete process.env.SPEDY_API_TOKEN;
    delete process.env.SPEDY_API_BASE;
    fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ id: "nf_123" }) }) as any);
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...savedEnv };
  });

  it("(a) sem SPEDY_API_TOKEN → no-op 'skipped', NÃO faz POST", async () => {
    const r = await emitNfse({ eventId: "evt_a", ...baseInput });
    expect(r.status).toBe("skipped");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(rows.get("evt_a")?.status).toBe("skipped");
  });

  it("(b) com token → POST para {base}/invoices com auth e payload corretos", async () => {
    process.env.SPEDY_API_TOKEN = "tok_secret";
    process.env.SPEDY_API_BASE = "https://api.spedy.test/";
    process.env.SPEDY_ISS_RATE = "0.02";
    const r = await emitNfse({ eventId: "evt_b", ...baseInput });
    expect(r.status).toBe("requested");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.spedy.test/invoices"); // barra final normalizada
    expect(opts.method).toBe("POST");
    expect(opts.headers.Authorization).toBe("Bearer tok_secret");
    expect(opts.headers["Content-Type"]).toBe("application/json");
    const payload = JSON.parse(opts.body);
    expect(payload.description).toBe("Galeed — assinatura");
    expect(payload.receiver.federalTaxNumber).toBe("12345678000190");
    expect(payload.total.invoiceAmount).toBe(119); // centavos → reais
    expect(payload.total.issRate).toBe(0.02);
    expect(rows.get("evt_b")?.status).toBe("requested");
  });

  it("(c) idempotente por event_id → reprocesso retorna 'duplicate' e NÃO faz 2º POST", async () => {
    process.env.SPEDY_API_TOKEN = "tok_secret";
    const r1 = await emitNfse({ eventId: "evt_c", ...baseInput });
    const r2 = await emitNfse({ eventId: "evt_c", ...baseInput });
    expect(r1.status).toBe("requested");
    expect(r2.status).toBe("duplicate");
    expect(fetchMock).toHaveBeenCalledTimes(1); // só a 1ª reivindicação chamou a Spedy
  });

  it("(d) fail-soft: erro de rede → status 'error', NUNCA lança", async () => {
    process.env.SPEDY_API_TOKEN = "tok_secret";
    fetchMock.mockRejectedValueOnce(new Error("ECONNRESET"));
    const r = await emitNfse({ eventId: "evt_d", ...baseInput });
    expect(r.status).toBe("error");
    expect(rows.get("evt_d")?.status).toBe("error");
  });

  it("(d') fail-soft: HTTP não-ok da Spedy → 'error', NÃO lança", async () => {
    process.env.SPEDY_API_TOKEN = "tok_secret";
    fetchMock.mockResolvedValueOnce({ ok: false, status: 422, json: async () => ({}) } as any);
    const r = await emitNfse({ eventId: "evt_e", ...baseInput });
    expect(r.status).toBe("error");
  });

  it("input sem eventId → 'error' (fail-soft), NÃO toca DB nem rede", async () => {
    process.env.SPEDY_API_TOKEN = "tok_secret";
    const r = await emitNfse({ eventId: "", ...baseInput });
    expect(r.status).toBe("error");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
