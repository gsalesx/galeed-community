/** M8/S1 — Menu de conta (topbar-right, app-shell.md §3.4).
 *
 *  Avatar com iniciais (gradiente azul→verde) que abre um dropdown:
 *    - cabeçalho com nome + email da conta (useAuth().session.account)
 *    - "Ajustes da conta" → /app/ajustes
 *    - "Sair" → logout() e redireciona pra /entrar
 *  Fecha ao clicar fora e no ESC.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";

function initials(name: string, email: string): string {
  const src = (name || email || "").trim();
  if (!src) return "??";
  const parts = src.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return src.slice(0, 2).toUpperCase();
}

export function AccountMenu() {
  const { session, logout } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const account = session?.account;
  const ini = useMemo(() => initials(account?.name ?? "", account?.email ?? ""), [account]);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function onLogout() {
    setOpen(false);
    await logout();
    navigate("/entrar", { replace: true });
  }

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Conta"
        onClick={() => setOpen((v) => !v)}
        style={{
          width: 32,
          height: 32,
          borderRadius: "50%",
          border: "none",
          cursor: "pointer",
          display: "grid",
          placeItems: "center",
          color: "#fff",
          fontSize: 12,
          fontWeight: 700,
          background: "linear-gradient(135deg, oklch(60% 0.13 250), var(--accent))",
        }}
      >
        {ini}
      </button>

      {open && (
        <div
          role="menu"
          style={{
            position: "absolute",
            top: "calc(100% + 8px)",
            right: 0,
            width: 230,
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 12,
            boxShadow: "var(--shadow)",
            padding: 6,
            zIndex: 40,
          }}
        >
          <div style={{ padding: "8px 10px 10px", borderBottom: "1px solid var(--border)", marginBottom: 6 }}>
            <div style={{ fontSize: 13.5, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {account?.name ?? "Conta"}
            </div>
            <div className="muted" style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {account?.email ?? ""}
            </div>
          </div>

          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              navigate("/app/ajustes");
            }}
            style={menuItemStyle}
          >
            Ajustes da conta
          </button>
          <button type="button" role="menuitem" onClick={onLogout} style={{ ...menuItemStyle, color: "var(--danger)" }}>
            Sair
          </button>
        </div>
      )}
    </div>
  );
}

const menuItemStyle = {
  display: "block",
  width: "100%",
  padding: "8px 10px",
  borderRadius: 8,
  border: "1px solid transparent",
  background: "transparent",
  color: "var(--fg)",
  fontSize: 13.5,
  cursor: "pointer",
  textAlign: "left" as const,
};

export default AccountMenu;
