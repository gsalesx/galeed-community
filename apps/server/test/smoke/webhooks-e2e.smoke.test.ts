/** Galeed — WEBHOOKS E2E (fase 2) PONTA-A-PONTA: gateway numa porta efêmera + um SERVIDOR HTTP DE
 *  TESTE local que CAPTURA os POSTs entregues. Diferente do c1-webhooks.smoke (que enfileira via
 *  emitWebhookEvent direto e registra o webhook no store), aqui TODO o caminho público é exercitado por
 *  HTTP de verdade — o cliente faz `POST /v1/webhooks` na borda, recebe o `secret`, dispara o gancho por
 *  uma operação real, o WORKER entrega async, e o servidor de teste recebe o POST assinado. É a prova de
 *  que a CADEIA inteira fecha: registro (borda) → gancho (op de negócio) → fila → worker → entrega HMAC.
 *
 *  O que cada bloco PROVA (ponta-a-ponta, sem atalho):
 *   1. REGISTRO via HTTP: `POST /v1/webhooks` (token can_ingest) → 201 com `secret` (mostrado UMA vez).
 *      O webhook assina ["ingest.organized","access.denied"] e aponta p/ o servidor de teste (loopback).
 *   2. ingest.organized E2E: `POST /v1/ingest` (HTTP) → batch_id → leva o job a `done` (markJobDone, o
 *      MESMO ponto que o worker síncrono usa) → o gancho emite `ingest.organized`. Roda 1 ciclo do
 *      worker → o servidor de teste RECEBEU o POST com X-Galeed-Signature VÁLIDA (verifyWebhookBody com
 *      o secret guardado do passo 1) + payload coerente { batch_id, result:{facts}, at }.
 *   3. access.denied E2E (NEGAÇÃO TOTAL): `GET /v1/facts` (HTTP) com um token escopado a área SEM fatos.
 *      ESTA é a rota de leitura que produz uma negação TOTAL gateway-side: factsHandler busca o universo
 *      INTEIRO de decisions (NÃO-escopado no motor) e o applyScope da borda barra TUDO → kept===0 &&
 *      withheld>0 → gancho emite `access.denied`. (O /v1/ask NÃO serve a esta prova: askHandler aplica o
 *      escopo DENTRO da recuperação do motor — um token de área vazia volta nada a esconder, withheld===0,
 *      e a borda NUNCA emite. A regra do fundador é kept===0 && withheld>0; só /v1/facts a satisfaz numa
 *      leitura.) Worker entrega → o servidor de teste recebe o POST assinado + payload mínimo
 *      { principal_id, reason, route, at }, reason "fora_de_escopo", route "/v1/facts". HMAC válido.
 *   4. PARCIAL não dispara: `GET /v1/facts` com o token de vendas (vê vendas, esconde produto = withheld
 *      PARCIAL, kept>0) → worker → o servidor de teste NÃO recebe NENHUM POST (decisão do fundador:
 *      access.denied só em negação TOTAL; parcial seria ruído e vazaria a existência de censurado).
 *
 *  SSRF: a guarda anti-SSRF (corretamente) barra 127.0.0.1; o worker roda sob GALEED_WEBHOOK_ALLOW_LOCAL=1
 *  (escape SÓ-TESTE de ssrf-guard.ts: libera SOMENTE loopback via http; todo o resto segue barrado). O
 *  REGISTRO via HTTP precisa do mesmo escape (o `POST /v1/webhooks` valida a URL no ato) → setamos o flag
 *  ANTES de subir o gateway. Skip sem Postgres (hasDb()). Fixture sufixado `whe2e` (isolado no banco). */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { hasDb, wipeBrain } from "../integration/helpers/db.ts";
import { startGatewayServer } from "../../src/connectors/gateway-server.ts";
import { getEngine, closeEngines, type FactRow, type PageRow } from "../../src/core/platform/engine.ts";
import { createPrincipal, setGrant, issueToken } from "../../src/core/access/principals.ts";
import { markJobDone, closeIngestQueue } from "../../src/core/ingestion/ingest-queue.ts";
import { runWebhookWorker } from "../../src/connectors/webhook-worker.ts";
import { verifyWebhookBody } from "../../src/lib/webhook-signature.ts";
import { closeSharedSql } from "../../src/core/platform/db-conn.ts";

const BRAIN = "__smoke_whe2e";
const PRINCIPAL_WRITER = "whe2e-writer"; // can_ingest → registra webhook + ingere
const PRINCIPAL_VENDAS = "whe2e-vendas"; // escopado a `vendas` → leitura PARCIAL (vê vendas, esconde produto)
const PRINCIPAL_DENIED = "whe2e-denied"; // escopado a `juridico` (área SEM fatos) → leitura = negação TOTAL

let server: Server | null = null;
let baseUrl = "";
let tokenWriter = "";
let tokenVendas = "";
let tokenDenied = "";
let webhookSecret = ""; // o secret CRU devolvido pelo POST /v1/webhooks (passo 1) — usado p/ verificar HMAC
let webhookId = "";
let _reqSeq = 0;

/** fetch tipado contra a borda. XFF único por request (cai num balde pré-auth próprio → o teto por IP
 *  da borda fica ativo mas a suíte não tromba nele). `ip` pina um IP fixo quando preciso (não usado aqui). */
async function gw(
  path: string,
  opts: { method?: string; body?: unknown; bearer?: string; ip?: string } = {},
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = {};
  if (opts.bearer) headers["authorization"] = `Bearer ${opts.bearer}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  headers["x-forwarded-for"] = opts.ip ?? `10.9.${(_reqSeq >> 8) & 255}.${_reqSeq & 255}`;
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
  return { status: res.status, json };
}

/** Um POST de webhook recebido pelo servidor de teste (o que o cliente real veria). */
interface Captured {
  path: string;
  signature: string;
  timestamp: string;
  event: string;
  delivery: string;
  contentType: string;
  body: string;
}

/** SERVIDOR HTTP DE TESTE (loopback, porta efêmera): captura TODO POST recebido e responde 200. É o
 *  "endpoint do cliente". O worker do Galeed entrega aqui (sob GALEED_WEBHOOK_ALLOW_LOCAL=1). */
function startTestTarget(): Promise<{ srv: Server; port: number; captured: Captured[] }> {
  const captured: Captured[] = [];
  const srv = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      captured.push({
        path: req.url || "",
        signature: String(req.headers["x-galeed-signature"] ?? ""),
        timestamp: String(req.headers["x-galeed-timestamp"] ?? ""),
        event: String(req.headers["x-galeed-event"] ?? ""),
        delivery: String(req.headers["x-galeed-delivery"] ?? ""),
        contentType: String(req.headers["content-type"] ?? ""),
        body: Buffer.concat(chunks).toString("utf8"),
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ srv, port, captured });
    });
  });
}

/** página-fonte do fixture (a tag carrega a área; sensibilidade governa o teto). */
const page = (slug: string, tags: string[], sensitivity: string, body: string): PageRow =>
  ({ slug, type: "reunioes", title: slug, date: "2024-06-01", path: "", body, content_hash: slug, tags, sensitivity } as PageRow);

/** fato tipado ancorado numa página-fonte. */
const fact = (slug: string, entity: string, value: string, vn: number): FactRow =>
  ({
    source_slug: slug, type: "reunioes", dimension: "decisions", idx: 0, text: "", quote: `${value}/mês`, meta: {},
    entity, predicate: "preco", value, value_num: vn, unit: "BRL", period: "monthly", tier: "enterprise",
    valid_from: "2024-06-01", valid_to: "", confidence: 0.9, status: "fato",
  } as FactRow);

async function seed(): Promise<void> {
  await wipeBrain(BRAIN);
  const e = await getEngine(BRAIN);
  // DUAS áreas: vendas (visível ao token de vendas) e produto (fora do escopo de vendas → withheld
  // PARCIAL). Ambas `interno` (≤ teto). setSensitivity explícito (upsertPage default = restrito).
  await e.upsertPage(page("call-vendas", ["area:vendas"], "interno", "Reuniao de vendas: o preco do enterprise da accelera passou para R$ 30 mil por mes."));
  await e.upsertPage(page("call-produto", ["area:produto"], "interno", "Roadmap de produto: o preco do modulo gama subiu para R$ 12 mil por mes."));
  await e.setSensitivity("call-vendas", "interno");
  await e.setSensitivity("call-produto", "interno");
  await e.putFacts([
    fact("call-vendas", "accelera", "R$ 30 mil", 30000),
    fact("call-produto", "gama", "R$ 12 mil", 12000),
  ]);

  // WRITER (can_ingest): registra o webhook e ingere. Escopo de vendas só p/ ter um grant válido.
  await createPrincipal(BRAIN, { id: PRINCIPAL_WRITER, kind: "agent", label: "Writer E2E" });
  await setGrant(BRAIN, { principalId: PRINCIPAL_WRITER, areas: ["vendas"], sensitivityMax: "interno", denyTypes: [], canIngest: true });
  tokenWriter = (await issueToken(BRAIN, { principalId: PRINCIPAL_WRITER, label: "whe2e-writer" })).token;

  // VENDAS: escopado a `vendas` → /v1/ask vê vendas E esconde produto = withheld PARCIAL (kept>0). NÃO dispara.
  await createPrincipal(BRAIN, { id: PRINCIPAL_VENDAS, kind: "agent", label: "Vendas E2E" });
  await setGrant(BRAIN, { principalId: PRINCIPAL_VENDAS, areas: ["vendas"], sensitivityMax: "interno", denyTypes: [] });
  tokenVendas = (await issueToken(BRAIN, { principalId: PRINCIPAL_VENDAS, label: "whe2e-vendas" })).token;

  // DENIED: escopado a `juridico` (área SEM nenhum fato). O motor recupera o universo e o escopo barra
  // TUDO → kept===0 && withheld>0 = NEGAÇÃO TOTAL → dispara access.denied.
  await createPrincipal(BRAIN, { id: PRINCIPAL_DENIED, kind: "agent", label: "Denied E2E" });
  await setGrant(BRAIN, { principalId: PRINCIPAL_DENIED, areas: ["juridico"], sensitivityMax: "interno", denyTypes: [] });
  tokenDenied = (await issueToken(BRAIN, { principalId: PRINCIPAL_DENIED, label: "whe2e-denied" })).token;
}

describe.skipIf(!hasDb())("WEBHOOKS E2E smoke — gateway + servidor de teste local (ponta-a-ponta)", () => {
  let target: { srv: Server; port: number; captured: Captured[] };

  beforeAll(async () => {
    // ESCAPE SÓ-TESTE: libera o loopback http p/ a guarda SSRF (no REGISTRO via HTTP e na ENTREGA do
    // worker). Sem isto o POST /v1/webhooks rejeitaria 127.0.0.1 (400) e o worker marcaria dead.
    process.env.GALEED_WEBHOOK_ALLOW_LOCAL = "1";
    await seed();
    target = await startTestTarget();
    process.env.API_TOKEN = "god-token-estatico-NAO-DEVE-AUTENTICAR";
    process.env.GATEWAY_PORT = "0"; // o OS escolhe a porta livre
    process.env.TRUST_PROXY = "1"; // a borda lê o RIGHTMOST do X-Forwarded-For (XFF único por request)
    server = startGatewayServer(BRAIN);
    await new Promise<void>((resolve) => server!.once("listening", () => resolve()));
    const addr = server!.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = null;
    if (target) await new Promise<void>((r) => target.srv.close(() => r()));
    delete process.env.GALEED_WEBHOOK_ALLOW_LOCAL;
    await wipeBrain(BRAIN);
    await closeIngestQueue();
    await closeSharedSql();
    await closeEngines();
  });

  // ---------- 1) REGISTRO via HTTP: POST /v1/webhooks → 201 com secret ----------
  it("(1) POST /v1/webhooks (can_ingest) → 201 com secret; aponta p/ o servidor de teste; assina ingest.organized+access.denied", async () => {
    const r = await gw("/v1/webhooks", {
      method: "POST",
      bearer: tokenWriter,
      body: {
        url: `http://127.0.0.1:${target.port}/galeed-hook`,
        events: ["ingest.organized", "access.denied"],
        label: "e2e hook",
      },
    });
    expect(r.status).toBe(201);
    expect(typeof r.json?.id).toBe("string");
    expect(typeof r.json?.secret).toBe("string");
    expect(r.json.secret.length).toBeGreaterThanOrEqual(32); // secret CRU mostrado UMA vez
    expect(r.json?.status).toBe("active");
    expect(r.json?.events).toEqual(["ingest.organized", "access.denied"]);
    // guarda o secret p/ verificar a assinatura das entregas (passos 2 e 3) — é o que o cliente faria.
    webhookSecret = r.json.secret;
    webhookId = r.json.id;
  });

  // ---------- 2) ingest.organized E2E: /v1/ingest → done → worker → POST assinado ----------
  it("(2) POST /v1/ingest → done → worker entrega ingest.organized ao servidor de teste com X-Galeed-Signature VÁLIDA", async () => {
    expect(webhookSecret).toBeTruthy(); // depende do passo 1
    const before = target.captured.length;

    // (a) ingere de verdade pela borda pública: 202 com batch_id.
    const ing = await gw("/v1/ingest", {
      method: "POST",
      bearer: tokenWriter,
      body: { source: "call_vendas", content: "Reunião de vendas: fechamos o enterprise por R$ 30 mil/mês." },
    });
    expect(ing.status).toBe(202);
    const batchId = ing.json.batch_id;
    expect(typeof batchId).toBe("string");
    expect(ing.json.status).toBe("organizing");

    // (b) leva o job a `done` pelo MESMO ponto que o worker síncrono usa (markJobDone) → o gancho
    //     ingest.organized emite (fan-out → fila de entrega). Não rodamos o pipeline de extração real
    //     (caro/LLM); markJobDone é o ponto de emissão apurado (ingest-queue.ts:283).
    await markJobDone(batchId, { total: 5, slugs: ["a", "b", "c", "d", "e"], skipped: 0, message: "Entrou 1 documento (5 partes)." });

    // (c) roda 1 ciclo do worker (entrega async). Sob GALEED_WEBHOOK_ALLOW_LOCAL=1 o loopback é liberado.
    await runWebhookWorker({ once: true, maxRetries: 5 });

    // (d) o servidor de teste RECEBEU exatamente 1 POST novo, no path certo, evento ingest.organized.
    const got = target.captured.slice(before);
    const organized = got.filter((c) => c.event === "ingest.organized");
    expect(organized.length).toBe(1);
    const cap = organized[0];
    expect(cap.path).toBe("/galeed-hook");
    expect(cap.contentType).toMatch(/application\/json/);
    expect(cap.timestamp).toBeTruthy();
    expect(cap.delivery).toBeTruthy();

    // (e) X-Galeed-Signature VÁLIDA p/ o corpo recebido + o secret guardado no passo 1 (verifyWebhookBody).
    expect(verifyWebhookBody(cap.body, cap.signature, webhookSecret)).toBe(true);
    // sanity negativa: a MESMA assinatura NÃO valida com o secret errado (a verificação é real).
    expect(verifyWebhookBody(cap.body, cap.signature, "secret-errado-qualquer")).toBe(false);
    // e o corpo adulterado quebra a verificação (a assinatura cobre o body EXATO).
    expect(verifyWebhookBody(cap.body + "x", cap.signature, webhookSecret)).toBe(false);

    // (f) o payload é coerente com o gancho ingest.organized (ingest-queue.ts:307): { batch_id, result:{facts}, at }.
    const payload = JSON.parse(cap.body);
    expect(payload.batch_id).toBe(batchId);
    expect(payload.result).toMatchObject({ facts: 5 });
    expect(typeof payload.at).toBe("string");
    expect(Number.isNaN(Date.parse(payload.at))).toBe(false); // `at` é ISO válido
  });

  // ---------- 3) access.denied E2E (NEGAÇÃO TOTAL): /v1/facts vazio por escopo → worker → POST assinado ----------
  it("(3) GET /v1/facts com token escopado a área SEM fatos (negação TOTAL) → worker entrega access.denied assinado", async () => {
    expect(webhookSecret).toBeTruthy();
    const before = target.captured.length;

    // token escopado a `juridico` (sem fatos): /v1/facts busca o universo INTEIRO de decisions e o
    // applyScope da borda barra TUDO → kept===0 && withheld>0 = NEGAÇÃO TOTAL. A resposta volta facts:[].
    const r = await gw("/v1/facts?area=produto&limit=200", { bearer: tokenDenied });
    expect(r.status).toBe(200);
    expect(Array.isArray(r.json.facts)).toBe(true);
    expect(r.json.facts.length).toBe(0); // a leitura voltou VAZIA por ESCOPO (tudo barrado)

    // o gancho da borda é fire-and-forget (o INSERT da entrega chega após a resposta HTTP). Roda alguns
    // ciclos do worker (com micro-espera) até o servidor de teste ver a entrega access.denied.
    await drainWorkerUntil(() => target.captured.slice(before).some((c) => c.event === "access.denied"));

    const got = target.captured.slice(before);
    const denied = got.filter((c) => c.event === "access.denied");
    expect(denied.length).toBe(1); // exatamente 1 access.denied entregue
    const cap = denied[0];
    expect(cap.path).toBe("/galeed-hook");

    // assinatura VÁLIDA com o MESMO secret guardado no passo 1.
    expect(verifyWebhookBody(cap.body, cap.signature, webhookSecret)).toBe(true);

    // payload MÍNIMO (decisão do fundador): só { principal_id, reason, route, at } — nenhum valor sensível.
    const payload = JSON.parse(cap.body);
    expect(payload.principal_id).toBe(PRINCIPAL_DENIED);
    expect(payload.reason).toBe("fora_de_escopo");
    expect(payload.route).toBe("/v1/facts");
    expect(typeof payload.at).toBe("string");
    expect(Number.isNaN(Date.parse(payload.at))).toBe(false);
    expect(Object.keys(payload).sort()).toEqual(["at", "principal_id", "reason", "route"]);
  });

  // ---------- 4) PARCIAL NÃO dispara: /v1/facts vê vendas + esconde produto → NENHUM access.denied ----------
  it("(4) GET /v1/facts com token de vendas (retorno PARCIAL: vê vendas, esconde produto) → NENHUM access.denied", async () => {
    const before = target.captured.length;

    // tokenVendas: o universo tem fatos de vendas (kept>0) E de produto (withheld>0) → PARCIAL. O gancho
    // SÓ dispara em negação TOTAL (kept===0) → nada deve ser entregue (não-ruído, não vaza censurado).
    const r = await gw("/v1/facts?limit=200", { bearer: tokenVendas });
    expect(r.status).toBe(200);
    expect(r.json.facts.length).toBeGreaterThan(0); // viu vendas → kept>0
    expect(r.json.facts.every((f: any) => !f.area.includes("produto"))).toBe(true); // escondeu produto

    // roda vários ciclos do worker (dando tempo p/ qualquer entrega indevida sair) e confirma: ZERO POSTs.
    for (let i = 0; i < 5; i++) {
      await runWebhookWorker({ once: true, maxRetries: 5 });
      await new Promise((r) => setTimeout(r, 20));
    }
    const got = target.captured.slice(before);
    expect(got.length).toBe(0); // withheld PARCIAL JAMAIS gera entrega de webhook
  });
});

/** Roda ciclos do worker (até ~25, com micro-espera entre eles) até `pred()` ficar true ou esgotar. O
 *  gancho da borda emite fire-and-forget → o INSERT da entrega pode chegar DEPOIS da resposta HTTP;
 *  poll-amos sem mascarar excesso (o assert do caso ainda conta exatamente as entregas). */
async function drainWorkerUntil(pred: () => boolean): Promise<void> {
  for (let i = 0; i < 25; i++) {
    await runWebhookWorker({ once: true, maxRetries: 5 });
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
}
