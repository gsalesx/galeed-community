/** M23-C/S4 — aditividade do schema-pack a360.json (PURO, sem DB/LLM). O pack ganha campos NOVOS
 *  (`extractable["notas"]` + 3 linhas de synonymClasses) SEM mudar NENHUM byte dos existentes
 *  (selo de aditividade do gate BRIEF §6.6). Lê o JSON do disco e crava os literais atuais. */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const packPath = fileURLToPath(new URL("../../schema-packs/a360.json", import.meta.url));
const packDir = fileURLToPath(new URL("../../schema-packs/", import.meta.url));
const pack = JSON.parse(readFileSync(packPath, "utf8"));

describe("M23-C — aditividade do pack a360.json", () => {
  it("1. extractable['accelera-preco'] e ['reunioes'] inalterados (deep-equal aos literais do HEAD)", () => {
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
  });

  it("2. synonymClasses[0] intacto e exatamente 4 classes (1 antiga + 3 novas)", () => {
    expect(pack.synonymClasses[0]).toEqual(["preco", "valor", "mensalidade", "ticket", "fee"]);
    expect(pack.synonymClasses.length).toBe(4);
    // as 3 novas, com o predicado FIXO como 1º token (a chave de fusão do reconcile)
    expect(pack.synonymClasses[1][0]).toBe("relacao");
    expect(pack.synonymClasses[1]).toContain("aluno");
    expect(pack.synonymClasses[2][0]).toBe("decisao");
    expect(pack.synonymClasses[3][0]).toBe("compromisso");
  });

  it("3. extractable['notas'] existe; eval_dimensions exato; template/fixture apontam pra arquivos que EXISTEM", () => {
    const notas = pack.extractable["notas"];
    expect(notas).toBeDefined();
    expect(notas.eval_dimensions).toEqual(["relacoes", "decisoes", "compromissos", "facts"]);
    expect(existsSync(packDir + notas.prompt_template)).toBe(true);
    expect(existsSync(packDir + notas.fixture_corpus)).toBe(true);
  });

  it("4. benchmark_min_recall de 'notas' é número > 0 (pega o placeholder 0.0 esquecido)", () => {
    expect(typeof pack.extractable["notas"].benchmark_min_recall).toBe("number");
    expect(pack.extractable["notas"].benchmark_min_recall).toBeGreaterThan(0);
  });

  it("5. roleTokens intacto ({})", () => {
    expect(pack.roleTokens).toEqual({});
  });
});
