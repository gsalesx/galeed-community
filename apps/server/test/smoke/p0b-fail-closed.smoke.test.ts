/** P0-B (mata A5) — SMOKE fail-closed dos conectores READ/WRITE + SSRF + escopo de graph/stats.
 *  Sobe os servers REAIS (api-server, ingest-server) em porta EFÊMERA (invariante #9). Prova:
 *   (a) sem token configurado → 503 (nunca 200 anônimo); doc_url/audio_url → 410 (SSRF desligado);
 *       payload vazio → 400. NÃO precisa de DB (todas as respostas saem antes de tocar o banco).
 *   (b) token de principal escopa /api/graph e /api/stats (título-segredo NÃO vaza); admin vê tudo.
 *
 *  Fixtures sufixadas `p0b-tenant` (3 devs no mesmo banco). Env salvo/restaurado por bloco. */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { hasDb, rawConnect } from "../integration/helpers/db.ts";
import { startApiServer } from "../../src/connectors/api-server.ts";
import { startIngestServer } from "../../src/connectors/ingest-server.ts";
import { getEngine, closeEngines, type FactRow, type PageRow } from "../../src/core/platform/engine.ts";
import { createPrincipal, setGrant, issueToken } from "../../src/core/access/principals.ts";

/** sobe um server em porta efêmera e resolve a baseUrl real (lê server.address()). */
async function listen(server: Server): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  await new Promise<void>((resolve) => {
    if (server.listening) return resolve();
    server.once("listening", () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const API_503 =
  "API_TOKEN não configurado — leitura desabilitada (fail-closed). Configure API_TOKEN no ambiente ou use um token de principal (x-galeed-principal-token).";
const INGEST_503 =
  "INGEST_TOKEN não configurado — ingestão desabilitada (fail-closed). Configure INGEST_TOKEN no ambiente.";

describe("P0-B fail-closed + SSRF (sem DB)", () => {
  const saved: Record<string, string | undefined> = {};
  beforeAll(() => {
    for (const k of ["API_TOKEN", "API_PORT", "INGEST_TOKEN", "PORT"]) saved[k] = process.env[k];
  });
  afterAll(() => {
    for (const k of ["API_TOKEN", "API_PORT", "INGEST_TOKEN", "PORT"]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
  });

  it("api-server SEM API_TOKEN: /api/health 200, leituras 503", async () => {
    delete process.env.API_TOKEN;
    process.env.API_PORT = "0";
    const s = await listen(startApiServer());
    try {
      const health = await fetch(`${s.baseUrl}/api/health`);
      expect(health.status).toBe(200);

      const retr = await fetch(`${s.baseUrl}/api/retrieve?q=x`);
      expect(retr.status).toBe(503);
      expect((await retr.json()).error).toBe(API_503);

      const stats = await fetch(`${s.baseUrl}/api/stats`);
      expect(stats.status).toBe(503);
      expect((await stats.json()).error).toBe(API_503);
    } finally {
      await s.close();
    }
  });

  it("api-server COM API_TOKEN: sem header → 401", async () => {
    process.env.API_TOKEN = "p0b-tenant-admin";
    process.env.API_PORT = "0";
    const s = await listen(startApiServer());
    try {
      const r = await fetch(`${s.baseUrl}/api/stats`);
      expect(r.status).toBe(401);
    } finally {
      await s.close();
    }
  });

  it("ingest-server SEM INGEST_TOKEN: /health 200, POST /ingest 503", async () => {
    delete process.env.INGEST_TOKEN;
    process.env.PORT = "0";
    const s = await listen(startIngestServer());
    try {
      const health = await fetch(`${s.baseUrl}/health`);
      expect(health.status).toBe(200);

      const ing = await fetch(`${s.baseUrl}/ingest`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "x" }),
      });
      expect(ing.status).toBe(503);
      expect((await ing.json()).error).toBe(INGEST_503);
    } finally {
      await s.close();
    }
  });

  it("ingest-server COM INGEST_TOKEN: 401 sem header; 410 SSRF; 400 payload vazio", async () => {
    process.env.INGEST_TOKEN = "p0b-tenant-ingest";
    process.env.PORT = "0";
    const s = await listen(startIngestServer());
    const post = (body: unknown, headers: Record<string, string> = {}) =>
      fetch(`${s.baseUrl}/ingest`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
    const tok = { "x-galeed-token": "p0b-tenant-ingest" };
    try {
      // sem header → 401
      const noAuth = await post({ text: "x" });
      expect(noAuth.status).toBe(401);

      // doc_url (SSRF clássico — metadados de cloud) → 410
      const docUrl = await post({ doc_url: "http://169.254.169.254/x" }, tok);
      expect(docUrl.status).toBe(410);
      expect((await docUrl.json()).error).toContain("doc_url foi desligado");

      // audio_url → 410
      const audioUrl = await post({ audio_url: "http://localhost/a.mp3" }, tok);
      expect(audioUrl.status).toBe(410);
      expect((await audioUrl.json()).error).toContain("audio_url foi desligado");

      // payload vazio → 400 com a mensagem nova
      const empty = await post({}, tok);
      expect(empty.status).toBe(400);
      expect((await empty.json()).error).toBe("faltou text ou doc_base64 (audio_url/doc_url estão desligados até o M22)");
    } finally {
      await s.close();
    }
  });
});

const SCOPE_BRAIN = "smoke-scope-p0b-tenant";
const PRINCIPAL_ID = "agent-p0b-tenant";
const SECRET_TITLE = "SEGREDO-p0b-tenant";

async function wipeScope(): Promise<void> {
  const sql = await rawConnect();
  try {
    for (const t of ["galeed_pages", "galeed_facts", "galeed_edges", "galeed_vectors", "galeed_principals", "galeed_grants", "galeed_tokens", "galeed_access_log"]) {
      await sql.unsafe(`delete from ${t} where brain = $1`, [SCOPE_BRAIN]).catch(() => {});
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

describe.skipIf(!hasDb())("P0-B graph/stats escopados", () => {
  const saved: Record<string, string | undefined> = {};
  let tokenRaw = "";
  let s: { baseUrl: string; close: () => Promise<void> };

  beforeAll(async () => {
    for (const k of ["API_TOKEN", "API_PORT"]) saved[k] = process.env[k];
    await wipeScope();
    const e = await getEngine(SCOPE_BRAIN);

    const page = (slug: string, tags: string[], title: string): PageRow =>
      ({ slug, type: "reunioes", title, date: "2024-06-01", path: "", body: `Conteudo de ${slug}.`, content_hash: slug, tags, sensitivity: "restrito" } as PageRow);
    await e.upsertPage(page("p0b-vendas", ["area:vendas"], "p0b-vendas"));
    await e.upsertPage(page("p0b-secreta", ["area:financeiro"], SECRET_TITLE));
    // upsertPage IGNORA sensitivity (LEARNINGS M11/S3) → setSensitivity num 2º passo.
    await e.setSensitivity("p0b-vendas", "interno"); // EM escopo
    await e.setSensitivity("p0b-secreta", "restrito"); // FORA do escopo

    // 1 fato na página em escopo → factCount > 0 no nó.
    await e.putFacts([
      {
        source_slug: "p0b-vendas", type: "reunioes", dimension: "decisions", idx: 0, text: "", quote: "preco", meta: {},
        entity: "accelera", predicate: "preco", value: "R$ 30 mil", value_num: 30000, unit: "BRL", period: "monthly",
        tier: "", valid_from: "2024-06-01", valid_to: "", confidence: 0.9, status: "fato",
      } as FactRow,
    ]);

    await createPrincipal(SCOPE_BRAIN, { id: PRINCIPAL_ID, kind: "agent", label: "Agente P0B" });
    await setGrant(SCOPE_BRAIN, { principalId: PRINCIPAL_ID, areas: ["vendas"], sensitivityMax: "interno", denyTypes: [] });
    const issued = await issueToken(SCOPE_BRAIN, { principalId: PRINCIPAL_ID, label: "smoke" });
    tokenRaw = issued.token;

    process.env.API_TOKEN = "p0b-tenant-admin";
    process.env.API_PORT = "0";
    s = await listen(startApiServer());
  });

  afterAll(async () => {
    await s.close();
    await wipeScope();
    for (const k of ["API_TOKEN", "API_PORT"]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
    await closeEngines();
  });

  const url = (path: string) => `${s.baseUrl}${path}${path.includes("?") ? "&" : "?"}brain=${SCOPE_BRAIN}`;

  it("graph escopado: vê p0b-vendas, NÃO vê p0b-secreta, título-segredo não vaza", async () => {
    const r = await fetch(url("/api/graph"), { headers: { "x-galeed-principal-token": tokenRaw } });
    expect(r.status).toBe(200);
    const body = await r.json();
    const ids = (body.nodes as Array<{ id: string }>).map((n) => n.id);
    expect(ids).toContain("p0b-vendas");
    expect(ids).not.toContain("p0b-secreta");
    expect(JSON.stringify(body)).not.toContain(SECRET_TITLE);
  });

  it("stats escopado: scoped:true, pages:1, vectors omitido", async () => {
    const r = await fetch(url("/api/stats"), { headers: { "x-galeed-principal-token": tokenRaw } });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.scoped).toBe(true);
    expect(body.pages).toBe(1);
    expect(body.vectors).toBeUndefined();
  });

  it("admin (x-galeed-token) vê TUDO: grafo com p0b-secreta, stats com vectors number", async () => {
    const g = await fetch(url("/api/graph"), { headers: { "x-galeed-token": "p0b-tenant-admin" } });
    expect(g.status).toBe(200);
    const gids = ((await g.json()).nodes as Array<{ id: string }>).map((n) => n.id);
    expect(gids).toContain("p0b-secreta");

    const st = await fetch(url("/api/stats"), { headers: { "x-galeed-token": "p0b-tenant-admin" } });
    expect(st.status).toBe(200);
    const body = await st.json();
    expect(typeof body.vectors).toBe("number");
    expect(body.scoped).toBeUndefined();
  });

  it("token de principal INVÁLIDO → 401", async () => {
    const r = await fetch(url("/api/stats"), { headers: { "x-galeed-principal-token": "gal_invalido-p0b" } });
    expect(r.status).toBe(401);
    expect((await r.json()).error).toBe("principal token inválido");
  });
});
