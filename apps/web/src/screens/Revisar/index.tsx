/** M25-C — Revisar: a fila de hipóteses da regra de ouro, agora em ESCALA.
 *
 *  A fila REAL (corpus accelera360-mentoria) tem 1.086 pendentes — irrevisável um a um. Esta tela
 *  vira uma mesa de decisão em escala:
 *    - Por grupos (default >30 pendentes): um card por grupo-decisão (reason × dimension × fonte),
 *      com contagem, amostra, recomendações do juiz, e os botões da decisão (receita / aprovar
 *      recomendados / descartar / um a um). Resultado de lote SEMPRE com números.
 *    - JudgeBar: o juiz RECOMENDA, nunca aprova (LEI I). Triar mostra custo ANTES.
 *    - Esperando você / Decididas: o fluxo M21 individual, intacto (com badge de recomendação).
 *
 *  Dados SÓ via api.hypotheses.*. Ações de lote NÃO são otimistas (card não some antes do 200).
 *  LEI I: o ÚNICO caminho de aprovação em lote é approveGroup({apenas_recomendados:true}) — o gate
 *  determinístico do M25-A aprova; a recomendação só SELECIONA. Zero loop de approve(id).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Card, Icon, Modal, Skeleton, Toast, type ToastTone } from "../../ui";
import { api } from "../../lib/api";
import { useQuery } from "../../lib/useQuery";
import { useBrain } from "../../lib/auth";
import { fmtNumber } from "../../lib/format";
import { HypothesisCard } from "./HypothesisCard";
import { GroupCard } from "./GroupCard";
import { JudgeBar } from "./JudgeBar";
import { RetidosModal } from "./RetidosModal";
import {
  abaInicial, ordenaGrupos, segmentoDoGrupo, separaPrecisaDeVoce, filtraGrupo, resumoLote,
  juizNuncaRodou, fmtCustoUsd, type AbaRevisar, type AcaoDeGrupo,
} from "./logic";
import {
  type Hypothesis, type ReviewReason, type HypothesisGroup,
  type BatchApproveResult, type JudgeRun, type JudgeEstimate, type JudgeCalibration,
} from "./types";

/** §3.8 — page size da lista um-a-um (sobe p/ o filtro de grupo client-side fazer sentido). */
const K_UM_A_UM = 200;
/** §3.8 — intervalo do polling da triagem quando o juiz roda em lote (Batch API). */
const POLL_MS = 5000;

type FiltroGrupo = { reason: ReviewReason; dimension: string; source_id: string };

function chaveGrupo(g: HypothesisGroup | FiltroGrupo): string {
  return `${g.reason}|${g.dimension}|${g.source_id}`;
}

export default function Revisar() {
  const { current } = useBrain();
  const brainId = current?.id ?? "";

  const [aba, setAba] = useState<AbaRevisar | null>(null); // null = ainda decidindo (counts em voo)
  const [filtroGrupo, setFiltroGrupo] = useState<FiltroGrupo | null>(null);
  const [grupoExpandido, setGrupoExpandido] = useState<string | null>(null);
  const [grupoBusy, setGrupoBusy] = useState<string | null>(null);
  const [confirmacao, setConfirmacao] = useState<
    null | { tipo: "descartar" | "triar" | "receita"; grupo?: HypothesisGroup }
  >(null);
  const [resultadoLote, setResultadoLote] = useState<BatchApproveResult | null>(null);
  const [triando, setTriando] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null); // fluxo um-a-um M21
  const [decididas, setDecididas] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState<{ msg: string; tone: ToastTone } | null>(null);

  // guarda de desmonte pro loop de polling
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  // --- dados (keyed por brainId) ---
  const counts = useQuery(`hypotheses:count:${brainId}`, () => api.hypotheses.count(), [brainId]);

  const grupos = useQuery<HypothesisGroup[]>(
    `hypotheses:groups:${brainId}:${aba}`,
    () => (aba === "grupos" ? api.hypotheses.groups() : Promise.resolve([])),
    [brainId, aba],
  );

  // calibração: erro AQUI NÃO derruba a tela — trata como null (BFF sem M25-B).
  const calibracao = useQuery(
    `hypotheses:calibration:${brainId}:${aba}`,
    () => (aba === "grupos" ? api.hypotheses.judge.calibration() : Promise.resolve(null)),
    [brainId, aba],
  );
  const calData = calibracao.error ? null : calibracao.data ?? null;

  const lista = useQuery<Hypothesis[]>(
    `hypotheses:list:${brainId}:${aba}:${filtroGrupo ? chaveGrupo(filtroGrupo) : ""}`,
    async () => {
      if (aba === "decididas") {
        const [aprovadas, descartadas] = await Promise.all([
          api.hypotheses.list({ status: "aprovada", k: K_UM_A_UM }),
          api.hypotheses.list({ status: "descartada", k: K_UM_A_UM }),
        ]);
        return ([...aprovadas, ...descartadas] as Hypothesis[]).sort((a, b) =>
          (b.decided_at ?? "").localeCompare(a.decided_at ?? ""),
        );
      }
      // aba "pendente" (e fallback quando ainda decidindo) — k=200 + filtros do grupo
      return (await api.hypotheses.list({
        status: "pendente",
        k: K_UM_A_UM,
        reason: filtroGrupo?.reason,
        dimension: filtroGrupo?.dimension,
        sourceId: filtroGrupo?.source_id,
      })) as Hypothesis[];
    },
    [brainId, aba, filtroGrupo ? chaveGrupo(filtroGrupo) : ""],
  );

  // aba inicial (uma única vez): troca manual depois sempre vence
  useEffect(() => {
    if (counts.data && aba === null) setAba(abaInicial(counts.data.pendente));
  }, [counts.data, aba]);

  const itens = useMemo(() => {
    const base = Array.isArray(lista.data) ? lista.data : [];
    const visivel = aba === "pendente" ? base.filter((h) => !decididas.has(h.id)) : base;
    // defesa em profundidade: filtra client-side mesmo se o BFF ignorou os params
    return aba === "pendente" ? filtraGrupo(visivel, filtroGrupo) : visivel;
  }, [lista.data, aba, decididas, filtroGrupo]);

  const pendentes = counts.data?.pendente ?? 0;
  const filaVazia = counts.data != null && pendentes === 0;

  // --- despacho das ações de lote (1 lote em voo por vez) ---
  function despacha(g: HypothesisGroup, acao: AcaoDeGrupo) {
    if (grupoBusy || triando) return;
    if (acao === "um_a_um") {
      setFiltroGrupo({ reason: g.reason, dimension: g.dimension, source_id: g.source_id });
      setAba("pendente");
      return;
    }
    if (acao === "descartar") { setConfirmacao({ tipo: "descartar", grupo: g }); return; }
    if (acao === "receita") { setConfirmacao({ tipo: "receita", grupo: g }); return; }
    void executa(g, acao); // aprovar_recomendados dispara direto (gate decide; nada cego)
  }

  async function executa(g: HypothesisGroup, acao: AcaoDeGrupo) {
    const key = chaveGrupo(g);
    setGrupoBusy(key);
    try {
      if (acao === "receita") {
        const r = await api.hypotheses.addDimToRecipe({ source_id: g.source_id, dimension: g.dimension });
        setResultadoLote(r);
        setToast({ msg: resumoLote(r), tone: "ok" });
      } else if (acao === "aprovar_recomendados") {
        // LEI I: SEMPRE o endpoint gateado do M25-A com apenas_recomendados — NUNCA loop de approve(id)
        const r = await api.hypotheses.approveGroup({
          reason: g.reason, dimension: g.dimension, source_id: g.source_id, apenas_recomendados: true,
        });
        setResultadoLote(r);
        setToast({ msg: resumoLote(r), tone: "ok" });
      } else if (acao === "descartar") {
        const r = await api.hypotheses.discardGroup({
          reason: g.reason, dimension: g.dimension, source_id: g.source_id,
        });
        setToast({ msg: `Grupo descartado — ${fmtNumber(r.descartados)} itens ficam registrados.`, tone: "neutral" });
      }
    } catch (e) {
      setToast({ msg: (e as Error).message, tone: "warn" }); // 404/409/… legível do BFF
    } finally {
      setGrupoBusy(null);
      grupos.refetch();
      counts.refetch();
      lista.refetch();
    }
  }

  // --- triagem (polling = re-POST de judge.run quando assíncrona — §9.2.2) ---
  async function triar() {
    setTriando(true);
    setConfirmacao(null);
    try {
      let r = await api.hypotheses.judge.run();
      while ((r.status === "batch_submetido" || r.status === "batch_em_andamento") && mounted.current) {
        await new Promise((ok) => setTimeout(ok, POLL_MS));
        if (!mounted.current) return;
        r = await api.hypotheses.judge.run(); // re-POST: poll/harvest, nunca submete 2º lote
      }
      if (mounted.current) {
        setToast({
          msg: `O juiz triou ${fmtNumber(r.julgados)} itens (${fmtCustoUsd(r.custo_usd)}) — as recomendações estão nos grupos e nos cards.`,
          tone: "ok",
        });
      }
    } catch (e) {
      if (mounted.current) setToast({ msg: (e as Error).message, tone: "warn" });
    } finally {
      if (mounted.current) {
        setTriando(false);
        grupos.refetch();
        lista.refetch();
        calibracao.refetch();
      }
    }
  }

  // --- fluxo um-a-um M21 (inalterado) ---
  async function act(id: string, kind: "approve" | "discard") {
    if (busyId) return;
    setBusyId(id);
    try {
      await api.hypotheses[kind](id);
      setDecididas((prev) => new Set(prev).add(id));
      setToast(
        kind === "approve"
          ? { msg: "Virou fato com selo.", tone: "ok" }
          : { msg: "Descartado — fica registrado.", tone: "neutral" },
      );
    } catch (e) {
      setToast({ msg: (e as Error).message, tone: "warn" });
    } finally {
      setBusyId(null);
      lista.refetch();
      counts.refetch();
    }
  }

  const pendenteLabel = counts.data != null ? `Esperando você (${pendentes})` : "Esperando você";
  const carregandoPrimeira = aba === null || (lista.loading && lista.data == null && aba !== "grupos");
  const totalAcerto =
    calData && calData.total.decididos > 0
      ? { taxa: calData.total.acerto, n: calData.total.decididos }
      : null;
  const ultimaTriagem: JudgeRun | null = null; // o resultado vive no toast; barra só mostra após status conhecido

  return (
    <div>
      {/* ── PAGE HEAD ──────────────────────────────────────────── */}
      <header style={{ marginBottom: 18 }}>
        <h1 style={{ fontSize: 22, fontWeight: 600, letterSpacing: "-.02em", margin: 0 }}>Revisar</h1>
        <p style={{ fontSize: 14, color: "var(--muted)", margin: "6px 0 0", maxWidth: "68ch", lineHeight: 1.55 }}>
          Trechos que nenhuma receita reconheceu. Você decide: o que aprovar vira fato com selo; o
          que descartar fica registrado — nada some em silêncio.
        </p>
      </header>

      {/* ── ABAS ───────────────────────────────────────────────── */}
      <div role="tablist" aria-label="Fila de revisão" style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        {pendentes > 0 && (
          <TabPill active={aba === "grupos"} onClick={() => setAba("grupos")}>
            Por grupos
          </TabPill>
        )}
        <TabPill active={aba === "pendente"} onClick={() => setAba("pendente")}>
          {pendenteLabel}
        </TabPill>
        <TabPill active={aba === "decididas"} onClick={() => setAba("decididas")}>
          Decididas
        </TabPill>
      </div>

      {/* ── CONTEÚDO POR ABA ───────────────────────────────────── */}
      {aba === "grupos" ? (
        <AbaGrupos
          grupos={grupos.data}
          loading={grupos.loading && grupos.data == null}
          error={grupos.error}
          onRetry={grupos.refetch}
          filaVazia={filaVazia}
          calData={calData}
          pendentes={pendentes}
          triando={triando}
          totalAcerto={totalAcerto}
          ultimaTriagem={ultimaTriagem}
          grupoBusy={grupoBusy}
          grupoExpandido={grupoExpandido}
          onToggleExpand={(k) => setGrupoExpandido((cur) => (cur === k ? null : k))}
          onAcao={despacha}
          onTriar={() => setConfirmacao({ tipo: "triar" })}
        />
      ) : (
        <AbaUmAUm
          aba={aba}
          carregando={carregandoPrimeira}
          erro={lista.error}
          onRetry={lista.refetch}
          itens={itens}
          filtroGrupo={filtroGrupo}
          onLimparFiltro={() => setFiltroGrupo(null)}
          busyId={busyId}
          onApprove={(id) => act(id, "approve")}
          onDiscard={(id) => act(id, "discard")}
        />
      )}

      {/* ── MODAIS DE CONFIRMAÇÃO ──────────────────────────────── */}
      {confirmacao?.tipo === "descartar" && confirmacao.grupo && (
        <ModalDescartar
          grupo={confirmacao.grupo}
          onCancel={() => setConfirmacao(null)}
          onConfirm={() => { const g = confirmacao.grupo!; setConfirmacao(null); void executa(g, "descartar"); }}
        />
      )}
      {confirmacao?.tipo === "receita" && confirmacao.grupo && (
        <ModalReceita
          grupo={confirmacao.grupo}
          onCancel={() => setConfirmacao(null)}
          onConfirm={() => { const g = confirmacao.grupo!; setConfirmacao(null); void executa(g, "receita"); }}
        />
      )}
      {confirmacao?.tipo === "triar" && (
        <ModalTriar onCancel={() => setConfirmacao(null)} onConfirm={() => void triar()} />
      )}

      {/* ── RETIDOS (números + porquês do gate) ────────────────── */}
      <RetidosModal
        open={resultadoLote !== null && confirmacao === null}
        onClose={() => setResultadoLote(null)}
        resultado={resultadoLote}
      />

      {/* ── TOAST ──────────────────────────────────────────────── */}
      {toast && (
        <div style={{ position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)", zIndex: 50 }}>
          <Toast tone={toast.tone} onClose={() => setToast(null)}>
            {toast.msg}
          </Toast>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Aba "grupos"
// ---------------------------------------------------------------------------

function AbaGrupos(props: {
  grupos: HypothesisGroup[] | null;
  loading: boolean;
  error: Error | null;
  onRetry: () => void;
  filaVazia: boolean;
  calData: JudgeCalibration | null;
  pendentes: number;
  triando: boolean;
  totalAcerto: { taxa: number; n: number } | null;
  ultimaTriagem: JudgeRun | null;
  grupoBusy: string | null;
  grupoExpandido: string | null;
  onToggleExpand: (key: string) => void;
  onAcao: (g: HypothesisGroup, acao: AcaoDeGrupo) => void;
  onTriar: () => void;
}) {
  const {
    grupos, loading, error, onRetry, filaVazia, calData, pendentes, triando, totalAcerto,
    ultimaTriagem, grupoBusy, grupoExpandido, onToggleExpand, onAcao, onTriar,
  } = props;

  if (filaVazia) return <VazioPendente />;
  if (loading) return <ListaCarregando />;
  if (error) return <EstadoErro mensagem={error.message} onRetry={onRetry} />;

  const lista = ordenaGrupos(grupos ?? []);
  const nuncaRodou = juizNuncaRodou(lista);
  const semDecisoes = !!calData && calData.total.decididos === 0;

  return (
    <div style={{ maxWidth: 760 }}>
      {pendentes > 0 && (
        <JudgeBar
          pendentes={pendentes}
          nuncaRodou={nuncaRodou}
          semDecisoes={semDecisoes}
          totalAcerto={totalAcerto}
          triando={triando}
          ultimaTriagem={ultimaTriagem}
          onTriar={onTriar}
        />
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {lista.map((g) => {
          const key = chaveGrupo(g);
          return (
            <GroupCard
              key={key}
              group={g}
              segmento={segmentoDoGrupo(calData ?? null, g)}
              busy={grupoBusy === key}
              expandido={grupoExpandido === key}
              onToggleExpand={() => onToggleExpand(key)}
              onAcao={(acao) => onAcao(g, acao)}
            />
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Aba "pendente" / "decididas" — fluxo um a um (M21 preservado + headers de seção)
// ---------------------------------------------------------------------------

function AbaUmAUm(props: {
  aba: AbaRevisar | null;
  carregando: boolean;
  erro: Error | null;
  onRetry: () => void;
  itens: Hypothesis[];
  filtroGrupo: FiltroGrupo | null;
  onLimparFiltro: () => void;
  busyId: string | null;
  onApprove: (id: string) => void;
  onDiscard: (id: string) => void;
}) {
  const { aba, carregando, erro, onRetry, itens, filtroGrupo, onLimparFiltro, busyId, onApprove, onDiscard } = props;
  const pendente = aba === "pendente";

  const filtroSource =
    filtroGrupo && itens.length > 0 ? itens[0].source_name : filtroGrupo?.source_id ?? "";
  const { precisamDeVoce, demais } = pendente
    ? separaPrecisaDeVoce(itens)
    : { precisamDeVoce: [], demais: itens };

  const card = (h: Hypothesis) => (
    <HypothesisCard
      key={h.id}
      item={h}
      busy={busyId === h.id}
      onApprove={pendente ? () => onApprove(h.id) : undefined}
      onDiscard={pendente ? () => onDiscard(h.id) : undefined}
    />
  );

  return (
    <div style={{ maxWidth: 760 }}>
      {/* strip de filtro de grupo (só na aba pendente) */}
      {pendente && filtroGrupo && (
        <div
          style={{
            display: "flex", alignItems: "center", gap: 10, marginBottom: 12,
            fontSize: 12, color: "var(--muted)",
          }}
        >
          <span className="mono">
            filtrando: {filtroGrupo.dimension} · {filtroSource}
          </span>
          <Button variant="ghost" size="sm" onClick={onLimparFiltro}>
            limpar filtro
          </Button>
        </div>
      )}

      {carregando ? (
        <ListaCarregando />
      ) : erro ? (
        <EstadoErro mensagem={erro.message} onRetry={onRetry} />
      ) : itens.length === 0 ? (
        pendente ? <VazioPendente /> : <VazioDecididas />
      ) : pendente && precisamDeVoce.length > 0 ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <h2 style={{ fontSize: 14, fontWeight: 600, margin: "0 0 2px" }}>Precisa de você ({precisamDeVoce.length})</h2>
          {precisamDeVoce.map(card)}
          <h2 style={{ fontSize: 14, fontWeight: 600, margin: "10px 0 2px" }}>Os demais</h2>
          {demais.map(card)}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>{itens.map(card)}</div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Modais de confirmação
// ---------------------------------------------------------------------------

function ModalDescartar({ grupo, onCancel, onConfirm }: { grupo: HypothesisGroup; onCancel: () => void; onConfirm: () => void }) {
  const n = fmtNumber(grupo.count);
  return (
    <Modal
      open
      onClose={onCancel}
      title="Descartar grupo"
      footer={
        <>
          <Button variant="secondary" onClick={onCancel}>Cancelar</Button>
          <Button variant="primary" onClick={onConfirm}>Descartar {n} itens</Button>
        </>
      }
    >
      <p style={{ fontSize: 14, lineHeight: 1.55, margin: 0 }}>
        Descartar os {n} itens deste grupo? Nada some em silêncio — eles ficam registrados na aba
        Decididas, com quem decidiu e quando.
      </p>
    </Modal>
  );
}

function ModalReceita({ grupo, onCancel, onConfirm }: { grupo: HypothesisGroup; onCancel: () => void; onConfirm: () => void }) {
  const n = fmtNumber(grupo.count);
  return (
    <Modal
      open
      onClose={onCancel}
      title="Adicionar à receita"
      footer={
        <>
          <Button variant="secondary" onClick={onCancel}>Cancelar</Button>
          <Button variant="primary" onClick={onConfirm}>Adicionar e aprovar ancorados</Button>
        </>
      }
    >
      <p style={{ fontSize: 14, lineHeight: 1.55, margin: 0 }}>
        A dimensão "{grupo.dimension}" entra na receita da fonte "{grupo.source_name}". Os {n} itens do
        grupo passam por uma verificação: só os que têm citação e número ancorados no texto
        original viram fato com selo — os demais ficam retidos, cada um com o porquê.
      </p>
    </Modal>
  );
}

/** Modal de triagem: busca a estimativa AO ABRIR (loading no corpo); confirma → triar(). */
function ModalTriar({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: () => void }) {
  const est = useQuery<JudgeEstimate>("hypotheses:judge:estimate", () => api.hypotheses.judge.estimate(), []);
  const loading = est.loading && est.data == null;
  const e = est.data;
  return (
    <Modal
      open
      onClose={onCancel}
      title="Triar com o juiz"
      footer={
        <>
          <Button variant="secondary" onClick={onCancel}>Cancelar</Button>
          <Button variant="primary" disabled={loading || !!est.error || !e} onClick={onConfirm}>
            {e ? `Triar ${fmtNumber(e.itens)} itens` : "Triar"}
          </Button>
        </>
      }
    >
      {loading ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <Skeleton width="80%" />
          <Skeleton width="55%" />
        </div>
      ) : est.error ? (
        <p style={{ fontSize: 14, lineHeight: 1.55, margin: 0, color: "var(--muted)" }}>{est.error.message}</p>
      ) : e ? (
        <p style={{ fontSize: 14, lineHeight: 1.55, margin: 0 }}>
          Triar {fmtNumber(e.itens)} itens com o juiz custa {fmtCustoUsd(e.custo_usd_estimado)}
          {e.batch ? " (em lote, com desconto)" : ""}. O juiz só recomenda — quem aprova é você (ou o
          gate, nunca a confiança dele).
        </p>
      ) : null}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Abas (pill simples)
// ---------------------------------------------------------------------------

function TabPill({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      style={{
        height: 32,
        padding: "0 14px",
        borderRadius: 99,
        border: `1px solid ${active ? "transparent" : "var(--border-strong)"}`,
        background: active ? "var(--accent-soft)" : "var(--surface)",
        color: active ? "var(--accent-ink)" : "var(--muted)",
        fontFamily: "var(--font)",
        fontSize: 13,
        fontWeight: 600,
        cursor: "pointer",
        transition: "background .12s, color .12s, border-color .12s",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Estados
// ---------------------------------------------------------------------------

function ListaCarregando() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, maxWidth: 760 }}>
      {[0, 1, 2].map((i) => (
        <Card key={i} padding="14px 16px">
          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            <Skeleton width={74} height={18} />
            <Skeleton width={90} height={18} />
            <Skeleton width={120} height={12} style={{ marginLeft: "auto" }} />
          </div>
          <Skeleton width="92%" />
          <Skeleton width="70%" style={{ marginTop: 8 }} />
          <Skeleton width="55%" height={11} style={{ marginTop: 12 }} />
        </Card>
      ))}
    </div>
  );
}

function VazioPendente() {
  return (
    <Card padding="32px 28px" style={{ maxWidth: 560 }}>
      <div style={{ display: "inline-flex", alignItems: "center", gap: 9 }}>
        <span
          aria-hidden
          style={{
            display: "grid", placeItems: "center", width: 34, height: 34, borderRadius: 10,
            background: "var(--accent-soft)", color: "var(--accent-ink)",
          }}
        >
          <Icon name="check" size={18} />
        </span>
        <span style={{ fontSize: 17, fontWeight: 600 }}>Nada esperando revisão.</span>
      </div>
      <p style={{ fontSize: 14, color: "var(--muted)", margin: "8px 0 0", lineHeight: 1.55 }}>
        Tudo que entrou casou com as receitas.
      </p>
    </Card>
  );
}

function VazioDecididas() {
  return (
    <Card padding="32px 28px" style={{ maxWidth: 560 }}>
      <div style={{ display: "inline-flex", alignItems: "center", gap: 9, color: "var(--accent-ink)" }}>
        <Icon name="info" size={18} />
        <span style={{ fontSize: 17, fontWeight: 600, color: "var(--fg)" }}>Nenhuma decisão ainda.</span>
      </div>
      <p style={{ fontSize: 14, color: "var(--muted)", margin: "8px 0 0", lineHeight: 1.55 }}>
        Quando você aprovar ou descartar uma hipótese, a decisão fica registrada aqui — com quem
        decidiu e quando.
      </p>
    </Card>
  );
}

function EstadoErro({ mensagem, onRetry }: { mensagem: string; onRetry: () => void }) {
  return (
    <div
      role="alert"
      style={{
        maxWidth: 560, padding: "16px 18px", borderRadius: 12, border: "1px solid var(--danger)",
        background: "var(--sn-secret-soft)", display: "flex", alignItems: "center", gap: 14,
      }}
    >
      <span style={{ flex: 1 }}>
        <b>Não consegui carregar a fila de revisão.</b>
        <span style={{ display: "block", fontSize: 13, color: "var(--muted)", marginTop: 4 }}>{mensagem}</span>
      </span>
      <Button size="sm" onClick={onRetry}>Tentar de novo</Button>
    </div>
  );
}
