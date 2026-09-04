/** M8 — Fatos & Timeline (bitemporal): auditar a verdade no tempo.
 *
 *  O trunfo bitemporal do Galeed mostrado de forma honesta: cada fato é uma
 *  AFIRMAÇÃO com janela de validade (valid_from → valid_to). Quando o cérebro
 *  "muda de ideia", o fato antigo é SUPERSEDIDO por um novo — e a linha do tempo
 *  por entidade prova: "achava X mai→jun, virou Y jun→".
 *
 *  Dados (read-only; brain injetado pelo cliente):
 *    - api.facts(dim, { type, asOf, current, limit }) → fatos da dimensão
 *    - api.timeline(entity, { pred })                 → história de uma entidade
 *
 *  M10/S4: a API agora tipa o retorno como FactItem[] (espelha bff-m9.ts). O claim
 *  tipado (value_num/unit/period/tier) é renderizado quando presente — campos ausentes
 *  são OMITIDOS, nada é inventado. valid_to vazio/null = fato VIGENTE (verdade atual).
 *  A timeline agrupa por (predicate, tier): cada tier é uma SÉRIE (degrau por degrau).
 *
 *  Controles: dimensão (dim), toggle "só vigentes" (current), data as-of.
 *  Clique numa linha → painel lateral com a linha do tempo daquela entidade.
 *  Estados: carregando (Skeleton), vazio, erro. Vigente vs expirado distinto.
 */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Button, Card, Chip, Icon, Skeleton, StatusChip } from "../../ui";
import type { StatusVariant } from "../../ui";
import { api, type FactItem } from "../../lib/api";
import { useQuery } from "../../lib/useQuery";
import { useBrain } from "../../lib/auth";
import { fmtDate, fmtDateFull, fmtConfidence } from "../../lib/format";

// ---------------------------------------------------------------------------
// Fato bitemporal TIPADO (FactItem do M9 — vem tipado da api.facts/api.timeline).
// ---------------------------------------------------------------------------

type Fact = FactItem;

/** Realce do claim numérico: "30000 BRL /mês" — só com o que existir; vazio = sem realce. */
function typedClaim(f: Fact): string {
  if (f.value_num == null) return "";
  const parts: string[] = [String(f.value_num)];
  if (f.unit) parts.push(f.unit);
  let s = parts.join(" ");
  if (f.period) s += ` /${f.period}`;
  return s;
}

/** Dimensões canônicas do extrator (core/health.ts CONF_HALFLIFE). */
const DIMS: { key: string; label: string }[] = [
  { key: "decisions", label: "Decisões" },
  { key: "facts", label: "Fatos" },
  { key: "claims", label: "Afirmações" },
  { key: "action_items", label: "Tarefas" },
  { key: "follow_ups_pending", label: "Follow-ups" },
  { key: "objections", label: "Objeções" },
  { key: "entities", label: "Entidades" },
];

const LIMIT = 200;
// piso de exibição: fatos abaixo disso são SUSPEITOS (registrado sem âncora verbatim, ~0.10) —
// escondidos por padrão. Casado com CONF_UNGROUNDED/CONF_REGISTERED do motor (indexer.ts).
const SUSPEITO_MAX = 0.2;

/** valid_to vazio/null ⇒ verdade atual (vigente hoje). */
function isVigente(f: Fact): boolean {
  return f.valid_to == null || f.valid_to === "";
}

/** status do selo → variante do StatusChip (tolerante a valores desconhecidos). */
function statusVariant(status?: string): StatusVariant {
  switch ((status || "").toLowerCase()) {
    case "fato":
    case "fact":
      return "fact";
    case "hipotese":
    case "hipótese":
    case "hypo":
      return "hypo";
    case "arquivado":
    case "arch":
      return "arch";
    case "registrado":
    case "registro":
    case "reg":
      return "reg";
    case "pessoa":
    case "entidade":
    case "ent":
      return "ent";
    default:
      return "fact";
  }
}

/** Rótulo curto da entidade/predicado pra exibição. */
function entityLabel(f: Fact): string {
  return f.entity || "—"; // SEM fallback pro slug (poluía a coluna com o nome do arquivo)
}

/** Conteúdo principal de um fato: o claim tipado (value) OU, p/ fatos textuais
 *  (decisions/entities/quotes), o `text` — que é onde mora a informação de verdade. */
function factValue(f: Fact): string {
  return f.value || f.text || "—";
}

// ---------------------------------------------------------------------------
// Tela
// ---------------------------------------------------------------------------

export default function Fatos() {
  const { current } = useBrain();

  const [dim, setDim] = useState("decisions");
  const [currentOnly, setCurrentOnly] = useState(false);
  // por padrão, esconde os SUSPEITOS (baixa certeza): observação textual sem âncora verbatim na
  // fonte (~0.10). Os grounded (0.45+) e os claims (0.60+) aparecem. Toggle revela os suspeitos.
  const [incluirSuspeitos, setIncluirSuspeitos] = useState(false);
  const [asOf, setAsOf] = useState("");
  // entidade selecionada → abre o painel de linha do tempo
  const [selected, setSelected] = useState<{ entity: string; pred?: string } | null>(null);

  const effectiveAsOf = asOf || undefined;

  const { data, error, loading, refetch } = useQuery<Fact[]>(
    `facts:${current?.id ?? ""}:${dim}:${currentOnly ? 1 : 0}:${effectiveAsOf ?? ""}`,
    () =>
      api.facts(dim, {
        asOf: effectiveAsOf,
        current: currentOnly,
        limit: LIMIT,
      }),
    [current?.id, dim, currentOnly, effectiveAsOf],
  );

  const todos = useMemo(() => (Array.isArray(data) ? data : []), [data]);
  // FILTRO INICIAL: esconde os suspeitos de baixa certeza (< 0.2 → registrado sem âncora). Toggle reabre.
  // ORDEM: certeza do MAIOR pro menor (pela confiança JÁ decaída/exibida, não a crua do banco).
  const facts = useMemo(() => {
    const base = incluirSuspeitos ? todos : todos.filter((f) => (f.confidence ?? 0) >= SUSPEITO_MAX);
    return [...base].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
  }, [todos, incluirSuspeitos]);
  const ocultos = todos.length - facts.length; // quantos suspeitos foram escondidos

  // quais colunas têm dados em PELO MENOS um fato? (omitimos colunas vazias)
  const cols = useMemo(() => {
    const has = (k: keyof Fact) => facts.some((f) => f[k] != null && f[k] !== "");
    return {
      entity: facts.some((f) => !!f.entity), // só quando há ENTIDADE real (não o slug do arquivo)
      predicate: has("predicate"),
      value: facts.some((f) => f.value || f.text), // conteúdo: claim tipado OU texto do fato
      tier: has("tier"),
      confidence: facts.some((f) => typeof f.confidence === "number"),
      validity: facts.some((f) => f.valid_from || f.valid_to),
      status: has("status"),
      source: has("source_slug"),
    };
  }, [facts]);

  return (
    <div>
      {/* ── PAGE HEAD ──────────────────────────────────────────── */}
      <header style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: 32, fontWeight: 700, letterSpacing: "-.025em", margin: 0 }}>Fatos</h1>
        <p style={{ fontSize: 14, color: "var(--muted)", margin: "6px 0 0" }}>
          A verdade do cérebro no tempo. Cada fato vale por um período — quando muda, o antigo é
          aposentado e o novo assume. Clique numa linha pra ver a história.
        </p>
      </header>

      {/* ── CONTROLES ──────────────────────────────────────────── */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 8,
          marginBottom: 18,
        }}
      >
        {/* dimensão */}
        {DIMS.map((d) => (
          <Chip key={d.key} active={dim === d.key} onToggle={() => setDim(d.key)}>
            {d.label}
          </Chip>
        ))}

        <span aria-hidden style={{ width: 1, height: 22, background: "var(--border)", margin: "0 4px" }} />

        {/* só vigentes */}
        <Chip active={currentOnly} onToggle={() => setCurrentOnly((v) => !v)} style={{ gap: 6 }}>
          <Icon name="check" size={13} />
          Só vigentes
        </Chip>

        {/* incluir suspeitos de baixa certeza (escondidos por padrão) */}
        <Chip active={incluirSuspeitos} onToggle={() => setIncluirSuspeitos((v) => !v)} style={{ gap: 6 }}>
          <Icon name="info" size={13} />
          Incluir fatos de baixa certeza{!incluirSuspeitos && ocultos > 0 ? ` (${ocultos})` : ""}
        </Chip>

        {/* as-of */}
        <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 8 }}>
          <span
            className="mono"
            style={{ fontSize: 12, color: asOf ? "var(--accent-ink)" : "var(--faint)", display: "inline-flex", alignItems: "center", gap: 6 }}
          >
            <Icon name="clock" size={13} />
            Como estava em
          </span>
          <input
            type="date"
            value={asOf}
            max={new Date().toISOString().slice(0, 10)}
            onChange={(e) => setAsOf(e.target.value)}
            aria-label="Ver fatos vigentes em (data as-of)"
            className="mono"
            style={{
              height: 32,
              border: "1px solid var(--border-strong)",
              borderRadius: 8,
              padding: "0 10px",
              background: "var(--surface)",
              color: "var(--fg)",
              fontSize: 12,
            }}
          />
          {asOf && (
            <button
              type="button"
              onClick={() => setAsOf("")}
              aria-label="Voltar pra hoje"
              style={{ border: "none", background: "none", cursor: "pointer", color: "var(--faint)", display: "inline-flex", padding: 2 }}
            >
              <Icon name="x" size={14} />
            </button>
          )}
        </span>
      </div>

      {/* aviso de as-of ativo */}
      {asOf && (
        <div
          className="mono"
          style={{
            marginBottom: 16,
            padding: "8px 12px",
            borderRadius: 8,
            border: "1px solid var(--border)",
            background: "var(--st-arch-soft)",
            color: "var(--muted)",
            fontSize: 12,
            display: "inline-flex",
            alignItems: "center",
            gap: 7,
          }}
        >
          <Icon name="clock" size={13} />
          Vendo a verdade vigente em <b style={{ color: "var(--fg)" }}>{fmtDateFull(asOf)}</b>
        </div>
      )}

      {/* ── ESTADOS / TABELA ───────────────────────────────────── */}
      {loading ? (
        <TabelaCarregando />
      ) : error ? (
        <EstadoErro mensagem={error.message} onRetry={refetch} />
      ) : facts.length === 0 ? (
        <EstadoVazio dim={dim} currentOnly={currentOnly} asOf={asOf} />
      ) : (
        <>
          <div className="mono" style={{ fontSize: 12, color: "var(--faint)", marginBottom: 10 }}>
            {facts.length} {facts.length === 1 ? "fato" : "fatos"}
            {currentOnly ? " vigentes" : ""} em <b style={{ color: "var(--muted)" }}>{DIMS.find((d) => d.key === dim)?.label ?? dim}</b>
          </div>
          <TabelaFatos
            facts={facts}
            cols={cols}
            selected={selected}
            onSelect={(f) =>
              setSelected(
                f.entity ? { entity: f.entity, pred: f.predicate } : null,
              )
            }
          />
          <Legenda />
        </>
      )}

      {/* ── PAINEL DE LINHA DO TEMPO (por entidade) ────────────── */}
      {selected && (
        <TimelinePanel
          entity={selected.entity}
          pred={selected.pred}
          brainId={current?.id}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tabela de fatos
// ---------------------------------------------------------------------------

type Cols = {
  entity: boolean;
  predicate: boolean;
  value: boolean;
  tier: boolean;
  confidence: boolean;
  validity: boolean;
  status: boolean;
  source: boolean;
};

/** Chip do tier (enterprise/pro/…) — realce mono discreto. */
function TierChip({ tier }: { tier: string }) {
  return (
    <span
      className="mono"
      style={{
        display: "inline-flex",
        alignItems: "center",
        fontSize: 10.5,
        fontWeight: 600,
        textTransform: "uppercase",
        letterSpacing: ".03em",
        padding: "2px 7px",
        borderRadius: 6,
        background: "var(--accent-soft)",
        color: "var(--accent-ink)",
        whiteSpace: "nowrap",
      }}
    >
      {tier}
    </span>
  );
}

/** Realce do numérico tipado: "30000 BRL /mês" em pílula mono (só com value_num). */
function NumericClaim({ f }: { f: Fact }) {
  const txt = typedClaim(f);
  if (!txt) return null;
  return (
    <span
      className="mono"
      style={{
        display: "inline-flex",
        alignItems: "center",
        fontSize: 11.5,
        fontWeight: 600,
        padding: "2px 8px",
        borderRadius: 6,
        background: "var(--st-fact-soft)",
        color: "var(--st-fact)",
        whiteSpace: "nowrap",
      }}
    >
      {txt}
    </span>
  );
}

const TH: React.CSSProperties = {
  textAlign: "left",
  padding: "9px 12px",
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: ".03em",
  textTransform: "uppercase",
  color: "var(--faint)",
  borderBottom: "1px solid var(--border)",
  whiteSpace: "nowrap",
};

const TD: React.CSSProperties = {
  padding: "11px 12px",
  fontSize: 13.5,
  borderBottom: "1px solid var(--border)",
  verticalAlign: "top",
};

function TabelaFatos({
  facts,
  cols,
  selected,
  onSelect,
}: {
  facts: Fact[];
  cols: Cols;
  selected: { entity: string; pred?: string } | null;
  onSelect: (f: Fact) => void;
}) {
  return (
    <Card padding={0} style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            {cols.entity && <th style={TH}>Entidade</th>}
            {cols.predicate && <th style={TH}>Predicado</th>}
            {cols.value && <th style={TH}>Fato</th>}
            {cols.tier && <th style={TH}>Tier</th>}
            {cols.confidence && <th style={{ ...TH, textAlign: "right" }}>Certeza</th>}
            {cols.validity && <th style={TH}>Validade</th>}
            {cols.status && <th style={TH}>Status</th>}
            {cols.source && <th style={TH}>Fonte</th>}
          </tr>
        </thead>
        <tbody>
          {facts.map((f, i) => {
            const vigente = isVigente(f);
            const clickable = !!f.entity;
            const isSel =
              selected &&
              f.entity === selected.entity &&
              (selected.pred == null || f.predicate === selected.pred);
            return (
              <tr
                key={`${f.source_slug ?? ""}:${f.entity ?? ""}:${f.predicate ?? ""}:${f.valid_from ?? ""}:${i}`}
                onClick={clickable ? () => onSelect(f) : undefined}
                style={{
                  cursor: clickable ? "pointer" : "default",
                  background: isSel ? "var(--accent-soft)" : undefined,
                  opacity: vigente ? 1 : 0.62,
                }}
                title={clickable ? "Ver linha do tempo desta entidade" : undefined}
              >
                {cols.entity && (
                  <td style={{ ...TD, fontWeight: 600, color: clickable ? "var(--accent-ink)" : "var(--fg)" }}>
                    {entityLabel(f)}
                  </td>
                )}
                {cols.predicate && (
                  <td style={{ ...TD, color: "var(--muted)" }} className="mono">
                    {f.predicate || "—"}
                  </td>
                )}
                {cols.value && (
                  <td style={{ ...TD, maxWidth: 520 }}>
                    <span style={{ display: "inline-flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                      <span style={{ lineHeight: 1.5 }}>{factValue(f)}</span>
                      <NumericClaim f={f} />
                    </span>
                  </td>
                )}
                {cols.tier && (
                  <td style={TD}>
                    {f.tier ? <TierChip tier={f.tier} /> : <span style={{ color: "var(--faint)" }}>—</span>}
                  </td>
                )}
                {cols.confidence && (
                  <td style={{ ...TD, textAlign: "right" }} className="mono">
                    {typeof f.confidence === "number" ? fmtConfidence(f.confidence) : "—"}
                  </td>
                )}
                {cols.validity && (
                  <td style={TD}>
                    <ValidityCell f={f} vigente={vigente} />
                  </td>
                )}
                {cols.status && (
                  <td style={TD}>
                    <StatusChip variant={statusVariant(f.status)} label={f.status} size="sm" />
                  </td>
                )}
                {cols.source && (
                  <td style={{ ...TD, color: "var(--muted)", whiteSpace: "nowrap" }} className="mono">
                    {f.source_slug ? <span style={{ fontSize: 12 }}>{f.source_slug}</span> : "—"}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
}

/** Validade: "12 jun → agora" (vigente) vs "12 mai → 12 jun" (expirado). */
function ValidityCell({ f, vigente }: { f: Fact; vigente: boolean }) {
  const from = f.valid_from ? fmtDate(f.valid_from) : "?";
  return (
    <span
      className="mono"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontSize: 12,
        color: vigente ? "var(--fg)" : "var(--muted)",
        whiteSpace: "nowrap",
      }}
    >
      <span>{from}</span>
      <span style={{ color: "var(--faint)" }}>→</span>
      {vigente ? (
        <span
          style={{
            color: "var(--st-fact)",
            fontWeight: 600,
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
          }}
        >
          <span aria-hidden style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--st-fact)" }} />
          agora
        </span>
      ) : (
        <span>{fmtDate(f.valid_to)}</span>
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Painel: linha do tempo bitemporal por entidade (supersessão)
// ---------------------------------------------------------------------------

function TimelinePanel({
  entity,
  pred,
  brainId,
  onClose,
}: {
  entity: string;
  pred?: string;
  brainId?: string;
  onClose: () => void;
}) {
  // padrão N+1 contra truncamento silencioso: o /api/timeline corta ordenado por (predicado,
  // valid_from) — sem aviso, séries inteiras sumiriam. Pedimos TL_PANEL_MAX+1 e avisamos se veio mais.
  const TL_PANEL_MAX = 1000;
  const { data, error, loading } = useQuery<Fact[]>(
    `timeline:${brainId ?? ""}:${entity}:${pred ?? ""}`,
    () => api.timeline(entity, { pred, limit: TL_PANEL_MAX + 1 }),
    [brainId, entity, pred],
  );

  const truncado = (data?.length ?? 0) > TL_PANEL_MAX;
  const events = useMemo(
    () => (Array.isArray(data) ? data.slice(0, TL_PANEL_MAX) : []),
    [data],
  );

  // agrupa por (predicado, tier) — cada tier é uma SÉRIE distinta (degrau por degrau).
  // ordena cada série por valid_from. Ex.: enterprise 3k (arquivado) → 30k (vigente) = 2 eventos.
  const series = useMemo(() => {
    const m = new Map<string, { predicate: string; tier: string; arr: Fact[] }>();
    for (const f of events) {
      const predicate = f.predicate || "—";
      const tier = f.tier || "";
      const key = `${predicate}|${tier}`;
      const g = m.get(key) ?? { predicate, tier, arr: [] };
      g.arr.push(f);
      m.set(key, g);
    }
    const out = [...m.values()];
    for (const g of out) {
      g.arr.sort((a, b) => (a.valid_from || "").localeCompare(b.valid_from || ""));
    }
    // ordena os grupos: por predicado, depois tier
    out.sort((a, b) => a.predicate.localeCompare(b.predicate) || a.tier.localeCompare(b.tier));
    return out;
  }, [events]);

  return (
    <>
      {/* backdrop */}
      <div
        onClick={onClose}
        style={{ position: "fixed", inset: 0, background: "oklch(20% 0.02 250 / 0.28)", zIndex: 40 }}
        aria-hidden
      />
      {/* drawer */}
      <aside
        role="dialog"
        aria-label={`Linha do tempo de ${entity}`}
        style={{
          position: "fixed",
          top: 0,
          right: 0,
          bottom: 0,
          width: "min(480px, 92vw)",
          background: "var(--surface)",
          borderLeft: "1px solid var(--border)",
          boxShadow: "var(--shadow)",
          zIndex: 41,
          display: "flex",
          flexDirection: "column",
        }}
      >
        <header
          style={{
            padding: "16px 20px",
            borderBottom: "1px solid var(--border)",
            background: "var(--surface-2)",
            display: "flex",
            alignItems: "flex-start",
            gap: 12,
          }}
        >
          <div style={{ flex: 1 }}>
            <div className="mono" style={{ fontSize: 11, color: "var(--faint)", textTransform: "uppercase", letterSpacing: ".04em" }}>
              Linha do tempo
            </div>
            <div style={{ fontSize: 19, fontWeight: 700, marginTop: 2 }}>{entity}</div>
            <div style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 3 }}>
              Como o cérebro mudou de ideia sobre isto, em ordem.
            </div>
            {/* porta pro DOSSIÊ — a página completa da entidade (decisões, compromissos, relações) */}
            <Link
              to={`/app/dossie/${encodeURIComponent(entity)}`}
              style={{ display: "inline-flex", alignItems: "center", gap: 5, marginTop: 8, fontSize: 12.5, fontWeight: 600, color: "var(--accent-ink)", textDecoration: "none" }}
            >
              Ver dossiê completo <Icon name="chevron" size={12} />
            </Link>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fechar"
            style={{ border: "none", background: "none", cursor: "pointer", color: "var(--muted)", padding: 4 }}
          >
            <Icon name="x" size={18} />
          </button>
        </header>

        <div style={{ overflowY: "auto", padding: "18px 20px", flex: 1 }}>
          {loading ? (
            <div style={{ display: "grid", gap: 14 }}>
              {[0, 1, 2].map((i) => (
                <div key={i} style={{ display: "grid", gap: 8 }}>
                  <Skeleton width="45%" height={10} />
                  <Skeleton width="90%" />
                  <Skeleton width="70%" />
                </div>
              ))}
            </div>
          ) : error ? (
            <EstadoErro mensagem={error.message} onRetry={onClose} compact />
          ) : events.length === 0 ? (
            <div style={{ color: "var(--muted)", fontSize: 14, lineHeight: 1.55 }}>
              Não há histórico bitemporal pra <b>{entity}</b> ainda. Assim que um fato sobre essa
              entidade for atualizado, a supersessão aparece aqui.
            </div>
          ) : (
            <div style={{ display: "grid", gap: 22 }}>
              {truncado && (
                <div
                  className="mono"
                  style={{
                    fontSize: 11.5, color: "var(--st-reg)", padding: "8px 10px", borderRadius: 8,
                    background: "var(--st-reg-soft)",
                  }}
                >
                  mostrando os {TL_PANEL_MAX} primeiros eventos — filtre por um predicado pra ver a série completa
                </div>
              )}
              {series.map((g) => (
                <div key={`${g.predicate}|${g.tier}`}>
                  {(g.predicate !== "—" || g.tier) && (
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                      {g.predicate !== "—" && (
                        <span className="mono" style={{ fontSize: 12, fontWeight: 600, color: "var(--muted)" }}>
                          {g.predicate}
                        </span>
                      )}
                      {g.tier && <TierChip tier={g.tier} />}
                    </div>
                  )}
                  <ol style={{ listStyle: "none", margin: 0, padding: 0, position: "relative" }}>
                    {g.arr.map((f, i) => (
                      <TimelineEvent key={i} f={f} last={i === g.arr.length - 1} superseded={i < g.arr.length - 1 && !isVigente(f)} />
                    ))}
                  </ol>
                </div>
              ))}
            </div>
          )}
        </div>
      </aside>
    </>
  );
}

/** Um evento na trilha vertical: bolinha + janela de validade + valor. */
function TimelineEvent({ f, last, superseded }: { f: Fact; last: boolean; superseded: boolean }) {
  const vigente = isVigente(f);
  return (
    <li style={{ display: "flex", gap: 12, paddingBottom: last ? 0 : 16, position: "relative" }}>
      {/* trilha + nó */}
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", flexShrink: 0 }}>
        <span
          aria-hidden
          style={{
            width: 12,
            height: 12,
            borderRadius: "50%",
            marginTop: 3,
            background: vigente ? "var(--st-fact)" : "var(--surface)",
            border: `2px solid ${vigente ? "var(--st-fact)" : "var(--border-strong)"}`,
          }}
        />
        {!last && <span aria-hidden style={{ width: 2, flex: 1, background: "var(--border)", marginTop: 3 }} />}
      </div>
      {/* corpo */}
      <div style={{ flex: 1, opacity: vigente ? 1 : 0.78 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span
            className="mono"
            style={{ fontSize: 11.5, color: "var(--muted)" }}
          >
            {f.valid_from ? fmtDate(f.valid_from) : "?"} →{" "}
            {vigente ? <b style={{ color: "var(--st-fact)" }}>agora</b> : fmtDate(f.valid_to)}
          </span>
          {f.status && <StatusChip variant={statusVariant(f.status)} label={f.status} size="sm" />}
          {superseded && (
            <span
              className="mono"
              style={{ fontSize: 10.5, color: "var(--faint)", textTransform: "uppercase", letterSpacing: ".03em" }}
            >
              superado
            </span>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 4 }}>
          <span style={{ fontSize: 14, color: "var(--fg)", textDecoration: superseded ? "line-through" : undefined }}>
            {factValue(f)}
          </span>
          <NumericClaim f={f} />
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 4 }}>
          {typeof f.confidence === "number" && (
            <span className="mono" style={{ fontSize: 11, color: "var(--faint)" }}>
              certeza {fmtConfidence(f.confidence)}
            </span>
          )}
          {f.source_slug && (
            <span className="mono" style={{ fontSize: 11, color: "var(--faint)" }}>
              {f.source_slug}
            </span>
          )}
        </div>
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Estados
// ---------------------------------------------------------------------------

function TabelaCarregando() {
  return (
    <Card padding={0}>
      <div style={{ padding: "11px 12px", borderBottom: "1px solid var(--border)", display: "flex", gap: 24 }}>
        {[80, 70, 120, 50, 90].map((w, i) => (
          <Skeleton key={i} width={w} height={9} />
        ))}
      </div>
      {[0, 1, 2, 3, 4, 5].map((r) => (
        <div key={r} style={{ padding: "13px 12px", borderBottom: "1px solid var(--border)", display: "flex", gap: 24, alignItems: "center" }}>
          <Skeleton width={90} height={11} />
          <Skeleton width={70} height={11} />
          <Skeleton width={200} height={11} />
          <Skeleton width={44} height={11} />
          <Skeleton width={110} height={11} />
        </div>
      ))}
    </Card>
  );
}

function EstadoVazio({ dim, currentOnly, asOf }: { dim: string; currentOnly: boolean; asOf: string }) {
  const label = DIMS.find((d) => d.key === dim)?.label ?? dim;
  return (
    <Card padding="32px 28px" style={{ maxWidth: 560 }}>
      <div style={{ display: "inline-flex", alignItems: "center", gap: 9, color: "var(--accent-ink)" }}>
        <Icon name="info" size={18} />
        <span style={{ fontSize: 17, fontWeight: 600, color: "var(--fg)" }}>Nenhum fato aqui</span>
      </div>
      <p style={{ fontSize: 14, color: "var(--muted)", margin: "8px 0 0", lineHeight: 1.55 }}>
        O cérebro não tem fatos em <b>{label}</b>
        {currentOnly ? " vigentes" : ""}
        {asOf ? <> vigentes em <b className="mono">{fmtDateFull(asOf)}</b></> : ""}. Conforme o material
        é processado, as afirmações extraídas aparecem aqui — com a janela de validade de cada uma.
      </p>
    </Card>
  );
}

function EstadoErro({
  mensagem,
  onRetry,
  compact,
}: {
  mensagem: string;
  onRetry: () => void;
  compact?: boolean;
}) {
  return (
    <div
      role="alert"
      style={{
        maxWidth: compact ? "100%" : 560,
        padding: "16px 18px",
        borderRadius: 12,
        border: "1px solid var(--danger)",
        background: "var(--sn-secret-soft)",
        display: "flex",
        alignItems: "center",
        gap: 14,
      }}
    >
      <span style={{ flex: 1 }}>
        <b>Não consegui carregar os fatos.</b>
        <span style={{ display: "block", fontSize: 13, color: "var(--muted)", marginTop: 4 }}>{mensagem}</span>
      </span>
      <Button size="sm" onClick={onRetry}>
        {compact ? "Fechar" : "Tentar de novo"}
      </Button>
    </div>
  );
}

/** Legenda: vigente vs expirado + nota de clique. */
function Legenda() {
  return (
    <div
      style={{
        marginTop: 22,
        maxWidth: 560,
        padding: "14px 18px",
        borderRadius: 12,
        border: "1px solid var(--border)",
        background: "var(--surface-2)",
        display: "flex",
        flexWrap: "wrap",
        gap: 18,
        alignItems: "center",
      }}
    >
      <span style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 13 }}>
        <span aria-hidden style={{ width: 9, height: 9, borderRadius: "50%", background: "var(--st-fact)" }} />
        <b>Vigente</b>
        <span style={{ color: "var(--muted)" }}>— verdade de hoje</span>
      </span>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 13, opacity: 0.62 }}>
        <span aria-hidden style={{ width: 9, height: 9, borderRadius: "50%", border: "2px solid var(--border-strong)" }} />
        <b>Expirado</b>
        <span style={{ color: "var(--muted)" }}>— já foi verdade, foi superado</span>
      </span>
      <span style={{ color: "var(--faint)", fontSize: 12.5, marginLeft: "auto" }}>
        Clique numa entidade pra ver a linha do tempo.
      </span>
    </div>
  );
}
