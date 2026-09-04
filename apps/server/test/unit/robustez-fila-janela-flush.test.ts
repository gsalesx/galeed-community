/** ROBUSTEZ DA FILA — flushJanelas sem banco (db-conn mockado com sql fake que grava as queries).
 *  Cobre os dois achados da janela:
 *  (1) corrida claim→DELETE: o DELETE agora é CONDICIONAL por msg_count (linha intocada ⇒ apaga;
 *      msg chegou durante a entrega ⇒ APARA só o entregue, devolve o claim e reseta first_at) —
 *      antes, o DELETE incondicional destruía a msg N+1 sem nunca ingerir;
 *  (2) GALEED_JANELA_MIN=0 DRENA o buffer (a query de claim roda com secs=0) — antes, o early-return
 *      encalhava pra sempre as mensagens já bufferizadas.
 *  O SQL real (jsonb_agg/? operator) é coberto pelo e2e; aqui valida-se o CONTRATO das queries e o
 *  fluxo de decisão (padrão vi.mock + vi.hoisted; NUNCA const top-level na factory). */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => {
  const state = {
    calls: [] as { text: string; params: any[] }[],
    claimRows: [] as any[],
    deleteCount: 1, // linhas afetadas pelo DELETE condicional (0 = msg chegou durante o flush)
  };
  const sql: any = (strings: TemplateStringsArray, ...values: any[]) => {
    const text = strings.join("¤").replace(/\s+/g, " ").trim();
    state.calls.push({ text, params: values });
    if (text.includes("set flush_claim = now()")) return Promise.resolve(state.claimRows);
    if (text.startsWith("delete from galeed_chat_janela"))
      return Promise.resolve(Object.assign([], { count: state.deleteCount }));
    return Promise.resolve(Object.assign([], { count: 1 }));
  };
  sql.json = (v: any) => ({ __json: v }); // marca a serialização única da lib (pegadinha do jsonb)
  sql.unsafe = async () => []; // DDL lazy do boot
  return {
    state,
    getSharedSql: vi.fn(async () => sql),
    sharedSqlGeneration: vi.fn(() => 1),
    deliver: vi.fn(async (..._args: any[]) => ({ outcome: "enqueued", jobId: "job-1" })),
    getIngestor: vi.fn((slug: string) => ({ slug })),
    resolveIngestorSource: vi.fn(async () => "src-1"),
  };
});

vi.mock("../../src/core/platform/db-conn.ts", () => ({
  getSharedSql: h.getSharedSql,
  sharedSqlGeneration: h.sharedSqlGeneration,
  closeSharedSql: vi.fn(async () => {}),
}));
vi.mock("../../src/core/ingestion/connector-ingest.ts", () => ({ deliverConnectorPayload: h.deliver }));
vi.mock("../../src/core/ingestion/ingestors/registry.ts", () => ({ getIngestor: h.getIngestor }));
vi.mock("../../src/core/ingestion/ingestors/deliver.ts", () => ({ resolveIngestorSource: h.resolveIngestorSource }));

import { flushJanelas } from "../../src/core/ingestion/ingestors/janela.ts";

const CFG = { silencioMin: 30, maxMsgs: 100 };
const row = () => ({
  brain: "b1",
  ingestor: "wa",
  chat_id: "chat-1",
  chat_label: "Mariana",
  mensagens: [
    { quem: "Mariana", texto: "oi", quando: "2026-07-07T12:00:00.000Z", ref: "wa:1" },
    { quem: "Você", texto: "olá!", quando: "2026-07-07T12:01:00.000Z", ref: "wa:2" },
  ],
  first_at: new Date("2026-07-07T12:00:00.000Z"),
  msg_count: 2,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.state.calls = [];
  h.state.claimRows = [];
  h.state.deleteCount = 1;
});

describe("flushJanelas — corrida claim→DELETE (achado crítico)", () => {
  it("linha intocada durante a entrega: DELETE condicional por msg_count do snapshot, sem trim", async () => {
    h.state.claimRows = [row()];
    h.state.deleteCount = 1;
    const out = await flushJanelas(CFG);
    expect(out.janelas).toBe(1);
    expect(out.mensagens).toBe(2);
    expect(out.jobs).toEqual(["job-1"]);
    const del = h.state.calls.find((c) => c.text.startsWith("delete from galeed_chat_janela"));
    expect(del).toBeDefined();
    expect(del!.text).toContain("msg_count = ¤"); // condição de versão — não é mais incondicional
    expect(del!.params).toEqual(["b1", "wa", "chat-1", 2]); // msg_count do SNAPSHOT do claim
    // ninguém escreveu ⇒ nenhum trim (jsonb_array_elements) roda
    expect(h.state.calls.some((c) => c.text.includes("jsonb_array_elements"))).toBe(false);
  });

  it("msg chegou durante o flush (DELETE afeta 0): apara SÓ o entregue, reseta first_at e devolve o claim", async () => {
    h.state.claimRows = [row()];
    h.state.deleteCount = 0; // simula o gateway appendando a msg N+1 durante o deliver
    const out = await flushJanelas(CFG);
    expect(out.janelas).toBe(1);
    expect(out.erros).toEqual([]);
    const trim = h.state.calls.find((c) => c.text.includes("jsonb_array_elements(mensagens)"));
    expect(trim).toBeDefined();
    // devolve a janela pra próxima rodada (a sobra fecha por silêncio/teto)
    expect(trim!.text).toContain("flush_claim = null");
    // first_at RESETA (menor `quando` restante, ou now()) — senão o flush da sobra repetiria o
    // externalRef e o dedupe do seam engoliria a página (perda dupla)
    expect(trim!.text).toContain("first_at = coalesce");
    // refs entregues entram via sql.json (serialização ÚNICA — interpolar JSON.stringify dupla-serializa)
    expect(trim!.params).toContainEqual({ __json: ["wa:1", "wa:2"] });
  });

  it("externalRef usa o ISO COMPLETO do first_at (sem slice de minuto — colisão em burst eliminada)", async () => {
    h.state.claimRows = [row()];
    await flushJanelas(CFG);
    expect(h.deliver).toHaveBeenCalledTimes(1);
    const payload = h.deliver.mock.calls[0][1] as any;
    expect(payload.externalRef).toBe("janela:wa:chat-1:2026-07-07T12:00:00.000Z");
  });

  it("erro na entrega devolve o claim SEM apagar nem aparar o buffer (fail-soft preservado)", async () => {
    h.state.claimRows = [row()];
    h.deliver.mockRejectedValueOnce(new Error("boom"));
    const out = await flushJanelas(CFG);
    expect(out.janelas).toBe(0);
    expect(out.erros).toHaveLength(1);
    expect(h.state.calls.some((c) => c.text.startsWith("delete from"))).toBe(false);
    expect(h.state.calls.some((c) => c.text.includes("jsonb_array_elements"))).toBe(false);
    const reset = h.state.calls.find((c) => c.text.includes("set flush_claim = null"));
    expect(reset).toBeDefined();
  });
});

describe("flushJanelas — GALEED_JANELA_MIN=0 drena o buffer (achado média)", () => {
  it("silencioMin=0 NÃO retorna cedo: a query de claim roda com secs=0 (toda janela vira vencida)", async () => {
    const out = await flushJanelas({ silencioMin: 0, maxMsgs: 100 });
    expect(out.janelas).toBe(0); // sem linhas no fake — o que importa é a query ter RODADO
    const claim = h.state.calls.find((c) => c.text.includes("set flush_claim = now()"));
    expect(claim).toBeDefined();
    expect(claim!.params[0]).toBe(0); // make_interval(secs => 0) ⇒ filtro vira last_at < now()
  });
});
