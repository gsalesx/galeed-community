/** Evolution API (WhatsApp) — config por brain + helpers HTTP.
 *  O Galeed NÃO embute a Evolution: só proxy/orquestra (QR, status, webhook → ingestor). */
import { getSharedSql, sharedSqlGeneration } from "./db-conn.ts";

export interface EvolutionBrainConfig {
  brain: string;
  instanceName: string;
  /** Token cru gld_ do bot WhatsApp — usado só no webhook (?token=). Nunca devolver à UI. */
  ingestToken: string;
  principalId: string;
  enabled: boolean;
  lastError: string | null;
}

let _ready: Promise<void> | null = null;
let _readyGeneration = -1;

async function db(): Promise<any> {
  const sql = await getSharedSql();
  const gen = sharedSqlGeneration();
  if (_ready && _readyGeneration === gen) {
    await _ready;
    return sql;
  }
  _readyGeneration = gen;
  _ready = (async () => {
    await sql.unsafe(`
      create table if not exists galeed_evolution (
        brain text primary key,
        instance_name text not null,
        ingest_token text not null,
        principal_id text not null,
        enabled boolean not null default true,
        last_error text
      )`);
  })();
  await _ready;
  return sql;
}

/** Nome estável da instância Evolution a partir do brain. */
export function evolutionInstanceName(brain: string): string {
  const slug = brain.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return `galeed-${slug || "brain"}`;
}

/** Extrai QR base64 das formas comuns da Evolution v2. */
export function extractQrBase64(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  const qr = d.qrcode;
  const candidates: unknown[] = [
    typeof qr === "object" && qr ? (qr as Record<string, unknown>).base64 : null,
    d.base64,
    typeof qr === "object" && qr ? (qr as Record<string, unknown>).code : null,
  ];
  for (const c of candidates) {
    if (typeof c !== "string" || c.length < 40) continue;
    // "code" da Evolution às vezes é o payload do WA Web (2@…), não imagem — só aceita base64/data-URL.
    if (c.startsWith("data:image")) return c;
    if (/^[A-Za-z0-9+/=\s]+$/.test(c) && c.length > 200) {
      return `data:image/png;base64,${c.replace(/\s+/g, "")}`;
    }
  }
  return null;
}

export function evolutionEnv(): { apiUrl: string; apiKey: string; webhookBase: string } | null {
  const apiUrl = (process.env.EVOLUTION_API_URL || "").trim().replace(/\/$/, "");
  const apiKey = (process.env.EVOLUTION_API_KEY || "").trim();
  if (!apiUrl || !apiKey) return null;
  const webhookBase = (process.env.EVOLUTION_WEBHOOK_BASE || "").trim().replace(/\/$/, "")
    || "http://gateway:8790";
  return { apiUrl, apiKey, webhookBase };
}

export async function getEvolutionConfig(brain: string): Promise<EvolutionBrainConfig | null> {
  const sql = await db();
  const rows = (await sql`select * from galeed_evolution where brain = ${brain} limit 1`) as any[];
  if (!rows.length) return null;
  const r = rows[0];
  return {
    brain,
    instanceName: r.instance_name,
    ingestToken: r.ingest_token,
    principalId: r.principal_id,
    enabled: r.enabled === true,
    lastError: r.last_error ?? null,
  };
}

export async function upsertEvolutionConfig(
  brain: string,
  input: { instanceName: string; ingestToken: string; principalId: string; enabled?: boolean; lastError?: string | null },
): Promise<void> {
  const sql = await db();
  await sql`
    insert into galeed_evolution (brain, instance_name, ingest_token, principal_id, enabled, last_error)
    values (${brain}, ${input.instanceName}, ${input.ingestToken}, ${input.principalId},
            ${input.enabled ?? true}, ${input.lastError ?? null})
    on conflict (brain) do update set
      instance_name = excluded.instance_name,
      ingest_token = excluded.ingest_token,
      principal_id = excluded.principal_id,
      enabled = excluded.enabled,
      last_error = excluded.last_error`;
}

export async function setEvolutionLastError(brain: string, err: string | null): Promise<void> {
  const sql = await db();
  await sql`update galeed_evolution set last_error = ${err} where brain = ${brain}`;
}

/** HTTP contra a Evolution. Lança Error com mensagem legível. */
export async function evolutionFetch(path: string, init?: RequestInit): Promise<{ status: number; json: any }> {
  const env = evolutionEnv();
  if (!env) throw new Error("Evolution não configurada (EVOLUTION_API_URL / EVOLUTION_API_KEY).");
  const res = await fetch(`${env.apiUrl}${path.startsWith("/") ? path : `/${path}`}`, {
    ...init,
    headers: {
      apikey: env.apiKey,
      "Content-Type": "application/json",
      ...(init?.headers as Record<string, string> | undefined),
    },
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const msg =
      (typeof json?.message === "string" && json.message) ||
      (typeof json?.error === "string" && json.error) ||
      (typeof json?.response?.message === "string" && json.response.message) ||
      `Evolution HTTP ${res.status}`;
    throw new Error(msg);
  }
  return { status: res.status, json };
}

export function webhookUrlFor(token: string): string {
  const env = evolutionEnv();
  if (!env) throw new Error("Evolution não configurada.");
  return `${env.webhookBase}/v1/ingestors/evolution-whatsapp?token=${encodeURIComponent(token)}`;
}
