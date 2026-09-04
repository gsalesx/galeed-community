/** StatusChip — chip epistêmico do selo (.s-status). Mono uppercase + bolinha
 *  categórica. As 5 variantes do status do selo (fato/hipótese/arquivado/
 *  registro/pessoa). Hipótese NUNCA pode parecer fato — cor sagrada. */
import type { CSSProperties } from "react";

export type StatusVariant = "fact" | "hypo" | "arch" | "reg" | "ent";

const LABEL: Record<StatusVariant, string> = {
  fact: "Fato",
  hypo: "Hipótese",
  arch: "Arquivado",
  reg: "Registro",
  ent: "Pessoa",
};

// cor (texto), soft (fundo), dot (bolinha). Hipótese tem texto âmbar mais
// escuro (oklch literal do 00-foundation §1.7) para contraste.
const STYLE: Record<StatusVariant, { fg: string; bg: string; dot: string }> = {
  fact: { fg: "var(--st-fact)", bg: "var(--st-fact-soft)", dot: "var(--st-fact)" },
  hypo: { fg: "oklch(48% 0.12 65)", bg: "var(--st-hypo-soft)", dot: "var(--st-hypo)" },
  arch: { fg: "var(--st-arch)", bg: "var(--st-arch-soft)", dot: "var(--st-arch)" },
  reg: { fg: "var(--st-reg)", bg: "var(--st-reg-soft)", dot: "var(--st-reg)" },
  ent: { fg: "var(--st-ent)", bg: "var(--st-ent-soft)", dot: "var(--st-ent)" },
};

export interface StatusChipProps {
  variant: StatusVariant;
  /** mostrar bolinha categórica (default true) */
  withDot?: boolean;
  /** sobrescrever o rótulo padrão */
  label?: string;
  size?: "sm" | "md";
  style?: CSSProperties;
}

export function StatusChip({ variant, withDot = true, label, size = "md", style }: StatusChipProps) {
  const c = STYLE[variant];
  return (
    <span
      className="mono"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        color: c.fg,
        background: c.bg,
        fontSize: size === "sm" ? 10 : 11,
        fontWeight: 600,
        letterSpacing: ".03em",
        textTransform: "uppercase",
        padding: "3px 9px",
        borderRadius: 6,
        whiteSpace: "nowrap",
        ...style,
      }}
    >
      {withDot && (
        <span
          aria-hidden
          style={{
            width: 7,
            height: 7,
            borderRadius: "50%",
            background: c.dot,
            flexShrink: 0,
          }}
        />
      )}
      {label ?? LABEL[variant]}
    </span>
  );
}

export default StatusChip;
