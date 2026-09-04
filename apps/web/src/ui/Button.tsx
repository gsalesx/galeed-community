/** Button — .btn + variantes. primary (accent) / secondary (borda) / ghost.
 *  size sm = 30px. Ícone opcional à esquerda. Um primary por contexto. */
import type { ButtonHTMLAttributes, ReactNode } from "react";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "ghost";
  size?: "sm" | "md";
  icon?: ReactNode;
  children?: ReactNode;
}

export function Button({
  variant = "secondary",
  size = "md",
  icon,
  children,
  style,
  ...rest
}: ButtonProps) {
  const sm = size === "sm";
  const base = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    height: sm ? 30 : 36,
    padding: sm ? "0 11px" : "0 15px",
    borderRadius: 8,
    fontFamily: "var(--font)",
    fontWeight: 600,
    fontSize: sm ? 12 : 13,
    cursor: rest.disabled ? "not-allowed" : "pointer",
    opacity: rest.disabled ? 0.55 : 1,
    transition: "background .12s, border-color .12s, color .12s",
    whiteSpace: "nowrap" as const,
  };

  const variants = {
    primary: {
      background: "var(--accent)",
      border: "1px solid var(--accent)",
      color: "#fff",
    },
    secondary: {
      background: "var(--surface)",
      border: "1px solid var(--border-strong)",
      color: "var(--fg)",
    },
    ghost: {
      background: "transparent",
      border: "1px solid transparent",
      color: "var(--accent-ink)",
    },
  } as const;

  return (
    <button
      {...rest}
      data-variant={variant}
      style={{ ...base, ...variants[variant], ...style }}
    >
      {icon}
      {children}
    </button>
  );
}

export default Button;
