/** M16/S5 · Gate #1 — EQUIVALÊNCIA batch≡sync (deep-equal). A PROVA CENTRAL da LEI II:
 *  o que o LOTE extrai = o que o caminho SÍNCRONO extrairia. Batch é otimização de ENTREGA, não muda a
 *  verdade. Determinístico e SEM custo (o LLM é STUBADO pelo MESMO oráculo nos dois caminhos):
 *
 *   - SÍNCRONO: `extractOne` (que chama `extractUnit`→`structured`) com `structured` STUBADO devolvendo
 *     claims determinísticos POR UNIT (chaveado pelo corpo da unit). Persiste via putExtraction → deriva.
 *   - BATCH: `buildBatchRequests` nas MESMAS units → p/ cada request, uma `BatchResultLine` succeeded cujo
 *     `message.content[0].tool_use.input` são EXATAMENTE os claims que o stub síncrono devolveria pra aquela
 *     unit (casado por custom_id → unitIdx → corpo da unit). `harvestExtractionBatch` com esse JSONL fake.
 *
 *  Assert: `deepEqual(currentFacts batch, currentFacts sync)` — mesmas dims, mesmos claims, mesma ordem.
 *  Se divergir: o builder do lote OU o harvest divergiu do sync (prompt/merge/ordem) → reabre S3 (blocked).
 *
 *  Engine REAL (Postgres :5434), 2 brains descartáveis (`__test_m16_s5_eq_sync` / `…_batch`). NUNCA Accelera.
 *  Skip automático sem DATABASE_URL. */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { hasDb, wipeBrain } from "./helpers/db.ts";
import { fakeBatchResult, fakeHandle } from "./helpers/batch-fixtures/index.ts";

// ── STUB do LLM (a costura única). `structured` (llm.ts) é o que `extractUnit` chama no caminho síncrono.
//    Devolve claims determinísticos POR UNIT, chaveados pelo trecho do corpo (que vai no prompt). O MESMO
//    oráculo é usado p/ fabricar os resultados do lote → a fonte de verdade é idêntica nos dois caminhos. ──
//    (a Batch API não passa por aqui — o harvest lê o JSONL fake; só o sync chama `structured`.)
const ORACLE = new Map<string, Record<string, any[]>>();
const mockStructured = vi.fn(async (o: { prompt: string }) => {
  // casa pelo corpo da unit que aparece no prompt (cada unit tem um marcador único "UNIT#<n>").
  for (const [marker, claims] of ORACLE) if (o.prompt.includes(marker)) return claims;
  return {}; // unit sem oráculo → sem claims (não deveria acontecer no teste)
});
vi.mock("../../src/lib/llm.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/llm.ts")>();
  return { ...actual, structured: (...a: any[]) => mockStructured(a[0]) };
});

// ── MOCK só de getBatchResults (S1) — o harvest lê o JSONL fake. submitBatch NÃO é exercido aqui. ──
const mockGetBatchResults = vi.fn();
vi.mock("../../src/lib/batch-client.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/batch-client.ts")>();
  return { ...actual, getBatchResults: (...a: any[]) => mockGetBatchResults(...a) };
});

import { capture } from "../../src/core/ingestion/capture.ts";
import { getEngine, type PageRow, type FactHit } from "../../src/core/platform/engine.ts";
import { extractOne, buildExtractionContext, buildExtractionUnits } from "../../src/core/extraction/extract.ts";
import { deriveIncremental } from "../../src/core/retrieval/indexer.ts";
import { buildBatchRequests, harvestExtractionBatch, makeCustomId } from "../../src/core/ingestion/batch-extract.ts";

const SYNC = "__test_m16_s5_eq_sync";
const BATCH = "__test_m16_s5_eq_batch";

/** normaliza um FactHit p/ deep-equal estável: drop de campos voláteis (slug/quote derivados da fonte)
 *  e ordena por uma chave canônica. O que importa pra LEI II: dimension + claim (entity/predicate/value/…).
 *  source_slug difere de propósito (brains diferentes) → fora da comparação. */
function canonFacts(facts: FactHit[]) {
  return facts
    .map((f) => ({
      dimension: f.dimension,
      text: f.text,
      entity: f.entity ?? null,
      predicate: f.predicate ?? null,
      value: f.value ?? null,
      value_num: f.value_num ?? null,
      unit: f.unit ?? null,
      period: f.period ?? null,
      tier: f.tier ?? null,
      valid_from: f.valid_from ?? null,
      valid_to: f.valid_to ?? null,
      status: f.status ?? null,
    }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

describe.skipIf(!hasDb())("M16/S5 · Gate #1 — equivalência batch≡sync (deep-equal)", () => {
  let pages: PageRow[] = [];

  beforeAll(async () => {
    await wipeBrain(SYNC);
    await wipeBrain(BATCH);
    // mesmas fontes nos dois brains (mesmo texto → mesmo slug/content_hash determinístico).
    const texts = [
      "UNIT#A A Accelera cobra R$ 30 mil/mes no plano enterprise a partir de janeiro de 2026.",
      "UNIT#B A Accelera tem MRR de R$ 50 mil em janeiro de 2026 e status ativo.",
      "UNIT#C A Accelera fechou um contrato grande em Joinville no comeco do ano.",
    ];
    pages = [];
    for (const t of texts) {
      const capSync = await capture({ home: SYNC, text: t, type: "nota" });
      await capture({ home: BATCH, text: t, type: "nota" });
      const e = await getEngine(SYNC);
      const p = await e.getPage(capSync.slug);
      if (!p) throw new Error("seed falhou");
      pages.push(p);
    }
    // oráculo: claims determinísticos por unit (chaveado pelo marcador UNIT#X do corpo).
    // dims reais do schema de `nota` (a 1ª dimensão = "facts"). Claims fora de uma dim real são dropados
    // pelo merge (ctx.dims) tanto no sync quanto no batch — por isso usamos a dim real "facts".
    ORACLE.clear();
    ORACLE.set("UNIT#A", {
      facts: [{ text: "Preço Accelera enterprise", context_quote: "R$ 30 mil/mes", entity: "accelera", predicate: "preco", value: "R$ 30 mil", value_num: 30000, unit: "BRL", period: "monthly", valid_from: "2026-01-01" }],
    });
    ORACLE.set("UNIT#B", {
      facts: [
        { text: "MRR Accelera jan/2026", context_quote: "MRR de R$ 50 mil", entity: "accelera", predicate: "mrr", value: "R$ 50 mil", value_num: 50000, unit: "BRL", period: "monthly", valid_from: "2026-01-01" },
        { text: "Status Accelera ativo", context_quote: "status ativo", entity: "accelera", predicate: "status", value: "ativo", valid_from: "2026-01-01" },
      ],
    });
    ORACLE.set("UNIT#C", {
      facts: [{ text: "Accelera contrato Joinville", context_quote: "Joinville", entity: "accelera", predicate: "cidade", value: "Joinville", valid_from: "2026-01-01" }],
    });
  });

  afterAll(async () => {
    await wipeBrain(SYNC);
    await wipeBrain(BATCH);
    vi.restoreAllMocks();
  });

  it("as MESMAS units → fatos deep-equal (sync via extractOne ; batch via harvestExtractionBatch)", async () => {
    // ── CAMINHO SÍNCRONO: extractOne (chama structured STUBADO) por página, depois deriva. ──
    const eSync = await getEngine(SYNC);
    const syncSlugs: string[] = [];
    for (const p of pages) {
      await extractOne(SYNC, p); // putExtraction + markExtracted (LLM stubado)
      syncSlugs.push(p.slug);
    }
    await deriveIncremental(SYNC, syncSlugs);
    const factsSync = await eSync.currentFacts();

    // ── CAMINHO BATCH: buildBatchRequests nas MESMAS units → JSONL fake com o MESMO oráculo → harvest. ──
    const eBatch = await getEngine(BATCH);
    const worthyByPage = [];
    for (const p of pages) {
      const bp = await eBatch.getPage(p.slug);
      if (!bp) throw new Error("seed batch falhou");
      const ctx = await buildExtractionContext(BATCH, bp);
      const units = buildExtractionUnits(bp); // MESMA segmentação que o síncrono
      worthyByPage.push({ page: bp, ctx, units });
    }
    const { requests, customMap } = await buildBatchRequests(BATCH, worthyByPage);

    // p/ cada request, fabrica a BatchResultLine succeeded com os claims que o oráculo devolveria pra
    // aquela unit (casado por custom_id → page.slug → unitIdx → corpo da unit).
    const slugToUnits = new Map(worthyByPage.map((w) => [w.page.slug, w.units]));
    const lines = requests.map((req) => {
      const slug = customMap[req.custom_id];
      const idx = Number(req.custom_id.match(/__(\d+)$/)![1]);
      const unit = slugToUnits.get(slug)![idx];
      // mesmo oráculo do sync: casa o marcador UNIT#X no corpo da unit.
      let claims: Record<string, any[]> = {};
      for (const [marker, c] of ORACLE) if (unit.body.includes(marker)) claims = c;
      return fakeBatchResult(req.custom_id, claims);
    });
    mockGetBatchResults.mockResolvedValue(lines);

    const out = await harvestExtractionBatch(BATCH, fakeHandle({ status: "ended" }), customMap);
    expect(out.harvested).toBe(pages.length);
    expect(out.errored).toBe(0);
    const factsBatch = await eBatch.currentFacts();

    // ── A LEI II: os fatos vigentes são deep-equal (mesmas dims/claims/ordem após canonicalização). ──
    expect(factsSync.length).toBeGreaterThan(0);
    expect(canonFacts(factsBatch)).toEqual(canonFacts(factsSync));

    // sanidade extra: o número de requests do lote == número de units worthy do síncrono (1 chamada/unit).
    const totalUnits = worthyByPage.reduce((n, w) => n + w.units.length, 0);
    expect(requests).toHaveLength(totalUnits);
    expect(mockStructured.mock.calls.length).toBe(totalUnits); // o sync fez 1 chamada por unit
  });

  it("custom_id é determinístico por (slug, unitIdx) — a chave da equivalência E da resumibilidade", async () => {
    const p = pages[0];
    expect(makeCustomId(p.slug, 0)).toBe(makeCustomId(p.slug, 0)); // estável
    expect(makeCustomId(p.slug, 0)).not.toBe(makeCustomId(p.slug, 1));
    expect(/^[a-zA-Z0-9_-]{1,64}$/.test(makeCustomId(p.slug, 0))).toBe(true);
  });
});
