/** Unit do handler /api/saude (bff-saude.ts) — SEM DB: mocka db-conn (getSharedSql como template
 *  tag) e o engine (storageStats). vi.mock + vi.hoisted (padrão bff-percepcoes-m24e). Prova:
 *  shape SaudeView; last_trace lido e parseado (inclusive quando vem string); sono null quando o
 *  brain nunca dormiu; jobs agregados por status; FAIL-SOFT total (tabela/conexão ausente não
 *  derruba — a tela Saúde degrada, não quebra). */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { sqlMock, getSharedSql, storageStats } = vi.hoisted(() => {
  const sqlMock = vi.fn();
  return {
    sqlMock,
    getSharedSql: vi.fn(async () => sqlMock),
    storageStats: vi.fn(),
  };
});
vi.mock("../../src/core/platform/db-conn.ts", () => ({ getSharedSql }));
vi.mock("../../src/core/platform/engine.ts", () => ({
  getEngine: vi.fn(async () => ({ storageStats })),
}));

import { saudeHandler } from "../../src/connectors/bff/bff-saude.ts";

const TRACE = {
  status: "parcial",
  fontes_novas: 14,
  fatos_novos: 51,
  budget_k: 10,
  chamadas_llm: 3,
  fases: {
    prune: { status: "ok", podaveis: 7 },
    reflexao: { status: "falhou", erro: "quota LLM estourada" },
  },
};

/** roteia a template-tag pelo texto da query (sono_state vs ingest_jobs). */
function routeSql(sonoRows: unknown[], jobRows: unknown[]) {
  sqlMock.mockImplementation(async (strings: TemplateStringsArray) => {
    const q = Array.isArray(strings) ? strings.join("?") : String(strings);
    if (q.includes("galeed_sono_state")) return sonoRows;
    if (q.includes("galeed_ingest_jobs")) return jobRows;
    return [];
  });
}

beforeEach(() => {
  sqlMock.mockReset();
  getSharedSql.mockClear();
  getSharedSql.mockImplementation(async () => sqlMock);
  storageStats.mockReset().mockResolvedValue({
    pagesTotal: 12, pagesHot: 9, pagesCold: 1, pagesArchived: 2,
    vectors: 340, facts: 88, edges: 17, bodyBytes: 12345,
  });
});

describe("bff-saude — /api/saude expõe sono + armazenamento + fila", () => {
  it("shape completo: last_trace parseado (string→objeto), storage mapeado, jobs agregados", async () => {
    routeSql(
      [{ last_sleep_at: "2026-07-06T03:00:00.000Z", last_trace: JSON.stringify(TRACE), updated_at: "2026-07-06T03:01:00.000Z" }],
      [{ status: "queued", n: 2 }, { status: "batch_submitted", n: 1 }, { status: "error", n: 3 }, { status: "dead", n: 1 }],
    );
    const v = await saudeHandler("brain-x");

    expect(v.sono?.lastSleepAt).toBe("2026-07-06T03:00:00.000Z");
    expect(v.sono?.trace?.status).toBe("parcial");
    expect(v.sono?.trace?.fases?.prune).toEqual({ status: "ok", podaveis: 7 });
    expect(v.sono?.trace?.fases?.reflexao?.erro).toBe("quota LLM estourada");

    expect(v.storage).toEqual({
      pagesTotal: 12, pagesHot: 9, pagesCold: 1, pagesArchived: 2, vectors: 340, facts: 88, edges: 17,
    }); // bodyBytes NÃO vaza (subset deliberado)

    expect(v.jobs).toEqual({ queued: 2, batch_submitted: 1, error: 3, dead: 1 });
  });

  it("nunca dormiu (0 linhas) → sono null; trace jsonb já-objeto também funciona", async () => {
    routeSql([], []);
    const v1 = await saudeHandler("brain-x");
    expect(v1.sono).toBeNull();

    routeSql([{ last_sleep_at: null, last_trace: TRACE, updated_at: null }], []);
    const v2 = await saudeHandler("brain-x");
    expect(v2.sono?.lastSleepAt).toBeNull();
    expect(v2.sono?.trace?.fases?.prune?.podaveis).toBe(7);
  });

  it("trace vazio ({} — só gate rodou sem gravar nada) → trace null (a tela mostra 'não dormiu')", async () => {
    routeSql([{ last_sleep_at: null, last_trace: {}, updated_at: null }], []);
    const v = await saudeHandler("brain-x");
    expect(v.sono?.trace).toBeNull();
  });

  it("FAIL-SOFT: sem DATABASE_URL (getSharedSql lança) → sono null + jobs {} (storage segue)", async () => {
    getSharedSql.mockImplementation(async () => {
      throw new Error("sem DATABASE_URL");
    });
    const v = await saudeHandler("brain-x");
    expect(v.sono).toBeNull();
    expect(v.jobs).toEqual({});
    expect(v.storage?.pagesArchived).toBe(2);
  });

  it("FAIL-SOFT: engine indisponível → storage null (sono e jobs seguem)", async () => {
    routeSql([], [{ status: "done", n: 5 }]);
    storageStats.mockRejectedValue(new Error("engine off"));
    const v = await saudeHandler("brain-x");
    expect(v.storage).toBeNull();
    expect(v.jobs).toEqual({ done: 5 });
  });
});
