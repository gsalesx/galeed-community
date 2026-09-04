/** M8/S? — Buscar (memória): a TELA-ASSINATURA do selo.
 *
 *  Aqui o Galeed devolve CONHECIMENTO, não texto: cada hit do retrieve vem
 *  envelopado no <Seal/> completo (status, certeza, tipo, proveniência, validade,
 *  supersessão, via, cite-link, cadeado de sigilo) acima do trecho.
 *
 *  Especificação: _design/painel.md §6 ("última busca"/selo) + _design/00-foundation §5.1.
 *
 *  Dados (read-only, brain injetado pelo cliente):
 *    - api.retrieve(q, k, { asOf })  → hits selados (via vetor/FTS/grafo)
 *  Time-travel: o toggle "Viajar no tempo" passa `asOf` (data ISO) pra api.retrieve,
 *  mostrando como a memória estava naquele dia.
 *
 *  Filtros (FilterChip) são client-side sobre os hits: por status (fato/hipótese/
 *  arquivado), por fonte e por via. Estado vazio é HONESTO — nada é inventado:
 *  antes da 1ª busca mostramos só sugestões de pergunta clicáveis.
 *
 *  Cliques: cite → abre a fonte (por ora só registra no console); entidade → sem destino (Mapa removido).
 */
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Button,
  Card,
  Chip,
  Icon,
  Loading,
  Seal,
  SearchInput,
  Skeleton,
} from "../../ui";
import { api, type RetrieveHit, type Selo } from "../../lib/api";
import { useQuery } from "../../lib/useQuery";
import { useBrain } from "../../lib/auth";
import { fmtDateFull } from "../../lib/format";

// ---------------------------------------------------------------------------
// Constantes de domínio
// ---------------------------------------------------------------------------

const K = 8;

/** Sugestões de pergunta clicáveis (estado vazio). Copy de gente, igual painel.md. */
const SUGESTOES = [
  "Qual o preço que combinamos com a Acme?",
  "Quem decide na conta Beta?",
  "O que ficou pendente?",
  "Mudou algum preço?",
];

/** Filtros de status — bolinha categórica do selo (00-foundation §1.3). */
const STATUS_FILTROS: { key: Selo["status"]; label: string; dot: string }[] = [
  { key: "fato", label: "Fatos", dot: "var(--st-fact)" },
  { key: "hipotese", label: "Hipóteses", dot: "var(--st-hypo)" },
  { key: "arquivado", label: "Arquivados", dot: "var(--st-arch)" },
];

/** Filtros de via — caminho de recuperação. */
const VIA_FILTROS: { key: string; label: string }[] = [
  { key: "vec", label: "Semântica" },
  { key: "fts", label: "Texto" },
  { key: "grafo", label: "Grafo" },
];

/** Legenda de status (rodapé). */
const LEGENDA: { label: string; sub: string; dot: string }[] = [
  { label: "Fato", sub: "confirmado", dot: "var(--st-fact)" },
  { label: "Hipótese", sub: "ainda um palpite", dot: "var(--st-hypo)" },
  { label: "Arquivado", sub: "guardado", dot: "var(--st-arch)" },
];

// ---------------------------------------------------------------------------
// Tela
// ---------------------------------------------------------------------------

export default function Buscar() {
  const navigate = useNavigate();
  const { current } = useBrain();

  // termo digitado (controla o input) vs. termo submetido (dispara o retrieve)
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");

  // time-travel: toggle + data as-of (ISO yyyy-mm-dd)
  const [timeTravel, setTimeTravel] = useState(false);
  const [asOf, setAsOf] = useState("");

  // filtros client-side
  const [fStatus, setFStatus] = useState<Set<Selo["status"]>>(new Set());
  const [fVia, setFVia] = useState<Set<string>>(new Set());
  const [fFonte, setFFonte] = useState<Set<string>>(new Set());

  const effectiveAsOf = timeTravel && asOf ? asOf : undefined;

  // retrieve: só roda com query submetida. brain entra na key pra refazer ao trocar de cérebro.
  const { data, error, loading, refetch } = useQuery<RetrieveHit[]>(
    `retrieve:${current?.id ?? ""}:${query}:${effectiveAsOf ?? ""}`,
    () => (query ? api.retrieve(query, K, { asOf: effectiveAsOf }) : Promise.resolve([])),
    [current?.id, query, effectiveAsOf],
  );

  const hits = data ?? [];

  // fontes disponíveis pra filtro (derivadas dos hits — nada inventado)
  const fontesDisponiveis = useMemo(() => {
    const s = new Set<string>();
    for (const h of hits) if (h.selo?.fonte) s.add(h.selo.fonte);
    return [...s];
  }, [hits]);

  // aplica filtros client-side
  const hitsFiltrados = useMemo(() => {
    return hits.filter((h) => {
      const selo = h.selo;
      if (!selo) return false;
      if (fStatus.size && !fStatus.has(selo.status)) return false;
      if (fVia.size && !fVia.has(selo.via)) return false;
      if (fFonte.size && !fFonte.has(selo.fonte)) return false;
      return true;
    });
  }, [hits, fStatus, fVia, fFonte]);

  function submit(q: string) {
    const t = q.trim();
    setQuery(t);
    // persiste a ÚLTIMA busca (por brain) → o Painel mostra a busca REAL do usuário, não um exemplo fixo.
    if (t && current?.id) {
      try {
        localStorage.setItem(`galeed:lastSearch:${current.id}`, t);
      } catch {
        /* localStorage indisponível: ignora */
      }
    }
    // limpa filtros ao trocar de busca (fontes mudam)
    setFStatus(new Set());
    setFVia(new Set());
    setFFonte(new Set());
  }

  function onSubmitForm(e: React.FormEvent) {
    e.preventDefault();
    submit(draft);
  }

  function clickSuggestion(s: string) {
    setDraft(s);
    submit(s);
  }

  // cite → abre o ORIGINAL VERBATIM da fonte (GET /api/source, gateado pelo RBAC no BFF).
  function openSource(hit: RetrieveHit) {
    window.open(sourceUrl(hit.slug), "_blank", "noopener");
  }

  function toggle<T>(set: Set<T>, setter: (s: Set<T>) => void, key: T) {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setter(next);
  }

  const searched = query.length > 0;

  return (
    <div>
      {/* ── PAGE HEAD ──────────────────────────────────────────── */}
      <header style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: 32, fontWeight: 700, letterSpacing: "-.025em", margin: 0 }}>
          Buscar na memória
        </h1>
        <p style={{ fontSize: 14, color: "var(--muted)", margin: "6px 0 0" }}>
          Pergunte do seu jeito. Toda resposta vem com selo: de onde veio e o quanto pode confiar.
        </p>
      </header>

      {/* ── CAMPO DE BUSCA GRANDE ──────────────────────────────── */}
      <form onSubmit={onSubmitForm} style={{ display: "flex", gap: 10, alignItems: "stretch" }}>
        <SearchInput
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="preço consultoria Acme"
          autoFocus
          aria-label="Buscar na memória"
          wrapStyle={{ flex: 1 }}
          style={{ height: 48, fontSize: 16 }}
        />
        <Button type="submit" variant="primary" disabled={!draft.trim()} style={{ height: 48 }}>
          Buscar
        </Button>
      </form>

      {/* ── BARRA DE FILTROS + TIME-TRAVEL ─────────────────────── */}
      {searched && (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: 8,
            marginTop: 16,
          }}
        >
          {STATUS_FILTROS.map((f) => (
            <Chip
              key={f.key}
              dotColor={f.dot}
              active={fStatus.has(f.key)}
              onToggle={() => toggle(fStatus, setFStatus, f.key)}
            >
              {f.label}
            </Chip>
          ))}

          <span aria-hidden style={{ width: 1, height: 22, background: "var(--border)", margin: "0 4px" }} />

          {VIA_FILTROS.map((f) => (
            <Chip key={f.key} active={fVia.has(f.key)} onToggle={() => toggle(fVia, setFVia, f.key)}>
              via {f.label.toLowerCase()}
            </Chip>
          ))}

          {fontesDisponiveis.length > 0 && (
            <>
              <span aria-hidden style={{ width: 1, height: 22, background: "var(--border)", margin: "0 4px" }} />
              {fontesDisponiveis.map((src) => (
                <Chip key={src} active={fFonte.has(src)} onToggle={() => toggle(fFonte, setFFonte, src)}>
                  {src}
                </Chip>
              ))}
            </>
          )}

          {/* Viajar no tempo */}
          <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 8 }}>
            <Chip
              active={timeTravel}
              onToggle={() => setTimeTravel((v) => !v)}
              style={{ gap: 6 }}
            >
              <Icon name="clock" size={13} />
              Viajar no tempo
            </Chip>
            {timeTravel && (
              <input
                type="date"
                value={asOf}
                max={new Date().toISOString().slice(0, 10)}
                onChange={(e) => setAsOf(e.target.value)}
                aria-label="Ver como estava em"
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
            )}
          </span>
        </div>
      )}

      {/* aviso de time-travel ativo */}
      {searched && timeTravel && asOf && (
        <div
          className="mono"
          style={{
            marginTop: 12,
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
          Como a memória estava em <b style={{ color: "var(--fg)" }}>{fmtDateFull(asOf)}</b>
        </div>
      )}

      {/* ── RESULTADOS / ESTADOS ───────────────────────────────── */}
      <section style={{ marginTop: 24 }}>
        {!searched ? (
          <EstadoVazio onPick={clickSuggestion} />
        ) : loading ? (
          <EstadoCarregando />
        ) : error ? (
          <EstadoErro mensagem={error.message} onRetry={refetch} />
        ) : hits.length === 0 ? (
          <EstadoNadaEncontrado query={query} />
        ) : hitsFiltrados.length === 0 ? (
          <EstadoFiltradoVazio
            onClear={() => {
              setFStatus(new Set());
              setFVia(new Set());
              setFFonte(new Set());
            }}
          />
        ) : (
          <>
            <div className="mono" style={{ fontSize: 12, color: "var(--faint)", marginBottom: 14 }}>
              {hitsFiltrados.length}{" "}
              {hitsFiltrados.length === 1 ? "memória" : "memórias"} pra{" "}
              <b style={{ color: "var(--muted)" }}>{query}</b>
            </div>

            <div style={{ display: "grid", gap: 16, maxWidth: 600 }}>
              {hitsFiltrados.map((hit, i) => (
                <MemoryCard key={hit.slug ?? i} hit={hit} onCite={() => openSource(hit)} />
              ))}
            </div>

            <Legenda />
          </>
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Card de Memória — Seal COMPLETO acima do trecho
// ---------------------------------------------------------------------------

/** URL do original verbatim (mesma origem; cookie de sessão vai junto). */
function sourceUrl(slug: string): string {
  return `/api/source?slug=${encodeURIComponent(slug)}`;
}

function MemoryCard({ hit, onCite }: { hit: RetrieveHit; onCite: () => void }) {
  const selo = hit.selo;
  // destaque <b> no excerpt: o cliente pode já mandar <b>; aqui só renderizamos texto cru
  // de forma segura (sem dangerouslySetInnerHTML — trecho é texto, não markup confiável).
  // (título/entidade deixaram de ser clicáveis: o destino era a tela Mapa, que foi removida.)
  return (
    <Seal selo={selo} elevated citeHref={sourceUrl(hit.slug)} style={{ maxWidth: "100%" }}>
      {hit.title && (
        <div
          style={{
            marginBottom: 6,
            color: "var(--fg)",
            fontSize: 13,
            fontWeight: 600,
          }}
        >
          {hit.title}
        </div>
      )}
      <div className="quote">{hit.excerpt}</div>
      {/* o link "abrir fonte" do Seal usa citeHref="#"; interceptamos com um botão extra honesto */}
      <button
        type="button"
        onClick={onCite}
        className="mono"
        style={{
          marginTop: 10,
          padding: 0,
          border: "none",
          background: "none",
          cursor: "pointer",
          color: "var(--accent-ink)",
          fontSize: 12,
          display: "inline-flex",
          alignItems: "center",
          gap: 5,
        }}
      >
        <Icon name="arrow" size={12} />
        abrir fonte
      </button>
    </Seal>
  );
}

// ---------------------------------------------------------------------------
// Estados
// ---------------------------------------------------------------------------

/** Vazio antes de buscar: sugestões de pergunta clicáveis (nada inventado). */
function EstadoVazio({ onPick }: { onPick: (s: string) => void }) {
  return (
    <Card padding="32px 28px" style={{ maxWidth: 600 }}>
      <div style={{ display: "inline-flex", alignItems: "center", gap: 9, color: "var(--accent-ink)" }}>
        <Icon name="search" size={18} />
        <span style={{ fontSize: 17, fontWeight: 600, color: "var(--fg)" }}>
          Pergunte alguma coisa
        </span>
      </div>
      <p style={{ fontSize: 14, color: "var(--muted)", margin: "8px 0 20px", lineHeight: 1.55 }}>
        O cérebro devolve cada trecho com o selo: se é fato ou palpite, o quanto pode confiar,
        de onde veio e quem pode ver. Comece por uma dessas:
      </p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 9 }}>
        {SUGESTOES.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => onPick(s)}
            style={{
              textAlign: "left",
              padding: "10px 14px",
              border: "1px solid var(--border-strong)",
              borderRadius: 99,
              background: "var(--surface)",
              color: "var(--fg)",
              fontSize: 13.5,
              cursor: "pointer",
            }}
          >
            {s}
          </button>
        ))}
      </div>
    </Card>
  );
}

/** Carregando: skeletons no formato de cards de selo. */
function EstadoCarregando() {
  return (
    <div style={{ maxWidth: 600 }}>
      <div style={{ marginBottom: 16 }}>
        <Loading variant="thinking" label="Procurando na memória…" />
      </div>
      <div style={{ display: "grid", gap: 16 }}>
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            style={{
              border: "1px solid var(--border)",
              borderRadius: 13,
              overflow: "hidden",
              background: "var(--surface)",
            }}
          >
            {/* header do selo */}
            <div
              style={{
                display: "flex",
                gap: 10,
                alignItems: "center",
                padding: "12px 15px",
                background: "var(--surface-2)",
                borderBottom: "1px solid var(--border)",
              }}
            >
              <Skeleton width={70} height={14} radius={6} />
              <Skeleton width={64} height={14} radius={6} />
              <Skeleton width={90} height={6} radius={3} style={{ marginLeft: "auto" }} />
            </div>
            {/* corpo */}
            <div style={{ padding: "14px 16px", display: "grid", gap: 9 }}>
              <Skeleton width="40%" height={10} />
              <Skeleton width="100%" />
              <Skeleton width="85%" />
            </div>
            {/* foot */}
            <div style={{ padding: "11px 16px", borderTop: "1px solid var(--border)" }}>
              <Skeleton width="55%" height={8} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Nada encontrado — honesto, sem inventar. */
function EstadoNadaEncontrado({ query }: { query: string }) {
  return (
    <Card padding="32px 28px" style={{ maxWidth: 600 }}>
      <div style={{ fontSize: 17, fontWeight: 600 }}>Nada na memória pra essa busca</div>
      <p style={{ fontSize: 14, color: "var(--muted)", margin: "8px 0 0", lineHeight: 1.55 }}>
        O cérebro não achou nenhuma memória pra <b className="mono">{query}</b>. Tente outras
        palavras, ou jogue o material dentro pra ele organizar.
      </p>
    </Card>
  );
}

/** Filtros zeraram a lista. */
function EstadoFiltradoVazio({ onClear }: { onClear: () => void }) {
  return (
    <Card padding="28px" style={{ maxWidth: 600 }}>
      <div style={{ fontSize: 15, fontWeight: 600 }}>Nenhuma memória com esses filtros</div>
      <p style={{ fontSize: 14, color: "var(--muted)", margin: "6px 0 14px" }}>
        Há resultados, mas nenhum bate com os filtros marcados.
      </p>
      <Button size="sm" onClick={onClear}>
        Limpar filtros
      </Button>
    </Card>
  );
}

/** Erro de API. */
function EstadoErro({ mensagem, onRetry }: { mensagem: string; onRetry: () => void }) {
  return (
    <div
      role="alert"
      style={{
        maxWidth: 600,
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
        <b>Não consegui buscar agora.</b>
        <span style={{ display: "block", fontSize: 13, color: "var(--muted)", marginTop: 4 }}>
          {mensagem}
        </span>
      </span>
      <Button size="sm" onClick={onRetry}>
        Tentar de novo
      </Button>
    </div>
  );
}

/** Legenda dos status + nota de governança (cadeado = quem vê). */
function Legenda() {
  const navigate = useNavigate();
  return (
    <div
      style={{
        marginTop: 28,
        maxWidth: 600,
        padding: "16px 18px",
        borderRadius: 12,
        border: "1px solid var(--border)",
        background: "var(--surface-2)",
      }}
    >
      <div style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>
        {LEGENDA.map((l) => (
          <span key={l.label} style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 13 }}>
            <span aria-hidden style={{ width: 9, height: 9, borderRadius: "50%", background: l.dot }} />
            <b>{l.label}</b>
            <span style={{ color: "var(--muted)" }}>— {l.sub}</span>
          </span>
        ))}
      </div>
      <p style={{ fontSize: 12.5, color: "var(--muted)", margin: "12px 0 0" }}>
        Toda memória mostra de onde veio e o quanto pode confiar. O cadeado diz quem pode ver:
        Aberto, Interno, Sigiloso, Secreto.{" "}
        <button
          type="button"
          onClick={() => navigate("/app/acesso")}
          style={{
            border: "none",
            background: "none",
            padding: 0,
            cursor: "pointer",
            color: "var(--accent-ink)",
            fontSize: 12.5,
            fontWeight: 600,
          }}
        >
          Quem vê o quê →
        </button>
      </p>
    </div>
  );
}
