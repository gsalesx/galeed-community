/** M25-A — fila em ESCALA: grupos por decisão + ações em LOTE gateadas (zero LLM).
 *  Handlers PUROS (home, input) → objeto serializável ou BffError — espelha bff-sources.ts.
 *  bff-sources.ts (M21/S3) fica INTACTO: aprovar/descartar UNITÁRIO continua lá; este arquivo
 *  é a zona NOVA do lote. O web-server.ts (zona neutra) só roteia. A LEI: decisão humana por
 *  LOTE, ancoragem por ITEM (gate determinístico no golden-rule — nunca LLM aqui). */
import {
  getEngine,
  type ReviewItemRow,
  type ReviewReason,
  type SourceRow,
} from "../../core/platform/engine.ts";
import {
  approveReviewItemsLote,
  discardReviewItemsLote,
  REVIEW_SCAN_LIMIT,
  type LoteAprovacao,
} from "../../core/ingestion/golden-rule.ts";
import { updateSourceHandler, type HypothesisView } from "./bff-sources.ts";
import { getRecommendations } from "../../core/ingestion/review-judge.ts"; // M25-B seam — recomendação por item (read-only)
import { BffError } from "./bff-common.ts";

const REASONS: ReadonlySet<string> = new Set([
  "fora_da_receita", "nao_ancorado", "entidade_vaga", "conexao_sugerida",
]);

/** Um grupo-decisão da fila: todos os pendentes que a MESMA frase decide. */
export interface HypothesisGroupView {
  reason: ReviewReason;
  dimension: string;
  source_id: string;            // "" quando o grupo não tem fonte (conexao_sugerida)
  source_name: string;          // "" quando sem fonte
  count: number;
  paginas: number;              // source_slugs distintos no grupo
  amostra: HypothesisView[];    // 3 itens mais recentes (listReview já vem desc)
  decisao: string;              // a frase da decisão que o grupo representa (PT)
  dimensao_na_receita: boolean; // a receita ATUAL da fonte já cobre a dimensão?
  // M25-B reconcile (adendo §9): rollup das recomendações do juiz no grupo. Ausente quando o juiz
  // ainda não passou por nenhum item — o front trata via `?? 0`. O lote `apenas_recomendados`
  // depende de recomendacoes.aprovar (gateado em A; o juiz NUNCA aprova — invariante #5).
  recomendacoes?: { aprovar: number; descartar: number; humano: number; sem_recomendacao: number };
}

/** Recomendações do juiz por id (subset do getRecommendations) — só o que groupHypotheses precisa. */
export type JuizRecs = Record<string, { recomendacao: string; motivo: string; confianca: number; judged_at: string }>;

/** A frase da DECISÃO que o grupo representa. TEMPLATE dirigido por dado — zero literal de
 *  domínio (invariante III/ADR-002): dimensão e fonte vêm do banco. */
export function decisaoDoGrupo(reason: ReviewReason, dimension: string, sourceName: string): string {
  const fonte = sourceName || "(sem fonte)";
  switch (reason) {
    case "fora_da_receita":
      return `a receita da fonte "${fonte}" não tem a dimensão "${dimension}".`;
    case "nao_ancorado":
      return `itens de "${dimension}" da fonte "${fonte}" sem âncora verificável no texto original.`;
    case "entidade_vaga":
      return `itens de "${dimension}" da fonte "${fonte}" sem dono claro.`;
    case "conexao_sugerida":
      return "conexões sugeridas pelo sono — aprovar registra a decisão e a aresta entra no grafo.";
  }
}

/** PURA — agrupa pendentes por (reason, dimension, source_id). amostra = 3 primeiros na ordem
 *  recebida; ordena grupos por count desc (o grupão primeiro). */
export function groupHypotheses(items: ReviewItemRow[], sources: SourceRow[], recs?: JuizRecs): HypothesisGroupView[] {
  const nameOf = new Map(sources.map((s) => [s.id, s.name]));
  const recipeDims = new Map(
    sources.map((s) => [s.id, new Set(s.recipe.fields.map((f) => f.dimension))]),
  );
  const grupos = new Map<string, { view: HypothesisGroupView; slugs: Set<string> }>();
  for (const it of items) {
    const sourceId = it.source_id ?? "";
    const key = `${it.reason}|${it.dimension}|${sourceId}`;
    let g = grupos.get(key);
    if (!g) {
      const source_name = nameOf.get(sourceId) ?? "";
      g = {
        view: {
          reason: it.reason,
          dimension: it.dimension,
          source_id: sourceId,
          source_name,
          count: 0,
          paginas: 0,
          amostra: [],
          decisao: decisaoDoGrupo(it.reason, it.dimension, source_name),
          dimensao_na_receita: recipeDims.get(sourceId)?.has(it.dimension) ?? false,
          // só materializa o rollup quando o juiz foi rodado (recs presente) — senão fica ausente.
          ...(recs ? { recomendacoes: { aprovar: 0, descartar: 0, humano: 0, sem_recomendacao: 0 } } : {}),
        },
        slugs: new Set<string>(),
      };
      grupos.set(key, g);
    }
    g.view.count++;
    g.slugs.add(it.source_slug);
    const r = recs?.[it.id];
    if (g.view.recomendacoes) {
      if (r?.recomendacao === "aprovar") g.view.recomendacoes.aprovar++;
      else if (r?.recomendacao === "descartar") g.view.recomendacoes.descartar++;
      else if (r?.recomendacao === "humano") g.view.recomendacoes.humano++;
      else g.view.recomendacoes.sem_recomendacao++;
    }
    if (g.view.amostra.length < 3) {
      g.view.amostra.push({
        ...it,
        source_name: g.view.source_name,
        recomendacao: r?.recomendacao,
        recomendacao_motivo: r?.motivo,
        recomendacao_confianca: r ? r.confianca : null,
        recomendado_em: r ? r.judged_at : null,
      });
    }
  }
  return [...grupos.values()]
    .map((g) => ({ ...g.view, paginas: g.slugs.size }))
    .sort((a, b) => b.count - a.count);
}

/** GET /api/hypotheses/groups — a fila agrupada por decisão. M25-B reconcile: + recomendações do
 *  juiz (join read-only via getRecommendations) p/ o front decidir o lote `apenas_recomendados`. */
export async function listHypothesisGroupsHandler(home: string): Promise<HypothesisGroupView[]> {
  const e = await getEngine(home);
  const itens = await e.listReview({ status: "pendente", limit: REVIEW_SCAN_LIMIT });
  const sources = await e.listSources();
  const recs = await getRecommendations(home, itens.map((it) => it.id));
  // Só ativa o rollup se ALGUM item foi adjudicado — senão o grupo sai sem `recomendacoes` (front usa ?? 0).
  const recsArg = Object.keys(recs).length ? (recs as JuizRecs) : undefined;
  return groupHypotheses(itens, sources, recsArg);
}

export interface GroupKeyBody { reason: string; dimension: string; source_id: string }

/** Valida e normaliza a chave do grupo na borda (400 legível). */
function validateGroupKey(body: GroupKeyBody): { reason: ReviewReason; dimension: string; source_id: string } {
  const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
  if (!REASONS.has(reason)) throw new BffError(400, "motivo de grupo inválido.");
  const dimension = typeof body?.dimension === "string" ? body.dimension.trim().toLowerCase() : "";
  if (!dimension) throw new BffError(400, "diga a dimensão do grupo.");
  const source_id = typeof body?.source_id === "string" ? body.source_id.trim() : "";
  return { reason: reason as ReviewReason, dimension, source_id };
}

/** ids pendentes do grupo (snapshot do momento da chamada — corrida com decisão unitária é
 *  resolvida pelo CAS do engine; item decidido no meio conta como ja_decidido). */
async function idsDoGrupo(
  home: string,
  key: { reason: ReviewReason; dimension: string; source_id: string },
): Promise<string[]> {
  const e = await getEngine(home);
  const itens = await e.listReview({ status: "pendente", limit: REVIEW_SCAN_LIMIT });
  return itens
    .filter((it) =>
      it.reason === key.reason &&
      it.dimension === key.dimension &&
      (it.source_id ?? "") === key.source_id,
    )
    .map((it) => it.id);
}

/** POST /api/hypotheses/groups/approve — ação (a): aprovar-grupo GATEADO por ancoragem. */
export async function approveGroupHandler(
  home: string,
  body: GroupKeyBody,
  decidedBy: string,
): Promise<{ ok: true } & LoteAprovacao> {
  const key = validateGroupKey(body);
  const ids = await idsDoGrupo(home, key);
  const r = await approveReviewItemsLote(home, ids, decidedBy);
  return { ok: true, ...r };
}

/** POST /api/hypotheses/groups/discard — ação (b): descartar-grupo REGISTRADO (decided_by
 *  gravado item a item — invariante #5, nunca silencioso). */
export async function discardGroupHandler(
  home: string,
  body: GroupKeyBody,
  decidedBy: string,
): Promise<{ ok: true; descartados: number; ja_decididos: number }> {
  const key = validateGroupKey(body);
  const ids = await idsDoGrupo(home, key);
  const r = await discardReviewItemsLote(home, ids, decidedBy);
  return { ok: true, ...r };
}

export interface AddDimensionBody {
  source_id: string;
  dimension: string;
  label?: string; // rótulo legível do campo novo da receita; default = a própria dimension
  area?: string;  // slug da área destino; default ""
}

/** POST /api/hypotheses/groups/add-dimension — ação (c): a receita da fonte GANHA a dimensão
 *  (updateSourceHandler EXISTENTE — que também faz o merge receita→pack, ADR-016/fix-1) e os
 *  pendentes fora_da_receita do grupo são re-gateados SEM LLM (o claim está salvo no item;
 *  com a dim agora na receita, o que resta da cadeia é exatamente gateClaimAnchoring — os que
 *  passam são aprovados pelo MESMO caminho da ação (a)). Idempotente: dim já na receita ⇒
 *  receita_atualizada=false e segue pro lote; repetir tudo ⇒ no-op. */
export async function addDimensionGroupHandler(
  home: string,
  body: AddDimensionBody,
  decidedBy: string,
): Promise<{ ok: true; receita_atualizada: boolean } & LoteAprovacao> {
  const source_id = typeof body?.source_id === "string" ? body.source_id.trim() : "";
  if (!source_id) throw new BffError(400, "esse grupo não tem fonte — não há receita pra atualizar.");
  const dimension = typeof body?.dimension === "string" ? body.dimension.trim().toLowerCase() : "";
  if (!dimension) throw new BffError(400, "diga a dimensão pra adicionar à receita.");
  const e = await getEngine(home);
  const source = await e.getSource(source_id);
  if (!source) throw new BffError(404, "fonte não encontrada.");

  const jaTem = source.recipe.fields.some((f) => f.dimension === dimension);
  if (!jaTem) {
    const recipe = {
      ...source.recipe,
      fields: [
        ...source.recipe.fields,
        {
          dimension,
          label: (typeof body?.label === "string" && body.label.trim()) || dimension,
          area: typeof body?.area === "string" ? body.area.trim().toLowerCase() : "",
        },
      ],
    };
    // caminho EXISTENTE (validateRecipe + upsert + mergeRecipeDimsIntoPack) — nada duplicado.
    await updateSourceHandler(home, source_id, { recipe });
  }
  const ids = await idsDoGrupo(home, { reason: "fora_da_receita", dimension, source_id });
  const r = await approveReviewItemsLote(home, ids, decidedBy);
  return { ok: true, receita_atualizada: !jaTem, ...r };
}
