/** M21/S5 — Catálogo "Ligar uma fonte nova" (fiel a docs/design-system/fontes.html).
 *
 *  Honestidade v1 (invariante "sem botão de mentira"):
 *   • REAIS (habilitados): "Upload de arquivos" e "Colar texto" — Ligar abre o drawer
 *     em modo CRIAR (a fonte nasce via POST /api/sources).
 *   • CONECTORES vivos (M22-D): "Conta Azul" e "E-mail" ganham "Conectar"/"Abrir"
 *     (cria a fonte-conector + abre a connect session do Nango — fluxo no index.tsx).
 *   • Demais conectores: botão "Em breve" DISABLED — nenhum clique dispara nada.
 */
import type { ReactNode } from "react";
import { Icon } from "../../ui";
import type { IconName } from "../../ui";
import { fonteDoProvider } from "./connector";
import type { Source } from "./types";

export interface CatalogProps {
  onCreate: (preset: { name: string; channel: "upload" | "paste" }) => void;
  /** M22-D — dispara o fluxo de conexão do provider (cria fonte-conector + connect session). */
  onConnect: (provider: string) => void;
  /** M22-D — fontes já ligadas neste cérebro (pra saber se o provider já tem fonte conectada). */
  fontes: Source[];
}

/** Tints do mockup (icon tints .t-*). Os que não têm token viram oklch literal do mockup. */
const TINTS = {
  green: { background: "var(--accent-soft)", color: "var(--accent-ink)" },
  blue: { background: "var(--st-fact-soft)", color: "var(--st-fact)" },
  amber: { background: "var(--st-hypo-soft)", color: "oklch(48% 0.12 65)" },
  violet: { background: "oklch(95.5% 0.04 285)", color: "oklch(48% 0.14 285)" },
  grey: { background: "var(--st-arch-soft)", color: "var(--muted)" },
} as const;

type Tint = keyof typeof TINTS;

/** `.what i` do mockup: mono 10.5px accent-ink (não-itálico). */
function Hint({ children }: { children: ReactNode }) {
  return (
    <i className="mono" style={{ fontStyle: "normal", fontSize: 10.5, color: "var(--accent-ink)" }}>
      {children}
    </i>
  );
}

interface ProvCard {
  nome: string;
  what: ReactNode;
  tag: string;
  icon: IconName;
  tint: Tint;
  /** presente = card REAL (Ligar habilitado); ausente = "Em breve" disabled */
  channel?: "upload" | "paste";
  /** M22-D — presente = conector vivo (Conectar/Abrir); chave opaca pro BFF (provider_config_key). */
  provider?: string;
}

/** Opções funcionais: 2 reais (upload/paste) e 2 conectores Nango vivos (conta-azul, google-mail).
 *  Conectores "em breve" removidos da vitrine. */
const CARDS: ProvCard[] = [
  {
    nome: "Upload de arquivos",
    what: (
      <>
        PDF, planilha, export de conversa: o arquivo entra pela receita do tipo. <Hint>você escolhe os campos</Hint>
      </>
    ),
    tag: "arquivos",
    icon: "pdf",
    tint: "amber",
    channel: "upload",
  },
  {
    nome: "Colar texto",
    what: <>Cola uma conversa ou anotação; a receita diz o que vira fato.</>,
    tag: "conversas",
    icon: "info",
    tint: "blue",
    channel: "paste",
  },
  {
    nome: "Conta Azul",
    what: (
      <>
        Vendas, contas a pagar e receber direto do ERP: <Hint>cliente · valor · data real</Hint>
      </>
    ),
    tag: "financeiro",
    icon: "info",
    tint: "blue",
    provider: "conta-azul",
  },
  {
    nome: "E-mail",
    what: (
      <>
        Acompanha propostas: o que foi <Hint>enviado · aceito · prometido</Hint> por escrito.
      </>
    ),
    tag: "conversas",
    icon: "email",
    tint: "violet",
    provider: "google-mail",
  },
];

export function Catalog({ onCreate, onConnect, fontes }: CatalogProps) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(228px, 1fr))",
        gap: 12,
      }}
    >
      {CARDS.map((c) => {
        const real = c.channel !== undefined;
        const conectorAtivo = c.provider ? fonteDoProvider(fontes, c.provider) : undefined;
        const jaConectado = conectorAtivo?.connector?.status === "conectado";
        const hover = real || c.provider !== undefined;
        return (
          <div
            key={c.nome}
            className={hover ? "fts-prov" : undefined}
            style={{
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: 12,
              padding: 15,
              display: "flex",
              flexDirection: "column",
              gap: 9,
              transition: "border-color .15s, box-shadow .15s",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span
                aria-hidden
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 8,
                  display: "grid",
                  placeItems: "center",
                  flexShrink: 0,
                  ...TINTS[c.tint],
                }}
              >
                <Icon name={c.icon} size={17} />
              </span>
              <b style={{ fontSize: 13.5, fontWeight: 600, lineHeight: 1.3 }}>{c.nome}</b>
            </div>
            <div style={{ fontSize: 12, color: "var(--muted)", lineHeight: 1.45, flex: 1 }}>{c.what}</div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                borderTop: "1px dashed var(--border)",
                paddingTop: 10,
              }}
            >
              <span className="mono" style={{ fontSize: 10, color: "var(--faint)" }}>
                {c.tag}
              </span>
              {real ? (
                <button
                  type="button"
                  className="fts-ligar"
                  onClick={() => onCreate({ name: "", channel: c.channel! })}
                  style={{
                    border: "1px solid var(--border-strong)",
                    background: "var(--surface)",
                    borderRadius: 7,
                    padding: "5px 12px",
                    fontSize: 12,
                    fontWeight: 600,
                    color: "var(--accent-ink)",
                    fontFamily: "var(--font)",
                    cursor: "pointer",
                  }}
                >
                  Ligar
                </button>
              ) : c.provider !== undefined ? (
                // M22-D — conector vivo: "Abrir" (já conectado, o pai abre o drawer) ou "Conectar".
                <button
                  type="button"
                  className="fts-ligar"
                  onClick={() => onConnect(c.provider!)}
                  style={{
                    border: "1px solid var(--border-strong)",
                    background: "var(--surface)",
                    borderRadius: 7,
                    padding: "5px 12px",
                    fontSize: 12,
                    fontWeight: 600,
                    color: "var(--accent-ink)",
                    fontFamily: "var(--font)",
                    cursor: "pointer",
                  }}
                >
                  {jaConectado ? "Abrir" : "Conectar"}
                </button>
              ) : (
                // "Em breve" comunica sem mentir: disabled de verdade, cursor default, zero handler.
                <button
                  type="button"
                  disabled
                  style={{
                    border: "1px solid var(--border-strong)",
                    background: "var(--surface)",
                    borderRadius: 7,
                    padding: "5px 12px",
                    fontSize: 12,
                    fontWeight: 600,
                    color: "var(--faint)",
                    fontFamily: "var(--font)",
                    cursor: "default",
                  }}
                >
                  Em breve
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default Catalog;
