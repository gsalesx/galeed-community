/** Galeed C1 — HELPER de emissão de eventos de webhook (fan-out → fila de entrega async).
 *
 *  emitWebhookEvent(brain, event, payload): lista os webhooks ACTIVE do brain que assinam `event` e
 *  enfileira UMA entrega (status='queued') por webhook. O WORKER (webhook-worker.ts) é quem entrega de
 *  fato (claim → assina → POST → retry/backoff). Aqui só o fan-out síncrono pra fila.
 *
 *  CONTRATO FAIL-SOFT (regra do fundador): a emissão NUNCA lança pro chamador. Os ganchos que chamam
 *  isto (C2) rodam no caminho-quente do produto (ingestão organizada, fato superado, review pendente,
 *  acesso negado) — uma falha de webhook (DB fora, brain sem store) JAMAIS pode derrubar a operação de
 *  negócio. Tudo em try/catch + console.error; retorno é só observabilidade (quantas entregas saíram).
 *
 *  Os 4 eventos v1 (WebhookEvent): ingest.organized | review.pending | fact.superseded | access.denied.
 *  Aqui o helper é AGNÓSTICO ao evento — só repassa. A SEMÂNTICA de quando/onde chamar é do C2. */
import { getEngine, type WebhookEvent } from "./engine.ts";
import { getSharedSql } from "./db-conn.ts";

export interface EmitResult {
  enqueued: number;          // quantas entregas foram enfileiradas (0 = ninguém assina / fail-soft)
  webhooks: number;          // quantos webhooks active assinam o evento
  deliveryIds: string[];     // ids das entregas criadas (observabilidade/teste)
}

/** Enfileira a entrega de `event` (com `payload`) para CADA webhook active do `brain` que o assina.
 *  FAIL-SOFT: nunca lança. Erro → loga no stderr e devolve o que conseguiu (parcial). */
export async function emitWebhookEvent(
  brain: string,
  event: WebhookEvent,
  payload: unknown,
): Promise<EmitResult> {
  const result: EmitResult = { enqueued: 0, webhooks: 0, deliveryIds: [] };
  try {
    const e = await getEngine(brain);
    // só os webhooks ACTIVE que assinam ESTE evento (filtro no store: status=active + event=any(events)).
    const hooks = await e.listWebhooks({ event, status: "active" });
    result.webhooks = hooks.length;
    for (const h of hooks) {
      try {
        const id = await e.enqueueWebhookDelivery({
          webhook_id: h.id,
          event,
          payload,
          // next_attempt_at omitido → default now() no store (entregável já neste tick do worker).
        });
        result.deliveryIds.push(id);
        result.enqueued += 1;
      } catch (err) {
        // uma entrega que não enfileira (ex.: violação de constraint) não impede as outras.
        console.error(
          `[webhook-emit] falha ao enfileirar entrega brain=${brain} event=${event} webhook=${h.id}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  } catch (err) {
    // fail-soft TOTAL: listar webhooks / abrir engine falhou → loga e segue. NUNCA lança pro chamador.
    console.error(
      `[webhook-emit] emissão falhou (fail-soft) brain=${brain} event=${event}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
  return result;
}

// ---------------------------------------------------------------------------------------------------
// C2 — SCAN de fact.superseded (gancho 3). Roda no ponto de CONSOLIDAÇÃO pós-job (consolidateAfterJob
// no ingest-worker), DEPOIS que a derivação bitemporal (applyBitemporal → replaceFactsForSourcesAndGroups,
// indexer.ts) gravou `valid_to` nos fatos que perderam a vigência. NÃO calcula supersessão — só observa o
// efeito já persistido e notifica UMA vez por fato.
//
// CONVENÇÃO bitemporal do schema (galeed_facts.valid_to é TEXT): "" / null = VIGENTE (verdade atual);
// uma data não-vazia = fato SUPERADO/arquivado naquela data (valid-time fim). Um fato "superado e no
// passado" é, portanto, valid_to <> '' AND valid_to <= hoje.
//
// ANTI-REEMISSÃO (a coluna garante): galeed_facts.webhook_notified_superseded (migração 35, default false).
// O scan só pega fatos com webhook_notified_superseded=false e, ANTES de emitir, marca true — então rodar
// de novo dá 0. O re-derive (delete+insert de replaceFactsForSourcesAndGroups) reseta a coluna pro default
// false: é o comportamento desejado (um fato que volta a ser reescrito é re-observado uma vez; em estado
// estável, nunca re-emite).
//
// FAIL-SOFT por contrato (igual emitWebhookEvent / recordUsage): NUNCA lança pro chamador. Erro → loga e
// devolve o que conseguiu. BOUNDED por LIMIT (GALEED_SUPERSEDED_SCAN_LIMIT, default 200) — uma passada do
// scan nunca varre o brain inteiro; o resto sai na próxima consolidação (idempotente).

/** Limite (bounded) de fatos superados notificados POR passada. Default cobre o caso comum; uma fila
 *  maior é PARCIAL e drena nas consolidações seguintes (a coluna garante que não re-notifica os já vistos). */
const SUPERSEDED_SCAN_LIMIT = Math.max(
  1,
  Number(process.env.GALEED_SUPERSEDED_SCAN_LIMIT || "") || 200,
);

export interface SupersededScanResult {
  scanned: number;   // fatos superados+no-passado ainda não notificados encontrados nesta passada (≤ LIMIT)
  emitted: number;   // quantos geraram emitWebhookEvent (= scanned; cada fato emite 1 evento fact.superseded)
  enqueued: number;  // total de entregas enfileiradas (soma do fan-out por webhook de cada fato)
}

/** C2 — SCAN bounded + brain-scoped dos fatos SUPERADOS no passado ainda NÃO notificados. Para cada um,
 *  emite `fact.superseded` (payload MÍNIMO: ids/datas, sem valores sensíveis) e marca
 *  webhook_notified_superseded=true (ANTES não — a marca é DEPOIS do emit; mas o emit é fail-soft e o
 *  worker é quem entrega, então o pior caso é uma entrega enfileirada e a marca aplicada na MESMA passada).
 *  FAIL-SOFT: NUNCA lança. Chamado no ponto de consolidação pós-job (ingest-worker.consolidateAfterJob). */
export async function scanSupersededFacts(brain: string): Promise<SupersededScanResult> {
  const result: SupersededScanResult = { scanned: 0, emitted: 0, enqueued: 0 };
  try {
    const sql = await getSharedSql();
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (mesmo formato de valid_to/job_date)
    // BOUNDED + brain-scoped: status='fato' (não arquivados-por-status / nao-verificado), valid_to NÃO
    // vazio e ≤ hoje (superado E no passado), ainda NÃO notificado. Mais antigos primeiro (drena estável).
    const rows = (await sql`
      select id, entity, predicate, valid_to
        from galeed_facts
       where brain = ${brain}
         and webhook_notified_superseded = false
         and status = 'fato'
         and valid_to is not null
         and valid_to <> ''
         and valid_to <= ${today}
       order by valid_to asc, id asc
       limit ${SUPERSEDED_SCAN_LIMIT}`) as any[];
    result.scanned = rows.length;
    if (!rows.length) return result;

    const at = new Date().toISOString();
    const markedIds: number[] = [];
    for (const r of rows) {
      const factId = Number(r.id);
      // payload MÍNIMO (regra do fundador): ids/datas, NUNCA o valor sensível do fato.
      const payload: Record<string, unknown> = {
        fact_id: factId,
        archived_at: r.valid_to,
        at,
      };
      if (r.entity) payload.entity = r.entity;       // entidade/predicado são metadados (não o valor) —
      if (r.predicate) payload.predicate = r.predicate; // dão contexto sem vazar o conteúdo superado.
      const emit = await emitWebhookEvent(brain, "fact.superseded", payload);
      result.emitted += 1;
      result.enqueued += emit.enqueued;
      markedIds.push(factId);
    }
    // marca DEPOIS do emit (a coluna garante o não-reemitir). UM UPDATE pro lote inteiro (= any($ids)).
    if (markedIds.length) {
      await sql`
        update galeed_facts
           set webhook_notified_superseded = true
         where brain = ${brain}
           and id = any(${markedIds})`;
    }
  } catch (err) {
    // fail-soft TOTAL: o scan NUNCA derruba a consolidação/ingestão. Loga e devolve o parcial.
    console.error(
      `[webhook-emit] scan de fact.superseded falhou (fail-soft) brain=${brain}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
  return result;
}
