/** M21/S3 — handlers PUROS de Fontes (/api/sources) e Fila de Revisão (/api/hypotheses).
 *  Espelha bff-jobs.ts: recebe (home, input), devolve objeto serializável ou lança BffError.
 *  O web-server.ts (zona neutra) só roteia. Aprovar/descartar DELEGA ao core (golden-rule.ts/S2). */
import { randomUUID } from "node:crypto";
import {
  getEngine,
  SENSITIVITY_LEVELS,
  type ReviewItemRow,
  type ReviewStatus,
  type SourceRecipe,
  type SourceRow,
} from "../../core/platform/engine.ts";
import { approveReviewItem, discardReviewItem } from "../../core/ingestion/golden-rule.ts";
import { getRecommendations } from "../../core/ingestion/review-judge.ts"; // M25-B seam — recomendação do juiz por item (read-only)
import { mergeRecipeDimsIntoPack } from "../../core/extraction/schema-pack.ts";
import { BffError } from "./bff-common.ts";

/** Valida e NORMALIZA a receita na borda (400 legível). `dimension`/`area` lowercase/trim — slug
 *  leve, SEM parser novo. Conteúdo dos campos é DADO do tenant: zero validação de domínio. */
function validateRecipe(recipe: SourceRecipe): SourceRecipe {
  if (!recipe || typeof recipe !== "object" || !Array.isArray(recipe.fields)) {
    throw new BffError(400, "a receita tem um campo sem nome.");
  }
  const fields = recipe.fields.map((f) => {
    if (
      !f || typeof f !== "object" ||
      typeof f.dimension !== "string" || typeof f.label !== "string" || typeof f.area !== "string" ||
      !f.dimension.trim()
    ) {
      throw new BffError(400, "a receita tem um campo sem nome.");
    }
    return {
      dimension: f.dimension.trim().toLowerCase(),
      label: f.label,
      area: f.area.trim().toLowerCase(),
    };
  });
  return { ...recipe, fields };
}

/** Sensibilidade na borda: ausente = 'restrito' (falha-fechado); inválida = 400. */
function validateSensitivity(value: string | undefined): string {
  if (value === undefined) return "restrito";
  if (!(SENSITIVITY_LEVELS as readonly string[]).includes(value)) {
    throw new BffError(400, "sigilo inválido.");
  }
  return value;
}

/** view de fonte pro front = SourceRow direto (S1 já computa pages_count/facts_count). */
export async function listSourcesHandler(home: string): Promise<SourceRow[]> {
  const e = await getEngine(home);
  return e.listSources();
}

export interface CreateSourceBody {
  name: string;
  channel: string;              // 'upload' | 'paste' (v1)
  type: string;                 // tipo de página (extractable key)
  recipe?: SourceRecipe;        // default { fields: [] }
  defaultSensitivity?: string;  // default 'restrito' (falha-fechado)
}

export async function createSourceHandler(home: string, body: CreateSourceBody): Promise<SourceRow> {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) throw new BffError(400, "dê um nome pra fonte.");
  if (body.channel !== "upload" && body.channel !== "paste") {
    throw new BffError(400, "esse canal ainda não existe — por enquanto a fonte recebe por upload ou texto colado.");
  }
  const type = typeof body.type === "string" ? body.type.trim() : "";
  if (!type) throw new BffError(400, "diga o tipo de coisa que entra por essa fonte.");
  const recipe = body.recipe !== undefined ? validateRecipe(body.recipe) : { fields: [] };
  const defaultSensitivity = validateSensitivity(body.defaultSensitivity);

  const row: SourceRow = {
    id: randomUUID(),
    name,
    channel: body.channel,
    type,
    recipe,
    default_sensitivity: defaultSensitivity,
    status: "ativa",
    last_read_at: null,
  };
  // fix-1 (ADR-016): MESMO merge receita→pack do wizardConfirm — dim da receita que o pack não
  // declara entra em extractable[type] (união, idempotente). Sem isso a extração nunca emite a dim
  // e 100% do campo vira hipótese `fora_da_receita`. Pack ANTES da fonte (ordem do wizard): se o
  // merge falhar, a fonte não nasce com receita que o pack não cobre.
  if (recipe.fields.length) {
    await mergeRecipeDimsIntoPack(home, [{ type, dims: recipe.fields.map((f) => f.dimension) }]);
  }
  const e = await getEngine(home);
  await e.upsertSource(row);
  return (await e.getSource(row.id)) ?? row;
}

/** PATCH semântico: só os campos presentes. */
export interface UpdateSourceBody {
  name?: string; type?: string; recipe?: SourceRecipe; defaultSensitivity?: string;
}

export async function updateSourceHandler(home: string, id: string, body: UpdateSourceBody): Promise<SourceRow> {
  const e = await getEngine(home);
  const current = await e.getSource(id);
  if (!current) throw new BffError(404, "fonte não encontrada.");

  const next: SourceRow = { ...current };
  if (body.name !== undefined) {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) throw new BffError(400, "dê um nome pra fonte.");
    next.name = name;
  }
  if (body.type !== undefined) {
    const type = typeof body.type === "string" ? body.type.trim() : "";
    if (!type) throw new BffError(400, "diga o tipo de coisa que entra por essa fonte.");
    next.type = type;
  }
  if (body.recipe !== undefined) next.recipe = validateRecipe(body.recipe);
  if (body.defaultSensitivity !== undefined) next.default_sensitivity = validateSensitivity(body.defaultSensitivity);

  // fix-1 (ADR-016): receita e/ou tipo mudou → garante receita ⊆ extractable[next.type] (união,
  // idempotente; nunca remove dim do pack). Mesma regra de domínio do wizardConfirm.
  if ((body.recipe !== undefined || body.type !== undefined) && next.recipe.fields.length) {
    await mergeRecipeDimsIntoPack(home, [
      { type: next.type, dims: next.recipe.fields.map((f) => f.dimension) },
    ]);
  }
  await e.upsertSource(next);
  return (await e.getSource(id)) ?? next;
}

/** status ∈ {'ativa','pausada'} — senão 400. 404 se a fonte não existe. */
export async function setSourceStatusHandler(home: string, id: string, status: string): Promise<SourceRow> {
  if (status !== "ativa" && status !== "pausada") {
    throw new BffError(400, "status inválido — uma fonte fica ativa ou pausada.");
  }
  const e = await getEngine(home);
  const current = await e.getSource(id);
  if (!current) throw new BffError(404, "fonte não encontrada.");
  await e.setSourceStatus(id, status);
  return (await e.getSource(id)) ?? { ...current, status };
}

/** itens da fila + nome da fonte resolvido (join em memória via listSources — N pequeno no v1).
 *  M25-B reconcile: + recomendação do juiz por item (join adjudicado via getRecommendations,
 *  seam read-only). "" / ausente = o juiz não passou por aqui (front trata via `?? ""`). */
export interface HypothesisView extends ReviewItemRow {
  source_name: string;
  recomendacao?: string;
  recomendacao_motivo?: string;
  recomendacao_confianca?: number | null;
  recomendado_em?: string | null;
}

export async function listHypothesesHandler(
  home: string, opts: { status?: string; limit?: number },
): Promise<HypothesisView[]> {
  const e = await getEngine(home);
  const items = await e.listReview({
    status: opts.status as ReviewStatus | undefined,
    limit: opts.limit,
  });
  const sources = await e.listSources();
  const names = new Map(sources.map((s) => [s.id, s.name]));
  // Join adjudicado (M25-B): 1 leitura batelada das colunas judge_* via o seam do dono.
  const recs = await getRecommendations(home, items.map((it) => it.id));
  return items.map((it) => {
    const r = recs[it.id];
    return {
      ...it,
      source_name: names.get(it.source_id) ?? "",
      recomendacao: r?.recomendacao,
      recomendacao_motivo: r?.motivo,
      recomendacao_confianca: r ? r.confianca : null,
      recomendado_em: r ? r.judged_at : null,
    };
  });
}

export async function hypothesesCountHandler(home: string): Promise<{ pendente: number; aprovada: number; descartada: number }> {
  const e = await getEngine(home);
  return e.reviewCounts();
}

export async function approveHypothesisHandler(home: string, id: string, decidedBy: string): Promise<{ ok: true; status: "aprovada" }> {
  try {
    await approveReviewItem(home, id, decidedBy);
  } catch (err) {
    throw new BffError(409, err instanceof Error ? err.message : String(err));
  }
  return { ok: true, status: "aprovada" };
}

export async function discardHypothesisHandler(home: string, id: string, decidedBy: string): Promise<{ ok: true; status: "descartada" }> {
  try {
    await discardReviewItem(home, id, decidedBy);
  } catch (err) {
    throw new BffError(409, err instanceof Error ? err.message : String(err));
  }
  return { ok: true, status: "descartada" };
}
