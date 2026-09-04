/** C2 — INTEGRAÇÃO dos 3 ganchos de emissão de webhook no CORE (fase 2c-2). Prova, contra Postgres real,
 *  que cada gancho enfileira uma delivery em galeed_webhook_deliveries com o event certo e payload coerente,
 *  consumindo a infra C1 (emitWebhookEvent → fan-out por webhook active que assina o event).
 *
 *  (1) ingest.organized — gancho em markJobDone (ingest-queue.ts): enfileira um job de TEXTO, leva até
 *      'done' via markJobDone (o caminho EXATO do worker; sem LLM, determinístico) e prova 1 delivery
 *      event='ingest.organized' com payload { batch_id, result.facts, at }.
 *  (2) fact.superseded — SCAN pós-consolidação (webhook-emit.ts): semeia um fato com valid_to no passado +
 *      webhook_notified_superseded=false → scanSupersededFacts enfileira 1 delivery e marca notified;
 *      rodar de NOVO → 0 (a coluna garante o não-reemitir). Payload MÍNIMO { fact_id, entity?, predicate?,
 *      archived_at, at } — sem valores sensíveis.
 *  (3) review.pending — gancho em addReviewItemsAndNotify (golden-rule.ts): itens pendentes entram E
 *      emitem 1 delivery event='review.pending' com payload { items, by_reason, at } agregado por reason.
 *
 *  Webhook registrado DIRETO via engine (putWebhook) — não passa pela borda do gateway (escopo do outro
 *  agente). Skip sem Postgres (hasDb()). Brain-fixture isolado (sufixo único, 3 devs no mesmo banco). */
import { describe, it, expect, afterAll } from "vitest";
import { hasDb, rawConnect, wipeBrain } from "./helpers/db.ts";
import { getEngine, closeEngines, type WebhookEvent } from "../../src/core/platform/engine.ts";
import {
  enqueueIngestJob,
  markJobDone,
  closeIngestQueue,
  type IngestJobResult,
} from "../../src/core/ingestion/ingest-queue.ts";
import { scanSupersededFacts } from "../../src/core/platform/webhook-emit.ts";
import { addReviewItemsAndNotify } from "../../src/core/ingestion/golden-rule.ts";
import { closeSharedSql } from "../../src/core/platform/db-conn.ts";
import type { ReviewItemRow } from "../../src/core/platform/engine.ts";

const BRAIN = "__c2hooks";

/** Lê as deliveries enfileiradas do brain (mais novas primeiro). Leitura crua — não consome a fila. */
async function deliveriesOf(event?: string): Promise<Array<{ event: string; payload: any; status: string }>> {
  const sql = await rawConnect();
  try {
    const rows = event
      ? ((await sql.unsafe(
          `select event, payload, status from galeed_webhook_deliveries where brain = $1 and event = $2 order by created_at desc`,
          [BRAIN, event],
        )) as any[])
      : ((await sql.unsafe(
          `select event, payload, status from galeed_webhook_deliveries where brain = $1 order by created_at desc`,
          [BRAIN],
        )) as any[]);
    return rows.map((r) => ({ event: r.event, payload: r.payload, status: r.status }));
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function wipeAll(): Promise<void> {
  await wipeBrain(BRAIN);
  const sql = await rawConnect();
  try {
    await sql.unsafe(`delete from galeed_ingest_jobs where brain = $1`, [BRAIN]).catch(() => {});
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** Registra um webhook active do brain que assina TODOS os 3 eventos do core (via engine, sem a borda). */
async function registerHook(): Promise<void> {
  const e = await getEngine(BRAIN);
  for (const h of await e.listWebhooks()) await e.deleteWebhook(h.id);
  await e.putWebhook({
    id: "c2-hook",
    url: "https://example.com/c2-hook",
    events: ["ingest.organized", "review.pending", "fact.superseded"] as WebhookEvent[],
    secret: "c2-secret",
    label: "c2 hooks",
    status: "active",
    created_by: "demo@galeed.app",
  });
}

describe.skipIf(!hasDb())("C2 — ganchos de emissão de webhook no core", () => {
  afterAll(async () => {
    await wipeAll();
    await closeIngestQueue();
    await closeSharedSql();
    await closeEngines();
  });

  it("ingest.organized: job de texto até 'done' (markJobDone) → 1 delivery com payload coerente", async () => {
    await wipeAll();
    await registerHook();

    const { jobId } = await enqueueIngestJob({
      brain: BRAIN,
      kind: "text",
      type: "nota",
      title: "nota de teste",
      textBody: "conteúdo qualquer para um job de texto.",
    });

    const result: IngestJobResult = {
      total: 3,
      slugs: ["s1"],
      skipped: 1,
      message: "Entrou 1 documento (3 partes).",
    };
    await markJobDone(jobId, result); // ← caminho EXATO do worker; o gancho ingest.organized dispara aqui

    const dels = await deliveriesOf("ingest.organized");
    expect(dels.length).toBe(1);
    const d = dels[0];
    expect(d.event).toBe("ingest.organized");
    expect(d.status).toBe("queued");
    expect(d.payload.batch_id).toBe(jobId);
    expect(d.payload.result.facts).toBe(3);
    expect(typeof d.payload.at).toBe("string");
  });

  it("fact.superseded: scan emite 1 e marca notified; rodar de novo → 0 (a coluna garante)", async () => {
    await wipeAll();
    await registerHook();

    // semeia UM fato superado-no-passado (valid_to = data antiga, status='fato', notified=false default).
    const sql = await rawConnect();
    let factId: number;
    try {
      const rows = (await sql.unsafe(
        `insert into galeed_facts
           (brain, source_slug, type, dimension, idx, text, quote, entity, predicate, value,
            valid_from, valid_to, confidence, status)
         values ($1, 'p-old', 'nota', 'precos', 0, 'preço antigo', '', 'accelera', 'preco', '5000',
            '2025-01-01', '2025-06-01', 0.9, 'fato')
         returning id`,
        [BRAIN],
      )) as any[];
      factId = Number(rows[0].id);
      // sanity: nasce notified=false (default migração 35)
      const chk = (await sql.unsafe(
        `select webhook_notified_superseded from galeed_facts where id = $1`,
        [factId],
      )) as any[];
      expect(chk[0].webhook_notified_superseded).toBe(false);
    } finally {
      await sql.end({ timeout: 5 });
    }

    // 1ª passada: encontra 1, emite, marca.
    const r1 = await scanSupersededFacts(BRAIN);
    expect(r1.scanned).toBe(1);
    expect(r1.emitted).toBe(1);
    expect(r1.enqueued).toBe(1); // 1 webhook assina → 1 delivery

    const dels = await deliveriesOf("fact.superseded");
    expect(dels.length).toBe(1);
    const p = dels[0].payload;
    expect(p.fact_id).toBe(factId);
    expect(p.archived_at).toBe("2025-06-01");
    expect(p.entity).toBe("accelera");
    expect(p.predicate).toBe("preco");
    expect(typeof p.at).toBe("string");
    // payload MÍNIMO: NÃO vaza o valor sensível do fato.
    expect("value" in p).toBe(false);
    expect("text" in p).toBe(false);

    // a coluna foi marcada.
    const sql2 = await rawConnect();
    try {
      const chk = (await sql2.unsafe(
        `select webhook_notified_superseded from galeed_facts where id = $1`,
        [factId],
      )) as any[];
      expect(chk[0].webhook_notified_superseded).toBe(true);
    } finally {
      await sql2.end({ timeout: 5 });
    }

    // 2ª passada: nada novo (a coluna garante o não-reemitir).
    const r2 = await scanSupersededFacts(BRAIN);
    expect(r2.scanned).toBe(0);
    expect(r2.emitted).toBe(0);
    expect(r2.enqueued).toBe(0);
    expect((await deliveriesOf("fact.superseded")).length).toBe(1); // segue 1 (não duplicou)
  });

  it("fact.superseded: NÃO emite por fato VIGENTE (valid_to='') nem FUTURO (valid_to > hoje)", async () => {
    await wipeAll();
    await registerHook();
    const future = new Date(Date.now() + 365 * 86400_000).toISOString().slice(0, 10);
    const sql = await rawConnect();
    try {
      // vigente (valid_to='') + futuro (valid_to>hoje) — nenhum deve ser notificado.
      await sql.unsafe(
        `insert into galeed_facts (brain, source_slug, type, dimension, idx, text, quote, entity, predicate, value, valid_from, valid_to, confidence, status)
         values ($1, 'p-cur', 'nota', 'precos', 0, 'preço atual', '', 'accelera', 'preco', '30000', '2026-01-01', '', 0.9, 'fato')`,
        [BRAIN],
      );
      await sql.unsafe(
        `insert into galeed_facts (brain, source_slug, type, dimension, idx, text, quote, entity, predicate, value, valid_from, valid_to, confidence, status)
         values ($1, 'p-fut', 'nota', 'precos', 1, 'preço futuro', '', 'accelera', 'plano', 'x', '2026-01-01', $2, 0.9, 'fato')`,
        [BRAIN, future],
      );
    } finally {
      await sql.end({ timeout: 5 });
    }
    const r = await scanSupersededFacts(BRAIN);
    expect(r.scanned).toBe(0);
    expect((await deliveriesOf("fact.superseded")).length).toBe(0);
  });

  it("review.pending: itens pendentes → 1 delivery com by_reason agregado", async () => {
    await wipeAll();
    await registerHook();

    const items: ReviewItemRow[] = [
      mkItem("r1", "fora_da_receita"),
      mkItem("r2", "fora_da_receita"),
      mkItem("r3", "entidade_vaga"),
    ];
    await addReviewItemsAndNotify(BRAIN, items);

    // os itens entraram na fila (storage).
    const e = await getEngine(BRAIN);
    const pend = await e.listReview({ status: "pendente" });
    expect(pend.length).toBe(3);

    // 1 delivery review.pending com agregação por reason.
    const dels = await deliveriesOf("review.pending");
    expect(dels.length).toBe(1);
    const p = dels[0].payload;
    expect(p.items).toBe(3);
    expect(p.by_reason.fora_da_receita).toBe(2);
    expect(p.by_reason.entidade_vaga).toBe(1);
    expect(typeof p.at).toBe("string");
  });

  it("review.pending: lista vazia = no-op (nenhuma delivery, nenhum item)", async () => {
    await wipeAll();
    await registerHook();
    await addReviewItemsAndNotify(BRAIN, []);
    expect((await deliveriesOf("review.pending")).length).toBe(0);
  });
});

function mkItem(id: string, reason: ReviewItemRow["reason"]): ReviewItemRow {
  return {
    id,
    source_id: "src-1",
    source_slug: "p-rev",
    dimension: "precos",
    text: "texto do claim",
    quote: "",
    claim: { entity: "accelera", predicate: "preco", value: "5000" },
    reason,
    status: "pendente",
    decided_by: "",
    decided_at: null,
  };
}
