/** M16/S5 — fixtures do GATE da Batch API. Constrói os artefatos que a Batch API REAL produziria
 *  (BatchResultLine succeeded/errored + BatchHandle) p/ os casos DETERMINÍSTICOS do gate (#1 equivalência,
 *  #3 resumibilidade, #4 erro parcial). O caso de ACEITE (#2 E2E real) NÃO usa estes fakes — usa a
 *  Anthropic de verdade (invariante #9). Aqui só mocamos o que é determinístico/sem-custo. */
import type { BatchHandle, BatchResultLine } from "../../../../src/lib/batch-client.ts";

/** Monta a resposta Messages de UM request succeeded com 1 bloco tool_use cujo `input` são as dims/claims.
 *  É EXATAMENTE o shape que `parseToolUse` (S1) lê do `result.message` do lote (= o que toolCall já parseia).
 *  `claimsByDim`: dim → array de claims (objetos {text, context_quote, entity?, predicate?, value?, …}). */
export function fakeBatchResult(customId: string, claimsByDim: Record<string, any[]>): BatchResultLine {
  return {
    custom_id: customId,
    result: {
      type: "succeeded",
      message: {
        id: "msg_fake",
        type: "message",
        role: "assistant",
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "toolu_fake", name: "registrar_extracao", input: claimsByDim }],
      },
    },
  };
}

/** Uma linha `errored` (api_error) — o lote NÃO deve derrubar por causa dela (LEI: erro parcial). */
export function fakeErroredResult(customId: string): BatchResultLine {
  return {
    custom_id: customId,
    result: { type: "errored", error: { type: "api_error", message: "fixture: erro injetado de propósito" } },
  };
}

/** Um BatchHandle de fachada p/ mockar getBatch/getBatchResults. `status` controla o caminho do poller:
 *  "ended" → harvest ; "in_progress" → próximo tick. `results_url` só importa pro getBatch real (mocado). */
export function fakeHandle(opts: { status?: BatchHandle["processing_status"]; results_url?: string | null; id?: string } = {}): BatchHandle {
  const status = opts.status ?? "ended";
  return {
    id: opts.id ?? "msgbatch_fixture",
    processing_status: status,
    request_counts: { processing: 0, succeeded: 0, errored: 0, canceled: 0, expired: 0 },
    results_url: opts.results_url !== undefined ? opts.results_url : status === "ended" ? "https://example/results.jsonl" : null,
    created_at: "2026-06-04T00:00:00Z",
    expires_at: "2026-07-03T00:00:00Z",
  };
}

/** Serializa um conjunto de BatchResultLine como JSONL (uma linha por request, ordem QUALQUER — o harvest
 *  casa por custom_id). Espelha o corpo bruto que a Anthropic devolve no `results_url`. */
export function toJsonl(lines: BatchResultLine[]): string {
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}
