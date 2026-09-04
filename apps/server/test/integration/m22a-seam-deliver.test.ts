/** INTEGRAÇÃO M22-A — o SEAM (deliverConnectorPayload) contra Postgres real (:5434).
 *  Brain de teste sufixado (test-m22a-seam-<unique>); Accelera = produção, NUNCA tocada.
 *
 *  Prova (gate BRIEF §5.1):
 *   - Caminho A (sem claims): blob gravado + job 'queued' carimbado com source_id; re-entrega → deduped.
 *   - Caminho B (com claims): página com tags src:/canal:/area: + fato carimbado (source_id=fonte) com
 *     valid_from ancorado na data DO EVENTO (timestamp do payload, NÃO hoje); claim FORA da receita →
 *     linha em galeed_ingest_review (fora_da_receita); re-entrega → deduped (zero duplicata).
 *   - ZERO LLM no caminho B: galeed_llm_usage do brain de teste sem NENHUMA linha (BRIEF §3/§5.2).
 *   - fonte pausada / inexistente → Error legível.
 *  No-op sem DATABASE_URL (padrão ADR-014). */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { hasDb, rawConnect, wipeBrain } from "./helpers/db.ts";
import { getEngine, closeEngines, type SourceRow } from "../../src/core/platform/engine.ts";
import { getBlobStore } from "../../src/core/ingestion/blob-store.ts";
import { getJob, closeIngestQueue } from "../../src/core/ingestion/ingest-queue.ts";
import {
  deliverConnectorPayload,
  finalizeConnectorDeliveries,
  type ConnectorPayload,
} from "../../src/core/ingestion/connector-ingest.ts";
import { createHash } from "node:crypto";

const BRAIN = `test-m22a-seam-${Math.random().toString(36).slice(2, 8)}`;
const SRC_ID = "src-m22a-seam-vendas";

const sourceRow = (extra: Partial<SourceRow> = {}): SourceRow => ({
  id: SRC_ID,
  name: "Conta Azul (vendas)",
  channel: "conta azul",
  type: "registro",
  recipe: { fields: [{ dimension: "vendas", label: "venda", area: "comercial" }] },
  default_sensitivity: "interno",
  status: "ativa",
  last_read_at: null,
  ...extra,
});

let dbOk = false;
async function ping(): Promise<boolean> {
  if (!hasDb()) return false;
  try {
    const sql = await rawConnect();
    await Promise.race([sql`select 1`, new Promise((_, r) => setTimeout(() => r(new Error("timeout")), 7000))]);
    await sql.end({ timeout: 5 });
    return true;
  } catch {
    return false;
  }
}

async function facts(): Promise<any[]> {
  const sql = await rawConnect();
  try {
    return (await sql`select * from galeed_facts where brain = ${BRAIN} order by id`) as any[];
  } finally {
    await sql.end({ timeout: 5 });
  }
}
async function reviewRows(): Promise<any[]> {
  const sql = await rawConnect();
  try {
    return (await sql`select * from galeed_ingest_review where brain = ${BRAIN} order by id`) as any[];
  } finally {
    await sql.end({ timeout: 5 });
  }
}
/** Linhas de LLM de EXTRAÇÃO/síntese (o que o BRIEF §3 promete ZERO no caminho determinístico).
 *  NÃO conta `op='embed'`: o embedding é o índice de busca semântica que a própria DESIGN-SPEC §4.2
 *  manda rodar (finalizeConnectorDeliveries → buildEmbeddings) — é a camada de retrieval, não a
 *  digestão de fatos. Ver DESVIO ANOTADO no ARTIFACTS (LEARNINGS M17/S4: código real é a verdade). */
async function extractionLlmCount(): Promise<number> {
  const sql = await rawConnect();
  try {
    const r = (await sql`
      select count(*)::int as n from galeed_llm_usage
       where brain = ${BRAIN} and op not in ('embed', 'embed:query')`) as any[];
    return Number(r[0]?.n ?? 0);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

beforeAll(async () => {
  dbOk = await ping();
  if (!dbOk) return;
  await wipeBrain(BRAIN);
  const e = await getEngine(BRAIN);
  await e.upsertSource(sourceRow());
});

afterAll(async () => {
  if (dbOk) await wipeBrain(BRAIN);
  await closeIngestQueue();
  await closeEngines();
});

describe.skipIf(!hasDb())("M22-A seam — deliverConnectorPayload", () => {
  it("caminho A (sem claims): grava blob + job queued carimbado; re-entrega → deduped", async () => {
    if (!dbOk) return;
    const payload: ConnectorPayload = {
      sourceId: SRC_ID,
      content: "E-mail de prospecção da Acme.\nRef: msg-A-001",
      contentType: "text/plain",
      timestamp: "2026-03-04T10:00:00.000Z",
      externalRef: "msg-A-001",
      title: "Prospecção Acme",
    };
    const r1 = await deliverConnectorPayload(BRAIN, payload);
    expect(r1.outcome).toBe("enqueued");
    expect(r1.jobId).toBeTruthy();

    // blob existe (pelo hash do conteúdo).
    const hash = createHash("sha256").update(Buffer.from(payload.content, "utf8")).digest("hex").slice(0, 16);
    const blob = await getBlobStore().get(BRAIN, hash);
    expect(blob).not.toBeNull();
    expect(blob!.toString("utf8")).toBe(payload.content);

    // job queued, carimbado com source_id e jobDate = data do evento.
    const job = await getJob(BRAIN, r1.jobId!);
    expect(job).not.toBeNull();
    expect(job!.status).toBe("queued");
    expect(job!.sourceId).toBe(SRC_ID);
    expect(job!.kind).toBe("file");
    expect(job!.jobDate).toBe("2026-03-04");
    expect(job!.filename).toBe("msg-A-001");

    // re-entrega do MESMO payload → deduped, mesmo jobId, zero job novo.
    const r2 = await deliverConnectorPayload(BRAIN, payload);
    expect(r2.outcome).toBe("deduped");
    expect(r2.jobId).toBe(r1.jobId);
  });

  it("caminho B (com claims): fato carimbado + valid_from ancorado no evento; fora-da-receita → review; re-entrega → deduped; ZERO LLM", async () => {
    if (!dbOk) return;
    // content COM o externalRef renderizado (contrato com B/C) e os quotes LITERAIS dos claims.
    const content = [
      "Venda registrada na Conta Azul.",
      "Cliente: Acme. Valor: 30000 BRL.",
      "Status do pedido: em aberto.",
      "Ref: venda-9001",
    ].join("\n");
    const payload: ConnectorPayload = {
      sourceId: SRC_ID,
      content,
      contentType: "text/plain",
      timestamp: "2026-01-15T09:30:00.000Z",
      externalRef: "venda-9001",
      title: "Venda Acme",
      claims: [
        {
          dimension: "vendas", // DENTRO da receita
          entity: "Acme",
          predicate: "venda",
          value: "30000 BRL",
          value_num: 30000,
          unit: "BRL",
          date: "2026-01-15",
          context_quote: "Cliente: Acme. Valor: 30000 BRL.",
          text: "Acme comprou por 30000 BRL.",
        },
        {
          dimension: "status_pedido", // FORA da receita → fila de revisão
          entity: "Acme",
          predicate: "status",
          value: "em aberto",
          date: "2026-01-15",
          context_quote: "Status do pedido: em aberto.",
          text: "Pedido da Acme em aberto.",
        },
      ],
    };

    const r1 = await deliverConnectorPayload(BRAIN, payload);
    expect(r1.outcome).toBe("claims_applied");
    expect(r1.approved).toBe(1);
    expect(r1.rejected).toBe(1);
    await finalizeConnectorDeliveries(BRAIN);

    // página criada com tags do contrato.
    const e = await getEngine(BRAIN);
    const page = await e.getPage(r1.slug!);
    expect(page).toBeTruthy();
    expect(page!.tags).toContain(`src:${SRC_ID}`);
    expect(page!.tags).toContain("canal:conta-azul");
    expect(page!.tags).toContain("area:comercial");

    // fato carimbado com source_id = fonte E valid_from ancorado na data DO EVENTO (não hoje).
    const fs = await facts();
    const vendaFact = fs.find((f) => String(f.entity).toLowerCase() === "acme" && f.predicate === "venda");
    expect(vendaFact).toBeTruthy();
    expect(vendaFact.source_id).toBe(SRC_ID);
    expect(vendaFact.valid_from).toBe("2026-01-15");
    expect(vendaFact.valid_from).not.toBe(new Date().toISOString().slice(0, 10));

    // claim fora-da-receita virou hipótese na fila com motivo certo.
    const rev = await reviewRows();
    const foraRec = rev.find((x) => x.dimension === "status_pedido");
    expect(foraRec).toBeTruthy();
    expect(foraRec.reason).toBe("fora_da_receita");
    expect(foraRec.source_id).toBe(SRC_ID);

    // ZERO LLM de EXTRAÇÃO (BRIEF §3/§5.2): o caminho determinístico não chama o LLM pra digerir o
    // record. (O único uso possível é op='embed' do índice de busca — excluído de propósito.)
    expect(await extractionLlmCount()).toBe(0);

    // re-entrega do MESMO payload → deduped, zero duplicata (mesma contagem de fatos/review/páginas).
    const factsBefore = (await facts()).length;
    const reviewBefore = (await reviewRows()).length;
    const r2 = await deliverConnectorPayload(BRAIN, payload);
    expect(r2.outcome).toBe("deduped");
    expect(r2.slug).toBe(r1.slug);
    expect((await facts()).length).toBe(factsBefore);
    expect((await reviewRows()).length).toBe(reviewBefore);
    expect(await extractionLlmCount()).toBe(0); // ainda zero LLM de extração
  });

  it("fonte pausada → Error com 'pausada' (não ingere)", async () => {
    if (!dbOk) return;
    const e = await getEngine(BRAIN);
    await e.upsertSource(sourceRow({ status: "pausada" }));
    await expect(
      deliverConnectorPayload(BRAIN, {
        sourceId: SRC_ID,
        content: "qualquer coisa",
        contentType: "text/plain",
        timestamp: "2026-01-15T00:00:00.000Z",
        externalRef: "x-1",
      }),
    ).rejects.toThrow(/pausada/);
    await e.upsertSource(sourceRow({ status: "ativa" })); // restaura
  });

  it("fonte inexistente → Error legível", async () => {
    if (!dbOk) return;
    await expect(
      deliverConnectorPayload(BRAIN, {
        sourceId: "nao-existe",
        content: "x",
        contentType: "text/plain",
        timestamp: "2026-01-15T00:00:00.000Z",
        externalRef: "x-2",
      }),
    ).rejects.toThrow(/não existe/);
  });

  it("validações de envelope (Error legível em PT)", async () => {
    if (!dbOk) return;
    const base: ConnectorPayload = {
      sourceId: SRC_ID,
      content: "ok",
      contentType: "text/plain",
      timestamp: "2026-01-15T00:00:00.000Z",
      externalRef: "ref-x",
    };
    await expect(deliverConnectorPayload(BRAIN, { ...base, content: "   " })).rejects.toThrow(/conteúdo vazio/);
    await expect(
      deliverConnectorPayload(BRAIN, { ...base, contentType: "application/pdf" as any }),
    ).rejects.toThrow(/binário não passa/);
    await expect(deliverConnectorPayload(BRAIN, { ...base, timestamp: "ontem" })).rejects.toThrow(/ISO-8601/);
    await expect(deliverConnectorPayload(BRAIN, { ...base, externalRef: "" })).rejects.toThrow(/external_ref/);
  });
});
