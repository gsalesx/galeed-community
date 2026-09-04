/** Icon — SVGs inline (sem lib). Stroke-based, herda currentColor.
 *  Nomeados por `name`; tamanho via prop (default 16). */
import type { CSSProperties } from "react";

export type IconName =
  | "search"
  | "arrow"
  | "lock-open"
  | "lock-closed"
  | "clock"
  | "check"
  | "x"
  | "info"
  | "chevron"
  | "plus"
  | "round"
  // proveniência
  | "whatsapp"
  | "email"
  | "call"
  | "pdf"
  | "audio";

export interface IconProps {
  name: IconName;
  size?: number;
  /** filled icons (pdf/audio glyphs) usam fill; default é stroke */
  className?: string;
  style?: CSSProperties;
  title?: string;
}

export function Icon({ name, size = 16, className, style, title }: IconProps) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    className,
    style,
    role: title ? ("img" as const) : ("presentation" as const),
    "aria-hidden": title ? undefined : true,
  };
  return (
    <svg {...common}>
      {title ? <title>{title}</title> : null}
      {paths(name)}
    </svg>
  );
}

function paths(name: IconName) {
  switch (name) {
    case "search":
      return (
        <>
          <circle cx="11" cy="11" r="7" />
          <path d="m21 21-4.3-4.3" />
        </>
      );
    case "arrow":
      return (
        <>
          <path d="M5 12h14" />
          <path d="m13 6 6 6-6 6" />
        </>
      );
    case "lock-open":
      return (
        <>
          <rect x="5" y="11" width="14" height="9" rx="2" />
          <path d="M8 11V7a4 4 0 0 1 7-2.6" />
        </>
      );
    case "lock-closed":
      return (
        <>
          <rect x="5" y="11" width="14" height="9" rx="2" />
          <path d="M8 11V8a4 4 0 0 1 8 0v3" />
        </>
      );
    case "clock":
      return (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </>
      );
    case "check":
      return <path d="m5 13 4 4 10-10" />;
    case "x":
      return (
        <>
          <path d="M6 6l12 12" />
          <path d="M18 6 6 18" />
        </>
      );
    case "info":
      return (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 11v5" />
          <path d="M12 8h.01" />
        </>
      );
    case "chevron":
      return <path d="m9 6 6 6-6 6" />;
    case "round": // moeda/crédito (token)
      return (
        <>
          <circle cx="12" cy="12" r="9" />
          <circle cx="12" cy="12" r="3.5" />
        </>
      );
    case "plus":
      return (
        <>
          <path d="M12 5v14" />
          <path d="M5 12h14" />
        </>
      );
    case "whatsapp":
      return (
        <>
          <path d="M3.5 20.5 5 16a8 8 0 1 1 3 3l-4.5 1.5z" />
          <path d="M9 9.5c0 3 2.5 5.5 5.5 5.5l1-1.2-1.8-1-1 .8a4 4 0 0 1-2.3-2.3l.8-1-1-1.8L9 9.5z" />
        </>
      );
    case "email":
      return (
        <>
          <rect x="3" y="5" width="18" height="14" rx="2" />
          <path d="m3.5 6.5 8.5 6 8.5-6" />
        </>
      );
    case "call":
      return (
        <path d="M5 3.5h3l1.5 4-2 1.5a11 11 0 0 0 5 5l1.5-2 4 1.5v3a2 2 0 0 1-2 2A16 16 0 0 1 3 5.5a2 2 0 0 1 2-2z" />
      );
    case "pdf":
      return (
        <>
          <path d="M7 3h7l4 4v14H7z" />
          <path d="M14 3v4h4" />
          <path d="M9.5 13h1.2a1.2 1.2 0 0 1 0 2.4H9.5z" />
          <path d="M9.5 17.5V13" />
          <path d="M14 13v4.5M14 13h1.6M14 15.2h1.2" />
        </>
      );
    case "audio":
      return (
        <>
          <path d="M4 10v4" />
          <path d="M8 7v10" />
          <path d="M12 4v16" />
          <path d="M16 7v10" />
          <path d="M20 10v4" />
        </>
      );
  }
}

export default Icon;
