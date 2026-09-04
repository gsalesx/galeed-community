/** M8/S1 — Topbar do console (app-shell.md §3).
 *
 *  Esquerda → direita: Brand (→ "/app") · BrainSwitcher · busca global (SearchInput
 *  que abre a CommandK) · topbar-right (sino de Avisos + AccountMenu).
 *  Atalho ⌘K / Ctrl+K abre a paleta de comando; o clique na busca também abre.
 *  Responsivo: <860px esconde a busca inline (o ⌘K segue funcionando).
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Brand, Icon, SearchInput } from "../ui";
import { BrainSwitcher } from "./BrainSwitcher";
import { AccountMenu } from "./AccountMenu";
import { CommandK } from "./CommandK";

export function Topbar() {
  const [cmdOpen, setCmdOpen] = useState(false);

  // ⌘K / Ctrl+K abre a paleta global
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setCmdOpen((v) => !v);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <header
      style={{
        gridColumn: "1 / 3",
        position: "sticky",
        top: 0,
        zIndex: 30,
        height: 56,
        display: "flex",
        alignItems: "center",
        gap: 16,
        padding: "0 18px",
        background: "var(--surface)",
        borderBottom: "1px solid var(--border)",
      }}
    >
      <Link to="/app" aria-label="Galeed — Início" style={{ textDecoration: "none", flexShrink: 0 }}>
        <Brand size={26} />
      </Link>

      <BrainSwitcher />

      {/* busca global — centralizada, max 420px; abre a CommandK ao focar/clicar */}
      <div className="topbar-search" style={{ flex: 1, maxWidth: 420, margin: "0 auto" }}>
        <div
          onMouseDown={(e) => {
            e.preventDefault();
            setCmdOpen(true);
          }}
        >
          <SearchInput
            placeholder="Buscar na memória…"
            shortcut="⌘K"
            readOnly
            style={{ cursor: "pointer" }}
          />
        </div>
      </div>

      {/* (o sino de "Avisos" saiu: era um botão sem ação — não existe central de avisos ainda) */}
      <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}>
        <AccountMenu />
      </div>

      <CommandK open={cmdOpen} onClose={() => setCmdOpen(false)} />
    </header>
  );
}

export default Topbar;
