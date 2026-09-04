/** SearchInput — campo de busca (.field). Ícone lupa à esquerda, atalho
 *  opcional à direita. Foco: anel accent-soft + border accent (via base.css). */
import type { CSSProperties, InputHTMLAttributes, ReactNode } from "react";
import { Icon } from "./Icon";

export interface SearchInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size"> {
  /** ícone à esquerda (default = lupa) */
  icon?: ReactNode;
  /** dica de atalho à direita, ex "/" ou "⌘K" */
  shortcut?: string;
  wrapStyle?: CSSProperties;
}

export function SearchInput({ icon, shortcut, wrapStyle, style, ...rest }: SearchInputProps) {
  return (
    <div style={{ position: "relative", display: "inline-flex", width: "100%", ...wrapStyle }}>
      <span
        aria-hidden
        style={{ position: "absolute", left: 11, top: 11, color: "var(--faint)", pointerEvents: "none" }}
      >
        {icon ?? <Icon name="search" size={16} />}
      </span>
      <input
        type="search"
        {...rest}
        style={{
          width: "100%",
          height: 38,
          border: "1px solid var(--border-strong)",
          borderRadius: 8,
          padding: `0 ${shortcut ? 34 : 12}px 0 34px`,
          background: "var(--surface)",
          color: "var(--fg)",
          fontFamily: "var(--font)",
          fontSize: 14,
          ...style,
        }}
      />
      {shortcut && (
        <kbd
          className="mono"
          style={{
            position: "absolute",
            right: 9,
            top: 8,
            fontSize: 11,
            color: "var(--faint)",
            background: "var(--surface-2)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            padding: "2px 6px",
            pointerEvents: "none",
          }}
        >
          {shortcut}
        </kbd>
      )}
    </div>
  );
}

export default SearchInput;
