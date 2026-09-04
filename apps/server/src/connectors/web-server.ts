#!/usr/bin/env -S npx tsx
/** M8/S2 — BFF (Backend-For-Frontend) do console Galeed.
 *
 *  Servidor ÚNICO do front (porta WEB_PORT=8789). Zero-dep (só node: builtins + a lib `postgres`
 *  via core/accounts.ts). Espelha o estilo do api-server.ts (node:http, send(), resolveBrain) e
 *  NÃO duplica lógica de leitura: IMPORTA query.ts/ask.ts (território do core; import ≠ edição).
 *
 *  Responsabilidades:
 *   - /api/health                        → liveness (NÃO toca DB).
 *   - /auth/{signup,login,logout,me}     → contas + sessão (core/accounts.ts), cookie httpOnly.
 *   - /api/{stats,graph,retrieve,search,facts,timeline}  → proxy de leitura (query.ts), exige sessão.
 *   - /api/graph?asOf=                   → grafo "como era em T" (TODO: derivar de facts/timeline).
 *   - /api/ask?q=                        → síntese LLM (ask.ts) — único endpoint caro.
 *   - /api/rbac/*                        → RBAC REAL do M7 (principals/grants/access_log + accessTest),
 *                                         só pras telas de GESTÃO. Shapes idênticos ao contrato do front.
 *   - estático de web/dist               → SPA em prod; no-op em dev (Vite serve e proxia).
 *
 *  Multi-tenant: o brain vem de ?brain= OU do currentBrain da sessão; valida membership SEMPRE. */
// Carrega .env (como o cli.ts): o BFF precisa de ANTHROPIC_API_KEY (ask) e OPENAI_API_KEY (busca
// semântica). Depender só do env exportado é frágil — robustez igual ao cli.
try {
  process.loadEnvFile();
} catch {
  /* sem .env: usa process.env */
}
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { rateLimit } from "../lib/rate-limit.ts"; // P0 — limitador em memória (janela fixa por chave)
import { applySecurityHeaders } from "../lib/security-headers.ts"; // ACHADO #8 — extraído p/ reuso (BFF/gateway)
// P0 (#7) — defesas anti-DoS de JSON extraídas p/ src/lib (reusadas por BFF/ingest/gateway). HttpError
// re-exportado abaixo (compat com test/unit/p0-dos-json.test.ts e clientip-xff-spoof.test.ts).
import { scanJsonDepthPreParse, guardJsonShape, HttpError } from "../lib/json-safety.ts";
import { readFile, stat } from "node:fs/promises";
import { join, normalize, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { retrieve, search, timeline, entityGraph, entityFacts, stats } from "../core/retrieval/query.ts";
import { askStream } from "../core/retrieval/ask.ts"; // M18/S2 — síntese streamada (prosa token-a-token)
// M10/S2: handlers tipados de LEITURA do M9 (facts/ask enriquecido/custo). M10/S3: handlers de ESCRITA
// RBAC (invite/grant/token/revoke). Ambos PUROS; o BFF (zona neutra) só roteia. BffError unificado.
import { factsHandler, askHandler, costHandler, askStreamPayload } from "./bff/bff-m9.ts";
import { percepcoesHandler } from "./bff/bff-percepcoes.ts"; // M24-E — percepções do sono
import { rbacInvite, rbacGrant, rbacTokenIssue, rbacTokenRevoke, rbacTokenRotate, rbacPrincipalRemove } from "./bff/bff-rbac-write.ts";
import { sourceHandler } from "./bff/bff-blob.ts"; // M11/S3 — fonte verbatim (blob) gateada pelo RBAC
import { onboardingStart, onboardingReply, onboardingConfirm } from "./bff/bff-onboarding.ts"; // M11/S4 — onboarding de contexto
import { ingestHandler } from "./bff/bff-ingest.ts"; // M11/S5 → M12: import assíncrono (enfileira)
import { listJobsHandler, getJobHandler } from "./bff/bff-jobs.ts"; // M12 — status da fila de ingestão
import { saudeHandler } from "./bff/bff-saude.ts"; // saúde real: sono + armazenamento + fila por status
import { lixeiraHandler, restaurarHandler } from "./bff/bff-lixeira.ts"; // lixeira de páginas (ver + restaurar)
// M21/S3 — fontes com receita + fila de revisão (regra de ouro). Handlers PUROS; o BFF só roteia.
import {
  listSourcesHandler, createSourceHandler, updateSourceHandler, setSourceStatusHandler,
  listHypothesesHandler, hypothesesCountHandler, approveHypothesisHandler, discardHypothesisHandler,
} from "./bff/bff-sources.ts";
// M25-A — fila em escala: grupos por decisão + ações em lote GATEADAS (zero LLM).
import {
  listHypothesisGroupsHandler, approveGroupHandler, discardGroupHandler, addDimensionGroupHandler,
} from "./bff/bff-review.ts";
import { judgeHandler, judgeCalibrationHandler, judgeEstimateHandler } from "./bff/bff-judge.ts"; // M25-B — juiz triador
import { wizardStart, wizardReply, wizardConfirm } from "./bff/bff-wizard.ts"; // M21/S4 — wizard de criação de cérebro
import { contextGet, contextSave, contextPreview, reextractEstimate, reextractRun } from "./bff/bff-context-edit.ts"; // M11/S6 — editar contexto + re-extração
// M22-A — conectores (seam + Nango): webhook m2m (auth = HMAC, fail-closed), connect session por fonte,
// criar fonte-conector e status. requireBrain nas rotas com sessão; o webhook é SEM sessão.
import { nangoWebhookHandler, connectSessionHandler, connectorCreateHandler, connectorsStatusHandler, readRawBody } from "./bff/bff-connectors.ts";
// M-PAY-A/B — webhook (m2m) + billing (account-scoped) do Stripe.
import { stripeWebhookHandler, createCheckoutHandler, createPortalHandler, getSubscriptionHandler, getCreditsHandler, createTopupHandler, getFounderSeatsHandler, getBillingPrefsHandler, setBillingPrefsHandler } from "./bff/bff-stripe.ts";
import { evolutionStatusHandler, evolutionConnectHandler, evolutionQrHandler } from "./bff/bff-evolution.ts";
import { gateAndDebit, grantTrial, billingEnabled, CREDIT_COST, listLedger, getSpendCap, setSpendCap, topupRemainingOfBrain, type GateResult } from "../core/platform/credits.ts";
import { assertEntitledByBrain } from "../core/platform/entitlement.ts";
import { resolveProvider, subscriptionAvailable } from "../lib/llm.ts";
import { config as platformConfig } from "../core/platform/config.ts";
import { registerBuiltinIngestors } from "../core/ingestion/ingestors/boot.ts";
import { listIngestors } from "../core/ingestion/ingestors/registry.ts";

/** Preflight de IA nas rotas de síntese (ask): sem ANTHROPIC_API_KEY, sem `claude` e sem
 *  ChatGPT/Codex (`~/.codex/auth.json`), a síntese falharia lá na frente. Melhor um 503 claro.
 *  Busca/FTS não passam por aqui. */
function aiUnavailableMsg(): string | null {
  const msg =
    "Este servidor está sem IA configurada: defina ANTHROPIC_API_KEY, instale o CLI `claude`, ou " +
    "autentique ChatGPT/Codex (`~/.codex/auth.json` + GALEED_PROVIDER=codex) e reinicie. " +
    "A busca por palavra-chave continua funcionando sem IA.";
  try {
    const p = resolveProvider(platformConfig().provider);
    if (p === "cli") return subscriptionAvailable() ? null : msg;
    return process.env.ANTHROPIC_API_KEY ? null : msg;
  } catch {
    return msg;
  }
}

/** Corpo do 402: distingue teto de gasto (cap) de saldo insuficiente (balance). A UI mostra cópia
 *  diferente (ajustar teto vs recarregar). */
function creditDeniedBody(credit: GateResult, needed: number) {
  return credit.capHit
    ? { error: "teto de gasto do mês atingido", reason: "cap", balance: credit.balance }
    : { error: "saldo de créditos insuficiente", reason: "balance", balance: credit.balance, needed };
}

/** M-PAY-H (Onda 3 + /10) — gate de ENTITLEMENT nas bordas pagas (ask/ingest/capture). Roda ANTES do
 *  gate de crédito. Contas SEM assinatura (trial puro) nunca caem aqui (reason 'none' → entitled).
 *  Decisão: assinatura inadimplente fora da graça (canceled/unpaid/past_due vencido) bloqueia o BOLO
 *  da assinatura — MAS NÃO confisca o crédito PRÉ-PAGO (top-up) que o cliente comprou avulso.
 *  M-PAY-H/10 (DECISÃO DO FUNDADOR): sob LAPSED, a ação PASSA se e somente se topup_remaining >= custo;
 *  nesse caso o débito sai SÓ do pré-pago (flag onlyTopup → gateAndDebit debita primeiro do topup).
 *  Retorna:
 *    • { deny } — o corpo do 402 a enviar (lapsed sem pré-pago suficiente, ou erro de leitura).
 *    • { onlyTopup:true } — lapsed mas o pré-pago cobre → seguir, debitando só do topup.
 *    • {} — conta em dia (entitled) → gate de crédito normal.
 *  Resolve a conta pelo OWNER do BRAIN (paridade débito↔gate). */
async function entitlementGate(
  brain: string,
  cost: number,
): Promise<{ deny?: { error: string; reason: string }; onlyTopup?: boolean }> {
  if (!billingEnabled()) return {}; // self-host sem Stripe: sem assinatura pra cobrar
  const e = await assertEntitledByBrain(brain);
  if (e.entitled) return {};
  // LAPSED: libera SÓ se o crédito pré-pago cobre o custo (o que o cliente comprou continua gastável).
  const prepaid = await topupRemainingOfBrain(brain);
  if (prepaid !== null && prepaid >= cost) return { onlyTopup: true };
  return { deny: { error: "pagamento pendente — atualize o método de pagamento", reason: "entitlement" } };
}
import { recordReferral } from "../core/platform/referral.ts";
import { registerProductionConnectors } from "../core/ingestion/connector-registry-boot.ts"; // M22 reconcile — pluga conta-azul + gmail no seam
import { BffError } from "./bff/bff-common.ts";
import {
  createAccount,
  accountByEmail,
  createSession,
  sessionAccount,
  destroySession,
  brainsOf,
  addBrainMembership,
  brainExists,
  verifyPassword,
  hashPassword, // ACHADO #14 — burn de tempo constante no login (mesmo custo scrypt das senhas reais)
  validatePasswordStrength, // FOLLOW-UP SENHA — política autoritativa no signup (400, não 500)
  type Account,
  type Brain,
  type Session,
} from "../core/access/accounts.ts";

const COOKIE = "galeed_sess";
const SESSION_MAX_AGE = 30 * 24 * 60 * 60; // segundos (30d) — casa com o TTL de accounts.ts
// Body máx: uploads chegam como base64 no JSON (infla ~33%), então um doc de N MB vira ~1.33N MB de
// body. 25 MiB cobre arquivos de ~18 MB (PDF/WhatsApp/etc.). Chamadas JSON normais ficam muito abaixo.
const BODY_LIMIT = 25 * (1 << 20); // 25 MiB
const WEB_DIST = fileURLToPath(new URL("../../../web/dist", import.meta.url));

// ---------- helpers HTTP ----------

function send(res: ServerResponse, code: number, obj: unknown, extraHeaders: Record<string, string> = {}): void {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": process.env.WEB_CORS_ORIGIN || "*",
    "access-control-allow-credentials": "true",
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    ...extraHeaders,
  });
  res.end(body);
}

/** Normaliza os hits do core para o shape de Selo do contrato (§5): o core emite `selo.natureza`,
 *  o componente Seal do front consome `selo.tipo`. Mantém `natureza` por compat e preenche `tipo`. */
function normHits(hits: unknown): unknown {
  if (!Array.isArray(hits)) return hits;
  return hits.map((h) => {
    const hit = h as { selo?: Record<string, unknown> };
    if (hit && hit.selo && hit.selo.tipo === undefined && hit.selo.natureza !== undefined) {
      return { ...hit, selo: { ...hit.selo, tipo: hit.selo.natureza } };
    }
    return h;
  });
}

// P0 (#7) — HttpError + scan/guard de JSON foram EXTRAÍDOS p/ src/lib/json-safety.ts (reuso por
// BFF/ingest/gateway). Re-export aqui mantém o contrato dos testes (test/unit/p0-dos-json.test.ts e
// clientip-xff-spoof.test.ts importam estes nomes de web-server.ts) sem duplicar a lógica.
export { HttpError, scanJsonDepthPreParse, guardJsonShape };

/** Lê o body JSON de um request POST, com limite de tamanho. */
function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (c: Buffer) => {
      if (tooLarge) return; // já estourou: descarta o resto (sem bufferizar) e deixa o stream drenar
      size += c.length;
      if (size > BODY_LIMIT) {
        tooLarge = true;
        // NÃO destrói a conexão (req.destroy aborta a resposta → o proxy do Vite vira 500). Rejeita
        // limpo → o catch da rota envia um 413 legível. req.resume() drena os bytes restantes.
        reject(new HttpError(413, `arquivo grande demais (máx ${Math.floor(BODY_LIMIT / (1 << 20))} MB).`));
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
      try {
        guardJsonShape(parsed); // P0 — barra aninhamento profundo / explosão de nós (DoS de parse)
      } catch (e) {
        return reject(e instanceof HttpError ? e : new HttpError(400, "JSON muito complexo"));
      }
      resolve(parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {});
    });
    req.on("error", () => reject(new HttpError(400, "erro lendo body")));
  });
}

/** Parse simples de cookies do header. */
function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// Secure: em dev local o front roda em HTTP e o browser DESCARTA cookies Secure → login quebraria.
// SECURE_COOKIES é override EXPLÍCITO ("1"=on, "0"=off) — necessário p/ rodar a imagem de prod
// (NODE_ENV=production) sobre HTTP local. Sem o env, o default segue NODE_ENV (prod=on).
// HttpOnly + SameSite=Lax em todos os casos.
const SECURE =
  process.env.SECURE_COOKIES === "1" ? true
  : process.env.SECURE_COOKIES === "0" ? false
  : process.env.NODE_ENV === "production";
function sessionCookie(token: string): string {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE}${SECURE ? "; Secure" : ""}`;
}
function clearCookie(): string {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${SECURE ? "; Secure" : ""}`;
}

/** IP do cliente: ÚLTIMO hop de x-forwarded-for (apendado pelo proxy) ou o socket remoto.
 *  FOLLOW-UP XFF — só confia no x-forwarded-for quando TRUST_PROXY==='1' (há um proxy reverso na
 *  frente); sem isso, qualquer cliente forjaria o header e burlaria o rate-limit. Default = socket.
 *  CRÍTICO: o proxy DEVE *apendar* (não sobrescrever) o IP real do cliente à DIREITA do header — é o
 *  que nginx (`proxy_add_x_forwarded_for`), Caddy e ALB fazem. Por isso lemos o RIGHTMOST: o leftmost
 *  é controlado pelo atacante (qualquer um manda `X-Forwarded-For: vítima` e rotaciona a janela do
 *  rate-limit). O rightmost é o IP que o último hop confiável observou e apendou. Sob N proxies
 *  encadeados o ideal é contar TRUST_PROXY_HOPS a partir da direita (1 hop = rightmost). */
export function clientIp(req: IncomingMessage): string {
  if (process.env.TRUST_PROXY === "1") {
    const xff = req.headers["x-forwarded-for"];
    const raw = Array.isArray(xff) ? xff[0] : xff;
    if (raw) {
      const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
      const first = parts[parts.length - 1];
      if (first) return first;
    }
  }
  return req.socket.remoteAddress || "unknown";
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

// ---------- auth / multi-tenant ----------

/** Monta o objeto Session (account + brains + currentBrain) p/ uma conta. */
async function buildSession(account: Account, preferBrain?: string): Promise<Session> {
  const brains = await brainsOf(account.id);
  const current = preferBrain && brains.some((b) => b.id === preferBrain) ? preferBrain : brains[0]?.id || "";
  return { account, brains, currentBrain: current };
}

/** Resolve a conta a partir do cookie do request (ou null). NÃO toca DB se não houver cookie. */
async function accountFromReq(req: IncomingMessage): Promise<Account | null> {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return null;
  return sessionAccount(token);
}

/** Exige sessão válida; resolve o brain do request (?brain= ou currentBrain) e VALIDA membership.
 *  Lança HttpError(401) sem sessão, HttpError(403) se o brain não pertence à conta. */
async function requireBrain(req: IncomingMessage, u: URL): Promise<{ account: Account; brains: Brain[]; home: string }> {
  const account = await accountFromReq(req);
  if (!account) throw new HttpError(401, "não autenticado");
  const brains = await brainsOf(account.id);
  const requested = u.searchParams.get("brain") || "";
  const home = requested || brains[0]?.id || "";
  if (!home) throw new HttpError(403, "conta sem brain");
  if (!brains.some((b) => b.id === home)) throw new HttpError(403, "sem acesso a esse brain");
  return { account, brains, home };
}

// ---------- RBAC REAL (M7/R16 — `core/principals.ts` + `core/scope.ts` + engine) ----------
// Os shapes de resposta são EXATAMENTE os que o front consome (web/src/lib/api.ts: Principal,
// AccessPreview, AccessLogEntry). Trocamos a fonte (mock → M7 real) sem mexer no contrato.
//
// NOTA DE ESCOPO: o RBAC fino aqui é só pras TELAS DE GESTÃO de principais (Acesso/Funcionário).
// As rotas de consulta do DONO (/api/ask, /api/search, /api/retrieve, /api/graph, /api/stats)
// seguem SEM escopo (admin) — ver comentário no bloco de proxy de leitura.
import { accessTest } from "../core/access/principals.ts";
import { getEngine } from "../core/platform/engine.ts";
// M10/S3: o shape de leitura dos principais (toPrincipalShape/labelOfArea/uiLevelOf) foi EXTRAÍDO p/
// ./bff-rbac-shape.ts no reconcile — os handlers de ESCRITA (bff-rbac-write.ts) reusam o MESMO shape.
import { toPrincipalShape, labelOfArea } from "./bff/bff-rbac-shape.ts";

/** /api/rbac/principals real: cada principal do brain + seu grant + tokens. */
async function rbacPrincipals(home: string): Promise<unknown[]> {
  const e = await getEngine(home);
  const principals = await e.allPrincipals();
  const out: unknown[] = [];
  for (const p of principals) {
    const grant = await e.getGrant(p.id);
    const tokens = await e.tokensOf(p.id);
    out.push(toPrincipalShape(p, grant, tokens));
  }
  return out;
}

/** /api/rbac/areas real: o M7 NÃO tem tabela de áreas. ESCOLHA documentada: derivar o conjunto de
 *  áreas das tags `area:<slug>` distintas das páginas do brain, com contagem real por área, em
 *  UNIÃO com as áreas citadas em grants existentes (count 0) — a matriz do Acesso precisa da
 *  coluna mesmo antes da primeira memória etiquetada; '*' (acesso total) não é área. É esta a
 *  fonte da tela Acesso (a lista fixa do front morreu junto com as origens inventadas). */
async function rbacAreas(home: string): Promise<unknown[]> {
  const e = await getEngine(home);
  const pages = await e.allPages();
  const counts = new Map<string, number>();
  for (const pg of pages) {
    for (const tag of pg.tags ?? []) {
      if (tag.startsWith("area:")) {
        const slug = tag.slice(5);
        if (slug) counts.set(slug, (counts.get(slug) ?? 0) + 1);
      }
    }
  }
  for (const p of await e.allPrincipals()) {
    const grant = await e.getGrant(p.id).catch(() => null);
    for (const slug of grant?.areas ?? []) {
      if (slug && slug !== "*" && !counts.has(slug)) counts.set(slug, 0);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([slug, count]) => ({
      slug,
      label: labelOfArea(slug),
      count,
    }));
}

/** /api/rbac/preview real: usa accessTest(home, principalId) do M7 (scope + visiblePages +
 *  sampleSlugs REAIS). Adapta ao shape AccessPreview. `blocked` = páginas totais − visíveis (real).
 *  `visibleFacts` não é calculável barato aqui (accessTest é por página) → 0 (não fabrica número).
 *  `results` = [] : o mock devolvia exemplos hard-coded de itens visíveis/bloqueados; sem fabricar
 *  conteúdo, devolvemos vazio (o ViewAsOverlay já trata `results ?? []`). O sinal real do escopo
 *  está em scope + visiblePages + blocked + sampleSlugs. */
async function rbacPreview(home: string, principalId: string): Promise<unknown> {
  const e = await getEngine(home);
  const totalPages = (await e.allPages()).length;
  const { scope, visiblePages, sampleSlugs } = await accessTest(home, principalId);
  return {
    scope: { principalId: scope.principalId, areas: scope.areas, sensitivityMax: scope.sensitivityMax },
    visiblePages,
    visibleFacts: 0, // não calculado por página; não fabricar
    blocked: Math.max(0, totalPages - visiblePages),
    sampleSlugs,
    results: [], // sem fabricar conteúdo de exemplo; o real está nos campos acima
  };
}

/** /api/rbac/log real: trilha de auditoria do brain (AccessLogRow → AccessLogEntry). `ts` coalesce. */
async function rbacLog(home: string, limit: number): Promise<unknown[]> {
  const e = await getEngine(home);
  const rows = await e.recentAccessLog(limit);
  return rows.map((r) => ({
    principal_id: r.principal_id,
    ts: r.ts ?? "",
    query: r.query,
    areas_touched: r.areas_touched ?? [],
    n_returned: r.n_returned ?? 0,
    event: r.event ?? null,
    actor: r.actor ?? null,
  }));
}

// ---------- estático (SPA em prod) ----------

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon",
  ".woff": "font/woff", ".woff2": "font/woff2", ".map": "application/json",
};

/** Serve um asset estático de web/dist. Retorna true se respondeu; false se não há dist/arquivo
 *  (em dev a pasta não existe → no-op, o Vite serve). SPA-fallback p/ index.html em rotas de app. */
async function serveStatic(res: ServerResponse, pathname: string): Promise<boolean> {
  let distExists = false;
  try {
    distExists = (await stat(WEB_DIST)).isDirectory();
  } catch {
    return false; // sem build → dev mode
  }
  if (!distExists) return false;
  const rel = normalize(pathname).replace(/^(\.\.[/\\])+/, "").replace(/^[/\\]+/, "");
  const candidate = rel ? join(WEB_DIST, rel) : "";
  const tryFile = async (file: string): Promise<boolean> => {
    try {
      const s = await stat(file);
      if (!s.isFile()) return false;
      const buf = await readFile(file);
      res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
      res.end(buf);
      return true;
    } catch {
      return false;
    }
  };
  if (candidate && (await tryFile(candidate))) return true;
  // SPA fallback: qualquer rota sem extensão → index.html
  if (!extname(pathname)) return tryFile(join(WEB_DIST, "index.html"));
  return false;
}

// ---------- servidor ----------

export function startWebServer() {
  const port = Number(process.env.WEB_PORT || 8789);
  registerProductionConnectors(); // M22 — handlers conta-azul + gmail vivos no seam (webhook ingere neste processo)

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      applySecurityHeaders(res, SECURE); // ACHADO #8 — cobre send()/SSE/estático (antes do dispatch); gate HSTS = SECURE (env)
      if (req.method === "OPTIONS") return send(res, 204, {});
      const u = new URL(req.url || "/", `http://localhost:${port}`);
      const path = u.pathname.replace(/\/+$/, "") || "/";
      const method = req.method || "GET";

      // --- health (sem DB) ---
      // `billing:false` (self-host sem Stripe) → o front esconde Plano/créditos. Não toca DB.
      if (path === "/api/health" || path === "/health") return send(res, 200, { ok: true, billing: billingEnabled() });

      // --- INGESTORES (metadados do registry, sem DB; INGESTORES.md) — o painel Conectar lista os
      // webhooks prontos. A EXECUÇÃO vive no gateway (/v1/ingestors/:slug, Bearer can_ingest). ---
      if (path === "/api/ingestors" && method === "GET") {
        registerBuiltinIngestors();
        return send(res, 200, { ingestors: listIngestors() });
      }

      // --- M22-A: webhook do Nango (m2m — auth é a assinatura HMAC; fail-closed §LEI III). ANTES de
      // qualquer bloco com sessão (sem cookie; o handler NUNCA lança — devolve {status, body}). ---
      if (path === "/api/connectors/nango/webhook" && method === "POST") {
        const raw = await readRawBody(req);
        const out = await nangoWebhookHandler(raw, req.headers);
        return send(res, out.status, out.body);
      }

      // --- M-PAY-A: webhook do Stripe (m2m — auth = assinatura do Stripe; sem sessão). Body RAW
      // obrigatório p/ a verificação de assinatura. O handler NUNCA lança — devolve {status, body}. ---
      if (path === "/api/webhooks/stripe" && method === "POST") {
        const raw = await readRawBody(req);
        const out = await stripeWebhookHandler(raw, req.headers);
        return send(res, out.status, out.body);
      }

      // --- auth ---
      if (path === "/auth/signup" && method === "POST") {
        // Rate limit por IP (anti brute-force / abuso de criação de conta). 429 ANTES de tocar DB.
        const rl = rateLimit(`auth:${clientIp(req)}`, 10, 60_000);
        if (!rl.ok) return send(res, 429, { error: "muitas tentativas" }, { "retry-after": String(rl.retryAfter) });
        const b = await readJsonBody(req);
        const name = str(b.name), email = str(b.email), password = str(b.password), brainName = str(b.brainName);
        if (!email || !password) return send(res, 400, { error: "email e senha obrigatórios" });
        // Pré-check de senha (UX): 400 limpo aqui; a validação autoritativa fica em accounts.ts.
        if (password.length < 8) return send(res, 400, { error: "senha deve ter ao menos 8 caracteres" });
        if (await accountByEmail(email)) return send(res, 409, { error: "email já cadastrado" });
        // P0-B (mata C2): brainName que já existe = takeover → 409 ANTES de criar a conta.
        if (brainName && (await brainExists(brainName.trim())))
          return send(res, 409, { error: "esse nome de cérebro já existe — escolha outro." });
        // FOLLOW-UP SENHA — política autoritativa ANTES de createAccount: senha fraca vira 400 limpo
        // (sem isso, o throw de validatePasswordStrength dentro de createAccount viraria 500).
        try {
          validatePasswordStrength(password);
        } catch {
          return send(res, 400, { error: "senha fraca" });
        }
        const account = await createAccount({ name, email, password, brainName: brainName || undefined });
        // M-PAY-H (Onda 2): trial de boas-vindas (1000cr / 14d → read-only ao expirar). Idempotente
        // por conta; cria a carteira (a conta nova deixa de ser "não-billada"). Fail-soft (não quebra signup).
        await grantTrial(account.id);
        // M-PAY-F: atribuição de indicação (ref = id da conta do indicador). Fail-soft (não quebra signup).
        await recordReferral(account.id, str(b.ref) || undefined);
        const token = await createSession(account.id);
        const session = await buildSession(account, brainName || undefined);
        return send(res, 200, session, { "set-cookie": sessionCookie(token) });
      }

      if (path === "/auth/login" && method === "POST") {
        // Rate limit por IP (anti brute-force de senha). 429 ANTES de tocar DB.
        const rl = rateLimit(`auth:${clientIp(req)}`, 10, 60_000);
        if (!rl.ok) return send(res, 429, { error: "muitas tentativas" }, { "retry-after": String(rl.retryAfter) });
        const b = await readJsonBody(req);
        const email = str(b.email), password = str(b.password);
        if (!email || !password) return send(res, 400, { error: "email e senha obrigatórios" });
        const acc = await accountByEmail(email);
        // ACHADO #14 — tempo constante: sem conta, ainda roda um verifyPassword dummy (resultado
        // descartado) antes do MESMO 401, p/ não vazar a existência do email pelo tempo de resposta.
        const ok = acc
          ? await verifyPassword(password, acc.passHash)
          : (await hashPassword(password), false); // sem conta: queima 1 scrypt no MESMO custo atual
        if (!acc || !ok) {
          return send(res, 401, { error: "email ou senha inválidos" });
        }
        const account: Account = { id: acc.id, name: acc.name, email: acc.email };
        const token = await createSession(account.id);
        const session = await buildSession(account);
        return send(res, 200, session, { "set-cookie": sessionCookie(token) });
      }

      if (path === "/auth/logout" && method === "POST") {
        const token = parseCookies(req.headers.cookie)[COOKIE];
        if (token) await destroySession(token);
        return send(res, 200, { ok: true }, { "set-cookie": clearCookie() });
      }

      if (path === "/auth/me") {
        // sem cookie → null SEM tocar o DB
        const token = parseCookies(req.headers.cookie)[COOKIE];
        if (!token) return send(res, 200, null);
        const account = await sessionAccount(token);
        if (!account) return send(res, 200, null, { "set-cookie": clearCookie() });
        return send(res, 200, await buildSession(account, u.searchParams.get("brain") || undefined));
      }

      // --- M-PAY-B: billing (account-scoped; precisa de sessão). O cliente só informa o NOME do tier;
      // o price_id é resolvido server-side por lookup_key. O estado da assinatura vem por webhook. ---
      if (path === "/api/billing/checkout" && method === "POST") {
        const account = await accountFromReq(req);
        if (!account) return send(res, 401, { error: "não autenticado" });
        // M-PAY-H (auditoria): rate-limit das mutações de billing por CONTA — 429 ANTES de tocar o
        // Stripe (mesmo helper de /auth e /api/ask). Barra abuso de criação de sessão/portal/cobrança.
        const rl = rateLimit(`billing:${account.id}`, 10, 60_000);
        if (!rl.ok) return send(res, 429, { error: "muitas tentativas" }, { "retry-after": String(rl.retryAfter) });
        const b = (await readJsonBody(req)) as any;
        const out = await createCheckoutHandler(account, String(b?.tier ?? ""), String(b?.cohort ?? "standard"));
        return send(res, out.status, out.body);
      }
      if (path === "/api/billing/portal" && method === "POST") {
        const account = await accountFromReq(req);
        if (!account) return send(res, 401, { error: "não autenticado" });
        const rl = rateLimit(`billing:${account.id}`, 10, 60_000);
        if (!rl.ok) return send(res, 429, { error: "muitas tentativas" }, { "retry-after": String(rl.retryAfter) });
        const out = await createPortalHandler(account);
        return send(res, out.status, out.body);
      }
      if (path === "/api/billing/subscription" && method === "GET") {
        const account = await accountFromReq(req);
        if (!account) return send(res, 401, { error: "não autenticado" });
        return send(res, 200, await getSubscriptionHandler(account));
      }
      if (path === "/api/billing/credits" && method === "GET") {
        const account = await accountFromReq(req);
        if (!account) return send(res, 401, { error: "não autenticado" });
        return send(res, 200, await getCreditsHandler(account));
      }
      if (path === "/api/billing/founder" && method === "GET") {
        // M-PAY-F: vagas da Turma Fundadora — PÚBLICO (a landing mostra "X vagas restantes").
        return send(res, 200, await getFounderSeatsHandler());
      }
      if (path === "/api/billing/topup" && method === "POST") {
        const account = await accountFromReq(req);
        if (!account) return send(res, 401, { error: "não autenticado" });
        const rl = rateLimit(`billing:${account.id}`, 10, 60_000);
        if (!rl.ok) return send(res, 429, { error: "muitas tentativas" }, { "retry-after": String(rl.retryAfter) });
        const b = (await readJsonBody(req)) as any;
        const out = await createTopupHandler(account, String(b?.package ?? ""));
        return send(res, out.status, out.body);
      }
      if (path === "/api/billing/ledger" && method === "GET") {
        // M-PAY front: visão do ledger (saldo+split, série de consumo, histórico) — account-scoped.
        const account = await accountFromReq(req);
        if (!account) return send(res, 401, { error: "não autenticado" });
        return send(res, 200, await listLedger(account.id, {
          limit: Number(u.searchParams.get("limit")) || undefined,
          days: Number(u.searchParams.get("days")) || undefined,
        }));
      }
      if (path === "/api/billing/prefs" && method === "GET") {
        // M-PAY-H (Onda 4): preferências de auto-recarga + sinais de dunning (account-scoped).
        const account = await accountFromReq(req);
        if (!account) return send(res, 401, { error: "não autenticado" });
        return send(res, 200, await getBillingPrefsHandler(account));
      }
      if (path === "/api/billing/prefs" && method === "PUT") {
        const account = await accountFromReq(req);
        if (!account) return send(res, 401, { error: "não autenticado" });
        const b = (await readJsonBody(req)) as any;
        const out = await setBillingPrefsHandler(account, {
          enabled: !!b?.enabled,
          thresholdCredits: Number(b?.thresholdCredits) || 0,
          package: b?.package ? String(b.package) : null,
        });
        return send(res, out.status, out.body);
      }
      if (path === "/api/billing/cap" && method === "GET") {
        const account = await accountFromReq(req);
        if (!account) return send(res, 401, { error: "não autenticado" });
        return send(res, 200, await getSpendCap(account.id));
      }
      if (path === "/api/billing/cap" && method === "PUT") {
        const account = await accountFromReq(req);
        if (!account) return send(res, 401, { error: "não autenticado" });
        const b = (await readJsonBody(req)) as any;
        return send(res, 200, await setSpendCap(account.id, {
          enabled: !!b?.enabled,
          killSwitch: !!b?.killSwitch,
          limitCredits: Number(b?.limitCredits) || 0,
        }));
      }

      // --- M18/S3 (seam): streaming SSE da síntese (prosa token-a-token). ANTES do bloco genérico
      // /api/ (switch JSON), porque o SSE escreve um stream cru — não passa pelo send() JSON. Auth via
      // requireBrain (cookie same-origin do EventSource); 401/403/400 vão como JSON normal (não SSE). ---
      if (path === "/api/ask/stream" && method === "GET") {
        const q = u.searchParams.get("q") || "";
        const { account, home } = await requireBrain(req, u); // lança HttpError → catch → JSON (antes de abrir o stream)
        // Rota cara de LLM: limita por CONTA (autenticada via requireBrain acima). 429 JSON antes do SSE.
        const rl = rateLimit(`ask:${account.id}`, 30, 60_000);
        if (!rl.ok) return send(res, 429, { error: "muitas tentativas" }, { "retry-after": String(rl.retryAfter) });
        if (!q) return send(res, 400, { error: "faltou ?q=" });
        const aiMsgStream = aiUnavailableMsg();
        if (aiMsgStream) return send(res, 503, { error: aiMsgStream }); // JSON antes de abrir o SSE
        const k = Number(u.searchParams.get("k")) || 8;

        // M-PAY-H: gate de entitlement (assinatura inadimplente fora da graça) ANTES do crédito. Conta
        // sem assinatura (trial puro) passa direto. 402 vai como JSON (não SSE). Resolvido pelo OWNER do
        // brain (mesma conta que o gateAndDebit cobra) — não pela conta da sessão. M-PAY-H/10: sob lapsed
        // a ação ainda passa se o crédito PRÉ-PAGO cobre o custo (debita só do topup via onlyTopup).
        const ent = await entitlementGate(home, CREDIT_COST.ask);
        if (ent.deny) return send(res, 402, ent.deny);
        // M-PAY-C: gate+débito de crédito (ask=6cr) ANTES de abrir o stream (402 vai como JSON, não SSE).
        // SEGURANÇA (auditoria R2): NÃO usar a Idempotency-Key do cliente como chave do débito — ask
        // SEMPRE re-executa o LLM (não há resposta cacheada/replayada). Aceitar a chave crua deixaria o
        // cliente fixar uma chave e rodar LLM de graça (o 1º débito cobra; os seguintes caem no claim
        // vazio sem debitar, mas o handler roda o LLM mesmo assim). Chave server-side por request
        // (gateAndDebit gera um uuid quando omitida) → todo ask que roda o LLM é cobrado.
        const credit = await gateAndDebit(home, CREDIT_COST.ask, "ask", undefined, { onlyTopup: ent.onlyTopup });
        if (!credit.ok) return send(res, 402, creditDeniedBody(credit, CREDIT_COST.ask));

        // headers SSE — flush imediato, sem buffer de proxy (nginx/Vite).
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no",
          "access-control-allow-origin": process.env.WEB_CORS_ORIGIN || "*",
          "access-control-allow-credentials": "true",
        });
        if (typeof (res as { flushHeaders?: () => void }).flushHeaders === "function") {
          (res as { flushHeaders: () => void }).flushHeaders();
        }

        let aborted = false;
        req.on("close", () => { aborted = true; }); // cliente desconectou → para de escrever (não vaza)
        const sse = (s: string): void => { if (!aborted && !res.writableEnded) res.write(s); };

        try {
          await askStream(home, q, (delta) => {
            sse(`data: ${JSON.stringify({ t: delta })}\n\n`); // token-a-token (LEI I)
          }, k);
          if (aborted) { try { res.end(); } catch { /* já fechado */ } return; }
          // carga ANCORADA rica = a MESMA do /api/ask, SEM 2ª síntese: askStreamPayload reusa
          // retrieve+seriesForQuery (zona BFF), ZERO LLM. A prosa já veio pelos tokens acima.
          const payload = await askStreamPayload(home, q, k); // { citations, facts }
          sse(`event: done\ndata: ${JSON.stringify(payload)}\n\n`);
          try { res.end(); } catch { /* já fechado */ }
        } catch (e) {
          // ACHADO #16/#23 — só mensagens tipadas (4xx seguras) vão cruas; erro inesperado vira genérico
          // (a stack fica no log server-side, nunca no cliente).
          const safe = e instanceof HttpError || e instanceof BffError;
          if (!safe) console.error(`✗ 500 SSE ${req.method} ${req.url}:`, (e as Error).stack || (e as Error).message);
          const msg = safe ? (e as Error).message : "erro interno";
          sse(`event: error\ndata: ${JSON.stringify({ error: msg })}\n\n`);
          try { res.end(); } catch { /* já fechado */ }
        }
        return;
      }

      // --- RBAC REAL (M7) — telas de GESTÃO de principais. Exige sessão + membership do brain. ---
      if (path.startsWith("/api/rbac/")) {
        const { account, home } = await requireBrain(req, u); // governança é de operador logado (403 cross-tenant ANTES de qualquer handler)
        const sub = path.slice("/api/rbac/".length);
        // M10/S3: ESCRITA RBAC. requireBrain já validou sessão+membership acima → escrita em brain
        // alheio nunca chega aqui (403). Handlers PUROS recebem só `home` (nunca leem brain do body).
        if (method === "POST" && sub === "invite") return send(res, 200, await rbacInvite(home, await readJsonBody(req)));
        if (method === "POST" && sub === "grant") return send(res, 200, await rbacGrant(home, await readJsonBody(req)));
        if (method === "POST" && sub === "token") return send(res, 200, await rbacTokenIssue(home, await readJsonBody(req)));
        if (method === "DELETE" && sub === "token")
          return send(res, 200, await rbacTokenRevoke(home, {
            principalId: u.searchParams.get("principal") || "",
            actor: account.email || undefined,
          }));
        if (method === "POST" && sub === "token/rotate")
          return send(res, 200, await rbacTokenRotate(home, await readJsonBody(req), account.email || undefined));
        if (method === "DELETE" && sub === "principal")
          return send(res, 200, await rbacPrincipalRemove(home, { principalId: u.searchParams.get("id") ?? "" }, account.email || undefined));
        if (sub === "principals") return send(res, 200, await rbacPrincipals(home));
        if (sub === "areas") return send(res, 200, await rbacAreas(home));
        if (sub === "preview") {
          const principal = u.searchParams.get("principal") || "";
          if (!principal) return send(res, 400, { error: "faltou ?principal=" });
          return send(res, 200, await rbacPreview(home, principal));
        }
        if (sub === "log") {
          const limit = Number(u.searchParams.get("limit")) || 50;
          return send(res, 200, await rbacLog(home, limit));
        }
        return send(res, 404, { error: "rota rbac desconhecida", rotas: ["principals", "areas", "preview", "log", "token/rotate", "principal"] });
      }

      // --- M21/S3: fontes + fila de revisão. requireBrain valida sessão+membership (403 cross-tenant). ---
      if (path.startsWith("/api/sources")) {
        const { home } = await requireBrain(req, u); // mesmo helper das rotas de gestão
        if (path === "/api/sources" && method === "GET")  return send(res, 200, await listSourcesHandler(home));
        if (path === "/api/sources" && method === "POST") { const b = await readJsonBody(req); return send(res, 200, await createSourceHandler(home, b as any)); }
        // --- M22-A: criar fonte-conector (POST /api/sources/connector) ANTES do match genérico
        // (senão "connector" cairia no grupo do :id). Idempotente, fail-closed 503/400 no handler. ---
        if (path === "/api/sources/connector" && method === "POST") { const b = await readJsonBody(req); return send(res, 200, await connectorCreateHandler(home, b as any)); }
        // --- M22-A: connect session do Nango pra fonte (o front D abre o Nango Connect com o token). ---
        const mc = path.match(/^\/api\/sources\/([^/]+)\/connect$/);
        if (mc && method === "POST") return send(res, 200, await connectSessionHandler(home, decodeURIComponent(mc[1])));
        const m = path.match(/^\/api\/sources\/([^/]+)(\/status)?$/);
        if (m && m[2] && method === "POST") { const b = await readJsonBody(req); return send(res, 200, await setSourceStatusHandler(home, decodeURIComponent(m[1]), String((b as any).status ?? ""))); }
        if (m && method === "POST") { const b = await readJsonBody(req); return send(res, 200, await updateSourceHandler(home, decodeURIComponent(m[1]), b as any)); }
        return send(res, 404, { error: "rota de fontes desconhecida" });
      }
      if (path.startsWith("/api/hypotheses")) {
        const { account, home } = await requireBrain(req, u);
        if (path === "/api/hypotheses" && method === "GET")
          return send(res, 200, await listHypothesesHandler(home, {
            status: u.searchParams.get("status") || undefined,
            limit: Number(u.searchParams.get("k")) || undefined,
          }));
        if (path === "/api/hypotheses/count" && method === "GET")
          return send(res, 200, await hypothesesCountHandler(home));
        // --- M25-A: fila em escala — grupos por decisão + ações em lote GATEADAS (zero LLM).
        // ANTES do match genérico :id/(approve|discard) — senão "groups" viraria id de item. ---
        if (path === "/api/hypotheses/groups" && method === "GET")
          return send(res, 200, await listHypothesisGroupsHandler(home));
        if (path === "/api/hypotheses/groups/approve" && method === "POST") {
          const b = await readJsonBody(req);
          return send(res, 200, await approveGroupHandler(home, b as any, account.email || account.id));
        }
        if (path === "/api/hypotheses/groups/discard" && method === "POST") {
          const b = await readJsonBody(req);
          return send(res, 200, await discardGroupHandler(home, b as any, account.email || account.id));
        }
        if (path === "/api/hypotheses/groups/add-dimension" && method === "POST") {
          const b = await readJsonBody(req);
          return send(res, 200, await addDimensionGroupHandler(home, b as any, account.email || account.id));
        }
        // --- M25-B: juiz triador (recomenda, NUNCA decide — invariante #5). Zona declarada;
        // handlers puros em bff-judge.ts. Paths exatos ANTES do match approve|discard. ---
        if (path === "/api/hypotheses/judge" && method === "POST") {
          const b = await readJsonBody(req);
          return send(res, 200, await judgeHandler(home, (b ?? {}) as any));
        }
        if (path === "/api/hypotheses/judge/calibration" && method === "GET")
          return send(res, 200, await judgeCalibrationHandler(home));
        if (path === "/api/hypotheses/judge/estimate" && method === "GET")
          return send(res, 200, await judgeEstimateHandler(home));
        const m = path.match(/^\/api\/hypotheses\/([^/]+)\/(approve|discard)$/);
        if (m && method === "POST") {
          const id = decodeURIComponent(m[1]);
          return send(res, 200, m[2] === "approve"
            ? await approveHypothesisHandler(home, id, account.email || account.id)
            : await discardHypothesisHandler(home, id, account.email || account.id));
        }
        return send(res, 404, { error: "rota de hipóteses desconhecida" });
      }

      // --- M22-A: status dos conectores do brain (estado DERIVADO, pro front D mesclar). ---
      if (path === "/api/connectors/status" && method === "GET") {
        const { home } = await requireBrain(req, u);
        return send(res, 200, await connectorsStatusHandler(home));
      }

      // --- M8/M11: brains da conta (criar/listar). Sessão obrigatória; NÃO exige brain (conta pode ter 0). ---
      if (path === "/api/brains") {
        const account = await accountFromReq(req);
        if (!account) return send(res, 401, { error: "não autenticado" });
        if (method === "GET") return send(res, 200, await brainsOf(account.id));
        if (method === "POST") {
          const b = await readJsonBody(req);
          const name = String((b as Record<string, unknown>).name ?? "").trim();
          if (!name) return send(res, 400, { error: "dê um nome pro cérebro" });
          // P0-B (mata C2): mesmo guard do wizard (bff-wizard.ts) — colisão de nome → 409.
          if (await brainExists(name))
            return send(res, 409, { error: "esse nome de cérebro já existe — escolha outro." });
          await addBrainMembership(account.id, name, "owner"); // brain = id = nome (sem coluna de nome ainda)
          return send(res, 200, { id: name, name, role: "owner" } as Brain);
        }
        return send(res, 405, { error: "use GET ou POST" });
      }

      // --- M21/S4: wizard de criação de cérebro. Sessão obrigatória; NÃO exige brain (vai nascer no confirm). ---
      if (path.startsWith("/api/wizard/")) {
        const account = await accountFromReq(req);
        if (!account) return send(res, 401, { error: "não autenticado" });
        if (path === "/api/wizard/start" && method === "POST") return send(res, 200, await wizardStart());
        if (path === "/api/wizard/reply" && method === "POST") { const b = await readJsonBody(req); return send(res, 200, await wizardReply(b as any)); }
        if (path === "/api/wizard/confirm" && method === "POST") { const b = await readJsonBody(req); return send(res, 200, await wizardConfirm(account.id, b as any)); }
        return send(res, 404, { error: "rota do wizard desconhecida", rotas: ["start", "reply", "confirm"] });
      }

      // --- M11/S4: onboarding de contexto (POST). requireBrain valida sessão+membership (403 cross-tenant). ---
      if (path.startsWith("/api/onboarding/")) {
        const { home } = await requireBrain(req, u);
        if (path === "/api/onboarding/start" && method === "POST") return send(res, 200, await onboardingStart(home));
        if (path === "/api/onboarding/reply" && method === "POST") { const b = await readJsonBody(req); return send(res, 200, await onboardingReply(home, b as any)); }
        if (path === "/api/onboarding/confirm" && method === "POST") { const b = await readJsonBody(req); return send(res, 200, await onboardingConfirm(home, b as any)); }
        return send(res, 404, { error: "rota onboarding desconhecida", rotas: ["start", "reply", "confirm"] });
      }

      // --- M12: import ASSÍNCRONO (202=Accepted: persiste blob + enfileira job) + status da fila. ---
      if (path === "/api/ingest" && method === "POST") {
        const { account, home } = await requireBrain(req, u);
        const b = await readJsonBody(req);
        // M-PAY-H: gate de entitlement (assinatura inadimplente fora da graça) ANTES do crédito. Conta
        // sem assinatura (trial puro) passa direto. Resolvido pelo OWNER do brain (mesma conta cobrada).
        // M-PAY-H/10: sob lapsed a ação ainda passa se o crédito PRÉ-PAGO cobre o custo (onlyTopup).
        const ent = await entitlementGate(home, CREDIT_COST.ingest);
        if (ent.deny) return send(res, 402, ent.deny);
        // M-PAY-C: gate+débito (ingest=30cr) antes de enfileirar — mesma op de valor do /v1/ingest.
        // Conta sem carteira = permissivo. SEGURANÇA (auditoria R2): chave de débito server-side por
        // request (não a Idempotency-Key crua do cliente) — ingest SEMPRE enfileira novo trabalho/LLM,
        // então uma chave fixa do cliente daria ingestões grátis (claim vazio = sem débito, mas o job
        // roda). gateAndDebit gera um uuid quando a chave é omitida.
        const credit = await gateAndDebit(home, CREDIT_COST.ingest, "ingest", undefined, { onlyTopup: ent.onlyTopup });
        if (!credit.ok) return send(res, 402, creditDeniedBody(credit, CREDIT_COST.ingest));
        // M-PAY-F (revisão): a indicação NÃO ativa em ingestão grátis (era farming sem teto) — só em
        // evento PAGO do indicado (assinatura/top-up), disparado no webhook do Stripe.
        return send(res, 202, await ingestHandler(home, b as any));
      }
      if (path === "/api/ingest/jobs" && method === "GET") {
        const { home } = await requireBrain(req, u);
        return send(res, 200, await listJobsHandler(home));
      }

      // --- WhatsApp / Evolution (QR + webhook → evolution-whatsapp) ---
      if (path === "/api/evolution/status" && method === "GET") {
        const { home } = await requireBrain(req, u);
        return send(res, 200, await evolutionStatusHandler(home));
      }
      if (path === "/api/evolution/connect" && method === "POST") {
        const { home } = await requireBrain(req, u);
        return send(res, 200, await evolutionConnectHandler(home));
      }
      if (path === "/api/evolution/qr" && method === "POST") {
        const { home } = await requireBrain(req, u);
        return send(res, 200, await evolutionQrHandler(home));
      }

      // --- GITHUB SYNC (github-sync.ts): espelho organizado pra pessoas + entrada por diff. ---
      if (path === "/api/github/config" && method === "GET") {
        const { home } = await requireBrain(req, u);
        const { getGithubConfig, contarRetidas } = await import("../core/platform/github-sync.ts");
        const c = await getGithubConfig(home);
        // retidas = memórias FORA do espelho pelo filtro de sigilo — a UI mostra o porquê de um
        // espelho menor que o cérebro (nunca mais repo vazio sem explicação).
        const retidas = c ? await contarRetidas(home, c.sigiloMax) : 0;
        // NUNCA devolve o PAT — só a pista de que existe (a UI mostra "••••" e troca se quiser).
        return send(res, 200, c ? { ...c, pat: undefined, temPat: !!c.pat, retidas } : { enabled: false, temPat: false, retidas: 0 });
      }
      if (path === "/api/github/config" && method === "PUT") {
        const { home } = await requireBrain(req, u);
        const b = await readJsonBody(req);
        const owner = str(b.owner), repo = str(b.repo);
        if (!owner || !repo) return send(res, 400, { error: "diga o dono e o repositório (ex.: minha-conta / meu-cerebro)" });
        const { setGithubConfig, getGithubConfig, contarRetidas } = await import("../core/platform/github-sync.ts");
        await setGithubConfig(home, {
          owner, repo,
          branch: str(b.branch) || "main",
          pat: str(b.pat), // vazio = mantém o atual
          sigiloMax: str(b.sigiloMax) || "restrito", // default: espelhar tudo (o repo é do dono)
          enabled: b.enabled === true,
        });
        const c = await getGithubConfig(home);
        const retidas = c ? await contarRetidas(home, c.sigiloMax) : 0;
        return send(res, 200, c ? { ...c, pat: undefined, temPat: !!c.pat, retidas } : {});
      }
      if (path === "/api/github/sync" && method === "POST") {
        const { home } = await requireBrain(req, u);
        const { runGithubSync } = await import("../core/platform/github-sync.ts");
        const [r] = await runGithubSync(home);
        if (!r) return send(res, 400, { error: "sync do GitHub não está configurada/ligada pra este cérebro." });
        return send(res, r.erro ? 502 : 200, r);
      }
      if (path.startsWith("/api/ingest/jobs/") && method === "GET") {
        const { home } = await requireBrain(req, u);
        const jobId = decodeURIComponent(path.slice("/api/ingest/jobs/".length));
        return send(res, 200, await getJobHandler(home, jobId));
      }

      // --- LIXEIRA (escrita): restaurar página arquivada — "nada é apagado; dá pra trazer de volta".
      // ANTES do bloco genérico /api/ (que força GET). A leitura GET /api/lixeira vive no switch. ---
      if (path === "/api/lixeira/restaurar" && method === "POST") {
        const { home } = await requireBrain(req, u);
        const b = await readJsonBody(req);
        return send(res, 200, await restaurarHandler(home, str(b.slug)));
      }

      // --- M11/S6: editar contexto + preview + re-extração sob comando. GET e POST no mesmo bloco. ---
      if (path.startsWith("/api/context")) {
        const { home } = await requireBrain(req, u);
        if (path === "/api/context" && method === "GET") return send(res, 200, await contextGet(home));
        if (path === "/api/context" && method === "POST") { const b = await readJsonBody(req); return send(res, 200, await contextSave(home, b as any)); }
        if (path === "/api/context/preview" && method === "POST") { const b = await readJsonBody(req); return send(res, 200, await contextPreview(home, b as any)); }
        if (path === "/api/context/reextract" && method === "GET") return send(res, 200, await reextractEstimate(home));
        if (path === "/api/context/reextract" && method === "POST") return send(res, 200, await reextractRun(home));
        return send(res, 404, { error: "rota context desconhecida", rotas: ["/api/context", "/api/context/preview", "/api/context/reextract"] });
      }

      // --- proxy de leitura (exige sessão + membership) ---
      // ESCOPO: estas rotas rodam como ADMIN (DONO logado), SEM escopo de principal de propósito.
      // O dono vê o brain INTEIRO — inclusive páginas `restrito` (no corpus eval-a360 tudo nasce
      // `restrito` por falha-fechado do M7; escopar o dono = ele não veria NADA). O RBAC fino é só
      // pras telas de gestão (/api/rbac/*), não pra consulta do próprio dono.
      if (path.startsWith("/api/")) {
        if (method !== "GET") return send(res, 405, { error: "leitura é GET" });
        const { account, home, brains } = await requireBrain(req, u);
        const q = u.searchParams.get("q") || "";
        const k = Number(u.searchParams.get("k")) || undefined;

        // M11/S3: fonte verbatim (blob). Devolve BINÁRIO (fora do switch JSON). Herda RBAC do M7
        // (sourceHandler lança BffError 403/404 — tratado no catch). `principal` = agente escopado opcional.
        if (path === "/api/source") {
          const principal = u.searchParams.get("principal") || undefined;
          const { buffer, mime, filename } = await sourceHandler(home, u.searchParams.get("slug") || "", principal);
          res.writeHead(200, {
            "content-type": mime,
            "content-disposition": `inline; filename="${filename.replace(/[^\w.\-]/g, "_")}"`,
            "access-control-allow-origin": process.env.WEB_CORS_ORIGIN || "*",
            "access-control-allow-credentials": "true",
          });
          return res.end(buffer);
        }

        switch (path) {
          case "/api/stats":
            return send(res, 200, await stats(home));
          case "/api/graph": {
            const asOf = u.searchParams.get("asOf") || undefined;
            // M19: o Mapa é o grafo de ENTIDADES (entidades + co-ocorrência/relações), não mais o de
            // páginas+wikilinks (galeed_edges é vazio sem [[links]] → mapa inútil). As entidades nascem na
            // data do 1º fato → o recorte as-of (viagem no tempo) é feito no cliente por node.date.
            const g = await entityGraph(home);
            return send(res, 200, asOf ? { ...g, asOf } : g);
          }
          case "/api/entity": {
            // M19: fatos ligados a UMA entidade — alimenta o inspetor do Mapa ao clicar num nó.
            const name = u.searchParams.get("entity") || "";
            if (!name) return send(res, 400, { error: "faltou ?entity=" });
            return send(res, 200, await entityFacts(home, name));
          }
          case "/api/retrieve":
            if (!q) return send(res, 400, { error: "faltou ?q=" });
            return send(res, 200, normHits(await retrieve(home, q, k ?? 6)));
          case "/api/search":
            if (!q) return send(res, 400, { error: "faltou ?q=" });
            return send(res, 200, normHits(await search(home, q, k ?? 8, u.searchParams.get("type") || undefined)));
          case "/api/facts":
            // M10/S2: handler tipado (FactItem[]) — preserva value_num/tier/unit/period sem achatar.
            return send(res, 200, await factsHandler(home, {
              dim: u.searchParams.get("dim") || "decisions",
              type: u.searchParams.get("type") || undefined,
              asOf: u.searchParams.get("asOf") || undefined,
              currentOnly: u.searchParams.get("current") === "1",
              limit: k,
            }));
          case "/api/cost":
            // M10/S2: rollup de custo — SÓ OWNER (costHandler valida `home` ∈ brains com role owner → 403).
            return send(res, 200, await costHandler(home, brains));
          case "/api/percepcoes":
            // M24-E: percepções do cérebro (saída do sono). Leitura do dono, RBAC herdado do requireBrain.
            return send(res, 200, await percepcoesHandler(home, {
              estado: u.searchParams.get("estado") || undefined,
              limit: k,
              offset: Number(u.searchParams.get("offset")) || 0,
            }));
          case "/api/saude":
            // Saúde real: último sono (last_trace), armazenamento (ativas/frias/arquivadas) e fila
            // por status. Leitura pura, zero LLM, RBAC herdado do requireBrain (nível das percepções).
            return send(res, 200, await saudeHandler(home));
          case "/api/lixeira":
            // Lixeira de páginas: o que o cérebro decidiu esquecer (archived=true). Nada é apagado.
            return send(res, 200, await lixeiraHandler(home));
          case "/api/timeline":
            // Teto sano: sem ?k= o corte fica em 1000 (o front pede N+1 pra detectar truncamento);
            // k gigante não vira SELECT ilimitado. NOTA: o engine ordena por (predicate, valid_from)
            // ASC — o corte descarta as linhas MAIS NOVAS do predicado que cruza o teto, por isso o
            // front deve sempre pedir folga (padrão N+1) e avisar quando truncar.
            return send(res, 200, await timeline(home, u.searchParams.get("entity") || "", {
              predicate: u.searchParams.get("pred") || undefined,
              limit: Math.min(k ?? 1000, 5000),
            }));
          case "/api/ask": {
            if (!q) return send(res, 400, { error: "faltou ?q=" });
            // Rota cara de LLM: limita por CONTA (autenticada via requireBrain acima).
            const rl = rateLimit(`ask:${account.id}`, 30, 60_000);
            if (!rl.ok) return send(res, 429, { error: "muitas tentativas" }, { "retry-after": String(rl.retryAfter) });
            const aiMsg = aiUnavailableMsg();
            if (aiMsg) return send(res, 503, { error: aiMsg });
            // M-PAY-H: gate de entitlement (assinatura inadimplente fora da graça) ANTES do crédito.
            // Resolvido pelo OWNER do brain (mesma conta que o gateAndDebit cobra), não pela sessão.
            // M-PAY-H/10: sob lapsed a ação ainda passa se o crédito PRÉ-PAGO cobre o custo (onlyTopup).
            const entAsk = await entitlementGate(home, CREDIT_COST.ask);
            if (entAsk.deny) return send(res, 402, entAsk.deny);
            // M-PAY-C: gate+débito de crédito (ask=6cr). SEGURANÇA (auditoria R2): chave server-side por
            // request (não a Idempotency-Key crua do cliente) — ask SEMPRE roda o LLM, então aceitar a
            // chave do cliente daria asks grátis (claim vazio não debita, mas o LLM roda).
            const credit = await gateAndDebit(home, CREDIT_COST.ask, "ask", undefined, { onlyTopup: entAsk.onlyTopup });
            if (!credit.ok) return send(res, 402, creditDeniedBody(credit, CREDIT_COST.ask));
            // M10/S2: handler enriquecido — { answer, citations (com selo), facts: FactItem[], gaps? }.
            return send(res, 200, await askHandler(home, q, k ?? 8));
          }
          default:
            return send(res, 404, {
              error: "rota desconhecida",
              rotas: ["/api/stats", "/api/graph", "/api/entity", "/api/retrieve", "/api/search", "/api/facts", "/api/cost", "/api/percepcoes", "/api/saude", "/api/lixeira", "/api/lixeira/restaurar", "/api/timeline", "/api/ask", "/api/ask/stream", "/api/source", "/api/sources*", "/api/sources/:id/connect", "/api/hypotheses*", "/api/connectors/nango/webhook", "/api/connectors/status", "/api/wizard/*", "/api/ingest", "/api/ingest/jobs", "/api/onboarding/*", "/api/context*", "/api/rbac/*", "/api/health"],
            });
        }
      }

      // --- estático / SPA (prod). Em dev a pasta não existe → 404 (o Vite serve). ---
      if (method === "GET" && (await serveStatic(res, path))) return;
      return send(res, 404, { error: "não encontrado" });
    } catch (e) {
      if (e instanceof HttpError || e instanceof BffError) return send(res, e.code, { error: e.message });
      // 500 = erro inesperado → loga stack no stderr (antes era silencioso; sem isso, debugar 500 é cego).
      console.error(`✗ 500 ${req.method} ${req.url}:`, (e as Error).stack || (e as Error).message);
      // ACHADO #16/#23 — NÃO vaza a mensagem interna ao cliente: resposta genérica (stack fica no log).
      return send(res, 500, { error: "erro interno" });
    }
  });

  server.listen(port, () => console.error(`🌐 galeed BFF no ar :${port}  (dist: ${WEB_DIST})`));
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) startWebServer();
