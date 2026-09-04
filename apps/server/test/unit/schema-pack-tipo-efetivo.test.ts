/** UNIT — expandRecipeEntries (PURA, sem DB): o merge receita→pack grava sob o PAR {type cru,
 *  tipo EFETIVO}. É o espelho do invariante do wizard (§6.2-c) pros caminhos fora dele
 *  (bff-connectors, ingestors/deliver, bff-sources): capture.ts colapsa type custom via
 *  resolveTipo ('email'/'erp'/'tabela' → 'notas'), então a chave que a extração LÊ
 *  (getExtractSchema(home, page.type)) PRECISA receber as dims da receita — senão a dim é
 *  inemissível e o gate rejeita/perde o campo em silêncio (causa-3 do 09b5e16). */
import { describe, it, expect } from "vitest";
import { expandRecipeEntries } from "../../src/core/extraction/schema-pack.ts";
import { resolveTipo } from "../../src/core/platform/brain.ts";
import { emailSourceSeed } from "../../src/core/ingestion/connectors/gmail.ts";
import { planilhaIngestor } from "../../src/core/ingestion/ingestors/planilha.ts";
import { notetakerIngestor } from "../../src/core/ingestion/ingestors/notetaker.ts";

describe("expandRecipeEntries — par {cru, efetivo}", () => {
  it("type custom ('email') expande pro par com as MESMAS dims — a chave efetiva é a que fecha o gate", () => {
    const dims = ["relacoes", "decisoes", "compromissos", "precos"];
    expect(resolveTipo("email")).toBe("notas"); // o colapso que motivou o fix
    expect(expandRecipeEntries([{ type: "email", dims }])).toEqual([
      { type: "email", dims },
      { type: "notas", dims },
    ]);
  });

  it("alias conhecido ('reuniao') expande pro plural canônico ('reunioes')", () => {
    expect(expandRecipeEntries([{ type: "reuniao", dims: ["decisoes"] }])).toEqual([
      { type: "reuniao", dims: ["decisoes"] },
      { type: "reunioes", dims: ["decisoes"] },
    ]);
  });

  it("type canônico ('notas') NÃO duplica; type vazio NÃO expande pra 'notas' (o merge o ignora)", () => {
    expect(expandRecipeEntries([{ type: "notas", dims: ["facts"] }])).toEqual([{ type: "notas", dims: ["facts"] }]);
    expect(expandRecipeEntries([{ type: "", dims: ["facts"] }])).toEqual([{ type: "", dims: ["facts"] }]);
  });

  it("invariante dos SEEDS reais (espelho do §6.2-c, sem DB): a chave EFETIVA de cada seed recebe as dims da receita", () => {
    const seeds = [
      { nome: "gmail", seed: emailSourceSeed("x") },
      { nome: "planilha", seed: planilhaIngestor.sourceSeed!() },
      { nome: "erp", seed: { type: "erp", recipe: { fields: [{ dimension: "claims" }] } } }, // conta-azul
    ];
    for (const { seed } of seeds) {
      const dims = seed.recipe.fields.map((f: any) => f.dimension);
      const expanded = expandRecipeEntries([{ type: seed.type, dims }]);
      const efetiva = expanded.find((e) => e.type === resolveTipo(seed.type));
      expect(efetiva).toBeDefined(); // a chave que a extração LÊ está no merge
      expect(efetiva!.dims).toEqual(dims);
    }
  });
});

describe("seed do notetaker — type 'reuniao' (não 'call')", () => {
  it("resolveTipo conhece o alias → page.type 'reunioes' (liga grafo de falantes + decay de reunião)", () => {
    const seed = notetakerIngestor.sourceSeed!();
    expect(seed.type).toBe("reuniao");
    expect(resolveTipo(seed.type)).toBe("reunioes"); // 'call' colapsava pra 'notas'
  });
});
