/** M8/S1 — Sidebar do console (app-shell.md §4).
 *
 *  236px, sticky abaixo da topbar, scroll interno. Itens de nav na ORDEM e com os
 *  LABELS exatos do mockup, agrupados:
 *    (topo)         Início · Buscar(memória) · Perguntar · Fatos · Adicionar(só joga)
 *    Quem vê o quê  Acesso
 *    Pra quem desenv. Conectar · Saúde · Ajustes
 *  Item ativo: fundo --accent-soft + texto --accent-ink (via NavLink isActive).
 *  Rodapé: card de ajuda "Como o Galeed funciona?".
 */
import { NavLink } from "react-router-dom";
import type { CSSProperties } from "react";
import { Icon, type IconName } from "../ui";
import { useQuery } from "../lib/useQuery";

interface NavItem {
  to: string;
  label: string;
  /** sufixo .count à direita (ex "memória", "grafo", "12") */
  count?: string;
  icon: IconName;
  /** rota exata (não casa sub-rotas) — usado no Início (/app) */
  end?: boolean;
}

interface NavGroup {
  /** título do grupo (.grp); ausente = bloco do topo sem rótulo */
  title?: string;
  items: NavItem[];
}

// Ordem e labels LITERAIS do mockup (app-shell.md §4).
// Ícones mapeados pro set disponível em ui/Icon (sem lib).
const GROUPS: NavGroup[] = [
  {
    items: [
      { to: "/app", label: "Início", icon: "info", end: true },
      { to: "/app/buscar", label: "Buscar", count: "memória", icon: "search" },
      { to: "/app/perguntar", label: "Perguntar", icon: "chevron" },
      { to: "/app/fatos", label: "Fatos", icon: "check" },
      { to: "/app/adicionar", label: "Adicionar", count: "só joga", icon: "plus" },
      { to: "/app/fontes", label: "Fontes", count: "receitas", icon: "arrow" },
    ],
  },
  {
    title: "Quem vê o quê",
    items: [{ to: "/app/acesso", label: "Acesso", icon: "lock-closed" }],
  },
  {
    title: "Pra quem desenvolve",
    items: [
      { to: "/app/conectar", label: "Conectar", icon: "arrow" },
      { to: "/app/saude", label: "Saúde", icon: "clock" },
      { to: "/app/ajustes", label: "Ajustes", icon: "info" },
    ],
  },
  {
    title: "Conta",
    items: [{ to: "/app/plano", label: "Plano", count: "créditos", icon: "round" }],
  },
];

const navBase: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "8px 10px",
  borderRadius: 8,
  fontSize: 13.5,
  fontWeight: 500,
  color: "var(--fg)",
  textDecoration: "none",
  lineHeight: 1.2,
};

function navStyle(isActive: boolean): CSSProperties {
  return isActive
    ? { ...navBase, background: "var(--accent-soft)", color: "var(--accent-ink)", fontWeight: 600 }
    : navBase;
}

export function Sidebar() {
  // self-host sem Stripe: o BFF anuncia billing:false no health e o grupo "Conta/Plano" some
  // (não existe o que assinar/recarregar). Enquanto carrega, esconde — evita piscar o item.
  const health = useQuery<{ ok: boolean; billing?: boolean }>(
    "health",
    () => fetch("/api/health").then((r) => r.json()),
    [],
  );
  const groups = health.data?.billing ? GROUPS : GROUPS.filter((g) => g.title !== "Conta");
  return (
    <aside
      style={{
        position: "sticky",
        top: 56,
        alignSelf: "start",
        height: "calc(100vh - 56px)",
        overflowY: "auto",
        background: "var(--surface)",
        borderRight: "1px solid var(--border)",
        padding: "14px 12px",
        display: "flex",
        flexDirection: "column",
        gap: 4,
      }}
    >
      {groups.map((group, gi) => (
        <div key={gi} style={{ display: "grid", gap: 2, marginTop: group.title ? 14 : 0 }}>
          {group.title && (
            <div
              className="faint"
              style={{
                fontSize: 11,
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: "0.04em",
                padding: "4px 10px 2px",
              }}
            >
              {group.title}
            </div>
          )}
          {group.items.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              style={({ isActive }) => navStyle(isActive)}
            >
              <span aria-hidden style={{ display: "grid", placeItems: "center", flexShrink: 0 }}>
                <Icon name={item.icon} size={17} />
              </span>
              <span style={{ flex: 1 }}>{item.label}</span>
              {item.count && (
                <span className="mono faint" style={{ fontSize: 11 }}>
                  {item.count}
                </span>
              )}
            </NavLink>
          ))}
          {/* o link só existe quando há docs SERVIDAS: o build do Docker define VITE_DOCS_URL
              (Caddy serve /docs); em dev/build manual a var não existe e /docs cairia no
              SPA-fallback (link quebrado que abre o próprio app) — então o item some. */}
          {group.title === "Pra quem desenvolve" && !!import.meta.env.VITE_DOCS_URL && (
            <a
              href={import.meta.env.VITE_DOCS_URL}
              target="_blank"
              rel="noopener noreferrer"
              style={navBase}
            >
              <span aria-hidden style={{ display: "grid", placeItems: "center", flexShrink: 0 }}>
                <Icon name="info" size={17} />
              </span>
              <span style={{ flex: 1 }}>Documentação</span>
              <span className="mono faint" style={{ fontSize: 11 }}>↗</span>
            </a>
          )}
        </div>
      ))}

      {/* spacer flex:1 empurra o card de ajuda pro rodapé */}
      <div style={{ flex: 1, minHeight: 20 }} />

      <div
        style={{
          margin: "8px 4px 0",
          padding: "13px 13px 14px",
          borderRadius: 12,
          background: "var(--surface-2)",
          border: "1px solid var(--border)",
        }}
      >
        <strong style={{ display: "block", fontSize: 13, marginBottom: 5 }}>
          Como o Galeed funciona?
        </strong>
        <p className="muted" style={{ fontSize: 12.5, lineHeight: 1.5, marginBottom: 0 }}>
          Você joga as coisas dentro. Ele organiza sozinho. Aí é só perguntar.
        </p>
      </div>
    </aside>
  );
}

export default Sidebar;
