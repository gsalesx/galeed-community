/** M25-C — lógica PURA da tela Revisar em escala (zero JSX/fetch/hooks).
 *
 *  Padrão da casa: `web/src/screens/Fontes/connector.ts` — tudo aqui é determinístico e
 *  testável em node (test/unit/revisar-m25c-front.test.ts). O front só EXIBE e DISPARA APIs;
 *  nenhuma decisão de custo/LLM mora aqui.
 *
 *  ADENDO DO ÁRBITRO (specs/slots/M25/M25-C-DESIGN-SPEC.md §9) prevalece onde diverge da §3.3:
 *    - calibração: `n`→`decididos`, `taxa`→`acerto` (semântica idêntica);
 *    - amostra do grupo chama `amostra`.
 */
import { fmtNumber } from "../../lib/format";
import type {
  Hypothesis, HypothesisGroup, JudgeCalibration, JudgeCalibrationSegment, BatchApproveResult,
  JudgeRun,
} from "../../lib/api";

/** Acima deste nº de pendentes a tela abre na visão por grupos (parâmetro de UI, não de domínio). */
export const GRUPOS_DEFAULT_MIN = 30;

export type AbaRevisar = "grupos" | "pendente" | "decididas";

/** Aba inicial: pendentes > GRUPOS_DEFAULT_MIN → "grupos"; senão "pendente".
 *  null (ainda carregando) → "pendente". */
export function abaInicial(pendentes: number | null): AbaRevisar {
  if (pendentes == null) return "pendente";
  return pendentes > GRUPOS_DEFAULT_MIN ? "grupos" : "pendente";
}

export type AcaoDeGrupo = "receita" | "aprovar_recomendados" | "descartar" | "um_a_um";

/** Tabela de decisão dos botões do card de grupo (a ORDEM do array é a ordem visual):
 *  - conexao_sugerida (ou source_id===""): ["um_a_um", "descartar"]  // SEM lote de aprovação:
 *        conexão não tem âncora de quote/valor — aprovar cria CONEXÃO no mapa, decisão um a um.
 *  - fora_da_receita com source_id ≠ "":  ["receita", ...(rec>0 ? ["aprovar_recomendados"] : []), "descartar", "um_a_um"]
 *  - nao_ancorado | entidade_vaga:        [...(rec>0 ? ["aprovar_recomendados"] : []), "descartar", "um_a_um"]
 *  onde rec = group.recomendacoes?.aprovar ?? 0. */
export function acoesDoGrupo(g: HypothesisGroup): AcaoDeGrupo[] {
  // conexão sugerida (ou sem fonte) nunca tem lote de aprovação — decisão um a um.
  if (g.reason === "conexao_sugerida" || g.source_id === "") {
    return ["um_a_um", "descartar"];
  }
  const rec = g.recomendacoes?.aprovar ?? 0;
  const recomendados: AcaoDeGrupo[] = rec > 0 ? ["aprovar_recomendados"] : [];
  if (g.reason === "fora_da_receita") {
    return ["receita", ...recomendados, "descartar", "um_a_um"];
  }
  // nao_ancorado | entidade_vaga
  return [...recomendados, "descartar", "um_a_um"];
}

/** Frase da decisão: devolve g.decisao se não-vazia; senão constrói fallback PT determinístico. */
export function decisaoDoGrupo(g: HypothesisGroup): string {
  if (g.decisao && g.decisao.trim() !== "") return g.decisao;
  switch (g.reason) {
    case "fora_da_receita":
      return `A receita da fonte "${g.source_name}" não tem a dimensão "${g.dimension}".`;
    case "nao_ancorado":
      return "O número ou a citação destes itens não confere com o texto original.";
    case "entidade_vaga":
      return "Nestes itens não dá pra saber de quem ou do quê se fala.";
    case "conexao_sugerida":
      return "O sono do cérebro sugeriu estas conexões entre entidades do mapa.";
    default:
      return "";
  }
}

/** Ordena por count desc; empate por reason asc, dimension asc, source_id asc (determinístico). */
export function ordenaGrupos(gs: HypothesisGroup[]): HypothesisGroup[] {
  return [...gs].sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    if (a.reason !== b.reason) return a.reason < b.reason ? -1 : 1;
    if (a.dimension !== b.dimension) return a.dimension < b.dimension ? -1 : 1;
    if (a.source_id !== b.source_id) return a.source_id < b.source_id ? -1 : 1;
    return 0;
  });
}

/** Pilha "precisa de você": recomendacao==="humano" primeiro (ordem relativa preservada nos 2 lados). */
export function separaPrecisaDeVoce(
  itens: Hypothesis[],
): { precisamDeVoce: Hypothesis[]; demais: Hypothesis[] } {
  const precisamDeVoce: Hypothesis[] = [];
  const demais: Hypothesis[] = [];
  for (const h of itens) {
    if (h.recomendacao === "humano") precisamDeVoce.push(h);
    else demais.push(h);
  }
  return { precisamDeVoce, demais };
}

/** Filtro client-side de um grupo sobre a lista carregada (defesa: o BFF pode ou não filtrar). */
export function filtraGrupo(
  itens: Hypothesis[],
  f: { reason: string; dimension: string; source_id: string } | null,
): Hypothesis[] {
  if (!f) return itens;
  return itens.filter(
    (h) => h.reason === f.reason && h.dimension === f.dimension && h.source_id === f.source_id,
  );
}

/** "Aprovados 790, retidos 42 — ver porquês." · retidos=0 → "Aprovados 790. Nenhum retido."
 *  · aprovados=0 → "Nenhum aprovado — 42 retidos pelo gate. Ver porquês." (milhar pt-BR). */
export function resumoLote(r: BatchApproveResult): string {
  const a = fmtNumber(r.aprovados);
  const n = r.retidos.length;
  if (r.aprovados === 0) return `Nenhum aprovado — ${fmtNumber(n)} retidos pelo gate. Ver porquês.`;
  if (n === 0) return `Aprovados ${a}. Nenhum retido.`;
  return `Aprovados ${a}, retidos ${fmtNumber(n)} — ver porquês.`;
}

/** Rótulo curto da recomendação do item ('' sem recomendação). */
export function rotuloRecomendacao(h: Hypothesis): string {
  switch (h.recomendacao) {
    case "aprovar":
      return "o juiz recomenda aprovar";
    case "descartar":
      return "o juiz recomenda descartar";
    case "humano":
      return "o juiz quer você aqui";
    default:
      return "";
  }
}

/** Localiza o segmento de calibração do grupo (match por dimension+source_id+reason). */
export function segmentoDoGrupo(
  cal: JudgeCalibration | null,
  g: HypothesisGroup,
): JudgeCalibrationSegment | undefined {
  if (!cal) return undefined;
  return cal.segmentos.find(
    (s) => s.dimension === g.dimension && s.source_id === g.source_id && s.reason === g.reason,
  );
}

/** Linha de acerto do segmento: undefined ou decididos===0 → "" · decididos<5 →
 *  `ainda aprendendo seu critério aqui (n=${decididos})`
 *  · senão → `o juiz acerta ${Math.round(acerto*100)}% aqui (n=${decididos})`. */
export function rotuloAcerto(seg: JudgeCalibrationSegment | undefined): string {
  if (!seg || seg.decididos === 0) return "";
  if (seg.decididos < 5) return `ainda aprendendo seu critério aqui (n=${seg.decididos})`;
  return `o juiz acerta ${Math.round(seg.acerto * 100)}% aqui (n=${seg.decididos})`;
}

/** "~US$ 0,87" (2 casas, vírgula decimal); v<0.01 e >0 → "menos de US$ 0,01". */
export function fmtCustoUsd(v: number): string {
  if (v > 0 && v < 0.01) return "menos de US$ 0,01";
  const s = (v < 0 ? 0 : v).toFixed(2).replace(".", ",");
  return `~US$ ${s}`;
}

/** Juiz nunca rodou neste brain? true quando NENHUM grupo tem recomendacoes com
 *  (aprovar+descartar+humano)>0. groups vazio → false (fila vazia tem outro estado). */
export function juizNuncaRodou(groups: HypothesisGroup[]): boolean {
  if (groups.length === 0) return false;
  for (const g of groups) {
    const r = g.recomendacoes;
    if (r && r.aprovar + r.descartar + r.humano > 0) return false;
  }
  return true;
}

/** §9.2.3 — a triagem está em andamento (lote aberto no Batch API)? terminal = concluido|nada_a_julgar. */
export function triagemEmAndamento(r: JudgeRun | null): boolean {
  if (!r) return false;
  return r.status === "batch_submetido" || r.status === "batch_em_andamento";
}
