/** KpiTile — número mono grande + rótulo + delta opcional (.kpi).
 *  Placeholder honesto: sem valor real, passar "—" (traço), nunca inventar. */
import type { CSSProperties } from "react";

export interface KpiTileProps {
  value: string | number;
  label: string;
  /** ex "+12" (verde --ok) ou "-3" (--danger se começar com "-") */
  delta?: string;
  style?: CSSProperties;
}

export function KpiTile({ value, label, delta, style }: KpiTileProps) {
  const negative = typeof delta === "string" && delta.trim().startsWith("-");
  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: 11,
        padding: "13px 15px",
        minWidth: 120,
        background: "var(--surface)",
        ...style,
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <b className="mono" style={{ fontSize: 24, fontWeight: 600, lineHeight: 1 }}>
          {value}
        </b>
        {delta && (
          <span
            className="mono"
            style={{ fontSize: 11, fontWeight: 600, color: negative ? "var(--danger)" : "var(--ok)" }}
          >
            {delta}
          </span>
        )}
      </div>
      <small style={{ display: "block", marginTop: 6, fontSize: 11.5, color: "var(--faint)" }}>{label}</small>
    </div>
  );
}

export default KpiTile;
