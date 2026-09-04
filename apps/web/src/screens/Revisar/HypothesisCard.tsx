/** M21/S7 — card de uma hipótese na fila de revisão.
 *
 *  Família visual da tela Fontes (fontes.html: paleta âmbar --st-hypo/--st-hypo-soft) no
 *  padrão de card do console. Selo-linha → trecho → citação (de onde saiu) → motivo LEGÍVEL
 *  (REASON_LABEL; o enum nunca aparece cru) → ações (só em pendente) ou rodapé de decisão
 *  (quem/quando — a prova do invariante #5: nada descartado em silêncio).
 *
 *  Texto e quote são strings de fonte NÃO-confiável: renderizados como texto puro
 *  (React escapa; zero dangerouslySetInnerHTML).
 */
import { Button, Icon, StatusChip } from "../../ui";
import { fmtConfidence, fmtDateFull, relativeTime } from "../../lib/format";
import { rotuloRecomendacao } from "./logic";
import { REASON_LABEL, type Hypothesis } from "./types";

/** Chip mono neutro da dimensão da receita (ex.: "pedido", "preco_falado"). */
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

export function HypothesisCard(props: {
  item: Hypothesis;
  busy: boolean;
  onApprove?: () => void; // ausentes na aba decididas
  onDiscard?: () => void;
}) {
  const { item, busy, onApprove, onDiscard } = props;
  const pendente = item.status === "pendente";
  const decidedLabel =
    item.status === "aprovada" ? "aprovada" : item.status === "descartada" ? "descartada" : "";

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
        <StatusChip variant="hypo" label="Hipótese" size="sm" />
        <DimensionChip dimension={item.dimension} />
        <span className="mono" style={{ fontSize: 11.5, color: "var(--muted)" }}>
          via <b style={{ color: "var(--fg)" }}>{item.source_name || "fonte removida"}</b>
        </span>
        <span className="mono" style={{ fontSize: 11.5, color: "var(--faint)", marginLeft: "auto" }}>
          {relativeTime(item.created_at)}
        </span>
      </div>

      {/* 2 — o trecho (texto puro; React escapa) */}
      <p style={{ fontSize: 13.5, lineHeight: 1.55, color: "var(--fg)", margin: "10px 0 0" }}>
        {item.text}
      </p>

      {/* 3 — a citação: de onde saiu */}
      {item.quote && (
        <blockquote
          className="mono"
          style={{
            margin: "10px 0 0",
            padding: "8px 12px",
            borderLeft: "3px solid var(--st-hypo)",
            borderRadius: "0 8px 8px 0",
            background: "var(--surface-2)",
            fontSize: 12,
            lineHeight: 1.55,
            color: "var(--muted)",
          }}
        >
          “{item.quote}”
        </blockquote>
      )}

      {/* 4 — motivo SEMPRE legível (nunca o enum cru) */}
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: 7,
          marginTop: 10,
          fontSize: 12.5,
          lineHeight: 1.5,
          color: "oklch(42% 0.1 65)",
        }}
      >
        <span aria-hidden style={{ color: "var(--st-hypo)", flexShrink: 0, display: "inline-flex", marginTop: 1 }}>
          <Icon name="info" size={15} />
        </span>
        <span>{REASON_LABEL[item.reason]}</span>
      </div>

      {/* 4b — recomendação do juiz (M25-C): só em pendente e quando o juiz passou por aqui.
          Recomendação é INFORMAÇÃO — os botões Aprovar/Descartar não mudam (LEI I). */}
      {pendente && item.recomendacao ? (
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 7,
            marginTop: 8,
            padding: "7px 10px",
            borderRadius: 8,
            background: item.recomendacao === "humano" ? "var(--st-hypo-soft)" : "var(--surface-2)",
            fontSize: 12.5,
            lineHeight: 1.5,
          }}
        >
          <span className="mono" style={{ fontWeight: 600, whiteSpace: "nowrap" }}>
            {rotuloRecomendacao(item)}
            {item.recomendacao_confianca != null ? ` · ${fmtConfidence(item.recomendacao_confianca)}` : ""}
          </span>
          {item.recomendacao_motivo ? <span style={{ color: "var(--muted)" }}>{item.recomendacao_motivo}</span> : null}
        </div>
      ) : null}

      {/* 5 — pendente: ações · decidida: rodapé com quem/quando (invariante #5) */}
      {pendente ? (
        <footer
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 9,
            marginTop: 12,
            paddingTop: 12,
            borderTop: "1px dashed var(--border-strong)",
          }}
        >
          <Button size="sm" disabled={busy} onClick={onDiscard}>
            Descartar
          </Button>
          <Button size="sm" variant="primary" disabled={busy} onClick={onApprove}>
            Aprovar — vira fato
          </Button>
        </footer>
      ) : (
        <footer
          style={{
            display: "flex",
            alignItems: "center",
            gap: 9,
            flexWrap: "wrap",
            marginTop: 12,
            paddingTop: 12,
            borderTop: "1px dashed var(--border-strong)",
          }}
        >
          {item.status === "aprovada" ? (
            <span
              className="mono"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                fontSize: 10,
                fontWeight: 600,
                letterSpacing: ".03em",
                textTransform: "uppercase",
                padding: "3px 9px",
                borderRadius: 6,
                background: "var(--accent-soft)",
                color: "var(--accent-ink)",
              }}
            >
              <span aria-hidden style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--accent)" }} />
              Aprovada
            </span>
          ) : (
            <span
              className="mono"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                fontSize: 10,
                fontWeight: 600,
                letterSpacing: ".03em",
                textTransform: "uppercase",
                padding: "3px 9px",
                borderRadius: 6,
                background: "var(--st-arch-soft)",
                color: "var(--st-arch)",
              }}
            >
              <span aria-hidden style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--st-arch)" }} />
              Descartada
            </span>
          )}
          <span className="mono" style={{ fontSize: 11, color: "var(--faint)" }}>
            {decidedLabel} por <b style={{ color: "var(--muted)" }}>{item.decided_by || "—"}</b>
            {item.decided_at ? ` · ${fmtDateFull(item.decided_at)}` : ""}
          </span>
        </footer>
      )}
    </article>
  );
}

export default HypothesisCard;
