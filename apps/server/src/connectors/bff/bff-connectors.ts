/** M22-A — handlers do BFF dos conectores: o webhook do Nango (m2m, auth = HMAC, fail-closed) + a
 *  connect session por fonte + criação de fonte-conector + status. Handlers PUROS no sentido do BFF:
 *  recebem dados, devolvem objeto serializável OU {status, body} (webhook). O web-server (zona neutra)
 *  só roteia/serializa.
 *
 *  Contrato oficial (invariante #9 — fixtures dos testes derivadas byte-a-byte, consulta 2026-06-12):
 *  webhooks https://nango.dev/docs/implementation-guides/platform/webhooks-from-nango;
 *  records  https://nango.dev/docs/reference/api/sync/records-list. */
import type { IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import {
  createConnectSession,
  listRecords as nangoListRecords,
  nangoConfigured,
  verifyNangoWebhook,
  type NangoRecord,
} from "../../lib/nango.ts";
import {
  deliverConnectorPayload,
  finalizeConnectorDeliveries,
  findSourceByConnection,
  getConnectorHandler,
  getSourceConnection,
  listSourceConnections,
  setSourceConnection,
  setSourceProvider,
  findSourceByProvider,
  updateConnectorState,
  type ConnectorRecordCtx,
  type SourceConnectionView,
} from "../../core/ingestion/connector-ingest.ts";
import { getEngine, type SourceRow } from "../../core/platform/engine.ts";
import { mergeRecipeDimsIntoPack } from "../../core/extraction/schema-pack.ts";
import { BffError } from "./bff-common.ts";

const MAX_BODY = 10 * 1024 * 1024; // 10MB
const MAX_CURSOR_PAGES = 1000; // teto de segurança do loop de records

/** Lê o body CRU (string) — a verificação HMAC exige os bytes originais, não o JSON re-serializado.
 *  Limite 10MB → BffError 413. */
export function readRawBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new BffError(413, "payload do webhook grande demais."));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", (e) => reject(e));
  });
}

export interface WebhookDeps {
  listRecords: typeof nangoListRecords;
}
export interface WebhookOutcome {
  status: number;
  body: unknown;
}

/** POST /api/connectors/nango/webhook — SEM sessão (m2m; a auth é o HMAC). NUNCA lança: devolve
 *  {status, body} (o web-server só serializa). Ordem CRAVADA — fail-closed primeiro (§4.7). */
export async function nangoWebhookHandler(
  rawBody: string,
  headers: Record<string, string | string[] | undefined>,
  deps?: Partial<WebhookDeps>,
): Promise<WebhookOutcome> {
  const listRecords = deps?.listRecords ?? nangoListRecords;

  // 1) fail-closed: assinatura.
  const verdict = verifyNangoWebhook(rawBody, headers);
  if (verdict === "unconfigured")
    return {
      status: 503,
      body: {
        error:
          "NANGO_WEBHOOK_SECRET não configurado — webhook desabilitado (fail-closed). Configure a signing key do Nango no ambiente.",
      },
    };
  if (verdict === "invalid") return { status: 401, body: { error: "assinatura do webhook inválida." } };

  // 2) JSON.
  let payload: any;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { error: "JSON inválido." } };
  }

  // 3) auth webhook (criação de conexão).
  if (payload?.type === "auth") {
    const tags = payload?.tags ?? {};
    if (
      payload?.operation === "creation" &&
      payload?.success === true &&
      typeof tags.source_id === "string" &&
      typeof tags.brain === "string" &&
      tags.source_id &&
      tags.brain
    ) {
      await setSourceConnection(tags.brain, tags.source_id, String(payload.connectionId ?? ""), String(payload.providerConfigKey ?? ""));
      return { status: 200, body: { ok: true } };
    }
    return { status: 200, body: { ignored: true } }; // auth de conexão alheia não é erro nosso
  }

  // 4) sync webhook.
  if (payload?.type === "sync") {
    const connectionId = String(payload.connectionId ?? "");
    const providerConfigKey = String(payload.providerConfigKey ?? "");

    // success === false → registra o erro (se acharmos a fonte) e ack.
    if (payload?.success === false) {
      const found = await findSourceByConnection(connectionId, providerConfigKey);
      if (found) await updateStateBestEffort(found.brain, found.sourceId, { last_error: "sync falhou no Nango" });
      return { status: 200, body: { ignored: true } };
    }

    const found = await findSourceByConnection(connectionId, providerConfigKey);
    if (!found) {
      console.log(`[connector-webhook] conexão sem fonte mapeada (connectionId=${connectionId} pck=${providerConfigKey})`);
      return { status: 200, body: { ignored: true } };
    }

    const { brain, sourceId } = found;
    const e = await getEngine(brain);
    const source = await e.getSource(sourceId);
    if (!source) {
      console.log(`[connector-webhook] fonte sumiu (brain=${brain} sourceId=${sourceId})`);
      return { status: 200, body: { ignored: true } };
    }
    if (source.status === "pausada")
      return {
        status: 409,
        body: { error: `a fonte "${source.name}" está pausada — o material não foi ingerido.` },
      };

    const handler = getConnectorHandler(providerConfigKey);
    if (!handler) {
      console.log(`[connector-webhook] sem handler registrado pra ${providerConfigKey} (M22-A standalone)`);
      return { status: 200, body: { ignored: true, reason: "sem handler registrado" } };
    }

    // busca o delta (LEI I — o cache do Nango é buffer). Cursor nosso avança SÓ após ingestão OK.
    const conn = await getSourceConnection(brain, sourceId);
    let cursor = conn?.state.cursor;
    const ctx: ConnectorRecordCtx = {
      brain,
      sourceId,
      connectionId,
      providerConfigKey,
      syncName: String(payload.syncName ?? ""),
      model: String(payload.model ?? ""),
    };

    let delivered = 0;
    let deduped = 0;
    let claimsApplied = 0;
    let lastCursorSeen: string | undefined = cursor;

    try {
      let pages = 0;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        if (++pages > MAX_CURSOR_PAGES) throw new Error("loop de records excedeu o teto de segurança (1000 páginas de cursor).");
        const { records, nextCursor } = await listRecords({
          connectionId,
          providerConfigKey,
          model: ctx.model,
          cursor: cursor ?? undefined,
          modifiedAfter: cursor ? undefined : payload.modifiedAfter,
          limit: 100,
        });

        for (const record of records) {
          if (record?._nango_metadata?.last_action === "DELETED") {
            console.log(`[connector-webhook] record DELETED ignorado (invariante #5 — conhecimento não some por deleção)`);
            continue;
          }
          const payloads = handler.normalize(record, ctx);
          if (!payloads.length) {
            console.log(`[connector-webhook] normalize devolveu 0 payloads (brain=${brain} model=${ctx.model})`);
            continue;
          }
          for (const p of payloads) {
            const r = await deliverConnectorPayload(brain, p);
            if (r.outcome === "enqueued") delivered++;
            else if (r.outcome === "claims_applied") claimsApplied++;
            else if (r.outcome === "deduped") deduped++;
          }
        }

        if (nextCursor) lastCursorSeen = nextCursor;
        if (!nextCursor || records.length === 0) {
          if (nextCursor) cursor = nextCursor; // último avanço (records vazio mas cursor mudou)
          break;
        }
        cursor = nextCursor;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await updateStateBestEffort(brain, sourceId, { last_error: msg }); // cursor NÃO avança → retry re-entrega
      return { status: 500, body: { error: msg } };
    }

    // fim OK: cursor avança, last_error limpo.
    await updateStateBestEffort(brain, sourceId, {
      cursor: lastCursorSeen,
      last_sync_at: new Date().toISOString(),
      last_error: "",
    });
    if (claimsApplied >= 1) await finalizeConnectorDeliveries(brain);

    return { status: 200, body: { ok: true, delivered, deduped, claims_applied: claimsApplied } };
  }

  // 5) type desconhecido.
  return { status: 200, body: { ignored: true } };
}

async function updateStateBestEffort(
  brain: string,
  sourceId: string,
  patch: { cursor?: string; last_sync_at?: string; last_error?: string },
): Promise<void> {
  try {
    await updateConnectorState(brain, sourceId, patch);
  } catch (err) {
    console.error(`[connector-webhook] updateConnectorState falhou (best-effort): ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ============================================================================
// connect session por fonte (§4.7 — árbitro: snake_case, connect_link OBRIGATÓRIO, 502 em falha)
// ============================================================================

export interface ConnectSessionResult {
  provider: string;
  token: string;
  connect_link: string;
  expires_at: string;
}

/** POST /api/sources/:id/connect — sessão+membership (requireBrain no web-server). Re-auth permitido
 *  (uma fonte já conectada pode reabrir a sessão). */
export async function connectSessionHandler(home: string, sourceId: string): Promise<ConnectSessionResult> {
  const e = await getEngine(home);
  const source = await e.getSource(sourceId);
  if (!source) throw new BffError(404, "essa fonte não existe mais.");

  const conn = await getSourceConnection(home, sourceId);
  const pck = conn?.providerConfigKey ?? "";
  if (!pck) throw new BffError(400, "essa fonte ainda não tem conector associado.");

  if (!nangoConfigured())
    throw new BffError(503, "NANGO_SECRET_KEY não configurado — conexão de fontes desabilitada.");

  let session: { token: string; connectLink?: string; expiresAt: string };
  try {
    session = await createConnectSession({ allowedIntegrations: [pck], tags: { source_id: sourceId, brain: home } });
  } catch (err) {
    throw new BffError(502, `o Nango recusou abrir a sessão de conexão: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!session.connectLink)
    throw new BffError(502, "o Nango devolveu sessão sem connect_link.");

  return { provider: pck, token: session.token, connect_link: session.connectLink, expires_at: session.expiresAt };
}

// ============================================================================
// criar fonte-conector + status (árbitro §4.7)
// ============================================================================

export interface ConnectorCreateBody {
  providerConfigKey: string; // integration-id que NÓS escolhemos no Nango (ex.: "conta-azul")
}
export interface ConnectorCreateResult {
  sourceId: string;
  providerConfigKey: string;
  name: string;
}

/** POST /api/sources/connector — cria (idempotente) a fonte de um conector a partir do sourceSeed() do
 *  handler. FAIL-CLOSED 503 ANTES de qualquer efeito (sem Nango configurado → não cria fonte órfã);
 *  400 sem handler registrado. Idempotente: se já existe fonte do mesmo provider no brain, devolve-a. */
export async function connectorCreateHandler(home: string, body: ConnectorCreateBody): Promise<ConnectorCreateResult> {
  const pck = typeof body?.providerConfigKey === "string" ? body.providerConfigKey.trim() : "";
  if (!pck) throw new BffError(400, "diga qual conector (providerConfigKey).");

  // fail-closed ANTES do efeito: sem secret, não criamos fonte que nunca conectaria.
  if (!nangoConfigured())
    throw new BffError(503, "NANGO_SECRET_KEY não configurado — conexão de fontes desabilitada.");

  const handler = getConnectorHandler(pck);
  if (!handler) throw new BffError(400, `conector "${pck}" não está disponível.`);

  // idempotente: já existe fonte desse provider no brain? devolve-a.
  const existing = await findSourceByProvider(home, pck);
  const e = await getEngine(home);
  if (existing) {
    const src = await e.getSource(existing.sourceId);
    return { sourceId: existing.sourceId, providerConfigKey: pck, name: src?.name ?? pck };
  }

  const seed = handler.sourceSeed();
  const recipe = { ...seed.recipe, fields: seed.recipe.fields ?? [] };
  if (recipe.fields.length) {
    // MESMO merge receita→pack do createSourceHandler (a dim da receita entra no extractable[type]).
    await mergeRecipeDimsIntoPack(home, [{ type: seed.type, dims: recipe.fields.map((f) => f.dimension) }]);
  }
  const row: SourceRow = {
    id: randomUUID(),
    name: seed.name,
    channel: seed.channel,
    type: seed.type,
    recipe,
    default_sensitivity: seed.default_sensitivity ?? "restrito",
    status: "ativa",
    last_read_at: null,
  };
  await e.upsertSource(row);
  await setSourceProvider(home, row.id, pck); // quem grava provider_config_key (questão fechada do árbitro)
  return { sourceId: row.id, providerConfigKey: pck, name: row.name };
}

/** GET /api/connectors/status — estado DERIVADO das conexões do brain (pro front D mesclar client-side). */
export async function connectorsStatusHandler(home: string): Promise<SourceConnectionView[]> {
  return listSourceConnections(home);
}
