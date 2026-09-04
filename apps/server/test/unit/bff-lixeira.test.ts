/** Unit dos handlers da LIXEIRA (bff-lixeira.ts) — SEM DB: mocka db-conn (getSharedSql como
 *  template tag) e o restoreCold do tiering. Prova: listagem mapeia archived=true → LixeiraItem
 *  (sem body — subset leve) + total honesto; restaurar valida slug (BffError 400 PT) e repassa
 *  home+slug pro restoreCold — a MESMA assinatura restoreCold(home, slug) que cobre cold E
 *  archived+hot (fix do pacote decaimento-lixeira#3). */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { sqlMock, getSharedSql, restoreCold } = vi.hoisted(() => {
  const sqlMock = vi.fn();
  return {
    sqlMock,
    getSharedSql: vi.fn(async () => sqlMock),
    restoreCold: vi.fn(),
  };
});
vi.mock("../../src/core/platform/db-conn.ts", () => ({ getSharedSql }));
vi.mock("../../src/core/memory/tiering.ts", () => ({ restoreCold }));

import { lixeiraHandler, restaurarHandler } from "../../src/connectors/bff/bff-lixeira.ts";
import { BffError } from "../../src/connectors/bff/bff-common.ts";

beforeEach(() => {
  sqlMock.mockReset();
  restoreCold.mockReset();
});

describe("bff-lixeira — listar arquivadas + restaurar", () => {
  it("lixeiraHandler: mapeia linhas archived → LixeiraItem (defaults seguros) + total do COUNT", async () => {
    sqlMock
      .mockResolvedValueOnce([
        { slug: "call-velha", type: "call", title: "Call antiga", date: "2025-01-10", tier: "hot" },
        { slug: "nota-fria", type: null, title: null, date: null, tier: "cold" },
      ])
      .mockResolvedValueOnce([{ n: 7 }]); // total real maior que a página (teto da listagem)

    const page = await lixeiraHandler("brain-x");
    expect(page.items).toEqual([
      { slug: "call-velha", type: "call", title: "Call antiga", date: "2025-01-10", tier: "hot" },
      { slug: "nota-fria", type: "", title: "", date: "", tier: "cold" },
    ]);
    expect(page.total).toBe(7);
  });

  it("restaurarHandler: repassa (home, slug) pro restoreCold e devolve o resultado cru", async () => {
    restoreCold.mockResolvedValue({ slug: "call-velha", restored: true, vectorsRebuilt: 3 });
    const r = await restaurarHandler("brain-x", "  call-velha  "); // trim
    expect(restoreCold).toHaveBeenCalledWith("brain-x", "call-velha");
    expect(r).toEqual({ slug: "call-velha", restored: true, vectorsRebuilt: 3 });
  });

  it("restaurarHandler: restored:false (não existe / já ativa) passa adiante sem virar erro", async () => {
    restoreCold.mockResolvedValue({ slug: "fantasma", restored: false, vectorsRebuilt: 0 });
    const r = await restaurarHandler("brain-x", "fantasma");
    expect(r.restored).toBe(false);
  });

  it("restaurarHandler: slug vazio → BffError 400 com mensagem PT leiga", async () => {
    await expect(restaurarHandler("brain-x", "")).rejects.toThrowError(BffError);
    await expect(restaurarHandler("brain-x", "   ")).rejects.toThrowError(
      "diga qual memória restaurar (slug).",
    );
    expect(restoreCold).not.toHaveBeenCalled();
  });
});
