#!/usr/bin/env -S npx tsx
/** GATEWAY PÚBLICO /v1 (leitura + ingestão gateada por can_ingest) — a borda pública do Galeed. Casca fina sobre os handlers
 *  puros do BFF (askHandler/factsHandler do bff-m9), com o contrato PÚBLICO de apps/docs/openapi.yaml.
 *
 *  POR QUE SEPARADO do api-server.ts (:8788) e do BFF (:8789): a borda pública tem um perfil de
 *  segurança DISTINTO — auth SÓ por `Authorization: Bearer <token>` (nada de god-token estático,
 *  cookie ou ?token=), o brain vem DO TOKEN (authenticateTokenGlobal → isolamento de tenant por
 *  construção, sem ?brain= do cliente), rate-limit por token, e o shape de resposta é o contrato
 *  público documentado (gateway-shape.ts), não o shape interno do motor.
 *
 *  Rotas (idioma do api-server.ts: node:http, send(res,code,obj), OPTIONS→204):
 *    GET  /health        → { ok: true }              (SEM auth)
 *    POST /v1/ask        body { question }           → { answer, facts[], withheld }
 *    GET  /v1/facts      query dim/area/status/as_of/min_confidence/limit/cursor → { facts[], cursor? }
 *    POST /v1/ingest     body { source, content, occurred_at?, participants?, sensitivity? } → 202 { batch_id, status:"organizing", source, received_at }   (requer scope.canIngest)
 *    GET  /v1/ingest/:id status do batch → { batch_id, status, progress?, result? }   (escopado por brain do token)
 *    GET  /v1/ingestors            lista os ingestores registrados (INGESTORES.md)
 *    POST /v1/ingestors/:slug      webhook por ingestor: payload cru do canal → normalize() → fila → 202 { status, recebidos, enfileirados, jobs[] }   (requer scope.canIngest; aceita ?token= como fallback)
 *    POST   /v1/webhooks    body { url, events[], label? } → 201 { id, url, events, secret, status }  (secret UMA vez; requer can_ingest; SSRF sync)
 *    GET    /v1/webhooks    → { webhooks[] } (SEM secret)   (requer can_ingest)
 *    DELETE /v1/webhooks/:id → { id, deleted:true }   (só do brain do token; id alheio → 404; requer can_ingest)
 *
 *  Segurança (invariantes da borda): applySecurityHeaders em TODA resposta; scanJsonDepthPreParse +
 *  body pequeno (64 KiB ask / 1 MiB ingest) no POST; 500 GENÉRICO (não vaza message — loga no stderr);
 *  status corretos (400/401/402/403/405/410/429). As rotas de ESCRITA (/v1/ingest e
 *  /v1/ingestors/:slug) são gateadas por scope.canIngest (403 fail-closed) ANTES de qualquer
 *  enqueue; SSRF fail-closed (rejeita doc_url/audio_url/doc_base64).
 *  ENV: GATEWAY_PORT (default 8790). NÃO usa API_TOKEN. */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { brainHome } from "../core/platform/brain.ts";
import { getEngine } from "../core/platform/engine.ts";
import type { PageRow } from "../core/platform/engine.ts";
import { authenticateTokenGlobal } from "../core/access/principals.ts";
import { checkLlmCostQuota } from "../core/platform/cost-quota.ts";
import { gateAndDebit, billingEnabled, CREDIT_COST, topupRemainingOfBrain } from "../core/platform/credits.ts";
import { assertEntitledByBrain } from "../core/platform/entitlement.ts";
import { inScope, type Scope } from "../core/access/scope.ts";
// INGESTORES (ver INGESTORES.md): registry plugável de canais de entrada — cada ingestor registrado
// ganha um webhook público POST /v1/ingestors/<slug> (o normalize() do ingestor é o middleware).
import { registerBuiltinIngestors } from "../core/ingestion/ingestors/boot.ts";
import { getIngestor, listIngestors } from "../core/ingestion/ingestors/registry.ts";
import { deliverIngestorWebhook, IngestorUsageError } from "../core/ingestion/ingestors/deliver.ts";

/** M-PAY-H/10 — gate de entitlement topup-aware na borda /v1 (paridade com web-server.entitlementGate).
 *  Conta entitled → {} (gate por crédito normal). LAPSED → {onlyTopup:true} se o crédito PRÉ-PAGO cobre
 *  o custo (debita só do topup); senão {deny:true} (402 entitlement). Decisão do fundador: o pré-pago
 *  comprado avulso continua gastável mesmo com a assinatura lapsed. */
async function entitlementGateV1(brain: string, cost: number): Promise<{ deny?: boolean; onlyTopup?: boolean }> {
  if (!billingEnabled()) return {}; // self-host sem Stripe: sem assinatura pra cobrar
  const e = await assertEntitledByBrain(brain);
  if (e.entitled) return {};
  const prepaid = await topupRemainingOfBrain(brain);
  if (prepaid !== null && prepaid >= cost) return { onlyTopup: true };
  return { deny: true };
}
import { rateLimit } from "../lib/rate-limit.ts";
import { applySecurityHeaders } from "../lib/security-headers.ts";
import { scanJsonDepthPreParse, HttpError } from "../lib/json-safety.ts";
import { clientIp } from "./web-server.ts";
import { askHandler, factsHandler, type FactItem } from "./bff/bff-m9.ts";
import { enqueueIngestJob, getJob, type IngestJob } from "../core/ingestion/ingest-queue.ts";
import { emitWebhookEvent } from "../core/platform/webhook-emit.ts";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { validateOutboundUrl } from "../lib/ssrf-guard.ts";
import type { WebhookEvent } from "../core/platform/engine.ts";
import {
  toPublicFact,
  withheldBlock,
  publishable,
  DIM_RE,
  type PublicFact,
  type SourcePageCtx,
} from "./gateway-shape.ts";
import { buildV1OpenApi } from "./v1-openapi.ts";

const BODY_LIMIT = 64 * 1024; // 64 KiB — é só { question } (default p/ /v1/ask)
// /v1/ingest manda CONTEÚDO CRU (transcrição, corpo de e-mail) → teto maior, mas ainda pequeno o
// bastante p/ não virar vetor de DoS de memória. 1 MiB cobre uma call/transcrição longa de texto.
const INGEST_BODY_LIMIT = 1024 * 1024; // 1 MiB — { source, content, ... }
const ASK_RATE = { max: 60, windowMs: 60_000 }; // 60/min por token
const FACTS_RATE = { max: 300, windowMs: 60_000 }; // 300/min por token
const INGEST_RATE = { max: 60, windowMs: 60_000 }; // 60/min por token (escrita — dispara extract+embed)
// Registro de webhooks (op de CONFIANÇA, gateada por can_ingest): teto modesto por token. Não é caminho
// quente (cliente registra/lista/remove raramente), mas o rate-limit fecha abuso de criação em massa.
const WEBHOOK_RATE = { max: 30, windowMs: 60_000 }; // 30/min por token
// Os 4 eventos v1 (espelha WebhookEvent do engine). Validamos o subconjunto que o cliente assina.
const WEBHOOK_EVENTS = new Set<WebhookEvent>([
  "ingest.organized",
  "review.pending",
  "fact.superseded",
  "access.denied",
]);
const WEBHOOK_BODY_LIMIT = 16 * 1024; // 16 KiB — { url, events[], label? } é minúsculo
const WEBHOOK_LABEL_MAX = 200; // teto cosmético do rótulo (anti-abuso de campo livre)
const WEBHOOK_EVENTS_MAX = 4; // no máx os 4 (sem duplicar p/ inflar)
// Enum de sensibilidade PÚBLICA (contrato ingestao.astro) → INTERNA do motor. Validamos a entrada
// pública; o mapeamento interno fica registrado p/ quando o pipeline de texto ad-hoc aceitar o nível.
const PUBLIC_SENSITIVITY = new Set(["open", "internal", "confidential", "secret"]);
const SENSITIVITY_PUBLIC_TO_INTERNAL: Record<string, string> = {
  open: "publico",
  internal: "interno",
  confidential: "sensivel",
  secret: "restrito",
};
// PRÉ-AUTH por IP (anti-DoS no DB compartilhado): teto generoso na borda, ANTES do SELECT de auth.
// 120/min/IP cobre o uso legítimo de qualquer cliente; barra o brute-force de Bearer-lixo numa box.
const AUTH_IP_RATE = { max: 120, windowMs: 60_000 };
// THROTTLE do webhook access.denied (anti-flood): no MÁX 1 emissão por principal por minuto. Uma
// negação total em loop (agente mal-escopado martelando) JAMAIS pode inundar a fila de webhooks do
// brain (ou a inbox do cliente) com `access.denied`. A chave por-principal (não por-token/IP) é o que
// o fundador pediu — 1 access.denied-webhook/principal/min. Janela própria, separada do rate-limit.
const ACCESS_DENIED_WH_RATE = { max: 1, windowMs: 60_000 };
const FACTS_LIMIT_MAX = 200;
const FACTS_LIMIT_DEFAULT = 50;
// Teto EXPLÍCITO do universo de decisions que a fase 1 percorre antes de escopar/filtrar/paginar na
// borda. O motor default oculto é 200 (postgres.ts) — pequeno demais p/ um cursor honesto. Documentado
// no contrato (fatos.astro): além deste teto o resultado vem `truncated:true`.
const FACTS_UNIVERSE_MAX = 2000;

/** Responde JSON com headers de segurança + CORS conservador. `secure` (HSTS) gateado por env. */
function send(res: ServerResponse, code: number, obj: unknown, extraHeaders: Record<string, string> = {}) {
  const secure = process.env.NODE_ENV === "production" || process.env.SECURE_COOKIES === "1";
  applySecurityHeaders(res, secure); // P0 (#8) — em TODA resposta
  const origin = process.env.API_CORS_ORIGIN || process.env.WEB_CORS_ORIGIN || "";
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    // CORS CONSERVADOR: só ecoa origin se explicitamente configurado (default = sem ACAO → mesma-origem).
    ...(origin ? { "access-control-allow-origin": origin } : {}),
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
    "vary": "Origin",
    ...extraHeaders,
  });
  res.end(JSON.stringify(obj));
}

/** Lê o body JSON do POST com teto + scan anti-DoS PRÉ-PARSE. Rejeita HttpError(413/400).
 *  `limit` é o teto de bytes (default BODY_LIMIT 64 KiB; /v1/ingest passa INGEST_BODY_LIMIT 1 MiB). */
function readJsonBody(req: IncomingMessage, limit = BODY_LIMIT): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (c: Buffer) => {
      if (tooLarge) return;
      size += c.length;
      if (size > limit) {
        tooLarge = true;
        reject(new HttpError(413, `body grande demais (máx ${Math.floor(limit / 1024)} KiB).`));
        req.resume();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) return resolve({});
      try {
        scanJsonDepthPreParse(raw); // P0 — barra aninhamento absurdo ANTES do JSON.parse (anti-crash)
      } catch (e) {
        return reject(e instanceof HttpError ? e : new HttpError(400, "JSON muito profundo"));
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return reject(new HttpError(400, "JSON inválido"));
      }
      resolve(parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {});
    });
    req.on("error", () => reject(new HttpError(400, "erro lendo body")));
  });
}

/** Extrai o token de `Authorization: Bearer <token>` — e SÓ isso (sem cookie, sem ?token=, sem
 *  API_TOKEN). Retorna "" se ausente/malformado. */
function bearerToken(req: IncomingMessage): string {
  const h = req.headers["authorization"];
  const raw = Array.isArray(h) ? h[0] : h;
  if (!raw) return "";
  const m = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return m ? m[1].trim() : "";
}

/** Metadados do webhook pra log — sem token, sem texto da mensagem. */
function webhookEventMeta(body: unknown): { event: string; instance: string; dataItems: number } {
  const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const event = typeof b.event === "string" ? b.event : "";
  let instance = "";
  if (typeof b.instance === "string") instance = b.instance;
  else if (typeof b.instanceName === "string") instance = b.instanceName;
  else if (b.instance && typeof b.instance === "object") {
    const inst = b.instance as Record<string, unknown>;
    if (typeof inst.instanceName === "string") instance = inst.instanceName;
    else if (typeof inst.name === "string") instance = inst.name;
  }
  const data = b.data;
  const dataItems = Array.isArray(data) ? data.length : data && typeof data === "object" ? 1 : 0;
  return { event, instance, dataItems };
}

/** auditoria de leitura (best-effort, não derruba a request). Espelha logAccess do api-server.ts. */
async function logAccess(brain: string, scope: Scope, query: string, nReturned: number) {
  try {
    await (await getEngine(brain)).appendAccessLog({
      principal_id: scope.principalId, query, areas_touched: scope.areas, n_returned: nReturned,
    });
  } catch { /* best-effort */ }
}

/** Carrega o contexto das páginas-fonte de um conjunto de fatos (tipo/data/tags/sensibilidade) p/ a
 *  tradução pública + o filtro de escopo. Uma só query (pagesBySlug) p/ todos os slugs. */
async function loadPages(brain: string, facts: FactItem[]): Promise<Map<string, PageRow>> {
  const slugs = [...new Set(facts.map((f) => f.source_slug || "").filter(Boolean))];
  if (!slugs.length) return new Map();
  try {
    return await (await getEngine(brain)).pagesBySlug(slugs);
  } catch {
    return new Map(); // sem páginas → tudo cai como falha-fechado no filtro (não vaza)
  }
}

/** Contexto de página → o subset que o tradutor consome. */
function pageCtx(p: PageRow | undefined): SourcePageCtx | undefined {
  if (!p) return undefined;
  return { type: p.type, date: p.date, tags: p.tags, sensitivity: p.sensitivity };
}

/** Aplica o escopo do principal a uma lista de fatos via a PÁGINA-FONTE (espelho do api-server.ts).
 *  Retorna { kept, withheld }: kept = fatos visíveis; withheld = nº barrados pelo escopo (honestidade).
 *  Fail-closed: fato sem página-fonte conhecida cai (não vaza). */
function applyScope(
  facts: FactItem[],
  pages: Map<string, PageRow>,
  scope: Scope,
): { kept: FactItem[]; withheld: number } {
  const kept: FactItem[] = [];
  let withheld = 0;
  for (const f of facts) {
    const p = pages.get(f.source_slug || "");
    if (p && inScope({ type: p.type, tags: p.tags, sensitivity: p.sensitivity }, scope)) {
      kept.push(f);
    } else {
      withheld += 1; // barrado pelo escopo (ou sem página → falha-fechado) = escondido
    }
  }
  return { kept, withheld };
}

/** Emite `access.denied` para o brain SÓ em NEGAÇÃO TOTAL — um pedido de leitura que voltou VAZIO
 *  porque TUDO foi barrado pelo escopo (kept===0 && withheld>0) OU um 403 de capacidade. NUNCA em
 *  withheld PARCIAL (leitura escopada normal esconde fato o tempo todo → seria ruído e vazaria a
 *  existência de conteúdo censurado). Payload MÍNIMO (ids/contagens, jamais valores sensíveis).
 *
 *  THROTTLE por principal (anti-flood): rateLimit(`adwh:<principal>`, 1, 60s) — só emite se .ok, no máx
 *  1 webhook/principal/min. FAIL-SOFT: o emit já nunca lança, mas envolvemos em try/catch por garantia —
 *  o caminho do usuário (a resposta da borda) JAMAIS cai por causa de um webhook (igual recordUsage). */
function emitAccessDenied(brain: string, scope: Scope, reason: string, route: string): void {
  try {
    const principalId = scope.principalId || "";
    const rl = rateLimit(`adwh:${principalId}`, ACCESS_DENIED_WH_RATE.max, ACCESS_DENIED_WH_RATE.windowMs);
    if (!rl.ok) return; // janela já gastou a emissão deste minuto → silêncio (anti-flood)
    // fire-and-forget: o fan-out é async; não esperamos (e não derrubamos a resposta). O emit é fail-soft.
    void emitWebhookEvent(brain, "access.denied", {
      principal_id: principalId,
      reason,
      route,
      at: new Date().toISOString(),
    }).catch((err) => {
      console.error("[gateway] access.denied emit (fail-soft):", err instanceof Error ? err.message : String(err));
    });
  } catch (err) {
    // por garantia (rateLimit/Date jamais lançam, mas o contrato é: NUNCA derrubar o caminho do usuário).
    console.error("[gateway] access.denied gancho (fail-soft):", err instanceof Error ? err.message : String(err));
  }
}

/** Traduz fatos internos (já escopados) + suas páginas para o shape público. `asOf` (opcional, do
 *  /v1/facts?as_of=) é o ponto temporal pra decidir supersessão (valid_until < asOf → archived).
 *  HONESTIDADE (cobre /v1/facts E o facts[] do /v1/ask num ponto só): `publishable()` exclui
 *  'nao-verificado' (suspeito de alucinação) ANTES da tradução — depois do applyScope, então o
 *  `withheld` segue contando SÓ a barreira de escopo, nunca este filtro de qualidade. */
function toPublic(facts: FactItem[], pages: Map<string, PageRow>, asOf?: string): PublicFact[] {
  return publishable(facts).map((f) => toPublicFact(f, pageCtx(pages.get(f.source_slug || "")), asOf));
}

/** Estados PÚBLICOS do batch de ingestão (contrato ingestao.astro). O 202 do enqueue promete
 *  "organizing"; daí o cliente faz polling do GET /v1/ingest/:id até "organized" (terminal de sucesso)
 *  ou "failed". O mundo interno tem MUITO mais estados (queued→processing→findable→digesting→
 *  batch_*→done|error|dead) — NÃO vazamos o cru: mapeamos pra um vocabulário público estável. */
type PublicIngestStatus = "organizing" | "indexed" | "organized" | "failed";

/** status interno do job → status público. `findable` (cérebro já buscável, digestão em curso) →
 *  "indexed" (sinal honesto de progresso parcial); `done`/`digested` → "organized"; `error`/`dead` →
 *  "failed"; o resto (queued/processing/digesting/batch_*) → "organizing". */
function publicIngestStatus(internal: IngestJob["status"]): PublicIngestStatus {
  switch (internal) {
    case "done":
    case "digested":
      return "organized";
    case "error":
    case "dead":
      return "failed";
    case "findable":
      return "indexed";
    default:
      return "organizing"; // queued | processing | digesting | batch_submitted | batch_harvesting
  }
}

/** Traduz um IngestJob interno → o shape PÚBLICO do GET /v1/ingest/:id. NÃO vaza campos internos crus
 *  (brain, content_hash, text_body, lease_until, attempts, batch_*…) — só o ticket público + progresso
 *  + o resumo do resultado quando organizado. */
function toPublicJob(job: IngestJob): {
  batch_id: string;
  status: PublicIngestStatus;
  progress?: number;
  result?: { facts: number; hypotheses?: number; pending_review?: number };
} {
  const status = publicIngestStatus(job.status);
  const out: {
    batch_id: string;
    status: PublicIngestStatus;
    progress?: number;
    result?: { facts: number; hypotheses?: number; pending_review?: number };
  } = { batch_id: job.id, status };
  if (typeof job.progress === "number") out.progress = job.progress;
  // resultado só quando organizado: lê o resumo gravado em result_json (total = nº de partes/páginas).
  // O motor de fatos não materializa contagens por job no result público → expomos o que EXISTE
  // honestamente (facts = nº de slices/páginas criadas); hypotheses/pending_review ficam omitidos
  // quando o pipeline não os produz (REGRA DE OURO: omitir > inventar).
  if (status === "organized") {
    const r = job.resultJson as { total?: unknown };
    const facts = typeof r?.total === "number" ? r.total : 0;
    out.result = { facts };
  }
  return out;
}

export function startGatewayServer(bootHome = brainHome()) {
  const port = Number(process.env.GATEWAY_PORT || 8790);
  registerBuiltinIngestors(); // webhooks prontos por ingestor (idempotente)
  const ROUTES = [
    "GET /health", "GET /v1/openapi.json", "POST /v1/ask", "GET /v1/facts", "POST /v1/ingest", "GET /v1/ingest/:id",
    "GET /v1/ingestors", "POST /v1/ingestors/:slug",
    "POST /v1/webhooks", "GET /v1/webhooks", "DELETE /v1/webhooks/:id",
  ];

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      if (req.method === "OPTIONS") {
        applySecurityHeaders(res, process.env.NODE_ENV === "production" || process.env.SECURE_COOKIES === "1");
        const origin = process.env.API_CORS_ORIGIN || process.env.WEB_CORS_ORIGIN || "";
        res.writeHead(204, {
          ...(origin ? { "access-control-allow-origin": origin } : {}),
          "access-control-allow-headers": "authorization, content-type",
          "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
          "vary": "Origin",
        });
        return res.end();
      }

      const u = new URL(req.url || "/", `http://localhost:${port}`);
      const path = u.pathname.replace(/\/+$/, "") || "/";

      // /health — liveness, SEM auth (igual ao contrato).
      if (path === "/health" || path === "/") {
        if (req.method !== "GET") return send(res, 405, { error: "use GET" });
        return send(res, 200, { ok: true });
      }

      // GET /v1/openapi.json — contrato público (sem auth). baseUrl derivado dos headers do proxy.
      if (path === "/v1/openapi.json") {
        if (req.method !== "GET") return send(res, 405, { error: "use GET" });
        const proto = String(req.headers["x-forwarded-proto"] || "http").split(",")[0].trim();
        const host = String(req.headers["x-forwarded-host"] || req.headers.host || `localhost:${port}`).split(",")[0].trim();
        const base = process.env.GALEED_PUBLIC_URL || `${proto}://${host}`;
        return send(res, 200, buildV1OpenApi(base));
      }

      // ----- AUTH: SÓ Authorization: Bearer <token>. brain vem DO TOKEN (nunca de ?brain=). -----
      // /v1/ingest/:jobId é dinâmica: casa o prefixo e extrai o id (sem framework de rotas).
      const ingestJobMatch = /^\/v1\/ingest\/([^/]+)$/.exec(path);
      const webhookIdMatch = /^\/v1\/webhooks\/([^/]+)$/.exec(path);
      const ingestorsMatch = /^\/v1\/ingestors(?:\/([^/]+))?$/.exec(path);
      const isV1 =
        path === "/v1/ask" ||
        path === "/v1/facts" ||
        path === "/v1/ingest" ||
        path === "/v1/webhooks" ||
        ingestJobMatch !== null ||
        webhookIdMatch !== null ||
        ingestorsMatch !== null;
      if (!isV1) {
        return send(res, 404, { error: "rota desconhecida", rotas: ROUTES });
      }
      // MAJOR fix (DoS pré-auth no DB compartilhado): rate-limit por IP ANTES do authenticateTokenGlobal,
      // que faz SELECT no Postgres. Sem este teto, Bearer-lixo em loop martela o DB sem limite (a chave
      // por-token só existe DEPOIS de autenticar). Teto generoso (uso legítimo passa folgado); barra o
      // brute-force de uma box contra o DB. /health não cai aqui (não toca DB).
      const rlPre = rateLimit(`gw-ip-auth:${clientIp(req)}`, AUTH_IP_RATE.max, AUTH_IP_RATE.windowMs);
      if (!rlPre.ok) return send(res, 429, { error: "muitas tentativas" }, { "retry-after": String(rlPre.retryAfter) });
      // SÓ na rota de ingestores aceitamos ?token= como fallback: ferramentas de webhook que não
      // mandam header Authorization (ex.: alguns paineis de notetaker) conseguem entregar mesmo
      // assim. Custo conhecido: token pode vazar em log de acesso — documentado no INGESTORES.md;
      // prefira SEMPRE o header quando a ferramenta suportar.
      const bearer = bearerToken(req);
      const queryTok = ingestorsMatch ? String(u.searchParams.get("token") ?? "").trim() : "";
      const token = bearer || queryTok;
      const authSource = bearer ? "bearer" : queryTok ? "query" : "none";
      if (req.method === "POST" && ingestorsMatch?.[1]) {
        console.error(
          `[ingestor-webhook] hit slug=${ingestorsMatch[1]} auth=${authSource} hasBearer=${Boolean(bearer)} hasQueryToken=${Boolean(queryTok)}`,
        );
      }
      const auth = token ? await authenticateTokenGlobal(token) : null;
      if (!auth) {
        if (req.method === "POST" && ingestorsMatch?.[1]) {
          console.error(`[ingestor-webhook] 401 slug=${ingestorsMatch[1]} auth=${authSource}`);
        }
        return send(res, 401, { error: "token inválido" });
      }
      const { brain, scope } = auth;

      // ----- POST /v1/ask -----
      if (path === "/v1/ask") {
        if (req.method !== "POST") return send(res, 405, { error: "use POST" });
        const rl = rateLimit(`gw:${scope.principalId}:ask`, ASK_RATE.max, ASK_RATE.windowMs);
        if (!rl.ok) return send(res, 429, { error: "rate limit" }, { "retry-after": String(rl.retryAfter) });
        // reforço leve por IP (anti-abuso de uma box): mais frouxo que o por-token.
        const rlIp = rateLimit(`gw-ip:${clientIp(req)}:ask`, ASK_RATE.max * 4, ASK_RATE.windowMs);
        if (!rlIp.ok) return send(res, 429, { error: "rate limit" }, { "retry-after": String(rlIp.retryAfter) });

        // KILL-SWITCH de custo de LLM por brain (M20+): /v1/ask é a ÚNICA chamada cara da borda. Se o
        // acumulado de HOJE (UTC) já estourou o teto diário (GALEED_LLM_DAILY_BUDGET_USD), barra a NOVA
        // síntese com 402 (Payment Required) ANTES de tocar o motor. Não afeta /v1/facts (não chama LLM).
        const quota = await checkLlmCostQuota(brain);
        if (quota.exceeded) {
          return send(res, 402, {
            error: "limite diário de custo de LLM atingido",
            current_usd: quota.current_usd,
            limit_usd: quota.limit_usd,
          });
        }

        const body = await readJsonBody(req);
        const question = typeof body.question === "string" ? body.question.trim() : "";
        if (!question) return send(res, 400, { error: "faltou 'question'" });

        // M-PAY-H (Onda 3): gate de ENTITLEMENT na borda PAGA da API /v1 (paridade com web-server).
        // Assinatura inadimplente fora da graça (canceled/unpaid/past_due vencido) → 402, ANTES do
        // crédito. Conta sem assinatura (trial puro) passa direto (reason 'none'). Resolve o owner do
        // brain igual ao débito p/ não divergir.
        // M-PAY-H/10: sob lapsed a ação ainda passa se o crédito PRÉ-PAGO cobre o custo (onlyTopup).
        const entAsk = await entitlementGateV1(brain, CREDIT_COST.ask);
        if (entAsk.deny) {
          return send(res, 402, { error: "pagamento pendente — atualize o método de pagamento", reason: "entitlement" });
        }
        // M-PAY-C: gate+débito de crédito (ask=6cr) DEPOIS de validar o body (não cobra por 400).
        // Conta sem carteira = permissivo. SEGURANÇA (auditoria R2): chave de débito server-side por
        // request (NÃO a Idempotency-Key crua do cliente) — ask SEMPRE roda o LLM (sem replay cacheado),
        // então aceitar a chave do cliente daria asks grátis (claim vazio não debita, mas o LLM roda).
        // gateAndDebit gera um uuid quando a chave é omitida.
        const credit = await gateAndDebit(brain, CREDIT_COST.ask, "ask", undefined, { onlyTopup: entAsk.onlyTopup });
        if (!credit.ok) {
          return send(res, 402, { error: "saldo de créditos insuficiente", balance: credit.balance, needed: CREDIT_COST.ask });
        }

        // BLOCKER fix: o scope do token entra NO MOTOR — a prosa é sintetizada sobre o corpus JÁ
        // escopado (o LLM nunca vê o que está fora do acesso). O applyScope abaixo segue como
        // defesa-em-profundidade sobre a série de fatos da borda.
        const r = await askHandler(brain, question, 8, scope);
        const pages = await loadPages(brain, r.facts);
        const { kept, withheld } = applyScope(r.facts, pages, scope);
        const facts = toPublic(kept, pages);
        await logAccess(brain, scope, question, facts.length);
        // NEGAÇÃO TOTAL (gancho access.denied): a leitura voltou VAZIA porque TUDO foi barrado pelo
        // escopo (kept===0 && withheld>0). NUNCA em withheld PARCIAL (kept>0) — escopo normal esconde
        // fato o tempo todo; emitir aí seria ruído e vazaria a existência de conteúdo censurado.
        if (kept.length === 0 && withheld > 0) {
          emitAccessDenied(brain, scope, "fora_de_escopo", "/v1/ask");
        }
        return send(res, 200, { answer: r.answer, facts, withheld: withheldBlock(withheld) });
      }

      // ----- GET /v1/facts -----
      if (path === "/v1/facts") {
        if (req.method !== "GET") return send(res, 405, { error: "use GET" });
        const rl = rateLimit(`gw:${scope.principalId}:facts`, FACTS_RATE.max, FACTS_RATE.windowMs);
        if (!rl.ok) return send(res, 429, { error: "rate limit" }, { "retry-after": String(rl.retryAfter) });

        // query pública → params internos (ver mapeamento no relatório).
        const statusParam = (u.searchParams.get("status") || "fact").toLowerCase();
        // MAJOR fix: o enum público desta rota é {fact, archived}. hypothesis NÃO é suportado aqui
        // (a rota parte de dim:"decisions", que não contém hipóteses) — devolver fatos como se fossem
        // hipóteses, ou silenciosamente [], mentiria. 400 explícito mantém doc (fatos.astro) e código
        // COERENTES. hypothesis fica como roadmap, fora da fase 1.
        const VALID_STATUS = ["fact", "archived"];
        if (statusParam === "hypothesis") {
          return send(res, 400, { error: "status 'hypothesis' não suportado nesta rota (use fact|archived)" });
        }
        if (!VALID_STATUS.includes(statusParam)) {
          return send(res, 400, { error: "status inválido (use fact|archived)" });
        }
        // `dim` público (default "decisions" = retrocompat byte-a-byte): as dimensões reais são
        // definidas por receita/pack do tenant (inclusive em PT — "decisoes", "compromissos"…),
        // então NÃO há allowlist de valores: validamos só o FORMATO (o SQL do motor é parametrizado;
        // dim inexistente devolve [] honesto). Sem isso a borda pública só alcançava "decisions"
        // hardcoded — e devolvia [] até pra decisões em cérebros com receitas PT.
        const dim = (u.searchParams.get("dim") || "decisions").toLowerCase();
        if (!DIM_RE.test(dim)) {
          return send(res, 400, { error: "dim inválida (use um nome de dimensão: a-z, 0-9, _; até 40 chars)" });
        }
        const area = u.searchParams.get("area") || "";
        const asOf = u.searchParams.get("as_of") || undefined;
        const minConfRaw = u.searchParams.get("min_confidence");
        const minConf = minConfRaw !== null ? Number(minConfRaw) : null;
        if (minConf !== null && (!Number.isFinite(minConf) || minConf < 0 || minConf > 1)) {
          return send(res, 400, { error: "min_confidence deve ser 0–1" });
        }
        const limitRaw = Number(u.searchParams.get("limit"));
        const limit = Number.isFinite(limitRaw) && limitRaw > 0
          ? Math.min(limitRaw, FACTS_LIMIT_MAX)
          : FACTS_LIMIT_DEFAULT;
        // cursor = offset numérico opaco (paginação simples e honesta sobre o resultado já escopado).
        const cursorRaw = Number(u.searchParams.get("cursor"));
        const offset = Number.isFinite(cursorRaw) && cursorRaw > 0 ? Math.floor(cursorRaw) : 0;

        // MAJOR fix (paginação honesta): busca um universo AMPLO e EXPLÍCITO do motor (teto da fase 1
        // = FACTS_UNIVERSE_MAX), não o default oculto de 200 do motor. O motor não conhece o status
        // público nem a área-destino por fato → escopo+filtros+slice acontecem na borda, então o
        // `cursor` SÓ pode sair quando há MAIS itens IN-SCOPE além do slice. Antes: limit:undefined
        // pegava 200 crus, paginava pós-filtro e emitia cursor como se houvesse percorrido tudo.
        const rows = await factsHandler(brain, {
          dim, // dimensão do query param (default "decisions" — retrocompat)
          asOf,
          // current não vem do contrato público; asOf cobre o recorte temporal. Sem asOf = estado atual.
          limit: FACTS_UNIVERSE_MAX, // teto EXPLÍCITO do universo (documentado no contrato)
        });
        // se o motor devolveu == teto, o universo pode estar TRUNCADO (há decisions além do teto) →
        // sinalizamos honestamente em `truncated` em vez de fingir cobertura total.
        const universeTruncated = rows.length >= FACTS_UNIVERSE_MAX;
        const pages = await loadPages(brain, rows);
        const { kept, withheld } = applyScope(rows, pages, scope);
        // NEGAÇÃO TOTAL (gancho access.denied): havia decisions no universo, mas o escopo barrou TODAS
        // (kept===0 && withheld>0) → a leitura voltou vazia por acesso, não por inexistência. NUNCA em
        // withheld PARCIAL (kept>0). Note: este gancho mira a barreira de ESCOPO (pré-filtros públicos),
        // não o resultado vazio por status/area/min_confidence — esses são filtro do cliente, não negação.
        if (kept.length === 0 && withheld > 0) {
          emitAccessDenied(brain, scope, "fora_de_escopo", "/v1/facts");
        }
        let pub = toPublic(kept, pages, asOf);
        // filtros públicos pós-tradução (status/area/min_confidence operam no shape público):
        pub = pub.filter((f) => f.status === statusParam);
        if (area) pub = pub.filter((f) => f.area.includes(area));
        if (minConf !== null) pub = pub.filter((f) => f.confidence !== null && f.confidence >= minConf);

        const pageSlice = pub.slice(offset, offset + limit);
        // cursor HONESTO: só quando de fato existem mais itens IN-SCOPE além do slice (offset+limit
        // < total escopado+filtrado). Não emitir cursor que mente.
        const hasMoreInScope = offset + limit < pub.length;
        const nextCursor = hasMoreInScope ? String(offset + limit) : undefined;
        await logAccess(brain, scope, `facts:${dim}:${statusParam}`, pageSlice.length);
        return send(res, 200, {
          facts: pageSlice,
          ...(nextCursor ? { cursor: nextCursor } : {}),
          // truncated=true só quando o universo bateu no teto E não há cursor (a última página pode
          // estar incompleta porque o motor cortou no teto). Honestidade > falsa cobertura total.
          ...(universeTruncated && !hasMoreInScope ? { truncated: true } : {}),
        });
      }

      // ----- /v1/ingestors — webhooks prontos por INGESTOR (registry plugável; INGESTORES.md) -----
      // GET /v1/ingestors (lista) · POST /v1/ingestors/:slug (entrega). O normalize() do ingestor é
      // o middleware que prepara o payload cru ANTES de entrar no seam (dedupe + fila + gate).
      if (ingestorsMatch) {
        const slug = ingestorsMatch[1] ?? "";
        if (!slug) {
          if (req.method !== "GET") return send(res, 405, { error: "use GET (lista) ou POST /v1/ingestors/:slug" });
          return send(res, 200, { ingestors: listIngestors() });
        }
        if (req.method !== "POST") return send(res, 405, { error: "use POST" });

        // mesmo gate de escrita fail-closed do /v1/ingest.
        if (!scope.canIngest) {
          emitAccessDenied(brain, scope, "can_ingest", `/v1/ingestors/${slug}`);
          console.error(`[ingestor-webhook] 403 can_ingest slug=${slug} brain=${brain} principal=${scope.principalId}`);
          return send(res, 403, { error: "token sem capacidade de escrita (can_ingest)" });
        }
        const ing = getIngestor(slug);
        if (!ing) {
          return send(res, 404, { error: `ingestor "${slug}" não existe`, disponiveis: listIngestors().map((i) => i.slug) });
        }

        const rl = rateLimit(`gw:${scope.principalId}:ingest`, INGEST_RATE.max, INGEST_RATE.windowMs);
        if (!rl.ok) return send(res, 429, { error: "rate limit" }, { "retry-after": String(rl.retryAfter) });
        const rlIp = rateLimit(`gw-ip:${clientIp(req)}:ingest`, INGEST_RATE.max * 4, INGEST_RATE.windowMs);
        if (!rlIp.ok) return send(res, 429, { error: "rate limit" }, { "retry-after": String(rlIp.retryAfter) });

        // kill-switch de custo (paridade com /v1/ingest): a fila dispara extração cara no worker.
        const quotaIng = await checkLlmCostQuota(brain);
        if (quotaIng.exceeded) {
          return send(res, 402, {
            error: "limite diário de custo de LLM atingido",
            current_usd: quotaIng.current_usd,
            limit_usd: quotaIng.limit_usd,
          });
        }

        const body = await readJsonBody(req, INGEST_BODY_LIMIT);

        // billing (paridade com /v1/ingest; permissivo em self-host sem Stripe): 1 débito por LOTE
        // entregue — um webhook pode carregar N mensagens, o custo é do disparo, não do item.
        const entIngW = await entitlementGateV1(brain, CREDIT_COST.ingest);
        if (entIngW.deny) {
          return send(res, 402, { error: "pagamento pendente — atualize o método de pagamento", reason: "entitlement" });
        }
        const creditIngW = await gateAndDebit(brain, CREDIT_COST.ingest, "ingest", undefined, { onlyTopup: entIngW.onlyTopup });
        if (!creditIngW.ok) {
          return send(res, 402, { error: "saldo de créditos insuficiente", balance: creditIngW.balance, needed: CREDIT_COST.ingest });
        }

        let r: Awaited<ReturnType<typeof deliverIngestorWebhook>>;
        try {
          r = await deliverIngestorWebhook(brain, ing, body);
        } catch (err) {
          // erro de USO (payload ruim / normalize plugável quebrado) → 400 legível; infra segue pro 500.
          if (err instanceof IngestorUsageError) {
            console.error(`[ingestor-webhook] 400 slug=${slug} brain=${brain} err=${err.message}`);
            return send(res, 400, { error: err.message });
          }
          throw err;
        }
        await logAccess(brain, scope, `ingestor:${slug}`, r.enfileirados + r.aplicados);

        // Webhook-friendly: evento reconhecido-mas-vazio (ack, mídia sem texto) responde 202
        // "ignored" — 4xx faria a ferramenta re-tentar pra sempre. 400 SÓ quando havia itens e
        // NENHUM entrou (payload malformado de verdade — aí re-tentar até é útil pra debugar).
        if (r.recebidos > 0 && r.erros.length === r.recebidos) {
          console.error(`[ingestor-webhook] 400 lote-vazio slug=${slug} brain=${brain} erros=${r.erros.length}`);
          return send(res, 400, { error: "nenhum item do lote pôde entrar", detalhes: r.erros });
        }
        // "buffered" = mensagens acumuladas na janela de conversa (ingerem quando ela fechar).
        const status = r.recebidos === 0 ? "ignored" : r.najanela === r.recebidos ? "buffered" : "organizing";
        const meta = webhookEventMeta(body);
        console.error(
          `[ingestor-webhook] ok slug=${slug} brain=${brain} event=${meta.event || "-"} instance=${meta.instance || "-"} dataItems=${meta.dataItems} status=${status} recebidos=${r.recebidos} na_janela=${r.najanela} enfileirados=${r.enfileirados} erros=${r.erros.length}`,
        );
        return send(res, 202, {
          status,
          ingestor: r.ingestor,
          recebidos: r.recebidos,
          enfileirados: r.enfileirados,
          aplicados: r.aplicados,
          dedupados: r.dedupados,
          na_janela: r.najanela,
          jobs: r.jobs,
          ...(r.erros.length ? { erros: r.erros } : {}),
          received_at: new Date().toISOString(),
        });
      }

      // ----- POST /v1/ingest — rota de ESCRITA de texto cru (gateada por scope.canIngest) -----
      if (path === "/v1/ingest") {
        if (req.method !== "POST") return send(res, 405, { error: "use POST" });

        // GATE DE ESCRITA (fail-closed): só um token com a capacidade can_ingest pode ingerir. PRÉ-tudo
        // (antes de rate-limit/quota/parse) — a borda não dá pista de custo a quem nem pode escrever.
        if (!scope.canIngest) {
          // 403 = NEGAÇÃO TOTAL por capacidade (gancho access.denied, throttle por principal).
          emitAccessDenied(brain, scope, "can_ingest", "/v1/ingest");
          return send(res, 403, { error: "token sem capacidade de escrita (can_ingest)" });
        }

        const rl = rateLimit(`gw:${scope.principalId}:ingest`, INGEST_RATE.max, INGEST_RATE.windowMs);
        if (!rl.ok) return send(res, 429, { error: "rate limit" }, { "retry-after": String(rl.retryAfter) });
        // reforço leve por IP (anti-abuso de uma box): mais frouxo que o por-token.
        const rlIp = rateLimit(`gw-ip:${clientIp(req)}:ingest`, INGEST_RATE.max * 4, INGEST_RATE.windowMs);
        if (!rlIp.ok) return send(res, 429, { error: "rate limit" }, { "retry-after": String(rlIp.retryAfter) });

        // KILL-SWITCH de custo PRÉ-ENQUEUE: a ingestão dispara extract+embed CAROS no worker. Se o
        // acumulado de HOJE já estourou o teto diário do brain, barra ANTES de enfileirar (402).
        const quota = await checkLlmCostQuota(brain);
        if (quota.exceeded) {
          return send(res, 402, {
            error: "limite diário de custo de LLM atingido",
            current_usd: quota.current_usd,
            limit_usd: quota.limit_usd,
          });
        }

        const body = await readJsonBody(req, INGEST_BODY_LIMIT);

        // ANTI-SSRF (postura do ingest-server.ts:73-78): a borda pública JAMAIS busca URL/arquivo
        // arbitrário a partir do servidor. Só texto cru. doc_url/audio_url/doc_base64 → 410 (desligado
        // de propósito). Checa ANTES de validar source/content (rejeita o vetor mesmo sem eles).
        if (body.doc_url !== undefined || body.audio_url !== undefined) {
          return send(res, 410, {
            error: "ingestão por URL está desligada (risco SSRF) — envie o conteúdo cru no campo 'content'.",
          });
        }
        if (body.doc_base64 !== undefined) {
          return send(res, 410, {
            error: "doc_base64 não é aceito nesta borda — envie o conteúdo cru no campo 'content'.",
          });
        }

        const source = typeof body.source === "string" ? body.source.trim() : "";
        const content = typeof body.content === "string" ? body.content.trim() : "";
        if (!source) return send(res, 400, { error: "faltou 'source'" });
        if (!content) return send(res, 400, { error: "faltou 'content'" });

        // occurred_at (ISO) → jobDate (YYYY-MM-DD, o que o pipeline ancora). Inválido → 400 (não engole).
        let jobDate: string | undefined;
        if (body.occurred_at !== undefined) {
          const raw = typeof body.occurred_at === "string" ? body.occurred_at.trim() : "";
          const d = raw ? new Date(raw) : null;
          if (!d || Number.isNaN(d.getTime())) {
            return send(res, 400, { error: "occurred_at deve ser uma data ISO 8601 válida" });
          }
          jobDate = d.toISOString().slice(0, 10);
        }

        // participants (string[]) — validado mas NÃO há campo na fila de texto ad-hoc p/ carregá-lo
        // (EnqueueInput não tem people; o pipeline infere participantes do próprio conteúdo). Rejeita o
        // tipo errado (não engole silenciosamente um shape inválido).
        if (body.participants !== undefined) {
          const ok = Array.isArray(body.participants) && body.participants.every((p) => typeof p === "string");
          if (!ok) return send(res, 400, { error: "participants deve ser uma lista de strings" });
        }

        // sensitivity (enum público) — validado; o mapeamento público→interno fica registrado. O
        // pipeline de TEXTO ad-hoc (sem receita de fonte) não aceita nível por-job hoje: entra como
        // 'restrito' (=secret) por fail-closed do capture, COERENTE com o contrato ("sem receita →
        // secret"). Enum inválido → 400.
        if (body.sensitivity !== undefined) {
          const s = typeof body.sensitivity === "string" ? body.sensitivity.toLowerCase() : "";
          if (!PUBLIC_SENSITIVITY.has(s)) {
            return send(res, 400, { error: "sensitivity inválida (use open|internal|confidential|secret)" });
          }
          void SENSITIVITY_PUBLIC_TO_INTERNAL[s]; // mapeamento pronto p/ quando a fila de texto aceitar o nível
        }

        // idempotência do paste: hash do conteúdo (espelha bff-ingest.ts:73). Re-post do MESMO texto não
        // re-extrai (o capture deduplica por fatia).
        const contentHash = createHash("sha256").update(content).digest("hex").slice(0, 16);

        // M-PAY-H (Onda 3): gate de ENTITLEMENT na borda PAGA da API /v1 (paridade com web-server).
        // Assinatura lapsed (canceled/unpaid/grace vencida) bloqueia o ingest pago ANTES do crédito;
        // trial puro (sem assinatura) passa direto.
        // M-PAY-H/10: sob lapsed a ação ainda passa se o crédito PRÉ-PAGO cobre o custo (onlyTopup).
        const entIng = await entitlementGateV1(brain, CREDIT_COST.ingest);
        if (entIng.deny) {
          return send(res, 402, { error: "pagamento pendente — atualize o método de pagamento", reason: "entitlement" });
        }
        // M-PAY-C: gate+débito (ingest=30cr) APÓS validar body/SSRF — não cobra por 400/410. Conta sem
        // carteira = permissivo. SEGURANÇA (auditoria R2): chave de débito server-side por request (NÃO a
        // Idempotency-Key crua do cliente) — ingest SEMPRE enfileira novo trabalho, então uma chave fixa
        // do cliente daria ingestões grátis (claim vazio não debita, mas o job roda).
        const creditIng = await gateAndDebit(brain, CREDIT_COST.ingest, "ingest", undefined, { onlyTopup: entIng.onlyTopup });
        if (!creditIng.ok) {
          return send(res, 402, { error: "saldo de créditos insuficiente", balance: creditIng.balance, needed: CREDIT_COST.ingest });
        }

        const { jobId } = await enqueueIngestJob({
          brain,
          kind: "text",
          type: source, // o `source` público vira o `type` do job (a receita de extração do motor)
          contentHash,
          textBody: content,
          jobDate,
        });

        await logAccess(brain, scope, `ingest:${source}`, 1);
        // 202 EXATAMENTE como o contrato (ingestao.astro): batch_id = jobId, status público "organizing".
        return send(res, 202, {
          batch_id: jobId,
          status: "organizing",
          source,
          received_at: new Date().toISOString(),
        });
      }

      // ===== /v1/webhooks — REGISTRO self-serve de webhooks de saída (op de CONFIANÇA) =====
      // TODAS as 3 rotas são gateadas por scope.canIngest (403 fail-closed): registrar um webhook é uma
      // capacidade de ESCRITA/confiança (recebe eventos do brain, vê metadados). Um token read-only não
      // pode criar/listar/remover — espelho do gate de /v1/ingest. PRÉ rate-limit/parse.
      if (path === "/v1/webhooks" || webhookIdMatch) {
        if (!scope.canIngest) {
          // 403 = NEGAÇÃO TOTAL por capacidade (gancho access.denied, throttle por principal).
          emitAccessDenied(brain, scope, "can_ingest", "/v1/webhooks");
          return send(res, 403, { error: "token sem capacidade de confiança (can_ingest)" });
        }
        const rl = rateLimit(`gw:${scope.principalId}:webhooks`, WEBHOOK_RATE.max, WEBHOOK_RATE.windowMs);
        if (!rl.ok) return send(res, 429, { error: "rate limit" }, { "retry-after": String(rl.retryAfter) });
        const e = await getEngine(brain);

        // ----- POST /v1/webhooks — cria um webhook; devolve o secret UMA VEZ -----
        if (path === "/v1/webhooks" && req.method === "POST") {
          const body = await readJsonBody(req, WEBHOOK_BODY_LIMIT);

          const url = typeof body.url === "string" ? body.url.trim() : "";
          if (!url) return send(res, 400, { error: "faltou 'url'" });

          // events: subconjunto não-vazio dos 4 (sem desconhecido, sem duplicar p/ inflar).
          if (!Array.isArray(body.events) || body.events.length === 0) {
            return send(res, 400, { error: "faltou 'events' (lista não-vazia)" });
          }
          if (body.events.length > WEBHOOK_EVENTS_MAX || !body.events.every((ev) => typeof ev === "string")) {
            return send(res, 400, { error: "events inválido (máx 4 strings)" });
          }
          const events = [...new Set(body.events as string[])];
          const bad = events.filter((ev) => !WEBHOOK_EVENTS.has(ev as WebhookEvent));
          if (bad.length) {
            return send(res, 400, {
              error: `evento(s) desconhecido(s): ${bad.join(", ")} (use ingest.organized|review.pending|fact.superseded|access.denied)`,
            });
          }

          // label opcional (cosmético) — string curta.
          let label = "";
          if (body.label !== undefined) {
            if (typeof body.label !== "string") return send(res, 400, { error: "label deve ser string" });
            label = body.label.trim().slice(0, WEBHOOK_LABEL_MAX);
          }

          // SSRF SYNC no registro (1ª camada — UX + barreira; o worker revalida na entrega anti-rebinding).
          // Rejeita já na criação URL não-https / localhost / IP interno (resolve DNS p/ validar).
          const guard = await validateOutboundUrl(url);
          if (!guard.ok) {
            return send(res, 400, { error: `URL não permitida: ${guard.reason ?? "reprovada pela guarda SSRF"}` });
          }

          // secret CRU de assinatura (HMAC) — mostrado UMA VEZ aqui; a listagem nunca o devolve.
          const secret = randomBytes(32).toString("hex");
          const id = randomUUID();
          try {
            await e.putWebhook({
              id,
              url,
              events: events as WebhookEvent[],
              secret,
              label,
              status: "active",
              created_by: scope.principalId || "",
            });
          } catch (err) {
            // unique(brain,url) é arbitrado no banco → URL já registrada vira 409 (não 500 genérico).
            const msg = err instanceof Error ? err.message : String(err);
            if (/duplicate key|unique/i.test(msg)) {
              return send(res, 409, { error: "já existe um webhook com esta URL neste brain" });
            }
            throw err; // outro erro → 500 genérico no catch externo
          }
          await logAccess(brain, scope, `webhook:create`, 1);
          // 201 com o secret MOSTRADO UMA VEZ (o cliente o guarda p/ verificar X-Galeed-Signature).
          return send(res, 201, { id, url, events, secret, status: "active" });
        }

        // ----- GET /v1/webhooks — lista do brain (SEM secret) -----
        if (path === "/v1/webhooks" && req.method === "GET") {
          const hooks = await e.listWebhooks(); // secret = "" em cada linha (store nunca o devolve)
          const list = hooks.map((h) => ({
            id: h.id,
            url: h.url,
            events: h.events,
            label: h.label,
            status: h.status,
            created_at: h.created_at,
            last_delivery_at: h.last_delivery_at ?? null,
            last_error: h.last_error || "",
            failure_count: h.failure_count ?? 0,
          }));
          await logAccess(brain, scope, `webhook:list`, list.length);
          return send(res, 200, { webhooks: list });
        }

        // ----- DELETE /v1/webhooks/:id — remove (só do brain do token; id alheio → 404) -----
        if (webhookIdMatch && req.method === "DELETE") {
          const id = decodeURIComponent(webhookIdMatch[1]);
          // getWebhook escopa por brain DO TOKEN → id de outro tenant volta undefined → 404 (não vaza).
          const existing = await e.getWebhook(id);
          if (!existing) return send(res, 404, { error: "webhook não encontrado" });
          await e.deleteWebhook(id);
          await logAccess(brain, scope, `webhook:delete`, 1);
          return send(res, 200, { id, deleted: true });
        }

        // método errado numa rota de webhook conhecida → 405.
        return send(res, 405, {
          error: path === "/v1/webhooks" ? "use POST ou GET" : "use DELETE",
        });
      }

      // ----- GET /v1/ingest/:jobId — status público do batch (escopado por brain do token) -----
      if (ingestJobMatch) {
        if (req.method !== "GET") return send(res, 405, { error: "use GET" });
        const rl = rateLimit(`gw:${scope.principalId}:ingest-status`, FACTS_RATE.max, FACTS_RATE.windowMs);
        if (!rl.ok) return send(res, 429, { error: "rate limit" }, { "retry-after": String(rl.retryAfter) });

        const jobId = decodeURIComponent(ingestJobMatch[1]);
        // getJob escopa por brain DO TOKEN → job de outro tenant volta null → 404 (não vaza cross-tenant).
        const job = await getJob(brain, jobId);
        if (!job) return send(res, 404, { error: "batch não encontrado" });
        return send(res, 200, toPublicJob(job));
      }

      return send(res, 404, { error: "rota desconhecida", rotas: ROUTES });
    } catch (e) {
      // erros de body/validação (HttpError) saem com o código real; o resto vira 500 GENÉRICO.
      if (e instanceof HttpError) return send(res, e.code, { error: e.message });
      console.error("[gateway] erro 500:", e); // loga no stderr — NÃO vaza message pro cliente
      return send(res, 500, { error: "erro interno" });
    }
  });

  server.listen(port, () =>
    console.error(`🌐 galeed GATEWAY /v1 (público: leitura + ingestão can_ingest) no ar :${port}  (bootstrap brain: ${bootHome})`),
  );
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) startGatewayServer();
