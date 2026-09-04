/** Brand — glyph quadrado escuro com a logo (monte de Gênesis 31:48) em branco
 *  + wordmark "Galeed". Logo: web/public/galeed-logo.png (renderizada branca
 *  via filter sobre badge --ink). */
import type { CSSProperties } from "react";

export interface BrandProps {
  /** lado do glyph em px (default 30) */
  size?: number;
  /** mostrar wordmark "Galeed" ao lado (default true) */
  withWordmark?: boolean;
  /** só o glyph, sem wordmark (atalho de withWordmark={false}) */
  glyphOnly?: boolean;
  /** sub-rótulo mono pequeno abaixo do wordmark */
  subLabel?: string;
  style?: CSSProperties;
}

const LOGO_SRC = "/galeed-logo.png";

export function Brand({ size = 30, withWordmark = true, glyphOnly = false, subLabel, style }: BrandProps) {
  const showWord = withWordmark && !glyphOnly;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 10, ...style }}>
      <span
        aria-hidden
        style={{
          width: size,
          height: size,
          borderRadius: 8,
          background: "var(--ink)",
          display: "grid",
          placeItems: "center",
          flexShrink: 0,
        }}
      >
        <img
          src={LOGO_SRC}
          alt=""
          style={{
            width: "100%",
            height: "100%",
            objectFit: "contain",
            padding: "16%",
            // renderiza branco sobre o badge escuro
            filter: "brightness(0) invert(1)",
          }}
        />
      </span>
      {showWord && (
        <span style={{ display: "inline-flex", flexDirection: "column", lineHeight: 1.1 }}>
          <strong style={{ fontSize: 17, fontWeight: 700, letterSpacing: "-0.02em", color: "var(--fg)" }}>
            Galeed
          </strong>
          {subLabel && (
            <span className="mono" style={{ fontSize: 10.5, color: "var(--faint)" }}>
              {subLabel}
            </span>
          )}
        </span>
      )}
    </span>
  );
}

export default Brand;
