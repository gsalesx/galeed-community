/** INVARIANTE CENTRAL: supersessão bitemporal (indexer.ts → applyBitemporal).
 *  É o coração da verdade do Galeed — "como o cérebro muda de ideia". Determinístico, função pura
 *  sobre FactRow[]. Uma regressão aqui corrompe a memória do cliente SEM acusar. Travamos as 7
 *  propriedades que a verdade tem que respeitar. */
import { describe, it, expect } from "vitest";
import { applyBitemporal } from "../../src/core/retrieval/indexer.ts";
import type { FactRow } from "../../src/core/platform/engine.ts";

/** fábrica de FactRow com defaults sãos (status "fato", confiança base). */
function fact(p: Partial<FactRow>): FactRow {
  return {
    source_slug: "s1",
    type: "reunioes",
    dimension: "facts",
    idx: 0,
    text: "",
    quote: "",
    meta: {},
    entity: "acme",
    predicate: "preco_mensal",
    value: "",
    valid_from: "",
    valid_to: "",
    confidence: 0.6,
    status: "fato",
    ...p,
  };
}

describe("applyBitemporal — supersessão por mudança de valor", () => {
  it("valor novo arquiva o antigo e vira a verdade vigente", () => {
    const fs = [
      fact({ source_slug: "jan", value: "499", valid_from: "2026-01-01" }),
      fact({ source_slug: "mar", value: "599", valid_from: "2026-03-01" }),
    ];
    applyBitemporal(fs);
    const [jan, mar] = fs;
    expect(jan.status).toBe("arquivado");
    expect(jan.valid_to).toBe("2026-03-01"); // fecha quando o novo começa
    expect(mar.status).toBe("fato");
    expect(mar.valid_to).toBe(""); // "" = vigente / verdade atual
  });

  it("ordena por valid_from independente da ordem de entrada (a data manda, não a inserção)", () => {
    const fs = [
      fact({ source_slug: "mar", value: "599", valid_from: "2026-03-01" }),
      fact({ source_slug: "jan", value: "499", valid_from: "2026-01-01" }),
    ];
    applyBitemporal(fs);
    const jan = fs.find((f) => f.source_slug === "jan")!;
    const mar = fs.find((f) => f.source_slug === "mar")!;
    expect(jan.status).toBe("arquivado");
    expect(mar.valid_to).toBe("");
  });
});

describe("applyBitemporal — corroboração (mesmo valor, fontes distintas)", () => {
  it("sobe a confiança e NÃO arquiva (não é mudança de ideia)", () => {
    const fs = [
      fact({ source_slug: "call_a", value: "499", valid_from: "2026-01-01", confidence: 0.6 }),
      fact({ source_slug: "call_b", value: "499", valid_from: "2026-02-01", confidence: 0.6 }),
    ];
    applyBitemporal(fs);
    expect(fs[0].status).not.toBe("arquivado");
    expect(fs[0].confidence).toBeGreaterThan(0.6); // corroboração de fonte distinta
    expect(fs[1].confidence).toBe(fs[0].confidence); // a versão repetida herda a confiança
  });

  it("formas diferentes do MESMO valor (R$ 499 ≡ 499) corroboram, não supersedem", () => {
    const fs = [
      fact({ source_slug: "a", value: "R$ 499", valid_from: "2026-01-01" }),
      fact({ source_slug: "b", value: "499", valid_from: "2026-02-01" }),
    ];
    applyBitemporal(fs);
    expect(fs[0].status).not.toBe("arquivado"); // normalizeValue colapsa → sem supersessão espúria
    expect(fs[0].confidence).toBeGreaterThan(0.6);
  });
});

describe("applyBitemporal — duplicata exata da mesma fonte", () => {
  it("colapsa (status 'duplicata') — não infla confiança nem cria versão", () => {
    const fs = [
      fact({ source_slug: "s1", value: "499", valid_from: "2026-01-01", confidence: 0.6 }),
      fact({ source_slug: "s1", value: "499", valid_from: "2026-01-01", confidence: 0.6 }),
    ];
    applyBitemporal(fs);
    expect(fs[1].status).toBe("duplicata");
    expect(fs[0].confidence).toBe(0.6); // mesma fonte NÃO corrobora
  });
});

describe("applyBitemporal — fato não-verificado (R5) não entra na cadeia", () => {
  it("não supersede nem corrobora (anti-alucinação não move a verdade)", () => {
    const fs = [
      fact({ source_slug: "ok", value: "499", valid_from: "2026-01-01" }),
      fact({ source_slug: "halluc", value: "9999", valid_from: "2026-03-01", status: "nao-verificado" }),
    ];
    applyBitemporal(fs);
    const ok = fs.find((f) => f.source_slug === "ok")!;
    const halluc = fs.find((f) => f.source_slug === "halluc")!;
    expect(ok.status).toBe("fato"); // NÃO foi arquivado por um fato não ancorado
    expect(ok.valid_to).toBe(""); // segue vigente
    expect(halluc.status).toBe("nao-verificado"); // intacto, fora da cadeia
  });
});

describe("applyBitemporal — fato SEM data ordena como o mais antigo", () => {
  it("o fato datado vence a currency; o sem-data não supersede o datado", () => {
    const fs = [
      fact({ source_slug: "undated", value: "499", valid_from: "" }),
      fact({ source_slug: "dated", value: "599", valid_from: "2026-03-01" }),
    ];
    applyBitemporal(fs);
    const dated = fs.find((f) => f.source_slug === "dated")!;
    expect(dated.valid_to).toBe(""); // o datado é a verdade vigente
  });
});

describe("applyBitemporal — fatos standalone (sem entity/predicate) são ignorados", () => {
  it("não agrupa nem muta fatos sem (entity, predicate)", () => {
    const fs = [
      fact({ entity: "", predicate: "", value: "nota livre A", status: "registrado" }),
      fact({ entity: "", predicate: "", value: "nota livre B", status: "registrado" }),
    ];
    applyBitemporal(fs);
    expect(fs.every((f) => f.status === "registrado")).toBe(true);
    expect(fs.every((f) => f.valid_to === "")).toBe(true);
  });
});

// ─── P1-A: a LEI da supersessão v2 (describes ADICIONADOS; os 7 acima passam sem edição) ───

/** fábrica NUMÉRICA (value_num + value coerentes — pegadinha §10: sem value_num o sameFactValue
 *  cai no normalizeValue por string). */
function nfact(p: Partial<FactRow> & { value_num: number }): FactRow {
  return fact({ value: String(p.value_num), unit: "BRL", period: "monthly", ...p });
}

describe("applyBitemporal — L1: EXATAMENTE 1 vigente por grupo", () => {
  it("5k(src1,jan)→5k(src2,fev)→12k(src3,mar): 1 só 'fato', elos corroborados fechados", () => {
    const fs = [
      nfact({ source_slug: "src1", value_num: 5000, valid_from: "2026-01-01" }),
      nfact({ source_slug: "src2", value_num: 5000, valid_from: "2026-02-01" }),
      nfact({ source_slug: "src3", value_num: 12000, valid_from: "2026-03-01" }),
    ];
    applyBitemporal(fs);
    const src1 = fs.find((f) => f.source_slug === "src1")!;
    const src2 = fs.find((f) => f.source_slug === "src2")!;
    const src3 = fs.find((f) => f.source_slug === "src3")!;
    // exatamente 1 vigente (status='fato' AND valid_to='')
    const vigentes = fs.filter((f) => f.status === "fato" && f.valid_to === "");
    expect(vigentes).toHaveLength(1);
    expect(vigentes[0].source_slug).toBe("src3");
    // src1(5k): sucessor src2(5k) MESMO valor → corroborado, fecha no início de src2 (§1.2c)
    expect(src1.status).toBe("corroborado");
    expect(src1.valid_to).toBe("2026-02-01");
    // src2(5k): sucessor src3(12k) valor MUDA → 'arquivado' (degrau/supersessão — §1.2c: status
    // é função do PAR elo↔sucessor imediato; o degrau que HOJE vaza fica fechado, não vigente).
    // [NOTA-DEV: a prose do §6.2 dizia 'corroborado' p/ src2, mas o algoritmo-contrato §1.2c e a
    //  tabela canônica §6.3 ('degraus com arquivado') mandam 'arquivado' — sigo o contrato.]
    expect(src2.status).toBe("arquivado");
    expect(src2.valid_to).toBe("2026-03-01");
    // confiança: run 5k = 2 fontes = 0.75; run 12k = 1 fonte = 0.60
    expect(src1.confidence).toBeCloseTo(0.75, 10);
    expect(src2.confidence).toBeCloseTo(0.75, 10);
    expect(src3.confidence).toBeCloseTo(0.6, 10);
  });
});

describe("applyBitemporal — L2/M2: idempotência (derivar 2× não infla)", () => {
  it("aplicar 2× sobre o mesmo array (a 2ª já carrega derivados) → byte-idêntico", () => {
    const make = () => [
      nfact({ source_slug: "src1", value_num: 5000, valid_from: "2026-01-01" }),
      nfact({ source_slug: "src2", value_num: 5000, valid_from: "2026-02-01" }),
      nfact({ source_slug: "src3", value_num: 12000, valid_from: "2026-03-01" }),
    ];
    const fs = make();
    applyBitemporal(fs);
    const snap1 = fs.map((f) => ({ s: f.source_slug, st: f.status, vt: f.valid_to, c: f.confidence }));
    // 2ª passada sobre o MESMO array — simula o re-derive (input já tem valid_to/status/confidence)
    applyBitemporal(fs);
    const snap2 = fs.map((f) => ({ s: f.source_slug, st: f.status, vt: f.valid_to, c: f.confidence }));
    expect(JSON.stringify(snap2)).toBe(JSON.stringify(snap1));
    // confiança NÃO sobe na 2ª passada
    expect(fs.find((f) => f.source_slug === "src1")!.confidence).toBeCloseTo(0.75, 10);
  });
});

describe("applyBitemporal — D5: determinismo (ordem de entrada não importa)", () => {
  it("empate de valid_from em 2 fontes → mesmo resultado em ordens diferentes", () => {
    const a = [
      nfact({ source_slug: "alpha", value_num: 5000, valid_from: "2026-02-01" }),
      nfact({ source_slug: "beta", value_num: 5000, valid_from: "2026-02-01" }),
    ];
    const b = [
      nfact({ source_slug: "beta", value_num: 5000, valid_from: "2026-02-01" }),
      nfact({ source_slug: "alpha", value_num: 5000, valid_from: "2026-02-01" }),
    ];
    applyBitemporal(a);
    applyBitemporal(b);
    const norm = (fs: FactRow[]) =>
      [...fs]
        .sort((x, y) => x.source_slug.localeCompare(y.source_slug))
        .map((f) => ({ s: f.source_slug, st: f.status, vt: f.valid_to, c: f.confidence }));
    expect(JSON.stringify(norm(a))).toBe(JSON.stringify(norm(b)));
    // tie-break source_slug: alpha < beta → alpha é o elo fechado (corroborado), beta o vigente
    const alpha = a.find((f) => f.source_slug === "alpha")!;
    const beta = a.find((f) => f.source_slug === "beta")!;
    expect(alpha.status).toBe("corroborado");
    expect(beta.status).toBe("fato");
    expect(beta.valid_to).toBe("");
  });
});

describe("applyBitemporal — L3: só ISO ordena a cadeia (ano vs ano-mês)", () => {
  it("'2024' < '2024-03' lexicograficamente == cronologicamente", () => {
    const fs = [
      nfact({ source_slug: "b", value_num: 12000, valid_from: "2024-03" }),
      nfact({ source_slug: "a", value_num: 5000, valid_from: "2024" }),
    ];
    applyBitemporal(fs);
    const ano = fs.find((f) => f.source_slug === "a")!;
    const mes = fs.find((f) => f.source_slug === "b")!;
    // o de "2024" é o mais antigo → arquivado, fecha no início de "2024-03"
    expect(ano.status).toBe("arquivado");
    expect(ano.valid_to).toBe("2024-03");
    expect(mes.status).toBe("fato");
    expect(mes.valid_to).toBe("");
  });
});
