/** INTEGRAÇÃO M25-B — juiz triador no Postgres real (:5434), LLM MOCKADO (vi.mock em anthropic.ts +
 *  batch-client.ts, fns via vi.hoisted — LEARNINGS M18/S2). §8.4 da DESIGN-SPEC.
 *
 *  Brain m25b-juiz-int (+ wipeBrain; describe.skipIf(!hasDb())). galeed_judge_batches limpa no afterAll
 *  via SQL próprio (zona neutra do helper db.ts não cobre a tabela nova). Semeia via engine REAL.
 *  O brain accelera360-mentoria NÃO é tocado aqui (corpus de prova — gate vivo §8.5). */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { hasDb, rawConnect, wipeBrain } from "./helpers/db.ts";

// ── mocks LLM (hoisted) ──────────────────────────────────────────────────────────────────────────
const h = vi.hoisted(() => ({
  toolCall: vi.fn(),
  submitBatch: vi.fn(),
  getBatch: vi.fn(),
  getBatchResults: vi.fn(),
  recordUsage: vi.fn(),
  hasKey: vi.fn(() => true),
}));

vi.mock("../../src/lib/anthropic.ts", async (orig) => {
  const actual = (await orig()) as any;
  return { ...actual, hasKey: h.hasKey, toolCall: h.toolCall };
});
vi.mock("../../src/lib/batch-client.ts", async (orig) => {
  const actual = (await orig()) as any;
  return { ...actual, submitBatch: h.submitBatch, getBatch: h.getBatch, getBatchResults: h.getBatchResults };
});
vi.mock("../../src/core/platform/usage.ts", async (orig) => {
  const actual = (await orig()) as any;
  return { ...actual, recordUsage: h.recordUsage };
});

import {
  judgePending,
  judgeCalibration,
  getRecommendations,
  closeReviewJudge,
  type JudgeRecomendacao,
} from "../../src/core/ingestion/review-judge.ts";
import { judgeHandler } from "../../src/connectors/bff/bff-judge.ts";
import { approveReviewItem, discardReviewItem } from "../../src/core/ingestion/golden-rule.ts";
import { getEngine, closeEngines, type ReviewItemRow, type SourceRow } from "../../src/core/platform/engine.ts";

const BRAIN = "m25b-juiz-int";
const SRC = "src-int-1";

const source = (extra: Partial<SourceRow> = {}): SourceRow => ({
  id: SRC,
  name: "Calls de teste",
  channel: "upload",
  type: "reunioes",
  recipe: { fields: [{ dimension: "decisoes", label: "decisão", area: "estrategia" }] },
  default_sensitivity: "interno",
  status: "ativa",
  last_read_at: null,
  ...extra,
});

let _i = 0;
const review = (extra: Partial<ReviewItemRow> = {}): ReviewItemRow => {
  const id = extra.id ?? `it-${++_i}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    id,
    source_id: SRC,
    source_slug: "pag-int-1",
    dimension: "claims",
    text: `claim ${id}`,
    quote: "trecho da call que ancora o claim",
    claim: { text: `claim ${id}`, entity: "andre", context_quote: "trecho da call que ancora o claim" },
    reason: "fora_da_receita",
    status: "pendente",
    decided_by: "",
    decided_at: null,
    ...extra,
  };
};

async function seedBase() {
  const e = await getEngine(BRAIN);
  await e.upsertSource(source());
  await e.upsertPage({
    slug: "pag-int-1",
    type: "reunioes",
    title: "pag-int-1",
    date: "2025-09-22",
    path: "",
    body: "Eh, eu tenho lembrança do teu negócio. trecho da call que ancora o claim. André está no ramo de clínicas.",
    content_hash: "pag-int-1",
    tags: [`src:${SRC}`],
  });
}

async function batchTable(sql: any) {
  return sql.unsafe(`select * from galeed_judge_batches where brain = $1 order by submitted_at`, [BRAIN]);
}

const mockTool = (rec: JudgeRecomendacao, conf = 0.8, motivo = "motivo de teste") =>
  h.toolCall.mockImplementation(async (_m: string, _p: string, _t: any, _s: string, onUsage?: any) => {
    onUsage?.({ input_tokens: 1000, output_tokens: 50 });
    return { recomendacao: rec, motivo, confianca: conf };
  });

const batchLine = (custom_id: string, rec: JudgeRecomendacao, conf = 0.7) => ({
  custom_id,
  result: {
    type: "succeeded" as const,
    message: {
      model: "claude-haiku-4-5-20251001",
      usage: { input_tokens: 1000, output_tokens: 50 },
      content: [{ type: "tool_use", name: "recomendar_triagem", input: { recomendacao: rec, motivo: "lote", confianca: conf } }],
    },
  },
});

describe.skipIf(!hasDb())("M25-B/integração — juiz triador", () => {
  beforeEach(async () => {
    h.toolCall.mockReset();
    h.submitBatch.mockReset();
    h.getBatch.mockReset();
    h.getBatchResults.mockReset();
    h.recordUsage.mockReset();
    h.hasKey.mockReset();
    h.hasKey.mockReturnValue(true);
    await closeReviewJudge();
    await closeEngines();
    const sql = await rawConnect();
    await sql.unsafe(`delete from galeed_judge_batches where brain = $1`, [BRAIN]).catch(() => {});
    await sql.end({ timeout: 5 });
    await wipeBrain(BRAIN);
  });

  afterAll(async () => {
    const sql = await rawConnect();
    await sql.unsafe(`delete from galeed_judge_batches where brain = $1`, [BRAIN]).catch(() => {});
    await sql.end({ timeout: 5 });
    await wipeBrain(BRAIN);
    await closeReviewJudge();
    await closeEngines();
  });

  it("1. sync persiste + reviewCounts byte-idêntico (LEI 1) + status segue pendente", async () => {
    await seedBase();
    const e = await getEngine(BRAIN);
    await e.addReviewItems([review(), review(), review()]);
    const antes = await e.reviewCounts();
    mockTool("descartar", 0.8);

    const r = await judgePending(BRAIN);
    expect(r.status).toBe("concluido");
    expect(r.julgados).toBe(3);
    expect(r.distribuicao.descartar).toBe(3);

    const depois = await e.reviewCounts();
    expect(depois).toEqual(antes); // LEI 1 comportamental — nenhum status mudou
    const pend = await e.listReview({ status: "pendente", limit: 100 });
    expect(pend).toHaveLength(3);

    // colunas judge_* gravadas
    const recs = await getRecommendations(BRAIN, pend.map((p) => p.id));
    expect(Object.keys(recs)).toHaveLength(3);
    for (const id of pend.map((p) => p.id)) {
      expect(recs[id].recomendacao).toBe("descartar");
      expect(recs[id].judged_at).toBeTruthy();
    }
  });

  it("2. idempotente; force re-julga pendentes mas NÃO item decidido (LEI 2)", async () => {
    await seedBase();
    const e = await getEngine(BRAIN);
    await e.addReviewItems([review(), review(), review()]);
    mockTool("aprovar", 0.9);
    await judgePending(BRAIN);
    expect(h.toolCall).toHaveBeenCalledTimes(3);

    // segunda chamada: nada a julgar, toolCall não chamado de novo
    h.toolCall.mockClear();
    const r2 = await judgePending(BRAIN);
    expect(r2.status).toBe("nada_a_julgar");
    expect(r2.julgados).toBe(0);
    expect(h.toolCall).not.toHaveBeenCalled();

    // decide 1 item (humano), depois force: os 2 pendentes re-julgam, o decidido NÃO
    const todos = await e.listReview({ status: "pendente", limit: 100 });
    await approveReviewItem(BRAIN, todos[0].id, "dono@x.com");
    h.toolCall.mockClear();
    mockTool("descartar", 0.5);
    const r3 = await judgePending(BRAIN, { force: true });
    expect(r3.julgados).toBe(2); // só os 2 ainda pendentes
    expect(h.toolCall).toHaveBeenCalledTimes(2);
    // a recomendação do item aprovado ficou CONGELADA (a de antes do force)
    const recAprovado = await getRecommendations(BRAIN, [todos[0].id]);
    expect(recAprovado[todos[0].id].recomendacao).toBe("aprovar");
  });

  it("3. memória real: estruturais primeiro + desempate trigram; judge_memory_n = 3", async () => {
    await seedBase();
    const e = await getEngine(BRAIN);
    const sql = await rawConnect();
    // 2 decisões estruturalmente iguais (mesma dim/source/reason), texts distintos p/ desempate trigram
    const dPrecoX = review({ id: "dec-preco", dimension: "precos", reason: "fora_da_receita", text: "preço do produto X subiu" });
    const dAgenda = review({ id: "dec-agenda", dimension: "precos", reason: "fora_da_receita", text: "agenda da call de sexta" });
    const dOutra = review({ id: "dec-outra", dimension: "objecoes", reason: "nao_ancorado", text: "objecao sobre prazo" });
    await e.addReviewItems([dPrecoX, dAgenda, dOutra]);
    // marca as 3 como decididas (memória) — via engine (caminho humano real)
    await e.setReviewStatus("dec-preco", "aprovada", "dono@x.com");
    await e.setReviewStatus("dec-agenda", "aprovada", "dono@x.com");
    await e.setReviewStatus("dec-outra", "descartada", "dono@x.com");

    // item-alvo na MESMA (dim/source/reason) das estruturais, texto de preço
    const alvo = review({ id: "alvo", dimension: "precos", reason: "fora_da_receita", text: "preço do produto Y" });
    await e.addReviewItems([alvo]);

    mockTool("humano", 0.6);
    await judgePending(BRAIN);

    // judge_memory_n do alvo = 3 (as 3 decisões entraram no recall, k default 6)
    const rec = await getRecommendations(BRAIN, ["alvo"]);
    expect(rec["alvo"].memoria_n).toBe(3);

    // só "alvo" estava pendente ⇒ 1 toolCall. A de preço veio antes da de agenda no recall (trigram)
    // — checa via prompt capturado (os dois texts de memória aparecem no bloco APROVOU).
    expect(h.toolCall).toHaveBeenCalledTimes(1);
    const promptUsado: string = h.toolCall.mock.calls[0][1];
    expect(promptUsado).toContain("preço do produto X subiu");
    expect(promptUsado).toContain("agenda da call de sexta");
    expect(promptUsado.indexOf("preço do produto X subiu")).toBeLessThan(promptUsado.indexOf("agenda da call de sexta"));
    await sql.end({ timeout: 5 });
  });

  it("4. batch: submete (>50), em_andamento não re-submete, colhe ao ended; custo metade", async () => {
    await seedBase();
    const e = await getEngine(BRAIN);
    const items = Array.from({ length: 60 }, () => review());
    await e.addReviewItems(items);
    const ids = (await e.listReview({ status: "pendente", limit: 200 })).map((r) => r.id);

    h.submitBatch.mockResolvedValue({
      id: "msgbatch_test_1",
      processing_status: "in_progress",
      request_counts: { processing: 60, succeeded: 0, errored: 0, canceled: 0, expired: 0 },
      results_url: null,
      created_at: "now",
      expires_at: "later",
    });

    const r1 = await judgePending(BRAIN);
    expect(r1.status).toBe("batch_submetido");
    expect(h.submitBatch).toHaveBeenCalledTimes(1);
    const sql = await rawConnect();
    const rows1 = await batchTable(sql);
    expect(rows1).toHaveLength(1);
    expect(rows1[0].total).toBe(60);
    expect(rows1[0].status).toBe("submetido");

    // 2ª chamada: in_progress → batch_em_andamento, NÃO submete outro lote
    h.getBatch.mockResolvedValue({
      id: "msgbatch_test_1",
      processing_status: "in_progress",
      request_counts: { processing: 60, succeeded: 0, errored: 0, canceled: 0, expired: 0 },
      results_url: null,
      created_at: "now",
      expires_at: "later",
    });
    const r2 = await judgePending(BRAIN);
    expect(r2.status).toBe("batch_em_andamento");
    expect(h.submitBatch).toHaveBeenCalledTimes(1); // ainda 1

    // 3ª chamada: ended + 60 succeeded → concluido, julgados 60, lote colhido
    h.getBatch.mockResolvedValue({
      id: "msgbatch_test_1",
      processing_status: "ended",
      request_counts: { processing: 0, succeeded: 60, errored: 0, canceled: 0, expired: 0 },
      results_url: "https://x/results",
      created_at: "now",
      expires_at: "later",
    });
    h.getBatchResults.mockResolvedValue(ids.map((id) => batchLine(id, "aprovar", 0.7)));

    const r3 = await judgePending(BRAIN);
    expect(r3.status).toBe("concluido");
    expect(r3.julgados).toBe(60);
    const rows3 = await batchTable(sql);
    expect(rows3[0].status).toBe("colhido");

    // recordUsage com op judge:recommend:batch e custo = metade do cheio
    const batchUsage = h.recordUsage.mock.calls.find((c: any[]) => c[1].op === "judge:recommend:batch");
    expect(batchUsage).toBeTruthy();
    const ev = batchUsage![1];
    // custo cheio de 1000in/50out haiku = (1000*1 + 50*5)/1e6 = 0.00125; metade = 0.000625
    expect(ev.costUsdReported).toBeCloseTo(0.000625, 9);
    await sql.end({ timeout: 5 });
  });

  it("5. decidido em voo entre submit e harvest → pulados, judged_at null", async () => {
    await seedBase();
    const e = await getEngine(BRAIN);
    const items = Array.from({ length: 60 }, () => review());
    await e.addReviewItems(items);
    const ids = (await e.listReview({ status: "pendente", limit: 200 })).map((r) => r.id);

    h.submitBatch.mockResolvedValue({
      id: "msgbatch_voo", processing_status: "in_progress",
      request_counts: { processing: 60, succeeded: 0, errored: 0, canceled: 0, expired: 0 },
      results_url: null, created_at: "now", expires_at: "later",
    });
    await judgePending(BRAIN); // submete

    // humano decide 1 dos 60 ANTES do harvest
    await approveReviewItem(BRAIN, ids[0], "dono@x.com");

    h.getBatch.mockResolvedValue({
      id: "msgbatch_voo", processing_status: "ended",
      request_counts: { processing: 0, succeeded: 60, errored: 0, canceled: 0, expired: 0 },
      results_url: "https://x/r", created_at: "now", expires_at: "later",
    });
    h.getBatchResults.mockResolvedValue(ids.map((id) => batchLine(id, "descartar", 0.6)));

    const r = await judgePending(BRAIN);
    expect(r.julgados).toBe(59);
    expect(r.pulados).toBe(1);
    // o item decidido em voo NÃO ganhou recomendação retroativa (judged_at null → ausente em getRecommendations)
    const rec = await getRecommendations(BRAIN, [ids[0]]);
    expect(rec[ids[0]]).toBeUndefined();
  });

  it("6. calibração após decisões simuladas (gate do pacote)", async () => {
    await seedBase();
    const e = await getEngine(BRAIN);
    // 10 itens MESMO segmento (dimension/source/reason). 6 aprovar / 3 descartar / 1 humano.
    const aprovar = Array.from({ length: 6 }, (_, i) => review({ id: `ap-${i}` }));
    const descartar = Array.from({ length: 3 }, (_, i) => review({ id: `de-${i}` }));
    const humano = review({ id: "hu-0" });
    await e.addReviewItems([...aprovar, ...descartar, humano]);

    // recomendações por mock dirigido por id
    h.toolCall.mockImplementation(async (_m: string, prompt: string, _t: any, _s: string, onUsage?: any) => {
      onUsage?.({ input_tokens: 800, output_tokens: 40 });
      if (/hu-0/.test(prompt)) return { recomendacao: "humano", motivo: "ambíguo", confianca: 0.3 };
      if (/de-\d/.test(prompt)) return { recomendacao: "descartar", motivo: "ruído", confianca: 0.7 };
      return { recomendacao: "aprovar", motivo: "fiel", confianca: 0.9 };
    });
    await judgePending(BRAIN);

    // decisões humanas REAIS: 5 dos "aprovar" aprovados + 1 descartado; os 3 "descartar" descartados;
    // o "humano" aprovado.
    for (let i = 0; i < 5; i++) await approveReviewItem(BRAIN, `ap-${i}`, "dono@x.com");
    await discardReviewItem(BRAIN, "ap-5", "dono@x.com"); // recomendou aprovar, decidiu descartar → MISS
    for (let i = 0; i < 3; i++) await discardReviewItem(BRAIN, `de-${i}`, "dono@x.com"); // HITs
    await approveReviewItem(BRAIN, "hu-0", "dono@x.com"); // abstenção decidida

    const cal = await judgeCalibration(BRAIN);
    const seg = cal.segmentos.find((s) => s.dimension === "claims" && s.source_id === SRC);
    expect(seg).toBeTruthy();
    expect(seg!.decididos).toBe(9); // 6 aprovar + 3 descartar (humano não conta no denominador)
    expect(seg!.acertos).toBe(8);   // 5 aprovar-ok + 3 descartar-ok (ap-5 errou)
    expect(seg!.acerto).toBeCloseTo(0.8889, 4);
    expect(seg!.abstencoes).toBe(1);
    expect(cal.total.decididos).toBe(9);
    expect(cal.total.acertos).toBe(8);
    expect(cal.total.abstencoes).toBe(1);
  });

  it("7. getRecommendations: julgados mapeiam 4 campos; não-julgado ausente; [] → {}", async () => {
    await seedBase();
    const e = await getEngine(BRAIN);
    await e.addReviewItems([review({ id: "j1" }), review({ id: "j2" })]);
    mockTool("humano", 0.4, "ambíguo");
    await judgePending(BRAIN);

    const recs = await getRecommendations(BRAIN, ["j1", "j2", "nao-existe"]);
    expect(recs["j1"]).toMatchObject({ recomendacao: "humano", motivo: "ambíguo" });
    expect(recs["j1"].confianca).toBeCloseTo(0.4, 5);
    expect(typeof recs["j1"].memoria_n).toBe("number");
    expect(recs["j1"].judged_at).toBeTruthy();
    expect(recs["nao-existe"]).toBeUndefined();
    expect(await getRecommendations(BRAIN, [])).toEqual({});
  });

  it("8. borda: judgeHandler sem ANTHROPIC_API_KEY → BffError 503 PT", async () => {
    h.hasKey.mockReturnValue(false); // chave ausente
    await expect(judgeHandler(BRAIN, {})).rejects.toMatchObject({ code: 503 });
    try {
      await judgeHandler(BRAIN, {});
    } catch (err: any) {
      expect(err.message).toMatch(/ANTHROPIC_API_KEY/);
    }
  });

  it("9. migração/boot lazy idempotente: fechar e reabrir 2× sem erro", async () => {
    await seedBase();
    const e = await getEngine(BRAIN);
    await e.addReviewItems([review()]);
    mockTool("aprovar", 0.8);
    await judgePending(BRAIN);
    await closeReviewJudge();
    // reabre 2× (db() re-roda create extension/alter if exists — re-executáveis)
    const cal1 = await judgeCalibration(BRAIN);
    await closeReviewJudge();
    const cal2 = await judgeCalibration(BRAIN);
    expect(cal1).toBeTruthy();
    expect(cal2).toBeTruthy();
  });
});
