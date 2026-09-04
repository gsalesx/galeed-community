/** M16/S3 — SMOKE do batch-pipeline (roteamento sync↔batch + montagem do lote + harvest). Prova:
 *   (1) ROTEAMENTO (shouldUseBatch): matriz limiar/provider/chave/disable — fail-safe síncrono;
 *   (2) makeCustomId: determinístico, casa ^[a-zA-Z0-9_-]{1,64}$, trunca slug longo preservando unicidade;
 *   (3) buildBatchRequests: 1 request/unit worthy, customMap correto, params == buildMessagesBody do MESMO
 *       prompt/system de extractUnit (LEI II estrutural no nível de unit);
 *   (4) harvestExtractionBatch: succeeded→putExtraction+markExtracted+deriveIncremental; errored→conta e
 *       segue (erro parcial não derruba); ordena por unitIdx antes do merge.
 *
 *  A Batch API (submitBatch/getBatchResults) é MOCADA (vi.mock) — o lote REAL é do S5. O harvest roda no
 *  ENGINE REAL (Postgres :5434) p/ provar a persistência + derive. Brain descartável `__test_m16_s3`
 *  (NUNCA Accelera). Skip automático sem DATABASE_URL (espelha m16-job-batch-state.test.ts). */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { hasDb, wipeBrain } from "./helpers/db.ts";

// ── MOCK da Batch API (S1). Só getBatchResults é exercido pelo harvest; submitBatch fica disponível p/
//    completude. Os tipos passam direto (mock parcial: substituímos as 2 funções, mantemos o resto). ──
const mockGetBatchResults = vi.fn();
const mockSubmitBatch = vi.fn();
vi.mock("../../src/lib/batch-client.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/batch-client.ts")>();
  return {
    ...actual,
    submitBatch: (...a: any[]) => mockSubmitBatch(...a),
    getBatchResults: (...a: any[]) => mockGetBatchResults(...a),
  };
});

import {
  DEFAULT_BATCH_THRESHOLD,
  resolveBatchThreshold,
  shouldUseBatch,
  makeCustomId,
  buildBatchRequests,
  harvestExtractionBatch,
} from "../../src/core/ingestion/batch-extract.ts";
import { buildMessagesBody } from "../../src/lib/anthropic.ts";
import { UNTRUSTED_SYS, wrapUntrusted } from "../../src/lib/prompt-safety.ts";
import { buildExtractionContext, type ExtractionUnit } from "../../src/core/extraction/extract.ts";
import { capture } from "../../src/core/ingestion/capture.ts";
import { getEngine, type PageRow } from "../../src/core/platform/engine.ts";
import type { BatchHandle, BatchResultLine } from "../../src/lib/batch-client.ts";

const BRAIN = "__test_m16_s3";

/** handle ENDED de fachada — o mock de getBatchResults ignora o conteúdo, só precisa de um objeto. */
const ENDED_HANDLE: BatchHandle = {
  id: "msgbatch_test",
  processing_status: "ended",
  request_counts: { processing: 0, succeeded: 0, errored: 0, canceled: 0, expired: 0 },
  results_url: "https://example/results.jsonl",
  created_at: "2026-06-04T00:00:00Z",
  expires_at: "2026-07-03T00:00:00Z",
};

/** monta uma resposta Messages com 1 bloco tool_use (o shape que parseToolUse lê) p/ uma dada saída. */
function succeededMessage(input: Record<string, any[]>) {
  return {
    type: "succeeded" as const,
    message: { stop_reason: "tool_use", content: [{ type: "tool_use", name: "registrar_extracao", input }] },
  };
}

describe("M16/S3 — roteamento + montagem (puro, sem DB)", () => {
  const ENV = { ...process.env };
  beforeEach(() => {
    process.env = { ...ENV };
  });
  afterAll(() => {
    process.env = ENV;
  });

  it("resolveBatchThreshold: env > default; NaN/≤0 cai pro default; nunca lança", async () => {
    delete process.env.GALEED_BATCH_THRESHOLD;
    expect(await resolveBatchThreshold("nobrain")).toBe(DEFAULT_BATCH_THRESHOLD);
    process.env.GALEED_BATCH_THRESHOLD = "7";
    expect(await resolveBatchThreshold("nobrain")).toBe(7);
    process.env.GALEED_BATCH_THRESHOLD = "0";
    expect(await resolveBatchThreshold("nobrain")).toBe(DEFAULT_BATCH_THRESHOLD);
    process.env.GALEED_BATCH_THRESHOLD = "lixo";
    expect(await resolveBatchThreshold("nobrain")).toBe(DEFAULT_BATCH_THRESHOLD);
  });

  it("shouldUseBatch: fail-safe síncrono sem chave / com disable; nunca regride", async () => {
    // sem ANTHROPIC_API_KEY ⇒ síncrono (false) mesmo com worthy alto.
    delete process.env.ANTHROPIC_API_KEY;
    expect(await shouldUseBatch("nobrain", 9999)).toBe(false);
    // disable explícito ⇒ síncrono mesmo com chave + worthy alto.
    process.env.ANTHROPIC_API_KEY = "sk-test";
    process.env.GALEED_BATCH_DISABLE = "1";
    expect(await shouldUseBatch("nobrain", 9999)).toBe(false);
  });

  it("shouldUseBatch: provider api + chave + worthy>limiar ⇒ batch; ≤limiar ⇒ síncrono", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    delete process.env.GALEED_BATCH_DISABLE;
    process.env.GALEED_PROVIDER = "api"; // força provider api (não depende do CLI local)
    process.env.GALEED_BATCH_THRESHOLD = "10";
    expect(await shouldUseBatch("nobrain", 11)).toBe(true); // > limiar
    expect(await shouldUseBatch("nobrain", 10)).toBe(false); // == limiar (não estritamente maior)
    expect(await shouldUseBatch("nobrain", 3)).toBe(false); // < limiar
  });

  it("shouldUseBatch: provider cli ⇒ SEMPRE síncrono (Batch API só no caminho HTTP/api)", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    delete process.env.GALEED_BATCH_DISABLE;
    process.env.GALEED_PROVIDER = "cli";
    process.env.GALEED_BATCH_THRESHOLD = "1";
    expect(await shouldUseBatch("nobrain", 9999)).toBe(false);
  });

  it("makeCustomId: determinístico, casa ^[a-zA-Z0-9_-]{1,64}$, único por (slug,idx)", () => {
    const re = /^[a-zA-Z0-9_-]{1,64}$/;
    const a = makeCustomId("preco-accelera", 0);
    const b = makeCustomId("preco-accelera", 1);
    expect(a).toBe("preco-accelera__0");
    expect(re.test(a)).toBe(true);
    expect(a).not.toBe(b);
    expect(makeCustomId("preco-accelera", 0)).toBe(a); // determinístico

    // slug longo (>60) com sufixo estoura 64 → trunca + hash, mas continua casando a regex e único por idx.
    const longSlug = "x".repeat(80);
    const c0 = makeCustomId(longSlug, 0);
    const c1 = makeCustomId(longSlug, 1);
    expect(c0.length).toBeLessThanOrEqual(64);
    expect(re.test(c0)).toBe(true);
    expect(c0).not.toBe(c1);

    // char fora do alfabeto vira '-' (ainda casa a regex).
    const d = makeCustomId("a/b c.d", 2);
    expect(re.test(d)).toBe(true);
  });
});

describe.skipIf(!hasDb())("M16/S3 — buildBatchRequests + harvest (engine real, batch MOCADO)", () => {
  beforeAll(async () => {
    await wipeBrain(BRAIN);
  });
  afterAll(async () => {
    await wipeBrain(BRAIN);
  });
  beforeEach(() => {
    mockGetBatchResults.mockReset();
    mockSubmitBatch.mockReset();
  });

  /** seed: captura um texto → devolve a PageRow real (com slug/content_hash/type). */
  async function seedPage(text: string, type = "nota"): Promise<PageRow> {
    const cap = await capture({ home: BRAIN, text, type });
    const e = await getEngine(BRAIN);
    const page = await e.getPage(cap.slug);
    if (!page) throw new Error("seed falhou: página não encontrada");
    return page;
  }

  it("buildBatchRequests: 1 request/unit worthy; params == buildMessagesBody do MESMO prompt de extractUnit (LEI II)", async () => {
    const page = await seedPage("A Accelera cobra R$ 30 mil/mês no plano enterprise.", "nota");
    const ctx = await buildExtractionContext(BRAIN, page);

    // 2 units fabricadas (worthy já filtradas pelo caller — aqui simulamos o conjunto worthy).
    const units: ExtractionUnit[] = [
      { header: "Fonte: nota\n", body: "linha um", date: "", triageText: "linha um" },
      { header: "Fonte: nota\n", body: "linha dois", date: "2026-01-02", triageText: "linha dois" },
    ];

    const { requests, customMap } = await buildBatchRequests(BRAIN, [{ page, ctx, units }]);

    expect(requests).toHaveLength(2);
    // custom_id determinístico por (slug, idx) + customMap → slug.
    expect(requests[0].custom_id).toBe(makeCustomId(page.slug, 0));
    expect(requests[1].custom_id).toBe(makeCustomId(page.slug, 1));
    expect(customMap[requests[0].custom_id]).toBe(page.slug);
    expect(customMap[requests[1].custom_id]).toBe(page.slug);

    // LEI II ESTRUTURAL: o params do lote é byte-igual ao buildMessagesBody do MESMO prompt/system que
    // extractUnit (extract.ts) compõe. Reconstruímos o esperado AQUI com a mesma fórmula e comparamos.
    const expectedPrompt = `${units[0].header}${ctx.ctxBlock}${ctx.hintBlock}\n\n${wrapUntrusted(units[0].body)}`;
    const expectedSystem =
      "Você extrai conhecimento estruturado de negócios. Seja fiel ao texto; não invente. " + UNTRUSTED_SYS;
    const expectedParams = buildMessagesBody(ctx.model, expectedPrompt, ctx.tool, expectedSystem);
    expect(requests[0].params).toEqual(expectedParams);
  });

  it("harvestExtractionBatch: succeeded→persiste+deriva; errored→conta e segue (erro parcial não derruba)", async () => {
    const page = await seedPage("A Accelera tem MRR de R$ 50 mil em janeiro de 2026.", "nota");
    const e = await getEngine(BRAIN);
    const ctx = await buildExtractionContext(BRAIN, page);
    const dim = ctx.dims[0]; // primeira dimensão do schema (tenant-neutro)

    // customMap como buildBatchRequests produziria: 2 units desta página.
    const cid0 = makeCustomId(page.slug, 0);
    const cid1 = makeCustomId(page.slug, 1);
    const customMap = { [cid0]: page.slug, [cid1]: page.slug };

    // JSONL de resultados: 1 succeeded (com 1 claim ancorado p/ virar fato) + 1 errored (não derruba).
    const claim = {
      text: "MRR da Accelera é R$ 50 mil/mês",
      context_quote: "MRR de R$ 50 mil",
      entity: "accelera",
      predicate: "mrr",
      value: "R$ 50 mil",
      value_num: 50000,
      unit: "BRL",
      period: "monthly",
      valid_from: "2026-01-01",
    };
    const lines: BatchResultLine[] = [
      { custom_id: cid0, result: succeededMessage({ [dim]: [claim] }) },
      { custom_id: cid1, result: { type: "errored", error: { type: "api_error", message: "boom" } } },
    ];
    mockGetBatchResults.mockResolvedValue(lines);

    const out = await harvestExtractionBatch(BRAIN, ENDED_HANDLE, customMap);

    expect(mockGetBatchResults).toHaveBeenCalledOnce();
    expect(out.harvested).toBe(1); // 1 página tocada (a succeeded)
    expect(out.errored).toBe(1); // a linha errored contada, sem derrubar o harvest

    // PERSISTÊNCIA: a extração crua foi gravada (putExtraction) e marcada (markExtracted).
    const meta = await e.extractionMeta(page.slug);
    expect(meta?.content_hash).toBe(page.content_hash || "");

    // DERIVE: deriveIncremental rodou → o fato (entity=accelera, predicate=mrr) aparece nos fatos vigentes.
    const cur = await e.currentFacts();
    const mrr = cur.find((f) => (f.entity || "") === "accelera" && (f.predicate || "") === "mrr");
    expect(mrr, "o fato derivado do batch deve estar vigente").toBeTruthy();
  });

  it("harvestExtractionBatch: custom_id órfão (fora do customMap) é ignorado sem derrubar", async () => {
    const page = await seedPage("Accelera fechou contrato em Joinville.", "nota");
    const ctx = await buildExtractionContext(BRAIN, page);
    const dim = ctx.dims[0];
    const cid = makeCustomId(page.slug, 0);
    const customMap = { [cid]: page.slug };

    const lines: BatchResultLine[] = [
      { custom_id: cid, result: succeededMessage({ [dim]: [{ text: "Accelera em Joinville", context_quote: "Joinville", entity: "accelera", predicate: "cidade", value: "Joinville" }] }) },
      { custom_id: "fantasma__9", result: succeededMessage({ [dim]: [{ text: "lixo" }] }) }, // órfão
    ];
    mockGetBatchResults.mockResolvedValue(lines);

    const out = await harvestExtractionBatch(BRAIN, ENDED_HANDLE, customMap);
    expect(out.harvested).toBe(1); // só a página conhecida; o órfão não cria página
  });
});
