/** M25-C — modal de resultado de um lote: números SEMPRE (resumoLote) + os retidos com o porquê.
 *
 *  Os porquês vêm PRONTOS do gate determinístico do M25-A — o front NÃO reescreve nem traduz.
 */
import type { ReactElement } from "react";
import { Button, Modal } from "../../ui";
import { resumoLote } from "./logic";
import type { BatchApproveResult } from "./types";

export interface RetidosModalProps {
  open: boolean;
  onClose: () => void;
  resultado: BatchApproveResult | null;
}

export function RetidosModal(props: RetidosModalProps): ReactElement | null {
  const { open, onClose, resultado } = props;
  if (!resultado) return null;
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Resultado do lote"
      width={560}
      footer={
        <Button variant="secondary" onClick={onClose}>
          Fechar
        </Button>
      }
    >
      <p style={{ fontSize: 14, lineHeight: 1.55, margin: 0 }}>{resumoLote(resultado)}</p>
      {resultado.retidos.length > 0 && (
        <div style={{ maxHeight: 320, overflow: "auto", marginTop: 12, display: "flex", flexDirection: "column", gap: 6 }}>
          {resultado.retidos.map((r) => (
            <div key={r.id} style={{ fontSize: 12.5, lineHeight: 1.5 }}>
              <span className="mono" style={{ color: "var(--faint)" }}>{r.id.slice(0, 8)}</span>
              {" — "}
              {r.porque}
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

export default RetidosModal;
