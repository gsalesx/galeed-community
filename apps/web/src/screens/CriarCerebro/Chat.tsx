/** M21/S6 — Coluna do chat do wizard (fiel a docs/design-system/criar-cerebro.html).
 *
 *  Burro por contrato: recebe bolhas + chips prontos e só devolve `onSend(texto)`.
 *  - Bolha IA: ícone 30×30 (logo Galeed), bubble surface radius 4/14/14/14, anima rise.
 *  - Bolha me: fundo --fg, branco, radius 14/14/4/14, max-width 80%, alinhada à direita.
 *  - Typing: 3 dots (blink 1.2s) enquanto o back responde (~650ms mínimo — index.tsx).
 *  - Chips: pill border-strong; o chip "go" (último, quando termina em "→" ou é o de
 *    confirmar 🪨) com --accent-soft. Clicar → onSend(texto do chip).
 *  - Composer: textarea rows=1 auto-grow (cap 110px), Enter envia / Shift+Enter quebra,
 *    botão-avião 36×36 accent; small LITERAL do mockup.
 *  - Texto vem do back como TEXTO PURO — nunca renderizado como HTML (XSS / CONTRACT).
 */
import { useEffect, useRef, useState } from "react";
import type { WizardChip } from "./types";

const LOGO_SRC = "/galeed-logo.png";

export interface ChatTurn {
  who: "ai" | "me";
  text: string;
}

/** chip "go" SINTÉTICO (suggestions simples): o último, quando é de avanço ("Pronto →") ou o de
 *  confirmar (🪨). Para chips ricos (`chips`) o `kind` já vem do back. */
function isGoChip(text: string, index: number, all: string[]): boolean {
  return index === all.length - 1 && (/→\s*$/.test(text.trim()) || text.includes("🪨"));
}

export function Chat(props: {
  turns: ChatTurn[];
  typing: boolean;
  suggestions: string[];
  /** chips RICOS (M21/fix-2) do passo `sources`: toggle multi-seleção + chip `go`. [] nos demais. */
  chips?: WizardChip[];
  onSend: (message: string, action?: "toggle" | "go") => void;
  disabled: boolean;
  /** muda → foca o composer (ex.: 409 no confirm — "o input volta ao composer"). */
  focusToken?: number;
}) {
  const { turns, typing, suggestions, chips, onSend, disabled, focusToken } = props;
  const [text, setText] = useState("");
  const chatRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // auto-scroll pro fim a cada turno / typing
  useEffect(() => {
    const el = chatRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns.length, typing]);

  // foco pedido pelo pai (erro de confirm → volta pro composer)
  useEffect(() => {
    if (focusToken !== undefined && focusToken > 0) inputRef.current?.focus();
  }, [focusToken]);

  function submit() {
    const message = text.trim();
    if (!message || disabled) return;
    setText("");
    const el = inputRef.current;
    if (el) el.style.height = "auto";
    onSend(message);
  }

  function autogrow() {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 110) + "px";
  }

  return (
    <div className="chatcol">
      <div className="chat" ref={chatRef}>
        {turns.map((t, i) =>
          t.who === "ai" ? (
            <div className="turn" key={i}>
              <div className="a-ic">
                <img src={LOGO_SRC} alt="" />
              </div>
              <div className="bubble">{t.text}</div>
            </div>
          ) : (
            <div className="turn me" key={i}>
              <div className="bubble">{t.text}</div>
            </div>
          ),
        )}
        {typing && (
          <div className="turn" key="typing">
            <div className="a-ic">
              <img src={LOGO_SRC} alt="" />
            </div>
            <div className="bubble">
              <span className="typing" aria-label="digitando…">
                <i />
                <i />
                <i />
              </span>
            </div>
          </div>
        )}
      </div>

      <div className="sugs">
        {!typing &&
          !disabled &&
          // chips RICOS (toggle/go) têm prioridade — passo `sources`. Toggle marca `.sel` e NÃO
          // trava o composer (envia action:'toggle', back re-renderiza no mesmo passo); `go` avança.
          (chips && chips.length > 0
            ? chips.map((c, i) => (
                <button
                  key={`${c.label}-${i}`}
                  type="button"
                  className={
                    "sug" +
                    (c.kind === "go" ? " go" : "") +
                    (c.kind === "toggle" && c.selected ? " sel" : "")
                  }
                  aria-pressed={c.kind === "toggle" ? !!c.selected : undefined}
                  onClick={() => onSend(c.label, c.kind === "go" ? "go" : "toggle")}
                >
                  {c.label}
                </button>
              ))
            : suggestions.map((s, i) => (
                <button
                  key={`${s}-${i}`}
                  type="button"
                  className={"sug" + (isGoChip(s, i, suggestions) ? " go" : "")}
                  onClick={() => onSend(s)}
                >
                  {s}
                </button>
              )))}
      </div>

      <div className="composer">
        <div className="cbox">
          <textarea
            ref={inputRef}
            rows={1}
            value={text}
            placeholder="Ou escreve com as suas palavras…"
            disabled={disabled}
            onChange={(e) => setText(e.target.value)}
            onInput={autogrow}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
          />
          <button className="send" type="button" title="Enviar" disabled={disabled} onClick={submit}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M22 2 11 13M22 2l-7 20-4-9-9-4z" />
            </svg>
          </button>
        </div>
        <small>
          O Galeed monta o cérebro com você: primeiro o que ele guarda, depois de onde vem. Nada
          entra antes disso.
        </small>
      </div>
    </div>
  );
}

export default Chat;
