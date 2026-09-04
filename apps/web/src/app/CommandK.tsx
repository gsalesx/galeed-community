/** M8/S1 — Paleta de comando ⌘K (busca global do shell).
 *
 *  Abre com Cmd/Ctrl+K (controlada pela Topbar) e fecha no ESC/backdrop (via Modal).
 *  Input liga em api.search(q) (debounce leve); Enter num hit abre, Enter vazio faz a
 *  busca completa em /app/buscar?q=. ↑/↓ percorre. Usa o <Modal/> + <SearchInput/> de ui/.
 *  Em modo FTS o backend ainda responde (sem embeddings/reranker).
 */
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Icon, Modal, SearchInput, Skeleton } from "../ui";
import { api, ApiError, type RetrieveHit } from "../lib/api";
import { API_ERROR_EVENT } from "./GlobalStates";

export interface CommandKProps {
  open: boolean;
  onClose: () => void;
}

export function CommandK({ open, onClose }: CommandKProps) {
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<RetrieveHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const reqId = useRef(0);

  // ao abrir: reseta e foca o input (Modal monta no mesmo tick → próximo frame)
  useEffect(() => {
    if (!open) return;
    setQ("");
    setHits([]);
    setActive(0);
    const t = setTimeout(() => {
      wrapRef.current?.querySelector<HTMLInputElement>('input[type="search"]')?.focus();
    }, 30);
    return () => clearTimeout(t);
  }, [open]);

  // busca com debounce; descarta respostas fora de ordem via reqId
  useEffect(() => {
    if (!open) return;
    const term = q.trim();
    if (!term) {
      setHits([]);
      setLoading(false);
      return;
    }
    const handle = setTimeout(async () => {
      const id = ++reqId.current;
      setLoading(true);
      try {
        const res = await api.search(term, { k: 6 });
        if (id === reqId.current) {
          setHits(res);
          setActive(0);
        }
      } catch (e) {
        if (id === reqId.current) {
          setHits([]);
          if (e instanceof ApiError && e.status !== 401) {
            window.dispatchEvent(new CustomEvent(API_ERROR_EVENT, { detail: { message: e.message } }));
          }
        }
      } finally {
        if (id === reqId.current) setLoading(false);
      }
    }, 220);
    return () => clearTimeout(handle);
  }, [q, open]);

  function goSearchPage() {
    const term = q.trim();
    onClose();
    navigate(`/app/buscar${term ? `?q=${encodeURIComponent(term)}` : ""}`);
  }

  function openHit(hit: RetrieveHit) {
    const term = q.trim();
    onClose();
    navigate(`/app/buscar?q=${encodeURIComponent(term)}&slug=${encodeURIComponent(hit.slug)}`);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, hits.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (hits[active]) openHit(hits[active]);
      else goSearchPage();
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Buscar na memória" width={560}>
      <div ref={wrapRef} onKeyDown={onKeyDown}>
        <SearchInput
          value={q}
          onChange={(e) => setQ((e.target as HTMLInputElement).value)}
          placeholder="Buscar na memória…"
          shortcut="ESC"
        />

        <div style={{ marginTop: 12, minHeight: 60 }}>
          {loading && (
            <div style={{ display: "grid", gap: 10, padding: "6px 2px" }}>
              <Skeleton width="90%" />
              <Skeleton width="70%" />
              <Skeleton width="80%" />
            </div>
          )}

          {!loading && q.trim() && hits.length === 0 && (
            <p className="muted" style={{ fontSize: 13.5, padding: "8px 2px" }}>
              Nada encontrado para “{q.trim()}”.{" "}
              <button type="button" onClick={goSearchPage} style={linkBtn}>
                Abrir busca completa →
              </button>
            </p>
          )}

          {!loading &&
            hits.map((hit, i) => (
              <button
                key={hit.slug + i}
                type="button"
                onMouseEnter={() => setActive(i)}
                onClick={() => openHit(hit)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  width: "100%",
                  padding: "9px 10px",
                  borderRadius: 8,
                  border: "1px solid transparent",
                  background: i === active ? "var(--accent-soft)" : "transparent",
                  color: "var(--fg)",
                  cursor: "pointer",
                  textAlign: "left",
                }}
              >
                <span aria-hidden className="faint" style={{ display: "grid", placeItems: "center", flexShrink: 0 }}>
                  <Icon name="search" size={15} />
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: "block", fontSize: 13.5, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {hit.title || hit.slug}
                  </span>
                  <span className="muted" style={{ display: "block", fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {hit.excerpt}
                  </span>
                </span>
                <span className="mono faint" style={{ fontSize: 10.5, flexShrink: 0 }}>
                  {hit.via}
                </span>
              </button>
            ))}
        </div>
      </div>
    </Modal>
  );
}

const linkBtn = {
  background: "transparent",
  border: "none",
  color: "var(--accent-ink)",
  fontWeight: 600,
  cursor: "pointer",
  padding: 0,
};

export default CommandK;
