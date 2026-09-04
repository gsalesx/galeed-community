/** M8 — Perguntar (Ask). Q&A sintetizado por LLM sobre o cérebro (tela "cara").
 *  Layout = chat multi-turn (coluna central max 780px): hero fixo no topo, turnos
 *  (pergunta = bolha escura à direita; resposta = lead sintetizado + "De onde veio" +
 *  citações com Seal completo + "o que mudou no tempo" + follows) e composer sticky.
 *
 *  Dados: api.ask(q) (BFF /api/ask, LLM/caro). Estado "pensando" = Loading "Lendo a memória".
 *  Sem fontes → resposta honesta "não encontrei" (não inventa). Baixa confiança → aviso âmbar.
 *  Hipótese nunca vira fato (o Seal carrega a cor categórica).
 *  Spec literal: specs/slots/M8/_design/perguntar.md + 00-foundation.md. */
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Seal, Loading, Button, Icon, Brand, Markdown } from "../../ui";
import { useBrain } from "../../lib/auth";
import { api, type AskAnswer, type RetrieveHit } from "../../lib/api";

// --- copy real (perguntar.md §1, §6, §7, §10) ---
const EYEBROW = "Perguntar ao cérebro";
const SUB =
  "Escreva como você falaria com uma pessoa do time. O cérebro junta tudo que sabe e responde com a fonte, o quanto dá pra confiar e o que mudou no tempo.";
const FOOTHINT_STRONG = "Toda resposta vem com a fonte.";
const FOOTHINT_REST = " Você vê tudo deste cérebro, inclusive o que é sigiloso.";
const THINKING_LABEL = "Lendo a memória";
const SRC_LABEL = "De onde veio";

/** Starters (chips no topo do composer; somem ao usar) — espectro completo, não só número. */
const STARTERS = [
  "O que decidimos recentemente e por quê?",
  "Quais compromissos ainda estão em aberto?",
  "O que aprendemos nos últimos projetos?",
  "Mudou algum preço ou prazo?",
];

// --- modelo de turno ---
interface Turn {
  id: number;
  q: string;
  /** texto da resposta crescendo ao vivo (tokens). undefined antes do 1º token. */
  streamText?: string;
  /** true enquanto o stream está aberto (mostra caret). false quando done/error/fallback resolveu. */
  streaming?: boolean;
  /** carga ancorada final (após `done` OU fallback api.ask). undefined = ainda não resolveu. */
  answer?: AskAnswer;
  error?: string;
}

/** "De onde veio": conta só fato/hipótese e pluraliza (perguntar.md §4.2 labelOf). */
function srcCount(cards: RetrieveHit[]): string {
  let fatos = 0;
  let hipos = 0;
  for (const c of cards) {
    if (c.selo?.status === "fato") fatos++;
    else if (c.selo?.status === "hipotese") hipos++;
  }
  const parts: string[] = [];
  if (fatos > 0) parts.push(`${fatos} ${fatos === 1 ? "fato" : "fatos"}`);
  if (hipos > 0) parts.push(`${hipos} ${hipos === 1 ? "hipótese" : "hipóteses"}`);
  return parts.join(" · ");
}

let TURN_SEQ = 1;

export default function Perguntar() {
  const { current } = useBrain();
  const [params, setParams] = useSearchParams();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [startersUsed, setStartersUsed] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const streamRef = useRef<{ close: () => void } | null>(null);
  const brainName = current?.name ?? "acme / vendas";

  // fecha o stream da pergunta anterior ao desmontar (não vaza EventSource)
  useEffect(() => () => streamRef.current?.close(), []);

  // pré-preenche pela URL (?q= vindo do AskCard do Painel) e dispara uma vez
  const firedQ = useRef<string | null>(null);
  useEffect(() => {
    const q = params.get("q");
    if (q && q.trim() && firedQ.current !== q) {
      firedQ.current = q;
      ask(q.trim());
      // limpa o ?q= pra não re-disparar em re-render/refresh
      const next = new URLSearchParams(params);
      next.delete("q");
      setParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  // scrollDown a cada turno novo / resposta chegando
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns]);

  // fallback bloqueante (= comportamento M17 atual): "Lendo a memória" → AnswerBody.
  async function askBlocking(id: number, q: string) {
    try {
      const answer = await api.ask(q);
      setTurns((t) => t.map((x) => (x.id === id ? { ...x, answer, streaming: false } : x)));
    } catch (e) {
      setTurns((t) =>
        t.map((x) =>
          x.id === id
            ? {
                ...x,
                error: e instanceof Error ? e.message : "Não consegui responder agora.",
                streaming: false,
              }
            : x,
        ),
      );
    }
  }

  function ask(qRaw: string) {
    const q = qRaw.trim();
    if (!q) return;
    setStartersUsed(true);
    const id = TURN_SEQ++;
    setTurns((t) => [...t, { id, q, streaming: true, streamText: "" }]);

    // navegador sem suporte a EventSource → direto pro bloqueante (M17)
    if (typeof EventSource === "undefined") {
      askBlocking(id, q);
      return;
    }

    streamRef.current?.close(); // cancela stream anterior (se houver), não vaza
    let gotAnyToken = false;
    let settled = false; // evita done+error duplo
    const handle = api.askStream(q, {
      onToken: (delta) => {
        gotAnyToken = true;
        setTurns((t) =>
          t.map((x) => (x.id === id ? { ...x, streamText: (x.streamText || "") + delta } : x)),
        );
      },
      onDone: (payload) => {
        if (settled) return;
        settled = true;
        // o texto streamado É a prosa: vira answer.answer; a camada ancorada vem na carga do done.
        setTurns((t) =>
          t.map((x) =>
            x.id === id
              ? {
                  ...x,
                  streaming: false,
                  answer: {
                    answer: x.streamText || "",
                    citations: payload.citations ?? [],
                    facts: payload.facts ?? [],
                    gaps: payload.gaps ?? [],
                  },
                }
              : x,
          ),
        );
      },
      onError: () => {
        if (settled) return;
        settled = true;
        // fallback: refaz bloqueante p/ uma resposta íntegra (tenha ou não chegado algum token).
        if (gotAnyToken) {
          setTurns((t) => t.map((x) => (x.id === id ? { ...x, streaming: false } : x)));
        }
        askBlocking(id, q);
      },
    });
    streamRef.current = handle;
  }

  function submit() {
    const q = draft.trim();
    if (!q) return;
    setDraft("");
    if (taRef.current) taRef.current.style.height = "auto";
    ask(q);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  function autosize(el: HTMLTextAreaElement) {
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }

  return (
    <div style={{ maxWidth: 780, margin: "0 auto", width: "100%" }}>
      {/* HERO — fica fixo no topo da coluna de chat */}
      <header style={{ padding: "8px 0 24px" }}>
        <div
          className="mono"
          style={{
            fontSize: 11.5,
            letterSpacing: ".06em",
            textTransform: "uppercase",
            color: "var(--accent-ink)",
            marginBottom: 10,
          }}
        >
          {EYEBROW}
        </div>
        <h1
          style={{
            fontSize: "clamp(28px,4vw,40px)",
            fontWeight: 800,
            letterSpacing: "-.03em",
            lineHeight: 1.05,
            margin: "0 0 12px",
            color: "var(--fg)",
          }}
        >
          O que você quer saber, {current ? firstName(current.name) : "Kelvin"}?
        </h1>
        <p style={{ fontSize: 15, lineHeight: 1.6, color: "var(--muted)", maxWidth: 640, margin: 0 }}>
          {SUB}
        </p>
      </header>

      {/* CHAT — turnos */}
      <div style={{ display: "grid", gap: 28 }}>
        {turns.map((t) => (
          <TurnView key={t.id} turn={t} />
        ))}
        <div ref={chatEndRef} />
      </div>

      {/* COMPOSER sticky no fundo da coluna */}
      <div
        style={{
          position: "sticky",
          bottom: 0,
          marginTop: 28,
          paddingTop: 16,
          paddingBottom: 8,
          background: "linear-gradient(to bottom, transparent, var(--bg) 28px)",
        }}
      >
        {/* starters (somem ao usar) */}
        {!startersUsed && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
            {STARTERS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => ask(s)}
                style={{
                  height: 32,
                  padding: "0 14px",
                  borderRadius: 99,
                  border: "1px solid var(--border-strong)",
                  background: "var(--surface)",
                  color: "var(--muted)",
                  fontSize: 13,
                  cursor: "pointer",
                }}
              >
                {s}
              </button>
            ))}
          </div>
        )}

        <div
          style={{
            display: "flex",
            alignItems: "flex-end",
            gap: 10,
            border: "1px solid var(--border-strong)",
            borderRadius: 14,
            background: "var(--surface)",
            padding: "10px 10px 10px 14px",
            boxShadow: "var(--shadow)",
          }}
        >
          <textarea
            ref={taRef}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              autosize(e.target);
            }}
            onKeyDown={onKeyDown}
            rows={1}
            placeholder={`Pergunte qualquer coisa sobre o cérebro ${brainName}…`}
            aria-label="Sua pergunta"
            style={{
              flex: 1,
              resize: "none",
              border: "none",
              outline: "none",
              background: "transparent",
              fontFamily: "var(--font)",
              fontSize: 15,
              lineHeight: 1.5,
              color: "var(--fg)",
              maxHeight: 120,
              padding: "5px 0",
            }}
          />
          <Button variant="primary" onClick={submit} disabled={!draft.trim()} icon={<Icon name="chevron" size={15} />}>
            Perguntar
          </Button>
        </div>

        {/* foothint — aviso de custo/identidade ancorado aqui (perguntar.md §6) */}
        <p style={{ fontSize: 12.5, color: "var(--faint)", margin: "10px 2px 0", lineHeight: 1.5 }}>
          <b style={{ color: "var(--muted)" }}>{FOOTHINT_STRONG}</b>
          {FOOTHINT_REST}
        </p>
      </div>
    </div>
  );
}

function firstName(name: string): string {
  // "Kelvin Cleto" → "Kelvin"; nome de brain ("acme / vendas") cai inteiro
  const t = name.trim().split(/\s+/)[0];
  return t || name;
}

// ---------------------------------------------------------------------------
// Turno: pergunta (bolha) + resposta (lead + citações + changed)
// ---------------------------------------------------------------------------

function TurnView({ turn }: { turn: Turn }) {
  return (
    <div className="turn">
      {/* PERGUNTA — bolha escura à direita */}
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <div
          style={{
            maxWidth: "78%",
            background: "var(--fg)",
            color: "#fff",
            borderRadius: "14px 14px 4px 14px",
            padding: "10px 14px",
            fontSize: 15,
            lineHeight: 1.5,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {turn.q}
        </div>
      </div>

      {/* RESPOSTA */}
      <div style={{ display: "flex", gap: 12, marginTop: 16 }}>
        <AnswerIcon />
        <div style={{ flex: 1, minWidth: 0 }}>
          {turn.error ? (
            <ErrorBody message={turn.error} />
          ) : turn.streaming && turn.streamText ? (
            <StreamingBody text={turn.streamText} />
          ) : turn.answer ? (
            <AnswerBody answer={turn.answer} />
          ) : (
            // antes do 1º token (stream) OU durante o fallback bloqueante: "pensando"
            <Loading variant="thinking" label={THINKING_LABEL} />
          )}
        </div>
      </div>
    </div>
  );
}

function AnswerIcon() {
  // logo Galeed 32px (perguntar.md §4 .a-ic) — Brand resolve o asset correto
  return <Brand size={32} glyphOnly style={{ flexShrink: 0 }} />;
}

/** Efeito de digitação: revela `target` char-a-char via requestAnimationFrame, em vez de
 *  despejar os deltas do SSE em blocos (que chegam irregulares e "piscam"). A velocidade
 *  escala com o backlog — quanto mais texto pendente, mais chars por frame — então a
 *  digitação nunca atrasa muito (cap de latência) mas continua visível como digitação.
 *  Uma instância por turno (monta/desmonta com o estado streaming), então começa do zero. */
function useTypewriter(target: string): string {
  const [shownLen, setShownLen] = useState(0);
  const targetRef = useRef(target);
  targetRef.current = target;

  useEffect(() => {
    let raf = 0;
    const loop = () => {
      setShownLen((cur) => {
        const tgt = targetRef.current.length;
        if (cur >= tgt) return cur; // alcançou o alvo → bail-out (sem re-render)
        const backlog = tgt - cur;
        const step = Math.max(2, Math.ceil(backlog / 8)); // ~2 chars/frame + recupera 1/8 do atraso
        return Math.min(tgt, cur + step);
      });
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  return target.slice(0, shownLen);
}

/** M18 — prosa crescendo ao vivo (tokens) com efeito de digitação, JÁ FORMATADA em markdown.
 *  Renderiza o texto digitado pelo mesmo <Markdown> do AnswerBody (negrito, listas, títulos,
 *  tabelas) → a transição digitando → resposta final não dá "pulo" de layout. Markdown parcial
 *  (ex.: `**` ainda não fechado na ponta) renderiza literal por um instante e se auto-corrige no
 *  próximo char — aceitável, é o comportamento de chat ao vivo. */
function StreamingBody({ text }: { text: string }) {
  const shown = useTypewriter(text);
  // cursor inline (▍) anexado ao texto: como o markdown é block, um <span> caret iria pra uma
  // linha própria; o glyph entra no FLUXO, colado no último char digitado, dentro do último bloco.
  return (
    <div className="streaming">
      <Markdown>{shown + "▍"}</Markdown>
    </div>
  );
}

function AnswerBody({ answer }: { answer: AskAnswer }) {
  // só citações com lastro (selo) viram card — protege contra hit malformado vindo do motor
  const cards = (answer.citations ?? []).filter((c) => c.selo);
  const hasSources = cards.length > 0;
  const lowConf =
    answer.lowConfidence ?? cards.some((c) => typeof c.selo?.confidence === "number" && c.selo.confidence < 0.6);
  const countLabel = srcCount(cards);
  // As fontes ("registros") ficam ESCONDIDAS por padrão pra não poluir a resposta — a proveniência
  // segue a 1 clique (invariante #6). Toggle "De onde veio · N".
  const [showSources, setShowSources] = useState(false);

  // Sem fontes → resposta honesta, sem citações (regra de produto: nada sem lastro).
  if (!hasSources) {
    return (
      <div>
        {answer.answer?.trim() ? (
          <Markdown>{answer.answer}</Markdown>
        ) : (
          <p style={{ fontSize: 15, lineHeight: 1.6, color: "var(--fg)", margin: 0 }}>
            Não encontrei nada sobre isso na memória deste cérebro. Não vou inventar — registre a informação ou tente perguntar de outro jeito.
          </p>
        )}
        {answer.gaps && answer.gaps.length > 0 && (
          <ul style={{ margin: "10px 0 0", paddingLeft: 18, color: "var(--muted)", fontSize: 14, lineHeight: 1.6 }}>
            {answer.gaps.map((g, i) => (
              <li key={i}>{g}</li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  return (
    <div>
      {/* baixa confiança → barra âmbar (perguntar.md §8) */}
      {lowConf && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            borderLeft: "3px solid var(--st-hypo)",
            background: "var(--st-hypo-soft)",
            borderRadius: "0 8px 8px 0",
            padding: "8px 12px",
            marginBottom: 12,
            fontSize: 13,
            color: "oklch(48% 0.12 65)",
          }}
        >
          <Icon name="info" size={14} />
          Confiança baixa: trate como palpite, não como certeza.
        </div>
      )}

      {/* resposta sintetizada — markdown renderizado e estilizado (react-markdown, sem HTML cru) */}
      <Markdown>{answer.answer ?? ""}</Markdown>

      {/* "De onde veio" — TOGGLE: as fontes ficam escondidas por padrão (não poluem a resposta). */}
      {countLabel && (
        <button
          type="button"
          onClick={() => setShowSources((v) => !v)}
          aria-expanded={showSources}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginTop: 18,
            marginBottom: showSources ? 10 : 0,
            fontSize: 13,
            color: "var(--muted)",
            background: "none",
            border: "none",
            padding: 0,
            cursor: "pointer",
          }}
        >
          <Icon name="chevron" size={13} style={{ transform: showSources ? "rotate(90deg)" : "none", transition: "transform .15s" }} />
          <span style={{ fontWeight: 600 }}>{SRC_LABEL}</span>
          <span className="mono" style={{ fontSize: 12, color: "var(--faint)" }}>
            {countLabel}
          </span>
        </button>
      )}

      {/* citações — Seal completo, só quando o usuário abre "De onde veio" */}
      {showSources && (
        <div style={{ display: "grid", gap: 12, marginTop: 10 }}>
          {cards.map((hit) => (
            <Seal
              key={hit.slug}
              selo={hit.selo}
              elevated
              citeHref={hit.selo?.cite ? `/app/buscar?q=${encodeURIComponent(hit.title)}&slug=${encodeURIComponent(hit.slug)}` : undefined}
            >
              <span>{hit.excerpt ?? hit.title}</span>
            </Seal>
          ))}
        </div>
      )}

      {/* "o que mudou no tempo" — lacunas/mudanças apontadas pelo motor */}
      {answer.gaps && answer.gaps.length > 0 && <ChangedBar items={answer.gaps} />}

      {/* porta pro DOSSIÊ: quando a resposta trouxe fatos de uma entidade, oferece a página dela */}
      {(() => {
        const ent = (answer.facts ?? []).find((f) => f.entity)?.entity;
        if (!ent) return null;
        return (
          <a
            href={`/app/dossie/${encodeURIComponent(ent)}`}
            className="mono"
            style={{ display: "inline-flex", alignItems: "center", gap: 5, marginTop: 12, fontSize: 12, color: "var(--accent-ink)", textDecoration: "none" }}
          >
            Ver dossiê de {ent} <Icon name="chevron" size={12} />
          </a>
        );
      })()}
    </div>
  );
}

// (removido) Série de fatos "Evolução" — não exibimos a evolução por tier na tela Perguntar.
// A proveniência fica em "De onde veio" (citações); o detalhe por fato vive na tela Fatos.

/** Barra "o que mudou no tempo" — borda-esquerda violeta. (O link "ver no mapa" saiu junto com a
 *  tela Mapa; a rota /app/mapa não existe mais e o clique jogava o usuário de volta no Painel.) */
function ChangedBar({ items }: { items: string[] }) {
  return (
    <div
      style={{
        borderLeft: "3px solid var(--st-reg)",
        background: "var(--st-reg-soft)",
        borderRadius: "0 8px 8px 0",
        padding: "12px 14px",
        marginTop: 16,
      }}
    >
      <div style={{ fontSize: 13, color: "var(--fg)", lineHeight: 1.6 }}>
        {items.map((it, i) => (
          // ACHADO #1 (XSS): os gaps vêm do motor; renderiza como TEXTO escapado (React), nunca __html.
          <div key={i}>{it}</div>
        ))}
      </div>
    </div>
  );
}

function ErrorBody({ message }: { message: string }) {
  return (
    <div
      style={{
        borderLeft: "3px solid var(--danger)",
        background: "oklch(95.5% 0.05 25)",
        borderRadius: "0 8px 8px 0",
        padding: "12px 14px",
        fontSize: 14,
        color: "var(--fg)",
        lineHeight: 1.6,
      }}
    >
      Não consegui responder agora. <span style={{ color: "var(--muted)" }}>{message}</span>
    </div>
  );
}
