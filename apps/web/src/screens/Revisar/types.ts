/** M21/S7 — tipos locais da fila de revisão (espelham HypothesisView do S3 / bff-sources.ts).
 *  Shapes idênticos aos de `web/src/lib/api.ts` (bloco hypotheses) — locais por contrato do slot.
 *  REASON_LABEL: o enum NUNCA aparece cru pro usuário (invariante M11). */

export type ReviewReason = "fora_da_receita" | "nao_ancorado" | "entidade_vaga" | "conexao_sugerida";
export type ReviewStatus = "pendente" | "aprovada" | "descartada";

/** M25-B — recomendação do juiz persistida no item ("" = juiz não passou por aqui). */
export type JudgeRecomendacao = "" | "aprovar" | "descartar" | "humano";

export interface Hypothesis {
  id: string;
  source_id: string;
  source_name: string;
  source_slug: string;
  dimension: string;
  text: string;
  quote: string;
  reason: ReviewReason;
  status: ReviewStatus;
  decided_by: string;
  created_at?: string;
  decided_at?: string | null;
  /** M25-B (migração 32) — ausentes em BFF sem o juiz. */
  recomendacao?: JudgeRecomendacao;
  recomendacao_motivo?: string;
  recomendacao_confianca?: number | null;
  recomendado_em?: string | null;
}

// M25-C — espelho local dos contratos consumidos de M25-A/B (padrão M21/S7: shapes idênticos
// aos de web/src/lib/api.ts, re-exportados pra os componentes do slot).
export type {
  HypothesisGroup,
  JudgeCalibration,
  JudgeCalibrationSegment,
  JudgeEstimate,
  JudgeRun,
  BatchApproveResult,
  BatchDiscardResult,
  RecipeBatchResult,
  BatchRetido,
} from "../../lib/api";

export const REASON_LABEL: Record<ReviewReason, string> = {
  fora_da_receita: "Não está na receita da fonte — nenhum campo reconhece isso.",
  nao_ancorado: "O número ou a citação não confere com o texto original — pode ser invenção.",
  entidade_vaga: "Não dá pra saber de quem ou do quê isso fala — a entidade é vaga (“ele”, “a empresa”…), sem dono claro.",
  conexao_sugerida: "O sono do cérebro notou que estas duas entidades convivem com os mesmos vizinhos no mapa, sem ligação direta — pode existir relação. Aprovar cria a CONEXÃO no mapa (nunca vira fato).",
};
