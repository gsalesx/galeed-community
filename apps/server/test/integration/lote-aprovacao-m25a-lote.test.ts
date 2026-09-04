/** M25-A/§5.C — aprovar/descartar EM LOTE no DB real (:5434). A LEI: decisão por LOTE,
 *  ancoragem por ITEM (gate determinístico, zero LLM). Verifica: derive ÚNICO (spy via mock
 *  PARCIAL do indexer — passthrough real + contagem), idempotência (dedupe review_id + CAS),
 *  conexao_sugerida sem extração/derive, descarte registrado, durabilidade (trigger 27).
 *  Moldes: p1c-contrato-aprovacao + fila-m23b-autocontencao. */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { hasDb, wipeBrain, rawConnect } from "./helpers/db.ts";

/** conta os fatos 'registrado' com selo (source_id + meta.review_id) destas páginas — claims sem
 *  triple viram status='registrado' (entity ''), fora do currentFacts(); a leitura é direta. */
async function selados(brain: string, slugs: string[]): Promise<{ count: number; source_ids: Set<string> }> {
  const sql = await rawConnect();
  try {
    const rows = (await sql`
      select source_id from galeed_facts
      where brain = ${brain} and source_slug = any(${slugs})
        and status = 'registrado' and meta->>'review_id' is not null`) as any[];
    return { count: rows.length, source_ids: new Set(rows.map((r) => r.source_id)) };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

// mock PARCIAL do indexer: deriveIncremental REAL preservado (passthroughs no DB), só
// instrumentado com spy pra contar as chamadas (padrão vi.hoisted).
const spy = vi.hoisted(() => ({ derive: vi.fn() }));
vi.mock("../../src/core/retrieval/indexer.ts", async (importActual) => {
  const actual = await importActual<typeof import("../../src/core/retrieval/indexer.ts")>();
  return {
    ...actual,
    deriveIncremental: vi.fn(async (home: string, slugs: string[]) => {
      spy.derive(home, [...slugs]);
      return actual.deriveIncremental(home, slugs);
    }),
  };
});

import { getEngine, closeEngines, type SourceRow, type ReviewItemRow } from "../../src/core/platform/engine.ts";
import {
  approveReviewItemsLote,
  discardReviewItemsLote,
  LOTE_PORQUE,
} from "../../src/core/ingestion/golden-rule.ts";

const BRAIN = "itest-m25a-lote";
const SOURCE_ID = "fonte-m25a-lote";
const SLUG_A = "pag-a-m25a-lote";
const SLUG_B = "pag-b-m25a-lote";

const QUOTE_A1 = "o status do contrato é fechado";
const QUOTE_A2 = "teobaldo vai ser o mentor da turma";
const QUOTE_B1 = "andré está no ramo de clínicas";
const BODY_A = `ata da reunião: ${QUOTE_A1}, conforme a diretoria; e ${QUOTE_A2}.`;
const BODY_B = `na call: ${QUOTE_B1}, segundo ele mesmo confirmou.`;

const SOURCE: SourceRow = {
  id: SOURCE_ID, name: "Fonte M25A", channel: "upload", type: "nota",
  recipe: { fields: [{ dimension: "decisoes", label: "Decisões", area: "" }], guidance: "" },
  default_sensitivity: "restrito", status: "ativa", last_read_at: null,
};

function rev(p: Partial<ReviewItemRow> & { id: string; source_slug: string }): ReviewItemRow {
  return {
    source_id: SOURCE_ID,
    dimension: p.dimension ?? "decisoes",
    text: p.text ?? "t",
    quote: p.quote ?? "",
    claim: p.claim ?? {},
    reason: p.reason ?? "nao_ancorado",
    status: "pendente",
    decided_by: "",
    decided_at: null,
    ...p,
  } as ReviewItemRow;
}

const ANCORA_A1 = rev({
  id: "rev-m25a-lote-a1", source_slug: SLUG_A, quote: QUOTE_A1,
  claim: { text: "status fechado", entity: "contrato", context_quote: QUOTE_A1 },
});
const ANCORA_A2 = rev({
  id: "rev-m25a-lote-a2", source_slug: SLUG_A, quote: QUOTE_A2,
  claim: { text: "teobaldo mentor", entity: "teobaldo", context_quote: QUOTE_A2 },
});
const ANCORA_B1 = rev({
  id: "rev-m25a-lote-b1", source_slug: SLUG_B, quote: QUOTE_B1,
  claim: { text: "andré clínicas", entity: "andre", context_quote: QUOTE_B1 },
});
const NAO_ANCORADO = rev({
  id: "rev-m25a-lote-na", source_slug: SLUG_A, quote: "frase que nunca consta xyzzy",
  claim: { text: "x", entity: "y", context_quote: "frase que nunca consta xyzzy" },
});
const CONEXAO = rev({
  id: "rev-m25a-lote-cx", source_slug: SLUG_A, dimension: "conexao", reason: "conexao_sugerida",
  claim: { a: "contrato", b: "teobaldo" },
});

const CLAIM_IDS = [ANCORA_A1.id, ANCORA_A2.id, ANCORA_B1.id, NAO_ANCORADO.id];

async function seed() {
  await wipeBrain(BRAIN);
  const e = await getEngine(BRAIN);
  await e.upsertSource(SOURCE);
  await e.upsertPage({
    slug: SLUG_A, type: "nota", title: "A", date: "2026-01-01", path: "", body: BODY_A,
    content_hash: "hash-a-m25a", tags: [`src:${SOURCE_ID}`],
  });
  await e.upsertPage({
    slug: SLUG_B, type: "nota", title: "B", date: "2026-01-01", path: "", body: BODY_B,
    content_hash: "hash-b-m25a", tags: [`src:${SOURCE_ID}`],
  });
  await e.addReviewItems([ANCORA_A1, ANCORA_A2, ANCORA_B1, NAO_ANCORADO, CONEXAO]);
}

describe.skipIf(!hasDb())("M25-A — aprovar/descartar em lote (DB real)", () => {
  beforeAll(async () => {
    await seed();
    spy.derive.mockClear();
  });
  afterAll(async () => {
    await wipeBrain(BRAIN);
    await closeEngines();
  });

  it("1. aprovar-grupo gateado: 3 ancorados aprovam, 1 retido com porquê; fatos com source_id carimbado", async () => {
    const r = await approveReviewItemsLote(BRAIN, CLAIM_IDS, "humano-m25a");
    expect(r.aprovados).toBe(3);
    expect(r.retidos).toEqual([{ id: NAO_ANCORADO.id, porque: LOTE_PORQUE.nao_ancorado }]);
    expect(r.ja_decididos).toBe(0);
    expect(r.paginas_derivadas).toBe(2);

    const e = await getEngine(BRAIN);
    // pág A: os 2 claims na MESMA dimensão/array, UM putExtraction
    const exA = await e.getExtraction(SLUG_A);
    const arrA = exA!.extractions!.decisoes as any[];
    expect(arrA).toHaveLength(2);
    expect(arrA.every((c) => c.review === "aprovada")).toBe(true);
    expect(new Set(arrA.map((c) => c.review_id))).toEqual(new Set([ANCORA_A1.id, ANCORA_A2.id]));
    expect(arrA.every((c) => c.source_id === SOURCE_ID)).toBe(true);

    // fatos 'registrado' com selo (source_id carimbado + meta.review_id) — claims sem triple
    const sel = await selados(BRAIN, [SLUG_A, SLUG_B]);
    expect(sel.count).toBe(3); // 3 ancorados aprovados
    expect(sel.source_ids).toEqual(new Set([SOURCE_ID]));

    // status: 3 aprovada, retido pendente
    expect((await e.getReviewItem(ANCORA_A1.id))!.status).toBe("aprovada");
    expect((await e.getReviewItem(ANCORA_B1.id))!.status).toBe("aprovada");
    expect((await e.getReviewItem(NAO_ANCORADO.id))!.status).toBe("pendente");
  });

  it("2. derive em LOTE (não por item): deriveIncremental chamado EXATAMENTE 1× com os 2 slugs", () => {
    expect(spy.derive).toHaveBeenCalledTimes(1);
    const [, slugs] = spy.derive.mock.calls[0];
    expect(new Set(slugs)).toEqual(new Set([SLUG_A, SLUG_B]));
  });

  it("3. idempotência: repetir = no-op (aprovados:0, ja_decididos:3, mesmo retido; arrays e fatos inalterados)", async () => {
    const e = await getEngine(BRAIN);
    const factsAntes = (await selados(BRAIN, [SLUG_A, SLUG_B])).count;
    const r = await approveReviewItemsLote(BRAIN, CLAIM_IDS, "humano-m25a");
    expect(r.aprovados).toBe(0);
    expect(r.ja_decididos).toBe(3);
    expect(r.retidos).toEqual([{ id: NAO_ANCORADO.id, porque: LOTE_PORQUE.nao_ancorado }]);

    const arrA = (await e.getExtraction(SLUG_A))!.extractions!.decisoes as any[];
    expect(arrA).toHaveLength(2); // dedupe review_id: não cresceu
    expect((await selados(BRAIN, [SLUG_A, SLUG_B])).count).toBe(factsAntes);
  });

  it("4. conexao_sugerida: aprovado SEM extração/derive (dim 'conexao' não entra na extração)", async () => {
    spy.derive.mockClear();
    const r = await approveReviewItemsLote(BRAIN, [CONEXAO.id], "humano-m25a");
    expect(r.aprovados).toBe(1);
    expect(r.paginas_derivadas).toBe(0);
    expect(spy.derive).not.toHaveBeenCalled();

    const e = await getEngine(BRAIN);
    const exA = await e.getExtraction(SLUG_A);
    expect(exA!.extractions!.conexao).toBeUndefined();
    const item = await e.getReviewItem(CONEXAO.id);
    expect(item!.status).toBe("aprovada");
    expect(item!.decided_by).toBe("humano-m25a");
  });

  it("5. descartar-grupo registrado: retido → descartada com decided_by; repetir = ja_decididos", async () => {
    const r = await discardReviewItemsLote(BRAIN, [NAO_ANCORADO.id], "humano-m25a");
    expect(r).toEqual({ descartados: 1, ja_decididos: 0 });
    const e = await getEngine(BRAIN);
    const item = await e.getReviewItem(NAO_ANCORADO.id);
    expect(item!.status).toBe("descartada");
    expect(item!.decided_by).toBe("humano-m25a"); // nunca silencioso

    const r2 = await discardReviewItemsLote(BRAIN, [NAO_ANCORADO.id], "humano-m25a");
    expect(r2).toEqual({ descartados: 0, ja_decididos: 1 });
  });

  it("6. durabilidade (trigger 27): putExtraction SEM os claims aprovados NÃO os apaga", async () => {
    const e = await getEngine(BRAIN);
    const ex = (await e.getExtraction(SLUG_A))!;
    await e.putExtraction({
      source_slug: SLUG_A, type: ex.type, date: ex.date,
      content_hash: ex.content_hash, prompt_version: "v-reextract-m25a", extractions: { decisoes: [] },
    });
    const after = (await e.getExtraction(SLUG_A))!.extractions!.decisoes as any[];
    expect(after).toHaveLength(2);
    expect(new Set(after.map((c) => c.review_id))).toEqual(new Set([ANCORA_A1.id, ANCORA_A2.id]));
  });
});
