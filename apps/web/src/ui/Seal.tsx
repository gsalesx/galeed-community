/** Seal — o COMPONENTE-ASSINATURA do Galeed. Carimba TODO trecho devolvido pelo
 *  cérebro. Regras sagradas:
 *   - status, certeza e validade SEMPRE visíveis;
 *   - hipótese NUNCA pode parecer fato (cor categórica fixa);
 *   - item secreto/restrito mostra cadeado vermelho.
 *
 *  Props derivam do shape `Selo` (ARCHITECTURE §5). Tipo redeclarado aqui para
 *  manter o componente self-contained (importa só React + irmãos de ui/).
 *  Anatomia: 00-foundation §2 + §5.1. */
import type { CSSProperties, ReactNode } from "react";
import { StatusChip } from "./StatusChip";
import type { StatusVariant } from "./StatusChip";
import { LockChip } from "./LockChip";
import type { LockLevel } from "./LockChip";
import { Icon } from "./Icon";
import type { IconName } from "./Icon";

/** Shape do selo vindo do /api/retrieve (ARCHITECTURE §5). */
export interface Selo {
  status: "fato" | "hipotese" | "arquivado" | "registrado";
  confidence: number;
  tipo: string;
  fonte: string;
  valid_from: string | null;
  valid_to: string | null;
  supersede?: { texto: string; valid: string } | null;
  tags: string[];
  via: "vec" | "fts" | "grafo" | string;
  cite: string;
  sensitivity?: "publico" | "interno" | "sensivel" | "restrito";
}

export interface SealProps {
  selo: Selo;
  /** corpo do trecho citado */
  children?: ReactNode;
  /** mcard com box-shadow (flutuante) */
  elevated?: boolean;
  /** href do cite (link "ver fonte"); default usa selo.cite como rótulo */
  citeHref?: string;
  /** clique no "substitui …" (leva pro Mapa) */
  onSupersedeClick?: () => void;
  style?: CSSProperties;
}

// --- mapeamentos do shape PT-BR para os enums visuais ---

const STATUS_MAP: Record<Selo["status"], StatusVariant> = {
  fato: "fact",
  hipotese: "hypo",
  arquivado: "arch",
  registrado: "reg",
};

const SENS_MAP: Record<NonNullable<Selo["sensitivity"]>, LockLevel> = {
  publico: "open",
  interno: "int",
  sensivel: "conf",
  restrito: "secret",
};

const VIA_LABEL: Record<string, string> = {
  vec: "semântica",
  fts: "texto",
  grafo: "grafo",
};

// ícone de proveniência inferido da fonte
function provenanceIcon(fonte: string): IconName {
  const f = fonte.toLowerCase();
  if (f.includes("whats")) return "whatsapp";
  if (f.includes("mail") || f.includes("@")) return "email";
  if (f.includes("liga") || f.includes("call") || f.includes("tel")) return "call";
  if (f.includes(".pdf") || f.includes("pdf") || f.includes("doc")) return "pdf";
  if (f.includes("audio") || f.includes("áudio") || f.includes("voz")) return "audio";
  return "info";
}

function fmtConfidence(c: number): string {
  // pt-BR "0,92"
  return c.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function Seal({ selo, children, elevated, citeHref, onSupersedeClick, style }: SealProps) {
  const statusVariant = STATUS_MAP[selo.status] ?? "reg";
  const lock: LockLevel | null = selo.sensitivity ? SENS_MAP[selo.sensitivity] ?? null : null;
  // o corpus real pode omitir campos — nada aqui pode assumir presença
  const hasConf = typeof selo.confidence === "number" && !Number.isNaN(selo.confidence);
  const confPct = hasConf ? Math.max(0, Math.min(1, selo.confidence)) * 100 : 0;
  const provIcon = provenanceIcon(selo.fonte ?? "");
  const tags = selo.tags ?? [];

  return (
    <div
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: 13,
        overflow: "hidden",
        boxShadow: elevated ? "var(--shadow)" : undefined,
        maxWidth: 560,
        ...style,
      }}
    >
      {/* HEADER (.seal): status + cadeado + certeza */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          flexWrap: "wrap",
          padding: "12px 15px",
          background: "var(--surface-2)",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <StatusChip variant={statusVariant} />
        {lock && <LockChip level={lock} />}

        {/* confidence meter — só quando o fato traz certeza (corpus pode omitir) */}
        {hasConf && (
          <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 8 }}>
            <span className="faint mono" style={{ fontSize: 11 }}>
              conf
            </span>
            <b className="mono" style={{ fontSize: 13, fontWeight: 600, color: "var(--fg)" }}>
              {fmtConfidence(selo.confidence)}
            </b>
            <span
              aria-hidden
              style={{
                width: 46,
                height: 5,
                borderRadius: 99,
                background: "var(--border)",
                overflow: "hidden",
              }}
            >
              <i style={{ display: "block", height: "100%", width: `${confPct}%`, background: "var(--accent)" }} />
            </span>
          </span>
        )}
      </div>

      {/* BODY (.seal-body): tipo + corpo citado */}
      <div style={{ padding: "14px 16px" }}>
        {selo.tipo && (
          <div
            className="mono"
            style={{ fontSize: 11, color: "var(--faint)", textTransform: "uppercase", letterSpacing: ".03em", marginBottom: 6 }}
          >
            {selo.tipo}
          </div>
        )}
        <div style={{ fontSize: 15, lineHeight: 1.5, color: "var(--fg)" }}>{children}</div>

        {/* supersessão: linha "substitui …" — antigo não some, linka pro Mapa */}
        {selo.supersede && (
          <button
            type="button"
            onClick={onSupersedeClick}
            style={{
              display: "block",
              marginTop: 10,
              padding: "8px 10px",
              width: "100%",
              textAlign: "left",
              border: "1px dashed var(--border-strong)",
              borderRadius: 8,
              background: "var(--st-arch-soft)",
              color: "var(--muted)",
              fontSize: 13,
              cursor: onSupersedeClick ? "pointer" : "default",
            }}
          >
            <span className="mono" style={{ color: "var(--st-arch)", fontSize: 11, marginRight: 6 }}>
              substitui
            </span>
            {selo.supersede.texto}
            <span className="mono faint" style={{ marginLeft: 6, fontSize: 11 }}>
              {selo.supersede.valid}
            </span>
          </button>
        )}

        {/* tags */}
        {tags.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 12 }}>
            {tags.map((t) => (
              <span
                key={t}
                className="mono"
                style={{
                  fontSize: 11,
                  color: "var(--faint)",
                  background: "var(--surface-2)",
                  border: "1px solid var(--border)",
                  borderRadius: 6,
                  padding: "2px 8px",
                }}
              >
                {t}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* FOOT (.seal-foot): proveniência · via · validade · cite */}
      <div
        className="mono"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 14,
          flexWrap: "wrap",
          padding: "11px 16px",
          borderTop: "1px solid var(--border)",
          fontSize: 11,
          color: "var(--faint)",
        }}
      >
        {selo.fonte && (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
            <Icon name={provIcon} size={12} />
            de onde veio: <b style={{ color: "var(--muted)" }}>{selo.fonte}</b>
          </span>
        )}
        {selo.via && (
          <span>
            via: <b style={{ color: "var(--muted)" }}>{VIA_LABEL[selo.via] ?? selo.via}</b>
          </span>
        )}
        {/* validade SEMPRE visível: traço honesto quando não há */}
        <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
          <Icon name="clock" size={12} />
          vale até: <b style={{ color: "var(--muted)" }}>{selo.valid_to ?? "—"}</b>
        </span>
        {selo.cite && (
          <a href={citeHref ?? "#"} style={{ marginLeft: "auto", color: "var(--accent-ink)" }}>
            {selo.cite}
          </a>
        )}
      </div>
    </div>
  );
}

export default Seal;
