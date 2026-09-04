/** Modal — overlay + dialog flutuante (--shadow). Fecha no ESC e no backdrop.
 *  Trava o scroll do body enquanto aberto. */
import { useEffect } from "react";
import type { CSSProperties, ReactNode } from "react";
import { Icon } from "./Icon";

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  /** largura máx do dialog (default 480) */
  width?: number;
  style?: CSSProperties;
}

export function Modal({ open, onClose, title, children, footer, width = 480, style }: ModalProps) {
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      role="presentation"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        display: "grid",
        placeItems: "center",
        padding: 20,
        background: "oklch(22% 0.02 240 / .35)",
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%",
          maxWidth: width,
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: 13,
          boxShadow: "var(--shadow)",
          overflow: "hidden",
          ...style,
        }}
      >
        {(title != null || true) && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              padding: "14px 18px",
              borderBottom: "1px solid var(--border)",
            }}
          >
            <strong style={{ fontSize: 16, fontWeight: 600 }}>{title}</strong>
            <button
              type="button"
              aria-label="Fechar"
              onClick={onClose}
              style={{
                display: "grid",
                placeItems: "center",
                width: 28,
                height: 28,
                border: "1px solid transparent",
                borderRadius: 8,
                background: "transparent",
                color: "var(--muted)",
                cursor: "pointer",
              }}
            >
              <Icon name="x" size={16} />
            </button>
          </div>
        )}
        <div style={{ padding: "18px" }}>{children}</div>
        {footer != null && (
          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              gap: 10,
              padding: "14px 18px",
              borderTop: "1px solid var(--border)",
            }}
          >
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

export default Modal;
