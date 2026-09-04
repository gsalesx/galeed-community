/** M16/S1 — cliente fino da Anthropic Message Batches API via fetch (sem SDK, sem dep). Mesma auth do
 *  toolCall (anthropicHeaders). Tenant-neutro. Batch é a versão ASSÍNCRONA do /v1/messages — o `params`
 *  de cada request é o corpo que buildMessagesBody (anthropic.ts) monta. GA: sem header beta.
 *
 *  Sem backoff 429 interno: o ponto do batch é NÃO consumir o rate-limit síncrono; o poll (S4) tem seu
 *  próprio intervalo/backoff. Erro HTTP propaga (o caller decide; o fail-safe síncrono cobre o caso comum
 *  porque o roteamento já filtrou). */
import { anthropicHeaders } from "./anthropic.ts";

const BATCH_API = "https://api.anthropic.com/v1/messages/batches";

/** Um request do lote = {custom_id, params}. `params` é o corpo Messages API normal (= o que toolCall monta
 *  via buildMessagesBody). `custom_id` casa ^[a-zA-Z0-9_-]{1,64}$ e é único no lote. */
export interface BatchRequest {
  custom_id: string;
  params: Record<string, unknown>;
}

export interface BatchRequestCounts {
  processing: number;
  succeeded: number;
  errored: number;
  canceled: number;
  expired: number;
}

/** Handle do lote — espelha a resposta de POST/GET /v1/messages/batches[/{id}]. */
export interface BatchHandle {
  id: string;
  processing_status: "in_progress" | "canceling" | "ended";
  request_counts: BatchRequestCounts;
  results_url: string | null;
  created_at: string;
  expires_at: string;
}

export type BatchResult =
  | { type: "succeeded"; message: Record<string, any> }
  | { type: "errored"; error: Record<string, any> }
  | { type: "canceled" }
  | { type: "expired" };

/** Uma linha do JSONL de resultados (casar SEMPRE por custom_id — ordem não garantida). */
export interface BatchResultLine {
  custom_id: string;
  result: BatchResult;
}

/** POST /v1/messages/batches — submete os requests, devolve o handle (processing_status="in_progress"). */
export async function submitBatch(requests: BatchRequest[]): Promise<BatchHandle> {
  if (!requests.length) throw new Error("submitBatch: lote vazio");
  const res = await fetch(BATCH_API, {
    method: "POST",
    headers: anthropicHeaders(),
    body: JSON.stringify({ requests }),
  });
  if (!res.ok) throw new Error(`Batch submit ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as BatchHandle;
}

/** GET /v1/messages/batches/{id} — status atual. results_url populado quando processing_status="ended". */
export async function getBatch(id: string): Promise<BatchHandle> {
  const res = await fetch(`${BATCH_API}/${encodeURIComponent(id)}`, {
    method: "GET",
    headers: anthropicHeaders(),
  });
  if (!res.ok) throw new Error(`Batch get ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as BatchHandle;
}

/** GET handle.results_url — JSONL → BatchResultLine[]. Casar por custom_id (ordem não garantida). Lança se
 *  results_url null (lote ainda não 'ended'). Tolerante a linhas vazias. */
export async function getBatchResults(handle: BatchHandle): Promise<BatchResultLine[]> {
  if (!handle.results_url) throw new Error("getBatchResults: results_url null (lote ainda não 'ended')");
  const res = await fetch(handle.results_url, { method: "GET", headers: anthropicHeaders() });
  if (!res.ok) throw new Error(`Batch results ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const text = await res.text();
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as BatchResultLine);
}
