/** INVARIANTE: síntese ancorada (answer-verify.ts) — LEI I do M17. Um claim da resposta só sobrevive se
 *  seu `quote` está verbatim na fonte citada E todo número do `text` ancora nessa fonte. Esta é a porta
 *  que mata a alucinação do HTC ("cardiovascular" 0× no corpus; "29 anos" quando a fonte diz "28") no
 *  nível do MECANISMO — determinístico, sem LLM. Testá-la protege a verdade na saída. */
import { describe, it, expect } from "vitest";
import {
  verifyAnswer,
  type Claim,
  type VerifySource,
} from "../../src/core/retrieval/answer-verify.ts";

// Fonte canônica do HTC: o corpus diz literalmente isto. "cardiovascular" NÃO aparece.
const MEDICO_BODY =
  "Bruno Canguçu é médico Cirurgião Vascular e Endovascular com mais de 28 anos de experiência.";
const MEDICO_SRC: VerifySource = { slug: "bruno-bio", body: MEDICO_BODY };

const PRECO_SRC: VerifySource = {
  slug: "preco-2026",
  body: "O programa Accelera 360 custa R$ 30.000 no tier atual.",
};

describe("verifyAnswer — LEI I (especificidade rastreia à fonte)", () => {
  it("passa-ancorado: quote verbatim, sem número → verified", () => {
    const claims: Claim[] = [
      { text: "Bruno Canguçu é médico.", cite_slug: "bruno-bio", quote: "Bruno Canguçu é médico" },
    ];
    const r = verifyAnswer(claims, [MEDICO_SRC]);
    expect(r.verified).toHaveLength(1);
    expect(r.dropped).toHaveLength(0);
  });

  it("dropa-quote-inventado: quote que não está na fonte → quote-not-grounded", () => {
    const claims: Claim[] = [
      {
        text: "Bruno trabalha em São Paulo.",
        cite_slug: "bruno-bio",
        quote: "atende exclusivamente em São Paulo capital",
      },
    ];
    const r = verifyAnswer(claims, [MEDICO_SRC]);
    expect(r.verified).toHaveLength(0);
    expect(r.dropped).toHaveLength(1);
    expect(r.dropped[0].reason).toBe("quote-not-grounded");
  });

  it("dropa-cite-inexistente: cite_slug fora de sources/facts → no-cite", () => {
    const claims: Claim[] = [
      { text: "Bruno é médico.", cite_slug: "fonte-fantasma", quote: "Bruno Canguçu é médico" },
    ];
    const r = verifyAnswer(claims, [MEDICO_SRC]);
    expect(r.verified).toHaveLength(0);
    expect(r.dropped[0].reason).toBe("no-cite");
  });

  it("dropa-numero-nao-ancorado: text '29 anos', fonte diz 'mais de 28 anos' → number-not-anchored", () => {
    const claims: Claim[] = [
      {
        text: "Bruno tem 29 anos de experiência.",
        cite_slug: "bruno-bio",
        // quote real e grounded — mas o número 29 não ancora (fonte: 28). A porta (3) o pega.
        quote: "com mais de 28 anos de experiência",
      },
    ];
    const r = verifyAnswer(claims, [MEDICO_SRC]);
    expect(r.verified).toHaveLength(0);
    expect(r.dropped[0].reason).toBe("number-not-anchored");
  });

  it("número ancorado passa: text 'custa 30 mil', fonte 'R$ 30.000' → verified (value-anchor)", () => {
    const claims: Claim[] = [
      {
        text: "O Accelera 360 custa 30 mil.",
        cite_slug: "preco-2026",
        quote: "custa R$ 30.000 no tier atual",
      },
    ];
    const r = verifyAnswer(claims, [PRECO_SRC]);
    expect(r.verified).toHaveLength(1);
    expect(r.dropped).toHaveLength(0);
  });

  describe("caso-canônico do HTC (mata a alucinação no nível do mecanismo)", () => {
    it('"Bruno Canguçu é cirurgião cardiovascular" com quote inventado → DROPADO', () => {
      // O LLM, para sustentar "cardiovascular", teria que citar um quote que o contenha. A fonte diz
      // "Vascular e Endovascular" — "cardiovascular" é 0×. O quote que o modelo emitiria para sustentar
      // ESPECIFICAMENTE o termo é a frase nominal que o afirma ("Cirurgião Cardiovascular"); ela NÃO
      // casa a fonte (token "cardiovascular" ausente → quoteIsGrounded false) → DROP. Defesa estrutural.
      const claims: Claim[] = [
        {
          text: "Bruno Canguçu é cirurgião cardiovascular.",
          cite_slug: "bruno-bio",
          quote: "Cirurgião Cardiovascular", // inventado: "cardiovascular" não está na fonte
        },
      ];
      const r = verifyAnswer(claims, [MEDICO_SRC]);
      expect(r.verified).toHaveLength(0);
      expect(r.dropped).toHaveLength(1);
      expect(r.dropped[0].reason).toBe("quote-not-grounded");
    });

    it('"Bruno Canguçu é médico" com quote verbatim → MANTIDO', () => {
      const claims: Claim[] = [
        {
          text: "Bruno Canguçu é médico.",
          cite_slug: "bruno-bio",
          quote: "Bruno Canguçu é médico",
        },
      ];
      const r = verifyAnswer(claims, [MEDICO_SRC]);
      expect(r.verified).toHaveLength(1);
      expect(r.verified[0].text).toBe("Bruno Canguçu é médico.");
      expect(r.dropped).toHaveLength(0);
    });
  });

  it("fato ancora via slug sintético __facts__ (decisão do Arquiteto — sem parsear linha à mão)", () => {
    const facts: VerifySource[] = [
      { slug: "__facts__", body: "preço vigente: R$ 30.000 (Accelera 360)" },
    ];
    const claims: Claim[] = [
      { text: "O preço vigente é R$ 30.000.", cite_slug: "__facts__", quote: "preço vigente: R$ 30.000" },
    ];
    const r = verifyAnswer(claims, [], facts);
    expect(r.verified).toHaveLength(1);
    expect(r.dropped).toHaveLength(0);
  });

  it("determinismo + separação: mantém os verificados e dropa só os sem âncora, na mesma chamada", () => {
    const claims: Claim[] = [
      { text: "Bruno é médico.", cite_slug: "bruno-bio", quote: "Bruno Canguçu é médico" }, // passa
      { text: "Bruno é cardiovascular.", cite_slug: "bruno-bio", quote: "Cirurgião Cardiovascular" }, // dropa
      { text: "Custa 30 mil.", cite_slug: "preco-2026", quote: "custa R$ 30.000" }, // passa
    ];
    const r = verifyAnswer(claims, [MEDICO_SRC, PRECO_SRC]);
    expect(r.verified.map((c) => c.text)).toEqual(["Bruno é médico.", "Custa 30 mil."]);
    expect(r.dropped).toHaveLength(1);
    expect(r.dropped[0].reason).toBe("quote-not-grounded");
  });
});
