/** C1 — ACHADO 2 (LOOP INFINITO): no catch de erro INESPERADO de deliverOne, o worker re-enfileirava a
 *  entrega como queued+60s SEM checar o teto de retries → uma entrega-veneno (deliver que SEMPRE lança)
 *  girava pra sempre. Este teste prova a TERMINAÇÃO: simula o ciclo queued→claim(attempt+1)→lança→
 *  handleUnexpectedDeliveryError contra um FAKE engine in-memory (sem DB, sem rede) e mostra que a
 *  entrega vira 'dead' em <= maxRetries ciclos, e que o webhook é desligado (status='failed'). */
import { describe, it, expect } from "vitest";
import { handleUnexpectedDeliveryError } from "../../src/connectors/webhook-worker.ts";
import type { WebhookDeliveryRow, WebhookRow } from "../../src/core/platform/engine.ts";

/** Engine FAKE mínima: só os métodos que handleUnexpectedDeliveryError toca, com uma fila in-memory
 *  e um claim que incrementa attempt (igual ao claim real). Determinístico, sem DB. */
function makeFakeEngine(initial: WebhookDeliveryRow, hook: WebhookRow) {
  let delivery: WebhookDeliveryRow = { ...initial };
  const hookState: WebhookRow = { ...hook };
  return {
    state: () => ({ delivery, hookState }),
    // claim: pega a entrega se 'queued' e elegível; marca 'delivering' e attempt+1 (igual ao real).
    claim(): WebhookDeliveryRow | null {
      if (delivery.status !== "queued") return null;
      const nextAt = delivery.next_attempt_at ? new Date(delivery.next_attempt_at).getTime() : 0;
      if (nextAt > Date.now()) return null; // re-agendada pro futuro → não elegível AGORA
      delivery = { ...delivery, status: "delivering", attempt: delivery.attempt + 1 };
      return delivery;
    },
    async markWebhookDelivery(id: string, patch: Partial<WebhookDeliveryRow> & { error?: string; next_attempt_at?: string }) {
      if (id !== delivery.id) return;
      delivery = {
        ...delivery,
        status: (patch.status ?? delivery.status) as WebhookDeliveryRow["status"],
        next_attempt_at: patch.next_attempt_at ?? delivery.next_attempt_at,
      };
    },
    async getWebhook(id: string): Promise<WebhookRow | undefined> {
      return id === hookState.id ? hookState : undefined;
    },
    async setWebhookStatus(id: string, status: WebhookRow["status"], opts?: { failure_count?: number; last_error?: string }) {
      if (id !== hookState.id) return;
      hookState.status = status;
      if (opts?.failure_count !== undefined) hookState.failure_count = opts.failure_count;
      if (opts?.last_error !== undefined) hookState.last_error = opts.last_error;
    },
  };
}

describe("C1 webhook-worker — ACHADO 2: entrega-veneno TERMINA em dead (não loopa)", () => {
  const hook: WebhookRow = {
    id: "wh-poison",
    url: "https://hooks.cliente.com/x",
    events: ["ingest.organized"],
    secret: "s",
    label: "",
    status: "active",
    created_by: "",
    failure_count: 0,
    last_error: "",
    last_delivery_at: null,
  };
  const seed: WebhookDeliveryRow = {
    id: "del-poison",
    webhook_id: "wh-poison",
    event: "ingest.organized",
    payload: {},
    status: "queued",
    attempt: 0,
    next_attempt_at: new Date(Date.now() - 1000).toISOString(), // já elegível
    response_status: null,
    error_message: "",
    delivered_at: null,
  };

  it("um deliver que SEMPRE lança vira 'dead' em <= maxRetries ciclos (terminação garantida)", async () => {
    const maxRetries = 5;
    const fake = makeFakeEngine(seed, hook);
    const e = fake as unknown as Awaited<ReturnType<typeof import("../../src/core/platform/engine.ts").getEngine>>;

    let cycles = 0;
    const HARD_CAP = 100; // se o achado NÃO estivesse corrigido, o loop nunca terminaria → este cap estoura.
    for (; cycles < HARD_CAP; cycles++) {
      const claimed = fake.claim();
      if (!claimed) break; // entrega não mais elegível (re-agendada pro futuro) — backoff entre ciclos
      // o deliver SEMPRE lança (entrega-veneno); o worker chama o handler do catch.
      await handleUnexpectedDeliveryError("__brain", e, claimed, { maxRetries }, new Error("deliver explodiu SEMPRE"));
      const st = fake.state().delivery.status;
      if (st === "dead") break; // terminou
      // se voltou a 'queued', o handler re-agendou pro FUTURO (backoff) → torna elegível p/ o próx ciclo.
      if (st === "queued") {
        // simula o tempo passando (o backoff já venceu) p/ o próximo claim ser elegível.
        await fake.markWebhookDelivery(claimed.id, {
          status: "queued",
          next_attempt_at: new Date(Date.now() - 1000).toISOString(),
        });
      }
    }

    const final = fake.state();
    expect(cycles).toBeLessThan(HARD_CAP); // NÃO loopou pra sempre
    expect(cycles).toBeLessThanOrEqual(maxRetries); // morreu dentro do teto
    expect(final.delivery.status).toBe("dead"); // terminou em DEAD
    expect(final.hookState.status).toBe("failed"); // o webhook foi desligado
    expect(final.hookState.failure_count).toBeGreaterThanOrEqual(1);
  });

  it("antes do teto, re-enfileira como 'queued' (não morre cedo demais)", async () => {
    const fake = makeFakeEngine(seed, hook);
    const e = fake as unknown as Awaited<ReturnType<typeof import("../../src/core/platform/engine.ts").getEngine>>;
    // 1ª tentativa: attempt vai a 1 (< maxRetries=5) → deve voltar a 'queued', NÃO 'dead'.
    const claimed = fake.claim();
    expect(claimed!.attempt).toBe(1);
    await handleUnexpectedDeliveryError("__brain", e, claimed!, { maxRetries: 5 }, new Error("transitório"));
    expect(fake.state().delivery.status).toBe("queued");
    expect(fake.state().hookState.status).toBe("active"); // ainda há retries → webhook segue ativo
  });
});
