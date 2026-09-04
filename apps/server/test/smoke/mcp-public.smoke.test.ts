/** @galeed/mcp PÚBLICO — SMOKE de INTEGRAÇÃO do GaleedClient contra o gateway VIVO (porta efêmera).
 *
 *  Prova que o cliente HTTP do pacote `apps/mcp` (ZERO DB/core — só `fetch` + Bearer) fala de verdade
 *  com a borda pública `startGatewayServer`, semeada DIRETO via engine/principals (sem LLM), EXATAMENTE
 *  como `test/smoke/gateway-v1.smoke.test.ts` faz o seed. O GaleedClient aponta pra http://127.0.0.1:PORT/v1.
 *
 *  O que cada bloco PROVA:
 *   1. client.ask(q)          → { answer:string, facts:[], withheld }      (token de leitura, escopo vendas).
 *   2. client.facts({area})   → { facts:[] } com fatos da área pedida.
 *   3. client.ingest(body)    com token WRITER (can_ingest) → 202 { batch_id }; ingestStatus(id) bate.
 *   4. client.ingest(body)    com token READER (sem can_ingest) → GaleedApiError 403 com msg clara.
 *   5. token INVÁLIDO         → GaleedApiError 401.
 *
 *  Skip se não houver Postgres (hasDb()). Determinístico: fatos via putFacts direto, sem LLM (o ask()
 *  dispara a síntese real do provider de dev — por isso os asserts de VALOR moram em facts/scope; o
 *  `answer` é só `typeof string`). Fixture sufixado `mcp-pub` (isolado dos demais smokes no mesmo banco). */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { hasDb, wipeBrain } from "../integration/helpers/db.ts";
import { startGatewayServer } from "../../src/connectors/gateway-server.ts";
import { getEngine, closeEngines, type FactRow, type PageRow } from "../../src/core/platform/engine.ts";
import { createPrincipal, setGrant, issueToken } from "../../src/core/access/principals.ts";
import { closeIngestQueue, getJob } from "../../src/core/ingestion/ingest-queue.ts";
// O CLIENTE PÚBLICO sob teste — importado direto de apps/mcp/src (TS), SEM passar pelo build.
import { GaleedClient, GaleedApiError } from "../../../../apps/mcp/src/client.ts";

// --- Fixture (nomes EXATOS, isolados por sufixo mcp-pub) ---
const BRAIN = "__smoke_mcp_pub";
const PRINCIPAL_READ = "mcp-agent-read"; // escopado SÓ à área `vendas`, SEM can_ingest (read-only)
const PRINCIPAL_WRITER = "mcp-agent-writer"; // COM can_ingest → pode escrever (/v1/ingest)

let server: Server | null = null;
let baseUrl = ""; // raiz do /v1 (ex.: http://127.0.0.1:PORT/v1) — é o que o GaleedClient consome
let tokenRead = ""; // token de leitura (escopo vendas, sem can_ingest)
let tokenWriter = ""; // token COM can_ingest

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

async function seed(): Promise<void> {
  await wipeBrain(BRAIN);

  const e = await getEngine(BRAIN);
  // área `vendas` (visível aos tokens). `interno` (≤ teto). upsertPage não grava `sensitivity` → seta explícito.
  await e.upsertPage(page("call-vendas", ["area:vendas"], "interno", "Reuniao de vendas: o preco do plano enterprise da accelera passou para R$ 30 mil por mes."));
  await e.setSensitivity("call-vendas", "interno");
  await e.putFacts([fact("call-vendas", "accelera", "R$ 30 mil", 30000)]);

  // principal de LEITURA: escopo vendas, teto interno, SEM can_ingest → 403 no /v1/ingest.
  await createPrincipal(BRAIN, { id: PRINCIPAL_READ, kind: "agent", label: "Agente Read MCP" });
  await setGrant(BRAIN, { principalId: PRINCIPAL_READ, areas: ["vendas"], sensitivityMax: "interno", denyTypes: [] });
  tokenRead = (await issueToken(BRAIN, { principalId: PRINCIPAL_READ, label: "mcp-smoke-read" })).token;

  // principal WRITER: COM can_ingest → pode ingerir (202 no /v1/ingest).
  await createPrincipal(BRAIN, { id: PRINCIPAL_WRITER, kind: "agent", label: "Agente Writer MCP" });
  await setGrant(BRAIN, { principalId: PRINCIPAL_WRITER, areas: ["vendas"], sensitivityMax: "interno", denyTypes: [], canIngest: true });
  tokenWriter = (await issueToken(BRAIN, { principalId: PRINCIPAL_WRITER, label: "mcp-smoke-writer" })).token;
}

describe.skipIf(!hasDb())("@galeed/mcp PÚBLICO smoke — GaleedClient contra o gateway vivo", () => {
  beforeAll(async () => {
    await seed();
    process.env.API_TOKEN = "god-token-estatico-NAO-DEVE-AUTENTICAR"; // a borda nunca o honra
    process.env.GATEWAY_PORT = "0"; // o OS escolhe a porta livre
    server = startGatewayServer(BRAIN);
    await new Promise<void>((resolve) => server!.once("listening", () => resolve()));
    const addr = server!.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    baseUrl = `http://127.0.0.1:${port}/v1`; // o GaleedClient recebe a RAIZ /v1 (igual o dev externo)
  });

  afterAll(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = null;
    await wipeBrain(BRAIN);
    await closeIngestQueue();
    await closeEngines();
  });

  // timeout largo: client.ask dispara síntese REAL no provider de dev (binário `claude` local) —
  // latência varia com a carga da máquina; 30s default flakava a suíte.
  it("client.ask(q) → { answer:string, facts[], withheld } (escopo vendas)", { timeout: 240_000 }, async () => {
    const client = new GaleedClient(baseUrl, tokenRead);
    const r = await client.ask("Qual o preço da accelera?");
    expect(typeof r.answer).toBe("string");
    expect(Array.isArray(r.facts)).toBe(true);
    expect(r.withheld).toBeDefined();
    // o escopo vendas enxerga `accelera`: ≥1 fato e nenhum com área `produto`.
    expect(r.facts.length).toBeGreaterThanOrEqual(1);
    expect(r.facts.every((f: any) => !(Array.isArray(f.area) && f.area.includes("produto")))).toBe(true);
  });

  it("client.facts({ area }) → { facts[] } com fatos da área pedida", async () => {
    const client = new GaleedClient(baseUrl, tokenRead);
    const r = await client.facts({ area: "vendas", status: "fact", limit: 50 });
    expect(Array.isArray(r.facts)).toBe(true);
    expect(r.facts.length).toBeGreaterThanOrEqual(1);
    for (const f of r.facts as any[]) {
      expect(f.status).toBe("fact");
      expect(Array.isArray(f.area) && f.area.includes("vendas")).toBe(true);
    }
  });

  it("client.ingest({ source, content }) com token WRITER (can_ingest) → 202 { batch_id }; ingestStatus bate", async () => {
    const client = new GaleedClient(baseUrl, tokenWriter);
    const r = await client.ingest({ source: "call_vendas", content: "Reunião de vendas: fechamos enterprise por R$ 30 mil/mês." });
    expect(typeof r.batch_id).toBe("string");
    expect(r.batch_id.length).toBeGreaterThan(0);
    expect(r.status).toBe("organizing");
    expect(r.source).toBe("call_vendas");
    expect(Number.isNaN(Date.parse(r.received_at))).toBe(false);
    // o job EXISTE na fila, no brain do token (prova ponta-a-ponta).
    const job = await getJob(BRAIN, r.batch_id);
    expect(job).toBeTruthy();
    expect(job!.brain).toBe(BRAIN);
    expect(job!.status).toBe("queued");
    // e o status público volta pelo próprio cliente.
    const st = await client.ingestStatus(r.batch_id);
    expect(st.batch_id).toBe(r.batch_id);
    expect(st.status).toBe("organizing");
  });

  it("client.ingest com token READER (sem can_ingest) → GaleedApiError 403 com mensagem clara", async () => {
    const client = new GaleedClient(baseUrl, tokenRead);
    await expect(client.ingest({ source: "call_vendas", content: "qualquer coisa" })).rejects.toMatchObject({
      name: "GaleedApiError",
      status: 403,
    });
    // a mensagem do servidor (que o MCP traduz pro agente) cita can_ingest.
    const err = await client.ingest({ source: "call_vendas", content: "x" }).catch((e) => e);
    expect(err).toBeInstanceOf(GaleedApiError);
    expect(String(err.message + err.body)).toContain("can_ingest");
  });

  it("token INVÁLIDO → GaleedApiError 401", async () => {
    const client = new GaleedClient(baseUrl, "gld_live_" + "0".repeat(64));
    const err = await client.facts({ area: "vendas" }).catch((e) => e);
    expect(err).toBeInstanceOf(GaleedApiError);
    expect(err.status).toBe(401);
    // o token cru NUNCA aparece na mensagem/corpo do erro (selo de não-vazamento).
    expect(err.message).not.toContain("0".repeat(64));
    expect(err.body).not.toContain("0".repeat(64));
  });
});
