/** M25-B/unit — puros do juiz triador + LEI 1 ESTRUTURAL (sem DB, sem LLM).
 *  §8.2 da DESIGN-SPEC. Tenant-neutro: nada de "accelera" aqui. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  judgeConfig,
  excerptAround,
  JUDGE_TOOL,
  validateJudgeOutput,
} from "../../src/core/ingestion/review-judge.ts";

describe("M25-B/judgeConfig — envs com default, parsing defensivo", () => {
  const SNAP = () => ({ ...process.env });
  const restore = (s: NodeJS.ProcessEnv) => {
    for (const k of ["GALEED_JUDGE_MODEL", "ANTHROPIC_MODEL", "GALEED_JUDGE_BATCH_THRESHOLD", "GALEED_JUDGE_K_MEMORIA", "GALEED_JUDGE_JANELA_CORPO"]) {
      if (s[k] === undefined) delete process.env[k];
      else process.env[k] = s[k];
    }
  };

  it("env ausente → defaults (haiku, 50, 6, 800)", () => {
    const s = SNAP();
    delete process.env.GALEED_JUDGE_MODEL;
    delete process.env.ANTHROPIC_MODEL;
    delete process.env.GALEED_JUDGE_BATCH_THRESHOLD;
    delete process.env.GALEED_JUDGE_K_MEMORIA;
    delete process.env.GALEED_JUDGE_JANELA_CORPO;
    const c = judgeConfig();
    expect(c.model).toBe("claude-haiku-4-5-20251001");
    expect(c.batchThreshold).toBe(50);
    expect(c.kMemoria).toBe(6);
    expect(c.janelaCorpo).toBe(800);
    restore(s);
  });

  it("ANTHROPIC_MODEL é o fallback do modelo", () => {
    const s = SNAP();
    delete process.env.GALEED_JUDGE_MODEL;
    process.env.ANTHROPIC_MODEL = "claude-sonnet-4-5-20250929";
    expect(judgeConfig().model).toBe("claude-sonnet-4-5-20250929");
    restore(s);
  });

  it("env setado → lido", () => {
    const s = SNAP();
    process.env.GALEED_JUDGE_MODEL = "modelo-x";
    process.env.GALEED_JUDGE_BATCH_THRESHOLD = "20";
    process.env.GALEED_JUDGE_K_MEMORIA = "3";
    process.env.GALEED_JUDGE_JANELA_CORPO = "1200";
    const c = judgeConfig();
    expect(c.model).toBe("modelo-x");
    expect(c.batchThreshold).toBe(20);
    expect(c.kMemoria).toBe(3);
    expect(c.janelaCorpo).toBe(1200);
    restore(s);
  });

  it("NaN/≤0 → default", () => {
    const s = SNAP();
    process.env.GALEED_JUDGE_BATCH_THRESHOLD = "abc";
    process.env.GALEED_JUDGE_K_MEMORIA = "0";
    process.env.GALEED_JUDGE_JANELA_CORPO = "-5";
    const c = judgeConfig();
    expect(c.batchThreshold).toBe(50);
    expect(c.kMemoria).toBe(6);
    expect(c.janelaCorpo).toBe(800);
    restore(s);
  });
});

describe("M25-B/excerptAround — janela em volta da quote", () => {
  const big = "x".repeat(16000) + "ÂNCORA-DA-QUOTE" + "y".repeat(17000); // ~33k chars

  it("quote no meio de 33k → janela ±400 com reticências e a quote DENTRO", () => {
    const out = excerptAround(big, "ÂNCORA-DA-QUOTE", 800);
    expect(out).toContain("ÂNCORA-DA-QUOTE");
    expect(out.startsWith("…")).toBe(true);
    expect(out.endsWith("…")).toBe(true);
    // ~800 chars + 2 reticências
    expect(out.length).toBeLessThanOrEqual(805);
    expect(out.length).toBeGreaterThan(700);
  });

  it("quote vazia → primeiros 800", () => {
    const out = excerptAround(big, "", 800);
    expect(out.length).toBe(800);
    expect(out.startsWith("x")).toBe(true);
  });

  it("quote não encontrada → primeiros 800", () => {
    const out = excerptAround(big, "NAO-EXISTE-NO-CORPO", 800);
    expect(out.length).toBe(800);
    expect(out.startsWith("x")).toBe(true);
  });

  it("body menor que a janela → body inteiro (sem reticências)", () => {
    const out = excerptAround("corpo curto", "curto", 800);
    expect(out).toBe("corpo curto");
  });
});

describe("M25-B/JUDGE_TOOL — schema exato", () => {
  it("enum e required cravados", () => {
    const props: any = JUDGE_TOOL.input_schema.properties;
    expect(props.recomendacao.enum).toEqual(["aprovar", "descartar", "humano"]);
    expect(JUDGE_TOOL.input_schema.required).toEqual(["recomendacao", "motivo", "confianca"]);
    expect(JUDGE_TOOL.name).toBe("recomendar_triagem");
  });
});

describe("M25-B/validateJudgeOutput — validação defensiva", () => {
  it("confianca 1.7 → clamp 1", () => {
    const out = validateJudgeOutput({ recomendacao: "aprovar", motivo: "ok", confianca: 1.7 });
    expect(out?.confianca).toBe(1);
  });

  it("confianca -0.5 → clamp 0", () => {
    const out = validateJudgeOutput({ recomendacao: "descartar", motivo: "ok", confianca: -0.5 });
    expect(out?.confianca).toBe(0);
  });

  it("recomendacao inválida ('aprova') → null (não persiste)", () => {
    expect(validateJudgeOutput({ recomendacao: "aprova", motivo: "x", confianca: 0.5 })).toBeNull();
  });

  it("motivo 1k chars → truncado em 280", () => {
    const out = validateJudgeOutput({ recomendacao: "humano", motivo: "a".repeat(1000), confianca: 0.4 });
    expect(out?.motivo.length).toBe(280);
  });

  it("objeto vazio/null → null", () => {
    expect(validateJudgeOutput(null)).toBeNull();
    expect(validateJudgeOutput({})).toBeNull();
  });
});

describe("M25-B/custom_id = id do item (hex32)", () => {
  it("id hex32 real casa ^[a-zA-Z0-9_-]{1,64}$", () => {
    const id = "68519d8af8ad80079a7034da2e371b5c";
    expect(/^[a-zA-Z0-9_-]{1,64}$/.test(id)).toBe(true);
  });
});

describe("M25-B/LEI 1 — assert ESTRUTURAL (zero aprovação automática)", () => {
  const fonte = readFileSync(
    new URL("../../src/core/ingestion/review-judge.ts", import.meta.url),
    "utf8",
  );

  it("o módulo NÃO contém setReviewStatus/approveReviewItem/discardReviewItem", () => {
    expect(fonte).not.toContain("setReviewStatus");
    expect(fonte).not.toContain("approveReviewItem");
    expect(fonte).not.toContain("discardReviewItem");
  });

  it("nenhum UPDATE em galeed_ingest_review toca a coluna status", () => {
    // o juiz só muda status de galeed_judge_batches (lote: 'erro'/'colhido') — NUNCA da fila de revisão.
    // status de review aparece SÓ em predicados de leitura/DDL (where status='pendente', etc.), nunca
    // num SET. Provamos isso varrendo cada SET de update da fila de revisão.
    const re = /update\s+galeed_ingest_review[\s\S]*?set([\s\S]*?)where/gi;
    let m: RegExpExecArray | null;
    let n = 0;
    while ((m = re.exec(fonte))) {
      n++;
      expect(/\bstatus\s*=/i.test(m[1])).toBe(false); // o SET de review NUNCA toca status
    }
    expect(n).toBeGreaterThan(0);
  });

  it("o único UPDATE em galeed_ingest_review seta SÓ colunas judge_*", () => {
    // localiza os blocos 'update galeed_ingest_review ... set ...' e prova que só tocam judge_*/judged_at.
    const re = /update\s+galeed_ingest_review[\s\S]*?set([\s\S]*?)where/gi;
    let m: RegExpExecArray | null;
    let n = 0;
    while ((m = re.exec(fonte))) {
      n++;
      const setClause = m[1];
      // toda atribuição no SET é a uma coluna judge_* ou judged_at
      const cols = setClause.match(/(\w+)\s*=/g) ?? [];
      for (const c of cols) {
        expect(/^(judge_recommendation|judge_reason|judge_confidence|judge_model|judge_memory_n|judged_at)\b/.test(c.trim())).toBe(true);
      }
    }
    expect(n).toBeGreaterThan(0); // existe ao menos 1 update de review (o de §3.7)
  });
});
