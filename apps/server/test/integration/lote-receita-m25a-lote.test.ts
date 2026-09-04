/** M25-A/§5.D — handlers da BORDA do lote no DB real (:5434): GET grupos, ação (c)
 *  add-dimension (receita ganha a dim via caminho EXISTENTE + merge no pack), idempotência,
 *  validações de borda (400/404), e grupo esvaziado some. */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { hasDb, wipeBrain } from "./helpers/db.ts";
import { getEngine, closeEngines, type ReviewItemRow } from "../../src/core/platform/engine.ts";
import { createSourceHandler } from "../../src/connectors/bff/bff-sources.ts";
import { loadSchemaPackAsync } from "../../src/core/extraction/schema-pack.ts";
import { BffError } from "../../src/connectors/bff/bff-common.ts";
import {
  listHypothesisGroupsHandler,
  addDimensionGroupHandler,
  approveGroupHandler,
  discardGroupHandler,
} from "../../src/connectors/bff/bff-review.ts";

const BRAIN = "itest-m25a-receita-lote";
const SLUG = "pag-receita-m25a-lote";
const QUOTE1 = "o cliente reclamou do tempo de resposta";
const QUOTE2 = "ficou claro que o onboarding está confuso";
const BODY = `notas: ${QUOTE1}; além disso, ${QUOTE2}.`;
const DECIDED_BY = "humano-m25a-receita";

let SOURCE_ID = "";

function rev(p: Partial<ReviewItemRow> & { id: string }): ReviewItemRow {
  return {
    source_id: SOURCE_ID,
    source_slug: SLUG,
    dimension: p.dimension ?? "observacoes",
    text: p.text ?? "t",
    quote: p.quote ?? "",
    claim: p.claim ?? {},
    reason: p.reason ?? "fora_da_receita",
    status: "pendente",
    decided_by: "",
    decided_at: null,
    ...p,
  } as ReviewItemRow;
}

async function seed() {
  await wipeBrain(BRAIN);
  const src = await createSourceHandler(BRAIN, {
    name: "Fonte Receita M25A",
    channel: "upload",
    type: "nota",
    recipe: { fields: [{ dimension: "decisoes", label: "Decisões", area: "" }], guidance: "" },
  });
  SOURCE_ID = src.id;
  const e = await getEngine(BRAIN);
  await e.upsertPage({
    slug: SLUG, type: "nota", title: "R", date: "2026-01-01", path: "", body: BODY,
    content_hash: "hash-receita-m25a", tags: [`src:${SOURCE_ID}`],
  });
  await e.addReviewItems([
    rev({ id: "rev-receita-m25a-1", quote: QUOTE1, claim: { text: "a", entity: "cliente", context_quote: QUOTE1 } }),
    rev({ id: "rev-receita-m25a-2", quote: QUOTE2, claim: { text: "b", entity: "onboarding", context_quote: QUOTE2 } }),
    rev({ id: "rev-receita-m25a-na", quote: "frase ausente zzz", claim: { text: "c", entity: "x", context_quote: "frase ausente zzz" } }),
    // pendente de OUTRO grupo (não pode ser tocado pela ação observacoes):
    rev({ id: "rev-receita-m25a-outro", dimension: "precos", quote: QUOTE1, claim: { text: "d", entity: "plano", context_quote: QUOTE1 } }),
  ]);
}

describe.skipIf(!hasDb())("M25-A — handlers da borda (receita + grupos, DB real)", () => {
  beforeAll(async () => {
    await seed();
  });
  afterAll(async () => {
    await wipeBrain(BRAIN);
    await closeEngines();
  });

  it("1. GET grupos: grupo fora_da_receita|observacoes com count 3, dimensao_na_receita false, decisão exata", async () => {
    const groups = await listHypothesisGroupsHandler(BRAIN);
    const g = groups.find((x) => x.reason === "fora_da_receita" && x.dimension === "observacoes");
    expect(g).toBeDefined();
    expect(g!.count).toBe(3);
    expect(g!.dimensao_na_receita).toBe(false);
    expect(g!.source_id).toBe(SOURCE_ID);
    expect(g!.decisao).toBe(
      `a receita da fonte "Fonte Receita M25A" não tem a dimensão "observacoes".`,
    );
    expect(g!.amostra.length).toBeLessThanOrEqual(3);
  });

  it("2. ação (c): receita ganha 'observacoes' + 2 aprovados/1 retido; pack mergeado; outro grupo intocado", async () => {
    const r = await addDimensionGroupHandler(BRAIN, { source_id: SOURCE_ID, dimension: "observacoes" }, DECIDED_BY);
    expect(r.receita_atualizada).toBe(true);
    expect(r.aprovados).toBe(2);
    expect(r.retidos).toHaveLength(1);
    expect(r.retidos[0].id).toBe("rev-receita-m25a-na");

    const e = await getEngine(BRAIN);
    const src = await e.getSource(SOURCE_ID);
    const campo = src!.recipe.fields.find((f) => f.dimension === "observacoes");
    expect(campo).toBeDefined();
    expect(campo!.label).toBe("observacoes"); // label default = a dim

    // merge no pack via caminho existente
    const pack = await loadSchemaPackAsync(BRAIN);
    expect(pack.extractable["nota"].eval_dimensions).toContain("observacoes");

    // pendente do OUTRO grupo segue pendente, intocado
    expect((await e.getReviewItem("rev-receita-m25a-outro"))!.status).toBe("pendente");
  });

  it("3. idempotência da (c): repetir = no-op no EFEITO — receita_atualizada false, aprovados 0, mesmo retido", async () => {
    // NOTA: o handler re-deriva os ids do GRUPO via idsDoGrupo (scan dos PENDENTES). Os 2
    // aprovados na 1ª (c) já saíram de 'pendente' ⇒ não voltam no scan ⇒ ja_decididos=0 aqui
    // (não 2). O contrato observável é o que IMPORTA: nada novo aprova/escreve, e o retido segue
    // retido pelo mesmo porquê. (A spec §3.2 supôs a lista de ids CONSTANTE; a borda re-consulta
    // os pendentes — idempotência no EFEITO, não na contagem de ja_decididos.)
    const r = await addDimensionGroupHandler(BRAIN, { source_id: SOURCE_ID, dimension: "observacoes" }, DECIDED_BY);
    expect(r.receita_atualizada).toBe(false);
    expect(r.aprovados).toBe(0);
    expect(r.ja_decididos).toBe(0);
    expect(r.retidos).toHaveLength(1);
    expect(r.retidos[0].id).toBe("rev-receita-m25a-na");
  });

  it("4. validações da borda: source_id '' → 400; dimension '' → 400; fonte inexistente → 404; reason inválido → 400", async () => {
    await expect(
      addDimensionGroupHandler(BRAIN, { source_id: "", dimension: "x" }, DECIDED_BY),
    ).rejects.toThrowError(new BffError(400, "esse grupo não tem fonte — não há receita pra atualizar."));
    await expect(
      addDimensionGroupHandler(BRAIN, { source_id: SOURCE_ID, dimension: "" }, DECIDED_BY),
    ).rejects.toThrowError(new BffError(400, "diga a dimensão pra adicionar à receita."));
    await expect(
      addDimensionGroupHandler(BRAIN, { source_id: "nao-existe", dimension: "y" }, DECIDED_BY),
    ).rejects.toThrowError(new BffError(404, "fonte não encontrada."));
    await expect(
      approveGroupHandler(BRAIN, { reason: "qualquer", dimension: "observacoes", source_id: SOURCE_ID }, DECIDED_BY),
    ).rejects.toThrowError(new BffError(400, "motivo de grupo inválido."));
  });

  it("5. grupo esvaziado some: descartar o retido → o grupo observacoes sai do GET", async () => {
    const r = await discardGroupHandler(
      BRAIN, { reason: "fora_da_receita", dimension: "observacoes", source_id: SOURCE_ID }, DECIDED_BY,
    );
    expect(r.descartados).toBe(1); // só o retido restava pendente
    const groups = await listHypothesisGroupsHandler(BRAIN);
    expect(groups.find((x) => x.reason === "fora_da_receita" && x.dimension === "observacoes")).toBeUndefined();
  });
});
