/** BFF WhatsApp via Evolution — N contas por cérebro (QR ou pairing code).
 *  Cria bot com can_ingest + acesso total, configura webhook MESSAGES_UPSERT no ingestor. */
import { createPrincipal, setGrant, issueToken } from "../../core/access/principals.ts";
import { getEngine } from "../../core/platform/engine.ts";
import {
  evolutionEnv,
  evolutionInstanceName,
  nextEvolutionInstanceName,
  extractQrBase64,
  extractPairingCode,
  normalizeWhatsAppNumber,
  isZombieEvolutionState,
  keepEvolutionInstances,
  evolutionFetch,
  getEvolutionConfig,
  upsertEvolutionConfig,
  listEvolutionInstances,
  upsertEvolutionInstance,
  removeEvolutionInstance,
  setEvolutionInstanceError,
  webhookUrlFor,
} from "../../core/platform/evolution.ts";
import { BffError } from "./bff-common.ts";

const PRINCIPAL_ID = "agent-whatsapp-evolution";
const PRINCIPAL_LABEL = "WhatsApp (Evolution)";

export interface EvolutionInstanceView {
  instanceName: string;
  /** open | connecting | close | unknown | null */
  state: string | null;
  connected: boolean;
  qrBase64: string | null;
  pairingCode: string | null;
  lastError: string | null;
  message?: string;
}

export interface EvolutionStatusView {
  configured: boolean;
  online: boolean;
  instances: EvolutionInstanceView[];
  webhookHint: string | null;
  lastError: string | null;
  message?: string;
  /** Compat: primeira instância (ou a alvo da ação). */
  instanceName: string | null;
  state: string | null;
  connected: boolean;
  qrBase64: string | null;
  pairingCode: string | null;
}

export type EvolutionActionInput = {
  add?: boolean;
  instanceName?: string;
  number?: string;
};

async function ensureBotAndToken(home: string): Promise<{ token: string; principalId: string }> {
  const existing = await getEvolutionConfig(home);
  if (existing?.ingestToken) {
    return { token: existing.ingestToken, principalId: existing.principalId };
  }

  const instanceName = evolutionInstanceName(home);
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
  return { token, principalId: PRINCIPAL_ID };
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

function isOpen(state: string | null | undefined): boolean {
  return state === "open";
}

function parseNumber(raw: unknown): string | undefined {
  if (raw == null || raw === "") return undefined;
  if (typeof raw !== "string" && typeof raw !== "number") {
    throw new BffError(400, "Número inválido — use DDI+DDD+número (ex. 5511999998888).");
  }
  try {
    return normalizeWhatsAppNumber(String(raw));
  } catch (err) {
    throw new BffError(400, err instanceof Error ? err.message : String(err));
  }
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

function instanceNameOf(x: any): string | null {
  const n = x?.instance?.instanceName ?? x?.name ?? x?.instanceName;
  return typeof n === "string" && n ? n : null;
}

async function ensureInstance(instanceName: string, token: string): Promise<{ qr: string | null; pairingCode: string | null; created: boolean }> {
  try {
    const { json } = await evolutionFetch(`/instance/fetchInstances?instanceName=${encodeURIComponent(instanceName)}`);
    const list = Array.isArray(json) ? json : json?.instance ? [json] : [];
    const hit = list.find((x: any) => instanceNameOf(x) === instanceName);
    if (hit) {
      return {
        qr: extractQrBase64(hit) ?? extractQrBase64(json),
        pairingCode: extractPairingCode(hit) ?? extractPairingCode(json),
        created: false,
      };
    }
  } catch {
    /* segue pra create */
  }

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
    return { qr: extractQrBase64(json), pairingCode: extractPairingCode(json), created: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/already|exist|in use|já exist/i.test(msg)) return { qr: null, pairingCode: null, created: false };
    throw err;
  }
}

async function fetchConnectPayload(
  instanceName: string,
  number?: string,
): Promise<{ qr: string | null; pairingCode: string | null }> {
  const q = number ? `?number=${encodeURIComponent(number)}` : "";
  const { json } = await evolutionFetch(`/instance/connect/${encodeURIComponent(instanceName)}${q}`, {
    timeoutMs: 20_000,
  });
  return { qr: extractQrBase64(json), pairingCode: extractPairingCode(json) };
}

async function deleteRemoteInstance(instanceName: string): Promise<void> {
  try {
    await evolutionFetch(`/instance/logout/${encodeURIComponent(instanceName)}`, { method: "DELETE" });
  } catch {
    /* já deslogada */
  }
  try {
    await evolutionFetch(`/instance/delete/${encodeURIComponent(instanceName)}`, { method: "DELETE" });
  } catch {
    /* já sumiu */
  }
}

function belongsToBrain(home: string, name: string): boolean {
  const prefix = evolutionInstanceName(home);
  return name === prefix || name.startsWith(`${prefix}-`);
}

/** Importa instâncias Evolution deste cérebro (prefixo galeed-…) sem apagar a open. */
async function reconcileFromEvolution(home: string): Promise<void> {
  try {
    const { json } = await evolutionFetch("/instance/fetchInstances");
    const list = Array.isArray(json) ? json : json?.instance ? [json] : [];
    for (const x of list) {
      const n = instanceNameOf(x);
      if (!n || !belongsToBrain(home, n)) continue;
      await upsertEvolutionInstance(home, n);
    }
  } catch {
    /* Evolution sem lista — segue com o que está no banco */
  }
}

/** Apaga só close / NOT CONNECTION. Nunca toca open nem connecting. */
async function cleanupZombies(home: string, keep: Set<string>): Promise<void> {
  const rows = await listEvolutionInstances(home);
  for (const row of rows) {
    if (keep.has(row.instanceName)) continue;
    const state = await fetchConnectionState(row.instanceName);
    if (isOpen(state) || state === "connecting") continue;
    if (!isZombieEvolutionState(state)) continue;
    await deleteRemoteInstance(row.instanceName);
    await removeEvolutionInstance(home, row.instanceName);
  }
}

function emptyStatus(partial: Partial<EvolutionStatusView> & Pick<EvolutionStatusView, "configured" | "online">): EvolutionStatusView {
  return {
    instances: [],
    webhookHint: null,
    lastError: null,
    instanceName: null,
    state: null,
    connected: false,
    qrBase64: null,
    pairingCode: null,
    ...partial,
  };
}

function pack(
  instances: EvolutionInstanceView[],
  extras: {
    configured: boolean;
    online: boolean;
    webhookHint: string | null;
    lastError: string | null;
    message?: string;
    focus?: string;
  },
): EvolutionStatusView {
  const focus = extras.focus
    ? instances.find((i) => i.instanceName === extras.focus)
    : undefined;
  const primary = focus ?? instances.find((i) => i.connected) ?? instances[0];
  return {
    configured: extras.configured,
    online: extras.online,
    instances,
    webhookHint: extras.webhookHint,
    lastError: extras.lastError ?? primary?.lastError ?? null,
    message: extras.message,
    instanceName: primary?.instanceName ?? null,
    state: primary?.state ?? null,
    connected: primary?.connected ?? false,
    qrBase64: primary?.qrBase64 ?? null,
    pairingCode: primary?.pairingCode ?? null,
  };
}

async function snapshotInstances(
  home: string,
  extras?: { qrByName?: Record<string, string | null>; pairByName?: Record<string, string | null> },
): Promise<EvolutionInstanceView[]> {
  const rows = await listEvolutionInstances(home);
  const out: EvolutionInstanceView[] = [];
  for (const row of rows) {
    const state = await fetchConnectionState(row.instanceName);
    const connected = isOpen(state);
    out.push({
      instanceName: row.instanceName,
      state,
      connected,
      qrBase64: connected ? null : (extras?.qrByName?.[row.instanceName] ?? null),
      pairingCode: connected ? null : (extras?.pairByName?.[row.instanceName] ?? null),
      lastError: row.lastError,
    });
  }
  return out;
}

async function statusPack(
  home: string,
  token: string | null,
  extras?: {
    message?: string;
    lastError?: string | null;
    focus?: string;
    qrByName?: Record<string, string | null>;
    pairByName?: Record<string, string | null>;
  },
): Promise<EvolutionStatusView> {
  const instances = await snapshotInstances(home, extras);
  return pack(instances, {
    configured: true,
    online: true,
    webhookHint: token ? webhookUrlFor(token).replace(/\?token=.+$/, "?token=…") : null,
    lastError: extras?.lastError ?? null,
    message: extras?.message,
    focus: extras?.focus,
  });
}

/** GET /api/evolution/status */
export async function evolutionStatusHandler(home: string): Promise<EvolutionStatusView> {
  const env = evolutionEnv();
  if (!env) {
    return emptyStatus({
      configured: false,
      online: false,
      message: "Defina EVOLUTION_API_URL e EVOLUTION_API_KEY no .env (compose profile evolution).",
    });
  }

  const cfg = await getEvolutionConfig(home);
  try {
    await evolutionFetch("/");
  } catch {
    const rows = await listEvolutionInstances(home);
    return pack(
      rows.map((r) => ({
        instanceName: r.instanceName,
        state: null,
        connected: false,
        qrBase64: null,
        pairingCode: null,
        lastError: r.lastError,
      })),
      {
        configured: true,
        online: false,
        webhookHint: null,
        lastError: cfg?.lastError ?? null,
        message: "Evolution offline — suba com: docker compose --profile evolution up -d",
      },
    );
  }

  await reconcileFromEvolution(home);
  const rows = await listEvolutionInstances(home);
  const stated = await Promise.all(
    rows.map(async (r) => ({
      instanceName: r.instanceName,
      state: await fetchConnectionState(r.instanceName),
    })),
  );
  await cleanupZombies(home, keepEvolutionInstances(stated));
  return statusPack(home, cfg?.ingestToken ?? null, { lastError: cfg?.lastError ?? null });
}

async function resolveTargetName(
  home: string,
  input: EvolutionActionInput,
  existing: string[],
): Promise<string> {
  if (input.instanceName) {
    if (!belongsToBrain(home, input.instanceName)) {
      throw new BffError(400, "Instância inválida para este cérebro.");
    }
    return input.instanceName;
  }
  if (input.add) return nextEvolutionInstanceName(home, existing);
  if (existing.length === 0) return nextEvolutionInstanceName(home, existing);

  const states = await Promise.all(existing.map(async (n) => ({ n, state: await fetchConnectionState(n) })));
  const retry = states.find((s) => !isOpen(s.state));
  if (retry) return retry.n;
  return nextEvolutionInstanceName(home, existing);
}

/** POST /api/evolution/connect — cria/reusa instância + QR ou pairing code. */
export async function evolutionConnectHandler(
  home: string,
  input: EvolutionActionInput = {},
): Promise<EvolutionStatusView> {
  if (!evolutionEnv()) {
    throw new BffError(503, "Evolution não configurada (EVOLUTION_API_URL / EVOLUTION_API_KEY).");
  }

  const number = parseNumber(input.number);
  try {
    const { token } = await ensureBotAndToken(home);
    await reconcileFromEvolution(home);
    const existing = (await listEvolutionInstances(home)).map((r) => r.instanceName);
    const instanceName = await resolveTargetName(home, input, existing);

    if (input.add) {
      await cleanupZombies(home, new Set([instanceName]));
    }

    const stateBefore = existing.includes(instanceName) ? await fetchConnectionState(instanceName) : null;
    if (isOpen(stateBefore) && input.add) {
      // add nunca reusa a open — pega o próximo nome
      const fresh = nextEvolutionInstanceName(home, existing);
      return evolutionConnectHandler(home, { ...input, add: false, instanceName: fresh });
    }

    if (isOpen(stateBefore) && !input.add && !number) {
      await upsertEvolutionInstance(home, instanceName, null);
      return statusPack(home, token, {
        focus: instanceName,
        message: "WhatsApp já conectado — mensagens vão pro cérebro.",
      });
    }

    const created = await ensureInstance(instanceName, token);
    await upsertEvolutionInstance(home, instanceName, null);
    try {
      await setInstanceWebhook(instanceName, token);
    } catch {
      /* webhook já pode ter ido no create */
    }

    const state = await fetchConnectionState(instanceName);
    let qr = created.qr;
    let pairingCode = created.pairingCode;
    if (state !== "open" && (!qr || number) && !pairingCode) {
      try {
        const got = await fetchConnectPayload(instanceName, number);
        qr = got.qr ?? qr;
        pairingCode = got.pairingCode ?? pairingCode;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!isTimeoutMsg(msg)) throw err;
      }
    }

    await setEvolutionInstanceError(home, instanceName, null);

    const waiting = state !== "open" && !qr && !pairingCode;
    const message = state === "open"
      ? "WhatsApp já conectado — mensagens vão pro cérebro."
      : pairingCode
        ? "Digite o código no WhatsApp (Aparelhos conectados → Conectar com número de telefone)."
        : waiting
          ? number
            ? "A Evolution ainda está gerando o código — tente de novo em alguns segundos."
            : "A Evolution ainda está gerando o QR — clique em Renovar QR em alguns segundos."
          : "Escaneie o QR no WhatsApp (Aparelhos conectados).";

    return statusPack(home, token, {
      focus: instanceName,
      message,
      qrByName: { [instanceName]: state === "open" ? null : qr },
      pairByName: { [instanceName]: state === "open" ? null : pairingCode },
    });
  } catch (err) {
    if (err instanceof BffError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    const name = typeof input.instanceName === "string" ? input.instanceName : "";
    if (name) await setEvolutionInstanceError(home, name, msg).catch(() => {});
    else await setEvolutionInstanceError(home, evolutionInstanceName(home), msg).catch(() => {});
    throw new BffError(502, msg);
  }
}

/** POST /api/evolution/qr — renova QR ou pairing code (instância já criada). */
export async function evolutionQrHandler(
  home: string,
  input: EvolutionActionInput = {},
): Promise<EvolutionStatusView> {
  if (!evolutionEnv()) {
    throw new BffError(503, "Evolution não configurada (EVOLUTION_API_URL / EVOLUTION_API_KEY).");
  }
  const cfg = await getEvolutionConfig(home);
  if (!cfg) throw new BffError(400, "Conecte o WhatsApp primeiro (POST /api/evolution/connect).");

  const number = parseNumber(input.number);
  const rows = await listEvolutionInstances(home);
  const instanceName = input.instanceName
    || rows.find((r) => r.instanceName)?.instanceName
    || cfg.instanceName;
  if (input.instanceName && !belongsToBrain(home, input.instanceName)) {
    throw new BffError(400, "Instância inválida para este cérebro.");
  }

  try {
    const state = await fetchConnectionState(instanceName);
    if (isOpen(state) && !number) {
      return statusPack(home, cfg.ingestToken, {
        focus: instanceName,
        message: "Já conectado — não precisa de QR.",
      });
    }
    let qr: string | null = null;
    let pairingCode: string | null = null;
    try {
      const got = await fetchConnectPayload(instanceName, number);
      qr = got.qr;
      pairingCode = got.pairingCode;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!isTimeoutMsg(msg)) throw err;
    }
    await setEvolutionInstanceError(home, instanceName, null);
    return statusPack(home, cfg.ingestToken, {
      focus: instanceName,
      message: pairingCode
        ? "Código renovado — digite no WhatsApp em até ~60s."
        : qr
          ? "QR renovado — escaneie em até ~60s."
          : "Não veio QR/código — tente de novo em alguns segundos.",
      qrByName: { [instanceName]: qr },
      pairByName: { [instanceName]: pairingCode },
    });
  } catch (err) {
    if (err instanceof BffError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    await setEvolutionInstanceError(home, instanceName, msg).catch(() => {});
    throw new BffError(502, msg);
  }
}

/** POST /api/evolution/disconnect — logout+delete SÓ desta instância. */
export async function evolutionDisconnectHandler(
  home: string,
  input: EvolutionActionInput = {},
): Promise<EvolutionStatusView> {
  if (!evolutionEnv()) {
    throw new BffError(503, "Evolution não configurada (EVOLUTION_API_URL / EVOLUTION_API_KEY).");
  }
  const instanceName = typeof input.instanceName === "string" ? input.instanceName.trim() : "";
  if (!instanceName || !belongsToBrain(home, instanceName)) {
    throw new BffError(400, "Informe a conta WhatsApp para desconectar.");
  }

  try {
    await deleteRemoteInstance(instanceName);
    await removeEvolutionInstance(home, instanceName);
    const cfg = await getEvolutionConfig(home);
    return statusPack(home, cfg?.ingestToken ?? null, {
      message: `Conta ${instanceName} desconectada. As outras seguem ativas.`,
    });
  } catch (err) {
    if (err instanceof BffError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw new BffError(502, msg);
  }
}
