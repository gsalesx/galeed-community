/** M23-A (§4.5) — factsForQueryStaged + surfacing contra o Postgres REAL (:5434). Invariante #9:
 *  dado persistido via engine real (seedM23aConsulta). Mock PARCIAL de ground.ts: detectComposite/
 *  independentEntities REAIS, groundQuestion substituível por caso — a integração NÃO chama LLM real
 *  (o LLM real é o §4.6). Brain descartável `itest-m23a-consulta`; banco COMPARTILHADO (só toca o
 *  brain de teste). */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const { groundMock } = vi.hoisted(() => ({ groundMock: vi.fn() }));

vi.mock("../../src/core/retrieval/ground.ts", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../../src/core/retrieval/ground.ts")>();
  return { ...orig, groundQuestion: groundMock };
});

import { hasDb, wipeBrain, rawConnect } from "./helpers/db.ts";
import { closeEngines } from "../../src/core/platform/engine.ts";
import { factsForQuery, factsForQueryStaged } from "../../src/core/retrieval/ask.ts";
import { seedM23aConsulta } from "./helpers/seed-m23a-consulta.ts";

const BRAIN = "itest-m23a-consulta";

async function usageCount(): Promise<number> {
  const sql = await rawConnect();
  try {
    const r = await sql.unsafe(
      `select count(*)::int as n from galeed_llm_usage where brain = $1 and op in ('ask:ground','ask:entity')`,
      [BRAIN],
    );
    return (r[0] as any).n as number;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

describe.skipIf(!hasDb())("M23-A staged contra o Postgres real (§4.5)", () => {
  beforeAll(async () => {
    await seedM23aConsulta(BRAIN);
  });
  afterAll(async () => {
    await wipeBrain(BRAIN);
    await closeEngines();
  });

  it("1. simples intocada + zero LLM", async () => {
    groundMock.mockReset();
    const staged = await factsForQueryStaged(BRAIN, "qual o preço da accelera?");
    expect(staged.staged.kind).toBe("simples");
    const single = await factsForQuery(BRAIN, "qual o preço da accelera?");
    expect(staged.block).toBe(single.block);
    expect(groundMock).not.toHaveBeenCalled();
    expect(await usageCount()).toBe(0);
  });

  it("2. composta rotulada com engine real", async () => {
    groundMock.mockResolvedValue({ subs: ["quando o teobaldo entrou na accelera?", "qual era o preço da accelera em março de 2024?"] });
    const staged = await factsForQueryStaged(BRAIN, "quanto custava a accelera quando o teobaldo entrou?");
    expect(staged.staged.kind).toBe("composta");
    expect(staged.block).toContain("PERGUNTA COMPOSTA");
    expect(staged.block).toContain("[S1]");
    expect(staged.block).toContain("desde 2024-04-02");
    expect(staged.block).toContain("[S2]");
    expect(staged.block).toContain("recorte temporal da pergunta: 2024-03");
    expect(staged.block).toContain("12000");
    const s2 = staged.block.slice(staged.block.indexOf("[S2]"));
    expect(s2).not.toContain("30000");
    expect(staged.entities).toContain("teobaldo");
    expect(staged.entities).toContain("accelera");
  });

  it("3. fail-open byte-idêntico — groundQuestion null → block = single-shot", async () => {
    groundMock.mockResolvedValue(null);
    const staged = await factsForQueryStaged(BRAIN, "quanto custava a accelera quando o teobaldo entrou?");
    const single = await factsForQuery(BRAIN, "quanto custava a accelera quando o teobaldo entrou?");
    expect(staged.block).toBe(single.block);
  });

  it("4. surfacing real, zero LLM (candidata única)", async () => {
    const r = await factsForQuery(BRAIN, "quem é o aluno que fechou o pocket?");
    expect(r.entities).toEqual(["eduardo-marinho"]);
    expect(r.surfaced).toBe("eduardo-marinho");
    expect(r.block).toContain("(entidade localizada por atributos: eduardo-marinho");
    expect(r.block).toContain("Pocket");
    expect(await usageCount()).toBe(0);
  });

  it("5. fail-open do surfacing — shape EXATO do P1-B (sem chave surfaced)", async () => {
    const r = await factsForQuery(BRAIN, "o que a aceleradora fez?");
    expect(r).toEqual({ block: "", entities: [] });
  });

  it("6. determinismo — casos 2 e 4 2× → block byte-idêntico", async () => {
    groundMock.mockResolvedValue({ subs: ["quando o teobaldo entrou na accelera?", "qual era o preço da accelera em março de 2024?"] });
    const a = await factsForQueryStaged(BRAIN, "quanto custava a accelera quando o teobaldo entrou?");
    const b = await factsForQueryStaged(BRAIN, "quanto custava a accelera quando o teobaldo entrou?");
    expect(a.block).toBe(b.block);
    const c = await factsForQuery(BRAIN, "quem é o aluno que fechou o pocket?");
    const d = await factsForQuery(BRAIN, "quem é o aluno que fechou o pocket?");
    expect(c.block).toBe(d.block);
  });
});
