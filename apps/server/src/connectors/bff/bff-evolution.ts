/** BFF WhatsApp via Evolution — status / conectar (QR) / renovar QR.
 *  Cria bot com can_ingest + acesso total, configura webhook MESSAGES_UPSERT no ingestor. */
import { createPrincipal, setGrant, issueToken } from "../../core/access/principals.ts";
import { getEngine } from "../../core/platform/engine.ts";
import {
  evolutionEnv,
  evolutionInstanceName,
  extractQrBase64,
  evolutionFetch,
  getEvolutionConfig,
  upsertEvolutionConfig,
  setEvolutionLastError,
  webhookUrlFor,
} from "../../core/platform/evolution.ts";
import { BffError } from "./bff-common.ts";

const PRINCIPAL_ID = "agent-whatsapp-evolution";
const PRINCIPAL_LABEL = "WhatsApp (Evolution)";

export interface EvolutionStatusView {
  configured: boolean;
  /** Evolution API alcançável */
  online: boolean;
  instanceName: string | null;
  /** open | connecting | close | unknown | null */
  state: string | null;
  connected: boolean;
  qrBase64: string | null;
  webhookHint: string | null;
  lastError: string | null;
  message?: string;
}

async function ensureBotAndToken(home: string): Promise<{ token: string; principalId: string; instanceName: string }> {
  const instanceName = evolutionInstanceName(home);
  const existing = await getEvolutionConfig(home);
  if (existing?.ingestToken) {
    return { token: existing.ingestToken, principalId: existing.principalId, instanceName: existing.instanceName || instanceName };
  }

  const e = await getEngine(home);
  if (!(await e.getPrincipal(PRINCIPAL_ID))) {
    await createPrincipal(home, { id: PRINCIPAL_ID, kind: "agent", label: PRINCIPAL_LABEL });
  }
  await setGrant(home, {
    principalId: PRINCIPAL_ID,
    areas: ["*"],
    sensitivityMax: "restrito",
    canIngest: true,
  });
  const { token } = await issueToken(home, { principalId: PRINCIPAL_ID, label: "webhook-evolution" });
  await upsertEvolutionConfig(home, {
    instanceName,
    ingestToken: token,
    principalId: PRINCIPAL_ID,
    enabled: true,
    lastError: null,
  });
  return { token, principalId: PRINCIPAL_ID, instanceName };
}

/** Payload webhook v2.3 — envelope `{ webhook }` (sem ele: "instance requires property webhook"). */
function webhookPayload(token: string) {
  return {
    enabled: true,
    url: webhookUrlFor(token),
    byEvents: false,
    base64: false,
    events: ["MESSAGES_UPSERT"],
    headers: { Authorization: `Bearer ${token}` },
  };
}

function isTimeoutMsg(msg: string): boolean {
  return /não respondeu em \d+s/i.test(msg);
}

async function setInstanceWebhook(instanceName: string, token: string): Promise<void> {
  const webhook = webhookPayload(token);
  try {
    await evolutionFetch(`/webhook/set/${encodeURIComponent(instanceName)}`, {
      method: "POST",
      body: JSON.stringify({ webhook }),
    });
  } catch {
    await evolutionFetch(`/webhook/set/${encodeURIComponent(instanceName)}`, {
      method: "POST",
      body: JSON.stringify({
        enabled: true,
        url: webhook.url,
        webhookByEvents: false,
        webhookBase64: false,
        events: webhook.events,
        headers: webhook.headers,
      }),
    });
  }
}

async function fetchConnectionState(instanceName: string): Promise<string> {
  try {
    const { json } = await evolutionFetch(`/instance/connectionState/${encodeURIComponent(instanceName)}`);
    const st =
      json?.instance?.state ??
      json?.state ??
      json?.status ??
      json?.connectionState ??
      null;
    return typeof st === "string" ? st.toLowerCase() : "unknown";
  } catch {
    return "unknown";
  }
}

async function ensureInstance(instanceName: string, token: string): Promise<{ qr: string | null; created: boolean }> {
  // Já existe?
  try {
    const { json } = await evolutionFetch(`/instance/fetchInstances?instanceName=${encodeURIComponent(instanceName)}`);
    const list = Array.isArray(json) ? json : json?.instance ? [json] : [];
    const hit = list.find((x: any) => {
      const n = x?.instance?.instanceName ?? x?.name ?? x?.instanceName;
      return n === instanceName;
    });
    if (hit) return { qr: extractQrBase64(hit) ?? extractQrBase64(json), created: false };
  } catch {
    /* segue pra create */
  }

  // qrcode:false → create responde na hora; o QR vem no /instance/connect (com timeout).
  try {
    const { json } = await evolutionFetch("/instance/create", {
      method: "POST",
      timeoutMs: 12_000,
      body: JSON.stringify({
        instanceName,
        integration: "WHATSAPP-BAILEYS",
        qrcode: false,
        webhook: webhookPayload(token),
      }),
    });
    return { qr: extractQrBase64(json), created: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/already|exist|in use|já exist/i.test(msg)) return { qr: null, created: false };
    throw err;
  }
}

async function fetchQr(instanceName: string): Promise<string | null> {
  const { json } = await evolutionFetch(`/instance/connect/${encodeURIComponent(instanceName)}`, {
    timeoutMs: 20_000,
  });
  return extractQrBase64(json);
}

/** GET /api/evolution/status */
export async function evolutionStatusHandler(home: string): Promise<EvolutionStatusView> {
  const env = evolutionEnv();
  if (!env) {
    return {
      configured: false,
      online: false,
      instanceName: null,
      state: null,
      connected: false,
      qrBase64: null,
      webhookHint: null,
      lastError: null,
      message: "Defina EVOLUTION_API_URL e EVOLUTION_API_KEY no .env (compose profile evolution).",
    };
  }

  const cfg = await getEvolutionConfig(home);
  const instanceName = cfg?.instanceName ?? evolutionInstanceName(home);

  let online = false;
  try {
    await evolutionFetch("/");
    online = true;
  } catch {
    return {
      configured: true,
      online: false,
      instanceName,
      state: null,
      connected: false,
      qrBase64: null,
      webhookHint: null,
      lastError: cfg?.lastError ?? null,
      message: "Evolution offline — suba com: docker compose --profile evolution up -d",
    };
  }

  const state = cfg ? await fetchConnectionState(instanceName) : null;
  const connected = state === "open";

  return {
    configured: true,
    online,
    instanceName,
    state,
    connected,
    qrBase64: null,
    webhookHint: cfg ? webhookUrlFor(cfg.ingestToken).replace(/\?token=.+$/, "?token=…") : null,
    lastError: cfg?.lastError ?? null,
  };
}

/** POST /api/evolution/connect — cria instância + webhook + devolve QR se precisar. */
export async function evolutionConnectHandler(home: string): Promise<EvolutionStatusView> {
  if (!evolutionEnv()) {
    throw new BffError(503, "Evolution não configurada (EVOLUTION_API_URL / EVOLUTION_API_KEY).");
  }

  try {
    const { token, instanceName } = await ensureBotAndToken(home);
    const { qr: qrCreate } = await ensureInstance(instanceName, token);
    try {
      await setInstanceWebhook(instanceName, token);
    } catch {
      /* webhook já pode ter ido no create */
    }

    const state = await fetchConnectionState(instanceName);
    let qr = qrCreate;
    if (state !== "open" && !qr) {
      try {
        qr = await fetchQr(instanceName);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!isTimeoutMsg(msg)) throw err;
      }
    }

    await setEvolutionLastError(home, null);

    const waitingQr = state !== "open" && !qr;
    return {
      configured: true,
      online: true,
      instanceName,
      state,
      connected: state === "open",
      qrBase64: state === "open" ? null : qr,
      webhookHint: webhookUrlFor(token).replace(/\?token=.+$/, "?token=…"),
      lastError: null,
      message: state === "open"
        ? "WhatsApp já conectado — mensagens vão pro cérebro."
        : waitingQr
          ? "A Evolution ainda está gerando o QR — clique em Renovar QR em alguns segundos."
          : "Escaneie o QR no WhatsApp (Aparelhos conectados).",
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await setEvolutionLastError(home, msg).catch(() => {});
    throw new BffError(502, msg);
  }
}

/** POST /api/evolution/qr — só renova o QR (instância já criada). */
export async function evolutionQrHandler(home: string): Promise<EvolutionStatusView> {
  if (!evolutionEnv()) {
    throw new BffError(503, "Evolution não configurada (EVOLUTION_API_URL / EVOLUTION_API_KEY).");
  }
  const cfg = await getEvolutionConfig(home);
  if (!cfg) throw new BffError(400, "Conecte o WhatsApp primeiro (POST /api/evolution/connect).");

  try {
    const state = await fetchConnectionState(cfg.instanceName);
    if (state === "open") {
      return {
        configured: true,
        online: true,
        instanceName: cfg.instanceName,
        state,
        connected: true,
        qrBase64: null,
        webhookHint: webhookUrlFor(cfg.ingestToken).replace(/\?token=.+$/, "?token=…"),
        lastError: null,
        message: "Já conectado — não precisa de QR.",
      };
    }
    let qr: string | null = null;
    try {
      qr = await fetchQr(cfg.instanceName);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!isTimeoutMsg(msg)) throw err;
    }
    await setEvolutionLastError(home, null);
    return {
      configured: true,
      online: true,
      instanceName: cfg.instanceName,
      state,
      connected: false,
      qrBase64: qr,
      webhookHint: webhookUrlFor(cfg.ingestToken).replace(/\?token=.+$/, "?token=…"),
      lastError: null,
      message: qr ? "QR renovado — escaneie em até ~60s." : "Não veio QR — tente de novo em alguns segundos.",
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await setEvolutionLastError(home, msg).catch(() => {});
    throw new BffError(502, msg);
  }
}
