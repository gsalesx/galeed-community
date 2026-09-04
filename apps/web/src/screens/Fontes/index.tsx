/** M21/S5 — Tela FONTES (fiel a docs/design-system/fontes.html — fidelidade Tier 1).
 *
 *  De onde a informação entra. Cada fonte tem a sua RECEITA: o cérebro sabe o que
 *  extrair dali, e o resto vira HIPÓTESE na fila de revisão (regra de ouro / ADR-016).
 *
 *  Estrutura (ordem EXATA do mockup):
 *   1. page-head  — h1 + parágrafo + "Ligar uma fonte" (scrolla pro catálogo)
 *   2. banner     — a regra que evita invenção (texto literal)
 *   3. strip      — "N trechos não casaram…" (só com pendente>0) → /app/revisar
 *   4. lista      — "Ligadas neste cérebro N": cards com receita em chips + stats reais
 *   5. catálogo   — reais (Upload/Colar texto) + conectores live "Em breve" (sem mentira)
 *   6. drawer     — receita editável (SourceDrawer)
 *
 *  Honestidade v1: o chip de status diz "ativa"/"pausada" (NÃO "lendo" — não há conector live).
 *  Dados SÓ via api.sources.* / api.hypotheses.count() — zero fetch direto, zero número inventado.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Card, Icon, Skeleton, Toast } from "../../ui";
import type { ToastTone } from "../../ui";
import { ApiError, api } from "../../lib/api";
import { useQuery } from "../../lib/useQuery";
import { fmtNumber, relativeTime } from "../../lib/format";
import { useBrain } from "../../lib/auth";
import { Catalog } from "./Catalog";
import { SourceDrawer } from "./SourceDrawer";
import {
  anexarEstadoConector,
  descricaoDaSync,
  ehConector,
  estadoDaConexao,
  fonteDoProvider,
  rotuloDoEstado,
} from "./connector";
import type { EstadoConexao } from "./connector";
import type { Source } from "./types";

type TintInfo = { background: string; color: string; icon: "pdf" | "info" | "email" };
const TINT: Record<"upload" | "paste", TintInfo> = {
  upload: { background: "var(--st-hypo-soft)", color: "oklch(48% 0.12 65)", icon: "pdf" },
  paste: { background: "var(--st-fact-soft)", color: "var(--st-fact)", icon: "info" },
};
/** M22-D — fonte-conector chega com o channel do SEED ("conta-azul"/"gmail"), não tem chave no
 *  TINT; o lookup ganha FALLBACK por provider (§5.2). */
function tintDaFonte(s: Source): TintInfo {
  return (
    (TINT as Record<string, TintInfo>)[s.channel] ??
    (s.connector?.provider === "google-mail"
      ? { background: "var(--st-fact-soft)", color: "var(--st-fact)", icon: "email" }
      : { background: "var(--accent-soft)", color: "var(--accent-ink)", icon: "info" })
  );
}

const META: Record<"upload" | "paste", string> = {
  upload: "Entra por upload de arquivos.",
  paste: "Entra por texto colado.",
};
function metaDaFonte(s: Source): string {
  return (META as Record<string, string>)[s.channel] ?? "Entra sozinha pelo conector.";
}

/** cores do chip de conexão por estado (§5.2): conectada=accent · pausada/desconectada=cinza ·
 *  erro/aguardando=hypo. */
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

interface DrawerState {
  mode: "editar" | "criar";
  source: Source | null;
  presetChannel?: "upload" | "paste";
}

export default function Fontes() {
  const navigate = useNavigate();
  const { current } = useBrain();
  const sourcesQ = useQuery<Source[]>("fontes", () => api.sources.list(), [current?.id]);
  const countsQ = useQuery("fontes-fila", () => api.hypotheses.count(), [current?.id]);
  // M22-D — estado de conexão das fontes-conector (endpoint próprio do A; mesclado client-side).
  const connStatusQ = useQuery("fontes-conn", () => api.sources.connectorsStatus(), [current?.id]);
  const [drawer, setDrawer] = useState<DrawerState | null>(null);
  const [toast, setToast] = useState<{ msg: string; tone: ToastTone } | null>(null);
  // M22-D — estado do fluxo de conexão (client-side; morre no reload — LEI 1).
  const [aguardando, setAguardando] = useState<string | null>(null);
  const [linkManual, setLinkManual] = useState<{ provider: string; url: string } | null>(null);
  const [conectorIndisponivel, setConectorIndisponivel] = useState<string | null>(null);
  const catRef = useRef<HTMLDivElement>(null);

  // M22-D — a verdade da lista é /api/sources + /api/connectors/status mesclados (LEI 1/§2.3).
  const sources = useMemo(
    () => anexarEstadoConector(sourcesQ.data ?? [], connStatusQ.data?.sources ?? []),
    [sourcesQ.data, connStatusQ.data],
  );
  const pendente = countsQ.data?.pendente ?? 0;

  // M22-D — refaz lista + estado de conexão juntos (todo refetch do fluxo de conexão).
  function refetchTudo() {
    sourcesQ.refetch();
    connStatusQ.refetch();
  }

  // M22-D — fluxo de conexão (padrão §1.2: window.open SÍNCRONO no clique; fallback honesto).
  async function conectar(provider: string) {
    const existente = fonteDoProvider(sources, provider);
    if (existente?.connector?.status === "conectado") {
      setDrawer({ mode: "editar", source: existente }); // card "Abrir"
      return;
    }
    const w = window.open("about:blank", "_blank"); // SÍNCRONO no clique (popup-blocker)
    try {
      const fonte = existente ?? (await api.sources.connectorCreate({ provider }));
      const r = await api.sources.connectStart(fonte.id);
      if (w) {
        try {
          w.opener = null;
        } catch {
          /* cross-origin após navegar: ok */
        }
        w.location.href = r.connect_link;
      } else {
        setLinkManual({ provider, url: r.connect_link }); // fallback honesto (§4.4)
      }
      setAguardando(provider);
      setToast({
        msg: "Abrimos a tela de conexão em outra janela. Quando terminar, o estado atualiza aqui.",
        tone: "neutral",
      });
      refetchTudo();
    } catch (e) {
      w?.close();
      if (e instanceof ApiError && e.status === 503) {
        setConectorIndisponivel(e.message); // P0-B visível
      } else {
        setToast({
          msg: e instanceof Error && e.message ? e.message : "Não deu pra iniciar a conexão.",
          tone: "warn",
        });
      }
    }
  }

  // M22-D — releitura do estado enquanto aguardando (LEI 1): foco da janela + polling 5s por ≤2min.
  useEffect(() => {
    if (aguardando === null) return;
    const onFocus = () => refetchTudo();
    window.addEventListener("focus", onFocus);
    const tick = setInterval(refetchTudo, 5000);
    const stop = setTimeout(() => setAguardando(null), 120_000); // session expira em 30min; UI não polla pra sempre
    return () => {
      window.removeEventListener("focus", onFocus);
      clearInterval(tick);
      clearTimeout(stop);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aguardando]);

  // M22-D — quando a fonte do provider aguardado sair de "desconectado", limpa aguardando + toast.
  useEffect(() => {
    if (aguardando === null) return;
    const fonte = fonteDoProvider(sources, aguardando);
    const st = fonte?.connector?.status;
    if (st && st !== "desconectado") {
      setAguardando(null);
      setLinkManual(null);
      if (st === "conectado") setToast({ msg: "Conectada.", tone: "ok" });
      else if (st === "erro")
        setToast({ msg: fonte?.connector?.last_error || "A conexão falhou — reconecte.", tone: "warn" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sources, aguardando]);

  // áreas já usadas em TODAS as fontes (datalist do drawer)
  const knownAreas = useMemo(() => {
    const seen: string[] = [];
    for (const s of sources)
      for (const f of s.recipe?.fields ?? []) {
        const a = f.area.trim().toLowerCase();
        if (a && !seen.includes(a)) seen.push(a);
      }
    return seen;
  }, [sources]);

  function irAoCatalogo() {
    catRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function fecharDrawer() {
    setDrawer(null);
    countsQ.refetch(); // a fila pode ter mudado enquanto o drawer estava aberto
  }

  function aposSalvar() {
    setToast({ msg: "Receita salva.", tone: "ok" });
    sourcesQ.refetch();
    connStatusQ.refetch();
    countsQ.refetch();
  }

  return (
    <div style={{ maxWidth: 1120, margin: "0 auto", padding: "8px 0 64px" }}>
      <style>{HOVER_CSS}</style>

      {/* 1. page-head */}
      <div style={{ display: "flex", alignItems: "flex-end", gap: 14, marginBottom: 16, flexWrap: "wrap" }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 600, letterSpacing: "-0.02em", margin: 0 }}>Fontes</h1>
          <p style={{ margin: "3px 0 0", color: "var(--muted)", fontSize: 13.5, maxWidth: "62ch" }}>
            De onde a informação entra. Cada fonte tem a sua <b>receita</b>: o cérebro sabe exatamente o que extrair
            dali, e o resto não vira fato.
          </p>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 9 }}>
          <Button variant="primary" icon={<Icon name="plus" size={15} />} onClick={irAoCatalogo}>
            Ligar uma fonte
          </Button>
        </div>
      </div>

      {/* 2. banner da regra de ouro (SEMPRE visível) */}
      <div
        style={{
          display: "flex",
          gap: 11,
          alignItems: "flex-start",
          background: "var(--accent-soft)",
          border: "1px solid oklch(88% 0.04 150)",
          borderRadius: 11,
          padding: "13px 16px",
          fontSize: 13.5,
          color: "var(--accent-ink)",
          marginBottom: 22,
        }}
      >
        <span aria-hidden style={{ flexShrink: 0, marginTop: 1, display: "inline-flex" }}>
          <Icon name="check" size={17} />
        </span>
        <span>
          <b style={{ fontWeight: 600 }}>A regra que evita invenção:</b> o que a receita reconhece vira{" "}
          <b style={{ fontWeight: 600 }}>fato carimbado</b>. O que ela não reconhece vira{" "}
          <b style={{ fontWeight: 600 }}>hipótese</b> e espera você confirmar. O cérebro nunca chuta.
        </span>
      </div>

      {/* 3. strip da fila (só com pendente > 0) */}
      {pendente > 0 && (
        <div
          style={{
            display: "flex",
            gap: 11,
            alignItems: "center",
            background: "var(--st-hypo-soft)",
            border: "1px solid oklch(89% 0.05 75)",
            borderRadius: 11,
            padding: "12px 16px",
            fontSize: 13.5,
            color: "oklch(42% 0.1 65)",
            marginBottom: 24,
            flexWrap: "wrap",
          }}
        >
          <span aria-hidden style={{ flexShrink: 0, display: "inline-flex" }}>
            <Icon name="info" size={17} />
          </span>
          <span>
            <b className="num" style={{ fontWeight: 600 }}>
              {fmtNumber(pendente)}
            </b>{" "}
            trechos não casaram com nenhuma receita. Estão guardados como <b style={{ fontWeight: 600 }}>hipótese</b>,
            esperando você revisar.
          </span>
          <a
            href="/app/revisar"
            onClick={(e) => {
              e.preventDefault();
              navigate("/app/revisar");
            }}
            style={{
              marginLeft: "auto",
              fontWeight: 600,
              color: "oklch(42% 0.1 65)",
              textDecoration: "underline",
              textUnderlineOffset: 3,
            }}
          >
            Revisar agora
          </a>
        </div>
      )}

      {/* 4. Ligadas neste cérebro */}
      <SecHeader>
        Ligadas neste cérebro{" "}
        <span className="num" style={{ color: "var(--muted)" }}>
          {sourcesQ.loading ? "…" : sources.length}
        </span>
      </SecHeader>

      {sourcesQ.loading ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {[0, 1, 2].map((i) => (
            <Card key={i} padding="16px 18px">
              <Skeleton width="38%" height={10} />
              <Skeleton width="62%" height={8} style={{ marginTop: 9 }} />
              <Skeleton width="46%" height={8} style={{ marginTop: 7 }} />
            </Card>
          ))}
        </div>
      ) : sourcesQ.error ? (
        <Card padding="20px 20px">
          <p style={{ color: "var(--muted)", fontSize: 14, margin: 0 }}>
            {sourcesQ.error.message || "Não deu pra carregar as fontes agora."}
          </p>
          <Button onClick={sourcesQ.refetch} style={{ marginTop: 12 }}>
            Tentar de novo
          </Button>
        </Card>
      ) : sources.length === 0 ? (
        <Card padding="22px 20px">
          <p style={{ color: "var(--muted)", fontSize: 14, margin: 0 }}>
            Nenhuma fonte ligada ainda. Ligue a primeira — é a receita dela que deixa os fatos certos.
          </p>
          <Button variant="primary" icon={<Icon name="plus" size={15} />} onClick={irAoCatalogo} style={{ marginTop: 12 }}>
            Ligar uma fonte
          </Button>
        </Card>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {sources.map((s) => (
            <SourceCard
              key={s.id}
              source={s}
              aguardando={aguardando != null && aguardando === s.connector?.provider}
              onOpen={() => setDrawer({ mode: "editar", source: s })}
            />
          ))}
        </div>
      )}

      {/* 5. catálogo */}
      <div ref={catRef}>
        <SecHeader>
          Ligar uma fonte nova{" "}
          <span className="num" style={{ color: "var(--muted)" }}>
            catálogo
          </span>
        </SecHeader>
      </div>

      {/* M22-D — aviso fail-closed (503) / fallback de popup bloqueada (mesmo padrão visual do strip da fila) */}
      {(conectorIndisponivel || linkManual) && (
        <div
          style={{
            display: "flex",
            gap: 11,
            alignItems: "flex-start",
            background: "var(--st-hypo-soft)",
            border: "1px solid oklch(89% 0.05 75)",
            borderRadius: 11,
            padding: "12px 16px",
            fontSize: 13.5,
            color: "oklch(42% 0.1 65)",
            marginBottom: 14,
            flexWrap: "wrap",
          }}
        >
          <span aria-hidden style={{ flexShrink: 0, display: "inline-flex" }}>
            <Icon name="info" size={17} />
          </span>
          <span style={{ flex: 1, minWidth: 0 }}>
            {conectorIndisponivel ? (
              conectorIndisponivel
            ) : linkManual ? (
              <>
                O navegador bloqueou a janela — abra a conexão pelo link:{" "}
                <a
                  href={linkManual.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ fontWeight: 600, color: "oklch(42% 0.1 65)", textDecoration: "underline", textUnderlineOffset: 3 }}
                >
                  Abrir a tela de conexão
                </a>
              </>
            ) : null}
          </span>
        </div>
      )}
      <Catalog
        fontes={sources}
        onCreate={(preset) => setDrawer({ mode: "criar", source: null, presetChannel: preset.channel })}
        onConnect={conectar}
      />

      {/* 6. drawer */}
      {drawer && (
        <SourceDrawer
          mode={drawer.mode}
          source={drawer.source}
          presetChannel={drawer.presetChannel}
          knownAreas={knownAreas}
          onClose={fecharDrawer}
          onSaved={aposSalvar}
          onStatusChanged={refetchTudo}
          aguardandoConexao={
            aguardando != null && drawer.source != null && aguardando === drawer.source.connector?.provider
          }
          onConnect={
            drawer.source && ehConector(drawer.source) && drawer.source.connector?.provider
              ? () => conectar(drawer.source!.connector!.provider)
              : undefined
          }
        />
      )}

      {/* toasts */}
      {toast && (
        <div style={{ position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)", zIndex: 80 }}>
          <Toast tone={toast.tone} onClose={() => setToast(null)}>
            {toast.msg}
          </Toast>
        </div>
      )}
    </div>
  );
}

/* ---------- subcomponentes locais ---------- */

/** section header .sec do mockup (uppercase + régua) */
function SecHeader({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        fontSize: 12,
        textTransform: "uppercase",
        letterSpacing: ".06em",
        fontWeight: 600,
        color: "var(--faint)",
        margin: "26px 0 12px",
        display: "flex",
        alignItems: "center",
        gap: 8,
      }}
    >
      <span style={{ display: "inline-flex", alignItems: "center", gap: 8, whiteSpace: "nowrap" }}>{children}</span>
      <span aria-hidden style={{ flex: 1, height: 1, background: "var(--border)" }} />
    </div>
  );
}

/** card .src do mockup: ícone tintado · nome+status · meta · chips da receita · stats */
function SourceCard({ source, aguardando, onOpen }: { source: Source; aguardando: boolean; onOpen: () => void }) {
  const tint = tintDaFonte(source);
  const fields = source.recipe?.fields ?? [];
  const areas: string[] = [];
  for (const f of fields) {
    const a = f.area.trim().toLowerCase();
    if (a && !areas.includes(a)) areas.push(a);
  }
  const ativa = source.status === "ativa";
  // M22-D — fonte-conector: chip mostra o estado da CONEXÃO (não "ativa/pausada"); meta = sync.
  const conn = ehConector(source);
  const estadoConn = conn ? estadoDaConexao(source, aguardando) : null;
  return (
    <div
      className="fts-src"
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      style={{
        display: "grid",
        gridTemplateColumns: "auto 1fr auto",
        gap: 14,
        alignItems: "center",
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: 12,
        padding: "14px 16px",
        cursor: "pointer",
        transition: "border-color .15s, box-shadow .15s",
      }}
    >
      <span
        aria-hidden
        style={{
          width: 40,
          height: 40,
          borderRadius: 10,
          display: "grid",
          placeItems: "center",
          flexShrink: 0,
          background: tint.background,
          color: tint.color,
        }}
      >
        <Icon name={tint.icon} size={20} />
      </span>

      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: 14, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          {source.name}
          {estadoConn ? (
            // M22-D — chip do estado da CONEXÃO (cores por estado; §5.2)
            (() => {
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
                    padding: "2px 8px",
                  }}
                >
                  <span aria-hidden style={{ width: 6, height: 6, borderRadius: "50%", background: c.dot }} />
                  {rotuloDoEstado(estadoConn)}
                </span>
              );
            })()
          ) : (
            /* honestidade v1: "ativa"/"pausada", nunca "lendo" */
            <span
              className="mono"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                fontSize: 10.5,
                fontWeight: 600,
                color: ativa ? "var(--accent-ink)" : "var(--faint)",
                background: ativa ? "var(--accent-soft)" : "var(--st-arch-soft)",
                borderRadius: 6,
                padding: "2px 8px",
              }}
            >
              <span
                aria-hidden
                style={{ width: 6, height: 6, borderRadius: "50%", background: ativa ? "var(--accent)" : "var(--faint)" }}
              />
              {source.status}
            </span>
          )}
        </div>
        <div style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 3 }}>
          {conn ? descricaoDaSync(source.connector, (iso) => relativeTime(iso)) : metaDaFonte(source)}
        </div>
        {(fields.length > 0 || areas.length > 0) && (
          <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginTop: 8 }}>
            {fields.map((f, i) => (
              <span
                key={`${f.dimension}-${i}`}
                className="mono"
                style={{
                  fontSize: 10.5,
                  color: "var(--muted)",
                  background: "var(--surface-2)",
                  border: "1px solid var(--border)",
                  borderRadius: 5,
                  padding: "2px 7px",
                }}
              >
                {f.label.trim() || f.dimension}
              </span>
            ))}
            {areas.map((a) => (
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
            ))}
          </div>
        )}
      </div>

      <div style={{ textAlign: "right" }}>
        <span className="num" style={{ display: "block", fontSize: 16, fontWeight: 600 }}>
          {fmtNumber(source.pages_count)}
        </span>
        <small style={{ display: "block", fontSize: 11, color: "var(--faint)" }}>documentos lidos</small>
        <span className="num" style={{ display: "block", fontSize: 16, fontWeight: 600, marginTop: 5 }}>
          {fmtNumber(source.facts_count)}
        </span>
        <small style={{ display: "block", fontSize: 11, color: "var(--faint)" }}>fatos com selo</small>
        <span className="num" style={{ display: "block", fontSize: 10.5, color: "var(--faint)", marginTop: 5 }}>
          última: {source.last_read_at ? relativeTime(source.last_read_at) : "—"}
        </span>
      </div>
    </div>
  );
}

/** hovers que inline-style não cobre (mesmo padrão de <style> local das telas vizinhas) */
const HOVER_CSS = `
.fts-src:hover { border-color: var(--border-strong) !important; box-shadow: var(--shadow); }
.fts-prov:hover { border-color: var(--border-strong) !important; box-shadow: var(--shadow); }
.fts-ligar:hover { background: var(--accent-soft) !important; border-color: oklch(88% 0.04 150) !important; }
@media (max-width: 860px) {
  .fts-src { grid-template-columns: auto 1fr !important; }
  .fts-src > div:last-child { grid-column: 1 / 3; display: flex; gap: 14px; text-align: left !important; border-top: 1px dashed var(--border); padding-top: 10px; }
}
`;
