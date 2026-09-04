/** M21/S6 — "Criar um cérebro" (/criar-cerebro): chat guiado de 4 passos + painel
 *  "o cérebro se montando" — fiel a docs/design-system/criar-cerebro.html (Tier 1).
 *
 *  O FRONT É BURRO: passo, perguntas, chips e painel vêm TODOS do `WizardTurn` que o
 *  back S4 devolve (`api.wizard.start/reply/confirm`); o `draft` dentro de `state` é
 *  OPACO e viaja de volta intacto. Zero roteiro aqui. O usuário NUNCA vê JSON.
 *
 *  Tela SEM AppShell (topbar própria com o stepper, como no mockup) — a rota
 *  `/criar-cerebro` dentro de RequireAuth é ZONA NEUTRA (pendência no ARTIFACTS).
 *  Exige só SESSÃO, não brain — é o ONBOARDING: conta recém-criada cai direto aqui
 *  (/comecar redireciona pra cá; o wizard antigo de 4 telas foi aposentado).
 *
 *  Fechamento (BRIEF §4): no step "review" o cartão legível vira bolha IA + chip
 *  "Criar o cérebro 🪨" → confirm. Sucesso → painel mostra o done-card com os 2 CTAs;
 *  a troca pro brain novo reusa o MESMO mecanismo do BrainSwitcher (auth.refresh()
 *  pra recarregar me() + switchBrain(id) do contexto — nada de estado novo).
 *
 *  Erros: bolha IA com a mensagem legível do BFF + chip "Tentar de novo" (reenvia a
 *  última mensagem); 409 no confirm → bolha pedindo outro nome e o input volta ao
 *  composer. O chat nunca trava (anti-loop é do back; aqui só renderizamos).
 */
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, ApiError } from "../../lib/api";
import { useAuth, useBrain } from "../../lib/auth";
import { Chat, type ChatTurn } from "./Chat";
import { Panel } from "./Panel";
import type { WizardStep, WizardTurn } from "./types";

const LOGO_SRC = "/galeed-logo.png";

/** chips sintéticos da TELA (afford do confirm e do retry — não são roteiro). */
const CONFIRM_CHIP = "Criar o cérebro 🪨";
const RETRY_CHIP = "Tentar de novo";

/** stepper: purpose=0 · areas=1 · sources=2 · sensitivity=3 · review/done=4 (DESIGN-SPEC §2). */
const STEP_INDEX: Record<WizardStep, number> = {
  purpose: 0,
  areas: 1,
  sources: 2,
  sensitivity: 3,
  review: 4,
  done: 4,
};

/** typing dots ficam visíveis no mínimo ~650ms antes de revelar (mockup). */
const MIN_TYPING_MS = 650;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function holdTyping(t0: number): Promise<void> {
  const rest = MIN_TYPING_MS - (Date.now() - t0);
  if (rest > 0) await sleep(rest);
}

/** mensagem legível de erro — NUNCA JSON na bolha (M11/ADR-005-d). */
function legible(e: unknown, fallback: string): string {
  if (e instanceof ApiError && e.message && !e.message.trim().startsWith("{")) return e.message;
  return fallback;
}

export default function CriarCerebro() {
  const navigate = useNavigate();
  const { refresh } = useAuth();
  const { brains, switchBrain } = useBrain();

  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [current, setCurrent] = useState<WizardTurn | null>(null);
  const [typing, setTyping] = useState(false);
  const [sending, setSending] = useState(false);
  const [created, setCreated] = useState<{ id: string; name: string } | null>(null);
  const [retry, setRetry] = useState(false); // erro de turno → chip "Tentar de novo"
  const [focusToken, setFocusToken] = useState(0); // 409 no confirm → foca o composer
  const lastMsg = useRef("");
  const startedRef = useRef(false);

  const pushAi = (text: string) => setTurns((ts) => [...ts, { who: "ai", text }]);
  const pushMe = (text: string) => setTurns((ts) => [...ts, { who: "me", text }]);

  // mount: bolha inicial do back (api.wizard.start)
  useEffect(() => {
    if (startedRef.current) return; // StrictMode re-mount: não duplica o start
    startedRef.current = true;
    void boot();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function boot() {
    setSending(true);
    setTyping(true);
    const t0 = Date.now();
    try {
      const turn = await api.wizard.start();
      await holdTyping(t0);
      setTyping(false);
      pushAi(turn.question || turn.card);
      setCurrent(turn);
    } catch (e) {
      await holdTyping(t0);
      setTyping(false);
      pushAi(legible(e, "Não consegui começar agora."));
      setRetry(true);
    } finally {
      setSending(false);
    }
  }

  /** envia a mensagem pro back e revela a resposta (sem bolha "me" — quem empilha é o caller).
   *  `action` (fix-2): 'toggle'/'go' nos chips ricos do passo `sources`. Toggle NÃO mostra bolha
   *  de IA (só re-renderiza chips/painel); 'go' e texto livre revelam a resposta normalmente. */
  async function deliver(message: string, action?: "toggle" | "go") {
    if (!current) return;
    setSending(true);
    setTyping(action ? false : true); // toggle é instantâneo: sem typing dots
    const t0 = Date.now();
    try {
      const turn = await api.wizard.reply(current.state, message, action);
      if (action !== "toggle") await holdTyping(t0);
      setTyping(false);
      if (action !== "toggle") pushAi(turn.question || turn.card);
      setCurrent(turn);
    } catch (e) {
      await holdTyping(t0);
      setTyping(false);
      pushAi(legible(e, "Não consegui processar agora."));
      setRetry(true);
    } finally {
      setSending(false);
    }
  }

  async function confirm() {
    if (!current || sending) return;
    pushMe(CONFIRM_CHIP);
    setSending(true);
    setTyping(true);
    const t0 = Date.now();
    try {
      const r = await api.wizard.confirm(current.state);
      await holdTyping(t0);
      setTyping(false);
      setCreated(r.brain);
    } catch (e) {
      await holdTyping(t0);
      setTyping(false);
      // 409 (nome já existe) ou outro erro: mensagem legível; o chat segue vivo e o
      // input volta ao composer pra escrever outro nome.
      pushAi(legible(e, "Não consegui criar agora."));
      setFocusToken((t) => t + 1);
    } finally {
      setSending(false);
    }
  }

  /** roteia o clique/Enter: retry → reenvia; chip de confirmar no review → confirm; chip toggle/go
   *  do passo `sources` → reply com action; resto (texto livre) → reply normal. */
  function onSend(message: string, action?: "toggle" | "go") {
    if (sending || created) return;
    if (retry && message === RETRY_CHIP) {
      setRetry(false);
      if (!current) void boot();
      else void deliver(lastMsg.current);
      return;
    }
    if (current?.state.step === "review" && message === CONFIRM_CHIP) {
      void confirm();
      return;
    }
    if (!current) return;
    setRetry(false);
    // chip toggle: não empilha bolha "me" (é só marcar/desmarcar); 'go' e texto livre, sim.
    if (action !== "toggle") {
      pushMe(message);
      lastMsg.current = message;
    }
    void deliver(message, action);
  }

  /** pós-criação: recarrega a sessão (me()) e troca pro brain novo — MESMO mecanismo
   *  do BrainSwitcher (switchBrain do auth context) — e só então navega. */
  async function goAfterCreate(path: string) {
    if (!created) return;
    try {
      await refresh();
    } catch {
      /* sessão segue a local; switchBrain valida contra ela */
    }
    switchBrain(created.id);
    navigate(path);
  }

  const stepIndex = created ? 4 : current ? STEP_INDEX[current.state.step] : 0;
  // Sem nenhum cérebro este wizard É o onboarding — não existe console pra onde "sair".
  const exitTo = brains.length === 0 ? null : "/app";

  const suggestions = created
    ? []
    : retry
      ? [RETRY_CHIP]
      : current?.state.step === "review"
        ? [CONFIRM_CHIP]
        : (current?.suggestions ?? []);

  // chips RICOS (toggle/go) só aparecem no passo de coleção `sources`, e não durante retry/confirm.
  const chips =
    created || retry || current?.state.step === "review" ? [] : (current?.chips ?? []);

  return (
    <div className="cwz">
      <style>{CSS}</style>

      <header className="topbar">
        <Link className="brand" to={exitTo ?? "/criar-cerebro"}>
          <span className="glyph">
            <img src={LOGO_SRC} alt="Galeed" />
          </span>
          <b>Galeed</b>
          <span className="sub">novo cérebro</span>
        </Link>
        <div className="steps" aria-label={`passo ${Math.min(stepIndex + 1, 4)} de 4`}>
          {[1, 2, 3, 4].map((n, i) => (
            <span key={n} style={{ display: "contents" }}>
              {i > 0 && <span className="ln" />}
              <span
                className={"o" + (i === stepIndex ? " on" : i < stepIndex ? " done" : "")}
                aria-current={i === stepIndex ? "step" : undefined}
              >
                {n}
              </span>
            </span>
          ))}
        </div>
        {exitTo && (
          <Link className="close" to={exitTo}>
            Sair sem criar
          </Link>
        )}
      </header>

      <div className="wrap">
        <Chat
          turns={turns}
          typing={typing}
          suggestions={suggestions}
          chips={chips}
          onSend={onSend}
          disabled={sending || !!created}
          focusToken={focusToken}
        />
        <Panel
          panel={current?.panel ?? null}
          created={created}
          onGoFontes={() => void goAfterCreate("/app/fontes")}
          onGoAdicionar={() => void goAfterCreate("/app/adicionar")}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// CSS do mockup, escopado em .cwz (valores LITERAIS de criar-cerebro.html; só os
// keyframes ganham prefixo cwz- pra não colidir com a fundação). base.css já cobre
// prefers-reduced-motion globalmente; o guard do mockup é repetido por segurança.
// ---------------------------------------------------------------------------

const CSS = `
.cwz{min-height:100vh;display:flex;flex-direction:column;background:var(--bg);color:var(--fg);font-size:14px;line-height:1.5}
.cwz a{color:inherit;text-decoration:none}
.cwz button{font-family:inherit;cursor:pointer}

/* ---- slim top bar (focused flow, no admin nav) ---- */
.cwz .topbar{display:flex;align-items:center;gap:14px;height:58px;padding:0 20px;background:var(--surface);
  border-bottom:1px solid var(--border);position:sticky;top:0;z-index:30}
.cwz .brand{display:flex;align-items:center;gap:9px;font-weight:600;letter-spacing:-.01em}
.cwz .brand .glyph{width:27px;height:27px;border-radius:7px;display:grid;place-items:center;background:var(--fg)}
.cwz .brand .glyph img{width:100%;height:100%;object-fit:contain;padding:15%;filter:brightness(0) invert(1)}
.cwz .brand b{font-size:15px}
.cwz .brand .sub{font-size:11px;color:var(--faint);font-family:var(--mono);margin-left:1px}
.cwz .steps{margin:0 auto;display:flex;align-items:center;gap:7px}
.cwz .steps .o{width:22px;height:22px;border-radius:50%;border:1.5px solid var(--border-strong);display:grid;place-items:center;
  font-family:var(--mono);font-size:10px;color:var(--faint);background:var(--surface);transition:.2s}
.cwz .steps .o.on{background:var(--accent);border-color:var(--accent);color:#fff}
.cwz .steps .o.done{background:var(--accent-soft);border-color:var(--accent);color:var(--accent-ink)}
.cwz .steps .ln{width:18px;height:1.5px;background:var(--border-strong)}
.cwz .close{margin-left:auto;font-size:12.5px;font-weight:600;color:var(--muted);border:1px solid var(--border);
  border-radius:8px;padding:7px 12px;background:var(--surface)}
.cwz .close:hover{background:var(--surface-2);color:var(--fg)}

/* ---- layout: chat | painel ---- */
.cwz .wrap{flex:1;display:grid;grid-template-columns:1fr 372px;gap:0;max-width:1180px;margin:0 auto;width:100%}

/* chat */
.cwz .chatcol{display:flex;flex-direction:column;min-height:calc(100vh - 58px);border-right:1px solid var(--border)}
.cwz .chat{flex:1;padding:28px 28px 16px;display:flex;flex-direction:column;gap:16px;overflow:auto}
.cwz .turn{display:flex;gap:11px;align-items:flex-start;max-width:94%;animation:cwz-rise .25s ease both}
.cwz .turn.me{align-self:flex-end;max-width:80%}
.cwz .a-ic{width:30px;height:30px;border-radius:8px;flex-shrink:0;background:var(--surface);border:1px solid var(--border-strong);
  display:grid;place-items:center;margin-top:2px}
.cwz .a-ic img{width:17px;height:17px;object-fit:contain}
.cwz .bubble{background:var(--surface);border:1px solid var(--border);border-radius:4px 14px 14px 14px;padding:12px 15px;
  font-size:14px;line-height:1.55;box-shadow:var(--shadow)}
.cwz .bubble b{font-weight:600}
.cwz .turn.me .bubble{background:var(--fg);color:#fff;border:none;border-radius:14px 14px 4px 14px}
@keyframes cwz-rise{from{opacity:0;transform:translateY(7px)}to{opacity:1;transform:none}}

/* typing dots */
.cwz .typing{display:inline-flex;gap:4px;padding:4px 2px}
.cwz .typing i{width:6px;height:6px;border-radius:50%;background:var(--faint);animation:cwz-blink 1.2s infinite}
.cwz .typing i:nth-child(2){animation-delay:.2s}
.cwz .typing i:nth-child(3){animation-delay:.4s}
@keyframes cwz-blink{0%,80%,100%{opacity:.25}40%{opacity:1}}

/* suggestion chips */
.cwz .sugs{display:flex;gap:8px;flex-wrap:wrap;padding:0 28px 12px;margin-left:41px}
.cwz .sug{border:1px solid var(--border-strong);background:var(--surface);border-radius:99px;padding:7px 14px;
  font-size:13px;font-weight:500;color:var(--fg);transition:.15s}
.cwz .sug:hover{border-color:var(--accent);color:var(--accent-ink);background:var(--accent-soft)}
.cwz .sug.go{background:var(--accent-soft);border-color:var(--accent);color:var(--accent-ink);font-weight:600}
.cwz .sug.sel{background:var(--accent);border-color:var(--accent);color:#fff}
.cwz .sug.sel:hover{background:var(--accent);color:#fff}

/* composer */
.cwz .composer{padding:14px 28px 20px;border-top:1px solid var(--border);background:var(--surface)}
.cwz .cbox{display:flex;gap:9px;align-items:flex-end;border:1px solid var(--border-strong);border-radius:12px;
  background:var(--bg);padding:9px 9px 9px 14px}
.cwz .cbox:focus-within{border-color:var(--accent)}
.cwz .cbox textarea{flex:1;border:none;background:none;resize:none;font-family:var(--font);font-size:14px;color:var(--fg);
  line-height:1.5;max-height:110px;outline:none;padding:4px 0}
.cwz .send{width:36px;height:36px;border-radius:9px;border:none;background:var(--accent);color:#fff;display:grid;place-items:center;flex-shrink:0}
.cwz .send:hover{background:var(--accent-ink)}
.cwz .send:disabled{opacity:.55;cursor:not-allowed}
.cwz .send svg{width:16px;height:16px}
.cwz .composer small{display:block;margin-top:8px;font-size:11.5px;color:var(--faint)}

/* ---- right panel: o cérebro se montando ---- */
.cwz .panel{padding:24px 22px 30px;background:var(--surface-2);overflow:auto;position:sticky;top:58px;height:calc(100vh - 58px)}
.cwz .panel .ph{display:flex;align-items:center;gap:10px;margin-bottom:18px}
.cwz .panel .ph .core{width:38px;height:38px;border-radius:10px;background:var(--surface);border:1px solid var(--border-strong);
  display:grid;place-items:center;position:relative}
.cwz .panel .ph .core img{width:21px;height:21px;object-fit:contain}
.cwz .panel .ph .core::after{content:"";position:absolute;inset:-5px;border-radius:13px;border:1.5px solid var(--accent);
  opacity:.5;animation:cwz-echo 2.4s infinite}
@keyframes cwz-echo{0%{transform:scale(.85);opacity:.5}100%{transform:scale(1.18);opacity:0}}
.cwz .panel .ph b{font-size:14.5px;display:block}
.cwz .panel .ph small{font-size:11px;color:var(--faint);font-family:var(--mono)}
.cwz .pgroup{margin-bottom:16px}
.cwz .pgroup .pl{font-size:10.5px;text-transform:uppercase;letter-spacing:.07em;font-weight:600;color:var(--faint);margin-bottom:8px;
  display:flex;align-items:center;gap:7px}
.cwz .pgroup .pl .ok{color:var(--accent-ink)}
.cwz .pcard{background:var(--surface);border:1px solid var(--border);border-radius:11px;padding:12px 13px;font-size:13px}
.cwz .pcard.empty{border-style:dashed;color:var(--faint);font-size:12.5px;background:none}
.cwz .pcard b{font-weight:600}
.cwz .pmono{font-family:var(--mono);font-size:11px;color:var(--faint)}
.cwz .achips{display:flex;gap:6px;flex-wrap:wrap}
.cwz .achip{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;font-weight:500;background:var(--surface);
  border:1px solid var(--border-strong);border-radius:8px;padding:5px 11px;animation:cwz-pop .3s ease both}
.cwz .achip .d{width:7px;height:7px;border-radius:50%;background:var(--accent)}
@keyframes cwz-pop{from{opacity:0;transform:scale(.8)}to{opacity:1;transform:scale(1)}}
.cwz .fline{display:flex;align-items:flex-start;gap:9px;padding:8px 0;border-bottom:1px dashed var(--border);animation:cwz-pop .3s ease both}
.cwz .fline:last-child{border-bottom:none}
.cwz .fline svg{width:15px;height:15px;color:var(--accent-ink);flex-shrink:0;margin-top:2px}
.cwz .fline b{font-size:12.5px;display:block}
.cwz .fline small{font-size:11px;color:var(--muted);display:block;line-height:1.4}
.cwz .fline .pmono{font-size:10px;color:var(--accent-ink)}
.cwz .pmono.accent{font-size:10px;color:var(--accent-ink)}
.cwz .ruleline{display:flex;gap:8px;align-items:flex-start;font-size:12px;color:var(--muted);padding:7px 0;animation:cwz-pop .3s ease both}
.cwz .ruleline svg{width:13px;height:13px;flex-shrink:0;margin-top:2.5px;color:var(--sn-conf)}
.cwz .ruleline b{color:var(--fg)}

/* final summary */
.cwz .done-card{background:var(--surface);border:1px solid oklch(88% 0.04 150);border-radius:13px;padding:16px;box-shadow:var(--shadow)}
.cwz .done-card .dt{display:flex;align-items:center;gap:9px;font-weight:600;font-size:14px;color:var(--accent-ink);margin-bottom:9px}
.cwz .done-card .dt svg{width:17px;height:17px}
.cwz .done-card p{margin:0 0 12px;font-size:12.5px;color:var(--muted);line-height:1.5}
.cwz .done-card .cta{display:flex;flex-direction:column;gap:8px}

/* responsive */
@media(max-width:980px){
  .cwz .wrap{grid-template-columns:1fr}
  .cwz .chatcol{border-right:none;min-height:0}
  .cwz .panel{position:static;height:auto;border-top:1px solid var(--border)}
}
@media(max-width:560px){
  .cwz .chat{padding:20px 16px 12px}
  .cwz .sugs{padding:0 16px 12px;margin-left:0}
  .cwz .composer{padding:12px 16px 16px}
  .cwz .panel{padding:20px 16px 26px}
  .cwz .steps .ln{width:10px}
}
@media (prefers-reduced-motion: reduce){
  .cwz *,.cwz *::before,.cwz *::after{animation:none!important;transition:none!important}
}
`;
