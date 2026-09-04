/** Achado criacao-de-fatos #4 — "aprovação morta": o caminho UNITÁRIO (approveReviewItem) não tinha
 *  gate nenhum — aprovar claim sem citação cunhava fato 'nao-verificado' 0.30 (fora de currentFacts
 *  e da cadeia bitemporal) com toast de sucesso na tela Revisar. O LOTE (M25-A) já gateava; agora o
 *  unitário roda o MESMO gateClaimAnchoring ANTES do efeito e lança o porquê legível (o
 *  approveHypothesisHandler converte em 409; o front já exibe e.message). vaguezaResolvida=true no
 *  unitário: a decisão humana POR ITEM resolve o referente vago (exceção review='aprovada' do
 *  indexer, M23-B teste 4) — a ancoragem NUNCA é dispensada.
 *  Engine mockado (padrão m23d-consolidacao-serial.test.ts) — sem DB. */
import { describe, it, expect, vi, beforeEach } from "vitest";

const BODY = "ela escolheu o plano pocket; o reajuste foi aceito pelo cliente na call de junho.";

const h = vi.hoisted(() => {
  const engine = {
    getReviewItem: vi.fn(),
    getPage: vi.fn(),
    getExtraction: vi.fn(),
    putExtraction: vi.fn(),
    setReviewStatus: vi.fn(),
  };
  return {
    engine,
    deriveIncremental: vi.fn(async () => ({ groups: 0, facts: 0, edges: 0 })),
    freshVersion: vi.fn(async () => "v-test"),
  };
});

vi.mock("../../src/core/platform/engine.ts", () => ({ getEngine: vi.fn(async () => h.engine) }));
vi.mock("../../src/core/retrieval/indexer.ts", () => ({ deriveIncremental: h.deriveIncremental }));
vi.mock("../../src/core/extraction/extract.ts", () => ({ freshVersion: h.freshVersion }));
vi.mock("../../src/core/platform/webhook-emit.ts", () => ({ emitWebhookEvent: vi.fn(async () => {}) }));

import { approveReviewItem, LOTE_PORQUE } from "../../src/core/ingestion/golden-rule.ts";

const item = (over: Record<string, unknown>) => ({
  id: "item-1",
  source_id: "src-1",
  source_slug: "pg-1",
  dimension: "decisions",
  text: "t",
  quote: "",
  claim: {},
  reason: "nao_ancorado",
  status: "pendente",
  decided_by: "",
  decided_at: null,
  ...over,
});

beforeEach(() => {
  h.engine.getReviewItem.mockReset();
  h.engine.getPage.mockReset();
  h.engine.getExtraction.mockReset();
  h.engine.putExtraction.mockReset();
  h.engine.setReviewStatus.mockReset();
  h.deriveIncremental.mockClear();
  h.engine.getPage.mockResolvedValue({ slug: "pg-1", type: "reunioes", date: "2026-06-01", body: BODY, content_hash: "x" });
  h.engine.getExtraction.mockResolvedValue(null);
});

describe("approveReviewItem — gate de ancoragem no caminho unitário (fim da aprovação morta)", () => {
  it("claim SEM evidência nenhuma → lança o porquê legível e NÃO grava nada (antes: fato invisível + toast falso)", async () => {
    h.engine.getReviewItem.mockResolvedValue(
      item({ claim: { entity: "acme", predicate: "posicionamento", value: "premium" } }), // 'premium' não está no body
    );
    await expect(approveReviewItem("brain", "item-1", "kelvin")).rejects.toThrow(LOTE_PORQUE.sem_evidencia);
    expect(h.engine.putExtraction).not.toHaveBeenCalled();
    expect(h.engine.setReviewStatus).not.toHaveBeenCalled();
    expect(h.deriveIncremental).not.toHaveBeenCalled();
  });

  it("quote NÃO-verbatim → lança nao_ancorado (aprovação não inventa âncora)", async () => {
    h.engine.getReviewItem.mockResolvedValue(
      item({ claim: { entity: "acme", predicate: "status", value: "x", context_quote: "frase inventada xyzzy que não consta" } }),
    );
    await expect(approveReviewItem("brain", "item-1", "kelvin")).rejects.toThrow(LOTE_PORQUE.nao_ancorado);
    expect(h.engine.setReviewStatus).not.toHaveBeenCalled();
  });

  it("página SUMIDA (body '') → lança (mesma política 'nunca aprovação às cegas' do lote)", async () => {
    h.engine.getPage.mockResolvedValue(undefined);
    h.engine.getReviewItem.mockResolvedValue(
      item({ claim: { entity: "acme", predicate: "status", value: "x", context_quote: "ela escolheu o plano pocket" } }),
    );
    await expect(approveReviewItem("brain", "item-1", "kelvin")).rejects.toThrow(LOTE_PORQUE.nao_ancorado);
  });

  it("entidade VAGA + quote verbatim → APROVA (vaguezaResolvida: o humano é o resolvedor do referente)", async () => {
    h.engine.getReviewItem.mockResolvedValue(
      item({
        reason: "entidade_vaga",
        claim: { entity: "ela", predicate: "plano", value: "pocket", context_quote: "ela escolheu o plano pocket" },
      }),
    );
    await approveReviewItem("brain", "item-1", "kelvin");
    // o claim entra na extração com os marcadores da decisão humana:
    expect(h.engine.putExtraction).toHaveBeenCalledTimes(1);
    const row = h.engine.putExtraction.mock.calls[0][0];
    expect(row.extractions.decisions[0].review).toBe("aprovada");
    expect(row.extractions.decisions[0].review_id).toBe("item-1");
    expect(h.deriveIncremental).toHaveBeenCalledWith("brain", ["pg-1"]);
    expect(h.engine.setReviewStatus).toHaveBeenCalledWith("item-1", "aprovada", "kelvin");
  });

  it("claim bem ancorado (quote verbatim) → aprova normalmente (o gate não retém quem tem evidência)", async () => {
    h.engine.getReviewItem.mockResolvedValue(
      item({ claim: { entity: "acme", predicate: "aceite", value: "reajuste", context_quote: "o reajuste foi aceito pelo cliente" } }),
    );
    await approveReviewItem("brain", "item-1", "kelvin");
    expect(h.engine.setReviewStatus).toHaveBeenCalledWith("item-1", "aprovada", "kelvin");
  });

  it("idempotência preservada: item já 'aprovada' → no-op silencioso (sem gate, sem escrita)", async () => {
    h.engine.getReviewItem.mockResolvedValue(item({ status: "aprovada", claim: {} }));
    await approveReviewItem("brain", "item-1", "kelvin");
    expect(h.engine.putExtraction).not.toHaveBeenCalled();
    expect(h.engine.setReviewStatus).not.toHaveBeenCalled();
  });

  it("conexao_sugerida segue o caminho M24-B: registra a decisão sem gate/extração/derive", async () => {
    h.engine.getReviewItem.mockResolvedValue(item({ reason: "conexao_sugerida", claim: {} }));
    await approveReviewItem("brain", "item-1", "kelvin");
    expect(h.engine.setReviewStatus).toHaveBeenCalledWith("item-1", "aprovada", "kelvin");
    expect(h.engine.putExtraction).not.toHaveBeenCalled();
    expect(h.deriveIncremental).not.toHaveBeenCalled();
  });
});
