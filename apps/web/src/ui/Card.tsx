/** Card — superfície base (.mcard/.vcard). Plano por default (só borda);
 *  elevated adiciona --shadow. header/footer opcionais. */
import type { CSSProperties, ReactNode } from "react";

export interface CardProps {
  children?: ReactNode;
  elevated?: boolean;
  /** padding do corpo (default "18px 20px" conforme vcard) */
  padding?: string | number;
  header?: ReactNode;
  footer?: ReactNode;
  className?: string;
  style?: CSSProperties;
}

export function Card({ children, elevated, padding = "18px 20px", header, footer, className, style }: CardProps) {
  return (
    <div
      className={className}
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: 13,
        boxShadow: elevated ? "var(--shadow)" : undefined,
        overflow: "hidden",
        ...style,
      }}
    >
      {header != null && (
        <div
          style={{
            padding: "12px 20px",
            background: "var(--surface-2)",
            borderBottom: "1px solid var(--border)",
          }}
        >
          {header}
        </div>
      )}
      {children != null && <div style={{ padding }}>{children}</div>}
      {footer != null && (
        <div style={{ padding: "12px 20px", borderTop: "1px solid var(--border)", color: "var(--muted)" }}>
          {footer}
        </div>
      )}
    </div>
  );
}

export default Card;
