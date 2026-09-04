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
      );
      create table if not exists galeed_evolution_instances (
        brain text not null,
        instance_name text not null,
        last_error text,
        enabled boolean not null default true,
        primary key (brain, instance_name)
      );
      insert into galeed_evolution_instances (brain, instance_name, last_error, enabled)
      select brain, instance_name, last_error, enabled
      from galeed_evolution
      where instance_name is not null and instance_name <> ''
      on conflict do nothing`);
  })();
  await _ready;
  return sql;
}

export interface EvolutionInstanceRow {
  brain: string;
  instanceName: string;
  lastError: string | null;
  enabled: boolean;
}

/** Nome estável da instância Evolution a partir do brain. slot 2+ vira sufixo `-2`. */
export function evolutionInstanceName(brain: string, slot = 1): string {
  const slug = brain.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  const base = `galeed-${slug || "brain"}`;
  return slot <= 1 ? base : `${base}-${slot}`;
}

/** Próximo instanceName livre neste cérebro (`galeed-x`, `galeed-x-2`, …). */
export function nextEvolutionInstanceName(brain: string, existing: string[]): string {
  const taken = new Set(existing);
  for (let slot = 1; slot < 100; slot++) {
    const n = evolutionInstanceName(brain, slot);
    if (!taken.has(n)) return n;
  }
  throw new Error("Limite de contas WhatsApp neste cérebro.");
}

/** DDI+DDD+número só dígitos (E.164 sem +). */
export function normalizeWhatsAppNumber(raw: string): string {
  const digits = String(raw || "").replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 15) {
    throw new Error("Número inválido — use DDI+DDD+número (ex. 5511999998888).");
  }
  return digits;
}

export function isZombieEvolutionState(state: string | null | undefined): boolean {
  if (!state) return false;
  const s = state.toLowerCase();
  return s === "close" || s === "closed" || s.includes("not connection") || s === "refused";
}

/** Código de emparelhamento (8 chars) das formas comuns da Evolution v2. */
export function extractPairingCode(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  const qr = d.qrcode;
  const candidates: unknown[] = [
    d.pairingCode,
    d.pairing_code,
    typeof qr === "object" && qr ? (qr as Record<string, unknown>).pairingCode : null,
    typeof qr === "object" && qr ? (qr as Record<string, unknown>).pairing_code : null,
  ];
  for (const c of candidates) {
    if (typeof c !== "string") continue;
    const code = c.replace(/\s+/g, "").toUpperCase();
    if (/^[A-Z0-9]{8}$/.test(code)) return code;
  }
  return null;
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

export async function listEvolutionInstances(brain: string): Promise<EvolutionInstanceRow[]> {
  const sql = await db();
  const rows = (await sql`
    select * from galeed_evolution_instances where brain = ${brain} order by instance_name`) as any[];
  return rows.map((r) => ({
    brain,
    instanceName: r.instance_name,
    lastError: r.last_error ?? null,
    enabled: r.enabled === true,
  }));
}

export async function upsertEvolutionInstance(
  brain: string,
  instanceName: string,
  lastError: string | null = null,
): Promise<void> {
  const sql = await db();
  await sql`
    insert into galeed_evolution_instances (brain, instance_name, last_error, enabled)
    values (${brain}, ${instanceName}, ${lastError}, true)
    on conflict (brain, instance_name) do update set
      last_error = excluded.last_error,
      enabled = true`;
}

export async function removeEvolutionInstance(brain: string, instanceName: string): Promise<void> {
  const sql = await db();
  await sql`delete from galeed_evolution_instances where brain = ${brain} and instance_name = ${instanceName}`;
}

export async function setEvolutionInstanceError(
  brain: string,
  instanceName: string,
  err: string | null,
): Promise<void> {
  const sql = await db();
  await sql`
    update galeed_evolution_instances set last_error = ${err}
    where brain = ${brain} and instance_name = ${instanceName}`;
  await setEvolutionLastError(brain, err);
}

type EvolutionFetchInit = RequestInit & { timeoutMs?: number };

function flattenEvolutionMessage(json: any, status: number): string {
  const candidates = [json?.message, json?.error, json?.response?.message];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c;
    if (Array.isArray(c)) {
      const flat = c.flat(Infinity).filter((x) => typeof x === "string").join("; ");
      if (flat) return flat;
    }
  }
  return `Evolution HTTP ${status}`;
}

/** HTTP contra a Evolution. Lança Error com mensagem legível. Timeout padrão 15s. */
export async function evolutionFetch(path: string, init?: EvolutionFetchInit): Promise<{ status: number; json: any }> {
  const env = evolutionEnv();
  if (!env) throw new Error("Evolution não configurada (EVOLUTION_API_URL / EVOLUTION_API_KEY).");
  const timeoutMs = init?.timeoutMs ?? 15_000;
  const { timeoutMs: _timeoutMs, ...rest } = (init ?? {}) as EvolutionFetchInit;
  void _timeoutMs;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${env.apiUrl}${path.startsWith("/") ? path : `/${path}`}`, {
      ...rest,
      signal: ctrl.signal,
      headers: {
        apikey: env.apiKey,
        "Content-Type": "application/json",
        ...(rest.headers as Record<string, string> | undefined),
      },
    });
  } catch (err) {
    if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) {
      throw new Error(`Evolution não respondeu em ${Math.round(timeoutMs / 1000)}s (${path}).`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    throw new Error(flattenEvolutionMessage(json, res.status));
  }
  return { status: res.status, json };
}

export function webhookUrlFor(token: string): string {
  const env = evolutionEnv();
  if (!env) throw new Error("Evolution não configurada.");
  return `${env.webhookBase}/v1/ingestors/evolution-whatsapp?token=${encodeURIComponent(token)}`;
}
