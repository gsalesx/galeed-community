/** M25-B/unit — o few-shot MUDA o prompt (a metade determinística do gate de memória). §8.3.
 *  Itens/fontes/decisões SINTÉTICOS — tenant-neutro (nada de "accelera"). Sem DB, sem LLM. */
import { describe, it, expect } from "vitest";
import {
  buildJudgePrompt,
  JUDGE_TOOL,
  type DecisaoMemoria,
} from "../../src/core/ingestion/review-judge.ts";
import { buildMessagesBody } from "../../src/lib/anthropic.ts";
import type { ReviewItemRow, SourceRow } from "../../src/core/platform/engine.ts";

const item = (extra: Partial<ReviewItemRow> = {}): ReviewItemRow => ({
  id: "abc123",
  source_id: "src-1",
  source_slug: "pag-1",
  dimension: "precos",
  text: "preço do produto X subiu para 100",
  quote: "subiu pra cem reais agora",
  claim: { text: "preço do produto X subiu para 100", value_num: 100 },
  reason: "fora_da_receita",
  status: "pendente",
  decided_by: "",
  decided_at: null,
  ...extra,
});

const source = (extra: Partial<SourceRow> = {}): SourceRow => ({
  id: "src-1",
  name: "Reuniões internas",
  channel: "upload",
  type: "reunioes",
  recipe: { fields: [{ dimension: "decisoes", label: "decisão tomada", area: "estrategia" }] },
  default_sensitivity: "interno",
  status: "ativa",
  last_read_at: null,
  ...extra,
});

const dec = (extra: Partial<DecisaoMemoria> = {}): DecisaoMemoria => ({
  id: "d1",
  dimension: "precos",
  source_id: "src-1",
  reason: "fora_da_receita",
  text: "preço antigo do plano",
  quote: "custava trinta\nlinha 2",
  decisao: "aprovada",
  decided_by: "dono@x.com",
  ...extra,
});

describe("M25-B/buildJudgePrompt — sem memória", () => {
  it("avisa ausência de precedentes (LEI 3) e NÃO traz blocos APROVOU/DESCARTOU", () => {
    const { prompt } = buildJudgePrompt(item(), source(), "trecho do corpo", []);
    expect(prompt).toContain("ainda NÃO tem decisões passadas");
    expect(prompt).not.toContain("O dono APROVOU");
    expect(prompt).not.toContain("O dono DESCARTOU");
  });
});

describe("M25-B/buildJudgePrompt — com memória", () => {
  it("2 aprovadas + 1 descartada → os DOIS blocos, com text+reason, na ordem dada", () => {
    const memoria: DecisaoMemoria[] = [
      dec({ id: "a1", text: "aprovada um", decisao: "aprovada" }),
      dec({ id: "a2", text: "aprovada dois", decisao: "aprovada" }),
      dec({ id: "x1", text: "descartada um", decisao: "descartada" }),
    ];
    const { prompt } = buildJudgePrompt(item(), source(), "trecho", memoria);
    expect(prompt).toContain("O dono APROVOU no passado:");
    expect(prompt).toContain("O dono DESCARTOU:");
    expect(prompt).toContain("aprovada um");
    expect(prompt).toContain("aprovada dois");
    expect(prompt).toContain("descartada um");
    expect(prompt).toContain("[motivo: fora_da_receita]");
    // ordem dada (buildJudgePrompt NÃO reordena): "aprovada um" antes de "aprovada dois"
    expect(prompt.indexOf("aprovada um")).toBeLessThan(prompt.indexOf("aprovada dois"));
    // só a 1ª linha da quote entra (firstLine)
    expect(prompt).toContain("custava trinta");
    expect(prompt).not.toContain("linha 2");
  });
});

describe("M25-B/buildJudgePrompt — receita e fonte ausente", () => {
  it("receita presente → recipeGuidance aparece", () => {
    const { prompt } = buildJudgePrompt(item(), source(), "trecho", []);
    expect(prompt).toContain("RECEITA DESTA FONTE");
    expect(prompt).toContain("decisoes");
    expect(prompt).toContain("Reuniões internas");
  });

  it("fonte undefined (conexao_sugerida) → 'item sem fonte (hipótese do sonho)' e zero crash com quote/slug vazios", () => {
    const conexao = item({ reason: "conexao_sugerida", source_id: "", source_slug: "", quote: "", dimension: "conexao" });
    const { prompt } = buildJudgePrompt(conexao, undefined, "", []);
    expect(prompt).toContain("item sem fonte (hipótese do sonho)");
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
  });
});

describe("M25-B/buildJudgePrompt — untrusted", () => {
  it("claim/quote/excerpt DENTRO de «DADOS»; papel/critério FORA", () => {
    const { prompt } = buildJudgePrompt(item(), source(), "TRECHO-DO-CORPO", []);
    // marcadores reais de prompt-safety.ts
    expect(prompt).toContain("«DADOS»");
    expect(prompt).toContain("«/DADOS»");
    // o excerpt está dentro de um bloco DADOS
    const blocos = prompt.split("«DADOS»").slice(1).map((b) => b.split("«/DADOS»")[0]);
    const dentro = blocos.join("\n");
    expect(dentro).toContain("TRECHO-DO-CORPO");
    expect(dentro).toContain("subiu pra cem reais agora"); // quote
    expect(dentro).toContain("preço do produto X subiu para 100"); // claim json
    // instruções FORA do untrusted
    expect(prompt).toContain("você NUNCA decide");
    expect(prompt).toContain("CRITÉRIO:");
  });
});

describe("M25-B/LEI 5 — mesmo corpo sync↔batch", () => {
  it("buildMessagesBody com os MESMOS args produz params deep-equal", () => {
    const { prompt, system } = buildJudgePrompt(item(), source(), "trecho", []);
    const model = "claude-haiku-4-5-20251001";
    const syncBody = buildMessagesBody(model, prompt, JUDGE_TOOL, system);
    const batchParams = buildMessagesBody(model, prompt, JUDGE_TOOL, system);
    expect(batchParams).toEqual(syncBody);
    // tool_choice forçado pra tool única
    expect((syncBody as any).tool_choice).toEqual({ type: "tool", name: "recomendar_triagem" });
  });
});
