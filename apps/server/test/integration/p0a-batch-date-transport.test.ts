/** P0-A — transporte da data da unit pelo BATCH até o fato. Espelha m16-batch-pipeline.test.ts:
 *  vi.mock de batch-client (getBatchResults), ENGINE REAL (:5434), skip sem DATABASE_URL,
 *  wipeBrain antes/depois. Brain descartável `__test_p0a_whatsapp` (NUNCA Accelera/produção).
 *
 *  NÃO constrói literais IngestJob (nota do árbitro §6.2: P0-C torna leaseUntil/attempts required) —
 *  dirige buildBatchRequests/harvestExtractionBatch DIRETO, como o m16-batch-pipeline já faz.
 *
 *  Casos:
 *   (1) buildExtractionUnits no excerto real → ≥2 units, datas distintas.
 *   (2) buildBatchRequests → para cada unit com data, customMap["d:"+custom_id]===unit.date; os
 *       mapeamentos custom_id→slug seguem intactos.
 *   (3) harvest com claims SEM date em 2 units de datas diferentes → cada claim carimbado com a data
 *       da SUA unit (datas distintas entre claims).
 *   (4) o FATO herda sem tocar o indexer: count(distinct valid_from) > 1 e cada valid_from casa a
 *       data da unit do claim.
 *   (5) retrocompat: customMap SEM chaves `d:` (job em voo) → claims sem carimbo, sem erro. */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { hasDb, wipeBrain } from "./helpers/db.ts";

// ── MOCK da Batch API (S1) — só getBatchResults é exercido pelo harvest. ──
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
  makeCustomId,
  buildBatchRequests,
  harvestExtractionBatch,
} from "../../src/core/ingestion/batch-extract.ts";
import { buildExtractionUnits } from "../../src/core/ingestion/segment.ts";
import { buildExtractionContext } from "../../src/core/extraction/extract.ts";
import { capture } from "../../src/core/ingestion/capture.ts";
import { getEngine, type PageRow } from "../../src/core/platform/engine.ts";
import type { BatchHandle, BatchResultLine } from "../../src/lib/batch-client.ts";

const BRAIN = "__test_p0a_whatsapp";
const EXCERPT = readFileSync(
  fileURLToPath(new URL("../unit/fixtures/whatsapp/real-accelera-excerto.txt", import.meta.url)),
  "utf8",
);

const ENDED_HANDLE: BatchHandle = {
  id: "msgbatch_p0a_test",
  processing_status: "ended",
  request_counts: { processing: 0, succeeded: 0, errored: 0, canceled: 0, expired: 0 },
  results_url: "https://example/results.jsonl",
  created_at: "2026-06-12T00:00:00Z",
  expires_at: "2026-07-12T00:00:00Z",
};

function succeededMessage(input: Record<string, any[]>) {
  return {
    type: "succeeded" as const,
    message: { stop_reason: "tool_use", content: [{ type: "tool_use", name: "registrar_extracao", input }] },
  };
}

describe.skipIf(!hasDb())("P0-A — transporte batch da data da unit (engine real, batch MOCADO)", () => {
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

  /** semeia a página com o excerto real → devolve a PageRow real. */
  async function seedExcerpt(): Promise<PageRow> {
    const cap = await capture({ home: BRAIN, text: EXCERPT, type: "reunioes", source: "whatsapp-export" });
    const e = await getEngine(BRAIN);
    const page = await e.getPage(cap.slug);
    if (!page) throw new Error("seed falhou: página não encontrada");
    return page;
  }

  it("(1) buildExtractionUnits no excerto real → ≥2 units com datas distintas", async () => {
    const page = await seedExcerpt();
    const units = buildExtractionUnits(page);
    expect(units.length).toBeGreaterThanOrEqual(2);
    const dates = new Set(units.filter((u) => u.date).map((u) => u.date));
    expect(dates.size).toBeGreaterThanOrEqual(2);
  });

  it("(2) buildBatchRequests: customMap['d:'+id]===unit.date; slug-map intacto", async () => {
    const page = await seedExcerpt();
    const ctx = await buildExtractionContext(BRAIN, page);
    const units = buildExtractionUnits(page).filter((u) => u.date); // só units datadas
    expect(units.length).toBeGreaterThanOrEqual(2);

    const { requests, customMap } = await buildBatchRequests(BRAIN, [{ page, ctx, units }]);
    expect(requests.length).toBe(units.length);
    units.forEach((u, i) => {
      const cid = makeCustomId(page.slug, i);
      expect(customMap[cid]).toBe(page.slug); // mapeamento slug intacto
      expect(customMap[`d:${cid}`]).toBe(u.date); // data da unit no mapa aditivo
    });
  });

  it("(3)+(4) harvest carimba a data da unit no claim → fato herda (distinct valid_from > 1) sem tocar o indexer", async () => {
    const page = await seedExcerpt();
    const ctx = await buildExtractionContext(BRAIN, page);
    const dim = ctx.dims[0];
    const units = buildExtractionUnits(page).filter((u) => u.date);
    expect(units.length).toBeGreaterThanOrEqual(2);

    // 2 units de DATAS DIFERENTES (as duas primeiras datadas distintas).
    const u0 = units[0];
    const u1 = units.find((u) => u.date !== u0.date)!;
    expect(u1).toBeTruthy();
    expect(u0.date).not.toBe(u1.date);

    const cid0 = makeCustomId(page.slug, 0);
    const cid1 = makeCustomId(page.slug, 1);
    // customMap como buildBatchRequests produziria, COM as chaves d: das 2 units.
    const customMap = {
      [cid0]: page.slug,
      [cid1]: page.slug,
      [`d:${cid0}`]: u0.date,
      [`d:${cid1}`]: u1.date,
    };

    // claims SEM date própria, ancorados em quote LITERAL do body (p/ virar fato), 1 por unit/data.
    const claim0 = {
      text: "fato da unit 0",
      context_quote: "criptografia de ponta a ponta",
      entity: "accelera_p0a",
      predicate: "marco_um",
      value: "v0",
    };
    const claim1 = {
      text: "fato da unit 1",
      context_quote: "Proposta comercial",
      entity: "accelera_p0a",
      predicate: "marco_dois",
      value: "v1",
    };
    const lines: BatchResultLine[] = [
      { custom_id: cid0, result: succeededMessage({ [dim]: [claim0] }) },
      { custom_id: cid1, result: succeededMessage({ [dim]: [claim1] }) },
    ];
    mockGetBatchResults.mockResolvedValue(lines);

    const out = await harvestExtractionBatch(BRAIN, ENDED_HANDLE, customMap);
    expect(out.harvested).toBe(1); // 1 página tocada

    // a EXTRAÇÃO crua já carrega a data carimbada por claim (transporte sync↔batch equivalente).
    // DESVIO vs spec §6.2: o base da worktree (M20) não tem `getExtraction(slug)` — usamos
    // `allExtractions().find(source_slug)`, equivalente (ANOTADO pro Integrador).
    const e = await getEngine(BRAIN);
    const ex = (await e.allExtractions()).find((x) => x.source_slug === page.slug);
    const rawClaims = (ex?.extractions?.[dim] ?? []) as any[];
    const datesByPredicate = Object.fromEntries(rawClaims.map((c) => [c.predicate, c.date]));
    expect(datesByPredicate["marco_um"]).toBe(u0.date);
    expect(datesByPredicate["marco_dois"]).toBe(u1.date);
    expect(datesByPredicate["marco_um"]).not.toBe(datesByPredicate["marco_dois"]);

    // o FATO herda a data via fallback do indexer (valid_from = date) — SEM mudança no indexer.
    const facts = (await e.currentFacts()).filter((f) => f.source_slug === page.slug);
    const validFroms = new Set(facts.map((f) => f.valid_from).filter(Boolean));
    expect(validFroms.size).toBeGreaterThan(1); // datas distintas → o bug "1 única data" morre
    // cada valid_from casa a data da unit do seu claim.
    const byPred = Object.fromEntries(facts.map((f) => [f.predicate, f.valid_from]));
    expect(byPred["marco_um"]).toBe(u0.date);
    expect(byPred["marco_dois"]).toBe(u1.date);
  });

  it("(5) retrocompat: customMap SEM chaves d: (job em voo) → claims sem carimbo, sem erro", async () => {
    const page = await seedExcerpt();
    const ctx = await buildExtractionContext(BRAIN, page);
    const dim = ctx.dims[0];
    const cid = makeCustomId(page.slug, 0);
    const customMap = { [cid]: page.slug }; // SEM d: (simula job submetido antes do merge P0-A)

    const lines: BatchResultLine[] = [
      {
        custom_id: cid,
        result: succeededMessage({
          [dim]: [{ text: "x", context_quote: "Boa tarde", entity: "accelera_p0a", predicate: "legado" }],
        }),
      },
    ];
    mockGetBatchResults.mockResolvedValue(lines);

    const out = await harvestExtractionBatch(BRAIN, ENDED_HANDLE, customMap);
    expect(out.harvested).toBe(1); // não derruba
    const e = await getEngine(BRAIN);
    const ex = (await e.allExtractions()).find((x) => x.source_slug === page.slug); // ver DESVIO no caso (3)+(4)
    const legado = ((ex?.extractions?.[dim] ?? []) as any[]).find((c) => c.predicate === "legado");
    expect(legado).toBeTruthy();
    expect(legado.date).toBeUndefined(); // sem chave d: → sem carimbo (no-op, retrocompat)
  });
});
