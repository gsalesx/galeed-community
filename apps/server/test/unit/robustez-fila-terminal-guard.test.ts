/** ROBUSTEZ DA FILA — guarda de terminal em markJobDone/markJobError (defesa em profundidade do
 *  reaper): o worker original pode terminar DEPOIS do reaper declarar o job 'dead' (lease estourado
 *  em voo) — sem a guarda o status oscilava dead→done/dead→error e o gancho ingest.organized
 *  disparava num job já dado como morto. Sem banco: db-conn mockado com sql fake que grava o texto
 *  das queries (o WHERE é o contrato) e devolve linhas controladas (0 linhas = job estava dead). */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => {
  const state = { calls: [] as { text: string; params: any[] }[], rows: [] as any[] };
  const sql: any = (strings: TemplateStringsArray, ...values: any[]) => {
    const text = strings.join("¤").replace(/\s+/g, " ").trim();
    state.calls.push({ text, params: values });
    return Promise.resolve(state.rows);
  };
  sql.json = (v: any) => ({ __json: v });
  sql.unsafe = async () => []; // DDL lazy do boot
  return {
    state,
    getSharedSql: vi.fn(async () => sql),
    sharedSqlGeneration: vi.fn(() => 1),
    emitWebhookEvent: vi.fn(async () => {}),
  };
});

vi.mock("../../src/core/platform/db-conn.ts", () => ({
  getSharedSql: h.getSharedSql,
  sharedSqlGeneration: h.sharedSqlGeneration,
  closeSharedSql: vi.fn(async () => {}),
}));
vi.mock("../../src/core/platform/webhook-emit.ts", () => ({
  emitWebhookEvent: h.emitWebhookEvent,
  scanSupersededFacts: vi.fn(async () => ({ scanned: 0, enqueued: 0 })),
}));

import { markJobDone, markJobError } from "../../src/core/ingestion/ingest-queue.ts";

beforeEach(() => {
  vi.clearAllMocks();
  h.state.calls = [];
  h.state.rows = [];
});

describe("guarda de terminal — job 'dead' não ressuscita", () => {
  it("markJobDone: WHERE exclui 'dead'; 0 linhas afetadas ⇒ ingest.organized NÃO dispara", async () => {
    h.state.rows = []; // o reaper matou o job antes — o UPDATE não acha linha
    await markJobDone("j1", { total: 1, slugs: ["s1"], skipped: 0, message: "ok" });
    const upd = h.state.calls.find((c) => c.text.includes("set status = 'done'"));
    expect(upd).toBeDefined();
    expect(upd!.text).toContain("status <> 'dead'");
    expect(h.emitWebhookEvent).not.toHaveBeenCalled(); // gancho não dispara num job morto
  });

  it("markJobDone em job vivo segue emitindo ingest.organized (comportamento preservado)", async () => {
    h.state.rows = [{ brain: "b1", result_json: {} }];
    await markJobDone("j1", { total: 2, slugs: [], skipped: 0, message: "ok" });
    expect(h.emitWebhookEvent).toHaveBeenCalledWith(
      "b1",
      "ingest.organized",
      expect.objectContaining({ batch_id: "j1", result: expect.objectContaining({ facts: 2 }) }),
    );
  });

  it("markJobError tem a MESMA guarda (dead não vira error silenciosamente)", async () => {
    await markJobError("j1", "falhou");
    const upd = h.state.calls.find((c) => c.text.includes("set status = 'error'"));
    expect(upd).toBeDefined();
    expect(upd!.text).toContain("status <> 'dead'");
  });
});
