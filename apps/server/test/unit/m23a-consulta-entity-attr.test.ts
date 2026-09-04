/** M23-A (§4.3) — entity-attr: resolvedor DETERMINÍSTICO puro + surfaceEntity com confirm MOCADO.
 *  Prova: token raro de VALUE, guarda de frequência (df≤3), word-boundary/fold, empate ordenado,
 *  determinismo; surfaceEntity vencedora-única (zero LLM), empate (1 chamada confirm), fail-open. */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { structured, resolveProvider, config, recordUsage } = vi.hoisted(() => ({
  structured: vi.fn(),
  resolveProvider: vi.fn((p?: string) => (p === "cli" ? "cli" : "api")),
  config: vi.fn(() => ({ provider: "api", apiModel: "claude-haiku-4-5-20251001", cliModel: "haiku", synthModel: "synth-model" })),
  recordUsage: vi.fn(async () => {}),
}));

vi.mock("../../src/lib/llm.ts", () => ({ structured, resolveProvider }));
vi.mock("../../src/core/platform/config.ts", () => ({ config }));
vi.mock("../../src/core/platform/usage.ts", () => ({ recordUsage }));

import { entityCandidatesByAttributes, surfaceEntity, type AttrFact } from "../../src/core/retrieval/entity-attr.ts";

const SLUG = "chat-m23a-consulta-2";
function facts(): AttrFact[] {
  return [
    { entity: "eduardo-marinho", predicate: "plano", value: "Pocket", source_slug: SLUG },
    { entity: "eduardo-marinho", predicate: "aluno_de", value: "accelera 360", source_slug: SLUG },
    { entity: "teobaldo", predicate: "aluno_de", value: "accelera 360", source_slug: SLUG },
    { entity: "accelera", predicate: "preco", value: "R$ 12 mil", source_slug: SLUG },
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveProvider.mockImplementation((p?: string) => (p === "cli" ? "cli" : "api"));
  config.mockReturnValue({ provider: "api", apiModel: "claude-haiku-4-5-20251001", cliModel: "haiku", synthModel: "synth-model" } as any);
});

describe("entityCandidatesByAttributes (§2.2)", () => {
  it("1. 'pocket' → candidata única eduardo-marinho, hitTokens contém pocket, evidência plano=Pocket", () => {
    const c = entityCandidatesByAttributes("quem é o aluno que fechou o pocket?", facts());
    expect(c.length).toBe(1);
    expect(c[0].entity).toBe("eduardo-marinho");
    expect(c[0].hitTokens).toContain("pocket");
    expect(c[0].evidence.some((e) => e.predicate === "plano" && e.value === "Pocket")).toBe(true);
  });

  it("2. guarda de frequência — token em 4 entidades (df>3) NÃO é evidência → []", () => {
    const f: AttrFact[] = [
      { entity: "ent-a", predicate: "aluno_de", value: "accelera 360", source_slug: SLUG },
      { entity: "ent-b", predicate: "aluno_de", value: "accelera 360", source_slug: SLUG },
      { entity: "ent-c", predicate: "aluno_de", value: "accelera 360", source_slug: SLUG },
      { entity: "ent-d", predicate: "aluno_de", value: "accelera 360", source_slug: SLUG },
    ];
    expect(entityCandidatesByAttributes("quem é da accelera?", f)).toEqual([]);
  });

  it("3. empate — 2 entidades com plano=Pocket, mesmo score, ordenadas por entity asc", () => {
    const f: AttrFact[] = [
      { entity: "eduardo-marinho", predicate: "plano", value: "Pocket", source_slug: SLUG },
      { entity: "ana-souza", predicate: "plano", value: "Pocket", source_slug: SLUG },
    ];
    const c = entityCandidatesByAttributes("quem fechou o pocket?", f);
    expect(c.length).toBe(2);
    expect(c[0].score).toBe(c[1].score);
    expect(c.map((x) => x.entity)).toEqual(["ana-souza", "eduardo-marinho"]);
  });

  it("4. fold/word-boundary — 'Pócket' (acento) casa; 'pocketzinho' NÃO casa", () => {
    expect(entityCandidatesByAttributes("quem fechou o Pócket?", facts()).length).toBe(1);
    expect(entityCandidatesByAttributes("quem tem pocketzinho?", facts())).toEqual([]);
  });

  it("5. determinismo — 2 chamadas → toEqual", () => {
    const q = "quem é o aluno que fechou o pocket?";
    expect(entityCandidatesByAttributes(q, facts())).toEqual(entityCandidatesByAttributes(q, facts()));
  });
});

describe("surfaceEntity (§2.2)", () => {
  it("6. vencedora única → { via: atributos }, structured NÃO chamado (zero LLM)", async () => {
    const r = await surfaceEntity("home", "quem é o aluno que fechou o pocket?", facts());
    expect(r).toEqual({ entity: "eduardo-marinho", via: "atributos" });
    expect(structured).not.toHaveBeenCalled();
  });

  it("7. empate → confirm 1× com tool confirmar_entidade; slug aceito → via confirmacao", async () => {
    structured.mockResolvedValue({ entity: "eduardo-marinho" });
    const f: AttrFact[] = [
      { entity: "eduardo-marinho", predicate: "plano", value: "Pocket", source_slug: SLUG },
      { entity: "ana-souza", predicate: "plano", value: "Pocket", source_slug: SLUG },
    ];
    const r = await surfaceEntity("home", "quem fechou o pocket?", f);
    expect(structured).toHaveBeenCalledTimes(1);
    expect(structured.mock.calls[0][0].tool.name).toBe("confirmar_entidade");
    expect(r).toEqual({ entity: "eduardo-marinho", via: "confirmacao" });
  });

  it("8. confirm fora das empatadas / vazio / throw → null (fail-open)", async () => {
    const f: AttrFact[] = [
      { entity: "eduardo-marinho", predicate: "plano", value: "Pocket", source_slug: SLUG },
      { entity: "ana-souza", predicate: "plano", value: "Pocket", source_slug: SLUG },
    ];
    structured.mockResolvedValue({ entity: "fora-das-empatadas" });
    expect(await surfaceEntity("home", "quem fechou o pocket?", f)).toBeNull();
    structured.mockResolvedValue({ entity: "" });
    expect(await surfaceEntity("home", "quem fechou o pocket?", f)).toBeNull();
    structured.mockRejectedValue(new Error("boom"));
    expect(await surfaceEntity("home", "quem fechou o pocket?", f)).toBeNull();
  });

  it("9. 0 candidatas → null e structured NÃO chamado", async () => {
    const r = await surfaceEntity("home", "o que a aceleradora fez?", facts());
    expect(r).toBeNull();
    expect(structured).not.toHaveBeenCalled();
  });

  it("10. meter da confirmação → recordUsage op ask:entity", async () => {
    let captured: ((ev: any) => void) | undefined;
    structured.mockImplementation(async (opts: any) => {
      captured = opts.meter;
      return { entity: "eduardo-marinho" };
    });
    const f: AttrFact[] = [
      { entity: "eduardo-marinho", predicate: "plano", value: "Pocket", source_slug: SLUG },
      { entity: "ana-souza", predicate: "plano", value: "Pocket", source_slug: SLUG },
    ];
    await surfaceEntity("home", "quem fechou o pocket?", f);
    expect(captured).toBeTypeOf("function");
    captured!({ provider: "api", model: "m", tokensIn: 1, tokensOut: 2 });
    expect(recordUsage).toHaveBeenCalledWith("home", expect.objectContaining({ op: "ask:entity" }));
  });
});
