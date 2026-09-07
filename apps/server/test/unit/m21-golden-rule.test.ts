/** M21/S2 — a REGRA DE OURO da ingestão com contrato (ADR-016), no gate PURO (sem DB, sem LLM):
 *  o que as regras reconhecem E ancoram vira fato; o que não casa vai pra revisar —
 *  nunca fato sozinho, nunca descarte silencioso. Casos do DESIGN-SPEC §8 + asserts do CONTRACT. */
import { describe, it, expect } from "vitest";
import { applyFilterGate, filterGuidance } from "../../src/core/ingestion/golden-rule.ts";
import type { SourceFilter } from "../../src/core/platform/engine.ts";

const BODY =
  "Reunião de preço: o valor da Accelera subiu para 30000 reais no tier executivo, " +
  "decisão tomada pela diretoria em conjunto com o financeiro.";

const RECIPE: SourceFilter = {
  fields: [{ dimension: "decisoes", label: "decisão tomada", area: "produto" }],
};

/** triple ancorado: quote VERBATIM do body + value_num presente literalmente no body. */
const CLAIM_OK = {
  text: "preço da Accelera subiu pra 30000 no tier executivo",
  entity: "accelera",
  predicate: "preco",
  value: "30000 reais",
  value_num: 30000,
  context_quote: "o valor da Accelera subiu para 30000 reais no tier executivo",
};

describe("applyFilterGate — o gate da regra de ouro (puro)", () => {
  it("1. filtro=null (job sem fonte) ⇒ pass-through byte-idêntico: approved deep-equal, rejected=[]", () => {
    const merged = { decisoes: [{ ...CLAIM_OK }], fofoca: [{ text: "qualquer coisa" }] };
    const out = applyFilterGate(merged, null, "", "pg-1", BODY);
    expect(out.approved).toEqual(merged); // deep-equal ao input — NADA injetado, NADA filtrado
    expect(out.rejected).toEqual([]);
    expect(out.counts).toEqual({ approved: 2, rejected: 0 });
  });

  it("2. dimensão fora do filtro ⇒ rejeitado reason='fora_do_filtro' (e NÃO está em approved)", () => {
    const merged = { fofoca: [{ ...CLAIM_OK }] }; // quote/número ancorados, mas a dim não é do filtro
    const out = applyFilterGate(merged, RECIPE, "f1", "pg-1", BODY);
    expect(out.approved.fofoca).toEqual([]);
    expect(out.rejected).toHaveLength(1);
    expect(out.rejected[0].reason).toBe("fora_do_filtro");
    expect(out.rejected[0].dimension).toBe("fofoca");
    expect(out.rejected[0].source_id).toBe("f1");
    expect(out.rejected[0].status).toBe("pendente");
    expect(out.counts).toEqual({ approved: 0, rejected: 1 });
  });

  it("3. triple com quote verbatim + value_num presente no body ⇒ aprovado com source_id injetado", () => {
    const merged = { decisoes: [{ ...CLAIM_OK }] };
    const out = applyFilterGate(merged, RECIPE, "f1", "pg-1", BODY);
    expect(out.rejected).toEqual([]);
    expect(out.approved.decisoes).toHaveLength(1);
    expect(out.approved.decisoes[0].source_id).toBe("f1"); // CONTRACT: o carimbo viaja no claim
    expect(out.approved.decisoes[0].entity).toBe("accelera"); // o resto do claim intacto
    expect(out.counts).toEqual({ approved: 1, rejected: 0 });
  });

  it("4. triple com quote inventado ⇒ rejeitado reason='nao_ancorado'", () => {
    const merged = {
      decisoes: [
        {
          ...CLAIM_OK,
          context_quote: "o churn despencou pela metade depois daquela migração gigantesca de plataforma",
        },
      ],
    };
    const out = applyFilterGate(merged, RECIPE, "f1", "pg-1", BODY);
    expect(out.approved.decisoes).toEqual([]);
    expect(out.rejected).toHaveLength(1);
    expect(out.rejected[0].reason).toBe("nao_ancorado");
  });

  it("5. triple com value_num que NÃO está no body ⇒ rejeitado 'nao_ancorado' (valueIsAnchored)", () => {
    const merged = {
      decisoes: [{ ...CLAIM_OK, value: "12345 reais", value_num: 12345 }], // quote verbatim, número não
    };
    const out = applyFilterGate(merged, RECIPE, "f1", "pg-1", BODY);
    expect(out.approved.decisoes).toEqual([]);
    expect(out.rejected).toHaveLength(1);
    expect(out.rejected[0].reason).toBe("nao_ancorado");
  });

  it("6. sem triple: quote verbatim ⇒ aprovado (vira 'registrado' no motor); sem quote ⇒ 'nao_ancorado'", () => {
    const merged = {
      decisoes: [
        { text: "decisão tomada pela diretoria", context_quote: "decisão tomada pela diretoria" }, // verbatim
        { text: "observação solta sem nenhum trecho da fonte" }, // sem quote
      ],
    };
    const out = applyFilterGate(merged, RECIPE, "f1", "pg-1", BODY);
    expect(out.approved.decisoes).toHaveLength(1);
    expect(out.approved.decisoes[0].source_id).toBe("f1");
    expect(out.rejected).toHaveLength(1);
    expect(out.rejected[0].reason).toBe("nao_ancorado");
    expect(out.counts).toEqual({ approved: 1, rejected: 1 });
  });

  it("7. ids determinísticos: 2 runs sobre o MESMO input ⇒ mesmos rejected[].id (idempotência M16)", () => {
    const merged = {
      fofoca: [{ ...CLAIM_OK }],
      decisoes: [{ text: "sem quote nenhum" }],
    };
    const a = applyFilterGate(merged, RECIPE, "f1", "pg-1", BODY);
    const b = applyFilterGate(merged, RECIPE, "f1", "pg-1", BODY);
    expect(a.rejected.length).toBeGreaterThan(0);
    expect(a.rejected.map((r) => r.id)).toEqual(b.rejected.map((r) => r.id));
    for (const r of a.rejected) expect(r.id).toMatch(/^[0-9a-f]{32}$/); // sha256 truncado, não uuid
  });
});

describe("filterGuidance — filtro → orientação de prompt (determinístico)", () => {
  it("8a. filtro com 2 fields ⇒ contém as 2 linhas (+ guidance do tenant quando presente)", () => {
    const filtro: SourceFilter = {
      fields: [
        { dimension: "decisoes", label: "decisão tomada", area: "produto" },
        { dimension: "metricas", label: "métrica reportada", area: "" },
      ],
      guidance: "Priorize valores em reais.",
    };
    const g = filterGuidance(filtro);
    expect(g).toContain("- decisoes: decisão tomada (área destino: produto)");
    expect(g).toContain("- metricas: métrica reportada");
    expect(g).not.toContain("metricas: métrica reportada (área"); // area "" ⇒ sem sufixo de área
    expect(g).toContain("Priorize valores em reais.");
    expect(g.startsWith("\n\nFILTRO DESTA FONTE")).toBe(true);
  });

  it("8b. null e filtro vazio (sem fields, sem guidance) ⇒ '' (prompt idêntico ao atual)", () => {
    expect(filterGuidance(null)).toBe("");
    expect(filterGuidance({ fields: [] })).toBe("");
  });
});

describe("modo livre — filtro sem fields (fix do baseline D)", () => {
  it("filtro com fields:[] é pass-through (fonte de ingestor nasce livre; filtro só gateia quando define dims)", () => {
    const merged = {
      decisions: [{ text: "Decidiu focar em premium porque clientes citam confiança", context_quote: "focar em premium" }],
      facts: [{ text: "CPL caiu pra R$ 12", context_quote: "CPL", entity: "x", predicate: "cpl", value: "R$ 12", value_num: 12 }],
    };
    const r = applyFilterGate(merged, { fields: [] }, "src-1", "pagina", "focar em premium CPL");
    expect(r.counts).toEqual({ approved: 2, rejected: 0 });
    expect(r.approved).toEqual(merged);
    expect(r.rejected).toEqual([]);
  });
});
