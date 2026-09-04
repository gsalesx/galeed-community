/** M21/S5 — Drawer da RECEITA da fonte (fiel a docs/design-system/fontes.html).
 *
 *  Seções na ORDEM do mockup:
 *   1. header (ícone tintado + nome + "receita de extração" + X)
 *   2. "O que essa fonte extrai" — fieldrows EDITÁVEIS (dimension/label/área, remover, adicionar)
 *   3. "Como sai do outro lado" — mcard com selo (StatusChip Fato + LockChip + certeza/via)
 *      e exemplo DETERMINÍSTICO derivado da receita (não LLM)
 *   4. "As regras dessa fonte" — 3 rulelines literais (+ select de sigilo)
 *   5. "Alimenta as áreas" — chips derivados (read-only)
 *   6. "Leitura automática" — toggle = status ativa/pausada (POST imediato)
 *   7. rodapé — Pausar/Retomar + "Salvar receita" (espera o 200; sem otimismo)
 *
 *  Modo "criar": nome + tipo editáveis no header; a fonte nasce em POST /api/sources.
 */
import { useEffect, useMemo, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { Link } from "react-router-dom";
import { Button, Icon, LockChip, StatusChip, Toast } from "../../ui";
import type { LockLevel, ToastTone } from "../../ui";
import { ApiError, api } from "../../lib/api";
import { relativeTime } from "../../lib/format";
import { descricaoDaSync, ehConector, erroLegivel, estadoDaConexao, rotuloDoEstado } from "./connector";
import type { EstadoConexao } from "./connector";
import type { Source, SourceRecipeField } from "./types";

export interface SourceDrawerProps {
  mode: "editar" | "criar";
  source: Source | null; // null em modo criar
  presetChannel?: "upload" | "paste";
  onClose: () => void;
  onSaved: () => void; // pai refaz as queries + mostra "Receita salva."
  /** aditivo ao DESIGN-SPEC §4: o toggle muda status na hora e o card da lista
   *  precisa refletir sem reload (CONTRACT) — pai só refaz a query, sem toast. */
  onStatusChanged?: () => void;
  /** áreas já usadas nas outras fontes (datalist do input de área) */
  knownAreas?: string[];
  /** M22-D — dispara o fluxo de conexão da fonte aberta (só p/ fontes-conector). */
  onConnect?: () => void;
  /** M22-D — true enquanto o connect_link foi aberto e o banco ainda diz desconectado. */
  aguardandoConexao?: boolean;
}

/** sigilo do back → rótulo legível (espelha LockChip) */
const SENS_LABEL: Record<string, string> = {
  publico: "Aberto",
  interno: "Interno",
  sensivel: "Sigiloso",
  restrito: "Secreto",
};
const SENS_LOCK: Record<string, LockLevel> = {
  publico: "open",
  interno: "int",
  sensivel: "conf",
  restrito: "secret",
};

type TintInfo = { background: string; color: string; icon: "pdf" | "info" | "email" };
const TINT: Record<"upload" | "paste", TintInfo> = {
  upload: { background: "var(--st-hypo-soft)", color: "oklch(48% 0.12 65)", icon: "pdf" },
  paste: { background: "var(--st-fact-soft)", color: "var(--st-fact)", icon: "info" },
};
/** M22-D — fonte-conector chega com o channel do SEED ("conta-azul"/"gmail"): lookup com FALLBACK. */
function tintDaFonte(channel: string, provider?: string): TintInfo {
  return (
    (TINT as Record<string, TintInfo>)[channel] ??
    (provider === "google-mail"
      ? { background: "var(--st-fact-soft)", color: "var(--st-fact)", icon: "email" }
      : { background: "var(--accent-soft)", color: "var(--accent-ink)", icon: "info" })
  );
}

/** cores do chip de conexão por estado (mesmas do card; §5.2). */
function chipCores(e: EstadoConexao): { fg: string; bg: string; dot: string } {
  switch (e) {
    case "conectada":
      return { fg: "var(--accent-ink)", bg: "var(--accent-soft)", dot: "var(--accent)" };
    case "pausada":
    case "desconectada":
      return { fg: "var(--faint)", bg: "var(--st-arch-soft)", dot: "var(--faint)" };
    case "erro":
    case "aguardando":
      return { fg: "oklch(42% 0.1 65)", bg: "var(--st-hypo-soft)", dot: "oklch(42% 0.1 65)" };
  }
}

function tituloArea(a: string): string {
  const t = a.trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : t;
}

function msgDeErro(e: unknown, fallback: string): string {
  if (e instanceof ApiError && e.message) return e.message;
  if (e instanceof Error && e.message) return e.message;
  return fallback;
}

const LBL_STYLE: CSSProperties = {
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: ".06em",
  fontWeight: 600,
  color: "var(--faint)",
  margin: "18px 0 9px",
};

const INPUT_STYLE: CSSProperties = {
  border: "1px solid var(--border-strong)",
  borderRadius: 7,
  background: "var(--surface)",
  color: "var(--fg)",
  fontFamily: "var(--font)",
  fontSize: 12.5,
  padding: "5px 8px",
  minWidth: 0,
};

export function SourceDrawer({
  mode,
  source,
  presetChannel,
  onClose,
  onSaved,
  onStatusChanged,
  knownAreas = [],
  onConnect,
  aguardandoConexao = false,
}: SourceDrawerProps) {
  const channel: string = source?.channel ?? presetChannel ?? "upload";
  const tint = tintDaFonte(channel, source?.connector?.provider);
  // M22-D — fonte-conector ganha a seção "Conexão" + botão Conectar/Reconectar.
  const conn = source != null && ehConector(source);
  const estadoConn = conn && source ? estadoDaConexao(source, aguardandoConexao) : null;
  const erroConn = conn && source ? erroLegivel(source.connector) : null;

  // estado editável (snapshot do source no open; em criar começa vazio)
  const [name, setName] = useState(source?.name ?? "");
  const [type, setType] = useState(source?.type ?? "");
  const [fields, setFields] = useState<SourceRecipeField[]>(source?.recipe?.fields ?? []);
  const [sens, setSens] = useState(source?.default_sensitivity ?? "restrito");
  const [status, setStatus] = useState<"ativa" | "pausada">(source?.status ?? "ativa");
  const [salvando, setSalvando] = useState(false);
  const [mudandoStatus, setMudandoStatus] = useState(false);
  const [toast, setToast] = useState<{ msg: string; tone: ToastTone } | null>(null);

  // transição de entrada (0.25s, como o mockup; reduced-motion zerado no base.css)
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  // Escape fecha
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const areas = useMemo(() => {
    const seen: string[] = [];
    for (const f of fields) {
      const a = f.area.trim().toLowerCase();
      if (a && !seen.includes(a)) seen.push(a);
    }
    return seen;
  }, [fields]);

  const valido = name.trim().length > 0 && type.trim().length > 0 && fields.every((f) => f.dimension.trim().length > 0);

  function setField(i: number, patch: Partial<SourceRecipeField>) {
    setFields((cur) => cur.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  }

  async function alternarStatus() {
    if (mode === "criar" || !source || mudandoStatus) return;
    const next = status === "ativa" ? "pausada" : "ativa";
    setMudandoStatus(true);
    try {
      await api.sources.setStatus(source.id, next);
      setStatus(next);
      setToast({ msg: next === "pausada" ? "Leitura pausada." : "Leitura retomada.", tone: "neutral" });
      onStatusChanged?.();
    } catch (e) {
      setToast({ msg: msgDeErro(e, "Não deu pra mudar o status da fonte."), tone: "warn" });
    } finally {
      setMudandoStatus(false);
    }
  }

  async function salvar() {
    if (!valido || salvando) return;
    setSalvando(true);
    const recipe = {
      ...(source?.recipe ?? {}),
      fields: fields.map((f) => ({
        dimension: f.dimension.trim().toLowerCase(),
        label: f.label,
        area: f.area.trim().toLowerCase(),
      })),
    };
    try {
      if (mode === "criar") {
        await api.sources.create({
          name: name.trim(),
          channel,
          type: type.trim(),
          recipe,
          defaultSensitivity: sens,
        });
      } else if (source) {
        await api.sources.update(source.id, {
          name: name.trim(),
          type: type.trim(),
          recipe,
          defaultSensitivity: sens,
        });
      }
      onSaved(); // pai: Toast "Receita salva." + refetch
      onClose();
    } catch (e) {
      setToast({ msg: msgDeErro(e, "Não deu pra salvar a receita."), tone: "warn" });
    } finally {
      setSalvando(false);
    }
  }

  // exemplo ESTÁTICO ilustrativo derivado da receita (determinístico, não LLM)
  const primeiroCampo = fields.find((f) => (f.label || f.dimension).trim());
  const exemplo = primeiroCampo ? (
    <>
      Quando entrar algo com <b>{primeiroCampo.label.trim() || primeiroCampo.dimension.trim()}</b>, sai um fato com
      este selo e a fonte citada.
    </>
  ) : (
    <>Assim que a fonte tiver receita, o primeiro registro aparece aqui com o selo.</>
  );

  return (
    <>
      {/* scrim */}
      <div
        onClick={onClose}
        aria-hidden
        style={{
          position: "fixed",
          inset: 0,
          background: "oklch(20% 0.02 250 / .35)",
          zIndex: 60,
          opacity: shown ? 1 : 0,
          transition: "opacity .2s",
        }}
      />
      {/* drawer */}
      <aside
        role="dialog"
        aria-label="Receita da fonte"
        aria-modal="true"
        style={{
          position: "fixed",
          top: 0,
          right: 0,
          bottom: 0,
          width: "min(460px, 100%)",
          background: "var(--surface)",
          zIndex: 70,
          borderLeft: "1px solid var(--border)",
          boxShadow: "-12px 0 40px oklch(30% 0.02 250 / .14)",
          transform: shown ? "none" : "translateX(102%)",
          transition: "transform .25s ease",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* 1. header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "16px 18px",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <span
            aria-hidden
            style={{
              width: 38,
              height: 38,
              borderRadius: 10,
              display: "grid",
              placeItems: "center",
              flexShrink: 0,
              background: tint.background,
              color: tint.color,
            }}
          >
            <Icon name={tint.icon} size={19} />
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            {mode === "criar" ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="nome da fonte"
                  aria-label="Nome da fonte"
                  autoFocus
                  style={{ ...INPUT_STYLE, fontSize: 14, fontWeight: 600 }}
                />
                <input
                  value={type}
                  onChange={(e) => setType(e.target.value)}
                  placeholder="tipo (ex.: conversas, reunioes)"
                  aria-label="Tipo da fonte"
                  className="mono"
                  style={{ ...INPUT_STYLE, fontSize: 11.5 }}
                />
              </div>
            ) : (
              <b style={{ fontSize: 15, display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {name}
              </b>
            )}
            <small className="mono" style={{ display: "block", fontSize: 11.5, color: "var(--faint)", marginTop: 2 }}>
              receita de extração
            </small>
          </div>
          <button
            type="button"
            title="Fechar"
            aria-label="Fechar"
            onClick={onClose}
            style={{
              marginLeft: "auto",
              width: 32,
              height: 32,
              border: "1px solid var(--border)",
              borderRadius: 8,
              background: "var(--surface)",
              display: "grid",
              placeItems: "center",
              color: "var(--muted)",
              cursor: "pointer",
              flexShrink: 0,
            }}
          >
            <Icon name="x" size={15} />
          </button>
        </div>

        {/* body */}
        <div style={{ flex: 1, overflow: "auto", padding: 18 }}>
          {/* 2. O que essa fonte extrai */}
          <div style={{ ...LBL_STYLE, marginTop: 0 }}>O que essa fonte extrai</div>
          <div>
            {fields.map((f, i) => (
              <div
                key={i}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "9px 11px",
                  border: "1px solid var(--border)",
                  borderRadius: 9,
                  background: "var(--surface-2)",
                  marginBottom: 7,
                }}
              >
                <input
                  className="mono"
                  value={f.dimension}
                  onChange={(e) => setField(i, { dimension: e.target.value.toLowerCase() })}
                  placeholder="campo"
                  aria-label={`Nome do campo ${i + 1}`}
                  style={{ ...INPUT_STYLE, width: 118, flexShrink: 0, fontSize: 11.5, fontWeight: 600 }}
                />
                <input
                  value={f.label}
                  onChange={(e) => setField(i, { label: e.target.value })}
                  placeholder="o que é (legível)"
                  aria-label={`Descrição do campo ${i + 1}`}
                  style={{ ...INPUT_STYLE, flex: 1 }}
                />
                <input
                  className="mono"
                  value={f.area}
                  onChange={(e) => setField(i, { area: e.target.value })}
                  placeholder="área"
                  aria-label={`Área do campo ${i + 1}`}
                  list="fts-areas"
                  style={{
                    ...INPUT_STYLE,
                    width: 92,
                    flexShrink: 0,
                    fontSize: 10.5,
                    color: "var(--accent-ink)",
                    background: "var(--accent-soft)",
                    borderColor: "oklch(88% 0.04 150)",
                  }}
                />
                <button
                  type="button"
                  title="Remover campo"
                  aria-label={`Remover campo ${i + 1}`}
                  onClick={() => setFields((cur) => cur.filter((_, j) => j !== i))}
                  style={{
                    border: "none",
                    background: "transparent",
                    color: "var(--faint)",
                    cursor: "pointer",
                    display: "grid",
                    placeItems: "center",
                    padding: 2,
                    flexShrink: 0,
                  }}
                >
                  <Icon name="x" size={13} />
                </button>
              </div>
            ))}
            <datalist id="fts-areas">
              {knownAreas.map((a) => (
                <option key={a} value={a} />
              ))}
            </datalist>
            <button
              type="button"
              onClick={() => setFields((cur) => [...cur, { dimension: "", label: "", area: "" }])}
              style={{
                width: "100%",
                border: "1px dashed var(--border-strong)",
                borderRadius: 9,
                background: "transparent",
                color: "var(--accent-ink)",
                fontSize: 12.5,
                fontWeight: 600,
                fontFamily: "var(--font)",
                padding: "8px 11px",
                cursor: "pointer",
                textAlign: "left",
              }}
            >
              + adicionar campo
            </button>
          </div>

          {/* 3. Como sai do outro lado */}
          <div style={LBL_STYLE}>Como sai do outro lado</div>
          <div
            style={{
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: 12,
              overflow: "hidden",
              boxShadow: "var(--shadow)",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                flexWrap: "wrap",
                gap: "6px 9px",
                padding: "10px 13px",
                borderBottom: "1px solid var(--border)",
                background: "var(--surface-2)",
              }}
            >
              <StatusChip variant="fact" size="sm" />
              <LockChip level={SENS_LOCK[sens] ?? "secret"} />
              <span className="mono" style={{ fontSize: 10.5, color: "var(--muted)" }}>
                certeza <b style={{ color: "var(--fg)", fontWeight: 600 }}>—</b>
              </span>
              <span className="mono" style={{ fontSize: 10.5, color: "var(--muted)" }}>
                via <b style={{ color: "var(--fg)", fontWeight: 600 }}>{name.trim() || "esta fonte"}</b>
              </span>
            </div>
            <div style={{ padding: "12px 13px", fontSize: 13, lineHeight: 1.55 }}>{exemplo}</div>
          </div>

          {/* 4. As regras dessa fonte */}
          <div style={LBL_STYLE}>As regras dessa fonte</div>
          <Rule icon="check">
            Só vira fato o que a receita <b style={{ color: "var(--fg)" }}>reconhece com nome, valor e data</b>. Cada
            fato sai com o selo e a fonte citada.
          </Rule>
          <Rule icon="info" hyp>
            O que ela <b style={{ color: "oklch(36% 0.1 65)" }}>não reconhecer</b> vira hipótese e entra na fila de
            revisão. Nunca vira fato sozinho.
          </Rule>
          <Rule icon="lock-closed">
            <span>
              Entra com o sigilo <b style={{ color: "var(--fg)" }}>{SENS_LABEL[sens] ?? sens}</b> por padrão. Você muda
              isso em{" "}
              <Link to="/app/acesso" style={{ fontWeight: 600, color: "var(--accent-ink)" }}>
                Acesso
              </Link>
              .
            </span>
            <select
              value={sens}
              onChange={(e) => setSens(e.target.value)}
              aria-label="Sigilo padrão da fonte"
              style={{
                display: "block",
                marginTop: 8,
                height: 30,
                padding: "0 8px",
                borderRadius: 7,
                border: "1px solid var(--border-strong)",
                background: "var(--surface)",
                color: "var(--fg)",
                fontFamily: "var(--font)",
                fontSize: 12.5,
              }}
            >
              <option value="publico">Aberto</option>
              <option value="interno">Interno</option>
              <option value="sensivel">Sigiloso</option>
              <option value="restrito">Secreto</option>
            </select>
          </Rule>

          {/* 5. Alimenta as áreas */}
          <div style={LBL_STYLE}>Alimenta as áreas</div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {areas.length > 0 ? (
              areas.map((a) => (
                <span
                  key={a}
                  className="mono"
                  style={{
                    fontSize: 10.5,
                    color: "var(--accent-ink)",
                    background: "var(--accent-soft)",
                    border: "1px solid oklch(88% 0.04 150)",
                    borderRadius: 5,
                    padding: "2px 7px",
                  }}
                >
                  → {tituloArea(a)}
                </span>
              ))
            ) : (
              <span style={{ fontSize: 12.5, color: "var(--faint)" }}>
                as áreas aparecem quando a receita tiver campos com área.
              </span>
            )}
          </div>

          {/* 5b. Conexão (M22-D — só fonte-conector) */}
          {conn && estadoConn && (
            <>
              <div style={LBL_STYLE}>Conexão</div>
              <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
                {(() => {
                  const c = chipCores(estadoConn);
                  return (
                    <span
                      className="mono"
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 5,
                        fontSize: 10.5,
                        fontWeight: 600,
                        color: c.fg,
                        background: c.bg,
                        borderRadius: 6,
                        padding: "3px 9px",
                      }}
                    >
                      <span aria-hidden style={{ width: 6, height: 6, borderRadius: "50%", background: c.dot }} />
                      {rotuloDoEstado(estadoConn)}
                    </span>
                  );
                })()}
                <span style={{ fontSize: 12.5, color: "var(--muted)" }}>
                  {descricaoDaSync(source?.connector, (iso) => relativeTime(iso))}
                </span>
              </div>
              {erroConn && (
                <div style={{ marginTop: 9 }}>
                  <Rule icon="info" hyp>
                    {erroConn}
                  </Rule>
                </div>
              )}
              <Button
                onClick={() => onConnect?.()}
                disabled={estadoConn === "aguardando"}
                style={{ marginTop: 11, width: "100%" }}
              >
                {estadoConn === "aguardando"
                  ? "Aguardando conexão…"
                  : estadoConn === "conectada"
                    ? "Reconectar"
                    : "Conectar"}
              </Button>
            </>
          )}

          {/* 6. Leitura automática (só faz sentido com a fonte criada) */}
          {mode === "editar" && (
            <div style={{ ...LBL_STYLE, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              Leitura automática
              <button
                type="button"
                title="Pausar ou retomar"
                aria-label="Pausar ou retomar a leitura"
                aria-pressed={status === "ativa"}
                onClick={alternarStatus}
                disabled={mudandoStatus}
                style={{
                  position: "relative",
                  width: 38,
                  height: 22,
                  borderRadius: 99,
                  background: status === "ativa" ? "var(--accent)" : "var(--border-strong)",
                  border: "none",
                  transition: "background .18s",
                  flexShrink: 0,
                  cursor: mudandoStatus ? "wait" : "pointer",
                  padding: 0,
                }}
              >
                <span
                  aria-hidden
                  style={{
                    position: "absolute",
                    top: 2.5,
                    left: status === "ativa" ? 19 : 2.5,
                    width: 17,
                    height: 17,
                    borderRadius: "50%",
                    background: "#fff",
                    transition: "left .18s",
                    boxShadow: "0 1px 3px oklch(30% 0.02 250 / .3)",
                  }}
                />
              </button>
            </div>
          )}
        </div>

        {/* 7. rodapé */}
        <div style={{ padding: "14px 18px", borderTop: "1px solid var(--border)", display: "flex", gap: 9 }}>
          {mode === "editar" && (
            <Button onClick={alternarStatus} disabled={mudandoStatus} style={{ flex: 1 }}>
              {status === "ativa" ? "Pausar leitura" : "Retomar leitura"}
            </Button>
          )}
          <Button variant="primary" onClick={salvar} disabled={!valido || salvando} style={{ flex: 1 }}>
            {salvando ? "Salvando…" : "Salvar receita"}
          </Button>
        </div>
      </aside>

      {/* toast local (status / erro de salvar — o "Receita salva." é do pai, que fecha o drawer) */}
      {toast && (
        <div style={{ position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)", zIndex: 80 }}>
          <Toast tone={toast.tone} onClose={() => setToast(null)}>
            {toast.msg}
          </Toast>
        </div>
      )}
    </>
  );
}

/** ruleline do mockup (.rule / .rule.hyp) */
function Rule({ icon, hyp, children }: { icon: "check" | "info" | "lock-closed"; hyp?: boolean; children: ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        gap: 10,
        alignItems: "flex-start",
        border: `1px solid ${hyp ? "oklch(89% 0.05 75)" : "var(--border)"}`,
        borderRadius: 10,
        padding: "12px 13px",
        fontSize: 12.5,
        color: hyp ? "oklch(42% 0.1 65)" : "var(--muted)",
        background: hyp ? "var(--st-hypo-soft)" : "var(--surface)",
        marginBottom: 8,
      }}
    >
      <span aria-hidden style={{ flexShrink: 0, marginTop: 1, display: "inline-flex" }}>
        <Icon name={icon} size={15} />
      </span>
      <span style={{ flex: 1 }}>{children}</span>
    </div>
  );
}

export default SourceDrawer;
