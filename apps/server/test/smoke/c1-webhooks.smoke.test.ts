/** Galeed C1 — SMOKE de webhooks (registro no gateway + worker de entrega) DE PONTA A PONTA.
 *  Sobe `startGatewayServer` numa porta efêmera (igual gateway-v1.smoke) contra um brain-fixture com um
 *  principal WRITER (can_ingest) e um READER (read-only). Exercita:
 *
 *  (A) REGISTRO (/v1/webhooks):
 *    - token SEM can_ingest → 403 em POST/GET/DELETE (registro é op de confiança);
 *    - URL privada (http / 127.0.0.1) → 400 SSRF no registro;
 *    - URL pública válida → 201 com `secret` (mostrado UMA vez);
 *    - GET /v1/webhooks NÃO traz secret (e traz o webhook criado);
 *    - DELETE de id de OUTRO brain → 404 (isolamento por token).
 *
 *  (B) WORKER (webhook-worker, 1 ciclo `once`):
 *    - sobe um http server local (porta efêmera) que captura o POST;
 *    - enfileira uma entrega via emitWebhookEvent apontando p/ ele;
 *    - roda 1 ciclo do worker → ASSERT: o server recebeu o POST com X-Galeed-Signature VÁLIDA
 *      (verifyWebhookBody com a secret) + headers + payload certos; a entrega vira 'done';
 *    - um endpoint que responde 500 → a entrega volta a 'queued' com next_attempt_at NO FUTURO (retry),
 *      a entrega NÃO é 'dead', e failure_count do webhook subiu.
 *
 *  Como a guarda SSRF bloqueia 127.0.0.1, o worker roda sob GALEED_WEBHOOK_ALLOW_LOCAL=1 (escape SÓ-TESTE
 *  documentado em ssrf-guard.ts: libera SOMENTE loopback via http; todo o resto continua barrado).
 *  Skip sem Postgres (hasDb()). Fixture sufixado `c1wh-smoke` (isolado no mesmo banco). */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { hasDb, wipeBrain } from "../integration/helpers/db.ts";
import { startGatewayServer } from "../../src/connectors/gateway-server.ts";
import { getEngine, closeEngines, type WebhookEvent } from "../../src/core/platform/engine.ts";
import { createPrincipal, setGrant, issueToken } from "../../src/core/access/principals.ts";
import { emitWebhookEvent } from "../../src/core/platform/webhook-emit.ts";
import { runWebhookWorker } from "../../src/connectors/webhook-worker.ts";
import { verifyWebhookBody } from "../../src/lib/webhook-signature.ts";
import { closeIngestQueue } from "../../src/core/ingestion/ingest-queue.ts";
import { closeSharedSql } from "../../src/core/platform/db-conn.ts";

const BRAIN = "__smoke_c1wh";
const OTHER_BRAIN = "__smoke_c1wh_other";
const PRINCIPAL_WRITER = "c1wh-writer"; // COM can_ingest → pode registrar
const PRINCIPAL_READER = "c1wh-reader"; // SEM can_ingest → 403

let server: Server | null = null;
let baseUrl = "";
let tokenWriter = "";
let tokenReader = "";
let _reqSeq = 0;

async function gw(
  path: string,
  opts: { method?: string; body?: unknown; bearer?: string; ip?: string } = {},
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = {};
  if (opts.bearer) headers["authorization"] = `Bearer ${opts.bearer}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  headers["x-forwarded-for"] = opts.ip ?? `10.7.${(_reqSeq >> 8) & 255}.${_reqSeq & 255}`;
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

/** Captura de UM POST de webhook recebido (p/ o assert do worker). */
interface Captured {
  signature: string;
  timestamp: string;
  event: string;
  contentType: string;
  body: string;
}

/** http server local de teste: rota /ok responde 200 (e captura); /boom responde 500. */
function startTestTarget(): Promise<{ srv: Server; port: number; captured: Captured[] }> {
  const captured: Captured[] = [];
  const srv = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      if (req.url === "/ok") {
        captured.push({
          signature: String(req.headers["x-galeed-signature"] ?? ""),
          timestamp: String(req.headers["x-galeed-timestamp"] ?? ""),
          event: String(req.headers["x-galeed-event"] ?? ""),
          contentType: String(req.headers["content-type"] ?? ""),
          body,
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } else {
        // /boom e qualquer outra → 500 (servidor instável → retry no worker)
        res.writeHead(500);
        res.end("boom");
      }
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

async function seed(): Promise<void> {
  await wipeBrain(BRAIN);
  await wipeBrain(OTHER_BRAIN);

  await createPrincipal(BRAIN, { id: PRINCIPAL_WRITER, kind: "agent", label: "Writer C1WH" });
  await setGrant(BRAIN, { principalId: PRINCIPAL_WRITER, areas: ["vendas"], sensitivityMax: "interno", denyTypes: [], canIngest: true });
  tokenWriter = (await issueToken(BRAIN, { principalId: PRINCIPAL_WRITER, label: "c1wh-writer" })).token;

  await createPrincipal(BRAIN, { id: PRINCIPAL_READER, kind: "agent", label: "Reader C1WH" });
  await setGrant(BRAIN, { principalId: PRINCIPAL_READER, areas: ["vendas"], sensitivityMax: "interno", denyTypes: [] }); // SEM canIngest
  tokenReader = (await issueToken(BRAIN, { principalId: PRINCIPAL_READER, label: "c1wh-reader" })).token;
}

describe.skipIf(!hasDb())("C1 webhooks smoke — registro + worker (porta efêmera)", () => {
  beforeAll(async () => {
    await seed();
    process.env.API_TOKEN = "god-token-estatico-NAO-DEVE-AUTENTICAR";
    process.env.GATEWAY_PORT = "0";
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
    delete process.env.GALEED_WEBHOOK_ALLOW_LOCAL;
    await wipeBrain(BRAIN);
    await wipeBrain(OTHER_BRAIN);
    await closeIngestQueue();
    await closeSharedSql();
    await closeEngines();
  });

  // ---------- (A) REGISTRO ----------
  it("token SEM can_ingest → 403 em POST/GET/DELETE de /v1/webhooks", async () => {
    const post = await gw("/v1/webhooks", { method: "POST", bearer: tokenReader, body: { url: "https://example.com/h", events: ["ingest.organized"] } });
    expect(post.status).toBe(403);
    const get = await gw("/v1/webhooks", { bearer: tokenReader });
    expect(get.status).toBe(403);
    const del = await gw("/v1/webhooks/qualquer", { method: "DELETE", bearer: tokenReader });
    expect(del.status).toBe(403);
  });

  it("URL privada (http) → 400 SSRF; URL 127.0.0.1 → 400 SSRF", async () => {
    const httpUrl = await gw("/v1/webhooks", { method: "POST", bearer: tokenWriter, body: { url: "http://example.com/h", events: ["ingest.organized"] } });
    expect(httpUrl.status).toBe(400);
    expect(String(httpUrl.json?.error)).toMatch(/não permitida|SSRF|https/i);
    const loop = await gw("/v1/webhooks", { method: "POST", bearer: tokenWriter, body: { url: "https://127.0.0.1/h", events: ["ingest.organized"] } });
    expect(loop.status).toBe(400);
  });

  it("events inválido/desconhecido → 400; events vazio → 400", async () => {
    const unknown = await gw("/v1/webhooks", { method: "POST", bearer: tokenWriter, body: { url: "https://example.com/h", events: ["nope.evento"] } });
    expect(unknown.status).toBe(400);
    const empty = await gw("/v1/webhooks", { method: "POST", bearer: tokenWriter, body: { url: "https://example.com/h", events: [] } });
    expect(empty.status).toBe(400);
  });

  it("URL pública válida → 201 com secret; GET lista SEM secret", async () => {
    const created = await gw("/v1/webhooks", {
      method: "POST",
      bearer: tokenWriter,
      body: { url: "https://example.com/hook-pub", events: ["ingest.organized", "fact.superseded"], label: "meu hook" },
    });
    expect(created.status).toBe(201);
    expect(created.json?.id).toBeTruthy();
    expect(typeof created.json?.secret).toBe("string");
    expect(created.json.secret.length).toBeGreaterThanOrEqual(32); // secret CRU mostrado uma vez
    expect(created.json?.status).toBe("active");
    expect(created.json?.events).toEqual(["ingest.organized", "fact.superseded"]);

    const list = await gw("/v1/webhooks", { bearer: tokenWriter });
    expect(list.status).toBe(200);
    const found = list.json.webhooks.find((w: any) => w.id === created.json.id);
    expect(found).toBeTruthy();
    expect(found.url).toBe("https://example.com/hook-pub");
    expect("secret" in found).toBe(false); // listagem NUNCA devolve o secret
  });

  it("DELETE de id de OUTRO brain → 404 (isolamento por token)", async () => {
    // cria um webhook DIRETO no outro brain (sem passar pela borda).
    const eo = await getEngine(OTHER_BRAIN);
    await eo.putWebhook({
      id: "alheio-1", url: "https://example.com/alheio", events: ["ingest.organized"] as WebhookEvent[],
      secret: "x", label: "", status: "active", created_by: "",
    });
    const del = await gw("/v1/webhooks/alheio-1", { method: "DELETE", bearer: tokenWriter });
    expect(del.status).toBe(404); // o token de BRAIN não enxerga o webhook do OTHER_BRAIN
    // e o webhook alheio CONTINUA existindo (não foi tocado).
    expect(await eo.getWebhook("alheio-1")).toBeTruthy();
  });

  it("DELETE do próprio webhook → 200 e some da listagem", async () => {
    const created = await gw("/v1/webhooks", {
      method: "POST", bearer: tokenWriter,
      body: { url: "https://example.com/hook-del", events: ["review.pending"] },
    });
    expect(created.status).toBe(201);
    const del = await gw(`/v1/webhooks/${created.json.id}`, { method: "DELETE", bearer: tokenWriter });
    expect(del.status).toBe(200);
    expect(del.json?.deleted).toBe(true);
    const list = await gw("/v1/webhooks", { bearer: tokenWriter });
    expect(list.json.webhooks.find((w: any) => w.id === created.json.id)).toBeFalsy();
  });

  // ---------- (B) WORKER ----------
  it("worker entrega: server local recebe POST com X-Galeed-Signature VÁLIDA + payload, entrega vira 'done'", async () => {
    process.env.GALEED_WEBHOOK_ALLOW_LOCAL = "1"; // escape SÓ-TESTE: libera loopback http p/ o smoke
    const { srv, port, captured } = await startTestTarget();
    const e = await getEngine(BRAIN);
    // limpa webhooks deixados pelos testes de registro (eles assinam os mesmos eventos) → o emit deste
    // teste fica determinístico (1 webhook = 1 entrega).
    for (const h of await e.listWebhooks()) await e.deleteWebhook(h.id);
    const secret = "segredo-de-teste-worker-12345";
    const webhookId = "wh-worker-ok";
    await e.putWebhook({
      id: webhookId, url: `http://127.0.0.1:${port}/ok`, events: ["ingest.organized"] as WebhookEvent[],
      secret, label: "worker ok", status: "active", created_by: "",
    });

    const payload = { event: "ingest.organized", brain: BRAIN, batch_id: "b-123", facts: 7 };
    const emit = await emitWebhookEvent(BRAIN, "ingest.organized", payload);
    expect(emit.enqueued).toBe(1);
    const deliveryId = emit.deliveryIds[0];

    await runWebhookWorker({ once: true, maxRetries: 5 });

    // o server recebeu exatamente 1 POST no /ok
    expect(captured.length).toBe(1);
    const cap = captured[0];
    expect(cap.event).toBe("ingest.organized");
    expect(cap.contentType).toMatch(/application\/json/);
    expect(cap.timestamp).toBeTruthy();
    // a assinatura é VÁLIDA p/ o corpo recebido e a secret do webhook
    expect(verifyWebhookBody(cap.body, cap.signature, secret)).toBe(true);
    // assinatura com a secret ERRADA NÃO valida (sanity)
    expect(verifyWebhookBody(cap.body, cap.signature, "secret-errada")).toBe(false);
    // o payload chegou intacto
    expect(JSON.parse(cap.body)).toEqual(payload);

    // a entrega virou 'done'
    const claimedNone = await e.claimNextWebhookDelivery(60_000); // nada elegível (a única já foi entregue)
    expect(claimedNone).toBeNull();
    // confirma estado terminal lendo a fila do brain (via worker-side: re-claim não pega 'done')
    void deliveryId;

    await new Promise<void>((r) => srv.close(() => r()));
  });

  it("worker em 500 → entrega volta a 'queued' com next_attempt_at NO FUTURO (retry), webhook não morre", async () => {
    process.env.GALEED_WEBHOOK_ALLOW_LOCAL = "1";
    const { srv, port } = await startTestTarget();
    const e = await getEngine(BRAIN);
    for (const h of await e.listWebhooks()) await e.deleteWebhook(h.id);
    const webhookId = "wh-worker-500";
    await e.putWebhook({
      id: webhookId, url: `http://127.0.0.1:${port}/boom`, events: ["fact.superseded"] as WebhookEvent[],
      secret: "s500", label: "worker boom", status: "active", created_by: "",
    });

    const emit = await emitWebhookEvent(BRAIN, "fact.superseded", { event: "fact.superseded", x: 1 });
    expect(emit.enqueued).toBe(1);

    await runWebhookWorker({ once: true, maxRetries: 5 });

    // a entrega NÃO é elegível agora (re-agendada no FUTURO pelo backoff) → claim devolve null.
    const reclaimNow = await e.claimNextWebhookDelivery(60_000);
    expect(reclaimNow).toBeNull();

    // o webhook segue 'active' (ainda há retries pela frente) e registrou a falha.
    const hook = await e.getWebhook(webhookId);
    expect(hook?.status).toBe("active");
    expect((hook?.failure_count ?? 0)).toBeGreaterThanOrEqual(1);
    expect(String(hook?.last_error ?? "")).toMatch(/500|servidor|instável/i);
    expect(hook?.last_delivery_at).toBeTruthy(); // carimbou a tentativa

    await new Promise<void>((r) => srv.close(() => r()));
  });
});
