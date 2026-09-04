/** INTEGRAÇÃO M22-A — nangoWebhookHandler (handler PURO) contra Postgres real (:5434).
 *  Brain de teste sufixado; deps.listRecords mockado com records no shape OFICIAL.
 *
 *  Contrato oficial (invariante #9 — fixtures byte-a-byte, consulta 2026-06-12):
 *   - webhook (sync/auth): https://nango.dev/docs/implementation-guides/platform/webhooks-from-nango
 *   - GET /records (_nango_metadata): https://nango.dev/docs/reference/api/sync/records-list
 *
 *  Prova (gate BRIEF §5.1):
 *   - sem NANGO_WEBHOOK_SECRET → 503; assinatura inválida → 401; JSON inválido → 400;
 *   - sync válido + handler registrado → records entregues no seam, cursor gravado, 200 com contagens;
 *   - fonte pausada → 409 e cursor INTACTO; conexão sem fonte / sem handler / auth de terceiro → 200 {ignored};
 *   - auth 'creation' com tags {source_id, brain} → connection_id gravado;
 *   - re-entrega do mesmo webhook (mesmos records) → 200 e zero duplicata.
 *  No-op sem DATABASE_URL. */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { hasDb, rawConnect, wipeBrain } from "./helpers/db.ts";
import { getEngine, closeEngines, type SourceRow } from "../../src/core/platform/engine.ts";
import { closeIngestQueue } from "../../src/core/ingestion/ingest-queue.ts";
import {
  clearConnectorHandlers,
  registerConnectorHandler,
  setSourceConnection,
  getSourceConnection,
  type ConnectorHandler,
} from "../../src/core/ingestion/connector-ingest.ts";
import { nangoWebhookHandler } from "../../src/connectors/bff/bff-connectors.ts";
import type { NangoRecord as LibNangoRecord } from "../../src/lib/nango.ts";

const BRAIN = `test-m22a-seam-${Math.random().toString(36).slice(2, 8)}`;
const SRC_ID = "src-m22a-seam-wh";
const CONN = "conn-m22a-seam-wh";
const PCK = "conta-azul";
const SECRET = "whsec_m22a-seam-wh";

const sourceRow = (extra: Partial<SourceRow> = {}): SourceRow => ({
  id: SRC_ID,
  name: "Conta Azul (webhook)",
  channel: "conta azul",
  type: "registro",
  recipe: { fields: [{ dimension: "vendas", label: "venda", area: "comercial" }] },
  default_sensitivity: "interno",
  status: "ativa",
  last_read_at: null,
  ...extra,
});

/** handler de TESTE: normaliza um record sintético em 1 payload com 1 claim DENTRO da receita. */
const testHandler: ConnectorHandler = {
  providerConfigKey: PCK,
  sourceSeed: () => ({
    name: "Conta Azul (webhook)",
    channel: "conta azul",
    type: "registro",
    recipe: { fields: [{ dimension: "vendas", label: "venda", area: "comercial" }] },
  }),
  normalize: (record: LibNangoRecord, ctx): any[] => {
    const cliente = String((record as any).cliente ?? "");
    const valor = Number((record as any).valor ?? 0);
    const content = [`Venda na Conta Azul.`, `Cliente: ${cliente}. Valor: ${valor} BRL.`, `Ref: ${(record as any).id}`].join("\n");
    return [
      {
        sourceId: ctx.sourceId,
        content,
        contentType: "text/plain",
        timestamp: String((record as any).data ?? "2026-02-01") + "T00:00:00.000Z",
        externalRef: String((record as any).id),
        title: `Venda ${cliente}`,
        claims: [
          {
            dimension: "vendas",
            entity: cliente,
            predicate: "venda",
            value: `${valor} BRL`,
            value_num: valor,
            unit: "BRL",
            date: String((record as any).data ?? "2026-02-01"),
            context_quote: `Cliente: ${cliente}. Valor: ${valor} BRL.`,
            text: `${cliente} comprou por ${valor} BRL.`,
          },
        ],
      },
    ];
  },
};

/** records no shape OFICIAL (§2.2 — com _nango_metadata). */
function record(id: string, cliente: string, valor: number, data: string): LibNangoRecord {
  return {
    id,
    cliente,
    valor,
    data,
    _nango_metadata: {
      deleted_at: null,
      last_action: "ADDED",
      first_seen_at: `${data}T00:00:00.000Z`,
      last_modified_at: `${data}T00:00:00.000Z`,
      cursor: `cursor-${id}`,
    },
  };
}

function syncBody(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "sync",
    connectionId: CONN,
    providerConfigKey: PCK,
    syncName: "vendas",
    model: "Venda",
    syncType: "INCREMENTAL",
    success: true,
    modifiedAfter: "2026-02-01T00:00:00.000Z",
    responseResults: { added: 2, updated: 0, deleted: 0 },
    ...extra,
  });
}
function authBody(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "auth",
    operation: "creation",
    connectionId: CONN,
    authMode: "OAUTH2",
    providerConfigKey: PCK,
    provider: "conta-azul",
    environment: "PROD",
    success: true,
    tags: { source_id: SRC_ID, brain: BRAIN },
    ...extra,
  });
}
function hmac(body: string, secret = SECRET): Record<string, string> {
  return { "x-nango-hmac-sha256": createHmac("sha256", secret).update(Buffer.from(body, "utf8")).digest("hex") };
}

/** mock de listRecords: pagina como o Nango REAL — página 1 traz os records + um next_cursor
 *  (cursor de retomada); página 2 (chamada com esse cursor) vem vazia + next_cursor null (fim). Assim
 *  o loop do handler avança o cursor e grava em connector_state (§4.7). */
function mockListRecords(records: LibNangoRecord[]) {
  return async (opts: { cursor?: string }) => {
    if (opts.cursor) return { records: [], nextCursor: null as string | null };
    return { records, nextCursor: "cursor-after-last" as string | null };
  };
}

async function facts(): Promise<any[]> {
  const sql = await rawConnect();
  try {
    return (await sql`select * from galeed_facts where brain = ${BRAIN}`) as any[];
  } finally {
    await sql.end({ timeout: 5 });
  }
}

let dbOk = false;
const prevSecret = process.env.NANGO_WEBHOOK_SECRET;

beforeAll(async () => {
  if (!hasDb()) return;
  try {
    const sql = await rawConnect();
    await sql`select 1`;
    await sql.end({ timeout: 5 });
    dbOk = true;
  } catch {
    dbOk = false;
    return;
  }
  await wipeBrain(BRAIN);
  const e = await getEngine(BRAIN);
  await e.upsertSource(sourceRow());
  await setSourceConnection(BRAIN, SRC_ID, CONN, PCK); // conexão mapeada (auth webhook já rodou)
});

beforeEach(() => {
  process.env.NANGO_WEBHOOK_SECRET = SECRET;
  clearConnectorHandlers();
});
afterEach(() => {
  if (prevSecret === undefined) delete process.env.NANGO_WEBHOOK_SECRET;
  else process.env.NANGO_WEBHOOK_SECRET = prevSecret;
});

afterAll(async () => {
  if (dbOk) await wipeBrain(BRAIN);
  clearConnectorHandlers();
  await closeIngestQueue();
  await closeEngines();
});

describe.skipIf(!hasDb())("M22-A seam — nangoWebhookHandler", () => {
  it("sem NANGO_WEBHOOK_SECRET → 503 (fail-closed)", async () => {
    if (!dbOk) return;
    delete process.env.NANGO_WEBHOOK_SECRET;
    const out = await nangoWebhookHandler(syncBody(), hmac(syncBody()));
    expect(out.status).toBe(503);
  });

  it("assinatura inválida (secret errada) → 401", async () => {
    if (!dbOk) return;
    const body = syncBody();
    const out = await nangoWebhookHandler(body, hmac(body, "secret-errada"));
    expect(out.status).toBe(401);
  });

  it("JSON inválido (mas assinado certo) → 400", async () => {
    if (!dbOk) return;
    const bad = "{ não é json";
    const out = await nangoWebhookHandler(bad, hmac(bad));
    expect(out.status).toBe(400);
  });

  it("sync válido + handler registrado → records entregues, cursor gravado, 200 com contagens", async () => {
    if (!dbOk) return;
    registerConnectorHandler(testHandler);
    const recs = [record("v-1", "Acme", 30000, "2026-02-01"), record("v-2", "Beta", 12000, "2026-02-02")];
    const body = syncBody();
    const out = await nangoWebhookHandler(body, hmac(body), { listRecords: mockListRecords(recs) });

    expect(out.status).toBe(200);
    const b = out.body as any;
    expect(b.ok).toBe(true);
    expect(b.claims_applied).toBe(2);

    // cursor gravado em connector_state (último cursor visto).
    const conn = await getSourceConnection(BRAIN, SRC_ID);
    expect(conn?.state.cursor).toBeTruthy();
    expect(conn?.state.last_sync_at).toBeTruthy();
    expect(conn?.state.last_error ?? "").toBe("");

    // fatos carimbados com a fonte, valid_from na data do evento.
    const fs = await facts();
    const acme = fs.find((f) => String(f.entity).toLowerCase() === "acme" && f.predicate === "venda");
    expect(acme).toBeTruthy();
    expect(acme.source_id).toBe(SRC_ID);
    expect(acme.valid_from).toBe("2026-02-01");
  });

  it("re-entrega do mesmo delta (cursor NÃO avançou — retry pós-crash) → 200 e zero duplicata (idempotência por hash)", async () => {
    if (!dbOk) return;
    registerConnectorHandler(testHandler);
    // Simula o cenário da §4.7: o cursor NÃO avançou (crash antes do update) → o Nango re-entrega o
    // MESMO delta. Reseto o cursor pra que listRecords devolva os MESMOS records de novo.
    await setSourceConnection(BRAIN, SRC_ID, CONN, PCK);
    const { updateConnectorState } = await import("../../src/core/ingestion/connector-ingest.ts");
    await updateConnectorState(BRAIN, SRC_ID, { cursor: "" });
    const recs = [record("v-1", "Acme", 30000, "2026-02-01"), record("v-2", "Beta", 12000, "2026-02-02")];
    const body = syncBody();
    const before = (await facts()).length;
    const out = await nangoWebhookHandler(body, hmac(body), { listRecords: mockListRecords(recs) });
    expect(out.status).toBe(200);
    expect((out.body as any).deduped).toBe(2); // ambos já entregues no teste anterior → dedup por hash
    expect((out.body as any).claims_applied).toBe(0); // zero re-aplicação de claim
    expect((await facts()).length).toBe(before); // zero duplicata
  });

  it("fonte pausada → 409 e cursor INTACTO (nada ingerido)", async () => {
    if (!dbOk) return;
    registerConnectorHandler(testHandler);
    const e = await getEngine(BRAIN);
    const cursorBefore = (await getSourceConnection(BRAIN, SRC_ID))?.state.cursor;
    await e.upsertSource(sourceRow({ status: "pausada" }));
    const body = syncBody();
    const out = await nangoWebhookHandler(body, hmac(body), {
      listRecords: mockListRecords([record("v-99", "Gama", 5000, "2026-03-01")]),
    });
    expect(out.status).toBe(409);
    expect((out.body as any).error).toMatch(/pausada/);
    expect((await getSourceConnection(BRAIN, SRC_ID))?.state.cursor).toBe(cursorBefore); // intacto
    await e.upsertSource(sourceRow({ status: "ativa" })); // restaura
  });

  it("conexão sem fonte mapeada → 200 {ignored}", async () => {
    if (!dbOk) return;
    registerConnectorHandler(testHandler);
    const body = syncBody({ connectionId: "conn-desconhecida" });
    const out = await nangoWebhookHandler(body, hmac(body), { listRecords: mockListRecords([]) });
    expect(out.status).toBe(200);
    expect((out.body as any).ignored).toBe(true);
  });

  it("sem handler registrado → 200 {ignored, reason}", async () => {
    if (!dbOk) return;
    clearConnectorHandlers(); // nenhum handler
    const body = syncBody();
    const out = await nangoWebhookHandler(body, hmac(body), { listRecords: mockListRecords([]) });
    expect(out.status).toBe(200);
    expect((out.body as any).ignored).toBe(true);
    expect((out.body as any).reason).toMatch(/handler/);
  });

  it("auth de terceiro (sem tags) → 200 {ignored}", async () => {
    if (!dbOk) return;
    const body = authBody({ tags: {} });
    const out = await nangoWebhookHandler(body, hmac(body));
    expect(out.status).toBe(200);
    expect((out.body as any).ignored).toBe(true);
  });

  it("auth 'creation' com tags {source_id, brain} → connection_id gravado", async () => {
    if (!dbOk) return;
    // zera a conexão e prova que o auth webhook a (re)grava.
    await setSourceConnection(BRAIN, SRC_ID, "", "");
    const newConn = "conn-novo-via-auth";
    const body = authBody({ connectionId: newConn });
    const out = await nangoWebhookHandler(body, hmac(body));
    expect(out.status).toBe(200);
    expect((out.body as any).ok).toBe(true);
    const conn = await getSourceConnection(BRAIN, SRC_ID);
    expect(conn?.connectionId).toBe(newConn);
    expect(conn?.providerConfigKey).toBe(PCK);
    await setSourceConnection(BRAIN, SRC_ID, CONN, PCK); // restaura p/ outros testes
  });

  it("sync success=false → 200 {ignored} e last_error registrado", async () => {
    if (!dbOk) return;
    const body = syncBody({ success: false });
    const out = await nangoWebhookHandler(body, hmac(body));
    expect(out.status).toBe(200);
    expect((out.body as any).ignored).toBe(true);
    const conn = await getSourceConnection(BRAIN, SRC_ID);
    expect(conn?.state.last_error).toMatch(/falhou/);
  });
});
