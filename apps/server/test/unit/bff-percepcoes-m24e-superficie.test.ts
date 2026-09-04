/** M24-E — unit do handler BFF de percepções (§6.2). SEM DB: mocka o engine (listPercepcoes/
 *  percepcaoCounts). vi.mock + vi.hoisted (LEARNINGS M18/S2). Prova: shape PercepcoesPage; default
 *  estado="viva"; "todas" não filtra; estado inválido → BffError 400 (string PT EXATA); clamp de
 *  limit/offset; toView reduz cites a source_slugs únicos e preserva numbers. */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { listPercepcoes, percepcaoCounts } = vi.hoisted(() => ({
  listPercepcoes: vi.fn(),
  percepcaoCounts: vi.fn(async () => ({ viva: 1, stale: 0, arquivada: 0 })),
}));
vi.mock("../../src/core/platform/engine.ts", () => ({
  getEngine: vi.fn(async () => ({ listPercepcoes, percepcaoCounts })),
}));

import { percepcoesHandler } from "../../src/connectors/bff/bff-percepcoes.ts";
import { BffError } from "../../src/connectors/bff/bff-common.ts";

const row = (over: any = {}) => ({
  id: "id1", classe: "tendencia", severidade: "alta", entity: "accelera", predicate: "preco", tier: "",
  texto: "subiu 900%", numbers: { pctTotal: 900, magnitude: 900 },
  cites: [{ source_slug: "p1", entity: "accelera", predicate: "preco", tier: "", valid_from: "2025-01-01", quote: "" },
          { source_slug: "p1", entity: "accelera", predicate: "preco", tier: "", valid_from: "2026-03-01", quote: "" }],
  estado: "viva", created_at: "2026-06-10T03:12:00.000Z", validated_at: null, ...over,
});

beforeEach(() => {
  listPercepcoes.mockReset().mockResolvedValue([row()]);
  percepcaoCounts.mockClear();
});

describe("M24-E bff-percepcoes", () => {
  it("shape PercepcoesPage completo + toView reduz cites a source_slugs únicos", async () => {
    const page = await percepcoesHandler("brain-x", {});
    expect(page.items).toHaveLength(1);
    const v = page.items[0];
    expect(v.cites.source_slugs).toEqual(["p1"]); // deduplicado
    expect(v.numbers).toEqual({ pctTotal: 900, magnitude: 900 }); // intacto
    expect(v.validated_at).toBe(""); // null → ""
    expect(page.counts).toEqual({ viva: 1, stale: 0, arquivada: 0 });
    expect(page.limit).toBe(50);
    expect(page.offset).toBe(0);
  });

  it('default estado="viva"', async () => {
    await percepcoesHandler("brain-x", {});
    expect(listPercepcoes).toHaveBeenCalledWith(expect.objectContaining({ estado: "viva" }));
  });

  it('estado="todas" não filtra (sem chave estado)', async () => {
    await percepcoesHandler("brain-x", { estado: "todas" });
    const arg = listPercepcoes.mock.calls[0][0];
    expect(arg.estado).toBeUndefined();
  });

  it("estado inválido → BffError 400 com a mensagem PT EXATA", async () => {
    await expect(percepcoesHandler("brain-x", { estado: "zumbi" })).rejects.toThrowError(BffError);
    await expect(percepcoesHandler("brain-x", { estado: "zumbi" })).rejects.toThrowError(
      'estado inválido — use "viva", "stale", "arquivada" ou "todas".',
    );
  });

  it("clamp de limit (0→default? não: 0 é falsy → 50; 999→200) e offset (-1→0)", async () => {
    await percepcoesHandler("brain-x", { limit: 999, offset: -1 });
    expect(listPercepcoes).toHaveBeenCalledWith(expect.objectContaining({ limit: 200, offset: 0 }));
    listPercepcoes.mockClear();
    await percepcoesHandler("brain-x", { limit: 1 });
    expect(listPercepcoes).toHaveBeenCalledWith(expect.objectContaining({ limit: 1 }));
  });
});
