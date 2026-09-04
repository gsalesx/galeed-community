/** Chip / FilterChip — pílula com bolinha categórica + label, alternável.
 *  on → texto --accent-ink, fundo --accent-soft, border oklch(88% 0.04 150). */
import type { CSSProperties, ReactNode } from "react";

export interface ChipProps {
  children: ReactNode;
  /** estado ligado/desligado */
  active?: boolean;
  /** cor da bolinha categórica (.sw2). Omitir = sem bolinha */
  dotColor?: string;
  onToggle?: () => void;
  style?: CSSProperties;
}

export function Chip({ children, active = false, dotColor, onToggle, style }: ChipProps) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onToggle}
      className="mono"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 7,
        height: 32,
        padding: "0 12px",
        borderRadius: 99,
        border: `1px solid ${active ? "oklch(88% 0.04 150)" : "var(--border-strong)"}`,
        background: active ? "var(--accent-soft)" : "var(--surface)",
        color: active ? "var(--accent-ink)" : "var(--fg)",
        fontSize: 12,
        fontWeight: 600,
        cursor: onToggle ? "pointer" : "default",
        transition: "background .12s, border-color .12s, color .12s",
        ...style,
      }}
    >
      {dotColor && (
        <span
          aria-hidden
          style={{ width: 9, height: 9, borderRadius: "50%", background: dotColor, flexShrink: 0 }}
        />
      )}
      {children}
    </button>
  );
}

export default Chip;
