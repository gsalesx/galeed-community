/** ChatGPT subscription via Codex OAuth (mesmo caminho do Hermes / Codex CLI).
 *
 *  Precedência: tokens no Postgres do brain (`galeed_llm_oauth`) > `~/.codex/auth.json`
 *  (só fallback de dev local). Renova em `auth.openai.com` e chama
 *  `https://chatgpt.com/backend-api/codex/responses` — sem OPENAI_API_KEY.
 *
 *  Headers `originator`/`User-Agent`/`ChatGPT-Account-ID` espelham o codex-rs
 *  (Cloudflare na frente do endpoint exige originator whitelisted). */
import { AsyncLocalStorage } from "node:async_hooks";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import {
  CODEX_PROVIDER,
  getLlmOauth,
  getUniqueLlmOauth,
  upsertLlmOauth,
  type LlmOauthTokens,
} from "../core/platform/llm-oauth.ts";

export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
export const CODEX_DEVICE_ISSUER = "https://auth.openai.com";
const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
const REFRESH_SKEW_SEC = 120;

const brainAls = new AsyncLocalStorage<string>();

/** Marca o brain do request/job para leitura de tokens no banco. */
export function bindCodexBrain(brain: string): void {
  if (brain) brainAls.enterWith(brain);
}

export function getCodexBrain(): string | undefined {
  return brainAls.getStore();
}

export function withCodexBrain<T>(brain: string, fn: () => Promise<T>): Promise<T> {
  return brainAls.run(brain, fn);
}

export interface CodexUsage {
  input_tokens: number;
  output_tokens: number;
}

type CodexTokens = LlmOauthTokens;

type TokenSource = { tokens: CodexTokens; raw: any; brain?: string };

function authPath(): string {
  const home = (process.env.CODEX_HOME || "").trim() || join(homedir(), ".codex");
  return join(home, "auth.json");
}

function decodeJwtClaims(token: string): Record<string, any> {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return {};
    const payload = parts[1] + "=".repeat((4 - (parts[1].length % 4)) % 4);
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return {};
  }
}

function isExpiring(accessToken: string, skewSec = REFRESH_SKEW_SEC): boolean {
  const exp = decodeJwtClaims(accessToken).exp;
  if (typeof exp !== "number") return false;
  return exp <= Date.now() / 1000 + skewSec;
}

/** ISO do `exp` do access_token — só metadado pra UI, nunca o token. */
export function accessTokenExpiresAt(accessToken: string): string | undefined {
  const exp = decodeJwtClaims(accessToken).exp;
  if (typeof exp !== "number") return undefined;
  return new Date(exp * 1000).toISOString();
}

function chatgptAccountId(accessToken: string): string | undefined {
  const auth = decodeJwtClaims(accessToken)["https://api.openai.com/auth"];
  const id = auth?.chatgpt_account_id;
  return typeof id === "string" && id ? id : undefined;
}

function codexHeaders(accessToken: string): Record<string, string> {
  const h: Record<string, string> = {
    authorization: `Bearer ${accessToken}`,
    "content-type": "application/json",
    "User-Agent": "codex_cli_rs/0.0.0 (Galeed)",
    originator: "codex_cli_rs",
  };
  const acct = chatgptAccountId(accessToken);
  if (acct) h["ChatGPT-Account-ID"] = acct;
  return h;
}

function readAuthFile(): TokenSource | null {
  const path = authPath();
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    const tokens = raw?.tokens;
    if (!tokens?.access_token || !tokens?.refresh_token) return null;
    return {
      tokens: {
        access_token: String(tokens.access_token),
        refresh_token: String(tokens.refresh_token),
        id_token: tokens.id_token ? String(tokens.id_token) : undefined,
        account_id: tokens.account_id ? String(tokens.account_id) : undefined,
      },
      raw,
    };
  } catch {
    return null;
  }
}

function writeFileTokens(raw: any, tokens: CodexTokens): void {
  const path = authPath();
  const next = { ...raw, auth_mode: raw?.auth_mode || "chatgpt", tokens: { ...raw?.tokens, ...tokens } };
  writeFileSync(path, JSON.stringify(next, null, 2), "utf8");
}

async function loadDbSource(preferBrain?: string): Promise<TokenSource | null> {
  const brain = preferBrain || getCodexBrain();
  try {
    if (brain) {
      const row = await getLlmOauth(brain, CODEX_PROVIDER);
      if (row) return { tokens: row.tokens, raw: null, brain: row.brain };
      return null; // brain conhecido sem tokens — não usa OAuth de outro tenant
    }
    // CLI / processo sem ALS: uma única linha no banco (VPS de um cérebro).
    const unique = await getUniqueLlmOauth(CODEX_PROVIDER);
    if (unique) return { tokens: unique.tokens, raw: null, brain: unique.brain };
  } catch {
    /* sem DATABASE_URL / tabela — cai no arquivo */
  }
  return null;
}

async function persistTokens(source: TokenSource, tokens: CodexTokens): Promise<void> {
  if (source.brain) {
    try {
      await upsertLlmOauth(source.brain, tokens, CODEX_PROVIDER);
    } catch {
      /* best-effort — token em memória ainda serve nesta chamada */
    }
    return;
  }
  try {
    writeFileTokens(source.raw, tokens);
  } catch {
    /* best-effort */
  }
}

async function refreshTokens(source: TokenSource): Promise<CodexTokens> {
  const res = await fetch(CODEX_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: source.tokens.refresh_token,
      client_id: CODEX_CLIENT_ID,
    }),
  });
  if (!res.ok) {
    throw new Error(
      `ChatGPT/Codex: falha ao renovar token (${res.status}). Conecte de novo em Conectar → ChatGPT.`,
    );
  }
  const j: any = await res.json();
  const access = String(j.access_token || "").trim();
  if (!access) throw new Error("ChatGPT/Codex: refresh sem access_token.");
  const updated: CodexTokens = {
    ...source.tokens,
    access_token: access,
    refresh_token: typeof j.refresh_token === "string" && j.refresh_token.trim() ? j.refresh_token.trim() : source.tokens.refresh_token,
  };
  await persistTokens(source, updated);
  return updated;
}

/** True se existe `~/.codex/auth.json` (dev local). Produção usa o banco — ver hasCodexCredentials. */
export function hasCodexAuth(): boolean {
  return !!readAuthFile();
}

/** Banco do brain (ou linha única) primeiro; arquivo só em dev. */
export async function hasCodexCredentials(brain?: string): Promise<boolean> {
  if (await loadDbSource(brain)) return true;
  return !!readAuthFile();
}

async function resolveAccessToken(): Promise<string> {
  // Precedência: banco do brain > arquivo ~/.codex (dev local).
  const source = (await loadDbSource()) || readAuthFile();
  if (!source) {
    throw new Error(
      "ChatGPT/Codex: sem credenciais. Conecte em Conectar → ChatGPT, ou (só em dev) autentique o Codex CLI (`~/.codex/auth.json`).",
    );
  }
  let tokens = source.tokens;
  if (isExpiring(tokens.access_token)) {
    tokens = await refreshTokens(source);
  }
  return tokens.access_token;
}

function extractOutputText(data: any): string {
  if (typeof data?.output_text === "string" && data.output_text.trim()) return data.output_text.trim();
  const parts: string[] = [];
  for (const item of data?.output || []) {
    if (item?.type !== "message") continue;
    for (const c of item.content || []) {
      if (c?.type === "output_text" && typeof c.text === "string") parts.push(c.text);
    }
  }
  return parts.join("").trim();
}

/** Chamada de texto via assinatura ChatGPT (Responses API / Codex backend).
 *  O endpoint exige stream:true + store:false + instructions não-vazio. */
export async function codexText(
  model: string,
  prompt: string,
  system = "",
  onUsage?: (u: CodexUsage) => void,
): Promise<string> {
  const access = await resolveAccessToken();
  const base = (process.env.GALEED_CODEX_BASE_URL || CODEX_BASE_URL).replace(/\/$/, "");
  const instructions = (system || "").trim() || "You are a helpful assistant. Follow the user instructions carefully.";
  const body: Record<string, unknown> = {
    model,
    instructions,
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: prompt }],
      },
    ],
    store: false,
    stream: true,
  };

  const res = await fetch(`${base}/responses`, {
    method: "POST",
    headers: {
      ...codexHeaders(access),
      accept: "text/event-stream",
      "OpenAI-Beta": "responses=experimental",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`ChatGPT/Codex ${res.status}: ${(await res.text()).slice(0, 400)}`);
  }
  if (!res.body) throw new Error("ChatGPT/Codex: resposta sem body (stream).");

  const { text, usage } = await consumeResponsesSse(res.body);
  if (onUsage && usage) onUsage(usage);
  if (!text) throw new Error("ChatGPT/Codex: resposta sem texto.");
  return text;
}

/** Consome SSE do Responses API; devolve texto final + usage do evento completed. */
async function consumeResponsesSse(body: ReadableStream<Uint8Array>): Promise<{ text: string; usage?: CodexUsage }> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let deltas = "";
  let finalText = "";
  let usage: CodexUsage | undefined;

  const handleEvent = (payload: string) => {
    if (!payload || payload === "[DONE]") return;
    let ev: any;
    try {
      ev = JSON.parse(payload);
    } catch {
      return;
    }
    const type = String(ev?.type || "");
    if (type === "response.output_text.delta" || type.endsWith("output_text.delta")) {
      const d = ev.delta ?? ev.text;
      if (typeof d === "string") deltas += d;
      return;
    }
    if (type === "response.completed" || type === "response.incomplete") {
      const snap = ev.response || ev;
      finalText = extractOutputText(snap) || finalText;
      if (snap?.usage) {
        usage = {
          input_tokens: Number(snap.usage.input_tokens ?? 0),
          output_tokens: Number(snap.usage.output_tokens ?? 0),
        };
      }
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of chunk.split(/\r?\n/)) {
        if (line.startsWith("data:")) handleEvent(line.slice(5).trim());
      }
    }
  }
  if (buf.trim()) {
    for (const line of buf.split(/\r?\n/)) {
      if (line.startsWith("data:")) handleEvent(line.slice(5).trim());
    }
  }

  return { text: (finalText || deltas).trim(), usage };
}

/** Modelo default quando o caller ainda passa alias Anthropic (haiku/sonnet). */
export function resolveCodexModel(requested: string): string {
  const env = (process.env.GALEED_CODEX_MODEL || "").trim();
  if (env) return env;
  if (/gpt|o\d|codex/i.test(requested)) return requested;
  return "gpt-5.4-mini";
}
