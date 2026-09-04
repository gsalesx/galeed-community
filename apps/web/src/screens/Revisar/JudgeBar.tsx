/** M25-C — barra do JUIZ triador (entre o header e as abas, só na aba "grupos" e com pendentes>0).
 *
 *  O juiz RECOMENDA, nunca aprova (LEI I): esta barra só TRIA (custa dinheiro — estimativa antes,
 *  no modal do index) e INFORMA. Nenhum botão de aprovar mora aqui. Props-only.
 */
import type { ReactElement } from "react";
import { Button, Card } from "../../ui";
import { fmtCustoUsd } from "./logic";
import type { JudgeRun } from "./types";

export interface JudgeBarProps {
  pendentes: number;
  nuncaRodou: boolean;
  semDecisoes: boolean;
  totalAcerto: { taxa: number; n: number } | null;
  triando: boolean;
  ultimaTriagem: JudgeRun | null;
  onTriar: () => void;
}

export function JudgeBar(props: JudgeBarProps): ReactElement {
  const { nuncaRodou, semDecisoes, totalAcerto, triando, ultimaTriagem, onTriar } = props;

  // Centro: por precedência (triando > nuncaRodou > semDecisoes > totalAcerto > "").
  let centro = "";
  if (triando) centro = "O juiz está triando a fila…";
  else if (nuncaRodou) centro = "O juiz ainda não triou esta fila.";
  else if (semDecisoes) {
    centro = "O juiz ainda não conhece seu critério — decida alguns itens e a triagem aprende com você.";
  } else if (totalAcerto) {
    centro = `o juiz acerta ${Math.round(totalAcerto.taxa * 100)}% das suas decisões (n=${totalAcerto.n})`;
  }

  const direita =
    ultimaTriagem?.status === "concluido"
      ? `última triagem: ${ultimaTriagem.julgados} itens · aprovar ${ultimaTriagem.distribuicao.aprovar}` +
        ` · descartar ${ultimaTriagem.distribuicao.descartar} · você ${ultimaTriagem.distribuicao.humano}` +
        ` · ${fmtCustoUsd(ultimaTriagem.custo_usd)}`
      : "";

  return (
    <Card padding="12px 16px" style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
        <Button variant="primary" size="sm" disabled={triando} onClick={onTriar}>
          {triando ? "Triando…" : "Triar com o juiz"}
        </Button>
        {centro && (
          <span className="mono" style={{ fontSize: 12, color: "var(--muted)", flex: 1, minWidth: 0 }}>
            {centro}
          </span>
        )}
        {direita && (
          <span className="mono" style={{ fontSize: 11.5, color: "var(--faint)", marginLeft: centro ? 0 : "auto" }}>
            {direita}
          </span>
        )}
      </div>
    </Card>
  );
}

export default JudgeBar;
