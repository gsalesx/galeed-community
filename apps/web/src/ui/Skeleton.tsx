/** Skeleton + Loading "pensando".
 *  - SkeletonBar: barra cinza (height 6-7px, --border) — placeholder honesto.
 *  - Loading variant="thinking": glyph girando + dots saltando (perguntar.html).
 *  - Loading variant="bar": pilha de barras.
 *  Respeita prefers-reduced-motion (animações zeradas via base.css). */
import type { CSSProperties } from "react";
import { Brand } from "./Brand";

export interface SkeletonProps {
  width?: number | string;
  height?: number;
  radius?: number;
  style?: CSSProperties;
}

/** Barra de placeholder (base do .ask-ln / .appbars i / .acc-row .ln). */
export function Skeleton({ width = "100%", height = 7, radius = 3, style }: SkeletonProps) {
  return (
    <span
      aria-hidden
      style={{
        display: "block",
        width,
        height,
        borderRadius: radius,
        background: "var(--border)",
        animation: "skeleton-pulse 1.4s ease-in-out infinite",
        ...style,
      }}
    />
  );
}

export interface LoadingProps {
  variant?: "thinking" | "bar";
  /** label de cortesia, ex "Pensando…" */
  label?: string;
  /** nº de barras quando variant="bar" */
  lines?: number;
  style?: CSSProperties;
}

export function Loading({ variant = "thinking", label = "Pensando…", lines = 3, style }: LoadingProps) {
  if (variant === "bar") {
    return (
      <div style={{ display: "grid", gap: 9, ...style }} role="status" aria-label={label}>
        {Array.from({ length: lines }).map((_, i) => (
          <Skeleton key={i} width={i === lines - 1 ? "60%" : "100%"} />
        ))}
      </div>
    );
  }
  // thinking
  return (
    <div
      role="status"
      aria-label={label}
      style={{ display: "inline-flex", alignItems: "center", gap: 12, color: "var(--muted)", ...style }}
    >
      <span
        aria-hidden
        style={{
          width: 30,
          height: 30,
          borderRadius: 9,
          display: "grid",
          placeItems: "center",
          border: "1px solid var(--border-strong)",
          background: "var(--surface)",
        }}
      >
        <span style={{ display: "grid", placeItems: "center", animation: "spin 1.4s linear infinite" }}>
          <Brand size={18} glyphOnly />
        </span>
      </span>
      <span style={{ display: "inline-flex", gap: 4 }} aria-hidden>
        {[0, 0.15, 0.3].map((d, i) => (
          <span
            key={i}
            style={{
              width: 5,
              height: 5,
              borderRadius: "50%",
              background: "var(--st-reg)",
              animation: "bounce 1.2s ease-in-out infinite",
              animationDelay: `${d}s`,
            }}
          />
        ))}
      </span>
      {label && <span style={{ fontSize: 13 }}>{label}</span>}
    </div>
  );
}

export default Skeleton;
