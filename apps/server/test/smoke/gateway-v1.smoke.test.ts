/** GATEWAY PÚBLICO /v1 — SMOKE de INTEGRAÇÃO (porta efêmera, igual helpers/bff.ts faz com o BFF).
 *  Sobe `startGatewayServer` num `GATEWAY_PORT=0` real e exercita a borda pública DE PONTA A PONTA
 *  contra um brain-fixture determinístico (semeado via engine/principals DIRETO, sem LLM): páginas em
 *  DUAS áreas (vendas|produto), fatos tipados por área, e um principal escopado SÓ a `vendas` + token cru.
 *
 *  O que cada bloco PROVA (asserts de VALOR, não só status):
 *   1. AUTH borda: sem Authorization → 401; token aleatório → 401; o god-token estático (API_TOKEN) NÃO
 *      autentica → 401. (a borda SÓ aceita Bearer de token emitido; nada de god-token/cookie/?token=.)
 *   2. SHAPE público do /v1/ask: 200 com { answer, facts[], withheld{count,reason} }; cada fact tem os
 *      campos PÚBLICOS (id/status/confidence/sensitivity/area/source/valid_from/valid_until/supersedes)
 *      e NENHUM campo interno cru (sem `natureza`, sem `valid_to`, sem `value_num`, sem `source_slug`…).
 *   3. SHAPE do /v1/facts com area/status/limit: 200 shape público; limit>200 coerçado p/ 200.
 *   4. ESCOPO + TENANT: token escopado a `vendas` só enxerga fatos de `vendas` (não vaza `produto`);
 *      o brain vem DO TOKEN — não há ?brain= que sobreponha (isolamento por construção).
 *   5. RATE-LIMIT: estourar a janela do /v1/facts → 429 com Retry-After.
 *   6. /health 200 SEM auth; método errado em rota conhecida → 405.
 *
 *  Skip se não houver Postgres (hasDb()). Determinístico: fatos via putFacts direto, sem LLM (o /v1/ask
 *  pode disparar a síntese real do provider de dev — por isso os asserts de VALOR moram em facts[]/scope;
 *  o `answer` é livre). Fixture sufixado `gw-v1` (isolado dos demais smokes no mesmo banco). */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import type { Server } from "node:http";
import { hasDb } from "../integration/helpers/db.ts";
import { wipeBrain } from "../integration/helpers/db.ts";
import { startGatewayServer } from "../../src/connectors/gateway-server.ts";
import { getEngine, closeEngines, type FactRow, type PageRow } from "../../src/core/platform/engine.ts";
import { createPrincipal, setGrant, issueToken } from "../../src/core/access/principals.ts";
import { _resetCostQuotaCache } from "../../src/core/platform/cost-quota.ts";
import {
  enqueueIngestJob,
  getJob,
  markJobDone,
  closeIngestQueue,
} from "../../src/core/ingestion/ingest-queue.ts";

// --- Fixture (nomes EXATOS, isolados por sufixo gw-v1) ---
const BRAIN = "__smoke_gw_v1";
const OTHER_BRAIN = "__smoke_gw_v1_other"; // tenant alheio — prova que o token NÃO o alcança
const PRINCIPAL_VENDAS = "gw-agent-vendas"; // escopado SÓ à área `vendas`, teto `interno`
const PRINCIPAL_RL = "gw-agent-ratelimit"; // principal dedicado ao teste de 429 (não polui os outros)
const PRINCIPAL_WRITER = "gw-agent-writer"; // COM can_ingest → pode escrever (/v1/ingest)
const PRINCIPAL_READER = "gw-agent-reader"; // SEM can_ingest → read-only (403 no /v1/ingest)
const PRINCIPAL_DENIED = "gw-agent-denied"; // escopado a área SEM fatos → toda leitura = negação TOTAL
const PRINCIPAL_DENIED_THROTTLE = "gw-agent-denied-throttle"; // p/ provar o throttle (5 → 1)
const PRINCIPAL_DENIED_403 = "gw-agent-denied-403"; // read-only DEDICADO ao gancho do 403 (escrita)

let server: Server | null = null;
let baseUrl = "";
let tokenVendas = ""; // token cru do principal escopado (lido após o seed)
let tokenRl = ""; // token cru do principal de rate-limit
let tokenWriter = ""; // token COM can_ingest
let tokenReader = ""; // token SEM can_ingest (read-only)
let tokenDenied = ""; // token cujo escopo barra TUDO (negação total em toda leitura)
let tokenDeniedThrottle = ""; // token p/ o teste de throttle do webhook access.denied
let tokenDenied403 = ""; // token read-only p/ o gancho do 403 (escrita → access.denied)

let _reqSeq = 0; // sequência p/ X-Forwarded-For único por request (espalha o balde pré-auth por IP)

/** fetch tipado contra o gateway. `bearer` injeta Authorization; ausente = anônimo.
 *  IP de cliente: sob TRUST_PROXY=1 (setado no beforeAll) o gateway lê o RIGHTMOST do X-Forwarded-For.
 *  Por DEFAULT cada request manda um XFF ÚNICO → cai num balde pré-auth próprio (o teto de 120/min/IP
 *  da borda fica ATIVO, mas a suíte não tromba nele). `ip` PINA um IP fixo: os testes de rate-limit
 *  (per-token e pré-auth) usam isso pra ACUMULAR no MESMO balde e provar o 429. */
async function gw(
  path: string,
  opts: { method?: string; body?: unknown; bearer?: string; headers?: Record<string, string>; ip?: string } = {},
): Promise<{ status: number; json: any; raw: string; retryAfter: string | null }> {
  const headers: Record<string, string> = { ...(opts.headers || {}) };
  if (opts.bearer) headers["authorization"] = `Bearer ${opts.bearer}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  headers["x-forwarded-for"] = opts.ip ?? `10.1.${(_reqSeq >> 8) & 255}.${_reqSeq & 255}`;
  _reqSeq += 1;
  const res = await fetch(baseUrl + path, {
    method: opts.method || "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const raw = await res.text();
  let json: any = null;
  try {
    json = raw ? JSON.parse(raw) : null;
  } catch {
    /* não-json */
  }
  return { status: res.status, json, raw, retryAfter: res.headers.get("retry-after") };
}

/** página-fonte do fixture (tags carregam a área; sensibilidade governa o teto). */
const page = (slug: string, tags: string[], sensitivity: string, body: string): PageRow =>
  ({ slug, type: "reunioes", title: slug, date: "2024-06-01", path: "", body, content_hash: slug, tags, sensitivity } as PageRow);

/** fato tipado ancorado numa página-fonte. */
const fact = (slug: string, entity: string, value: string, vn: number): FactRow =>
  ({
    source_slug: slug, type: "reunioes", dimension: "decisions", idx: 0, text: "", quote: `${value}/mês`, meta: {},
    entity, predicate: "preco", value, value_num: vn, unit: "BRL", period: "monthly", tier: "enterprise",
    valid_from: "2024-06-01", valid_to: "", confidence: 0.9, status: "fato",
  } as FactRow);

/** fato totalmente parametrizável (p/ os testes de Blocker-1 e status archived): o `text` carrega o
 *  valor (essencial p/ provar que o LLM o teria visto); `valid_to` controla a supersessão temporal;
 *  `idx` evita colisão de chave-natural quando há +1 fato na mesma página/dimensão. */
const factFull = (o: {
  slug: string; entity: string; predicate?: string; value: string; vn?: number; text?: string;
  validFrom?: string; validTo?: string; status?: string; idx?: number;
}): FactRow =>
  ({
    source_slug: o.slug, type: "reunioes", dimension: "decisions", idx: o.idx ?? 0,
    text: o.text ?? "", quote: o.text || `${o.value}/mês`, meta: {},
    entity: o.entity, predicate: o.predicate ?? "preco", value: o.value,
    value_num: o.vn ?? null, unit: "BRL", period: "monthly", tier: "enterprise",
    valid_from: o.validFrom ?? "2024-06-01", valid_to: o.validTo ?? "",
    confidence: 0.9, status: o.status ?? "fato",
  } as FactRow);

/** token de VALOR ÚNICO e improvável (Blocker 1): se ele aparecer no `answer` de um token escopado a
 *  vendas, o escopo NÃO barrou a recuperação → o LLM viu corpus de produto. Distinto e inconfundível. */
const SECRET_PRODUTO = "ZZQ7-SECRETO-4242";

async function seed(): Promise<void> {
  await wipeBrain(BRAIN);
  await wipeBrain(OTHER_BRAIN);

  const e = await getEngine(BRAIN);
  // DUAS áreas: vendas (visível ao token) e produto (fora do escopo → withheld). Ambas `interno` (≤ teto).
  // upsertPage NÃO grava a coluna `sensitivity` (vira `restrito` por default no engine) → seta explícito
  // com e.setSensitivity (o setter dedicado) p/ o teste de teto valer `interno`, não o fail-closed.
  await e.upsertPage(page("call-vendas", ["area:vendas"], "interno", "Reuniao de vendas: o preco do plano enterprise da accelera passou para R$ 30 mil por mes."));
  await e.upsertPage(page("call-produto", ["area:produto"], "interno", "Roadmap de produto: o preco do modulo gama subiu para R$ 12 mil por mes."));
  await e.setSensitivity("call-vendas", "interno");
  await e.setSensitivity("call-produto", "interno");
  await e.putFacts([
    fact("call-vendas", "accelera", "R$ 30 mil", 30000),
    fact("call-produto", "gama", "R$ 12 mil", 12000),
    // BLOCKER 1: fato de PRODUTO com valor ÚNICO no TEXTO. Área `produto` (fora do escopo de vendas).
    // Se o escopo não barrar a RECUPERAÇÃO, o LLM verá este texto e o token vazará no `answer`.
    factFull({
      slug: "call-produto", entity: "delta", predicate: "codigo_secreto", value: SECRET_PRODUTO,
      text: `O código secreto do módulo delta de produto é ${SECRET_PRODUTO} (confidencial de produto).`,
      idx: 1,
    }),
    // STATUS ARCHIVED: fato de VENDAS (dentro do escopo) cujo valid_to já PASSOU → status público
    // "archived" derivado do TEMPO, mesmo gravado como status:"fato" pelo motor.
    factFull({
      slug: "call-vendas", entity: "accelera", predicate: "preco_antigo", value: "R$ 18 mil", vn: 18000,
      text: "Preço antigo da accelera: R$ 18 mil (vigorou até 2024-05-31).",
      validFrom: "2024-01-01", validTo: "2024-05-31", idx: 2,
    }),
  ]);

  // principal escopado SÓ a `vendas`, teto `interno` → enxerga accelera/vendas, barra gama/produto.
  await createPrincipal(BRAIN, { id: PRINCIPAL_VENDAS, kind: "agent", label: "Agente Vendas GW" });
  await setGrant(BRAIN, { principalId: PRINCIPAL_VENDAS, areas: ["vendas"], sensitivityMax: "interno", denyTypes: [] });
  tokenVendas = (await issueToken(BRAIN, { principalId: PRINCIPAL_VENDAS, label: "gw-smoke" })).token;

  // principal dedicado ao teste de rate-limit (mesmo escopo) — chave de balde própria, não throttla os outros.
  await createPrincipal(BRAIN, { id: PRINCIPAL_RL, kind: "agent", label: "Agente RL GW" });
  await setGrant(BRAIN, { principalId: PRINCIPAL_RL, areas: ["vendas"], sensitivityMax: "interno", denyTypes: [] });
  tokenRl = (await issueToken(BRAIN, { principalId: PRINCIPAL_RL, label: "gw-smoke-rl" })).token;

  // ESCRITA: principal COM can_ingest (pode ingerir) vs principal SEM (read-only, 403 no /v1/ingest).
  await createPrincipal(BRAIN, { id: PRINCIPAL_WRITER, kind: "agent", label: "Agente Writer GW" });
  await setGrant(BRAIN, { principalId: PRINCIPAL_WRITER, areas: ["vendas"], sensitivityMax: "interno", denyTypes: [], canIngest: true });
  tokenWriter = (await issueToken(BRAIN, { principalId: PRINCIPAL_WRITER, label: "gw-smoke-writer" })).token;

  await createPrincipal(BRAIN, { id: PRINCIPAL_READER, kind: "agent", label: "Agente Reader GW" });
  await setGrant(BRAIN, { principalId: PRINCIPAL_READER, areas: ["vendas"], sensitivityMax: "interno", denyTypes: [] }); // SEM canIngest → fail-closed
  tokenReader = (await issueToken(BRAIN, { principalId: PRINCIPAL_READER, label: "gw-smoke-reader" })).token;

  // NEGAÇÃO TOTAL (access.denied): principal escopado a uma área SEM nenhum fato (`juridico`). Como o
  // /v1/facts busca o universo INTEIRO de decisions (não escopado no motor) e o applyScope barra TUDO,
  // toda leitura deste token volta kept===0 && withheld>0 → negação TOTAL. Token próprio = balde de
  // throttle (adwh:<principal>) isolado dos demais (não throttla / não é throttlado por outros casos).
  await createPrincipal(BRAIN, { id: PRINCIPAL_DENIED, kind: "agent", label: "Agente Denied GW" });
  await setGrant(BRAIN, { principalId: PRINCIPAL_DENIED, areas: ["juridico"], sensitivityMax: "interno", denyTypes: [] }); // área SEM fatos
  tokenDenied = (await issueToken(BRAIN, { principalId: PRINCIPAL_DENIED, label: "gw-smoke-denied" })).token;
  // principal SÓ p/ o teste de THROTTLE (5 negações → no máx 1 emissão): balde próprio, mesma área vazia.
  await createPrincipal(BRAIN, { id: PRINCIPAL_DENIED_THROTTLE, kind: "agent", label: "Agente Denied Throttle GW" });
  await setGrant(BRAIN, { principalId: PRINCIPAL_DENIED_THROTTLE, areas: ["juridico"], sensitivityMax: "interno", denyTypes: [] });
  tokenDeniedThrottle = (await issueToken(BRAIN, { principalId: PRINCIPAL_DENIED_THROTTLE, label: "gw-smoke-denied-throttle" })).token;
  // principal READ-ONLY (sem canIngest) DEDICADO ao gancho do 403 (escrita → access.denied): balde de
  // throttle próprio, p/ não colidir com o do teste de 403 puro (PRINCIPAL_READER).
  await createPrincipal(BRAIN, { id: PRINCIPAL_DENIED_403, kind: "agent", label: "Agente Denied 403 GW" });
  await setGrant(BRAIN, { principalId: PRINCIPAL_DENIED_403, areas: ["vendas"], sensitivityMax: "interno", denyTypes: [] }); // SEM canIngest
  tokenDenied403 = (await issueToken(BRAIN, { principalId: PRINCIPAL_DENIED_403, label: "gw-smoke-denied-403" })).token;

  // tenant ALHEIO: um fato em outro brain. O token de BRAIN jamais deve alcançá-lo (isolamento por token).
  const eo = await getEngine(OTHER_BRAIN);
  await eo.upsertPage(page("call-alheia", ["area:vendas"], "interno", "Outro tenant: o preco do plano omega subiu para R$ 99 mil por mes."));
  await eo.setSensitivity("call-alheia", "interno");
  await eo.putFacts([fact("call-alheia", "omega", "R$ 99 mil", 99000)]);
}

/** campos internos crus que JAMAIS podem vazar pro contrato público (selo de não-vazamento). */
const INTERNAL_LEAK_KEYS = ["natureza", "valid_to", "value_num", "source_slug", "dimension", "quote", "idx", "meta", "type"];
/** campos públicos OBRIGATÓRIOS do selo (perguntar.astro / fatos.astro). */
const PUBLIC_KEYS = ["id", "status", "text", "confidence", "sensitivity", "area", "source", "valid_from", "valid_until", "supersedes"];

/** assere que um fact tem o shape público EXATO e não carrega nenhum campo interno cru. */
function assertPublicFact(f: any) {
  for (const k of PUBLIC_KEYS) expect(f, `falta campo público '${k}'`).toHaveProperty(k);
  for (const k of INTERNAL_LEAK_KEYS) expect(f, `vazou campo interno '${k}'`).not.toHaveProperty(k);
  expect(["fact", "hypothesis", "archived"]).toContain(f.status);
  expect(["open", "internal", "confidential", "secret"]).toContain(f.sensitivity);
  expect(Array.isArray(f.area)).toBe(true);
  expect(f.source).toMatchObject({ type: expect.any(String), ref: expect.any(String) });
  expect("occurred_at" in f.source).toBe(true);
  expect(f.confidence === null || typeof f.confidence === "number").toBe(true);
}

describe.skipIf(!hasDb())("GATEWAY /v1 smoke — borda pública (porta efêmera)", () => {
  beforeAll(async () => {
    await seed();
    // god-token estático: se existir no ambiente, a borda NÃO pode aceitá-lo. Setamos um valor conhecido
    // p/ provar explicitamente que passá-lo como Bearer dá 401 (a borda ignora API_TOKEN por design).
    process.env.API_TOKEN = "god-token-estatico-NAO-DEVE-AUTENTICAR";
    process.env.GATEWAY_PORT = "0"; // o OS escolhe a porta livre
    // Topologia de proxy reverso confiável (igual ao smoke do BFF): o gateway lê o RIGHTMOST do
    // X-Forwarded-For p/ o clientIp. Cada request manda um XFF único (ver gw()), então o teto
    // pré-auth por IP (120/min) fica ATIVO e testável sem travar a própria suíte.
    process.env.TRUST_PROXY = "1";
    server = startGatewayServer(BRAIN);
    await new Promise<void>((resolve) => server!.once("listening", () => resolve()));
    const addr = server!.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = null;
    await wipeBrain(BRAIN);
    await wipeBrain(OTHER_BRAIN);
    await closeIngestQueue(); // fecha a conexão compartilhada da fila (criada pelos testes de /v1/ingest)
    await closeEngines();
  });

  // ---------- 1) AUTH da borda ----------
  it("SEM Authorization → 401", async () => {
    const r = await gw("/v1/facts");
    expect(r.status).toBe(401);
    expect(r.json?.error).toBe("token inválido");
  });

  it("token aleatório/inexistente → 401", async () => {
    const r = await gw("/v1/facts", { bearer: "gld_live_" + "0".repeat(64) });
    expect(r.status).toBe(401);
  });

  it("god-token estático (API_TOKEN) como Bearer NÃO autentica → 401", async () => {
    expect(process.env.API_TOKEN).toBeTruthy(); // garante que o god-token EXISTE no ambiente
    const r = await gw("/v1/facts", { bearer: process.env.API_TOKEN! });
    expect(r.status).toBe(401);
    // e o /v1/ask idem (a borda nunca honra o god-token, em rota alguma).
    const a = await gw("/v1/ask", { method: "POST", bearer: process.env.API_TOKEN!, body: { question: "preço?" } });
    expect(a.status).toBe(401);
  });

  it("auth roda ANTES do método: cliente sem token em rota /v1 vê 401, nunca 405", async () => {
    const r = await gw("/v1/ask", { method: "GET" }); // método errado + sem token → 401 (não 405)
    expect(r.status).toBe(401);
  });

  // ---------- 2) SHAPE público do /v1/ask ----------
  // timeout LARGO: este é o único assert que dispara SÍNTESE REAL no provider de dev (binário
  // `claude` local sem ANTHROPIC_API_KEY) — a latência varia com a carga da máquina e os 30s
  // default flakavam a suíte inteira. Os asserts de VALOR continuam determinísticos (facts[]).
  it("POST /v1/ask com token válido → 200 com shape público { answer, facts[], withheld }", { timeout: 240_000 }, async () => {
    const r = await gw("/v1/ask", { method: "POST", bearer: tokenVendas, body: { question: "Qual o preço da accelera?" } });
    expect(r.status).toBe(200);
    // envelope público
    expect(typeof r.json.answer).toBe("string");
    expect(Array.isArray(r.json.facts)).toBe(true);
    expect(r.json.withheld).toMatchObject({ count: expect.any(Number), reason: expect.any(String) });
    // cada fact tem o selo público e NENHUM campo interno cru
    for (const f of r.json.facts) assertPublicFact(f);
    // a série da pergunta traz o fato `accelera` (área vendas, dentro do escopo) — pelo menos 1 fato.
    expect(r.json.facts.length).toBeGreaterThanOrEqual(1);
    // o escopo `vendas` enxerga accelera; e JAMAIS o fato `gama` (área produto, fora do escopo).
    const texts = r.json.facts.map((f: any) => `${f.area.join(",")}|${f.text}`).join(" || ");
    expect(r.json.facts.every((f: any) => !f.area.includes("produto"))).toBe(true);
    // sanity: nada de gama vazando
    expect(texts.toLowerCase()).not.toContain("gama");
  });

  it("POST /v1/ask sem 'question' → 400", async () => {
    const r = await gw("/v1/ask", { method: "POST", bearer: tokenVendas, body: { foo: "bar" } });
    expect(r.status).toBe(400);
  });

  // ---------- 3) SHAPE do /v1/facts + coerção de limit ----------
  it("GET /v1/facts com area/status/limit → 200 shape público; limit>200 coerçado p/ 200", async () => {
    const r = await gw("/v1/facts?area=vendas&status=fact&limit=50", { bearer: tokenVendas });
    expect(r.status).toBe(200);
    expect(Array.isArray(r.json.facts)).toBe(true);
    expect(r.json.facts.length).toBeGreaterThanOrEqual(1);
    for (const f of r.json.facts) {
      assertPublicFact(f);
      expect(f.status).toBe("fact");
      expect(f.area).toContain("vendas");
    }
    // limit>200 não estoura: o slice nunca devolve mais que o teto (o fixture é pequeno, então o assert
    // de coerção é indireto — o server faz Math.min(limit,200); um limit absurdo retorna 200 e não erra).
    const big = await gw("/v1/facts?limit=999999", { bearer: tokenVendas });
    expect(big.status).toBe(200);
    expect(big.json.facts.length).toBeLessThanOrEqual(200);
    // status inválido → 400 (validação da borda)
    const bad = await gw("/v1/facts?status=banana", { bearer: tokenVendas });
    expect(bad.status).toBe(400);
  });

  // ---------- 4) ESCOPO (2 áreas) + TENANT ----------
  it("ESCOPO: token de `vendas` só enxerga fatos de `vendas` (gama/produto fica fora)", async () => {
    const all = await gw("/v1/facts?limit=200", { bearer: tokenVendas });
    expect(all.status).toBe(200);
    // NENHUM fato da área produto aparece (escopo fail-closed por página-fonte).
    expect(all.json.facts.some((f: any) => f.area.includes("produto"))).toBe(false);
    // e o fato de vendas (accelera) ESTÁ presente.
    expect(all.json.facts.some((f: any) => f.area.includes("vendas"))).toBe(true);
    expect(all.json.facts.some((f: any) => (f.text || "").toLowerCase().includes("accelera") || f.source.ref === "call-vendas")).toBe(true);
    // filtrar explicitamente por area=produto não revela nada (o escopo barra ANTES do filtro público).
    const prod = await gw("/v1/facts?area=produto&limit=200", { bearer: tokenVendas });
    expect(prod.status).toBe(200);
    expect(prod.json.facts.length).toBe(0);
  });

  it("TENANT: o brain vem do TOKEN — não há ?brain= que sobreponha (sem vazar outro tenant)", async () => {
    // tenta forçar o brain alheio pela query: a borda IGNORA ?brain= (brain vem do token de BRAIN).
    const r = await gw(`/v1/facts?brain=${OTHER_BRAIN}&limit=200`, { bearer: tokenVendas });
    expect(r.status).toBe(200);
    // o fato `omega` (do OTHER_BRAIN) NÃO aparece — o token nunca alcança outro tenant.
    const refs = r.json.facts.map((f: any) => f.source.ref);
    expect(refs).not.toContain("call-alheia");
    expect(r.json.facts.every((f: any) => (f.text || "").toLowerCase().indexOf("omega") === -1)).toBe(true);
    // e via /v1/ask perguntando explicitamente pelo dado alheio: o withheld é honesto e omega não vaza.
    const a = await gw("/v1/ask", { method: "POST", bearer: tokenVendas, body: { question: "Qual o preço do omega?" } });
    expect(a.status).toBe(200);
    expect(a.json.facts.every((f: any) => (f.text || "").toLowerCase().indexOf("omega") === -1)).toBe(true);
  });

  // ---------- 4b) BLOCKER 1 — a PROSA do /v1/ask é sintetizada SOB ESCOPO (não vaza cross-área) ----------
  // timeout largo: síntese REAL no provider de dev (mesma razão do teste de shape acima)
  it("BLOCKER 1: /v1/ask com token de `vendas` perguntando pelo segredo de PRODUTO → o valor único NÃO vaza na prosa", { timeout: 240_000 }, async () => {
    // O fato `delta` (área produto, FORA do escopo de vendas) carrega o token único SECRET_PRODUTO no
    // seu TEXTO. Antes do fix, askHandler chamava ask() SEM scope → o motor recuperava o corpus inteiro
    // e o LLM via (e podia ecoar) o segredo de produto. Com o fix, o motor é escopado: a recuperação
    // barra a página de produto ANTES do prompt → o LLM nunca vê o segredo.
    const r = await gw("/v1/ask", {
      method: "POST",
      bearer: tokenVendas,
      // a pergunta NÃO contém nenhum pedaço do token (senão o LLM poderia ecoar o prompt) — só pede o valor.
      body: { question: "Qual é o código secreto do módulo delta de produto? Responda com o valor exato." },
    });
    expect(r.status).toBe(200);
    // (1) o ANSWER (prosa do LLM) NÃO pode conter o token único — prova que o escopo barrou a recuperação.
    expect(r.json.answer).not.toContain(SECRET_PRODUTO);
    expect(String(r.json.answer).toUpperCase()).not.toContain(SECRET_PRODUTO.toUpperCase());
    // (2) nenhum fato de produto vaza na série (defesa-em-profundidade da borda).
    expect(r.json.facts.every((f: any) => !f.area.includes("produto"))).toBe(true);
    expect(r.json.facts.every((f: any) => !String(f.text || "").includes(SECRET_PRODUTO))).toBe(true);
    expect(r.json.facts.every((f: any) => f.source.ref !== "call-produto")).toBe(true);
    // (3) withheld coerente: é um nº ≥ 0 com reason consistente (>0 ⇒ "fora do seu acesso"; 0 ⇒ "").
    expect(typeof r.json.withheld.count).toBe("number");
    expect(r.json.withheld.count).toBeGreaterThanOrEqual(0);
    if (r.json.withheld.count > 0) expect(r.json.withheld.reason).toBe("fora do seu acesso");
    else expect(r.json.withheld.reason).toBe("");
  });

  // ---------- 4c) STATUS ARCHIVED derivado do TEMPO (valid_until no passado) ----------
  it("STATUS: fato cujo valid_until já passou → status:'archived' (derivado do tempo, não do campo cru)", async () => {
    // O fato `accelera/preco_antigo` (área vendas, DENTRO do escopo) tem valid_to=2024-05-31 (passado),
    // mas o motor o gravou como status:"fato". A borda DEVE derivar "archived" do tempo.
    const arc = await gw("/v1/facts?status=archived&limit=200", { bearer: tokenVendas });
    expect(arc.status).toBe(200);
    // o fato antigo aparece SÓ sob status=archived (e com status público "archived").
    const antigo = arc.json.facts.find((f: any) => String(f.text || "").includes("R$ 18 mil"));
    expect(antigo, "fato superado deveria aparecer sob status=archived").toBeTruthy();
    expect(antigo.status).toBe("archived");
    expect(antigo.valid_until).toBe("2024-05-31");
    // e NÃO aparece sob status=fact (o default) — supersedido não é fato vigente.
    const vig = await gw("/v1/facts?status=fact&limit=200", { bearer: tokenVendas });
    expect(vig.status).toBe(200);
    expect(vig.json.facts.every((f: any) => !String(f.text || "").includes("R$ 18 mil"))).toBe(true);
    // o fato VIGENTE (accelera 30 mil, valid_to vazio) continua "fact".
    expect(vig.json.facts.some((f: any) => f.status === "fact")).toBe(true);
  });

  // ---------- 4d) status=hypothesis não é suportado por esta rota (doc ↔ código coerentes) ----------
  it("STATUS: status=hypothesis → 400 (não prometido nesta rota da fase 1)", async () => {
    const r = await gw("/v1/facts?status=hypothesis", { bearer: tokenVendas });
    expect(r.status).toBe(400);
    expect(String(r.json?.error || "")).toContain("hypothesis");
  });

  // ---------- 4e) KILL-SWITCH de custo de LLM por brain (402) ----------
  describe("KILL-SWITCH de custo de LLM (quota diária por brain → 402)", () => {
    const QUOTA_PRINCIPAL = "gw-agent-quota";
    let tokenQuota = "";
    const prevBudget = process.env.GALEED_LLM_DAILY_BUDGET_USD;

    beforeAll(async () => {
      // principal escopado a vendas (mesma fixture), token próprio p/ não poluir os baldes de rate-limit.
      await createPrincipal(BRAIN, { id: QUOTA_PRINCIPAL, kind: "agent", label: "Agente Quota GW" });
      await setGrant(BRAIN, { principalId: QUOTA_PRINCIPAL, areas: ["vendas"], sensitivityMax: "interno", denyTypes: [] });
      tokenQuota = (await issueToken(BRAIN, { principalId: QUOTA_PRINCIPAL, label: "gw-smoke-quota" })).token;
    });

    afterEach(() => {
      // restaura o env e zera o micro-cache de quota entre casos (cada teste seta o teto que precisa).
      if (prevBudget === undefined) delete process.env.GALEED_LLM_DAILY_BUDGET_USD;
      else process.env.GALEED_LLM_DAILY_BUDGET_USD = prevBudget;
      _resetCostQuotaCache(BRAIN);
    });

    it("ACUMULADO de HOJE acima do teto → 402 com {current_usd, limit_usd}", async () => {
      // semeia UMA linha de custo de HOJE ACIMA do teto baixo que vamos setar.
      const e = await getEngine(BRAIN);
      await e.putLlmUsage({
        brain: BRAIN, op: "synthesis", provider: "api", model: "test-quota",
        tokens_in: 1, tokens_out: 1, cost_usd: 9.99, meta: { smoke: "quota-over" },
      } as any);
      process.env.GALEED_LLM_DAILY_BUDGET_USD = "0.01"; // teto bem abaixo do acumulado
      _resetCostQuotaCache(BRAIN); // micro-cache pode ter um valor antigo de outro caso

      const r = await gw("/v1/ask", { method: "POST", bearer: tokenQuota, body: { question: "Qual o preço da accelera?" } });
      expect(r.status).toBe(402);
      expect(r.json?.error).toBe("limite diário de custo de LLM atingido");
      expect(typeof r.json?.current_usd).toBe("number");
      expect(typeof r.json?.limit_usd).toBe("number");
      expect(r.json.current_usd).toBeGreaterThanOrEqual(r.json.limit_usd); // exceeded = current >= limit
      expect(r.json.limit_usd).toBe(0.01);
    });

    // timeout largo: síntese REAL no provider de dev (mesma razão do teste de shape acima)
    it("ACUMULADO de HOJE abaixo do teto → 200 normal (a quota não barra)", { timeout: 240_000 }, async () => {
      // teto alto: o acumulado do dia (mesmo com a linha de 9.99) fica abaixo → /v1/ask roda normal.
      process.env.GALEED_LLM_DAILY_BUDGET_USD = "1000000";
      _resetCostQuotaCache(BRAIN);

      const r = await gw("/v1/ask", { method: "POST", bearer: tokenQuota, body: { question: "Qual o preço da accelera?" } });
      expect(r.status).toBe(200);
      expect(typeof r.json.answer).toBe("string");
      expect(Array.isArray(r.json.facts)).toBe(true);
    });
  });

  // ---------- 4f) INGESTÃO (/v1/ingest) — escrita gateada por can_ingest + status público ----------
  describe("INGESTÃO /v1/ingest — escrita gateada (can_ingest) + GET de status", () => {
    // (a) token COM can_ingest → POST /v1/ingest → 202 com batch_id e shape EXATO do contrato.
    it("(a) POST /v1/ingest com token can_ingest → 202 { batch_id, status:'organizing', source, received_at }", async () => {
      const r = await gw("/v1/ingest", {
        method: "POST",
        bearer: tokenWriter,
        body: { source: "call_vendas", content: "Reunião de vendas: fechamos o plano enterprise por R$ 30 mil/mês." },
      });
      expect(r.status).toBe(202);
      expect(typeof r.json.batch_id).toBe("string");
      expect(r.json.batch_id.length).toBeGreaterThan(0);
      expect(r.json.status).toBe("organizing");
      expect(r.json.source).toBe("call_vendas");
      expect(typeof r.json.received_at).toBe("string");
      expect(Number.isNaN(Date.parse(r.json.received_at))).toBe(false); // received_at é ISO válido
      // NÃO vaza campos internos crus do job no 202.
      for (const k of ["brain", "text_body", "content_hash", "lease_until", "attempts", "textBody"]) {
        expect(r.json).not.toHaveProperty(k);
      }
      // o job EXISTE na fila, no brain do token, status interno 'queued'.
      const job = await getJob(BRAIN, r.json.batch_id);
      expect(job).toBeTruthy();
      expect(job!.brain).toBe(BRAIN);
      expect(job!.kind).toBe("text");
      expect(job!.type).toBe("call_vendas");
      expect(job!.status).toBe("queued");
    });

    // (b) token read-only (sem can_ingest) → 403 (fail-closed).
    it("(b) POST /v1/ingest com token SEM can_ingest → 403", async () => {
      const r = await gw("/v1/ingest", {
        method: "POST",
        bearer: tokenReader,
        body: { source: "call_vendas", content: "qualquer coisa" },
      });
      expect(r.status).toBe(403);
      expect(String(r.json?.error || "")).toContain("can_ingest");
    });

    // (c) doc_url no body → rejeitado (anti-SSRF).
    it("(c) POST /v1/ingest com doc_url no body → 410 (anti-SSRF)", async () => {
      const r = await gw("/v1/ingest", {
        method: "POST",
        bearer: tokenWriter,
        body: { source: "call_vendas", content: "texto", doc_url: "http://169.254.169.254/latest/meta-data/" },
      });
      expect(r.status).toBe(410);
      expect(String(r.json?.error || "").toLowerCase()).toContain("ssrf");
      // audio_url e doc_base64 idem.
      const a = await gw("/v1/ingest", { method: "POST", bearer: tokenWriter, body: { source: "s", content: "t", audio_url: "http://x/" } });
      expect(a.status).toBe(410);
      const b = await gw("/v1/ingest", { method: "POST", bearer: tokenWriter, body: { source: "s", content: "t", doc_base64: "aGVsbG8=" } });
      expect(b.status).toBe(410);
    });

    // (d) sem content → 400 (e sem source → 400).
    it("(d) POST /v1/ingest sem 'content' → 400; sem 'source' → 400", async () => {
      const noContent = await gw("/v1/ingest", { method: "POST", bearer: tokenWriter, body: { source: "call_vendas" } });
      expect(noContent.status).toBe(400);
      expect(String(noContent.json?.error || "")).toContain("content");
      const noSource = await gw("/v1/ingest", { method: "POST", bearer: tokenWriter, body: { content: "texto cru" } });
      expect(noSource.status).toBe(400);
      expect(String(noSource.json?.error || "")).toContain("source");
    });

    // (e) GET /v1/ingest/:id do próprio job → shape público; job de OUTRO brain → 404.
    it("(e) GET /v1/ingest/:id do próprio job → shape público; job de outro brain → 404", async () => {
      // cria um job no próprio brain via /v1/ingest e consulta o status.
      const created = await gw("/v1/ingest", {
        method: "POST",
        bearer: tokenWriter,
        body: { source: "call_vendas", content: "Outro conteúdo pra organizar." },
      });
      expect(created.status).toBe(202);
      const id = created.json.batch_id;

      const st = await gw(`/v1/ingest/${id}`, { bearer: tokenWriter });
      expect(st.status).toBe(200);
      expect(st.json.batch_id).toBe(id);
      // status público ∈ enum estável (recém-criado = "organizing").
      expect(["organizing", "indexed", "organized", "failed"]).toContain(st.json.status);
      expect(st.json.status).toBe("organizing");
      // NÃO vaza nenhum campo interno cru do job.
      for (const k of ["brain", "text_body", "textBody", "content_hash", "contentHash", "lease_until", "leaseUntil", "attempts", "batchId", "kind", "type"]) {
        expect(st.json).not.toHaveProperty(k);
      }

      // status 'organized' quando o job terminou: marca done e re-consulta → result.facts presente.
      await markJobDone(id, { total: 3, slugs: ["a", "b", "c"], skipped: 0, message: "Entrou 1 documento (3 partes)." });
      const done = await gw(`/v1/ingest/${id}`, { bearer: tokenWriter });
      expect(done.status).toBe(200);
      expect(done.json.status).toBe("organized");
      expect(done.json.result).toMatchObject({ facts: 3 });

      // job de OUTRO brain: o token de BRAIN não o alcança → 404 (não vaza cross-tenant).
      const { jobId: alheio } = await enqueueIngestJob({ brain: OTHER_BRAIN, kind: "text", type: "call_alheia", textBody: "segredo de outro tenant" });
      const cross = await gw(`/v1/ingest/${alheio}`, { bearer: tokenWriter });
      expect(cross.status).toBe(404);
      // sanity: o job alheio REALMENTE existe no outro brain (o 404 é por isolamento, não por inexistência).
      expect(await getJob(OTHER_BRAIN, alheio)).toBeTruthy();
      // id inexistente → 404 também.
      const ghost = await gw(`/v1/ingest/nao-existe-${Date.now()}`, { bearer: tokenWriter });
      expect(ghost.status).toBe(404);
    });

    // (f) quota de custo estourada → 402 PRÉ-ENQUEUE (não enfileira).
    it("(f) POST /v1/ingest com quota diária estourada → 402 (PRÉ-ENQUEUE)", async () => {
      const e = await getEngine(BRAIN);
      await e.putLlmUsage({
        brain: BRAIN, op: "synthesis", provider: "api", model: "test-quota-ingest",
        tokens_in: 1, tokens_out: 1, cost_usd: 9.99, meta: { smoke: "ingest-quota-over" },
      } as any);
      const prevBudget = process.env.GALEED_LLM_DAILY_BUDGET_USD;
      process.env.GALEED_LLM_DAILY_BUDGET_USD = "0.01";
      _resetCostQuotaCache(BRAIN);
      try {
        const r = await gw("/v1/ingest", {
          method: "POST",
          bearer: tokenWriter,
          body: { source: "call_vendas", content: "isto não deveria enfileirar" },
        });
        expect(r.status).toBe(402);
        expect(r.json?.error).toBe("limite diário de custo de LLM atingido");
        expect(typeof r.json?.current_usd).toBe("number");
        expect(typeof r.json?.limit_usd).toBe("number");
      } finally {
        if (prevBudget === undefined) delete process.env.GALEED_LLM_DAILY_BUDGET_USD;
        else process.env.GALEED_LLM_DAILY_BUDGET_USD = prevBudget;
        _resetCostQuotaCache(BRAIN);
      }
    });

    // occurred_at inválido → 400 (não engole shape ruim).
    it("(g) POST /v1/ingest com occurred_at inválido → 400; participants não-lista → 400; sensitivity inválida → 400", async () => {
      const badDate = await gw("/v1/ingest", { method: "POST", bearer: tokenWriter, body: { source: "s", content: "t", occurred_at: "ontem de tarde" } });
      expect(badDate.status).toBe(400);
      expect(String(badDate.json?.error || "")).toContain("occurred_at");
      const badPart = await gw("/v1/ingest", { method: "POST", bearer: tokenWriter, body: { source: "s", content: "t", participants: "fulano" } });
      expect(badPart.status).toBe(400);
      const badSens = await gw("/v1/ingest", { method: "POST", bearer: tokenWriter, body: { source: "s", content: "t", sensitivity: "ultra-secreto" } });
      expect(badSens.status).toBe(400);
      // occurred_at VÁLIDO + sensitivity válida + participants lista → 202 (caminho feliz com extras).
      const ok = await gw("/v1/ingest", {
        method: "POST",
        bearer: tokenWriter,
        body: { source: "call_vendas", content: "com extras", occurred_at: "2026-05-01T10:00:00Z", participants: ["ana", "bruno"], sensitivity: "internal" },
      });
      expect(ok.status).toBe(202);
      const job = await getJob(BRAIN, ok.json.batch_id);
      expect(job!.jobDate).toBe("2026-05-01"); // occurred_at ISO → jobDate YYYY-MM-DD
    });

    // auth roda no /v1/ingest: sem token → 401; god-token → 401.
    it("(h) /v1/ingest exige Bearer de token emitido (sem token → 401; god-token → 401)", async () => {
      const anon = await gw("/v1/ingest", { method: "POST", body: { source: "s", content: "t" } });
      expect(anon.status).toBe(401);
      const god = await gw("/v1/ingest", { method: "POST", bearer: process.env.API_TOKEN!, body: { source: "s", content: "t" } });
      expect(god.status).toBe(401);
    });
  });

  // ---------- 4g) WEBHOOK access.denied — SÓ em negação TOTAL, com throttle ----------
  describe("WEBHOOK access.denied — só em negação TOTAL (kept===0 && withheld>0) ou 403, com throttle", () => {
    let webhookId = "";

    // registra UM webhook que assina access.denied (DIRETO no store; a borda fan-out enfileira a entrega).
    beforeAll(async () => {
      const e = await getEngine(BRAIN);
      webhookId = "wh-access-denied";
      await e.putWebhook({
        id: webhookId,
        url: "https://example.com/access-denied-hook",
        events: ["access.denied"] as any,
        secret: "secret-access-denied-smoke",
        label: "access.denied smoke",
        status: "active",
        created_by: "",
      });
    });

    afterAll(async () => {
      const e = await getEngine(BRAIN);
      await e.deleteWebhook(webhookId).catch(() => {});
    });

    /** drena TODAS as entregas enfileiradas do brain e devolve só as de access.denied (event + payload).
     *  claimNextWebhookDelivery pega 1 por vez (marca 'delivering' c/ lease no futuro → não re-claima na
     *  mesma drenagem). Marcamos cada uma como 'done' p/ não reaparecer em drenagens futuras de outro caso. */
    async function drainOnce(): Promise<{ event: string; payload: any }[]> {
      const e = await getEngine(BRAIN);
      const out: { event: string; payload: any }[] = [];
      for (let i = 0; i < 200; i++) {
        const d = await e.claimNextWebhookDelivery(60_000);
        if (!d) break;
        if (d.event === "access.denied") out.push({ event: d.event, payload: d.payload });
        await e.markWebhookDelivery(d.id, { status: "done" }); // tira da fila (não polui os outros casos)
      }
      return out;
    }

    /** O gancho da borda emite o webhook FIRE-AND-FORGET (não bloqueia a resposta HTTP) → o INSERT da
     *  entrega pode chegar ao banco DEPOIS da resposta. Aqui poll-amos até ver `expected` entregas (ou
     *  estabilizar): garante não-flake sem mascarar excesso (se viessem 2, o assert do caso ainda pega). */
    async function drainAccessDenied(expected = 0): Promise<{ event: string; payload: any }[]> {
      const acc: { event: string; payload: any }[] = [];
      for (let i = 0; i < 25; i++) {
        acc.push(...(await drainOnce()));
        if (acc.length >= expected && (expected > 0 || i >= 2)) break; // viu o esperado, ou estabilizou em 0
        await new Promise((r) => setTimeout(r, 20));
      }
      return acc;
    }

    // (a) NEGAÇÃO TOTAL: token escopado a área SEM fatos pergunta por algo só de outra área → kept===0 &&
    // withheld>0 → exatamente 1 delivery access.denied enfileirada, payload mínimo correto.
    it("(a) negação TOTAL (kept===0 && withheld>0) → 1 delivery access.denied com payload mínimo", async () => {
      await drainAccessDenied(); // zera o que veio de testes anteriores (isolamento determinístico)
      // /v1/facts busca o universo INTEIRO de decisions; o escopo `juridico` (sem fatos) barra TUDO →
      // toda decision vira withheld, kept===0 → negação TOTAL. Pedimos explicitamente `produto`.
      const r = await gw("/v1/facts?area=produto&limit=200", { bearer: tokenDenied });
      expect(r.status).toBe(200);
      expect(r.json.facts.length).toBe(0); // a leitura voltou VAZIA (tudo barrado pelo acesso)

      const deliveries = await drainAccessDenied(1);
      expect(deliveries.length).toBe(1); // EXATAMENTE 1 access.denied enfileirada
      const p = deliveries[0].payload;
      expect(p.principal_id).toBe(PRINCIPAL_DENIED);
      expect(p.reason).toBe("fora_de_escopo");
      expect(p.route).toBe("/v1/facts");
      expect(typeof p.at).toBe("string");
      expect(Number.isNaN(Date.parse(p.at))).toBe(false); // `at` é ISO válido
      // payload MÍNIMO: nenhum valor sensível (sem fatos/textos/contagem de conteúdo censurado).
      expect(Object.keys(p).sort()).toEqual(["at", "principal_id", "reason", "route"]);
    });

    // (b) RETORNO PARCIAL (kept>0, algum withheld): token `vendas` lê /v1/facts → vê vendas, esconde
    // produto → NÃO é negação total → NENHUMA delivery (não-ruído, não vaza existência de censurado).
    it("(b) retorno PARCIAL (kept>0, algum withheld) → NENHUMA delivery", async () => {
      await drainAccessDenied();
      // tokenVendas: o universo tem fatos de vendas (kept>0) E de produto (withheld>0) → PARCIAL.
      const r = await gw("/v1/facts?limit=200", { bearer: tokenVendas });
      expect(r.status).toBe(200);
      expect(r.json.facts.length).toBeGreaterThan(0); // viu algo (vendas) → kept>0
      expect(r.json.facts.some((f: any) => f.area.includes("produto"))).toBe(false); // escondeu produto

      const deliveries = await drainAccessDenied(0);
      expect(deliveries.length).toBe(0); // withheld PARCIAL JAMAIS dispara access.denied
    });

    // (c) THROTTLE: 5 negações totais SEGUIDAS do MESMO principal → no MÁX 1 delivery na janela (60s).
    it("(c) THROTTLE: 5 negações totais seguidas do mesmo principal → no máx 1 delivery", async () => {
      await drainAccessDenied();
      for (let i = 0; i < 5; i++) {
        const r = await gw("/v1/facts?area=produto&limit=200", { bearer: tokenDeniedThrottle });
        expect(r.status).toBe(200);
        expect(r.json.facts.length).toBe(0); // cada uma é negação total
      }
      const deliveries = await drainAccessDenied(1);
      // re-drena após um respiro p/ provar que NÃO escapou uma 2ª (caso o throttle vazasse): nada novo.
      await new Promise((r) => setTimeout(r, 60));
      deliveries.push(...(await drainOnce()));
      expect(deliveries.length).toBe(1); // throttle adwh:<principal> = 1/min → no máx 1 das 5
      expect(deliveries[0].payload.principal_id).toBe(PRINCIPAL_DENIED_THROTTLE);
    });

    // (d) 403 de capacidade (escrita sem can_ingest) também dispara access.denied (gancho do 403).
    it("(d) 403 can_ingest (POST /v1/ingest sem escrita) → 1 delivery access.denied (reason can_ingest)", async () => {
      await drainAccessDenied();
      const r = await gw("/v1/ingest", { method: "POST", bearer: tokenDenied403, body: { source: "s", content: "t" } });
      expect(r.status).toBe(403);

      const deliveries = await drainAccessDenied(1);
      expect(deliveries.length).toBe(1);
      expect(deliveries[0].payload.principal_id).toBe(PRINCIPAL_DENIED_403);
      expect(deliveries[0].payload.reason).toBe("can_ingest");
      expect(deliveries[0].payload.route).toBe("/v1/ingest");
    });
  });

  // ---------- 5) RATE-LIMIT ----------
  it("RATE-LIMIT: estourar a janela do /v1/facts → 429 com Retry-After", async () => {
    // FACTS_RATE = 300/min por token. Disparamos 305 requests com um principal DEDICADO (balde próprio):
    // as ~300 primeiras passam (200), e a borda passa a responder 429 + Retry-After. Rota sem LLM.
    let saw429 = false;
    let retryAfter: string | null = null;
    for (let i = 0; i < 305; i++) {
      const r = await gw("/v1/facts?limit=1", { bearer: tokenRl });
      if (r.status === 429) {
        saw429 = true;
        retryAfter = r.retryAfter;
        break;
      }
      expect(r.status).toBe(200); // antes de estourar, tudo 200
    }
    expect(saw429).toBe(true);
    expect(retryAfter).toBeTruthy(); // Retry-After presente (segundos até a janela resetar)
    expect(Number(retryAfter)).toBeGreaterThan(0);
  }, 60_000);

  // ---------- 5b) RATE-LIMIT PRÉ-AUTH por IP (anti-DoS no DB compartilhado) ----------
  it("RATE-LIMIT PRÉ-AUTH: muitas req com Bearer INVÁLIDO do MESMO IP → 429 ANTES do SELECT de auth", async () => {
    // AUTH_IP_RATE = 120/min/IP. Mandamos Bearer LIXO (que daria 401) de um IP FIXO e dedicado: o teto
    // por IP roda ANTES do authenticateTokenGlobal (que faz SELECT no Postgres), então o atacante que
    // martela com token inválido bate em 429 sem chegar ao DB. Antes do fix, todo Bearer-lixo passava
    // pelo SELECT primeiro (martelo no DB compartilhado). IP fixo ≠ dos outros testes (não os throttla).
    const ATTACK_IP = "203.0.113.66"; // TEST-NET-3, fixo e isolado
    const lixo = "gld_live_" + "9".repeat(64);
    let saw401 = 0;
    let saw429 = false;
    let retryAfter: string | null = null;
    for (let i = 0; i < 130; i++) {
      const r = await gw("/v1/facts?limit=1", { bearer: lixo, ip: ATTACK_IP });
      if (r.status === 429) {
        saw429 = true;
        retryAfter = r.retryAfter;
        expect(r.json?.error).toBe("muitas tentativas"); // mensagem do teto pré-auth (não "token inválido")
        break;
      }
      expect(r.status).toBe(401); // antes de estourar o IP, o Bearer-lixo dá 401 (auth roda)
      saw401 += 1;
    }
    expect(saw401).toBeGreaterThan(0); // houve 401s antes de o teto por IP estourar
    expect(saw429).toBe(true); // o teto pré-auth por IP barrou o martelo
    expect(retryAfter).toBeTruthy();
    expect(Number(retryAfter)).toBeGreaterThan(0);
  }, 60_000);

  // ---------- 6) /health + método ----------
  it("GET /health → 200 SEM auth", async () => {
    const r = await gw("/health");
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true });
  });

  it("método errado em rota conhecida (autenticado) → 405", async () => {
    // GET no /v1/ask COM token válido (auth passa) → 405 (a rota só aceita POST).
    const r = await gw("/v1/ask", { method: "GET", bearer: tokenVendas });
    expect(r.status).toBe(405);
    // POST no /v1/facts COM token válido → 405 (a rota só aceita GET).
    const r2 = await gw("/v1/facts", { method: "POST", bearer: tokenVendas, body: {} });
    expect(r2.status).toBe(405);
  });

  it("rota desconhecida → 404 com a lista de rotas", async () => {
    const r = await gw("/v1/nope", { bearer: tokenVendas });
    expect(r.status).toBe(404);
    expect(Array.isArray(r.json?.rotas)).toBe(true);
    expect(r.json.rotas).toContain("POST /v1/ask");
  });
});
