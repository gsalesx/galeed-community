/** M17 · S4 — Gate #1 (LEI I, DETERMINÍSTICO, sem LLM). Prova de MECANISMO do verificador da resposta.
 *  COMPLEMENTA `answer-verify.test.ts` (S1, dono do arquivo): aqui cobrimos os CASOS DE BORDA que o
 *  brief pede explicitamente (§6 / DESIGN-SPEC S4) — em especial o **quote MÍNIMO vs LARGO** contra o
 *  fuzzy ≥70% do `quoteIsGrounded` — sem editar o teste do S1.
 *
 *  Por que isto importa (a defesa estrutural do M17): "cardiovascular" é 0× na fonte. Um claim só pode
 *  afirmar "cardiovascular" se citar um `quote` que o sustente. Com quote MÍNIMO (a frase curta que
 *  prova o termo), o termo inventado domina os tokens e o claim cai (quote-not-grounded). Com quote
 *  LARGO, o termo inventado pode se DILUIR entre tokens grounded e passar a porta de tokens — é por isso
 *  que o SYSTEM (S2) pede a MENOR frase verbatim e o gate #2 (LLM real) fecha o resíduo (ADR-011 §Conseq.b).
 *  Este teste TRAVA esse contrato: minimal-cardiovascular DROPA; o número não-ancorado DROPA. */
import { describe, it, expect } from "vitest";
import {
  verifyAnswer,
  type Claim,
  type VerifySource,
} from "../../src/core/retrieval/answer-verify.ts";

// Fonte canônica do HTC. "cardiovascular" NÃO aparece; "Vascular e Endovascular" sim; "mais de 28 anos".
const SRC: VerifySource[] = [
  {
    slug: "bio-bruno",
    body:
      "Bruno Canguçu é médico Cirurgião Vascular e Endovascular, sócio da Accelera 360, " +
      "com mais de 28 anos de experiência clínica.",
  },
];

describe("M17/S4 Gate#1 — verifyAnswer (LEI I, determinístico, sem LLM)", () => {
  it("mantém claim ancorado (médico, quote verbatim mínimo)", () => {
    const claims: Claim[] = [
      { text: "Há um médico na empresa.", cite_slug: "bio-bruno", quote: "Bruno Canguçu é médico" },
    ];
    const r = verifyAnswer(claims, SRC);
    expect(r.verified).toHaveLength(1);
    expect(r.dropped).toHaveLength(0);
  });

  it("dropa cite inexistente → no-cite", () => {
    const claims: Claim[] = [{ text: "x", cite_slug: "nao-existe", quote: "x" }];
    const r = verifyAnswer(claims, SRC);
    expect(r.verified).toHaveLength(0);
    expect(r.dropped[0].reason).toBe("no-cite");
  });

  it("dropa '29 anos' (fonte diz 'mais de 28 anos') → number-not-anchored", () => {
    // quote REAL e grounded — mas o número 29 do `text` não ancora na fonte (que diz 28). Porta (3).
    const claims: Claim[] = [
      {
        text: "Tem 29 anos de experiência.",
        cite_slug: "bio-bruno",
        quote: "mais de 28 anos de experiência",
      },
    ];
    const r = verifyAnswer(claims, SRC);
    expect(r.verified).toHaveLength(0);
    expect(r.dropped[0].reason).toBe("number-not-anchored");
  });

  // --- BORDA: quote MÍNIMO vs LARGO contra o fuzzy ≥70% (o coração da LEI I para termo NOMINAL) ---
  describe("quote mínimo vs largo (fuzzy ≥70% do quoteIsGrounded) — caso 'cardiovascular'", () => {
    it("quote MÍNIMO inventado ('Cirurgião Cardiovascular') → DROPA (term 0× domina os tokens)", () => {
      // tokens significativos do quote: [cirurgião, cardiovascular]. "cardiovascular" não está na fonte
      // → 1/2 = 0.5 < 0.7 → quoteIsGrounded false → DROP. É a defesa que mata "cardiovascular".
      const claims: Claim[] = [
        { text: "É cirurgião cardiovascular.", cite_slug: "bio-bruno", quote: "Cirurgião Cardiovascular" },
      ];
      const r = verifyAnswer(claims, SRC);
      expect(r.verified).toHaveLength(0);
      expect(r.dropped).toHaveLength(1);
      expect(r.dropped[0].reason).toBe("quote-not-grounded");
    });

    it("quote VERBATIM legítimo ('Cirurgião Vascular e Endovascular') → MANTÉM", () => {
      // o termo REAL da fonte. Quote curto e fiel → grounded → verified. (Prova que o gate não mutila
      // o claim legítimo: corta só o inventado.)
      const claims: Claim[] = [
        {
          text: "É Cirurgião Vascular e Endovascular.",
          cite_slug: "bio-bruno",
          quote: "Cirurgião Vascular e Endovascular",
        },
      ];
      const r = verifyAnswer(claims, SRC);
      expect(r.verified).toHaveLength(1);
      expect(r.dropped).toHaveLength(0);
    });

    it("quote LARGO que DILUI 'cardiovascular' PASSA a porta de tokens — risco residual documentado", () => {
      // ADR-011 §Consequências(b): um quote largo de contexto pode embutir um termo inventado e ainda
      // passar a porta fuzzy (a maioria dos tokens é grounded). É EXATAMENTE por isso que (1) o SYSTEM
      // (S2) instrui a MENOR frase verbatim e (2) o gate #2 usa LLM real. Este assert TRAVA o
      // comportamento atual do mecanismo determinístico (≥70%): não é um bug a corrigir no verificador
      // (corrigir seria reimplementar parser/NER — proibido, invariante #9), é o resíduo que o gate #2 cobre.
      const claims: Claim[] = [
        {
          text: "É cirurgião cardiovascular.",
          cite_slug: "bio-bruno",
          quote: "Bruno Canguçu é médico Cirurgião Cardiovascular Endovascular", // largo: term diluído
        },
      ];
      const r = verifyAnswer(claims, SRC);
      // o mecanismo determinístico SOZINHO deixa passar (≥70% grounded). Documenta o limite da porta 2.
      expect(r.verified).toHaveLength(1);
    });
  });

  it("multi-claim na MESMA chamada: mantém os ancorados, dropa cada não-ancorado pelo seu motivo", () => {
    const claims: Claim[] = [
      { text: "Há um médico.", cite_slug: "bio-bruno", quote: "Bruno Canguçu é médico" }, // passa
      { text: "É cardiovascular.", cite_slug: "bio-bruno", quote: "Cirurgião Cardiovascular" }, // drop quote
      { text: "Tem 29 anos.", cite_slug: "bio-bruno", quote: "mais de 28 anos de experiência" }, // drop número
      { text: "y", cite_slug: "fantasma", quote: "y" }, // drop cite
    ];
    const r = verifyAnswer(claims, SRC);
    expect(r.verified.map((c) => c.text)).toEqual(["Há um médico."]);
    const reasons = r.dropped.map((d) => d.reason).sort();
    expect(reasons).toEqual(["no-cite", "number-not-anchored", "quote-not-grounded"]);
  });
});
