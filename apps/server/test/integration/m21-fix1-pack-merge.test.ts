/** INTEGRAÇÃO M21/fix-1 — /api/sources faz o MESMO merge regras (`filtro`)→pack do wizard (ADR-016).
 *  Bug (review estrutural): create/updateSourceHandler gravavam as regras (`filtro`) mas NÃO uniam as dims no
 *  schema-pack — extração nunca emitia a dim → approved=0, 100% vai pra revisar `fora_do_filtro`.
 *  Asserts:
 *   - createSourceHandler com dim nova → loadSchemaPackAsync mostra a dim em extractable[type];
 *   - updateSourceHandler idem (regras novas e troca de tipo);
 *   - pack pré-existente NÃO perde nada (união, não substituição: outras dims/tipos/campos ficam);
 *   - idempotente: dim já declarada = no-op (pack_version NÃO bumpa).
 *  No-op sem DATABASE_URL/GALEED_DB_URL/SUPABASE_DB_URL (padrão ADR-014). */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { hasDb, wipeBrain } from "./helpers/db.ts";
import {
  createSourceHandler,
  updateSourceHandler,
} from "../../src/connectors/bff/bff-sources.ts";
import {
  loadSchemaPackAsync,
  saveSchemaPack,
  schemaPackVersion,
  clearSchemaPackCache,
} from "../../src/core/extraction/schema-pack.ts";
import { closeEngines } from "../../src/core/platform/engine.ts";

const BRAIN = "__m21_fix1";

const recipeOf = (...dims: string[]) => ({
  fields: dims.map((d) => ({ dimension: d, label: d, area: "geral" })),
});

async function cleanup(): Promise<void> {
  if (!hasDb()) return;
  await wipeBrain(BRAIN);
  clearSchemaPackCache(BRAIN);
}

beforeAll(cleanup);
afterAll(async () => {
  await cleanup();
  await closeEngines();
});

describe.skipIf(!hasDb())("M21/fix-1 — merge filtro→pack em /api/sources (ADR-016)", () => {
  it("createSourceHandler com dim nova → pack ganha a dim em extractable[type]", async () => {
    // pack pré-existente com conteúdo que NÃO pode se perder (outro tipo + dims do mesmo tipo).
    await saveSchemaPack(BRAIN, {
      synonymClasses: [["preco", "valor"]],
      roleTokens: { gasto: ["custo"] },
      extractable: {
        reunioes: { eval_dimensions: ["decisoes"] },
        calls: { eval_dimensions: ["objecoes"] },
      },
    });
    const v0 = await schemaPackVersion(BRAIN);

    const src = await createSourceHandler(BRAIN, {
      name: "Atas de reunião",
      channel: "upload",
      type: "reunioes",
      filtro: recipeOf("decisoes", "pendencias"),
    });
    expect(src.filtro.fields.map((f) => f.dimension)).toEqual(["decisoes", "pendencias"]);

    const pack = await loadSchemaPackAsync(BRAIN);
    // dim nova ENTROU (união) — é exatamente o que faltava (bug do fix-1):
    expect(pack.extractable.reunioes.eval_dimensions).toEqual(["decisoes", "pendencias"]);
    // NADA se perdeu: outro tipo, synonymClasses e roleTokens intactos.
    expect(pack.extractable.calls.eval_dimensions).toEqual(["objecoes"]);
    expect(pack.synonymClasses).toEqual([["preco", "valor"]]);
    expect(pack.roleTokens).toEqual({ gasto: ["custo"] });
    expect(await schemaPackVersion(BRAIN)).toBe(v0 + 1);
  });

  it("create idempotente: filtro só com dims já declaradas = no-op (versão NÃO bumpa)", async () => {
    const v0 = await schemaPackVersion(BRAIN);
    await createSourceHandler(BRAIN, {
      name: "Outra fonte de reunião",
      channel: "paste",
      type: "reunioes",
      filtro: recipeOf("decisoes"),
    });
    expect(await schemaPackVersion(BRAIN)).toBe(v0);
    const pack = await loadSchemaPackAsync(BRAIN);
    expect(pack.extractable.reunioes.eval_dimensions).toEqual(["decisoes", "pendencias"]);
  });

  it("updateSourceHandler com dim nova no filtro → pack ganha a dim; nunca remove", async () => {
    const src = await createSourceHandler(BRAIN, {
      name: "Calls de venda",
      channel: "upload",
      type: "calls",
      filtro: recipeOf("objecoes"),
    });
    // update REDUZ as regras (`filtro`) pra só a dim nova: o pack faz UNIÃO — 'objecoes' continua lá.
    await updateSourceHandler(BRAIN, src.id, { filtro: recipeOf("proximos-passos") });
    const pack = await loadSchemaPackAsync(BRAIN);
    expect(pack.extractable.calls.eval_dimensions).toEqual(["objecoes", "proximos-passos"]);
  });

  it("updateSourceHandler trocando o TIPO → dims do filtro entram no tipo novo", async () => {
    const src = await createSourceHandler(BRAIN, {
      name: "Planilha de preços",
      channel: "upload",
      type: "calls",
      filtro: recipeOf("objecoes"),
    });
    await updateSourceHandler(BRAIN, src.id, { type: "planilhas" });
    const pack = await loadSchemaPackAsync(BRAIN);
    expect(pack.extractable.planilhas.eval_dimensions).toEqual(["objecoes"]);
    // o tipo antigo NÃO perde a dim (união, nunca remoção):
    expect(pack.extractable.calls.eval_dimensions).toContain("objecoes");
  });

  it("fonte sem dims no filtro = pack intocado (versão NÃO bumpa)", async () => {
    const v0 = await schemaPackVersion(BRAIN);
    await createSourceHandler(BRAIN, {
      name: "Fonte sem filtro",
      channel: "paste",
      type: "avulsos",
    });
    expect(await schemaPackVersion(BRAIN)).toBe(v0);
    const pack = await loadSchemaPackAsync(BRAIN);
    expect(pack.extractable.avulsos).toBeUndefined();
  });
});
