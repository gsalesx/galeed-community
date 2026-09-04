/** LockChip — cadeado de sigilo (.s-lock). Ícone SVG cadeado 11px + label.
 *  Aberto usa gancho aberto; demais usam gancho fechado. Item secreto/restrito
 *  fica vermelho (--sn-secret). */
import type { CSSProperties } from "react";
import { Icon } from "./Icon";

export type LockLevel = "open" | "int" | "conf" | "secret";

const LABEL: Record<LockLevel, string> = {
  open: "Aberto",
  int: "Interno",
  conf: "Sigiloso",
  secret: "Secreto",
};

const STYLE: Record<LockLevel, { fg: string; bg: string }> = {
  open: { fg: "var(--sn-open)", bg: "var(--sn-open-soft)" },
  int: { fg: "var(--sn-int)", bg: "var(--sn-int-soft)" },
  conf: { fg: "var(--sn-conf)", bg: "var(--sn-conf-soft)" },
  secret: { fg: "var(--sn-secret)", bg: "var(--sn-secret-soft)" },
};

export interface LockChipProps {
  level: LockLevel;
  /** mostrar texto do nível (default true). Quando false, só o ícone. */
  showLabel?: boolean;
  style?: CSSProperties;
}

export function LockChip({ level, showLabel = true, style }: LockChipProps) {
  const c = STYLE[level];
  return (
    <span
      className="mono"
      title={LABEL[level]}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        color: c.fg,
        background: c.bg,
        fontSize: 11,
        fontWeight: 600,
        padding: "3px 8px",
        borderRadius: 6,
        whiteSpace: "nowrap",
        ...style,
      }}
    >
      <Icon name={level === "open" ? "lock-open" : "lock-closed"} size={11} />
      {showLabel && LABEL[level]}
    </span>
  );
}

export default LockChip;
