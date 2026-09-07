/** Peças visuais do “plugue” (API/MCP/webhook) — reuso em Fontes e Acesso. */
import { Button, Chip, Icon } from "../../ui";

export const V1_BASE = (typeof window !== "undefined" ? window.location.origin : "") + "/v1";
/** URL pública do gateway — o snippet MCP aponta pra cá, não pro origin local. */
export const MCP_API_URL = "https://galeed.guilhermesales.com/v1";

export function mcpSnippet(tokenPlaceholder = "gld_live_SUA_CHAVE"): string {
  return `{
  "mcpServers": {
    "galeed": {
      "command": "npx",
      "args": ["-y", "@galeed/mcp"],
      "env": {
        "GALEED_TOKEN": "${tokenPlaceholder}",
        "GALEED_API_URL": "${MCP_API_URL}"
      }
    }
  }
}`;
}

export function EndpointHeader({ kind, title, note }: { kind: string; title: string; note: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <Chip>{kind}</Chip>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 15, fontWeight: 600 }}>{title}</div>
      </div>
      <span style={{ fontSize: 11.5, color: "var(--faint)", whiteSpace: "nowrap" }}>{note}</span>
    </div>
  );
}

export function TokenBlock({ code, onCopy, oneLine }: { code: string; onCopy: () => void; oneLine?: boolean }) {
  return (
    <div style={{ position: "relative" }}>
      <pre
        className="mono"
        style={{
          margin: 0,
          padding: "13px 46px 13px 14px",
          background: "var(--ink)",
          color: "oklch(90% 0.015 240)",
          borderRadius: 10,
          fontSize: 12.5,
          lineHeight: 1.6,
          overflowX: "auto",
          whiteSpace: oneLine ? "nowrap" : "pre",
        }}
      >
        {code}
      </pre>
      <button
        type="button"
        aria-label="Copiar"
        title="Copiar"
        onClick={onCopy}
        style={{
          position: "absolute",
          top: 8,
          right: 8,
          display: "grid",
          placeItems: "center",
          width: 30,
          height: 30,
          borderRadius: 8,
          border: "1px solid oklch(40% 0.02 250)",
          background: "oklch(26% 0.02 250)",
          color: "oklch(82% 0.015 240)",
          cursor: "pointer",
        }}
      >
        <Icon name="plus" size={14} />
      </button>
    </div>
  );
}

export function FieldRow({ label, value, onCopy, muted }: { label: string; value: string; onCopy: () => void; muted?: boolean }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ fontSize: 11.5, color: muted ? "var(--faint)" : "var(--muted)", fontWeight: 600, marginBottom: 4 }}>{label}</div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          border: "1px solid var(--border)",
          borderRadius: 9,
          background: "var(--surface-2)",
          padding: "7px 7px 7px 11px",
        }}
      >
        <span className="mono" style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: muted ? "var(--muted)" : "var(--fg)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {value}
        </span>
        <Button size="sm" variant="secondary" onClick={onCopy}>Copiar</Button>
      </div>
    </div>
  );
}
