/** BFF ChatGPT/Codex OAuth (device flow do Hermes openai-codex).
 *  Tokens ficam em galeed_llm_oauth por brain. Nunca devolve client secret nem tokens à UI. */
import {
  CODEX_CLIENT_ID,
  CODEX_DEVICE_ISSUER,
  CODEX_TOKEN_URL,
  accessTokenExpiresAt,
  bindCodexBrain,
} from "../../lib/chatgpt-codex.ts";
import {
  CODEX_PROVIDER,
  deleteLlmOauth,
  getLlmOauth,
  upsertLlmOauth,
} from "../../core/platform/llm-oauth.ts";
import { BffError } from "./bff-common.ts";

export interface CodexStatusView {
  connected: boolean;
  expiresAt?: string;
  pending?: boolean;
  userCode?: string;
  verificationUrl?: string;
}

export interface CodexStartView {
  verificationUrl: string;
  userCode: string;
  interval: number;
}

interface PendingDevice {
  deviceAuthId: string;
  userCode: string;
  verificationUrl: string;
  interval: number;
  startedAt: number;
}

const pendingByBrain = new Map<string, PendingDevice>();
const PENDING_TTL_MS = 15 * 60 * 1000;

function pendingOf(brain: string): PendingDevice | undefined {
  const p = pendingByBrain.get(brain);
  if (!p) return undefined;
  if (Date.now() - p.startedAt > PENDING_TTL_MS) {
    pendingByBrain.delete(brain);
    return undefined;
  }
  return p;
}

/** GET /api/llm/codex/status */
export async function codexStatusHandler(home: string): Promise<CodexStatusView> {
  bindCodexBrain(home);
  const row = await getLlmOauth(home, CODEX_PROVIDER);
  if (row) {
    const expiresAt = accessTokenExpiresAt(row.tokens.access_token);
    return { connected: true, ...(expiresAt ? { expiresAt } : {}) };
  }
  const pending = pendingOf(home);
  if (pending) {
    return {
      connected: false,
      pending: true,
      userCode: pending.userCode,
      verificationUrl: pending.verificationUrl,
    };
  }
  return { connected: false };
}

/** POST /api/llm/codex/start — pede user_code; a UI abre verificationUrl. */
export async function codexStartHandler(home: string): Promise<CodexStartView> {
  bindCodexBrain(home);
  const res = await fetch(`${CODEX_DEVICE_ISSUER}/api/accounts/deviceauth/usercode`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ client_id: CODEX_CLIENT_ID }),
  });
  if (!res.ok) {
    throw new BffError(502, `ChatGPT recusou o início do login (${res.status}). Tente de novo.`);
  }
  const data: any = await res.json();
  const userCode = String(data?.user_code || "").trim();
  const deviceAuthId = String(data?.device_auth_id || "").trim();
  const interval = Math.max(3, Number(data?.interval) || 5);
  const verificationUrl =
    (typeof data?.verification_uri_complete === "string" && data.verification_uri_complete.trim()) ||
    (typeof data?.verification_uri === "string" && data.verification_uri.trim()) ||
    `${CODEX_DEVICE_ISSUER}/codex/device`;
  if (!userCode || !deviceAuthId) {
    throw new BffError(502, "ChatGPT não devolveu o código de aprovação.");
  }
  pendingByBrain.set(home, {
    deviceAuthId,
    userCode,
    verificationUrl,
    interval,
    startedAt: Date.now(),
  });
  return { verificationUrl, userCode, interval };
}

/** POST /api/llm/codex/poll — uma rodada; a UI repete até connected. */
export async function codexPollHandler(home: string): Promise<CodexStatusView> {
  bindCodexBrain(home);
  const pending = pendingOf(home);
  if (!pending) {
    const existing = await getLlmOauth(home, CODEX_PROVIDER);
    if (existing) {
      const expiresAt = accessTokenExpiresAt(existing.tokens.access_token);
      return { connected: true, ...(expiresAt ? { expiresAt } : {}) };
    }
    throw new BffError(400, "Clique em Conectar ChatGPT primeiro.");
  }

  const poll = await fetch(`${CODEX_DEVICE_ISSUER}/api/accounts/deviceauth/token`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ device_auth_id: pending.deviceAuthId, user_code: pending.userCode }),
  });

  if (poll.status === 403 || poll.status === 404) {
    return {
      connected: false,
      pending: true,
      userCode: pending.userCode,
      verificationUrl: pending.verificationUrl,
    };
  }
  if (!poll.ok) {
    throw new BffError(502, `ChatGPT falhou ao confirmar o login (${poll.status}).`);
  }

  const codeResp: any = await poll.json();
  const authorizationCode = String(codeResp?.authorization_code || "").trim();
  const codeVerifier = String(codeResp?.code_verifier || "").trim();
  if (!authorizationCode || !codeVerifier) {
    throw new BffError(502, "ChatGPT aprovou, mas não devolveu o código de troca.");
  }

  const tokenRes = await fetch(CODEX_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: authorizationCode,
      redirect_uri: `${CODEX_DEVICE_ISSUER}/deviceauth/callback`,
      client_id: CODEX_CLIENT_ID,
      code_verifier: codeVerifier,
    }),
  });
  if (!tokenRes.ok) {
    throw new BffError(502, `Não deu pra concluir o login ChatGPT (${tokenRes.status}).`);
  }
  const tokens: any = await tokenRes.json();
  const access = String(tokens?.access_token || "").trim();
  const refresh = String(tokens?.refresh_token || "").trim();
  if (!access || !refresh) {
    throw new BffError(502, "Login ChatGPT sem tokens — tente Conectar de novo.");
  }

  await upsertLlmOauth(home, {
    access_token: access,
    refresh_token: refresh,
    id_token: typeof tokens.id_token === "string" ? tokens.id_token : undefined,
  });
  pendingByBrain.delete(home);
  const expiresAt = accessTokenExpiresAt(access);
  return { connected: true, ...(expiresAt ? { expiresAt } : {}) };
}

/** POST /api/llm/codex/disconnect */
export async function codexDisconnectHandler(home: string): Promise<{ connected: false }> {
  bindCodexBrain(home);
  pendingByBrain.delete(home);
  await deleteLlmOauth(home, CODEX_PROVIDER);
  return { connected: false };
}
