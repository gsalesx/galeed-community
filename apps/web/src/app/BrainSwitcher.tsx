/** M8/S1 — Brain switcher (app-shell.md §5).
 *
 *  Botão (.brain) que mostra o brain ATUAL (dot accent + nome) e abre um dropdown
 *  (.brain-menu, ~230px) com os brains de useBrain(). Trocar chama switchBrain(id) —
 *  o cliente de api passa a anexar ?brain=<id> em toda chamada de tenant.
 *  Fecha ao clicar fora (document) e no ESC. "+ Novo cérebro" navega pro onboarding.
 *
 *  NÃO vaza tenant: mostra só o nome do brain (campo public `name`), nunca o id cru
 *  de outro tenant — a lista vem da própria sessão (membership da conta).
 */
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useBrain } from "../lib/auth";
import { Icon } from "../ui";

// Paleta de dots por posição (1º accent verde, depois azul, âmbar… — mockup §5).
const DOT_COLORS = [
  "var(--accent)",
  "oklch(60% 0.13 250)",
  "oklch(64% 0.14 70)",
  "var(--st-reg)",
];

export function BrainSwitcher() {
  const { current, brains, switchBrain } = useBrain();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

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

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          height: 34,
          padding: "0 10px",
          borderRadius: 8,
          border: "1px solid var(--border-strong)",
          background: "var(--surface)",
          color: "var(--fg)",
          cursor: "pointer",
        }}
      >
        <span
          aria-hidden
          style={{ width: 8, height: 8, borderRadius: "50%", background: DOT_COLORS[0], flexShrink: 0 }}
        />
        <span style={{ fontSize: 13.5, fontWeight: 600, maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {current?.name ?? "Sem cérebro"}
        </span>
        <span aria-hidden className="faint" style={{ display: "grid", placeItems: "center", transform: "rotate(90deg)" }}>
          <Icon name="chevron" size={14} />
        </span>
      </button>

      {open && (
        <div
          role="menu"
          onClick={(e) => e.stopPropagation()}
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            left: 0,
            width: 230,
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 12,
            boxShadow: "var(--shadow)",
            padding: 6,
            zIndex: 40,
          }}
        >
          {brains.map((b, i) => {
            const active = b.id === current?.id;
            return (
              <button
                key={b.id}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                onClick={() => {
                  switchBrain(b.id);
                  setOpen(false);
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 9,
                  width: "100%",
                  padding: "8px 9px",
                  borderRadius: 8,
                  border: "1px solid transparent",
                  background: active ? "var(--accent-soft)" : "transparent",
                  color: "var(--fg)",
                  cursor: "pointer",
                  textAlign: "left",
                }}
              >
                <span
                  aria-hidden
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    background: DOT_COLORS[i % DOT_COLORS.length],
                    flexShrink: 0,
                  }}
                />
                <span style={{ flex: 1, fontSize: 13.5, fontWeight: active ? 600 : 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {b.name}
                </span>
                <span className="mono faint" style={{ fontSize: 10.5 }}>
                  {b.role}
                </span>
              </button>
            );
          })}

          <div style={{ borderTop: "1px solid var(--border)", margin: "6px 4px" }} />
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              navigate("/criar-cerebro");
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              width: "100%",
              padding: "8px 9px",
              borderRadius: 8,
              border: "1px solid transparent",
              background: "transparent",
              color: "var(--accent-ink)",
              fontWeight: 600,
              fontSize: 13.5,
              cursor: "pointer",
              textAlign: "left",
            }}
          >
            <Icon name="plus" size={15} />
            Novo cérebro
          </button>
        </div>
      )}
    </div>
  );
}

export default BrainSwitcher;
