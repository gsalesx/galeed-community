/** Toast — notificação efêmera. Fundo --ink (tinta escura), pílula 99px.
 *  Auto-dismiss opcional. Tom funcional opcional via ícone/cor de acento. */
import { useEffect } from "react";
import type { CSSProperties, ReactNode } from "react";
import { Icon } from "./Icon";
import type { IconName } from "./Icon";

export type ToastTone = "neutral" | "ok" | "warn" | "danger";

const TONE_ICON: Record<ToastTone, IconName | null> = {
  neutral: null,
  ok: "check",
  warn: "info",
  danger: "x",
};

const TONE_COLOR: Record<ToastTone, string> = {
  neutral: "oklch(82% 0.015 240)",
  ok: "var(--ok)",
  warn: "var(--warn)",
  danger: "var(--danger)",
};

export interface ToastProps {
  children: ReactNode;
  tone?: ToastTone;
  /** ms até auto-fechar; 0 = não fecha sozinho */
  duration?: number;
  onClose?: () => void;
  style?: CSSProperties;
}

export function Toast({ children, tone = "neutral", duration = 3500, onClose, style }: ToastProps) {
  useEffect(() => {
    if (!duration || !onClose) return;
    const t = setTimeout(onClose, duration);
    return () => clearTimeout(t);
  }, [duration, onClose]);

  const icon = TONE_ICON[tone];

  return (
    <div
      role="status"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 9,
        maxWidth: 420,
        padding: "10px 16px",
        borderRadius: 99,
        background: "var(--ink)",
        color: "oklch(90% 0.01 240)",
        boxShadow: "var(--shadow)",
        fontSize: 13.5,
        ...style,
      }}
    >
      {icon && (
        <span style={{ display: "grid", placeItems: "center", color: TONE_COLOR[tone], flexShrink: 0 }}>
          <Icon name={icon} size={15} />
        </span>
      )}
      <span>{children}</span>
      {onClose && (
        <button
          type="button"
          aria-label="Fechar"
          onClick={onClose}
          style={{
            display: "grid",
            placeItems: "center",
            marginLeft: 4,
            width: 22,
            height: 22,
            border: "none",
            borderRadius: 6,
            background: "transparent",
            color: "oklch(70% 0.01 240)",
            cursor: "pointer",
          }}
        >
          <Icon name="x" size={14} />
        </button>
      )}
    </div>
  );
}

export default Toast;
