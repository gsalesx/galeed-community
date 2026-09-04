#!/usr/bin/env -S npx tsx
/** API HTTP READ-ONLY — a base do SaaS. Casca fina sobre o core (query.ts); o front NUNCA
 *  fala com o banco direto, só com esta API. Zero dependência npm (node:http).
 *
 *  Separada do ingest-server (escrita) de propósito: leitura e escrita são responsabilidades
 *  distintas, com perfis de segurança distintos. Esta API é puramente de LEITURA (sem LLM no
 *  caminho → rápida e barata), exatamente o HOT path da arquitetura v0.3.
 *
 *  Endpoints (todos GET, JSON):
 *    GET /api/health
 *    GET /api/graph                          → grafo inteiro (nós+arestas) p/ visualização
 *    GET /api/retrieve?q=...&k=6              → contexto + selo epistêmico
 *    GET /api/search?q=...&type=...&k=8       → FTS
 *    GET /api/facts?dim=decisions&asOf=...&current=1
 *    GET /api/timeline?entity=...&pred=...    → linha do tempo bitemporal
 *    GET /api/stats
 *
 *  Multi-tenant: ?brain=<companyId> escolhe o tenant (env GALEED_BRAIN = default). O isolamento
 *    real é a coluna `brain` no Postgres — ?brain mapeia direto pra ela.
 *  Auth: FAIL-CLOSED. Token de principal (x-galeed-principal-token / ?ptoken) → leitura escopada.
 *    Senão, API_TOKEN setado → admin via header `x-galeed-token` (ou ?token=). SEM API_TOKEN e SEM
 *    token de principal → 503 (leitura desabilitada): ausência de config NUNCA é leitura aberta.
 *  CORS: liberado (GET read-only) — ajuste API_CORS_ORIGIN se quiser travar. */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { brainHome } from "../core/platform/brain.ts";
import { retrieve, search, facts, timeline, graphAll, stats } from "../core/retrieval/query.ts";
import { getEngine } from "../core/platform/engine.ts";
import type { GraphData } from "../core/platform/engine.ts";
import { authenticateToken } from "../core/access/principals.ts";
import { inScope, type Scope } from "../core/access/scope.ts";

/** Compara token recebido x esperado em TEMPO CONSTANTE (não vaza por timing). Iguala
 *  comprimentos via hash sha256 fixo de 32 bytes antes do timingSafeEqual. */
function safeTokenEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

function send(res: ServerResponse, code: number, obj: unknown) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": process.env.API_CORS_ORIGIN || "*",
    "access-control-allow-headers": "x-galeed-token, x-galeed-principal-token, content-type",
  });
  res.end(body);
}

/** auditoria de leitura de principal — grava quem consultou o quê (não falha a request se logar falhar). */
async function logAccess(home: string, scope: Scope, query: string, nReturned: number) {
  try {
    await (await getEngine(home)).appendAccessLog({
      principal_id: scope.principalId, query, areas_touched: scope.areas, n_returned: nReturned,
    });
  } catch { /* auditoria best-effort: não derruba a leitura */ }
}

/** filtra uma lista de itens-fonte (com `source_slug`) pelo escopo: mantém só itens cuja
 *  PÁGINA-FONTE passa no filtro espelho do S2. Não vaza fato/fonte fora do escopo. */
async function filterBySourceScope<T extends { source_slug?: string }>(home: string, items: T[], scope: Scope): Promise<T[]> {
  if (!items.length) return items;
  const pages = await (await getEngine(home)).pagesBySlug(items.map((i) => i.source_slug || ""));
  return items.filter((i) => {
    const p = pages.get(i.source_slug || "");
    return !!p && inScope({ type: p.type, tags: p.tags, sensitivity: p.sensitivity }, scope);
  });
}

/** P0-B (mata A5c) — espelho de escopo do GRAFO: mantém só nós cuja PÁGINA passa no inScope
 *  (mesmo espelho do retrieve); nó-fantasma (sem página, exists=false) cai — fail-closed;
 *  aresta só sobrevive se os DOIS lados sobreviverem. */
async function scopedGraphAll(home: string, scope: Scope): Promise<GraphData> {
  const g = await graphAll(home);
  if (!g.nodes.length) return { nodes: [], edges: [] };
  const pages = await (await getEngine(home)).pagesBySlug(g.nodes.map((n) => n.id));
  const keep = new Set(
    g.nodes
      .filter((n) => {
        const p = pages.get(n.id);
        return !!p && inScope({ type: p.type, tags: p.tags, sensitivity: p.sensitivity }, scope);
      })
      .map((n) => n.id),
  );
  return {
    nodes: g.nodes.filter((n) => keep.has(n.id)),
    edges: g.edges.filter((e) => keep.has(e.src) && keep.has(e.dst)),
  };
}

/** P0-B — stats sob escopo, derivadas do grafo ESCOPADO (mesma fonte de verdade do /api/graph).
 *  `vectors` é OMITIDO de propósito (contagem de vetores não é atribuível a escopo sem join novo
 *  — omitir > mentir); `scoped: true` sinaliza o recorte parcial ao cliente. */
async function scopedStats(
  home: string, scope: Scope,
): Promise<{ pages: number; facts: number; edges: number; scoped: true }> {
  const g = await scopedGraphAll(home, scope);
  return {
    pages: g.nodes.length,
    facts: g.nodes.reduce((s, n) => s + (n.factCount || 0), 0),
    edges: g.edges.length,
    scoped: true,
  };
}

/** Resolve o tenant do request: ?brain=<id> escolhe o brain; senão o default (GALEED_BRAIN). */
function resolveBrain(u: URL): string {
  return brainHome(u.searchParams.get("brain") || undefined);
}

export function startApiServer(defaultHome = brainHome()) {
  const port = Number(process.env.API_PORT || 8788);
  const token = process.env.API_TOKEN;

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      if (req.method === "OPTIONS") return send(res, 204, {});
      const u = new URL(req.url || "/", `http://localhost:${port}`);
      const path = u.pathname.replace(/\/+$/, "") || "/";

      if (req.method !== "GET") return send(res, 405, { error: "API read-only: use GET" });
      if (path === "/api/health" || path === "/health") return send(res, 200, { ok: true });

      const home = resolveBrain(u);

      // Auth por TOKEN DE PRINCIPAL (header x-galeed-principal-token ou ?ptoken=): resolve o Scope (S2),
      // escopa as leituras e grava access-log. Falha fechado: token presente e inválido/revogado → 401
      // (NÃO cai pra admin). Sem token de principal → comportamento atual (admin via API_TOKEN).
      const ptoken = (req.headers["x-galeed-principal-token"] as string | undefined) || u.searchParams.get("ptoken") || "";
      let scope: Scope | null = null;
      if (ptoken) {
        const auth = await authenticateToken(home, ptoken);
        if (!auth) return send(res, 401, { error: "principal token inválido" });
        scope = auth.scope;
      } else if (token) {
        const got = (req.headers["x-galeed-token"] as string | undefined) || u.searchParams.get("token") || "";
        if (!safeTokenEqual(got, token)) return send(res, 401, { error: "token inválido" });
      } else {
        // P0-B (mata A5b): sem API_TOKEN configurado = leitura DESABILITADA (fail-closed), nunca aberta.
        return send(res, 503, {
          error: "API_TOKEN não configurado — leitura desabilitada (fail-closed). Configure API_TOKEN no ambiente ou use um token de principal (x-galeed-principal-token).",
        });
      }

      const q = u.searchParams.get("q") || "";
      const k = Number(u.searchParams.get("k")) || undefined;

      switch (path) {
        case "/api/graph": {
          if (scope) {
            const g = await scopedGraphAll(home, scope);
            await logAccess(home, scope, "graph", g.nodes.length);
            return send(res, 200, g);
          }
          return send(res, 200, await graphAll(home));
        }
        case "/api/retrieve": {
          if (!q) return send(res, 400, { error: "faltou ?q=" });
          const hits = await retrieve(home, q, k ?? 6, scope ? { scope } : undefined);
          if (scope) await logAccess(home, scope, q, hits.length);
          return send(res, 200, hits);
        }
        case "/api/search": {
          if (!q) return send(res, 400, { error: "faltou ?q=" });
          const hits = await search(home, q, k ?? 8, u.searchParams.get("type") || undefined, scope ?? undefined);
          if (scope) await logAccess(home, scope, q, hits.length);
          return send(res, 200, hits);
        }
        case "/api/facts": {
          const dim = u.searchParams.get("dim") || "decisions";
          const rows = await facts(home, dim, {
            type: u.searchParams.get("type") || undefined,
            asOf: u.searchParams.get("asOf") || undefined,
            currentOnly: u.searchParams.get("current") === "1",
            limit: k,
          });
          if (scope) {
            const scoped = await filterBySourceScope(home, rows, scope);
            await logAccess(home, scope, dim, scoped.length);
            return send(res, 200, scoped);
          }
          return send(res, 200, rows);
        }
        case "/api/timeline": {
          const entity = u.searchParams.get("entity") || "";
          const rows = await timeline(home, entity, {
            predicate: u.searchParams.get("pred") || undefined,
            limit: k,
          });
          if (scope) {
            const scoped = await filterBySourceScope(home, rows, scope);
            await logAccess(home, scope, entity, scoped.length);
            return send(res, 200, scoped);
          }
          return send(res, 200, rows);
        }
        case "/api/stats": {
          if (scope) {
            const s = await scopedStats(home, scope);
            await logAccess(home, scope, "stats", s.pages);
            return send(res, 200, s);
          }
          return send(res, 200, await stats(home));
        }
        default:
          return send(res, 404, { error: "rota desconhecida", rotas: ["/api/graph", "/api/retrieve", "/api/search", "/api/facts", "/api/timeline", "/api/stats", "/api/health"] });
      }
    } catch (e) {
      return send(res, 500, { error: (e as Error).message });
    }
  });

  server.listen(port, () =>
    console.error(`🛰️  galeed API (read-only) no ar :${port}  (brain default: ${defaultHome}, auth: ${token ? "on" : "FAIL-CLOSED (sem API_TOKEN — leituras 503)"})`),
  );
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) startApiServer();
