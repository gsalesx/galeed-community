/** M22-A — client REST mínimo do Nango (DECISÃO §4.6: sem SDK; a API REST cobre 100% do necessário,
 *  zero dependência nova — `fetch` nativo do Node ≥18). Tudo por env. Anti-SSRF: o único host de saída
 *  é NANGO_HOST (env) — NUNCA fetch de URL vinda de payload.
 *
 *  Contratos OFICIAIS (fixtures derivadas destes shapes — invariante #9):
 *   - webhooks:        https://nango.dev/docs/implementation-guides/platform/webhooks-from-nango (consulta 2026-06-12)
 *   - GET /records:    https://nango.dev/docs/reference/api/sync/records-list (consulta 2026-06-12)
 *   - connect session: https://nango.dev/docs/reference/api/connect/sessions/create (consulta 2026-06-12)
 *
 *  Env:
 *   - NANGO_SECRET_KEY    → Authorization: Bearer (records + connect sessions). Ausente ⇒ nangoConfigured() false.
 *   - NANGO_WEBHOOK_SECRET → signing key do HMAC do webhook (Environment Settings → Webhooks → Signing key —
 *                            NÃO é a secret da API). Ausente ⇒ webhook 503 (fail-closed).
 *   - NANGO_HOST          → base URL (opcional). Default https://api.nango.dev.
 *   - NANGO_MOCK=1        → createConnectSession determinística sem fetch (E2E sem conta — árbitro §4.6). */
import { createHmac, timingSafeEqual } from "node:crypto";

function nangoHost(): string {
  return (process.env.NANGO_HOST || "https://api.nango.dev").replace(/\/+$/, "");
}

/** Há secret key da API configurada? (records + connect sessions). */
export function nangoConfigured(): boolean {
  return !!process.env.NANGO_SECRET_KEY;
}

// ---------- verificação de assinatura do webhook (§2.1) ----------

/** Lê um header (case-insensitive na PRÁTICA: o node já normaliza pra lowercase em req.headers, mas
 *  aceitamos os dois por robustez). Array → primeiro valor. */
function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const lower = name.toLowerCase();
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === lower) {
      const v = headers[k];
      return Array.isArray(v) ? v[0] : v;
    }
  }
  return undefined;
}

export type VerifyResult = "valid" | "invalid" | "unconfigured";

/** Verificação da assinatura do webhook (doc §2.1): HMAC-SHA256 do RAW body com NANGO_WEBHOOK_SECRET,
 *  comparado ao header `x-nango-hmac-sha256` via crypto.timingSafeEqual (NUNCA ===; comprimentos
 *  diferentes → false, sem throw). O legado `x-nango-signature` (SHA-256 puro, deprecado) NÃO é
 *  aceito. Sem secret configurada → 'unconfigured' (o chamador responde 503 — a lib não decide HTTP). */
export function verifyNangoWebhook(
  rawBody: string | Buffer,
  headers: Record<string, string | string[] | undefined>,
): VerifyResult {
  const secret = process.env.NANGO_WEBHOOK_SECRET;
  if (!secret) return "unconfigured";

  // SÓ o HMAC vale (fail-closed): o header legado x-nango-signature é ignorado de propósito.
  const given = headerValue(headers, "x-nango-hmac-sha256");
  if (!given) return "invalid";

  const body = typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody;
  const expected = createHmac("sha256", secret).update(body).digest("hex");

  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(given, "utf8");
  // timingSafeEqual lança se os comprimentos diferem → guarda explícita (assinatura forjada de tamanho
  // diferente NUNCA derruba o processo; é só 'invalid').
  if (a.length !== b.length) return "invalid";
  return timingSafeEqual(a, b) ? "valid" : "invalid";
}

// ---------- shapes oficiais dos records (§2.2) ----------

export interface NangoMetadata {
  deleted_at: string | null;
  last_action: "ADDED" | "UPDATED" | "DELETED";
  first_seen_at: string;
  last_modified_at: string;
  cursor: string;
}
export interface NangoRecord {
  [key: string]: unknown;
  _nango_metadata: NangoMetadata;
}

export interface ListRecordsOpts {
  connectionId: string;
  providerConfigKey: string;
  model: string;
  cursor?: string;
  modifiedAfter?: string; // ISO — fallback quando ainda não há cursor nosso
  limit?: number; // default 100
}

/** GET {NANGO_HOST}/records (§2.2). Lança Error legível em !res.ok (status + corpo curto).
 *  NUNCA segue URL vinda de payload — o host vem SÓ do env (anti-SSRF). */
export async function listRecords(
  opts: ListRecordsOpts,
): Promise<{ records: NangoRecord[]; nextCursor: string | null }> {
  const url = new URL(`${nangoHost()}/records`);
  url.searchParams.set("model", opts.model);
  if (opts.cursor) url.searchParams.set("cursor", opts.cursor);
  if (!opts.cursor && opts.modifiedAfter) url.searchParams.set("modified_after", opts.modifiedAfter);
  url.searchParams.set("limit", String(opts.limit ?? 100));

  const res = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${process.env.NANGO_SECRET_KEY ?? ""}`,
      "Connection-Id": opts.connectionId,
      "Provider-Config-Key": opts.providerConfigKey,
    },
  });
  if (!res.ok) {
    const text = (await res.text().catch(() => "")).slice(0, 300);
    throw new Error(`Nango GET /records falhou (${res.status}): ${text}`);
  }
  const data = (await res.json()) as { records?: NangoRecord[]; next_cursor?: string | null };
  return { records: Array.isArray(data.records) ? data.records : [], nextCursor: data.next_cursor ?? null };
}

// ---------- connect session (§2.3) ----------

export interface ConnectSessionOpts {
  allowedIntegrations: string[]; // [provider_config_key da fonte]
  tags?: Record<string, string>; // { source_id, brain } — volta no auth webhook
}

/** POST {NANGO_HOST}/connect/sessions (§2.3). Lança em !res.ok.
 *  NANGO_MOCK=1 (árbitro §4.6) → resposta determinística SEM fetch (E2E/dev sem conta real). */
export async function createConnectSession(
  opts: ConnectSessionOpts,
): Promise<{ token: string; connectLink?: string; expiresAt: string }> {
  if (process.env.NANGO_MOCK === "1") {
    const pck = opts.allowedIntegrations[0] ?? "mock";
    const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
    return {
      token: `mock-connect-token-${pck}`,
      connectLink: `https://connect.nango.dev/mock/${pck}`,
      expiresAt,
    };
  }
  const res = await fetch(`${nangoHost()}/connect/sessions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.NANGO_SECRET_KEY ?? ""}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      allowed_integrations: opts.allowedIntegrations,
      ...(opts.tags ? { tags: opts.tags } : {}),
    }),
  });
  if (!res.ok) {
    const text = (await res.text().catch(() => "")).slice(0, 300);
    throw new Error(`Nango POST /connect/sessions falhou (${res.status}): ${text}`);
  }
  const json = (await res.json()) as { data?: { token?: string; connect_link?: string; expires_at?: string } };
  const d = json.data ?? {};
  if (!d.token) throw new Error("Nango devolveu sessão sem token.");
  return { token: d.token, connectLink: d.connect_link, expiresAt: d.expires_at ?? "" };
}
