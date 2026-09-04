/** "Ver como ela vê" (§2.8) — painel à direita. Preview do que o principal enxerga:
 *  itens visíveis (selo Fato + cadeado + área + citação) e itens BLOQUEADOS (borrados,
 *  lockmsg genérico que NÃO nomeia a área oculta). Cabeçalho azul fact. */
import { useEffect } from "react";
import { Button, Icon, LockChip, SearchInput, StatusChip } from "../../ui";
import type { LockLevel } from "../../ui";
import type { AccessPreview, Principal } from "../../lib/api";
import { lockText, SENS_TO_CODE } from "./data";

export interface ViewAsOverlayProps {
  open: boolean;
  onClose: () => void;
  principal: Principal | null;
  preview: AccessPreview | null;
  loading: boolean;
  error: string | null;
}

export function ViewAsOverlay({ open, onClose, principal, preview, loading, error }: ViewAsOverlayProps) {
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open || !principal) return null;

  const code: LockLevel = SENS_TO_CODE[principal.grant.sensitivity_max];
  const scopeText = `${principal.areas_labels.join(" + ")} · ${lockText(code)}`;

  const results = preview?.results ?? [];
  const visible = results.filter((r) => !r.blocked);
  const blocked = results.filter((r) => r.blocked);
  const total = visible.length + blocked.length;

  return (
    <div
      role="presentation"
      onClick={onClose}
      style={{ position: "fixed", inset: 0, zIndex: 1000, display: "flex", justifyContent: "flex-end", background: "oklch(22% 0.02 240 / .35)" }}
    >
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={`Vendo o cérebro como ${principal.label} vê`}
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%",
          maxWidth: 460,
          height: "100%",
          background: "var(--surface)",
          boxShadow: "var(--shadow)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {/* topo azul fact */}
        <div style={{ padding: "16px 18px", background: "var(--st-fact-soft)", borderBottom: "1px solid var(--border)" }}>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
            <div>
              <strong style={{ fontSize: 16, fontWeight: 600, color: "var(--st-fact)" }}>
                Vendo o cérebro como {principal.label} vê
              </strong>
              <div className="mono" style={{ marginTop: 4, fontSize: 12, color: "var(--st-fact)" }}>{scopeText}</div>
            </div>
            <button
              type="button"
              aria-label="Fechar"
              onClick={onClose}
              style={{ display: "grid", placeItems: "center", width: 28, height: 28, border: "none", borderRadius: 8, background: "transparent", color: "var(--st-fact)", cursor: "pointer" }}
            >
              <Icon name="x" size={16} />
            </button>
          </div>
          <p style={{ margin: "10px 0 12px", fontSize: 13, color: "var(--muted)", lineHeight: 1.5 }}>
            É o mesmo Galeed, mas só com o que esse acesso pode ver. O resto aparece trancado.
          </p>
          <SearchInput value="preço consultoria Acme" readOnly />
        </div>

        {/* lista */}
        <div style={{ flex: 1, overflowY: "auto", padding: "16px 18px" }}>
          {loading && <p style={{ fontSize: 14, color: "var(--muted)" }}>Carregando o que esse acesso pode ver…</p>}
          {error && <p style={{ fontSize: 14, color: "var(--danger)" }}>{error}</p>}
          {!loading && !error && (
            <>
              <div className="mono" style={{ fontSize: 11.5, color: "var(--faint)", marginBottom: 12 }}>
                {visible.length} resultados que esse acesso pode ver
              </div>
              <div style={{ display: "grid", gap: 12 }}>
                {visible.map((r, i) => (
                  <div key={`v${i}`} style={{ border: "1px solid var(--border)", borderRadius: 13, padding: "14px 16px", background: "var(--surface)" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 9, flexWrap: "wrap" }}>
                      <StatusChip variant="fact" />
                      <LockChip level={(r.level as LockLevel) || "conf"} />
                      {r.area && (
                        <span className="mono" style={{ fontSize: 11, color: "var(--faint)" }}>via: {r.area}</span>
                      )}
                    </div>
                    <p style={{ margin: 0, fontSize: 14.5, lineHeight: 1.5 }}>{r.quote}</p>
                  </div>
                ))}
                {blocked.map((r, i) => (
                  <div
                    key={`b${i}`}
                    style={{
                      position: "relative",
                      border: "1px dashed var(--border-strong)",
                      borderRadius: 13,
                      padding: "14px 16px",
                      background:
                        "repeating-linear-gradient(45deg, var(--surface-2), var(--surface-2) 8px, var(--surface) 8px, var(--surface) 16px)",
                      overflow: "hidden",
                    }}
                  >
                    <div aria-hidden style={{ filter: "blur(4px)", opacity: 0.55, userSelect: "none" }}>
                      <div style={{ height: 7, width: "70%", borderRadius: 3, background: "var(--border)", marginBottom: 8 }} />
                      <div style={{ height: 7, width: "90%", borderRadius: 3, background: "var(--border)" }} />
                    </div>
                    <div
                      className="mono"
                      style={{ display: "inline-flex", alignItems: "center", gap: 6, marginTop: 12, fontSize: 11.5, fontWeight: 600, color: "var(--sn-secret)" }}
                    >
                      <Icon name="lock-closed" size={12} />
                      {r.label || "Oculto"}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        {/* rodapé */}
        <div style={{ padding: "14px 18px", borderTop: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <span style={{ fontSize: 13, color: "var(--muted)" }}>
            {visible.length} de {total} itens visíveis. {blocked.length} ficaram de fora pela permissão deste acesso.
          </span>
          <Button variant="ghost" icon={<Icon name="arrow" size={15} />}>Abrir a tela dela</Button>
        </div>
      </aside>
    </div>
  );
}

export default ViewAsOverlay;
