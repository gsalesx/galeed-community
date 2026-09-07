/** ConfirmDialog — popup de confirmação GLOBAL do app.
 *
 *  Use este componente em vez de `window.confirm` ou de um Modal local só de “tem certeza?”.
 *  API: título + texto + Cancelar + Confirmar (opcionalmente perigo).
 *
 *  Ex.:
 *    <ConfirmDialog
 *      open={!!pedido}
 *      title="Pausar fonte"
 *      text="As mensagens param de entrar. O que já está no cérebro permanece."
 *      confirmLabel="Pausar"
 *      danger
 *      onConfirm={executar}
 *      onCancel={fechar}
 *    />
 */
import { Button, Modal } from "../../ui";

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  text: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Confirmar em vermelho (ação destrutiva / irreversível). */
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  text,
  confirmLabel = "Confirmar",
  cancelLabel = "Cancelar",
  danger = false,
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <Modal
      open={open}
      onClose={busy ? () => {} : onCancel}
      title={title}
      width={440}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button
            variant="primary"
            onClick={onConfirm}
            disabled={busy}
            style={danger ? { background: "var(--danger)", borderColor: "var(--danger)" } : undefined}
          >
            {busy ? "Aguarde…" : confirmLabel}
          </Button>
        </>
      }
    >
      <p style={{ margin: 0, fontSize: 14.5, lineHeight: 1.5 }}>{text}</p>
    </Modal>
  );
}

export default ConfirmDialog;
