/** UNIT M22-C — EMAIL_RECIPE + emailSourceSeed (DADO) + aditividade do pack a360.json.
 *  PURO (sem DB/LLM). Espelho do m23c-receitas-pack.test.ts: o pack ganha extractable["email"] SEM
 *  mudar NENHUM byte dos existentes; a receita tem as 4 dims (sem facts); o seed crava canal/tipo/sigilo. */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { EMAIL_RECIPE, emailSourceSeed } from "../../src/core/ingestion/connectors/gmail.ts";

const packPath = fileURLToPath(new URL("../../schema-packs/a360.json", import.meta.url));
const packDir = fileURLToPath(new URL("../../schema-packs/", import.meta.url));
const pack = JSON.parse(readFileSync(packPath, "utf8"));

describe("M22-C — EMAIL_RECIPE (DADO)", () => {
  it("1. fields EXATOS (4 dims, na ordem); sem 'facts' na receita", () => {
    expect(EMAIL_RECIPE.fields).toEqual([
      { dimension: "relacoes", label: "vínculo declarado (cliente, fornecedor, parceiro)", area: "comercial" },
      { dimension: "decisoes", label: "decisão tomada ou descartada", area: "comercial" },
      { dimension: "compromissos", label: "promessa assumida (com prazo)", area: "comercial" },
      { dimension: "precos", label: "preço, valor ou proposta", area: "comercial" },
    ]);
    expect(EMAIL_RECIPE.fields.some((f) => f.dimension === "facts")).toBe(false);
  });

  it("1b. M7 — toda field declara área NÃO-VAZIA (área já em forma de slug): sem área a página de " +
     "e-mail nasce sem tag `area:` e fica invisível a QUALQUER token escopado (scope.ts: item sem " +
     "área só passa com acesso total '*')", () => {
    for (const f of EMAIL_RECIPE.fields) {
      expect(f.area).toBeTruthy();
      expect(f.area).toBe(f.area.toLowerCase());
      expect(f.area).toMatch(/^[a-z0-9-]+$/);
    }
  });
});

describe("M22-C — emailSourceSeed", () => {
  it("2. channel gmail, type email, sigilo interno, status ativa", () => {
    const s = emailSourceSeed("x");
    expect(s.id).toBe("x");
    expect(s.channel).toBe("gmail");
    expect(s.type).toBe("email");
    expect(s.default_sensitivity).toBe("interno");
    expect(s.status).toBe("ativa");
    expect(s.last_read_at).toBeNull();
    expect(s.recipe).toBe(EMAIL_RECIPE);
  });
});

describe("M22-C — aditividade do pack a360.json (extractable['email'])", () => {
  it("3a. extractable['email'] existe; eval_dimensions exato; recall > 0; template/fixture EXISTEM", () => {
    const email = pack.extractable["email"];
    expect(email).toBeDefined();
    expect(email.eval_dimensions).toEqual(["relacoes", "decisoes", "compromissos", "precos", "facts"]);
    expect(typeof email.benchmark_min_recall).toBe("number");
    expect(email.benchmark_min_recall).toBeGreaterThan(0);
    expect(existsSync(packDir + email.prompt_template)).toBe(true);
    expect(existsSync(packDir + email.fixture_corpus)).toBe(true);
  });

  it("3b. entradas existentes BYTE-IDÊNTICAS aos literais do HEAD (accelera-preco/reunioes/notas)", () => {
    expect(pack.extractable["accelera-preco"]).toEqual({
      prompt_template: "prompts/extract/accelera-preco.md",
      fixture_corpus: "fixtures/extract/accelera-preco.jsonl",
      eval_dimensions: ["precos", "decisoes", "claims"],
      benchmark_min_recall: 0.8,
    });
    expect(pack.extractable["reunioes"]).toEqual({
      prompt_template: "prompts/extract/accelera-preco.md",
      fixture_corpus: "fixtures/extract/accelera-preco.jsonl",
      eval_dimensions: ["precos", "decisoes", "objecoes", "claims"],
    });
    expect(pack.extractable["notas"]).toEqual({
      prompt_template: "prompts/extract/memoria-nao-numerica.md",
      fixture_corpus: "fixtures/extract/memoria-nao-numerica.jsonl",
      eval_dimensions: ["relacoes", "decisoes", "compromissos", "facts"],
      benchmark_min_recall: 0.8,
    });
  });

  it("3c. synonymClasses intacto (length 4) e roleTokens intacto ({})", () => {
    expect(pack.synonymClasses.length).toBe(4);
    expect(pack.synonymClasses[0]).toEqual(["preco", "valor", "mensalidade", "ticket", "fee"]);
    expect(pack.roleTokens).toEqual({});
  });
});
