/** M22-A — verifyNangoWebhook contra o FORMATO OFICIAL da assinatura do Nango.
 *
 *  Contrato oficial (invariante #9 — fixture derivada byte-a-byte da doc, consulta 2026-06-12):
 *  https://nango.dev/docs/implementation-guides/platform/webhooks-from-nango
 *  Header vigente = `X-Nango-Hmac-Sha256` = HMAC-SHA256 do RAW body com a webhook signing key
 *  (Environment Settings → Webhooks → Signing key — NÃO a API secret). O header legado
 *  `X-Nango-Signature` (SHA-256 puro, deprecado) NÃO deve ser aceito (fail-closed). */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash, createHmac } from "node:crypto";
import { verifyNangoWebhook } from "../../src/lib/nango.ts";

const SECRET = "whsec_m22a-seam-test";

// Payload do sync webhook — shape oficial (§2.1).
const SYNC_PAYLOAD = JSON.stringify({
  type: "sync",
  connectionId: "conn-m22a-seam",
  providerConfigKey: "conta-azul",
  syncName: "vendas",
  model: "Venda",
  syncType: "INCREMENTAL",
  success: true,
  modifiedAfter: "2026-06-12T00:00:00.000Z",
  responseResults: { added: 1, updated: 0, deleted: 0 },
});

function hmacHeader(body: string, secret = SECRET): Record<string, string> {
  return { "x-nango-hmac-sha256": createHmac("sha256", secret).update(Buffer.from(body, "utf8")).digest("hex") };
}

describe("verifyNangoWebhook (formato oficial X-Nango-Hmac-Sha256)", () => {
  const prev = process.env.NANGO_WEBHOOK_SECRET;
  beforeEach(() => {
    process.env.NANGO_WEBHOOK_SECRET = SECRET;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.NANGO_WEBHOOK_SECRET;
    else process.env.NANGO_WEBHOOK_SECRET = prev;
  });

  it("assinatura HMAC válida → 'valid'", () => {
    expect(verifyNangoWebhook(SYNC_PAYLOAD, hmacHeader(SYNC_PAYLOAD))).toBe("valid");
  });

  it("corpo adulterado (mesma assinatura) → 'invalid'", () => {
    const header = hmacHeader(SYNC_PAYLOAD);
    const tampered = SYNC_PAYLOAD.replace('"added":1', '"added":999');
    expect(verifyNangoWebhook(tampered, header)).toBe("invalid");
  });

  it("assinatura com secret ERRADA → 'invalid'", () => {
    expect(verifyNangoWebhook(SYNC_PAYLOAD, hmacHeader(SYNC_PAYLOAD, "secret-errada"))).toBe("invalid");
  });

  it("header ausente → 'invalid'", () => {
    expect(verifyNangoWebhook(SYNC_PAYLOAD, {})).toBe("invalid");
  });

  it("header legado x-nango-signature (SHA-256 puro) sozinho → 'invalid' (NÃO aceito)", () => {
    const legacy = createHash("sha256").update(SECRET + SYNC_PAYLOAD).digest("hex");
    expect(verifyNangoWebhook(SYNC_PAYLOAD, { "x-nango-signature": legacy })).toBe("invalid");
  });

  it("comprimento divergente da assinatura NÃO lança (retorna 'invalid')", () => {
    expect(() => verifyNangoWebhook(SYNC_PAYLOAD, { "x-nango-hmac-sha256": "abc123" })).not.toThrow();
    expect(verifyNangoWebhook(SYNC_PAYLOAD, { "x-nango-hmac-sha256": "abc123" })).toBe("invalid");
  });

  it("aceita Buffer como rawBody (HMAC sobre os bytes)", () => {
    expect(verifyNangoWebhook(Buffer.from(SYNC_PAYLOAD, "utf8"), hmacHeader(SYNC_PAYLOAD))).toBe("valid");
  });

  it("sem NANGO_WEBHOOK_SECRET → 'unconfigured' (fail-closed; a lib não decide HTTP)", () => {
    delete process.env.NANGO_WEBHOOK_SECRET;
    expect(verifyNangoWebhook(SYNC_PAYLOAD, hmacHeader(SYNC_PAYLOAD))).toBe("unconfigured");
  });
});
