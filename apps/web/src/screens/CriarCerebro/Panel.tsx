/** M21/S6 — Painel "o cérebro se montando" (fiel a docs/design-system/criar-cerebro.html).
 *
 *  Renderiza a projeção DETERMINÍSTICA `turn.panel` que o S4 devolve — nunca JSON cru.
 *  - Header: core 38×38 com eco animado (echo 2.4s) + nome + status mono.
 *  - 4 pgroups na ordem do mockup; card vazio `pcard empty` com o texto LITERAL enquanto
 *    o passo não chegou; check "✓" (e contagem) no rótulo quando preenche.
 *  - Regras: cadeado na 1ª (sigilo padrão), alerta âmbar nas seguintes (regra de ouro).
 *  - `created` não-nulo → done-card "Cérebro pronto pra nascer" com os 2 CTAs.
 */
import { Button } from "../../ui";
import type { WizardPanel } from "./types";

const LOGO_SRC = "/galeed-logo.png";

/** ícone "nó" do mockup (fonte/receita + CTA fontes). */
function NodeIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 3v6m0 0a3 3 0 1 0 0 6 3 3 0 0 0 0-6zm0 6v6" />
    </svg>
  );
}

function Pl({ label, ok }: { label: string; ok?: string | null }) {
  return (
    <div className="pl">
      {label} {ok != null && <span className="ok">✓{ok ? ` ${ok}` : ""}</span>}
    </div>
  );
}

export function Panel(props: {
  panel: WizardPanel | null;
  created: { id: string; name: string } | null;
  onGoFontes: () => void;
  onGoAdicionar: () => void;
}) {
  const { panel, created, onGoFontes, onGoAdicionar } = props;
  const hasPurpose = !!panel?.purpose;
  const areas = panel?.areas ?? [];
  const sources = panel?.sources ?? [];
  const rules = panel?.rules ?? [];

  return (
    <aside className="panel">
      <div className="ph">
        <div className="core">
          <img src={LOGO_SRC} alt="" />
        </div>
        <div>
          <b>{panel?.name || "Cérebro sem nome"}</b>
          <small>{created ? "pronto pra nascer" : panel?.status || "se montando…"}</small>
        </div>
      </div>

      <div className="pgroup">
        <Pl label="O que ele cuida" ok={hasPurpose ? "" : null} />
        {hasPurpose ? (
          <div className="pcard">
            <b>{panel?.purpose}</b>
            <br />
            <span className="pmono">definido por você</span>
          </div>
        ) : (
          <div className="pcard empty">Aparece aqui quando você contar.</div>
        )}
      </div>

      <div className="pgroup">
        <Pl label="Áreas de guarda" ok={areas.length ? String(areas.length) : null} />
        {areas.length ? (
          <div className="pcard">
            <div className="achips">
              {areas.map((a) => (
                <span className="achip" key={a}>
                  <span className="d" />
                  {a}
                </span>
              ))}
            </div>
          </div>
        ) : (
          <div className="pcard empty">As gavetas do cérebro. A IA sugere, você ajusta.</div>
        )}
      </div>

      <div className="pgroup">
        <Pl label="Fontes e receitas" ok={sources.length ? String(sources.length) : null} />
        {sources.length ? (
          <div className="pcard">
            {sources.map((f) => (
              <div className="fline" key={f.name}>
                <NodeIcon />
                <span>
                  <b>{f.name}</b>
                  <small>extrai: {f.fields.join(" · ")}</small>
                  <span className="pmono accent">→ {f.areas.join(" · ")}</span>
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className="pcard empty">De onde a informação entra, e o que extraímos de cada uma.</div>
        )}
      </div>

      <div className="pgroup">
        <Pl label="Regras de entrada" ok={rules.length ? "" : null} />
        {rules.length ? (
          <div className="pcard">
            {rules.map((r, i) => (
              <div className="ruleline" key={i}>
                {i === 0 ? (
                  // cadeado — sigilo padrão (cor --sn-conf, como no mockup)
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                    <rect x="4" y="11" width="16" height="9" rx="2" />
                    <path d="M8 11V7a4 4 0 0 1 8 0v4" />
                  </svg>
                ) : (
                  // alerta âmbar — a regra de ouro (hipótese espera revisão)
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.2"
                    style={{ color: "var(--st-hypo)" }}
                  >
                    <path d="M12 9v4M12 17h.01" />
                    <circle cx="12" cy="12" r="9" />
                  </svg>
                )}
                <span>{r}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="pcard empty">
            Sigilo padrão e o que fazer com o que a receita não reconhecer.
          </div>
        )}
      </div>

      {created && (
        <div className="pgroup">
          <div className="done-card">
            <div className="dt">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M9 12l2 2 4-4" />
                <circle cx="12" cy="12" r="9" />
              </svg>{" "}
              Cérebro pronto pra nascer
            </div>
            <p>
              Estrutura definida. Agora sim: pode jogar qualquer coisa dentro, porque o cérebro
              sabe o que procurar.
            </p>
            <div className="cta">
              <Button
                variant="primary"
                onClick={onGoFontes}
                icon={
                  <span style={{ width: 15, height: 15, display: "inline-grid" }} aria-hidden>
                    <NodeIcon />
                  </span>
                }
                style={{ width: "100%", height: 38, borderRadius: 9 }}
              >
                Criar e ligar as fontes
              </Button>
              <Button
                variant="secondary"
                onClick={onGoAdicionar}
                style={{ width: "100%", height: 38, borderRadius: 9 }}
              >
                Jogar a primeira coisa dentro
              </Button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}

export default Panel;
