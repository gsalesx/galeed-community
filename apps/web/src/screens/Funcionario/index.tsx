/** M8 — Tela do FUNCIONÁRIO (/portal — chat escopado com RBAC restrito).
 *
 *  Fonte literal: docs/design-system/funcionario.html + _design/funcionario.md.
 *  É "a porta do funcionário": um principal com grant restrito (áreas + teto de
 *  sensibilidade) conversa com o cérebro e vê SÓ o que liberaram pra ele.
 *
 *  Diferenças vs a tela do dono (Perguntar):
 *   - topbar SLIM, SEM nav de admin (brand + bloco "who"); sem brain switcher/busca;
 *   - scopebar PERSISTENTE: "Você está vendo: <áreas> · até <nível>" (teto = Interno);
 *   - selo idêntico ao do dono, MAS `s-via` carimba a ÁREA aprovada (não vetor/grafo)
 *     e o nível "secret" NÃO aparece (teto Interno) → vira recusa;
 *   - estado crítico de RBAC: pergunta fora do acesso → SEM card + recusa honesta
 *     GENÉRICA que NUNCA nomeia a área oculta + nota "Respondi só com o que você pode ver";
 *   - foothint de privacidade: "Nada vaza por padrão".
 *
 *  Renderiza em shell slim (AppShell slim). Como o mockup tem topbar+scopebar+composer
 *  próprios (que diferem do shell de admin), a tela monta um layout full-viewport
 *  auto-contido (fixed) — só o conteúdo do chat, sem sidebar.
 *
 *  Dados: api.ask(q) (mesmo motor de Ask). O BFF aplica o RBAC do M7 ANTES da síntese:
 *  hits fora do escopo são descartados; se o assunto inteiro está fora → recusa genérica.
 *  Território EXCLUSIVO: screens/Funcionario/**. Não inventa dados; a recusa nunca
 *  revela o que está oculto.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Brand, Icon } from "../../ui";
import { useAuth } from "../../lib/auth";
import { api, type AskAnswer, type RetrieveHit, type Sensitivity } from "../../lib/api";

// ---------------------------------------------------------------------------
// Escopo do principal (grant restrito). Derivado do session quando possível;
// fallback = genérico "Você" sem escopo fictício (dados neutros).
// ---------------------------------------------------------------------------

interface Scope {
  nome: string;
  papel: string;
  iniciais: string;
  areas: string[];
  /** teto de sensibilidade do grant (nunca "restrito" nesta tela). */
  tetoLabel: string;
}

const SCOPE_FALLBACK: Scope = {
  nome: "Você",
  papel: "",
  iniciais: "V",
  areas: [],
  tetoLabel: "até Interno",
};

function iniciais(nome: string): string {
  const partes = nome.trim().split(/\s+/).filter(Boolean);
  if (partes.length === 0) return "?";
  if (partes.length === 1) return partes[0].slice(0, 2).toUpperCase();
  return (partes[0][0] + partes[partes.length - 1][0]).toUpperCase();
}

// ---------------------------------------------------------------------------
// Modelo de uma resposta renderizável (subconjunto do AskAnswer, mapeado ao card)
// ---------------------------------------------------------------------------

type StatusVis = "fact" | "hypo";
type LockVis = "open" | "int" | "conf"; // sem "secret": teto Interno

interface CardVM {
  status: StatusVis;
  statusLabel: string;
  lock: LockVis;
  lockLabel: string;
  conf: number; // 0..100
  confLabel: string; // "certeza 0,94"
  srcLabel: string; // "veio de uma call"
  srcIcon: "whatsapp" | "email" | "call" | "pdf" | "info";
  area: string; // .s-via — ÁREA aprovada (não vetor/grafo)
  quote: string;
  tags: string[];
  citeHref?: string;
}

interface AnswerVM {
  /** lead em texto puro (sem HTML); realces vêm via highlights. */
  lead: string;
  highlights: string[];
  card: CardVM | null;
  /** nota de "limitado por acesso" — GENÉRICA, nunca nomeia a área. */
  limited: string | null;
}

interface TurnVM {
  id: string;
  question: string;
  answer: AnswerVM | null; // null enquanto "pensando"
  error?: boolean;
}

// --- copy literal do mockup -----------------------------------------------

const REFUSAL_LIMITED =
  "Parte do contexto ficou de fora do seu acesso. Respondi só com o que você pode ver.";

const SUGGESTIONS = [
  "A política de reembolso mudou?",
  "Qual o salário do time de vendas?",
  "Quem é o contato principal na Acme?",
];

// ---------------------------------------------------------------------------
// Mapeamentos do shape da API → modelo visual do card
// ---------------------------------------------------------------------------

const STATUS_LABEL: Record<StatusVis, string> = { fact: "Fato", hypo: "Hipótese" };
const LOCK_LABEL: Record<LockVis, string> = { open: "Aberto", int: "Interno", conf: "Sigiloso" };

const SENS_TO_LOCK: Record<Sensitivity, LockVis | "secret"> = {
  publico: "open",
  interno: "int",
  sensivel: "conf",
  restrito: "secret",
};

function fmtCerteza(c: number | null | undefined): string {
  // pt-BR "0,94" — corpus pode não trazer certeza; nesse caso, sem rótulo
  if (typeof c !== "number" || Number.isNaN(c)) return "";
  const v = Math.max(0, Math.min(1, c));
  return `certeza ${v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function srcFrom(fonte: string): { icon: CardVM["srcIcon"]; label: string } {
  const f = (fonte || "").toLowerCase();
  if (f.includes("whats") || f.includes("wa")) return { icon: "whatsapp", label: "veio do WhatsApp" };
  if (f.includes("mail") || f.includes("@") || f.includes("e-mail")) return { icon: "email", label: "veio de e-mail" };
  if (f.includes("call") || f.includes("liga") || f.includes("tel") || f.includes("voz"))
    return { icon: "call", label: "veio de uma call" };
  if (f.includes("pdf") || f.includes("doc")) return { icon: "pdf", label: "veio de um documento" };
  return { icon: "info", label: fonte ? `veio de ${fonte}` : "fonte registrada" };
}

/** ÁREA aprovada (s-via): preferimos a área do hit; senão a 1ª área do escopo. */
function areaFrom(hit: RetrieveHit, scope: Scope): string {
  const t = (hit.type || "").trim();
  // se o tipo bate com uma área liberada, usa o rótulo dela
  const match = scope.areas.find((a) => a.toLowerCase() === t.toLowerCase());
  if (match) return match;
  // alguns BFFs mandam a área no próprio selo.via como texto (não vec/fts/grafo)
  const via = (hit.selo?.via || "").trim();
  const viaMatch = scope.areas.find((a) => a.toLowerCase() === via.toLowerCase());
  if (viaMatch) return viaMatch;
  return scope.areas[0] ?? "—";
}

/** Converte o 1º hit liberado em card; teto Interno → nunca exibe "secret". */
function hitToCard(hit: RetrieveHit, scope: Scope): CardVM {
  const selo = hit.selo ?? ({} as RetrieveHit["selo"]);
  const status: StatusVis = selo.status === "hipotese" ? "hypo" : "fact";
  const lvl = selo.sensitivity ? SENS_TO_LOCK[selo.sensitivity] : "int";
  const lock: LockVis = lvl === "secret" ? "conf" : lvl; // defensivo: nunca mostra secret
  const src = srcFrom(selo.fonte);
  const quote = (hit.excerpt || "").trim() || (selo.tipo || "").trim() || "";
  return {
    status,
    statusLabel: STATUS_LABEL[status],
    lock,
    lockLabel: LOCK_LABEL[lock],
    conf: typeof selo.confidence === "number" ? Math.round(Math.max(0, Math.min(1, selo.confidence)) * 100) : 0,
    confLabel: fmtCerteza(selo.confidence),
    srcLabel: src.label,
    srcIcon: src.icon,
    area: areaFrom(hit, scope),
    quote,
    tags: (selo.tags || []).slice(0, 4),
    citeHref: selo.cite || hit.slug ? `#${hit.slug}` : undefined,
  };
}

/** Mapeia o AskAnswer do motor → modelo da tela, aplicando a gramática de RBAC.
 *  - sem citações liberadas → recusa honesta GENÉRICA + nota limited (nunca nomeia área);
 *  - com citações → lead + 1 card (o funcionário recebe card único, não array). */
function answerToVM(ans: AskAnswer): AnswerVM {
  const cits = ans.citations ?? [];
  const limited = Boolean((ans.gaps && ans.gaps.length > 0) || ans.lowConfidence);

  if (cits.length === 0) {
    // assunto fora do acesso OU sem fontes: NÃO inventa, recusa honesta genérica.
    const lead =
      ans.answer?.trim() ||
      "Não consigo te responder isso: esse assunto está fora do seu acesso. Se precisar mesmo, fale com quem cuida do cérebro pra liberar.";
    return { lead, highlights: ans.highlights ?? [], card: null, limited: REFUSAL_LIMITED };
  }

  return {
    lead: ans.answer?.trim() || "Encontrei isto na sua área. Veja a fonte e o quanto dá pra confiar antes de usar.",
    highlights: ans.highlights ?? [],
    card: hitToCardSafe(cits[0]),
    limited: limited ? REFUSAL_LIMITED : null,
  };
}

// scope é injetado no momento da chamada (closure abaixo); helper estável
let _scope: Scope = SCOPE_FALLBACK;
function hitToCardSafe(hit: RetrieveHit): CardVM {
  return hitToCard(hit, _scope);
}

// ---------------------------------------------------------------------------
// Render do lead com realces (<b>) sem dangerouslySetInnerHTML
// ---------------------------------------------------------------------------

function renderHighlighted(text: string, highlights: string[]) {
  if (!text) return null;
  const terms = (highlights || []).map((h) => h.trim()).filter(Boolean);
  if (terms.length === 0) return text;
  // divide o texto preservando os termos realçados (case-insensitive)
  const escaped = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const re = new RegExp(`(${escaped.join("|")})`, "gi");
  const parts = text.split(re);
  return parts.map((p, i) =>
    terms.some((t) => t.toLowerCase() === p.toLowerCase()) ? (
      <b key={i} style={{ fontWeight: 600 }}>
        {p}
      </b>
    ) : (
      <span key={i}>{p}</span>
    ),
  );
}

// ===========================================================================
// Componente
// ===========================================================================

export default function Funcionario() {
  const { session } = useAuth();

  const scope = useMemo<Scope>(() => {
    const nome = session?.account?.name?.trim();
    if (!nome) return SCOPE_FALLBACK;
    return {
      nome,
      papel: SCOPE_FALLBACK.papel,
      iniciais: iniciais(nome),
      areas: SCOPE_FALLBACK.areas,
      tetoLabel: SCOPE_FALLBACK.tetoLabel,
    };
  }, [session]);

  // mantém o helper de mapeamento ciente do escopo corrente
  useEffect(() => {
    _scope = scope;
  }, [scope]);

  const brainSub = useMemo(() => {
    const b = session?.brains?.find((x) => x.id === session?.currentBrain);
    return b?.name ? `/ ${b.name}` : "/ acme";
  }, [session]);

  const [turns, setTurns] = useState<TurnVM[]>([]);
  const [draft, setDraft] = useState("");
  const [shownSuggestions, setShownSuggestions] = useState<string[]>(SUGGESTIONS);
  const [busy, setBusy] = useState(false);

  const chatRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const taId = useId();

  const scrollDown = useCallback(() => {
    requestAnimationFrame(() => {
      const el = chatRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }, []);

  const ask = useCallback(
    async (question: string, removeSuggestion?: string) => {
      const q = question.trim();
      if (!q || busy) return;
      if (removeSuggestion) setShownSuggestions((s) => s.filter((x) => x !== removeSuggestion));

      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      setTurns((t) => [...t, { id, question: q, answer: null }]);
      setBusy(true);
      scrollDown();

      try {
        const ans = await api.ask(q);
        const vm = answerToVM(ans);
        setTurns((t) => t.map((turn) => (turn.id === id ? { ...turn, answer: vm } : turn)));
      } catch {
        // falha de rede/erro: NÃO inventa. Recusa honesta genérica + nota limited.
        const vm: AnswerVM = {
          lead: "Não consegui buscar isso agora. Tente de novo daqui a pouco.",
          highlights: [],
          card: null,
          limited: null,
        };
        setTurns((t) => t.map((turn) => (turn.id === id ? { ...turn, answer: vm, error: true } : turn)));
      } finally {
        setBusy(false);
        scrollDown();
      }
    },
    [busy, scrollDown],
  );

  // autosize do textarea (max 120px)
  const autosize = useCallback(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, []);
  useEffect(autosize, [draft, autosize]);

  const submit = useCallback(() => {
    const v = draft.trim();
    if (!v) return;
    void ask(v);
    setDraft("");
  }, [draft, ask]);

  const canSend = draft.trim().length > 0 && !busy;

  return (
    <div style={S.root}>
      {/* SLIM TOP BAR — NO admin nav (this is the employee door) */}
      <header style={S.topbar}>
        <span style={S.brand}>
          <Brand size={27} withWordmark={false} />
          <b style={{ fontSize: 15, fontWeight: 600, letterSpacing: "-.01em" }}>Galeed</b>
          <span className="mono" style={{ fontSize: 11, color: "var(--faint)", marginLeft: 1 }}>
            {brainSub}
          </span>
        </span>
        <div style={S.who}>
          <div style={S.whoNm} className="who-nm">
            <b style={{ fontSize: 13, fontWeight: 600, display: "block", lineHeight: 1.25 }}>{scope.nome}</b>
            <small style={{ fontSize: 11, color: "var(--faint)" }}>{scope.papel}</small>
          </div>
          <div style={S.avatar} aria-hidden>
            {scope.iniciais}
          </div>
        </div>
      </header>

      {/* PERSISTENT SCOPE BANNER */}
      <div style={S.scopebar}>
        <span style={S.scopeIc} aria-hidden>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} width={15} height={15}>
            <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        </span>
        <span style={{ fontSize: 13, color: "var(--accent-ink)" }}>
          <b style={{ fontWeight: 600 }}>Você está vendo:</b>
        </span>
        <span style={{ display: "flex", gap: 6, marginLeft: 2, flexWrap: "wrap" }}>
          {scope.areas.map((a) => (
            <span key={a} style={S.areaChip} className="mono">
              {a}
            </span>
          ))}
        </span>
        <span style={S.lvl} className="mono scope-lvl">
          <Icon name="lock-closed" size={12} />
          {scope.tetoLabel}
        </span>
      </div>

      {/* CHAT */}
      <main style={S.chat} ref={chatRef}>
        <div style={S.hello}>
          <h1 style={S.helloH1}>Oi, {scope.nome.split(/\s+/)[0]}. O que você precisa saber?</h1>
          <p style={S.helloP}>
            Pergunte como você falaria com um colega. A resposta sempre vem com a fonte e o quanto dá pra confiar.
          </p>
        </div>

        {turns.map((turn) => (
          <Turn key={turn.id} turn={turn} />
        ))}
      </main>

      {/* COMPOSER */}
      <div style={S.composer}>
        <div style={S.composerInner}>
          {shownSuggestions.length > 0 && (
            <div style={S.suggest} className="suggest-row">
              {shownSuggestions.map((s) => (
                <button
                  key={s}
                  type="button"
                  style={S.sg}
                  className="sg-chip"
                  onClick={() => void ask(s, s)}
                  disabled={busy}
                >
                  {s}
                </button>
              ))}
            </div>
          )}
          <div style={S.box} className="composer-box">
            <textarea
              id={taId}
              ref={taRef}
              rows={1}
              placeholder="Escreva sua pergunta…"
              aria-label="Escreva sua pergunta"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
              style={S.textarea}
            />
            <button
              type="button"
              aria-label="Enviar pergunta"
              style={{ ...S.go, ...(canSend ? null : S.goDisabled) }}
              disabled={!canSend}
              onClick={submit}
            >
              <Icon name="arrow" size={18} />
            </button>
          </div>
          <div style={S.foothint}>
            <b style={{ color: "var(--muted)", fontWeight: 600 }}>Nada vaza por padrão.</b> Você só vê o que liberaram
            pra você.
          </div>
        </div>
      </div>

      <ScopedStyles />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Turno (pergunta + resposta / pensando)
// ---------------------------------------------------------------------------

function Turn({ turn }: { turn: TurnVM }) {
  return (
    <div style={S.turn} className="fn-turn">
      <div style={S.qBubble}>{turn.question}</div>
      <div style={S.aWrap}>
        <div style={S.aIc} aria-hidden>
          <Brand size={18} withWordmark={false} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          {turn.answer === null ? (
            <Thinking />
          ) : (
            <>
              <p style={S.aLead}>{renderHighlighted(turn.answer.lead, turn.answer.highlights)}</p>
              {turn.answer.card && <SealCard card={turn.answer.card} />}
              {turn.answer.limited && <LimitedNote text={turn.answer.limited} />}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** Estado "pensando": glyph girando + dots saltando (00-foundation §5.11). */
function Thinking() {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "4px 0 8px" }} aria-live="polite">
      <span style={{ display: "inline-flex", gap: 4 }} aria-hidden>
        <i style={{ ...S.dot, animationDelay: "0s" }} />
        <i style={{ ...S.dot, animationDelay: ".15s" }} />
        <i style={{ ...S.dot, animationDelay: ".3s" }} />
      </span>
      <span style={{ fontSize: 13, color: "var(--faint)" }}>Pensando…</span>
    </div>
  );
}

/** Card de citação (selo). Mesma gramática do dono; `s-via` = ÁREA aprovada;
 *  nível "secret" não existe nesta tela (teto Interno). */
function SealCard({ card }: { card: CardVM }) {
  const confLow = card.conf < 60;
  return (
    <article style={S.mcard}>
      <div style={S.seal}>
        <span style={{ ...S.sStatus, ...(card.status === "hypo" ? S.sStatusHypo : S.sStatusFact) }} className="mono">
          <span style={{ ...S.sDot, background: card.status === "hypo" ? "var(--st-hypo)" : "var(--st-fact)" }} />
          {card.statusLabel}
        </span>
        <span style={{ ...S.sLock, ...LOCK_STYLE[card.lock] }} className="mono">
          <Icon name="lock-closed" size={12} />
          {card.lockLabel}
        </span>
        {card.confLabel && (
          <span style={S.sConf}>
            <span style={S.confTrack}>
              <i
                style={{
                  display: "block",
                  height: "100%",
                  width: `${card.conf}%`,
                  background: confLow ? "var(--st-hypo)" : "var(--st-fact)",
                  borderRadius: 99,
                }}
              />
            </span>
            <span className="mono" style={{ fontSize: 11, color: confLow ? "oklch(48% 0.12 65)" : "var(--muted)" }}>
              {card.confLabel}
            </span>
          </span>
        )}
        <span style={S.sMeta}>
          <Icon name={card.srcIcon} size={13} style={{ color: "var(--faint)" }} />
          {card.srcLabel}
        </span>
        <span style={S.sVia} className="mono">
          {card.area}
        </span>
      </div>
      {card.quote && (
        <div style={{ padding: "13px 15px" }}>
          <p style={S.quote}>{card.quote}</p>
        </div>
      )}
      <div style={S.mfoot}>
        {card.tags.map((t) => (
          <span key={t} style={S.tag} className="mono">
            {t}
          </span>
        ))}
        <a href={card.citeHref ?? "#"} style={S.cite}>
          abrir fonte
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} width={13} height={13}>
            <path d="M7 17 17 7M9 7h8v8" />
          </svg>
        </a>
      </div>
    </article>
  );
}

/** Nota honesta de "limitado por acesso" — GENÉRICA, NUNCA nomeia a área oculta. */
function LimitedNote({ text }: { text: string }) {
  // texto da copy tem o 1º trecho em <b>; renderizamos a 1ª frase em negrito.
  const idx = text.indexOf(".");
  const head = idx >= 0 ? text.slice(0, idx + 1) : text;
  const tail = idx >= 0 ? text.slice(idx + 1) : "";
  return (
    <div style={S.limited}>
      <Icon name="lock-closed" size={15} style={{ color: "var(--sn-conf)", flexShrink: 0 }} />
      <span>
        <b style={{ color: "var(--fg)" }}>{head}</b>
        {tail}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Estilos (inline; tokens do design system). Hover/scroll via <ScopedStyles/>.
// ---------------------------------------------------------------------------

const LOCK_STYLE: Record<LockVis, React.CSSProperties> = {
  open: { color: "var(--sn-open)", background: "var(--sn-open-soft)" },
  int: { color: "var(--sn-int)", background: "var(--sn-int-soft)" },
  conf: { color: "var(--sn-conf)", background: "var(--sn-conf-soft)" },
};

const S: Record<string, React.CSSProperties> = {
  // layout full-viewport auto-contido (cobre o shell slim: topbar+scopebar+chat+composer próprios)
  root: {
    position: "fixed",
    inset: 0,
    zIndex: 50,
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
    background: "var(--bg)",
    color: "var(--fg)",
  },

  topbar: {
    display: "flex",
    alignItems: "center",
    gap: 14,
    height: 58,
    padding: "0 20px",
    background: "var(--surface)",
    borderBottom: "1px solid var(--border)",
    flexShrink: 0,
  },
  brand: { display: "flex", alignItems: "center", gap: 9, fontWeight: 600, letterSpacing: "-.01em" },
  who: { marginLeft: "auto", display: "flex", alignItems: "center", gap: 9 },
  whoNm: { textAlign: "right", lineHeight: 1.25 },
  avatar: {
    width: 34,
    height: 34,
    borderRadius: "50%",
    background: "linear-gradient(135deg,oklch(60% 0.13 250),oklch(56% 0.15 150))",
    display: "grid",
    placeItems: "center",
    color: "#fff",
    fontWeight: 600,
    fontSize: 12,
    flexShrink: 0,
  },

  scopebar: {
    display: "flex",
    alignItems: "center",
    gap: 11,
    flexWrap: "wrap",
    padding: "11px 20px",
    background: "var(--accent-soft)",
    borderBottom: "1px solid oklch(88% 0.04 150)",
    flexShrink: 0,
  },
  scopeIc: {
    width: 26,
    height: 26,
    borderRadius: 7,
    background: "var(--accent)",
    color: "#fff",
    display: "grid",
    placeItems: "center",
    flexShrink: 0,
  },
  areaChip: {
    fontSize: 11.5,
    fontWeight: 600,
    color: "var(--accent-ink)",
    background: "var(--surface)",
    border: "1px solid oklch(88% 0.04 150)",
    borderRadius: 6,
    padding: "2px 9px",
  },
  lvl: {
    marginLeft: "auto",
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    fontSize: 11.5,
    fontWeight: 600,
    color: "var(--sn-int)",
    background: "var(--sn-int-soft)",
    borderRadius: 6,
    padding: "3px 9px",
  },

  chat: {
    flex: 1,
    width: "100%",
    maxWidth: 760,
    margin: "0 auto",
    padding: "26px 20px 170px",
    display: "flex",
    flexDirection: "column",
    gap: 18,
    overflowY: "auto",
  },
  hello: { textAlign: "center", padding: "18px 10px 8px" },
  helloH1: { fontSize: 23, fontWeight: 600, letterSpacing: "-.02em", margin: "0 0 6px" },
  helloP: { margin: "0 auto", color: "var(--muted)", fontSize: 14, maxWidth: "46ch" },

  turn: { display: "flex", flexDirection: "column", gap: 11 },
  qBubble: {
    alignSelf: "flex-end",
    maxWidth: "80%",
    background: "var(--fg)",
    color: "#fff",
    borderRadius: "14px 14px 4px 14px",
    padding: "10px 15px",
    fontSize: 14,
    lineHeight: 1.45,
  },
  aWrap: { display: "flex", gap: 11, alignItems: "flex-start", maxWidth: "96%" },
  aIc: {
    width: 30,
    height: 30,
    borderRadius: 8,
    flexShrink: 0,
    background: "var(--surface)",
    border: "1px solid var(--border-strong)",
    display: "grid",
    placeItems: "center",
    marginTop: 2,
  },
  aLead: { fontSize: 14, lineHeight: 1.55, margin: "2px 0 12px" },

  dot: { width: 5, height: 5, borderRadius: "50%", background: "var(--st-reg, oklch(55% 0.16 285))", animation: "bounce 1.2s ease-in-out infinite" },

  // seal card
  mcard: {
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: 12,
    overflow: "hidden",
    boxShadow: "var(--shadow)",
    maxWidth: 560,
  },
  seal: {
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    gap: "7px 10px",
    padding: "10px 14px",
    borderBottom: "1px solid var(--border)",
    background: "var(--surface-2)",
  },
  sStatus: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: ".03em",
    textTransform: "uppercase",
    padding: "3px 9px",
    borderRadius: 6,
  },
  sStatusFact: { color: "var(--st-fact)", background: "var(--st-fact-soft)" },
  sStatusHypo: { color: "oklch(48% 0.12 65)", background: "var(--st-hypo-soft)" },
  sDot: { width: 7, height: 7, borderRadius: "50%" },
  sLock: {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    fontSize: 11,
    fontWeight: 600,
    padding: "3px 8px 3px 7px",
    borderRadius: 6,
    whiteSpace: "nowrap",
  },
  sConf: { display: "inline-flex", alignItems: "center", gap: 7 },
  confTrack: { width: 42, height: 5, borderRadius: 99, background: "var(--border)", overflow: "hidden" },
  sMeta: { display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11.5, color: "var(--muted)" },
  sVia: { marginLeft: "auto", fontSize: 11, color: "var(--faint)" },
  quote: { margin: 0, fontSize: 14.5, lineHeight: 1.55 },
  mfoot: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", padding: "0 15px 13px" },
  tag: {
    fontSize: 11,
    color: "var(--muted)",
    background: "var(--surface-2)",
    border: "1px solid var(--border)",
    borderRadius: 5,
    padding: "2px 7px",
  },
  cite: {
    marginLeft: "auto",
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    fontSize: 12.5,
    fontWeight: 600,
    color: "var(--accent-ink)",
  },

  // honest limited-by-access note
  limited: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    marginTop: 11,
    padding: "10px 14px",
    border: "1px solid var(--border)",
    borderLeft: "3px solid var(--sn-conf)",
    borderRadius: 9,
    background: "var(--surface)",
    fontSize: 12.5,
    color: "var(--muted)",
  },

  // composer
  composer: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 10,
    background: "linear-gradient(0deg,var(--bg) 72%,transparent)",
    padding: "14px 20px calc(16px + env(safe-area-inset-bottom))",
  },
  composerInner: { maxWidth: 760, margin: "0 auto" },
  suggest: { display: "flex", gap: 8, overflowX: "auto", paddingBottom: 11 },
  sg: {
    flexShrink: 0,
    fontSize: 12.5,
    color: "var(--fg)",
    background: "var(--surface)",
    border: "1px solid var(--border-strong)",
    borderRadius: 99,
    padding: "7px 13px",
    whiteSpace: "nowrap",
  },
  box: {
    display: "flex",
    alignItems: "flex-end",
    gap: 9,
    background: "var(--surface)",
    border: "1px solid var(--border-strong)",
    borderRadius: 14,
    padding: "8px 8px 8px 16px",
    boxShadow: "var(--shadow)",
  },
  textarea: {
    flex: 1,
    border: 0,
    outline: 0,
    resize: "none",
    fontFamily: "var(--font)",
    fontSize: 14.5,
    color: "var(--fg)",
    background: "transparent",
    maxHeight: 120,
    lineHeight: 1.45,
    padding: "5px 0",
  },
  go: {
    width: 38,
    height: 38,
    borderRadius: 10,
    border: 0,
    background: "var(--accent)",
    color: "#fff",
    display: "grid",
    placeItems: "center",
    flexShrink: 0,
    cursor: "pointer",
  },
  goDisabled: { background: "var(--border-strong)", cursor: "default" },
  foothint: { textAlign: "center", fontSize: 11.5, color: "var(--faint)", marginTop: 9 },
};

/** CSS escopado: hovers, scrollbar oculta, animação dos turns, responsivo <620px.
 *  (Inline style não cobre :hover/@media; injetamos só o que o mockup precisa.) */
function ScopedStyles() {
  return (
    <style>{`
      .suggest-row::-webkit-scrollbar{display:none}
      .suggest-row{scrollbar-width:none}
      .sg-chip:hover:not(:disabled){border-color:var(--accent);color:var(--accent-ink);background:var(--accent-soft)}
      .composer-box:focus-within{border-color:var(--accent)}
      @media(prefers-reduced-motion:no-preference){
        .fn-turn{animation:rise .28s ease both}
        @keyframes rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
      }
      @media(max-width:620px){
        .who-nm{display:none!important}
        .scope-lvl{margin-left:0!important}
      }
    `}</style>
  );
}
