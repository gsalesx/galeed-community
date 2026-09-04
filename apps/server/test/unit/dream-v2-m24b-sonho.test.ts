/** M24-B/§5.C — orquestração dreamV2 com engine MOCADO (vi.mock + vi.hoisted, padrão M18/S2).
 *  Prova: shape EXATO do item (§2.1.5), NOOP não escreve (LEI VI), dry-run, e ZERO LLM (LEI I). */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createHash } from "node:crypto";
import type { GraphData } from "../../src/core/platform/engine.ts";

// fns mocadas em vi.hoisted (sem TDZ) — único acesso externo do dreamV2 é o engine.
const m = vi.hoisted(() => ({
  graph: { nodes: [], edges: [] } as GraphData,
  addReviewItems: vi.fn(async (_rows: any[]) => {}),
}));

vi.mock("../../src/core/platform/engine.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/core/platform/engine.ts")>();
  return {
    ...actual,
    getEngine: vi.fn(async () => ({
      entityGraph: vi.fn(async () => m.graph),
      addReviewItems: m.addReviewItems,
    })),
  };
});

import { dreamV2 } from "../../src/core/memory/dream-v2.ts";

const node = (id: string) => ({ id, label: id, type: "assunto", date: "", exists: true, factCount: 3 });
const edge = (src: string, dst: string) => ({ src, dst, kind: "cooc", weight: 2 });
// 1 par elegível: a–b compartilham v1,v2 (sem ligação direta). v1–v2 também compartilhariam {a,b},
// mas estão LIGADOS diretamente (aresta v1–v2) ⇒ excluídos ("já ligados não é descoberta") — sobra a–b.
const RICH: GraphData = {
  nodes: ["a", "b", "v1", "v2"].map(node),
  edges: [edge("a", "v1"), edge("b", "v1"), edge("a", "v2"), edge("b", "v2"), edge("v1", "v2")],
};
const POOR: GraphData = { nodes: ["a", "b"].map(node), edges: [edge("a", "b")] };

beforeEach(() => {
  m.addReviewItems.mockClear();
});

describe("dreamV2 orquestração (M24-B §5.C)", () => {
  it("1. shape do item — addReviewItems 1× com item EXATO (§2.1.5)", async () => {
    m.graph = RICH;
    const r = await dreamV2("itest-m24b-sonho-mock", { minShared: 1 });
    expect(m.addReviewItems).toHaveBeenCalledTimes(1);
    const rows = m.addReviewItems.mock.calls[0][0];
    expect(rows.length).toBe(1);
    const item = rows[0];
    const expectedId = createHash("sha256").update(`sonho|a|b`).digest("hex").slice(0, 32);
    expect(item.id).toBe(expectedId);
    expect(item.reason).toBe("conexao_sugerida");
    expect(item.dimension).toBe("conexao");
    expect(item.source_id).toBe("");
    expect(item.source_slug).toBe("");
    expect(item.quote).toBe("");
    expect(item.status).toBe("pendente");
    expect(item.decided_by).toBe("");
    expect(item.decided_at).toBeNull();
    expect(item.claim.origem).toBe("sonho-v2");
    expect(item.claim.a).toBe("a");
    expect(item.claim.b).toBe("b");
    expect(item.claim.kind).toBe("conexao");
    expect(item.claim.shared).toEqual(expect.arrayContaining(["v1", "v2"]));
    expect(r.enqueued).toBe(1);
    expect(r.noop).toBe(false);
  });

  it("2. NOOP não escreve (LEI VI)", async () => {
    m.graph = POOR;
    const r = await dreamV2("itest-m24b-sonho-mock");
    expect(m.addReviewItems).not.toHaveBeenCalled();
    expect(r.noop).toBe(true);
    expect(r.enqueued).toBe(0);
    expect(r.hypotheses.length).toBe(0);
  });

  it("3. dry-run — enqueue:false não escreve, hypotheses preenchido", async () => {
    m.graph = RICH;
    const r = await dreamV2("itest-m24b-sonho-mock", { minShared: 1, enqueue: false });
    expect(m.addReviewItems).not.toHaveBeenCalled();
    expect(r.hypotheses.length).toBeGreaterThan(0);
    expect(r.enqueued).toBe(0);
    expect(r.noop).toBe(false);
  });

  it("4. zero LLM (LEI I) — módulo não exporta nem importa nada de LLM", async () => {
    const mod = await import("../../src/core/memory/dream-v2.ts");
    const exported = Object.keys(mod);
    // só exporta DREAM_DEFAULTS, predictLinks, detectClusters, dreamV2 (+ tipos, apagados em runtime)
    expect(exported.sort()).toEqual(["DREAM_DEFAULTS", "detectClusters", "dreamV2", "predictLinks"]);
    // assert estrutural: o source NÃO importa llm.ts/usage.ts
    const fs = await import("node:fs");
    const url = new URL("../../src/core/memory/dream-v2.ts", import.meta.url);
    const src = fs.readFileSync(url, "utf8");
    expect(src).not.toMatch(/llm\.ts|usage\.ts|galeed_llm_usage|prose|resolveProvider|structured/);
  });
});
