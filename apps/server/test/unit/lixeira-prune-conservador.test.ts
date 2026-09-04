/** Decaimento→lixeira (achado decaimento-lixeira#1): o prune AUTO do ciclo de sono é ultra-
 *  conservador — só arquiva LIXO GENUÍNO (órfã no grafo E 0 fatos E anterior ao cutoff). O CLI
 *  manual (`galeed prune`) mantém o critério amplo (score ≤ keepMin). E o cutoff do AUTO é função
 *  PURA do relógio injetado (pruneCutoff). Sem banco: engine mockado. */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  setArchived: vi.fn(async (_slug: string, _archived: boolean) => {}),
  graph: { nodes: [] as any[], edges: [] as any[] },
}));

vi.mock("../../src/core/platform/engine.ts", async (importOriginal) => {
  const mod = await importOriginal<any>();
  return {
    ...mod,
    getEngine: vi.fn(async () => ({
      graphAll: async () => h.graph,
      setArchived: h.setArchived,
    })),
  };
});
// consolidateCold puxa capture/llm no import do módulo — isolamos (não são exercitados aqui).
vi.mock("../../src/core/ingestion/capture.ts", () => ({ capture: vi.fn() }));
vi.mock("../../src/lib/llm.ts", () => ({ resolveProvider: () => "none", prose: vi.fn(async () => "") }));

import { prune } from "../../src/core/memory/sleep.ts";
import { pruneCutoff } from "../../src/core/ingestion/sono-step.ts";

const CUTOFF = "2026-01-01";
const nodo = (id: string, factCount: number, date: string) => ({
  id, label: id, type: "notas", date, exists: true, factCount,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.graph = {
    nodes: [
      nodo("orfa-velha-sem-fato", 0, "2020-05-05"), // lixo genuíno: as 3 condições
      nodo("orfa-velha-com-fato", 1, "2020-05-05"), // gerou fato → conservador poupa
      nodo("linkada-velha-sem-fato", 0, "2020-05-05"), // linkada → conservador poupa
      nodo("linkada-2", 0, "2020-05-05"),
      nodo("orfa-nova-sem-fato", 0, "2026-06-30"), // nova (pós-cutoff) → conservador poupa
    ],
    edges: [{ src: "linkada-velha-sem-fato", dst: "linkada-2", kind: "wikilink" }],
  };
});

describe("pruneCutoff — derivação pura do cutoff (relógio injetado)", () => {
  it("agora − dias, em ISO date (comparável lexicograficamente)", () => {
    expect(pruneCutoff(new Date("2026-07-01T00:00:00.000Z"), 180)).toBe("2026-01-02");
    expect(pruneCutoff(new Date("2026-07-01T12:34:56.000Z"), 180)).toBe("2026-01-02");
    expect(pruneCutoff(new Date("2026-07-07T00:00:00.000Z"), 0)).toBe("2026-07-07");
  });
});

describe("prune conservador (modo AUTO do sono)", () => {
  it("candidata SÓ com grau 0 E 0 fatos E anterior ao cutoff — lixo genuíno", async () => {
    const r = await prune("b", { conservador: true, olderThan: CUTOFF });
    expect(r.candidates.map((c) => c.slug)).toEqual(["orfa-velha-sem-fato"]);
  });

  it("sem cutoff (olderThan vazio) → NENHUMA candidata (idade é condição obrigatória)", async () => {
    const r = await prune("b", { conservador: true });
    expect(r.candidates).toEqual([]);
  });

  it("apply arquiva via flag (setArchived true) apenas o lixo genuíno", async () => {
    const r = await prune("b", { conservador: true, olderThan: CUTOFF, apply: true });
    expect(r.archived).toBe(1);
    expect(h.setArchived).toHaveBeenCalledTimes(1);
    expect(h.setArchived).toHaveBeenCalledWith("orfa-velha-sem-fato", true);
  });

  it("critério AMPLO (CLI) segue pegando mais que o conservador (órfã com 1 fato e linkada velha)", async () => {
    const amplo = await prune("b", { olderThan: CUTOFF });
    const slugs = amplo.candidates.map((c) => c.slug);
    expect(slugs).toContain("orfa-velha-sem-fato");
    expect(slugs).toContain("orfa-velha-com-fato"); // score 3−3=0 ≤ keepMin 1, órfã
    expect(slugs.length).toBeGreaterThan(1); // amplo ⊋ conservador
    expect(amplo.archived).toBe(0); // dry-run por default — nada arquivado
    expect(h.setArchived).not.toHaveBeenCalled();
  });
});
