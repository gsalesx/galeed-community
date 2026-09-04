/** M25-C — card de um GRUPO-decisão da fila (reason × dimension × fonte).
 *
 *  Família visual do HypothesisCard (--surface, borda --border, radius 12, padding 14×16).
 *  Props-only: TODOS os dados vêm via props; a junção (despacho das ações) é o index.tsx.
 *  Zero LLM, zero fetch aqui — só EXIBE e dispara onAcao.
 *
 *  text/quote/decisao/motivo são strings de fonte não-confiável → texto puro (React escapa).
 */
import type { ReactElement } from "react";
import { Button, StatusChip } from "../../ui";
import { fmtConfidence, fmtNumber } from "../../lib/format";
import {
  acoesDoGrupo, decisaoDoGrupo, rotuloAcerto, rotuloRecomendacao, type AcaoDeGrupo,
} from "./logic";
import type { HypothesisGroup, JudgeCalibrationSegment, Hypothesis } from "./types";

/** Chip mono neutro da dimensão (mesma anatomia do DimensionChip do HypothesisCard — local). */
function DimensionChip({ dimension }: { dimension: string }) {
  if (!dimension) return null;
  return (
    <span
      className="mono"
      style={{
        display: "inline-flex",
        alignItems: "center",
        fontSize: 10.5,
        fontWeight: 600,
        letterSpacing: ".03em",
        textTransform: "uppercase",
        padding: "3px 8px",
        borderRadius: 6,
        background: "var(--surface-2)",
        border: "1px solid var(--border)",
        color: "var(--muted)",
        whiteSpace: "nowrap",
      }}
    >
      {dimension}
    </span>
  );
}

export interface GroupCardProps {
  group: HypothesisGroup;
  segmento?: JudgeCalibrationSegment;
  busy: boolean;
  expandido: boolean;
  onToggleExpand: () => void;
  onAcao: (acao: AcaoDeGrupo) => void;
}

export function GroupCard(props: GroupCardProps): ReactElement {
  const { group, segmento, busy, expandido, onToggleExpand, onAcao } = props;
  const acoes = acoesDoGrupo(group);
  const semFonte = group.source_id === "";
  const rec = group.recomendacoes;
  const temRec = !!rec && rec.aprovar + rec.descartar + rec.humano > 0;
  const linhaAcerto = rotuloAcerto(segmento);
  const temReceita = acoes.includes("receita");

  return (
    <article
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: 12,
        padding: "14px 16px",
      }}
    >
      {/* 1 — linha-selo */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <StatusChip variant="hypo" size="sm" label="Grupo" />
        <DimensionChip dimension={group.dimension} />
        <span className="mono" style={{ fontSize: 12, color: "var(--muted)" }}>
          <b className="mono" style={{ color: "var(--fg)" }}>{fmtNumber(group.count)}</b> itens
        </span>
        <span className="mono" style={{ fontSize: 11.5, color: "var(--muted)" }}>
          {semFonte ? (
            "vindos do sono do cérebro"
          ) : (
            <>via <b style={{ color: "var(--fg)" }}>{group.source_name || "fonte removida"}</b></>
          )}
        </span>
      </div>

      {/* 2 — a decisão */}
      <p style={{ fontSize: 13.5, lineHeight: 1.55, color: "var(--fg)", margin: "10px 0 0" }}>
        {decisaoDoGrupo(group)}
      </p>

      {/* 3 — linha do juiz (só quando há recomendações) */}
      {temRec && rec && (
        <p className="mono" style={{ fontSize: 12, color: "var(--accent-ink)", margin: "8px 0 0", lineHeight: 1.5 }}>
          {[
            rec.aprovar > 0 ? `o juiz recomenda aprovar ${fmtNumber(rec.aprovar)}` : null,
            rec.descartar > 0 ? `descartar ${fmtNumber(rec.descartar)}` : null,
            rec.humano > 0 ? `quer você em ${fmtNumber(rec.humano)}` : null,
          ].filter(Boolean).join(" · ")}
          {rec.sem_recomendacao > 0 ? (
            <span style={{ color: "var(--faint)" }}>{` · ${fmtNumber(rec.sem_recomendacao)} sem triagem`}</span>
          ) : null}
        </p>
      )}

      {/* 4 — linha do acerto do juiz neste segmento */}
      {linhaAcerto !== "" && (
        <p className="mono" style={{ fontSize: 11.5, color: "var(--muted)", margin: "6px 0 0" }}>
          {linhaAcerto}
        </p>
      )}

      {/* 5 — amostra expandível */}
      {group.amostra.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <Button variant="ghost" size="sm" onClick={onToggleExpand}>
            {expandido ? "Esconder amostra" : `Ver amostra (${group.amostra.length})`}
          </Button>
          {expandido && (
            <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 8 }}>
              {group.amostra.map((item) => (
                <AmostraItem key={item.id} item={item} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* 6 — rodapé de ações (ordem de acoesDoGrupo) */}
      <footer
        style={{
          display: "flex",
          justifyContent: "flex-end",
          flexWrap: "wrap",
          gap: 9,
          marginTop: 12,
          paddingTop: 12,
          borderTop: "1px dashed var(--border-strong)",
        }}
      >
        {acoes.map((acao) => {
          if (acao === "receita") {
            return (
              <Button key={acao} size="sm" variant="primary" disabled={busy} onClick={() => onAcao(acao)}>
                {`Adicionar "${group.dimension}" à receita e aprovar os ancorados`}
              </Button>
            );
          }
          if (acao === "aprovar_recomendados") {
            return (
              <Button
                key={acao}
                size="sm"
                variant={temReceita ? "secondary" : "primary"}
                disabled={busy}
                onClick={() => onAcao(acao)}
              >
                {`Aprovar recomendados (${fmtNumber(rec?.aprovar ?? 0)})`}
              </Button>
            );
          }
          if (acao === "descartar") {
            return (
              <Button key={acao} size="sm" variant="secondary" disabled={busy} onClick={() => onAcao(acao)}>
                Descartar grupo
              </Button>
            );
          }
          // um_a_um
          return (
            <Button key={acao} size="sm" variant="ghost" disabled={busy} onClick={() => onAcao(acao)}>
              Revisar um a um
            </Button>
          );
        })}
      </footer>
    </article>
  );
}

/** Um item da amostra (text + citação âmbar + badge de recomendação quando houver). */
function AmostraItem({ item }: { item: Hypothesis }) {
  const rotulo = rotuloRecomendacao(item);
  return (
    <div style={{ paddingLeft: 2 }}>
      <p style={{ fontSize: 13, lineHeight: 1.5, color: "var(--fg)", margin: 0 }}>{item.text}</p>
      {item.quote && (
        <blockquote
          className="mono"
          style={{
            margin: "6px 0 0",
            padding: "7px 11px",
            borderLeft: "3px solid var(--st-hypo)",
            borderRadius: "0 8px 8px 0",
            background: "var(--surface-2)",
            fontSize: 11.5,
            lineHeight: 1.5,
            color: "var(--muted)",
          }}
        >
          “{item.quote}”
        </blockquote>
      )}
      {rotulo !== "" && (
        <div style={{ display: "flex", alignItems: "baseline", gap: 7, marginTop: 6, fontSize: 12, lineHeight: 1.5 }}>
          <span className="mono" style={{ fontWeight: 600, whiteSpace: "nowrap", color: "var(--accent-ink)" }}>
            {rotulo}
            {item.recomendacao_confianca != null ? ` · ${fmtConfidence(item.recomendacao_confianca)}` : ""}
          </span>
          {item.recomendacao_motivo ? (
            <span style={{ color: "var(--muted)" }}>{item.recomendacao_motivo}</span>
          ) : null}
        </div>
      )}
    </div>
  );
}

export default GroupCard;
