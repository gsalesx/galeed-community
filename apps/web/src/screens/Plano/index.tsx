/** Tela PLANO & CRÉDITOS (M-PAY front) — porta fiel de docs/design-system/plano.html.
 *
 *  Renderiza dentro do <main> do AppShell, então DROPA a topbar/sidebar/mnav/footer do
 *  protótipo (a chrome já vem do shell) e porta só o conteúdo do `.main` (de `.page-head`
 *  até as faturas), num wrapper `<div className="plano">` com um <style> ESCOPADO sob `.plano`
 *  (mesma técnica da tela Lançamento). Tokens exclusivos do protótipo ficam no `.plano{}`;
 *  o resto reusa os tokens globais do app.
 *
 *  TUDO via api.billing.* (REAL). Nada de número inventado:
 *   - Saldo: ring + split de api.billing.ledger().summary (graceful "sem carteira").
 *   - Seu plano: api.billing.subscription() + cérebros = brains da sessão (useBrain).
 *   - Consumo: série diária client-side sobre ledger.daily (janela 7/14/30).
 *   - Histórico: ledger.entries com filtros + export CSV client-side.
 *   - Fundador: api.billing.founder().
 *   - Planos: checkout(tier,"founder") via Modal de confirmação → redireciona pro Stripe.
 *   - Packs: topup(id) → redireciona pro Stripe.
 *   - Forma de pagamento: portal() (Stripe gerencia cartão/Pix).
 *   - Teto de gasto: cap()/setCap() funcional (R$ = créditos × 0,02).
 *   - Faturas: empty state.
 *  Trata os retornos ?checkout=success|cancel e ?topup=success|cancel (toast + refetch).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { Modal, Toast } from "../../ui";
import { useBrain } from "../../lib/auth";
import { useQuery } from "../../lib/useQuery";
import { api, ApiError } from "../../lib/api";
import type { LedgerView, LedgerEntry, SpendCap, BillingPrefs } from "../../lib/api";

// ---------------------------------------------------------------------------
// Ícones inline (24×24; tamanho vem do CSS). `d` p/ path único; `children` p/ múltiplos.
// ---------------------------------------------------------------------------
function Ico({ d, sw = 2, children }: { d?: string; sw?: number; children?: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={sw} aria-hidden>
      {children ?? <path d={d} />}
    </svg>
  );
}
const IClock = () => (
  <Ico>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </Ico>
);
const IInfo = () => (
  <Ico>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 8v4M12 16h.01" />
  </Ico>
);
const IInfo2 = () => (
  <Ico>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 16v-4M12 8h.01" />
  </Ico>
);
const IPlan = () => (
  <Ico>
    <path d="M20 7L12 3 4 7v10l8 4 8-4z" />
    <path d="M12 12l8-4M12 12v9M12 12L4 8" />
  </Ico>
);
const IBars = () => (
  <Ico>
    <path d="M3 3v18h18" />
    <rect x="7" y="11" width="3" height="6" />
    <rect x="13" y="7" width="3" height="10" />
  </Ico>
);
const IDown = () => <Ico d="M12 3v12m0 0l-4-4m4 4l4-4M5 21h14" />;
const IChat = () => <Ico d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />;
const IPlus = () => (
  <Ico>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 8v8M8 12h8" />
  </Ico>
);
const ICheck = () => <Ico d="M20 6L9 17l-5-5" />;
const IBuilding = () => (
  <Ico>
    <path d="M3 21h18M5 21V7l7-4 7 4v14M9 9h.01M9 13h.01M9 17h.01M15 9h.01M15 13h.01M15 17h.01" />
  </Ico>
);
const ICard = () => (
  <Ico>
    <rect x="2" y="5" width="20" height="14" rx="2" />
    <path d="M2 10h20" />
  </Ico>
);
const ICap = () => (
  <Ico>
    <path d="M12 2a10 10 0 1 0 10 10" />
    <path d="M12 7v5l3 2" />
    <path d="M16 4l4 4-4 4" />
  </Ico>
);
const IInvoice = () => (
  <Ico>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <path d="M14 2v6h6M9 13h6M9 17h4" />
  </Ico>
);
const ILock = () => (
  <Ico>
    <rect x="5" y="11" width="14" height="10" rx="1.5" />
    <path d="M8 11V7a4 4 0 0 1 8 0v4" />
  </Ico>
);

// ---------------------------------------------------------------------------
// Planos / packs (preços EXATOS do protótipo). tierId casa com api.billing.checkout.
// ---------------------------------------------------------------------------
type TierId = "starter" | "pro" | "business";
interface Plan {
  id: TierId;
  name: string;
  forWhom: string;
  was: string;
  now: string;
  pop?: boolean;
  badge?: string;
  specs: { lead?: string; tail: string }[]; // lead = pedaço em <b>
}
const PLANS: Plan[] = [
  {
    id: "starter",
    name: "Starter",
    forWhom: "pra começar",
    was: "R$119",
    now: "R$45",
    specs: [
      { lead: "4.000 créditos", tail: " por mês" },
      { lead: "1 cérebro", tail: " · ~50 documentos/mês" },
      { tail: "API e MCP pra qualquer IA" },
      { tail: "Teto de gasto com desligamento" },
    ],
  },
  {
    id: "pro",
    name: "Pro",
    forWhom: "pro dia a dia",
    was: "R$329",
    now: "R$129",
    pop: true,
    badge: "o mais escolhido",
    specs: [
      { lead: "10.000 créditos", tail: " por mês" },
      { lead: "3 cérebros", tail: " · ~150 documentos/mês" },
      { tail: "Acessos por pessoa e por bot" },
      { lead: "Suporte de ponta", tail: " de fundador" },
    ],
  },
  {
    id: "business",
    name: "Business",
    forWhom: "pra equipe",
    was: "R$1.197",
    now: "R$379",
    specs: [
      { lead: "30.000 créditos", tail: " por mês" },
      { lead: "5 cérebros", tail: " · ~450 documentos/mês" },
      { tail: "Níveis de sigilo por área" },
      { tail: "Histórico de acesso completo" },
    ],
  },
];

interface Pack {
  id: string;
  qty: string;
  price: string;
  best?: boolean;
}
const PACKS: Pack[] = [
  { id: "cr2500", qty: "2.500", price: "R$50" },
  { id: "cr10000", qty: "10.000", price: "R$200" },
  { id: "cr50000", qty: "50.000", price: "R$1.000", best: true },
];

const CREDIT_TO_BRL = 0.02; // 1 crédito = R$0,02
const LEDGER_LIMIT = 50; // nº de entradas carregadas do histórico

const fmt = (n: number) => Math.round(n).toLocaleString("pt-BR");
const fmtBRL = (reais: number) =>
  "R$" +
  reais.toLocaleString("pt-BR", {
    minimumFractionDigits: Number.isInteger(reais) ? 0 : 2,
    maximumFractionDigits: 2,
  });

type ToastState = { msg: string; tone: "ok" | "neutral" | "danger" } | null;
type LFilter = "all" | "ing" | "ask" | "top";

// ---------------------------------------------------------------------------
// Tempo relativo p/ o histórico ("hoje · HH:MM", "ontem · HH:MM", "N dias · HH:MM").
// ---------------------------------------------------------------------------
function relTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const hhmm = d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startThat = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startToday - startThat) / 86400000);
  if (days <= 0) return `hoje · ${hhmm}`;
  if (days === 1) return `ontem · ${hhmm}`;
  return `${days} dias · ${hhmm}`;
}

// ---------------------------------------------------------------------------
// Classificação de uma entrada do ledger → ícone, label, subtítulo.
// ---------------------------------------------------------------------------
function entryKind(e: LedgerEntry): "top" | "ask" | "ing" {
  if (e.delta > 0) return "top";
  if (e.op === "ask") return "ask";
  return "ing";
}
function entryLabel(e: LedgerEntry): string {
  if (e.delta > 0) {
    if (e.bucket === "monthly") return "Créditos do plano";
    if (e.bucket === "topup") return "Créditos adicionados";
    return "Créditos";
  }
  if (e.op === "ask") return "Perguntou";
  if (e.op === "ingest") return "Jogou conteúdo dentro";
  return e.reason || "Gasto";
}
function entryMatchesFilter(e: LedgerEntry, f: LFilter): boolean {
  if (f === "all") return true;
  if (f === "top") return e.delta > 0;
  if (f === "ing") return e.op === "ingest";
  if (f === "ask") return e.op === "ask";
  return true;
}

// ---------------------------------------------------------------------------
// Gráfico de consumo (porta de `render(n)` do protótipo): bar stack ing+ask por dia.
// ---------------------------------------------------------------------------
const CH = { W: 720, H: 190, padL: 10, padR: 10, padT: 14, padB: 20 };
const PLOT_H = CH.H - CH.padT - CH.padB;
const BASE_Y = CH.padT + PLOT_H;

interface Day {
  date: string; // YYYY-MM-DD
  ing: number;
  ask: number;
  label: string; // d/m
}

/** Constrói a janela de N dias do calendário (mais antigo → mais novo) a partir de ledger.daily. */
function buildWindow(daily: { date: string; ing: number; ask: number }[], n: number): Day[] {
  const byDate = new Map(daily.map((d) => [d.date, d]));
  const out: Day[] = [];
  const today = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
    const key =
      d.getFullYear() +
      "-" +
      String(d.getMonth() + 1).padStart(2, "0") +
      "-" +
      String(d.getDate()).padStart(2, "0");
    const hit = byDate.get(key);
    out.push({
      date: key,
      ing: hit?.ing ?? 0,
      ask: hit?.ask ?? 0,
      label: d.getDate() + "/" + (d.getMonth() + 1),
    });
  }
  return out;
}

interface ChartTip {
  x: number;
  y: number;
  total: number;
  ing: number;
  ask: number;
  label: string;
}

/** Self-host sem Stripe não expõe tela de billing — o gate vive num wrapper FORA da tela
 *  (que tem dezenas de hooks): return condicional lá dentro violaria as regras de hooks. */
export default function Plano() {
  const { data: health } = useQuery<{ ok: boolean; billing?: boolean }>(
    "health",
    () => fetch("/api/health").then((r) => r.json()),
    [],
  );
  if (!health) return null; // carregando — não pisca a tela de billing
  if (health.billing !== true) return <Navigate to="/app" replace />;
  return <PlanoScreen />;
}

function PlanoScreen() {
  const { brains } = useBrain();
  const brainCount = brains.length;

  const [ledger, setLedger] = useState<LedgerView | null>(null);
  const [hasSub, setHasSub] = useState<boolean | null>(null); // tem plano ativo?
  const [subTier, setSubTier] = useState<string | null>(null);
  const [subStatusLabel, setSubStatusLabel] = useState<string | null>(null);
  const [graceUntil, setGraceUntil] = useState<string | null>(null); // M-PAY-H — janela de graça (past_due)
  const [founderTotal, setFounderTotal] = useState<number | null>(null);
  const [founderUsed, setFounderUsed] = useState<number | null>(null);
  const [founderRemaining, setFounderRemaining] = useState<number | null>(null);
  const [cap, setCap] = useState<SpendCap | null>(null);
  const [prefs, setPrefs] = useState<BillingPrefs | null>(null); // M-PAY-H — auto-recarga + dunning

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastState>(null);

  // UI local
  const [window7, setWindow7] = useState<7 | 14 | 30>(30);
  const [lfilter, setLfilter] = useState<LFilter>("all");
  const [tip, setTip] = useState<ChartTip | null>(null);
  const [confirmPlan, setConfirmPlan] = useState<Plan | null>(null);

  // teto: campo de R$ controlado (debounce no salvar)
  const [capReaisInput, setCapReaisInput] = useState<string>("");
  const capDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const STATUS_LABEL: Record<string, string> = useMemo(
    () => ({
      active: "Ativa",
      trialing: "Em teste",
      past_due: "Pagamento pendente",
      unpaid: "Não paga",
      canceled: "Cancelada",
      incomplete: "Incompleta",
    }),
    [],
  );

  const load = useCallback(async () => {
    const [subR, ledgerR, founderR, capR, prefsR] = await Promise.allSettled([
      api.billing.subscription(),
      api.billing.ledger({ limit: LEDGER_LIMIT }),
      api.billing.founder(),
      api.billing.cap(),
      api.billing.prefs(),
    ]);

    if (subR.status === "fulfilled") {
      const s = subR.value;
      const has = !!s.status && s.status !== "canceled";
      setHasSub(has);
      setSubTier(s.tier);
      setSubStatusLabel(s.status ? STATUS_LABEL[s.status] ?? s.status : null);
      // M-PAY-H: banner de graça só quando past_due COM janela ainda futura (entitlement = 'grace').
      setGraceUntil(s.status === "past_due" && s.grace_until ? s.grace_until : null);
    } else {
      setHasSub(false);
      setGraceUntil(null);
    }

    if (ledgerR.status === "fulfilled") setLedger(ledgerR.value);

    if (founderR.status === "fulfilled") {
      setFounderTotal(founderR.value.total);
      setFounderUsed(founderR.value.used);
      setFounderRemaining(founderR.value.remaining);
    }

    if (capR.status === "fulfilled") {
      setCap(capR.value);
      setCapReaisInput(String(Math.round(capR.value.limitCredits * CREDIT_TO_BRL)));
    }

    if (prefsR.status === "fulfilled") setPrefs(prefsR.value);

    setLoading(false);
  }, [STATUS_LABEL]);

  useEffect(() => {
    void load();
  }, [load]);

  // Retornos do Stripe (?checkout/?topup). Crédito chega por webhook → toast + refetch atrasado.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const ok = p.get("checkout") === "success" || p.get("topup") === "success";
    const cancel = p.get("checkout") === "cancel" || p.get("topup") === "cancel";
    if (ok) {
      setToast({ msg: "Pagamento confirmado — atualizando seu plano e saldo…", tone: "ok" });
      const t = setTimeout(() => void load(), 2500);
      window.history.replaceState({}, "", window.location.pathname);
      return () => clearTimeout(t);
    }
    if (cancel) {
      setToast({ msg: "Pagamento cancelado.", tone: "neutral" });
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, [load]);

  // redireciona pro Stripe (checkout/topup/portal)
  const go = useCallback(async (key: string, fn: () => Promise<{ url: string }>) => {
    setBusy(key);
    try {
      const { url } = await fn();
      window.location.href = url;
    } catch (e) {
      setToast({ msg: e instanceof ApiError ? e.message : "falha ao iniciar o pagamento", tone: "danger" });
      setBusy(null);
    }
  }, []);

  // --- derivados do ledger ---
  const summary = ledger?.summary ?? null;
  const balance = summary?.balance ?? null;
  const grant = summary?.grant ?? 0;
  const hasWallet = balance != null;
  const ringFrac = hasWallet && grant > 0 ? Math.max(0, Math.min(1, balance / grant)) : 0;

  const spentIngest = summary?.spentIngest ?? 0;
  const spentAsk = summary?.spentAsk ?? 0;
  const spentTotal = summary?.spentTotal ?? 0;
  const ingPct = spentTotal > 0 ? (spentIngest / spentTotal) * 100 : 0;
  const askPct = spentTotal > 0 ? (spentAsk / spentTotal) * 100 : 0;

  // ring SVG (r=54, C=2πr) — fração CHEIA = saldo/grant
  const RING_R = 54;
  const RING_C = 2 * Math.PI * RING_R;
  const ringOffset = RING_C * (1 - ringFrac);

  // --- série do gráfico ---
  const days = useMemo(() => buildWindow(ledger?.daily ?? [], window7), [ledger, window7]);
  const chartMax = useMemo(() => Math.max(1, ...days.map((d) => d.ing + d.ask)), [days]);
  const consumed = useMemo(() => days.reduce((s, d) => s + d.ing + d.ask, 0), [days]);
  const avgPerDay = window7 > 0 ? consumed / window7 : 0;
  const monthPace = avgPerDay * 30;
  const maxDay = useMemo(() => Math.max(0, ...days.map((d) => d.ing + d.ask)), [days]);

  const slot = (CH.W - CH.padL - CH.padR) / window7;
  const barW = Math.min(slot * 0.6, 16);

  // --- histórico filtrado ---
  const entries = ledger?.entries ?? [];
  const filteredEntries = useMemo(() => entries.filter((e) => entryMatchesFilter(e, lfilter)), [entries, lfilter]);
  const reachedLimit = entries.length >= LEDGER_LIMIT;

  // --- export CSV (client-side) ---
  const exportCsv = useCallback(() => {
    if (entries.length === 0) {
      setToast({ msg: "Nada no histórico pra exportar ainda.", tone: "neutral" });
      return;
    }
    const head = ["data", "tipo", "descricao", "cerebro", "creditos"];
    const rows = entries.map((e) => {
      const desc = entryLabel(e).replace(/"/g, '""');
      const brain = (e.brain ?? "").replace(/"/g, '""');
      return [
        new Date(e.created_at).toISOString(),
        entryKind(e),
        `"${desc}"`,
        `"${brain}"`,
        String(e.delta),
      ].join(",");
    });
    const csv = [head.join(","), ...rows].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "galeed-historico-creditos.csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setToast({ msg: "Histórico exportado em CSV.", tone: "ok" });
  }, [entries]);

  // --- teto de gasto ---
  const capEnabled = cap?.enabled ?? false;
  const capKill = cap?.killSwitch ?? false;
  const capLimitCredits = cap?.limitCredits ?? 0;
  const capSpentCredits = cap?.cycleSpentCredits ?? 0;
  const capLimitBRL = capLimitCredits * CREDIT_TO_BRL;
  const capSpentBRL = capSpentCredits * CREDIT_TO_BRL;
  const capFillPct = capLimitCredits > 0 ? Math.min(100, (capSpentCredits / capLimitCredits) * 100) : 0;

  const saveCap = useCallback(
    async (next: { enabled: boolean; killSwitch: boolean; limitCredits: number }) => {
      try {
        const saved = await api.billing.setCap(next);
        setCap(saved);
        setCapReaisInput(String(Math.round(saved.limitCredits * CREDIT_TO_BRL)));
        setToast({ msg: "Teto atualizado.", tone: "ok" });
      } catch (e) {
        setToast({ msg: e instanceof ApiError ? e.message : "falha ao salvar o teto", tone: "danger" });
        void load(); // re-sincroniza com o servidor
      }
    },
    [load],
  );

  const onToggleCap = useCallback(
    (enabled: boolean) => {
      if (!cap) return;
      setCap({ ...cap, enabled });
      void saveCap({ enabled, killSwitch: cap.killSwitch, limitCredits: cap.limitCredits });
    },
    [cap, saveCap],
  );

  const onToggleKill = useCallback(
    (killSwitch: boolean) => {
      if (!cap) return;
      setCap({ ...cap, killSwitch });
      void saveCap({ enabled: cap.enabled, killSwitch, limitCredits: cap.limitCredits });
    },
    [cap, saveCap],
  );

  const onCapReais = useCallback(
    (raw: string) => {
      setCapReaisInput(raw);
      if (!cap) return;
      const reais = Math.max(0, Math.floor(Number(raw) || 0));
      const limitCredits = reais * 50; // créditos = reais × 50
      setCap({ ...cap, limitCredits }); // otimista, pro meter responder
      if (capDebounce.current) clearTimeout(capDebounce.current);
      capDebounce.current = setTimeout(() => {
        void saveCap({ enabled: cap.enabled, killSwitch: cap.killSwitch, limitCredits });
      }, 600);
    },
    [cap, saveCap],
  );

  const flushCap = useCallback(() => {
    if (!cap) return;
    if (capDebounce.current) {
      clearTimeout(capDebounce.current);
      capDebounce.current = null;
    }
    const reais = Math.max(0, Math.floor(Number(capReaisInput) || 0));
    const limitCredits = reais * 50;
    if (limitCredits !== capLimitCredits) {
      void saveCap({ enabled: cap.enabled, killSwitch: cap.killSwitch, limitCredits });
    }
  }, [cap, capReaisInput, capLimitCredits, saveCap]);

  useEffect(
    () => () => {
      if (capDebounce.current) clearTimeout(capDebounce.current);
    },
    [],
  );

  // --- auto-recarga (M-PAY-H Onda 4) — opt-in off_session. Ligar exige método salvo (hasPaymentMethod)
  // + um pacote. Salva via api.billing.setPrefs; o backend revalida (400 sem método/pacote). ---
  const savePrefs = useCallback(
    async (next: { enabled: boolean; thresholdCredits: number; package: string | null }) => {
      setBusy("autorecharge");
      try {
        const saved = await api.billing.setPrefs(next);
        setPrefs(saved);
        setToast({ msg: next.enabled ? "Auto-recarga ligada." : "Auto-recarga desligada.", tone: "ok" });
      } catch (e) {
        setToast({ msg: e instanceof ApiError ? e.message : "falha ao salvar a auto-recarga", tone: "danger" });
        void load(); // re-sincroniza
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  const onToggleAutorecharge = useCallback(
    (enabled: boolean) => {
      if (!prefs) return;
      const pkg = prefs.autorechargePackage ?? PACKS[0].id;
      const threshold = prefs.autorechargeThresholdCredits > 0 ? prefs.autorechargeThresholdCredits : 500;
      void savePrefs({ enabled, thresholdCredits: threshold, package: pkg });
    },
    [prefs, savePrefs],
  );

  const onAutorechargePackage = useCallback(
    (pkg: string) => {
      if (!prefs) return;
      void savePrefs({ enabled: prefs.autorechargeEnabled, thresholdCredits: prefs.autorechargeThresholdCredits, package: pkg });
    },
    [prefs, savePrefs],
  );

  const onAutorechargeThreshold = useCallback(
    (raw: string) => {
      if (!prefs) return;
      const threshold = Math.max(0, Math.floor(Number(raw) || 0));
      void savePrefs({ enabled: prefs.autorechargeEnabled, thresholdCredits: threshold, package: prefs.autorechargePackage });
    },
    [prefs, savePrefs],
  );

  // --- trial countdown + alerta de consumo (M-PAY-H) ---
  // trialExpiresAt/readOnly vêm do summary do ledger (backend expõe p/ o front mostrar o estado).
  const trialExpiresAt = summary?.trialExpiresAt ?? null;
  const readOnly = summary?.readOnly ?? false;
  const trialDaysLeft = useMemo(() => {
    if (!trialExpiresAt) return null;
    const ms = new Date(trialExpiresAt).getTime() - Date.now();
    if (Number.isNaN(ms)) return null;
    return Math.max(0, Math.ceil(ms / 86400000));
  }, [trialExpiresAt]);
  // alerta de consumo: maior limiar já cruzado (60/80/90) + pct corrente do ciclo.
  const alertPct = summary?.alertPct ?? 0;
  const consumptionPct = summary?.consumptionPct ?? 0;
  const showConsumptionAlert = alertPct >= 60 && !readOnly;

  // --- confirmar assinatura ---
  // M-PAY-H (Onda 4): escolhe o cohort por DISPONIBILIDADE — 'founder' enquanto há vaga (founderRemaining
  // > 0), senão 'standard'. Sem vaga fundador NÃO pode travar a assinatura: o backend resolve o preço
  // padrão (resolvePriceId(tier,'standard')). Antes o front mandava SEMPRE 'founder' (gap #5).
  const confirmCheckout = useCallback(() => {
    if (!confirmPlan) return;
    const p = confirmPlan;
    setConfirmPlan(null);
    const cohort = founderRemaining != null && founderRemaining > 0 ? "founder" : "standard";
    void go(`tier-${p.id}`, () => api.billing.checkout(p.id, cohort));
  }, [confirmPlan, founderRemaining, go]);

  // gridlines do gráfico
  const gridLines = [0.25, 0.5, 0.75, 1].map((f) => ({
    y: BASE_Y - PLOT_H * f,
    dashed: f < 1,
  }));

  // x labels (step ~6)
  const xStep = Math.max(1, Math.round(window7 / 6));

  const showFounder = founderTotal != null && founderRemaining != null && founderRemaining > 0;

  return (
    <div className="plano">
      <style>{CSS}</style>

      {/* PAGE HEAD */}
      <div className="page-head">
        <div>
          <h1>Plano e créditos</h1>
          <p>Seu saldo, pra onde foram seus créditos, e como subir de plano.</p>
        </div>
      </div>

      {/* M-PAY-H — banner de graça: pagamento pendente, ainda em janela de uso até a data. */}
      {graceUntil && (
        <div className="grace-banner" role="alert">
          <span>
            Pagamento da assinatura pendente. Você continua com acesso até{" "}
            <b>{new Date(graceUntil).toLocaleDateString("pt-BR")}</b> — atualize seu método de pagamento para não perder
            as ações pagas.
          </span>
          <button
            className="btn primary"
            onClick={() => void go("portal", () => api.billing.portal())}
            disabled={busy === "portal"}
          >
            {busy === "portal" ? "Abrindo…" : "Atualizar pagamento"}
          </button>
        </div>
      )}

      {/* M-PAY-H — alerta de consumo (60/80/90% do bolo do ciclo). Só aparece após cruzar um limiar. */}
      {showConsumptionAlert && (
        <div className={"consume-banner" + (alertPct >= 90 ? " hi" : "")} role="status">
          <IInfo2 />
          <span>
            Você já usou <b>{consumptionPct}%</b> dos créditos do ciclo
            {prefs?.autorechargeEnabled
              ? " — a auto-recarga assume quando o saldo baixar."
              : ". Ligue a auto-recarga ou recarregue para não ficar sem."}
          </span>
          {!prefs?.autorechargeEnabled && (
            <a className="btn" href="#packs" onClick={(e) => scrollTo(e, "packs")}>
              Recarregar
            </a>
          )}
        </div>
      )}

      {/* M-PAY-H — contagem regressiva do trial: créditos de teste expiram em 14 dias → read-only. */}
      {trialExpiresAt && !hasSub && trialDaysLeft != null && (
        <div className={"trial-banner" + (readOnly ? " over" : trialDaysLeft <= 3 ? " soon" : "")} role="status">
          <IClock />
          <span>
            {readOnly ? (
              <>
                Seu teste grátis expirou — a conta está em <b>modo leitura</b>. Assine um plano ou recarregue para voltar
                a jogar conteúdo e perguntar.
              </>
            ) : (
              <>
                Seu teste grátis termina em <b>{trialDaysLeft === 1 ? "1 dia" : `${trialDaysLeft} dias`}</b> (
                {new Date(trialExpiresAt).toLocaleDateString("pt-BR")}). Ao expirar, os créditos de teste não usados são
                zerados e a conta vira leitura.
              </>
            )}
          </span>
          <a className="btn primary" href="#planos" onClick={(e) => scrollTo(e, "planos")}>
            Ver planos
          </a>
        </div>
      )}

      {/* STATUS */}
      <div className="status-grid">
        {/* balance */}
        <div className="scard">
          <div className="ch">
            <IClock /> Saldo de créditos
          </div>
          {hasWallet ? (
            <div className="balance">
              <div className="ring">
                <svg width="124" height="124" viewBox="0 0 128 128">
                  <circle cx="64" cy="64" r={RING_R} fill="none" stroke="var(--surface-2)" strokeWidth="13" />
                  <circle
                    cx="64"
                    cy="64"
                    r={RING_R}
                    fill="none"
                    stroke="var(--accent)"
                    strokeWidth="13"
                    strokeLinecap="round"
                    strokeDasharray={RING_C.toFixed(2)}
                    strokeDashoffset={ringOffset.toFixed(1)}
                  />
                </svg>
                <div className="center">
                  <b className="num">{fmt(balance ?? 0)}</b>
                  <small>de {fmt(grant)}</small>
                </div>
              </div>
              <div className="info">
                <div className="big">
                  <b className="num">{fmt(balance ?? 0)}</b>
                  <span>créditos restantes</span>
                </div>
                <div className="usebar">
                  <i className="ing" style={{ width: `${ingPct}%` }} />
                  <i className="ask" style={{ width: `${askPct}%` }} />
                </div>
                <div className="uselegend">
                  <span className="li">
                    <span className="sw" style={{ background: "var(--st-fact)" }} /> Jogar dentro{" "}
                    <span className="n">{fmt(spentIngest)}</span>
                  </span>
                  <span className="li">
                    <span className="sw" style={{ background: "var(--accent)" }} /> Perguntar{" "}
                    <span className="n">{fmt(spentAsk)}</span>
                  </span>
                  <span className="li">
                    <span className="sw" style={{ background: "var(--border-strong)" }} /> Total gasto{" "}
                    <span className="n">{fmt(spentTotal)}</span>
                  </span>
                </div>
                <div className="note">
                  <IInfo />{" "}
                  {trialExpiresAt && !hasSub
                    ? trialDaysLeft != null && trialDaysLeft > 0
                      ? `Os créditos do teste expiram em ${trialDaysLeft === 1 ? "1 dia" : `${trialDaysLeft} dias`} — assine para renovar todo mês.`
                      : "O teste expirou. Assine para renovar créditos todo mês."
                    : "Seus créditos do plano renovam todo mês. Créditos avulsos não expiram."}
                </div>
              </div>
            </div>
          ) : (
            <div className="balance-empty">
              <b>Sem carteira ainda</b>
              <p>Assine um plano ou recarregue créditos pra começar a usar.</p>
              <a className="btn primary" href="#planos" onClick={(e) => scrollTo(e, "planos")}>
                Ver planos
              </a>
            </div>
          )}
        </div>

        {/* plan status */}
        <div className="scard planstatus">
          <div className="ch">
            <IPlan /> Seu plano
          </div>
          {hasSub ? (
            <>
              <span className="trial-pill on">
                <span className="d" /> {subStatusLabel ?? "Ativo"}
              </span>
              <h3 style={{ textTransform: "capitalize" }}>{subTier ?? "Plano"}</h3>
              <p className="desc">Plano ativo. Renova todo mês com seus créditos.</p>
            </>
          ) : (
            <>
              <span className="trial-pill">
                <span className="d" /> Teste grátis
              </span>
              <h3>Sem plano ainda</h3>
              <p className="desc">
                Você está usando o teste. Escolha um plano pra renovar créditos todo mês e liberar mais cérebros.
              </p>
            </>
          )}
          <div className="ministat">
            <div className="m">
              <b className="num">{loading ? "·" : fmt(brainCount)}</b>
              <small>{brainCount === 1 ? "cérebro" : "cérebros"}</small>
            </div>
            <div className="m">
              <b className="num">{grant > 0 ? fmt(grant) : "·"}</b>
              <small>créditos/mês</small>
            </div>
            <div className="m">
              <b className="num">∞</b>
              <small>perguntas*</small>
            </div>
          </div>
          <div className="cta">
            <a className="btn primary lg block" href="#planos" onClick={(e) => scrollTo(e, "planos")}>
              Ver planos
            </a>
          </div>
        </div>
      </div>

      {/* CONSUMO */}
      <div className="sec-title">
        <h2>Consumo</h2>
        <p>Pra onde foram seus créditos.</p>
      </div>
      <div className="cons-card">
        <div className="cons-head">
          <div className="ch">
            <IBars /> Créditos gastos por dia
          </div>
          <div className="seg">
            {([7, 14, 30] as const).map((n) => (
              <button key={n} className={window7 === n ? "on" : undefined} onClick={() => setWindow7(n)}>
                {n} dias
              </button>
            ))}
          </div>
        </div>
        <div className="chart-wrap">
          <svg viewBox="0 0 720 190" className="chart" role="img" aria-label="Consumo de créditos por dia">
            {gridLines.map((g, i) => (
              <line
                key={i}
                className="grid"
                x1={CH.padL}
                y1={g.y.toFixed(1)}
                x2={CH.W - CH.padR}
                y2={g.y.toFixed(1)}
                strokeWidth="1"
                strokeDasharray={g.dashed ? "2 5" : undefined}
              />
            ))}
            {days.map((d, i) => {
              const x = CH.padL + slot * i + (slot - barW) / 2;
              const hIng = (d.ing / chartMax) * PLOT_H;
              const hAsk = (d.ask / chartMax) * PLOT_H;
              const yIng = BASE_Y - hIng;
              const yAsk = yIng - hAsk;
              return (
                <g key={d.date}>
                  {d.ing > 0 && (
                    <rect className="bar-ing" x={x.toFixed(1)} y={yIng.toFixed(1)} width={barW.toFixed(1)} height={hIng.toFixed(1)} rx="2" />
                  )}
                  {d.ask > 0 && (
                    <rect className="bar-ask" x={x.toFixed(1)} y={yAsk.toFixed(1)} width={barW.toFixed(1)} height={hAsk.toFixed(1)} rx="2" />
                  )}
                  <rect
                    className="hit"
                    x={(CH.padL + slot * i).toFixed(1)}
                    y={CH.padT}
                    width={slot.toFixed(1)}
                    height={PLOT_H}
                    fill="transparent"
                    onMouseMove={(ev) => {
                      const wrap = (ev.currentTarget.ownerSVGElement?.parentElement as HTMLElement) ?? null;
                      const wr = wrap?.getBoundingClientRect();
                      const rb = ev.currentTarget.getBoundingClientRect();
                      setTip({
                        x: wr ? ev.clientX - wr.left : 0,
                        y: wr ? rb.top - wr.top : 0,
                        total: d.ing + d.ask,
                        ing: d.ing,
                        ask: d.ask,
                        label: d.label,
                      });
                    }}
                    onMouseLeave={() => setTip(null)}
                  />
                </g>
              );
            })}
            {days.map((d, i) =>
              i % xStep === 0 ? (
                <text
                  key={"x" + d.date}
                  className="xlab"
                  x={(CH.padL + slot * i + slot / 2).toFixed(1)}
                  y={CH.H - 6}
                  textAnchor="middle"
                >
                  {d.label}
                </text>
              ) : null,
            )}
          </svg>
          <div className={"chart-tip" + (tip ? " show" : "")} style={tip ? { left: tip.x, top: tip.y } : undefined}>
            {tip && (
              <>
                <b>{fmt(tip.total)}</b> créd · {tip.label}
                <br />
                <span style={{ color: "var(--d-faint)" }}>
                  jogar {tip.ing} · perguntar {tip.ask}
                </span>
              </>
            )}
          </div>
        </div>
        <div className="uselegend cons-legend">
          <span className="li">
            <span className="sw" style={{ background: "var(--st-fact)" }} /> Jogar dentro
          </span>
          <span className="li">
            <span className="sw" style={{ background: "var(--accent)" }} /> Perguntar
          </span>
        </div>
        <div className="cons-tiles">
          <div className="ctile">
            <small>Consumido no período</small>
            <b className="num">{fmt(consumed)}</b>
            <span className="u">créd</span>
          </div>
          <div className="ctile">
            <small>Média por dia</small>
            <b className="num">{fmt(avgPerDay)}</b>
            <span className="u">créd</span>
          </div>
          <div className="ctile">
            <small>Ritmo do mês</small>
            <b className="num">{fmt(monthPace)}</b>
            <span className="u">créd</span>
          </div>
          <div className="ctile">
            <small>Maior dia</small>
            <b className="num">{fmt(maxDay)}</b>
            <span className="u">créd</span>
          </div>
        </div>
      </div>

      {/* HISTÓRICO */}
      <div className="sec-title">
        <h2>Histórico</h2>
        <p>Cada vez que você jogou algo, perguntou ou recarregou.</p>
        <a
          className="more"
          href="#export"
          onClick={(e) => {
            e.preventDefault();
            exportCsv();
          }}
        >
          Exportar CSV
        </a>
      </div>
      <div className="cons-card">
        <div className="lfilters">
          {(
            [
              ["all", "Tudo"],
              ["ing", "Jogar dentro"],
              ["ask", "Perguntar"],
              ["top", "Recargas"],
            ] as [LFilter, string][]
          ).map(([f, label]) => (
            <button key={f} className={"lchip" + (lfilter === f ? " on" : "")} onClick={() => setLfilter(f)}>
              {label}
            </button>
          ))}
        </div>
        {filteredEntries.length > 0 ? (
          <div className="ledger">
            {filteredEntries.map((e) => {
              const kind = entryKind(e);
              return (
                <div key={e.id} className="lrow">
                  <div className={"li " + kind}>
                    {kind === "ask" ? <IChat /> : kind === "top" ? <IPlus /> : <IDown />}
                  </div>
                  <div className="lmain">
                    <b>{entryLabel(e)}</b>
                    <small>{e.brain ?? "—"}</small>
                  </div>
                  <div className="ltime">{relTime(e.created_at)}</div>
                  <div className={"ldelta " + (e.delta > 0 ? "gain" : "spend")}>
                    {e.delta > 0 ? `+${fmt(e.delta)}` : `−${fmt(Math.abs(e.delta))}`}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="ledger-empty">
            <IClock />
            <b>{entries.length === 0 ? "Nada por aqui ainda" : "Nada neste filtro"}</b>
            <small>
              {entries.length === 0
                ? "Quando você jogar conteúdo, perguntar ou recarregar, aparece aqui."
                : "Tente outro filtro pra ver mais movimentos."}
            </small>
          </div>
        )}
        {reachedLimit && (
          <div className="lmore">
            <span className="lnote">Mostrando os {LEDGER_LIMIT} movimentos mais recentes.</span>
          </div>
        )}
      </div>

      {/* PLANS */}
      <div className="sec-title" id="planos">
        <h2>Escolha seu plano</h2>
        {/* M-PAY-H (auditoria gap #5): a copy do preço fundador só vale quando há vaga (founderRemaining>0
            = showFounder); senão é o preço padrão. Casa com confirmCheckout, que manda cohort 'founder'
            só com vaga, 'standard' caso contrário (o backend cobra standard). Não anunciar fundador sem vaga. */}
        <p>{showFounder ? "Preço de fundador, travado pra sempre. Cancela quando quiser." : "Cancela quando quiser. Sem fidelidade."}</p>
      </div>
      <div className="plans">
        {PLANS.map((p) => {
          const current = hasSub && subTier === p.id;
          return (
            <div key={p.id} className={"plan" + (p.pop ? " pop" : "")}>
              {p.badge && <div className="badge">{p.badge}</div>}
              <div className="pname">{p.name}</div>
              <div className="pfor">{p.forWhom}</div>
              {/* COM vaga fundador: preço padrão riscado (p.was) + preço fundador (p.now) + selo. SEM vaga:
                  só o preço PADRÃO (p.was) que é o que será cobrado — sem riscar nem prometer fundador. */}
              <div className="price">
                {showFounder && <span className="was num">{p.was}</span>}
                <div className="now">
                  <b>{showFounder ? p.now : p.was}</b>
                  <span>/mês</span>
                </div>
              </div>
              {showFounder && <div className="ptag">de fundador, pra sempre</div>}
              <ul className="specs">
                {p.specs.map((s, i) => (
                  <li key={i}>
                    <ICheck />
                    <span>
                      {s.lead ? <b>{s.lead}</b> : null}
                      {s.tail}
                    </span>
                  </li>
                ))}
              </ul>
              <div className="pcta">
                {current ? (
                  <button className="btn lg block" disabled>
                    Seu plano
                  </button>
                ) : (
                  <button
                    className={"btn lg block" + (p.pop ? " primary" : "")}
                    onClick={() => setConfirmPlan(p)}
                    disabled={busy === `tier-${p.id}`}
                  >
                    {/* Já tem assinatura noutro tier → trocar plano vai pro Customer Portal (proration),
                        não cria 2ª assinatura (auditoria R2). Sem assinatura → checkout normal. */}
                    {busy === `tier-${p.id}` ? "Redirecionando…" : hasSub ? `Trocar para ${p.name}` : `Assinar ${p.name}`}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Enterprise */}
      <div className="ent">
        <span className="ico">
          <IBuilding />
        </span>
        <div className="et">
          <b>Enterprise</b>
          <p>Cérebros ilimitados, ambiente dedicado, SLA e acordo de dados (DPA). Pra quando o negócio cresce.</p>
        </div>
        <div className="eprice">
          <div className="v">a partir de R$3.900</div>
          <small>sob medida</small>
        </div>
        <a className="btn" href="mailto:kelvin@kcggroup.com.br" style={{ marginLeft: 8 }}>
          Falar com a gente
        </a>
      </div>

      <p className="fineprint">
        Começa com <b>1.000 créditos grátis</b>, sem cartão · 1 crédito = <b>R$0,02</b> · paga no Pix ou cartão ·
        cancela quando quiser.
        <br />
        *Perguntar é ilimitado em quantidade; cada pergunta consome créditos conforme o uso.
      </p>

      {/* CREDIT PACKS */}
      <div className="sec-title" id="packs">
        <h2>Comprar créditos avulsos</h2>
        <p>Acabou no meio do mês? Recarregue sem mudar de plano. Não expiram.</p>
      </div>
      <div className="packs">
        {PACKS.map((pk) => (
          <div key={pk.id} className="pack">
            {pk.best && <span className="tag">melhor valor</span>}
            <div className="qty num">
              {pk.qty} <small>créditos</small>
            </div>
            <div className="pp">
              sai a <b>{pk.price}</b> · R$0,02 cada
            </div>
            <button
              className="btn block"
              onClick={() => void go(`topup-${pk.id}`, () => api.billing.topup(pk.id))}
              disabled={busy === `topup-${pk.id}`}
            >
              {busy === `topup-${pk.id}` ? "Redirecionando…" : "Comprar"}
            </button>
          </div>
        ))}
      </div>

      {/* BILLING */}
      <div className="sec-title">
        <h2>Pagamento e limites</h2>
      </div>
      <div className="bill-grid">
        {/* payment method */}
        <div className="bcard">
          <div className="bh">
            <ICard />
            <b>Forma de pagamento</b>
          </div>
          <div className="pay-empty">
            <span>Nenhuma forma de pagamento ainda.</span>
            <button
              className="btn"
              onClick={() => void go("portal", () => api.billing.portal())}
              disabled={busy === "portal"}
            >
              {busy === "portal" ? "Abrindo…" : "Adicionar"}
            </button>
          </div>
          <p style={{ margin: "13px 0 0", fontSize: 12, color: "var(--faint)" }}>
            Você só é cobrado quando assina. O teste é sem cartão.
          </p>
        </div>

        {/* spending cap */}
        <div className="bcard">
          <div className="bh">
            <ICap />
            <b>Teto de gasto</b>
          </div>
          <div className="cap-toggle">
            <div className="lab">
              <b>Limitar o gasto do mês</b>
              <small>Nunca passa do valor que você definir.</small>
            </div>
            <label className="switch">
              <input
                type="checkbox"
                checked={capEnabled}
                disabled={!cap}
                onChange={(e) => onToggleCap(e.target.checked)}
              />
              <span className="tr" />
            </label>
          </div>
          <div className={"capbody" + (capEnabled ? "" : " off")}>
            <div className="cap-field">
              <span className="pre">R$</span>
              <input
                type="number"
                min={0}
                step={50}
                value={capReaisInput}
                onChange={(e) => onCapReais(e.target.value)}
                onBlur={flushCap}
              />
              <span style={{ fontSize: 12.5, color: "var(--muted)" }}>por mês</span>
            </div>
            <div className="cap-check">
              <input
                id="killSwitch"
                type="checkbox"
                checked={capKill}
                disabled={!cap}
                onChange={(e) => onToggleKill(e.target.checked)}
              />
              <label htmlFor="killSwitch">
                <b>Desligar ao bater o teto.</b> O cérebro pausa de ler e perguntar até o próximo ciclo. Sem susto na
                fatura.
              </label>
            </div>
            <div className="capmeter">
              <div className="cl">
                <span>Gasto neste ciclo</span>
                <span>
                  <b>{fmtBRL(capSpentBRL)}</b> de <b>{fmtBRL(capLimitBRL)}</b>
                </span>
              </div>
              <div className="ct">
                <i style={{ width: `${capFillPct}%` }} />
              </div>
            </div>
          </div>
        </div>

        {/* M-PAY-H (Onda 4) — auto-recarga opt-in: recarrega o saldo sozinho quando cai do limiar. */}
        <div className="bcard">
          <div className="bh">
            <IPlus />
            <b>Auto-recarga</b>
          </div>
          <div className="cap-toggle">
            <div className="lab">
              <b>Recarregar sozinho ao acabar</b>
              <small>Compra o pacote escolhido quando o saldo baixa. Nunca para no meio.</small>
            </div>
            <label className="switch">
              <input
                type="checkbox"
                checked={prefs?.autorechargeEnabled ?? false}
                disabled={!prefs || busy === "autorecharge" || !(prefs?.hasPaymentMethod ?? false)}
                onChange={(e) => onToggleAutorecharge(e.target.checked)}
              />
              <span className="tr" />
            </label>
          </div>
          {!(prefs?.hasPaymentMethod ?? false) ? (
            <div className="ar-need">
              <IInfo /> Faça uma compra de créditos primeiro — assim guardamos sua forma de pagamento para a auto-recarga.
            </div>
          ) : (
            <div className={"capbody" + ((prefs?.autorechargeEnabled ?? false) ? "" : " off")}>
              <label className="ar-lab">Pacote a recarregar</label>
              <div className="ar-packs">
                {PACKS.map((pk) => (
                  <button
                    key={pk.id}
                    className={"ar-pack" + ((prefs?.autorechargePackage ?? "") === pk.id ? " on" : "")}
                    onClick={() => onAutorechargePackage(pk.id)}
                    disabled={busy === "autorecharge"}
                  >
                    {pk.qty} <small>créd · {pk.price}</small>
                  </button>
                ))}
              </div>
              <label className="ar-lab">Recarregar quando o saldo ficar abaixo de</label>
              <div className="cap-field">
                <input
                  type="number"
                  min={0}
                  step={100}
                  defaultValue={prefs?.autorechargeThresholdCredits ?? 0}
                  key={prefs?.autorechargeThresholdCredits ?? 0}
                  onBlur={(e) => onAutorechargeThreshold(e.target.value)}
                  disabled={busy === "autorecharge"}
                />
                <span style={{ fontSize: 12.5, color: "var(--muted)" }}>créditos</span>
              </div>
              {prefs?.needsAction && (
                <div className="ar-need">
                  <IInfo /> A última cobrança precisou de confirmação no banco (3-D Secure). Religue para autorizar de novo.
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* invoices */}
      <div className="sec-title">
        <h2>Faturas</h2>
      </div>
      <div className="bcard">
        <div className="inv-empty">
          <IInvoice />
          <b>Nenhuma fatura ainda</b>
          <small>Quando você assinar, suas faturas aparecem aqui pra baixar.</small>
        </div>
      </div>

      {/* CONFIRM SUBSCRIBE MODAL */}
      <Modal
        open={confirmPlan != null}
        onClose={() => setConfirmPlan(null)}
        title="Confirmar assinatura"
        width={430}
        footer={
          <>
            <button className="plano-modal-btn" onClick={() => setConfirmPlan(null)}>
              Agora não
            </button>
            <button className="plano-modal-btn primary" onClick={confirmCheckout}>
              Confirmar e assinar
            </button>
          </>
        }
      >
        {confirmPlan && (
          <div className="plano">
            <div className="modal-body">
              <h3 className="mtitle">Plano {confirmPlan.name}</h3>
              <p className="msub">Preço de fundador, travado enquanto sua conta estiver ativa.</p>
              <div className="sumrow">
                <span className="k">Plano</span>
                <span className="v">{confirmPlan.name}</span>
              </div>
              <div className="sumrow">
                <span className="k">Cobrança</span>
                <span className="v">mensal · Pix ou cartão</span>
              </div>
              <div className="sumrow total">
                <span className="k">Você paga</span>
                <span className="v">
                  <span className="was">{confirmPlan.was}</span>
                  {confirmPlan.now}/mês
                </span>
              </div>
              <div className="mfn">
                <ILock /> Sem fidelidade. Cancela quando quiser.
              </div>
            </div>
          </div>
        )}
      </Modal>

      {toast && (
        <div className="plano-toast">
          <Toast tone={toast.tone} onClose={() => setToast(null)}>
            {toast.msg}
          </Toast>
        </div>
      )}
    </div>
  );
}

/** Scroll suave até um id da própria página (substitui o smooth-scroll do protótipo). */
function scrollTo(e: React.MouseEvent, id: string) {
  e.preventDefault();
  const t = document.getElementById(id);
  if (t) t.scrollIntoView({ behavior: "smooth", block: "start" });
}

// ---------------------------------------------------------------------------
// CSS do design (docs/design-system/plano.html), ESCOPADO sob `.plano`. Só o conteúdo
// do `.main`-pra-baixo; chrome (topbar/sidebar/mnav/footer) foi DROPADO (vem do AppShell).
// Tokens exclusivos do protótipo no `.plano{}`; o resto reusa os globais do app.
// keyframes `pop` → `plano-pop` (anti-colisão). Toast/modal próprios do protótipo viraram
// componentes do app (Toast/Modal), com o miolo estilizado por classes escopadas.
// ---------------------------------------------------------------------------
const CSS = `
.plano{
  /* tokens exclusivos do protótipo (os demais vêm dos tokens globais do app) */
  --ink-2: oklch(21% 0.02 250);
  --d-fg: oklch(96% 0.01 240);
  --d-muted: oklch(74% 0.02 240);
  --d-faint: oklch(60% 0.02 240);
  --d-line: oklch(100% 0 0 / .09);
  --d-surface: oklch(100% 0 0 / .04);

  color:var(--fg);font-size:14px;line-height:1.5;
  max-width:1120px;width:100%;
}
.plano *{box-sizing:border-box}
.plano a{color:inherit;text-decoration:none}
.plano button{font-family:inherit;cursor:pointer}
.plano .num{font-family:var(--mono);font-variant-numeric:tabular-nums;font-feature-settings:"tnum"}
.plano input[type=checkbox]{width:15px;height:15px;accent-color:var(--accent);cursor:pointer}

.plano .page-head{display:flex;align-items:flex-end;gap:14px;margin-bottom:22px;flex-wrap:wrap}
.plano .page-head h1{font-size:22px;font-weight:600;letter-spacing:-.02em;margin:0}
.plano .page-head p{margin:3px 0 0;color:var(--muted);font-size:13.5px}
.plano .page-head .right{margin-left:auto;display:flex;gap:9px}

/* M-PAY-H — banner de graça (pagamento pendente, ainda em uso) */
.plano .grace-banner{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:20px;padding:13px 16px;
  border:1px solid var(--warn,#caa14a);border-radius:11px;background:color-mix(in srgb,var(--warn,#caa14a) 12%,transparent)}
.plano .grace-banner span{flex:1;min-width:240px;font-size:13.5px;color:var(--fg)}
.plano .grace-banner .btn{flex:none}

/* M-PAY-H — alerta de consumo + contagem regressiva do trial */
.plano .consume-banner,.plano .trial-banner{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:20px;
  padding:12px 16px;border:1px solid var(--border-strong);border-radius:11px;background:var(--surface)}
.plano .consume-banner svg,.plano .trial-banner svg{width:18px;height:18px;color:var(--faint);flex-shrink:0}
.plano .consume-banner span,.plano .trial-banner span{flex:1;min-width:240px;font-size:13.5px;color:var(--fg)}
.plano .consume-banner .btn,.plano .trial-banner .btn{flex:none}
.plano .consume-banner.hi{border-color:var(--warn,#caa14a);background:color-mix(in srgb,var(--warn,#caa14a) 12%,transparent)}
.plano .trial-banner.soon{border-color:var(--warn,#caa14a);background:color-mix(in srgb,var(--warn,#caa14a) 12%,transparent)}
.plano .trial-banner.over{border-color:var(--danger,#c0504a);background:color-mix(in srgb,var(--danger,#c0504a) 12%,transparent)}

/* M-PAY-H — auto-recarga */
.plano .ar-need{display:flex;align-items:flex-start;gap:8px;font-size:12.5px;color:var(--muted);line-height:1.4;
  padding:11px 13px;border:1px dashed var(--border-strong);border-radius:10px;margin-top:4px}
.plano .ar-need svg{width:15px;height:15px;color:var(--faint);flex-shrink:0;margin-top:1px}
.plano .ar-lab{display:block;font-size:12px;color:var(--muted);font-weight:600;margin:6px 0 8px}
.plano .ar-packs{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}
.plano .ar-pack{font-family:var(--mono);font-size:13px;font-weight:700;color:var(--fg);border:1px solid var(--border-strong);
  background:var(--surface);border-radius:9px;padding:8px 12px;transition:.14s}
.plano .ar-pack small{font-family:var(--font);font-size:11px;color:var(--faint);font-weight:500;margin-left:5px}
.plano .ar-pack:hover{border-color:var(--faint)}
.plano .ar-pack.on{border-color:var(--accent);background:var(--accent-soft);color:var(--accent-ink)}
.plano .ar-pack.on small{color:var(--accent-ink)}

.plano .btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;height:38px;padding:0 15px;border-radius:9px;
  border:1px solid var(--border-strong);background:var(--surface);font-weight:600;font-size:13px;color:var(--fg);transition:.15s}
.plano .btn:hover{background:var(--surface-2)}
.plano .btn svg{width:15px;height:15px}
.plano .btn.primary{background:var(--accent);border-color:var(--accent);color:#fff}
.plano .btn.primary:hover{background:var(--accent-ink)}
.plano .btn.block{width:100%}
.plano .btn.lg{height:44px;font-size:14px}
.plano .btn:disabled{opacity:.55;cursor:default;background:var(--surface-2)}
.plano .btn.primary:disabled{background:var(--surface-2);border-color:var(--border-strong);color:var(--fg)}

.plano .sec-title{display:flex;align-items:baseline;gap:12px;margin:36px 0 14px}
.plano .sec-title h2{font-size:16px;font-weight:600;margin:0;letter-spacing:-.01em}
.plano .sec-title p{margin:0;color:var(--faint);font-size:12.5px}
.plano .sec-title .more{margin-left:auto;font-size:12.5px;font-weight:600;color:var(--accent-ink)}

/* status row */
.plano .status-grid{display:grid;grid-template-columns:1.5fr 1fr;gap:16px;align-items:stretch}
.plano .scard{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:18px 20px}
.plano .scard .ch{display:flex;align-items:center;gap:8px;font-size:12.5px;font-weight:600;color:var(--muted)}
.plano .scard .ch svg{width:15px;height:15px;color:var(--faint)}

.plano .balance{display:flex;gap:22px;align-items:center;margin-top:10px}
.plano .ring{position:relative;width:124px;height:124px;flex-shrink:0}
.plano .ring svg{transform:rotate(-90deg)}
.plano .ring .center{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center}
.plano .ring .center b{font-family:var(--mono);font-size:29px;font-weight:700;letter-spacing:-.03em;line-height:1}
.plano .ring .center small{font-size:10.5px;color:var(--faint);margin-top:3px;font-weight:500}
.plano .balance .info{flex:1;min-width:0}
.plano .balance .info .big{display:flex;align-items:baseline;gap:8px}
.plano .balance .info .big b{font-family:var(--mono);font-size:22px;font-weight:700;letter-spacing:-.02em}
.plano .balance .info .big span{font-size:12.5px;color:var(--muted)}
.plano .usebar{display:flex;height:8px;border-radius:99px;overflow:hidden;margin:13px 0 11px;background:var(--surface-2);gap:2px}
.plano .usebar i{display:block;height:100%}
.plano .usebar i.ing{background:var(--st-fact)}
.plano .usebar i.ask{background:var(--accent)}
.plano .uselegend{display:flex;flex-wrap:wrap;gap:6px 16px;font-size:12px;color:var(--muted)}
.plano .uselegend .li{display:inline-flex;align-items:center;gap:7px}
.plano .uselegend .sw{width:9px;height:9px;border-radius:3px;flex-shrink:0}
.plano .uselegend .li .n{font-family:var(--mono);color:var(--fg);font-weight:600}
.plano .scard .note{margin-top:14px;padding-top:13px;border-top:1px solid var(--border);font-size:12px;color:var(--faint);
  display:flex;align-items:center;gap:7px}
.plano .scard .note svg{width:13px;height:13px;flex-shrink:0}

.plano .balance-empty{margin-top:14px}
.plano .balance-empty b{display:block;font-size:16px;font-weight:700;letter-spacing:-.01em}
.plano .balance-empty p{margin:5px 0 14px;font-size:13px;color:var(--muted)}

/* plan status card */
.plano .planstatus{display:flex;flex-direction:column;height:100%}
.plano .trial-pill{display:inline-flex;align-items:center;gap:7px;align-self:flex-start;font-family:var(--mono);font-size:11px;
  font-weight:600;color:var(--st-hypo);background:var(--st-hypo-soft);border:1px solid oklch(88% 0.05 75);
  border-radius:99px;padding:4px 11px;margin-top:10px}
.plano .trial-pill .d{width:7px;height:7px;border-radius:50%;background:var(--st-hypo)}
.plano .trial-pill.on{color:var(--accent-ink);background:var(--accent-soft);border-color:oklch(88% 0.04 150)}
.plano .trial-pill.on .d{background:var(--accent)}
.plano .planstatus h3{font-size:19px;font-weight:700;letter-spacing:-.02em;margin:13px 0 4px}
.plano .planstatus .desc{font-size:13px;color:var(--muted);margin:0 0 14px}
.plano .planstatus .ministat{display:flex;gap:0;border:1px solid var(--border);border-radius:10px;overflow:hidden;margin-bottom:16px}
.plano .planstatus .ministat .m{flex:1;padding:10px 12px;text-align:center}
.plano .planstatus .ministat .m+.m{border-left:1px solid var(--border)}
.plano .planstatus .ministat .m b{display:block;font-family:var(--mono);font-size:16px;font-weight:700}
.plano .planstatus .ministat .m small{font-size:10.5px;color:var(--faint)}
.plano .planstatus .cta{margin-top:auto;display:flex;flex-direction:column;gap:8px}

/* consumption */
.plano .cons-card{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:18px 20px}
.plano .cons-head{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:16px}
.plano .cons-head .ch{display:flex;align-items:center;gap:8px;font-size:12.5px;font-weight:600;color:var(--muted)}
.plano .cons-head .ch svg{width:15px;height:15px;color:var(--faint)}
.plano .seg{display:inline-flex;background:var(--surface-2);border:1px solid var(--border);border-radius:9px;padding:3px;gap:2px;margin-left:auto}
.plano .seg button{border:none;background:none;font-family:var(--mono);font-size:12px;font-weight:600;color:var(--muted);
  padding:6px 13px;border-radius:6px;transition:.14s}
.plano .seg button:hover{color:var(--fg)}
.plano .seg button.on{background:var(--surface);color:var(--fg);box-shadow:0 1px 2px oklch(0% 0 0 / .07)}
.plano .chart-wrap{position:relative}
.plano .chart{width:100%;height:auto;display:block;overflow:visible}
.plano .chart .grid{stroke:var(--border)}
.plano .chart .bar-ing{fill:var(--st-fact)}
.plano .chart .bar-ask{fill:var(--accent)}
.plano .chart .hit{cursor:default}
.plano .chart text.xlab{fill:var(--faint);font-family:var(--mono);font-size:9px}
.plano .chart-tip{position:absolute;pointer-events:none;background:var(--ink);color:var(--d-fg);border-radius:8px;
  padding:7px 10px;font-size:11.5px;line-height:1.4;opacity:0;transform:translate(-50%,-100%);transition:opacity .12s;
  white-space:nowrap;z-index:5;box-shadow:0 8px 22px oklch(0% 0 0 / .25)}
.plano .chart-tip.show{opacity:1}
.plano .chart-tip b{font-family:var(--mono);font-weight:700}
.plano .cons-legend{margin-top:12px}
.plano .cons-tiles{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-top:18px;padding-top:16px;border-top:1px solid var(--border)}
.plano .ctile{border:1px solid var(--border);border-radius:11px;padding:13px 14px;background:var(--surface-2)}
.plano .ctile small{font-size:11px;color:var(--faint);display:block;margin-bottom:6px}
.plano .ctile b{font-family:var(--mono);font-size:21px;font-weight:700;letter-spacing:-.02em}
.plano .ctile .u{font-size:11px;color:var(--muted);font-weight:500;margin-left:4px}

/* ledger */
.plano .lfilters{display:flex;gap:7px;flex-wrap:wrap;margin-bottom:8px}
.plano .lchip{font-family:var(--mono);font-size:11.5px;font-weight:600;color:var(--muted);border:1px solid var(--border-strong);
  background:var(--surface);border-radius:99px;padding:5px 12px;transition:.14s}
.plano .lchip:hover{color:var(--fg);border-color:var(--faint)}
.plano .lchip.on{background:var(--fg);color:var(--surface);border-color:var(--fg)}
.plano .ledger{display:flex;flex-direction:column}
.plano .lrow{display:flex;align-items:center;gap:13px;padding:12px 4px;border-bottom:1px solid var(--border)}
.plano .lrow:last-child{border-bottom:none}
.plano .lrow .li{width:34px;height:34px;border-radius:9px;display:grid;place-items:center;flex-shrink:0}
.plano .lrow .li svg{width:17px;height:17px}
.plano .li.ing{background:var(--st-fact-soft);color:var(--st-fact)}
.plano .li.ask{background:var(--accent-soft);color:var(--accent-ink)}
.plano .li.top{background:oklch(95% 0.05 60);color:oklch(48% 0.11 60)}
.plano .lrow .lmain{flex:1;min-width:0}
.plano .lrow .lmain b{font-weight:600;font-size:13.5px;display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.plano .lrow .lmain small{font-size:12px;color:var(--faint)}
.plano .lrow .ltime{font-family:var(--mono);font-size:11.5px;color:var(--faint);flex-shrink:0;text-align:right;white-space:nowrap}
.plano .lrow .ldelta{font-family:var(--mono);font-size:14px;font-weight:700;flex-shrink:0;min-width:62px;text-align:right}
.plano .ldelta.spend{color:var(--fg)}
.plano .ldelta.gain{color:var(--accent-ink)}
.plano .lmore{text-align:center;margin-top:10px}
.plano .lmore .lnote{font-size:12px;color:var(--faint)}
.plano .ledger-empty{display:flex;flex-direction:column;align-items:center;text-align:center;gap:6px;padding:30px 16px;color:var(--faint)}
.plano .ledger-empty svg{width:28px;height:28px;color:var(--border-strong)}
.plano .ledger-empty b{color:var(--muted);font-weight:600;font-size:13px}
.plano .ledger-empty small{font-size:12px}

/* founder strip */
.plano .founder{background:radial-gradient(440px 180px at 92% -40%, oklch(56% 0.15 150 / .18), transparent),var(--ink);
  color:var(--d-fg);border-radius:14px;padding:16px 20px;margin-top:16px;display:flex;align-items:center;gap:20px;
  overflow:hidden;position:relative}
.plano .founder .fglyph{width:40px;height:40px;border-radius:10px;background:oklch(100% 0 0 / .06);display:grid;place-items:center;flex-shrink:0}
.plano .founder .fglyph svg{width:50%;height:50%;color:var(--d-fg);opacity:.85}
.plano .founder .ftxt{flex:1;min-width:0}
.plano .founder .kick{display:inline-flex;align-items:center;gap:7px;font-family:var(--mono);font-size:10.5px;font-weight:600;
  letter-spacing:.08em;text-transform:uppercase;color:oklch(80% 0.12 150)}
.plano .founder .kick .d{width:6px;height:6px;border-radius:50%;background:var(--accent);box-shadow:0 0 8px var(--accent)}
.plano .founder h3{font-size:16px;font-weight:700;letter-spacing:-.02em;margin:5px 0 0}
.plano .founder .fcount{text-align:right;flex-shrink:0;min-width:150px}
.plano .founder .fcount .c{font-family:var(--mono);font-size:12px;color:var(--d-muted);margin-bottom:7px}
.plano .founder .fcount .c b{color:oklch(82% 0.12 150);font-weight:700}
.plano .fbar{height:6px;border-radius:99px;background:var(--d-surface);overflow:hidden}
.plano .fbar i{display:block;height:100%;border-radius:99px;background:linear-gradient(90deg,var(--accent),oklch(72% 0.13 160))}
.plano .founder .btn.dark{border:1px solid var(--d-line);color:var(--d-fg);background:oklch(100% 0 0 / .05);flex-shrink:0}
.plano .founder .btn.dark:hover{background:oklch(100% 0 0 / .1)}

/* plans */
.plano .plans{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;align-items:stretch}
.plano .plan{position:relative;background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:22px 20px;
  display:flex;flex-direction:column;transition:.18s}
.plano .plan:hover{border-color:var(--border-strong);box-shadow:var(--shadow)}
.plano .plan.pop{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent),0 18px 40px oklch(56% 0.15 150 / .12)}
.plano .plan .badge{position:absolute;top:-11px;left:50%;transform:translateX(-50%);font-family:var(--mono);font-size:10px;
  font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#fff;background:var(--accent);border-radius:99px;padding:5px 12px;white-space:nowrap}
.plano .plan .pname{font-size:15px;font-weight:700;letter-spacing:-.01em}
.plano .plan .pfor{font-size:12.5px;color:var(--muted);margin-top:2px}
.plano .plan .price{display:flex;align-items:flex-end;gap:9px;margin:16px 0 3px}
.plano .plan .price .was{font-family:var(--mono);font-size:15px;color:var(--faint);text-decoration:line-through;
  text-decoration-color:var(--border-strong);font-weight:500;padding-bottom:6px}
.plano .plan .price .now{display:flex;align-items:flex-end;gap:3px}
.plano .plan .price .now b{font-family:var(--mono);font-size:38px;font-weight:800;letter-spacing:-.03em;line-height:.85}
.plano .plan .price .now span{font-size:13px;color:var(--muted);font-weight:600;padding-bottom:5px}
.plano .plan .ptag{font-family:var(--mono);font-size:11px;color:var(--muted);background:var(--surface-2);
  border:1px solid var(--border);border-radius:6px;padding:3px 9px;align-self:flex-start;margin-bottom:16px}
.plano .plan.pop .ptag{color:var(--accent-ink);background:var(--accent-soft);border-color:transparent}
.plano .plan .specs{list-style:none;margin:0 0 18px;padding:16px 0 0;border-top:1px solid var(--border);
  display:flex;flex-direction:column;gap:11px;flex:1}
.plano .plan .specs li{display:flex;gap:10px;align-items:flex-start;font-size:13px;color:var(--fg);line-height:1.4}
.plano .plan .specs li svg{width:16px;height:16px;color:var(--accent-ink);flex-shrink:0;margin-top:1px}
.plano .plan .specs li b{font-weight:600}
.plano .plan .pcta{margin-top:auto}

/* enterprise strip */
.plano .ent{display:flex;align-items:center;gap:16px;background:var(--surface);border:1px solid var(--border);
  border-radius:14px;padding:16px 20px;margin-top:16px;flex-wrap:wrap}
.plano .ent .ico{width:38px;height:38px;border-radius:10px;background:var(--ink);display:grid;place-items:center;flex-shrink:0}
.plano .ent .ico svg{width:19px;height:19px;color:var(--d-fg)}
.plano .ent .et b{font-size:14px;font-weight:600}
.plano .ent .et p{margin:2px 0 0;font-size:12.5px;color:var(--muted)}
.plano .ent .eprice{margin-left:auto;text-align:right}
.plano .ent .eprice .v{font-family:var(--mono);font-size:14px;font-weight:600}
.plano .ent .eprice small{font-size:11px;color:var(--faint);display:block}

.plano .fineprint{margin:16px 0 0;font-family:var(--mono);font-size:11.5px;color:var(--faint);line-height:1.8}
.plano .fineprint b{color:var(--muted)}

/* credit packs */
.plano .packs{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}
.plano .pack{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:18px;position:relative;transition:.15s}
.plano .pack:hover{border-color:var(--border-strong);transform:translateY(-2px);box-shadow:var(--shadow)}
.plano .pack .tag{position:absolute;top:14px;right:14px;font-family:var(--mono);font-size:10px;font-weight:600;
  color:var(--accent-ink);background:var(--accent-soft);border-radius:5px;padding:2px 7px}
.plano .pack .qty{font-family:var(--mono);font-size:26px;font-weight:700;letter-spacing:-.02em}
.plano .pack .qty small{font-size:12px;color:var(--faint);font-weight:500;font-family:var(--font);margin-left:5px}
.plano .pack .pp{font-size:12.5px;color:var(--muted);margin:5px 0 14px}
.plano .pack .pp b{font-family:var(--mono);color:var(--fg);font-weight:600}

/* billing */
.plano .bill-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;align-items:start}
.plano .bcard{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:18px 20px}
.plano .bcard .bh{display:flex;align-items:center;gap:9px;margin-bottom:14px}
.plano .bcard .bh svg{width:16px;height:16px;color:var(--faint)}
.plano .bcard .bh b{font-size:14px;font-weight:600}
.plano .pay-empty{font-size:13px;color:var(--muted);display:flex;align-items:center;justify-content:space-between;gap:10px;
  padding:12px 14px;border:1px dashed var(--border-strong);border-radius:10px}

/* spending cap */
.plano .cap-toggle{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px}
.plano .cap-toggle .lab b{font-size:13.5px;font-weight:600;display:block}
.plano .cap-toggle .lab small{font-size:12px;color:var(--muted)}
.plano .switch{position:relative;width:42px;height:24px;flex-shrink:0}
.plano .switch input{position:absolute;opacity:0;width:100%;height:100%;margin:0;cursor:pointer}
.plano .switch .tr{position:absolute;inset:0;border-radius:99px;background:var(--border-strong);transition:.18s}
.plano .switch .tr::after{content:"";position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;background:#fff;
  box-shadow:0 1px 3px oklch(0% 0 0 / .25);transition:.18s}
.plano .switch input:checked+.tr{background:var(--accent)}
.plano .switch input:checked+.tr::after{transform:translateX(18px)}
.plano .capbody{border-top:1px solid var(--border);padding-top:14px}
.plano .capbody.off{opacity:.45;pointer-events:none}
.plano .cap-field{display:flex;align-items:center;gap:9px;margin-bottom:12px}
.plano .cap-field .pre{font-family:var(--mono);font-size:14px;color:var(--muted)}
.plano .cap-field input[type=number]{flex:1;height:38px;border:1px solid var(--border-strong);border-radius:9px;
  background:var(--surface-2);padding:0 12px;font-family:var(--mono);font-size:14px;color:var(--fg);width:auto}
.plano .cap-field input[type=number]:focus{outline:none;border-color:var(--accent);background:var(--surface)}
.plano .cap-check{display:flex;align-items:flex-start;gap:9px;font-size:12.5px;color:var(--muted);line-height:1.4}
.plano .cap-check label{cursor:pointer}
.plano .cap-check label b{color:var(--fg);font-weight:600}
.plano .capmeter{margin-top:14px;padding-top:14px;border-top:1px solid var(--border)}
.plano .capmeter .cl{display:flex;justify-content:space-between;font-size:12px;color:var(--muted);margin-bottom:7px}
.plano .capmeter .cl b{font-family:var(--mono);color:var(--fg);font-weight:600}
.plano .capmeter .ct{height:8px;border-radius:99px;background:var(--surface-2);overflow:hidden}
.plano .capmeter .ct i{display:block;height:100%;border-radius:99px;background:var(--accent)}

/* invoices */
.plano .inv-empty{display:flex;flex-direction:column;align-items:center;text-align:center;gap:6px;padding:30px 16px;color:var(--faint)}
.plano .inv-empty svg{width:30px;height:30px;color:var(--border-strong)}
.plano .inv-empty b{color:var(--muted);font-weight:600;font-size:13px}
.plano .inv-empty small{font-size:12px}

/* subscribe modal body (renderizado dentro do Modal do app) */
.plano .modal-body .mtitle{font-size:19px;font-weight:700;letter-spacing:-.02em;margin:0 0 4px}
.plano .modal-body .msub{margin:0 0 12px;font-size:13px;color:var(--muted)}
.plano .modal-body .sumrow{display:flex;align-items:center;justify-content:space-between;padding:9px 0;font-size:13.5px}
.plano .modal-body .sumrow+.sumrow{border-top:1px solid var(--border)}
.plano .modal-body .sumrow .k{color:var(--muted)}
.plano .modal-body .sumrow .v{font-weight:600}
.plano .modal-body .sumrow.total .v{font-family:var(--mono);font-size:18px;font-weight:800}
.plano .modal-body .sumrow .v .was{font-family:var(--mono);font-size:12px;color:var(--faint);text-decoration:line-through;margin-right:7px;font-weight:500}
.plano .modal-body .mfn{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--faint);margin-top:10px}
.plano .modal-body .mfn svg{width:14px;height:14px}
.plano-modal-btn{display:inline-flex;align-items:center;justify-content:center;height:40px;padding:0 18px;border-radius:9px;
  border:1px solid var(--border-strong);background:var(--surface);font-family:var(--font);font-weight:600;font-size:13px;
  color:var(--fg);cursor:pointer;transition:.15s}
.plano-modal-btn:hover{background:var(--surface-2)}
.plano-modal-btn.primary{background:var(--accent);border-color:var(--accent);color:#fff}
.plano-modal-btn.primary:hover{background:var(--accent-ink)}

/* toast wrapper (fixa o Toast do app no rodapé, como no protótipo) */
.plano-toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:90}

/* responsive (grids de conteúdo; chrome não existe aqui) */
@media(max-width:1080px){
  .plano .status-grid{grid-template-columns:1fr}
  .plano .plans{grid-template-columns:1fr;max-width:420px}
  .plano .plan.pop{order:-1}
  .plano .packs{grid-template-columns:1fr}
  .plano .bill-grid{grid-template-columns:1fr}
  .plano .cons-tiles{grid-template-columns:repeat(2,1fr)}
}
@media(max-width:560px){
  .plano .balance{flex-direction:column;align-items:flex-start;gap:14px}
  .plano .cons-tiles{grid-template-columns:repeat(2,1fr)}
  .plano .lrow .ltime{display:none}
}
@media (prefers-reduced-motion: reduce){.plano *{animation:none!important;transition:none!important}}
`;
