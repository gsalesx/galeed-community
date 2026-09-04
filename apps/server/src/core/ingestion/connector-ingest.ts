/** M22-A — o SEAM ÚNICO por onde TODO conector entrega material ao motor (LEI II) + registro de
 *  handlers (formato como DADO, invariante III) + acessores do estado de conexão (colunas da migração
 *  29; dono único = ESTE módulo; engine.ts intocado — zoning §3).
 *
 *  A LEI (BRIEF §2): (I) o dado mora no NOSSO Postgres; (II) seam único, zero ramo de formato no core
 *  (o normalizador de cada conector é módulo isolado que EMITE payloads pro seam); (IV) tokens OAuth
 *  NUNCA aqui — só connection_id + provider_config_key + connector_state (cursor/last_sync_at/last_error).
 *
 *  Não chama buildEmbeddings por payload (um webhook pode entregar centenas de records); o caminho COM
 *  claims roda finalizeConnectorDeliveries 1× ao fim do lote. O caminho SEM claims já embeda no pipeline. */
import { createHash } from "node:crypto";
import { getSharedSql, sharedSqlGeneration } from "../platform/db-conn.ts";
import { getEngine } from "../platform/engine.ts";
import { putBlobOnly, sliceForIngest } from "./ingest-doc.ts";
import { enqueueIngestJob } from "./ingest-queue.ts";
import { capture } from "./capture.ts";
import { applyRecipeGate, addReviewItemsAndNotify } from "./golden-rule.ts";
import { deriveIncremental } from "../retrieval/indexer.ts";
import { buildEmbeddings } from "../retrieval/embeddings.ts";
import { slugify } from "../../lib/slug.ts";
import type { NangoRecord } from "../../lib/nango.ts";

// ============================================================================
// §4.1 — o envelope do seam
// ============================================================================

/** Um claim DETERMINÍSTICO pronto (ERP/M22-B). MESMA semântica de campos que o indexer e o
 *  applyRecipeGate já leem (entity/predicate/value/value_num/context_quote/text + unit/period/tier),
 *  uma única semântica de claim no sistema. `context_quote` DEVE ser trecho LITERAL do `content`
 *  (âncora — o gate rejeita o que não confere: golden-rule.ts/quoteIsGrounded). */
export interface ConnectorClaim {
  dimension: string; // dimensão de extração (⊆ receita da fonte; fora dela → fila de revisão)
  entity: string;
  predicate: string;
  value?: string;
  value_num?: number;
  unit?: string; // unidade do value_num (ex.: "BRL") — campo que o indexer lê (GraphQueryHit)
  period?: string; // período do claim (ex.: "2026-01") — campo que o indexer lê
  tier?: string; // tier/escalonamento — verificado em applyBitemporal/indexer (árbitro §4.1)
  date?: string; // YYYY-MM-DD — data DO EVENTO (âncora do valid_from, P1-A)
  valid_from?: string; // YYYY-MM-DD — quando o claim começou a valer (bitemporal; default = date)
  context_quote: string; // trecho LITERAL do content (obrigatório)
  text?: string; // o claim em linguagem natural (vai pra fila de revisão se rejeitado)
}

/** O ENVELOPE do seam (LEI II). content textual SEMPRE (proveniência/âncora); claims opcionais ⇒
 *  caminho determinístico zero-LLM (BRIEF §3). O content DEVE conter o externalRef renderizado
 *  (contrato com B/C: proveniência legível na página). */
export interface ConnectorPayload {
  sourceId: string; // galeed_sources.id — a fonte dona da entrega
  content: string; // rendição TEXTUAL do record/mensagem (sempre; é a âncora)
  contentType: "text/plain" | "text/markdown";
  timestamp: string; // ISO-8601 — data DO EVENTO na origem (não da ingestão)
  externalRef: string; // id estável na origem (record id / message id) — proveniência
  title?: string; // título legível da página (opcional)
  claims?: ConnectorClaim[]; // presentes ⇒ caminho determinístico (zero LLM)
}

export interface DeliverResult {
  outcome: "enqueued" | "claims_applied" | "deduped";
  jobId?: string; // outcome 'enqueued' (caminho assíncrono LLM)
  slug?: string; // outcome 'claims_applied' (página âncora criada)
  approved?: number; // claims aprovados pelo gate (claims_applied)
  rejected?: number; // claims que foram pra fila de revisão (claims_applied)
}

const DET_VERSION = "m22a-det-1"; // versão LITERAL determinística (não é prompt LLM; extract_version é texto livre)

function sha16(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

/** sourceTags — espelha LITERALMENTE process-blob-job.ts:118-126 (src:<id> + canal:<slug> + area:<slug>). */
function sourceTags(source: {
  id: string;
  channel: string;
  recipe: { fields: { area?: string }[] };
}): string[] {
  return [
    `src:${source.id}`,
    ...(source.channel?.trim() ? [`canal:${slugify(source.channel)}`] : []),
    ...[...new Set(source.recipe.fields.map((f) => (f.area || "").trim()).filter(Boolean))].map(
      (a) => `area:${slugify(a)}`,
    ),
  ];
}

/** O SEAM (LEI II). Valida a fonte (existe via engine.getSource; status !== 'pausada'), grava o blob
 *  verbatim (putBlobOnly) e:
 *   - SEM claims → enfileira job carimbado com source_id (pipeline LLM normal);
 *   - COM claims → caminho determinístico síncrono (§4.2) — zero LLM.
 *  Falhas = Error com mensagem legível em PT (o chamador BFF mapeia pra HTTP). */
export async function deliverConnectorPayload(
  brain: string,
  payload: ConnectorPayload,
): Promise<DeliverResult> {
  // Validações (Error legível, em PT, NESTA ordem — §4.1).
  const content = (payload.content || "").trim();
  if (!content) throw new Error("o conector entregou conteúdo vazio.");
  if (payload.contentType !== "text/plain" && payload.contentType !== "text/markdown")
    throw new Error(
      "o conector deve entregar conteúdo textual (text/plain ou text/markdown) — binário não passa pelo seam.",
    );
  if (!payload.timestamp || Number.isNaN(Date.parse(payload.timestamp)))
    throw new Error("timestamp inválido — use ISO-8601.");
  if (!payload.externalRef || !payload.externalRef.trim())
    throw new Error("payload sem external_ref — a proveniência é obrigatória.");

  const e = await getEngine(brain);
  const source = await e.getSource(payload.sourceId);
  if (!source) throw new Error("essa fonte não existe mais.");
  if (source.status === "pausada")
    throw new Error(`a fonte "${source.name}" está pausada — retome a leitura pra ingerir.`);

  const buf = Buffer.from(payload.content, "utf8");
  const { docHash } = await putBlobOnly(brain, buf, {
    contentType: payload.contentType,
    filename: payload.externalRef, // proveniência no blob
    source: "connector",
  });

  // ===== Caminho A — SEM claims (e-mail/não-estruturado → pipeline LLM normal) =====
  if (!payload.claims || payload.claims.length === 0) {
    // DEDUP DE ENTREGA (re-entrega do MESMO payload → zero job novo): leitura direta read-only.
    const sql = await getSharedSql();
    const dup = (await sql`
      select id from galeed_ingest_jobs
       where brain = ${brain} and source_id = ${source.id} and content_hash = ${docHash}
         and status not in ('error','dead')
       limit 1`) as any[];
    if (dup.length) return { outcome: "deduped", jobId: dup[0].id as string };

    const { jobId } = await enqueueIngestJob({
      brain,
      kind: "file",
      type: source.type,
      contentHash: docHash,
      filename: payload.externalRef,
      mime: payload.contentType,
      title: payload.title,
      jobDate: payload.timestamp.slice(0, 10),
      sourceId: source.id,
    });
    return { outcome: "enqueued", jobId };
  }

  // ===== Caminho B — COM claims (ERP/M22-B → determinístico, ZERO LLM, BRIEF §3) =====
  const slices = sliceForIngest(payload.content);
  if (slices.length !== 1)
    throw new Error("payload estruturado deve render UMA página por record — fatie no normalizador.");
  const sl = slices[0];

  const tags = sourceTags(source);
  const cap = await capture({
    home: brain,
    text: sl.text,
    type: source.type,
    title: payload.title,
    date: payload.timestamp.slice(0, 10),
    source: "connector",
    externalId: `sl:${sha16(sl.text)}`,
    tags,
    sensitivity: source.default_sensitivity,
  });
  if (cap.skipped) return { outcome: "deduped", slug: cap.slug };

  // agrupa os claims por dimensão (cada item = o ConnectorClaim cru — mesma semântica do `merged`).
  const claimsByDim: Record<string, any[]> = {};
  for (const c of payload.claims) {
    const dim = c.dimension;
    (claimsByDim[dim] ??= []).push(c);
  }

  // o pageBody é o body COMO o capture grava (capture.ts:69/70: text.trim() + "\n").
  const pageBody = sl.text.trim() + "\n";
  const gate = applyRecipeGate(claimsByDim, source.recipe, source.id, cap.slug, pageBody);
  // C2 — review.pending (gancho da regra de ouro, fail-soft).
  if (gate.rejected.length) await addReviewItemsAndNotify(brain, gate.rejected);
  console.log(
    `[recipe-gate] brain=${brain} page=${cap.slug} approved=${gate.counts.approved} ` +
      `rejected=${gate.counts.rejected} source=${source.id}`,
  );

  await e.putExtraction({
    source_slug: cap.slug,
    type: source.type,
    date: payload.timestamp.slice(0, 10),
    content_hash: sha16(sl.text),
    prompt_version: DET_VERSION,
    extractions: gate.approved,
  });
  await e.markExtracted(cap.slug, DET_VERSION);
  await deriveIncremental(brain, [cap.slug]); // write-path O(1) (M14/ADR-008)
  await e.touchSourceRead(source.id);

  return {
    outcome: "claims_applied",
    slug: cap.slug,
    approved: gate.counts.approved,
    rejected: gate.counts.rejected,
  };
}

/** Roda buildEmbeddings(brain) 1× ao FIM de um lote de entregas com claims (o caminho A já embeda dentro
 *  do pipeline). Não-fatal: falha vira log (espelho de process-blob-job.ts:216-228) — FTS segue; a
 *  varredura de reparo re-tenta. */
export async function finalizeConnectorDeliveries(brain: string): Promise<void> {
  try {
    await buildEmbeddings(brain);
  } catch (err) {
    console.error(
      `[connector] embeddings falharam no finalize — busca semântica off pra este lote (a varredura re-tenta): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

// ============================================================================
// §4.4 — registro de conectores como DADO (o core não conhece formato — invariante III)
// ============================================================================

/** Contexto de UM record entregue por um sync do Nango (montado pelo webhook handler). */
export interface ConnectorRecordCtx {
  brain: string;
  sourceId: string;
  connectionId: string;
  providerConfigKey: string;
  syncName: string;
  model: string;
}

/** Factory PURA da fonte (árbitro §4.4): fecha "quem grava provider_config_key" — o connectorCreateHandler
 *  chama sourceSeed() e cria a fonte com este shape. Sem IO, sem env. */
export interface ConnectorSourceSeed {
  name: string; // nome legível da fonte
  channel: string; // canal de ingestão (NUNCA "conector" — é o canal real, ex.: "conta azul")
  type: string; // tipo de página
  recipe: { fields: { dimension: string; label: string; area: string }[]; guidance?: string; triage_profile?: string };
  default_sensitivity?: string; // nível; ausente ⇒ engine resolve (fail-closed 'restrito')
}

/** O normalizador que B/C implementam. PURO — sem IO, sem fetch, sem env: recebe o record cru do Nango
 *  (com _nango_metadata) e devolve 0..n payloads pro seam (preenchendo sourceId via ctx, mapeando
 *  ctx.model → dimensão). O core NÃO conhece formato (invariante III): este módulo só guarda o mapa
 *  providerConfigKey → handler. */
export interface ConnectorHandler {
  providerConfigKey: string; // ex.: "conta-azul" (B), "google-mail" (C)
  sourceSeed(): ConnectorSourceSeed; // factory pura da fonte (árbitro §4.4)
  normalize(record: NangoRecord, ctx: ConnectorRecordCtx): ConnectorPayload[];
}

const handlers = new Map<string, ConnectorHandler>();

export function registerConnectorHandler(h: ConnectorHandler): void {
  handlers.set(h.providerConfigKey, h); // último ganha (re-registro em teste)
}
export function getConnectorHandler(providerConfigKey: string): ConnectorHandler | undefined {
  return handlers.get(providerConfigKey);
}
export function clearConnectorHandlers(): void {
  handlers.clear(); // SÓ testes
}

// ============================================================================
// §4.5 — acessores do estado de conexão (dono único das colunas da migração 29)
// ============================================================================

export interface ConnectorState {
  cursor?: string;
  last_sync_at?: string;
  last_error?: string;
}

/** Estado DERIVADO de uma conexão pra o front (árbitro §4.5). */
export interface SourceConnectionView {
  sourceId: string;
  name: string;
  channel: string;
  providerConfigKey: string;
  connectionId: string;
  status: "desconectado" | "conectado" | "erro"; // sem connection_id→desconectado; last_error→erro; senão conectado
  cursor: string;
  lastSyncAt: string;
  lastError: string;
}

// Boot lazy idempotente espelhando a migração 29 (precedente ingest-queue.ts:126-163). O seam não
// depende da ordem de execução do engine.
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
    // idempotente — espelha a migração id 29. Boot lazy não depende da ordem do engine.
    await sql.unsafe(`
      alter table galeed_sources add column if not exists connection_id text not null default '';
      alter table galeed_sources add column if not exists provider_config_key text not null default '';
      alter table galeed_sources add column if not exists connector_state jsonb not null default '{}'::jsonb;
      create index if not exists galeed_sources_connection
        on galeed_sources(connection_id, provider_config_key) where connection_id <> '';
    `);
  })();
  await _ready;
  return sql;
}

/** webhook → fonte: resolve (brain, sourceId) pelo connection_id (+ provider_config_key, defesa contra
 *  colisão). null = conexão desconhecida. */
export async function findSourceByConnection(
  connectionId: string,
  providerConfigKey: string,
): Promise<{ brain: string; sourceId: string } | null> {
  if (!connectionId) return null;
  const sql = await db();
  const rows = (await sql`
    select brain, id from galeed_sources
     where connection_id = ${connectionId} and provider_config_key = ${providerConfigKey}
     limit 1`) as any[];
  if (!rows.length) return null;
  return { brain: rows[0].brain as string, sourceId: rows[0].id as string };
}

/** auth webhook 'creation' → grava connection_id + provider_config_key na fonte. */
export async function setSourceConnection(
  brain: string,
  sourceId: string,
  connectionId: string,
  providerConfigKey: string,
): Promise<void> {
  const sql = await db();
  await sql`
    update galeed_sources
       set connection_id = ${connectionId}, provider_config_key = ${providerConfigKey}
     where brain = ${brain} and id = ${sourceId}`;
}

/** grava SÓ o provider_config_key (árbitro §4.5): o connectorCreateHandler associa a fonte ao provider
 *  ANTES de a conexão existir (connection_id chega depois, no auth webhook). */
export async function setSourceProvider(
  brain: string,
  sourceId: string,
  providerConfigKey: string,
): Promise<void> {
  const sql = await db();
  await sql`
    update galeed_sources
       set provider_config_key = ${providerConfigKey}
     where brain = ${brain} and id = ${sourceId}`;
}

export async function getSourceConnection(
  brain: string,
  sourceId: string,
): Promise<{ connectionId: string; providerConfigKey: string; state: ConnectorState } | null> {
  const sql = await db();
  const rows = (await sql`
    select connection_id, provider_config_key, connector_state from galeed_sources
     where brain = ${brain} and id = ${sourceId}
     limit 1`) as any[];
  if (!rows.length) return null;
  return {
    connectionId: rows[0].connection_id ?? "",
    providerConfigKey: rows[0].provider_config_key ?? "",
    state: (rows[0].connector_state ?? {}) as ConnectorState,
  };
}

/** primeira fonte (do brain) associada a um provider_config_key (árbitro §4.5). */
export async function findSourceByProvider(
  brain: string,
  providerConfigKey: string,
): Promise<{ sourceId: string } | null> {
  const sql = await db();
  const rows = (await sql`
    select id from galeed_sources
     where brain = ${brain} and provider_config_key = ${providerConfigKey}
     order by created_at asc nulls last
     limit 1`) as any[];
  if (!rows.length) return null;
  return { sourceId: rows[0].id as string };
}

/** todas as conexões do brain com status DERIVADO (árbitro §4.5) — pro GET /api/connectors/status. */
export async function listSourceConnections(brain: string): Promise<SourceConnectionView[]> {
  const sql = await db();
  const rows = (await sql`
    select id, name, channel, provider_config_key, connection_id, connector_state from galeed_sources
     where brain = ${brain} and provider_config_key <> ''
     order by created_at asc nulls last`) as any[];
  return rows.map((r) => {
    const state = (r.connector_state ?? {}) as ConnectorState;
    const connectionId = r.connection_id ?? "";
    const lastError = state.last_error ?? "";
    const status: SourceConnectionView["status"] = !connectionId
      ? "desconectado"
      : lastError
        ? "erro"
        : "conectado";
    return {
      sourceId: r.id as string,
      name: r.name as string,
      channel: r.channel as string,
      providerConfigKey: r.provider_config_key as string,
      connectionId,
      status,
      cursor: state.cursor ?? "",
      lastSyncAt: state.last_sync_at ?? "",
      lastError,
    };
  });
}

/** merge jsonb (connector_state || $patch) — nunca substitui o objeto inteiro
 *  (precedente mergeJobResult, ingest-queue.ts:508-514). */
export async function updateConnectorState(
  brain: string,
  sourceId: string,
  patch: Partial<ConnectorState>,
): Promise<void> {
  const sql = await db();
  await sql`
    update galeed_sources
       set connector_state = coalesce(connector_state, '{}'::jsonb) || ${sql.json(patch as any)}
     where brain = ${brain} and id = ${sourceId}`;
}
