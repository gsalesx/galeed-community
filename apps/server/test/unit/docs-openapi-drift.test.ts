/** TESTE DE DRIFT — mantém a documentação VIVA.
 *
 *  Garante que toda rota HTTP REAL dos 3 servidores do Galeed está documentada em
 *  apps/docs/openapi.yaml. Se alguém adicionar uma rota e esquecer de documentar, este
 *  teste (e o CI) fica VERMELHO.
 *
 *  Servidores cobertos (lidos como TEXTO, extraindo os literais de path que o próprio
 *  dispatch usa — sem chutar):
 *    - src/connectors/web-server.ts   (BFF, porta 8789, superset de /api/*)
 *    - src/connectors/api-server.ts   (read-only, porta 8788)
 *    - src/connectors/ingest-server.ts(webhook, porta 8787)
 *
 *  COMO O DISPATCH FUNCIONA (confirmado lendo os fontes):
 *
 *  web-server.ts  (web-server.ts:333-335)
 *    const path = u.pathname.replace(/\/+$/, "") || "/";  // trailing slash removido
 *    const method = req.method || "GET";
 *    Compara por:
 *      - igualdade exata:    `path === "/api/health"`  (às vezes com `&& method === "POST"`)
 *      - prefixo + sub:      `path.startsWith("/api/rbac/")` → `sub === "invite"` etc. (rbac usa
 *                            DELETE em token; web-server.ts:437-462)
 *      - prefixo + regex:    `path.match(/^\/api\/sources\/([^/]+)\/connect$/)` etc.
 *      - switch(path) GET:   bloco final `path.startsWith("/api/")` força GET (405 senão) e dá
 *                            switch nos casos /api/stats, /api/graph, ... (web-server.ts:600-677)
 *
 *  api-server.ts  (api-server.ts:111-113)
 *    Mesmo normalize de path. TODO método != GET → 405. /api/health|/health hardcoded.
 *    Depois um switch(path) com os 6 casos read-only (api-server.ts:140-199).
 *
 *  ingest-server.ts  (ingest-server.ts:47-48)
 *    NÃO normaliza nem usa URL(): compara `req.url` cru.
 *      - GET  /health
 *      - POST /ingest   (qualquer outra coisa → 404)
 *    Por isso o ingest tem `/ingest` e `/health` (NÃO `/api/ingest`).
 *
 *  NORMALIZAÇÃO (dos dois lados): método em minúsculas; segmento dinâmico (:id, {id},
 *  {jobId}, ([^/]+), etc.) vira o placeholder "*". Assim `/api/sources/{id}` (spec) e
 *  `/api/sources/([^/]+)` (regex do código) casam em `/api/sources/*`.
 *
 *  EXCEÇÕES DELIBERADAS:
 *    - SPA fallback (serveStatic / index.html) e assets estáticos: IGNORADOS — não são rotas
 *      de API, são o catch-all do front (web-server.ts:680-682).
 *    - /api/health e /health contam como DUAS rotas distintas (ambas documentadas), pois o
 *      código responde às duas literalmente.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", ".."); // test/unit → apps/server (sibling de src/)
const REPO_ROOT = join(ROOT, "..", ".."); // apps/server → raiz do repo (onde vive apps/docs/)
const SRC = (rel: string) => join(ROOT, "src", "connectors", rel);
const OPENAPI = join(REPO_ROOT, "apps", "docs", "openapi.yaml");

type Route = { method: string; path: string };

/** Normaliza um path: minúsculas no método (feito pelo caller), e troca segmentos dinâmicos
 *  por "*". Cobre :id, {id}, {jobId}, e os grupos de captura de regex já convertidos em "*". */
function normalizePath(p: string): string {
  return (
    p
      // {id}, {jobId}, ... → *
      .replace(/\{[^}]+\}/g, "*")
      // :id, :slug, ... → *
      .replace(/:[^/]+/g, "*")
      // colapsa segmentos já marcados
      .replace(/\/+$/, "") || "/"
  );
}

function key(r: Route): string {
  return `${r.method.toLowerCase()} ${normalizePath(r.path)}`;
}

// ──────────────────────────────────────────────────────────────────────────────
//  EXTRATOR — rotas REAIS dos fontes
// ──────────────────────────────────────────────────────────────────────────────

// Converte o CORPO de uma regex de rota (já SEM âncoras ^...$) numa LISTA de paths normalizados.
// Desescapa "\/", e EXPANDE os dois padrões de grupo que o web-server.ts usa no FIM da rota:
//   1) opcional  (\/status)?            → variante SEM e variante COM o sufixo (sources/:id casa
//                                          tanto /api/sources/:id quanto /api/sources/:id/status).
//   2) alternância (approve|discard)    → uma rota por opção literal (hypotheses/:id/approve E
//                                          /discard) — NÃO é segmento dinâmico, são literais.
// Grupos de captura restantes (segmento dinâmico [^/]+) viram "*".
// (comentário de LINHA de propósito: evita fechar o JSDoc com a sequência asterisco-barra.)
function regexLiteralToPaths(body: string): string[] {
  const desc = body.replace(/\\\//g, "/"); // \/ → /
  let variants: string[] = [];

  const optTail = desc.match(/^(.*?)\(([^)]*)\)\?$/); // grupo opcional no fim: (\/x)?
  const altTail = desc.match(/^(.*?)\(([^)]*\|[^)]*)\)$/); // alternância no fim: (a|b)
  if (optTail) {
    const head = optTail[1];
    const inner = optTail[2].replace(/\\\//g, "/"); // ex.: "/status"
    variants.push(head); // sem o sufixo opcional
    variants.push(head + inner); // com o sufixo opcional
  } else if (altTail) {
    const head = altTail[1];
    for (const opt of altTail[2].split("|")) variants.push(head + opt); // approve, discard
  } else {
    variants.push(desc);
  }
  // grupos de captura RESTANTES (segmento dinâmico) → *
  return variants.map((v) => normalizePath(v.replace(/\([^)]*\)\??/g, "*")));
}

// Regexes construídas via RegExp(string) — single-quoted, sem literais /.../ — para zero
// ambiguidade de tokenização (literais de regex com aspas dentro confundem o transform).
const RE_PATH_METHOD = () =>
  new RegExp('path === "([^"]+)"\\s*&&\\s*method === "([A-Z]+)"', "g");
const RE_PATH_NO_METHOD = () =>
  new RegExp('path === "([^"]+)"(?!\\s*&&\\s*method)', "g");
const RE_METHOD_SUB = () =>
  new RegExp('method === "([A-Z]+)"\\s*&&\\s*sub === "([a-zA-Z-/]+)"', "g");
const RE_SUB = () => new RegExp('\\bsub === "([a-zA-Z-]+)"', "g");
// Captura o CORPO da regex de rota entre /^ e $/ dentro de path.match(...). Robusto a "/"
// dentro de classes [^/] (que quebravam um capturador genérico de literal de regex).
const RE_MATCH_BODY = () => new RegExp('path\\.match\\(/\\^(.*?)\\$/\\)', "g");
const RE_METHOD_IN_WINDOW = /method === "([A-Z]+)"/;
const RE_CASE_API = () => new RegExp('case "(/api/[^"]+)":', "g");
const RE_PATH_HEALTH = () => new RegExp('path === "(/[^"]*health[^"]*)"', "g");
// Bloco multi-método com path FIXO: `if (path === "<lit>") { ... if (method === "POST") ... }`.
// Captura o path e TODOS os `method === "<M>"` numa janela após o "{" do bloco (ex.: /api/brains
// expõe GET e POST em linhas separadas; web-server.ts:532-546).
const RE_PATH_BLOCK = () => new RegExp('path === "([^"]+)"\\)\\s*\\{', "g");
const RE_METHOD_ALL = () => new RegExp('method === "([A-Z]+)"', "g");
// Bloco por PREFIXO com barra final + method: `path.startsWith("<pref>/") && method === "<M>"`
// (ex.: /api/ingest/jobs/:jobId; web-server.ts:578). O segmento dinâmico final vira "*".
const RE_STARTSWITH_METHOD = () =>
  new RegExp('path\\.startsWith\\("([^"]+/)"\\)\\s*&&\\s*method === "([A-Z]+)"', "g");

/** Extrai as rotas do web-server.ts. */
function extractWebServer(src: string): Route[] {
  const routes: Route[] = [];
  const add = (method: string, path: string) => routes.push({ method, path });

  // (1) path === "<lit>" && method === "<M>"  (ambos na mesma expressão)
  for (const m of src.matchAll(RE_PATH_METHOD())) add(m[2], m[1]);

  // (2) path === "<lit>" SEM "&& method": health(GET), auth/me(GET). As rotas /auth/{signup,
  //     login,logout} têm method na MESMA expressão → vieram por (1) como POST; aqui sobram só
  //     as GET implícitas (leitura por cookie). web-server.ts:338,383.
  for (const m of src.matchAll(RE_PATH_NO_METHOD())) add("GET", m[1]);

  // (3) Bloco RBAC: path.startsWith("/api/rbac/") + sub === "<x>". web-server.ts:442-459.
  //     invite/grant/token = POST (token tb DELETE); principals/areas/preview/log = GET.
  if (src.includes('path.startsWith("/api/rbac/")')) {
    for (const m of src.matchAll(RE_METHOD_SUB())) add(m[1], `/api/rbac/${m[2]}`);
    // sub === "<x>" sem method (principals/areas/preview/log) → GET
    for (const m of src.matchAll(RE_SUB())) {
      const sub = m[1];
      if (!["invite", "grant", "token", "principal"].includes(sub)) add("GET", `/api/rbac/${sub}`);
    }
  }

  // (4) Rotas por regex: path.match(/^...$/) + (na janela seguinte) method === "<M>". Todas POST
  //     no web-server.ts (sources/:id, sources/:id/status, sources/:id/connect, hypotheses/:id/
  //     (approve|discard)). web-server.ts:473-477,515-516. O method pode estar numa linha
  //     posterior (`if (m && method === "POST")`) → varre uma janela de 220 chars após o match.
  for (const m of src.matchAll(RE_MATCH_BODY())) {
    const win = src.slice(m.index ?? 0, (m.index ?? 0) + 220);
    const mm = win.match(RE_METHOD_IN_WINDOW);
    if (!mm) continue; // sem method próximo → não é uma rota POST/DELETE; ignora
    for (const p of regexLiteralToPaths(m[1])) add(mm[1], p);
  }

  // (5) switch(path) final read-only (GET forçado; método != GET já deu 405). web-server.ts:600-677.
  //     /api/source (binário) é tratado antes do switch como path === "/api/source" → veio por (2).
  for (const m of src.matchAll(RE_CASE_API())) add("GET", m[1]);

  // (6) Bloco multi-método de path FIXO: `if (path === "<lit>") { ... method === "<M>" ... }`.
  //     /api/brains expõe GET e POST em linhas separadas dentro do mesmo bloco (web-server.ts:532).
  //     Varre uma janela após o "{" e adiciona TODO método citado. (2) já adicionou o GET implícito;
  //     o dedupe cuida da sobreposição.
  for (const m of src.matchAll(RE_PATH_BLOCK())) {
    const start = (m.index ?? 0) + m[0].length;
    const win = src.slice(start, start + 600);
    for (const mm of win.matchAll(RE_METHOD_ALL())) add(mm[1], m[1]);
  }

  // (7) Bloco por PREFIXO + method na mesma expressão: path.startsWith("<pref>/") && method === "<M>"
  //     (ex.: /api/ingest/jobs/:jobId; web-server.ts:578). O sufixo dinâmico vira "*".
  for (const m of src.matchAll(RE_STARTSWITH_METHOD())) add(m[2], `${m[1]}*`);

  return routes;
}

/** Extrai as rotas do api-server.ts (todas GET; health hardcoded; switch com 6 casos). */
function extractApiServer(src: string): Route[] {
  const routes: Route[] = [];
  // health: path === "/api/health" || path === "/health" (api-server.ts:114)
  for (const m of src.matchAll(RE_PATH_HEALTH())) routes.push({ method: "GET", path: m[1] });
  // switch(path) read-only — todos GET (req.method != GET já caiu em 405; api-server.ts:113)
  for (const m of src.matchAll(RE_CASE_API())) routes.push({ method: "GET", path: m[1] });
  return routes;
}

/** Extrai as rotas do ingest-server.ts. Compara req.url cru (ingest-server.ts:47-48):
 *    GET /health ; POST /ingest.
 *  Usa .includes() com substrings literais do código (não regex) para evitar fragilidade. */
function extractIngestServer(src: string): Route[] {
  const routes: Route[] = [];
  // GET /health  → linha: req.method === "GET" && req.url === "/health"
  if (src.includes('req.url === "/health"')) {
    routes.push({ method: "GET", path: "/health" });
  }
  // POST /ingest → guarda: req.method !== "POST" || req.url !== "/ingest" (exige POST /ingest)
  if (src.includes('req.url !== "/ingest"')) {
    routes.push({ method: "POST", path: "/ingest" });
  }
  return routes;
}

function dedupe(routes: Route[]): Route[] {
  const seen = new Set<string>();
  const out: Route[] = [];
  for (const r of routes) {
    const k = key(r);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────────────
//  EXTRATOR — rotas DOCUMENTADAS (openapi.yaml)
// ──────────────────────────────────────────────────────────────────────────────

const HTTP_METHODS = new Set(["get", "post", "put", "delete", "patch", "options", "head"]);

function extractSpecRoutes(): Route[] {
  const doc = parseYaml(readFileSync(OPENAPI, "utf8")) as {
    paths?: Record<string, Record<string, unknown>>;
  };
  const out: Route[] = [];
  for (const [path, ops] of Object.entries(doc.paths ?? {})) {
    for (const method of Object.keys(ops)) {
      if (HTTP_METHODS.has(method.toLowerCase())) {
        out.push({ method, path });
      }
    }
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────────────
//  TESTES
// ──────────────────────────────────────────────────────────────────────────────

describe("docs/openapi drift — toda rota HTTP real está documentada", () => {
  const web = extractWebServer(readFileSync(SRC("web-server.ts"), "utf8"));
  const api = extractApiServer(readFileSync(SRC("api-server.ts"), "utf8"));
  const ingest = extractIngestServer(readFileSync(SRC("ingest-server.ts"), "utf8"));

  const realRoutes = dedupe([...web, ...api, ...ingest]);
  const specRoutes = extractSpecRoutes();
  const specKeys = new Set(specRoutes.map(key));
  const realKeys = new Set(realRoutes.map(key));

  it("extraiu um número plausível de rotas reais (sanidade do extrator)", () => {
    // sanidade: se o extrator quebrar e voltar vazio, o ASSERT principal passaria à toa.
    expect(realRoutes.length).toBeGreaterThan(40);
    // web-server tem o grosso (>30 rotas)
    expect(web.length).toBeGreaterThan(30);
    expect(api.length).toBeGreaterThanOrEqual(7); // 6 switch + health(s)
    expect(ingest.length).toBe(2); // /health (GET) + /ingest (POST)
  });

  it("HARD FAIL: toda {método, path} REAL existe na openapi.yaml", () => {
    const undocumented = realRoutes
      .filter((r) => !specKeys.has(key(r)))
      .map((r) => `${r.method.toUpperCase()} ${normalizePath(r.path)}`)
      .sort();

    expect(
      undocumented,
      undocumented.length
        ? `\n\nRotas HTTP REAIS sem documentação em apps/docs/openapi.yaml ` +
            `(${undocumented.length}):\n` +
            undocumented.map((r) => `  • ${r}`).join("\n") +
            `\n\nAdicione cada uma ao openapi.yaml (summary + responses { error }).\n`
        : "ok",
    ).toEqual([]);
  });

  it("CHECK LEVE (warn): paths documentados sem rota real correspondente (possível typo)", () => {
    const orphan = specRoutes
      .filter((r) => !realKeys.has(key(r)))
      .map((r) => `${r.method.toUpperCase()} ${normalizePath(r.path)}`)
      .sort();
    if (orphan.length) {
      // eslint-disable-next-line no-console
      console.warn(
        `\n[drift] ${orphan.length} path(s) documentado(s) SEM rota real correspondente ` +
          `(possível typo OU normalização de path-param):\n` +
          orphan.map((r) => `  • ${r}`).join("\n"),
      );
    }
    // não falha — é só um sinal
    expect(true).toBe(true);
  });
});
