/** M8 — Tela Painel (Início). O console do dia a dia.
 *  Spec: specs/slots/M8/_design/painel.md · tokens: _design/00-foundation.md
 *
 *  Mostra que o cérebro está vivo e organizando sozinho: saudação + slug do tenant,
 *  banner FTS condicional, 4 KPIs (/api/stats), "Organizando agora" (dois tempos),
 *  feed "O que entrou", AskCard (atalho → /app/perguntar), e a assinatura
 *  "Última busca" com o componente Seal (hits reais de /api/retrieve).
 *
 *  REGRA DE OURO: nunca inventar número. Onde a API não dá série temporal
 *  (deltas) ou endpoint de fila/atividade, mostramos estado vazio HONESTO,
 *  rotulado — jamais um valor fake.
 */
import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import {
  Button,
  Card,
  Icon,
  KpiTile,
  Seal,
  SearchInput,
  Skeleton,
  type Selo as UiSelo,
} from "../../ui";
import { INGEST_NAO_TERMINAIS, api, type GraphNode, type IngestJob, type RetrieveHit, type Stats } from "../../lib/api";
import { useAuth, useBrain } from "../../lib/auth";
import { useQuery } from "../../lib/useQuery";
import { fmtNumber } from "../../lib/format";

/** Última busca REAL do usuário (persistida pela tela Buscar, por brain). "" = ainda não buscou. */
function readLastSearch(brainId?: string): string {
  if (!brainId) return "";
  try {
    return localStorage.getItem(`galeed:lastSearch:${brainId}`) || "";
  } catch {
    return "";
  }
}

// chips de exemplo do AskCard — o ESPECTRO do cérebro, não só número (decisão · compromisso · mercado)
const ASK_CHIPS = ["O que decidimos e por quê?", "Quais compromissos estão em aberto?", "O que sabemos dos concorrentes?"];

export default function Painel() {
  const navigate = useNavigate();
  const { session } = useAuth();
  const { current } = useBrain();

  // primeiro nome do usuário logado, senão "você"
  const fullName = session?.account?.name?.trim();
  const firstName = fullName ? fullName.split(/\s+/)[0] : "você";
  const slug = current?.name ?? "";

  // --- dados ----------------------------------------------------------------
  const stats = useQuery<Stats>("painel:stats", (signal) => fetchStats(signal), [current?.id]);
  const graph = useQuery("painel:graph-top", (signal) => fetchGraphTop(signal), [current?.id]);
  // fila de ingestão REAL (mesmo endpoint da tela Adicionar) — alimenta "Organizando agora"
  // e "O que entrou". Re-consulta a cada 5s enquanto o Painel está aberto.
  const jobs = useQuery<IngestJob[]>("painel:jobs", () => api.ingest.jobs(), [current?.id]);
  useEffect(() => {
    const t = setInterval(() => jobs.refetch(), 5000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id]);
  // lista canônica de não-terminais (lib/api.ts) — inclui batch_submitted/batch_harvesting; antes o
  // job de lote (que pode levar horas) sumia do contador "na fila pra organizar" sem aparecer em done.
  const naFila = jobs.data ? jobs.data.filter((j) => INGEST_NAO_TERMINAIS.includes(j.status)).length : null;
  const entraram = (jobs.data ?? [])
    .filter((j) => j.status === "done")
    .sort((a, b) => (b.finishedAt ?? b.createdAt).localeCompare(a.finishedAt ?? a.createdAt))
    .slice(0, 5);
  const lastQuery = readLastSearch(current?.id);
  const lastSearch = useQuery<RetrieveHit[]>(
    `painel:retrieve:${current?.id ?? ""}:${lastQuery}`,
    (signal) => (lastQuery ? fetchRetrieve(lastQuery, signal) : Promise.resolve([])),
    [current?.id, lastQuery],
  );

  // modo FTS = sem embeddings indexados (vectors == 0) → banner âmbar
  const ftsMode = stats.data ? stats.data.vectors === 0 : false;

  // cérebro novo / vazio = stats carregou e está tudo zerado
  const isEmptyBrain =
    !stats.loading &&
    !stats.error &&
    !!stats.data &&
    stats.data.pages === 0 &&
    stats.data.facts === 0 &&
    stats.data.edges === 0;

  const [ask, setAsk] = useState("");

  function goAsk(q: string) {
    const query = q.trim();
    if (!query) return;
    navigate(`/app/perguntar?q=${encodeURIComponent(query)}`);
  }
  function onAskSubmit(e: FormEvent) {
    e.preventDefault();
    goAsk(ask);
  }

  return (
    <div>
      {/* PAGE HEAD --------------------------------------------------------- */}
      <header
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 16,
          flexWrap: "wrap",
          marginBottom: 18,
        }}
      >
        <div>
          <h1 style={{ fontSize: 32, fontWeight: 700, letterSpacing: "-.025em", margin: 0 }}>
            Olá, {firstName} <span aria-hidden>👋</span>
          </h1>
          <p className="muted" style={{ fontSize: 14, marginTop: 6 }}>
            {slug ? (
              <>
                O cérebro <b className="mono" style={{ color: "var(--muted)" }}>{slug}</b> está vivo e
                organizando sozinho.
              </>
            ) : (
              "O cérebro está vivo e organizando sozinho."
            )}
          </p>
        </div>
        <div style={{ display: "inline-flex", gap: 10 }}>
          <Button
            variant="secondary"
            icon={<Icon name="search" size={15} />}
            onClick={() => navigate("/app/buscar")}
          >
            Buscar
          </Button>
          <Button
            variant="primary"
            icon={<Icon name="plus" size={15} />}
            onClick={() => navigate("/app/adicionar")}
          >
            Jogar algo dentro
          </Button>
        </div>
      </header>

      {/* BANNER FTS (condicional: sem chave de IA / sem embeddings) --------- */}
      {ftsMode && <FtsHint />}

      {/* ERRO de stats — banner útil, mantém o resto navegável --------------- */}
      {stats.error && <ErrorBanner message="Não consegui carregar os números do cérebro." onRetry={stats.refetch} />}

      {/* CÉREBRO NOVO / VAZIO → CTA de onboarding (substitui grid + selo) ---- */}
      {isEmptyBrain ? (
        <EmptyBrainCta onStart={() => navigate("/app/adicionar")} />
      ) : (
        <>
          {/* LINHA DE KPIs (4) ------------------------------------------- */}
          <section
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(4, 1fr)",
              gap: 14,
              marginBottom: 20,
            }}
            className="painel-kpis"
          >
            {stats.loading
              ? Array.from({ length: 4 }).map((_, i) => <KpiSkeleton key={i} />)
              : (
                  <>
                    <KpiTile label="Coisas que você jogou" value={fmtNumber(stats.data?.pages)} />
                    <KpiTile label="Fatos organizados" value={fmtNumber(stats.data?.facts)} />
                    <KpiTile label="Conexões entre coisas" value={fmtNumber(stats.data?.edges)} />
                    {/* entidades: derivado do grafo (nº de nós). oculta se a API não der. */}
                    {graph.data != null && (
                      <KpiTile label="Pessoas e empresas" value={fmtNumber(graph.data.count)} />
                    )}
                  </>
                )}
          </section>

          {/* GRID PRINCIPAL (1.55fr / 1fr) ------------------------------- */}
          <section
            style={{
              display: "grid",
              gridTemplateColumns: "1.55fr 1fr",
              gap: 18,
              alignItems: "start",
              marginBottom: 28,
            }}
            className="painel-grid"
          >
            {/* COLUNA ESQUERDA */}
            <div style={{ display: "grid", gap: 18 }}>
              <OrganizandoAgora
                facts={stats.data?.facts ?? null}
                fila={naFila}
                loading={stats.loading}
              />
              <OQueEntrou jobs={entraram} />
              {(graph.data?.top.length ?? 0) > 0 && <SobreQuemSabe nodes={graph.data!.top} />}
            </div>

            {/* COLUNA DIREITA */}
            <div style={{ display: "grid", gap: 18 }}>
              <AskCard
                value={ask}
                onChange={setAsk}
                onSubmit={onAskSubmit}
                onChip={(c) => goAsk(c)}
              />
            </div>
          </section>

          {/* ÚLTIMA BUSCA + SELO (assinatura) ---------------------------- */}
          <UltimaBusca
            query={lastQuery}
            hits={lastSearch.data}
            loading={lastSearch.loading}
            error={lastSearch.error}
            onRetry={lastSearch.refetch}
            onSuggest={() => (lastQuery ? goAsk(lastQuery) : navigate("/app/buscar"))}
            onAccess={() => navigate("/app/acesso")}
          />
        </>
      )}

      {/* CSS responsivo (≤1080px → KPIs 2 col, grid 1 col) */}
      <style>{`
        @media (max-width: 1080px) {
          .painel-kpis { grid-template-columns: repeat(2, 1fr) !important; }
          .painel-grid { grid-template-columns: 1fr !important; }
        }
      `}</style>
    </div>
  );
}

// ===========================================================================
// Fetchers (com AbortSignal)
// ===========================================================================

function fetchStats(signal?: AbortSignal): Promise<Stats> {
  void signal;
  return api.stats();
}

/** entidades do grafo: contagem (KPI) + top por nº de fatos (card "Sobre quem o cérebro mais
 *  sabe" — cada uma abre o DOSSIÊ). Devolve null se o endpoint não der (oculta, não inventa). */
async function fetchGraphTop(signal?: AbortSignal): Promise<{ count: number; top: GraphNode[] } | null> {
  void signal;
  try {
    const g = await api.graph();
    if (!g?.nodes) return null;
    const top = [...g.nodes]
      .filter((n) => (n.factCount ?? 0) > 0)
      .sort((a, b) => (b.factCount ?? 0) - (a.factCount ?? 0))
      .slice(0, 6);
    return { count: g.nodes.length, top };
  } catch {
    return null;
  }
}

function fetchRetrieve(q: string, signal?: AbortSignal): Promise<RetrieveHit[]> {
  void signal;
  return api.retrieve(q, 2);
}

// ===========================================================================
// Sub-componentes
// ===========================================================================

function FtsHint() {
  return (
    <div
      role="status"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "10px 14px",
        marginBottom: 18,
        borderRadius: 10,
        background: "var(--st-hypo-soft)",
        border: "1px solid var(--st-hypo)",
        color: "var(--fg)",
        fontSize: 13.5,
      }}
    >
      <span aria-hidden style={{ color: "var(--st-hypo)", display: "grid", placeItems: "center" }}>
        <Icon name="info" size={17} />
      </span>
      {/* honesto: a chave entra no .env do SERVIDOR — não existe tela pra colar chave.
          (o link antigo mandava pra /app/conectar, que não tem onde configurar IA — beco) */}
      <span style={{ flex: 1 }}>
        Busca por palavra-chave ligada. Pra busca semântica, adicione{" "}
        <code className="mono" style={{ fontSize: 12 }}>OPENAI_API_KEY</code> no .env do servidor e
        reinicie.
      </span>
    </div>
  );
}

function ErrorBanner({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div
      role="alert"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "10px 14px",
        marginBottom: 18,
        borderRadius: 10,
        background: "var(--sn-secret-soft)",
        border: "1px solid var(--danger)",
        color: "var(--fg)",
        fontSize: 13.5,
      }}
    >
      <span aria-hidden style={{ color: "var(--danger)", display: "grid", placeItems: "center" }}>
        <Icon name="info" size={17} />
      </span>
      <span style={{ flex: 1 }}>{message}</span>
      <Button size="sm" variant="secondary" onClick={onRetry}>
        Tentar de novo
      </Button>
    </div>
  );
}

function KpiSkeleton() {
  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: 11,
        padding: "13px 15px",
        minWidth: 120,
        background: "var(--surface)",
      }}
    >
      <Skeleton width={70} height={20} radius={4} />
      <Skeleton width={110} style={{ marginTop: 12 }} />
    </div>
  );
}

function EmptyBrainCta({ onStart }: { onStart: () => void }) {
  return (
    <Card style={{ maxWidth: 560, margin: "24px auto", textAlign: "center", padding: "40px 32px" }}>
      <h2 style={{ fontSize: 24, fontWeight: 600, letterSpacing: "-.02em", marginBottom: 10 }}>
        Seu cérebro está pronto pra começar
      </h2>
      <p className="muted" style={{ fontSize: 15, lineHeight: 1.5, marginBottom: 22 }}>
        Você joga as coisas dentro. Ele organiza sozinho. Aí é só perguntar.
      </p>
      <Button variant="primary" icon={<Icon name="plus" size={15} />} onClick={onStart}>
        Jogar algo dentro
      </Button>
    </Card>
  );
}

// --- 5a. Organizando agora (dois tempos: fila → fato) ----------------------

function OrganizandoAgora({
  facts,
  fila,
  loading,
}: {
  facts: number | null;
  fila: number | null;
  loading: boolean;
}) {
  return (
    <Card
      header={
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8, fontWeight: 600 }}>
            <span
              aria-hidden
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: "var(--accent)",
                animation: "skeleton-pulse 1.6s ease-in-out infinite",
              }}
            />
            Organizando agora
          </span>
          <span className="mono faint" style={{ fontSize: 11 }}>
            tempo real
          </span>
        </div>
      }
    >
      <div style={{ display: "flex", alignItems: "center", gap: 18, flexWrap: "wrap" }}>
        {/* estágio A — fila REAL (/api/ingest/jobs, mesmo dado da tela Adicionar). */}
        <Stage
          colorVar="--st-reg"
          value={loading ? null : fila}
          label="na fila pra organizar"
          honest="nada na fila agora"
        />
        <span aria-hidden style={{ color: "var(--faint)" }}>
          <Icon name="arrow" size={18} />
        </span>
        {/* estágio B — já virou fato (facts de /api/stats) */}
        <Stage
          colorVar="--accent"
          value={loading ? null : facts}
          label="já viraram fato"
        />
      </div>
      <div
        style={{
          marginTop: 14,
          height: 5,
          borderRadius: 99,
          background: "var(--border)",
          overflow: "hidden",
        }}
        aria-hidden
      >
        <i
          style={{
            display: "block",
            height: "100%",
            width: "100%",
            background: "var(--accent)",
            opacity: 0.55,
          }}
        />
      </div>
      <div
        className="mono"
        style={{
          marginTop: 12,
          display: "flex",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
          fontSize: 11,
          color: "var(--faint)",
        }}
      >
        <span style={{ fontFamily: "var(--font)" }}>O cérebro lê, separa e carimba cada coisa sozinho.</span>
      </div>
    </Card>
  );
}

function Stage({
  colorVar,
  value,
  label,
  honest,
}: {
  colorVar: string;
  value: number | null;
  label: string;
  honest?: string;
}) {
  const showHonest = value === 0 && honest;
  return (
    <div style={{ minWidth: 110 }}>
      {value === null ? (
        <Skeleton width={56} height={26} radius={6} />
      ) : (
        <b className="mono" style={{ fontSize: 30, fontWeight: 600, lineHeight: 1, color: `var(${colorVar})` }}>
          {fmtNumber(value)}
        </b>
      )}
      <div className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>
        {showHonest ? honest : label}
      </div>
    </div>
  );
}

// --- 5b. O que entrou (atividade recente) ----------------------------------
// Ingestões concluídas de /api/ingest/jobs (mesmo dado da tela Adicionar); vazio → estado honesto.

function OQueEntrou({ jobs }: { jobs: IngestJob[] }) {
  return (
    <Card
      header={
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
          <span style={{ fontWeight: 600 }}>
            O que entrou{" "}
            <span className="faint" style={{ fontWeight: 400, fontSize: 12.5 }}>
              últimas fontes
            </span>
          </span>
        </div>
      }
    >
      {jobs.length === 0 ? (
        <div
          style={{
            display: "grid",
            placeItems: "center",
            textAlign: "center",
            gap: 6,
            padding: "20px 8px",
            color: "var(--muted)",
          }}
        >
          <span aria-hidden style={{ color: "var(--faint)" }}>
            <Icon name="info" size={22} />
          </span>
          <div style={{ fontSize: 14, fontWeight: 600, color: "var(--fg)" }}>Nada novo ainda</div>
          <p className="muted" style={{ fontSize: 13, maxWidth: 320, margin: 0 }}>
            Quando você jogar algo dentro, as fontes aparecem aqui enquanto o cérebro organiza.
          </p>
        </div>
      ) : (
        <div style={{ display: "grid", gap: 10 }}>
          {jobs.map((j) => (
            <div key={j.id} style={{ display: "flex", alignItems: "baseline", gap: 10, fontSize: 13 }}>
              <span
                aria-hidden
                style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--accent)", flexShrink: 0, transform: "translateY(-1px)" }}
              />
              <span style={{ fontWeight: 600, color: "var(--fg)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {j.filename ?? "Texto colado"}
              </span>
              <span className="muted" style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {j.message ?? "organizado"}
              </span>
              <span className="mono faint" style={{ fontSize: 11, flexShrink: 0 }}>
                {horaLocal(j.finishedAt ?? j.createdAt)}
              </span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

/** "14:32" — hora local curta do timestamp ISO (dia omitido; o feed é do dia a dia). */
function horaLocal(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

// --- 5b². Sobre quem o cérebro mais sabe (top entidades → DOSSIÊ) -----------

function SobreQuemSabe({ nodes }: { nodes: GraphNode[] }) {
  const navigate = useNavigate();
  const tipo = (role?: string) => (role === "org" ? "empresa" : role === "pessoa" ? "pessoa" : "tema");
  return (
    <Card
      header={
        <span style={{ fontWeight: 600 }}>
          Sobre quem o cérebro mais sabe{" "}
          <span className="faint" style={{ fontWeight: 400, fontSize: 12.5 }}>cada um abre o dossiê</span>
        </span>
      }
    >
      <div style={{ display: "grid", gap: 8 }}>
        {nodes.map((n) => (
          <button
            key={n.id}
            type="button"
            onClick={() => navigate(`/app/dossie/${encodeURIComponent(n.id)}`)}
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: 10,
              width: "100%",
              padding: "6px 8px",
              border: "none",
              borderRadius: 8,
              background: "none",
              cursor: "pointer",
              textAlign: "left",
              fontSize: 13.5,
            }}
          >
            <span style={{ fontWeight: 600, color: "var(--accent-ink)" }}>{n.label || n.id}</span>
            <span className="faint" style={{ fontSize: 11.5 }}>{tipo(n.role)}</span>
            <span style={{ flex: 1 }} />
            <span className="mono faint" style={{ fontSize: 11.5 }}>{n.factCount} fatos</span>
          </button>
        ))}
      </div>
    </Card>
  );
}

// --- 5c. Pergunte ao cérebro (AskCard, card escuro) ------------------------

function AskCard({
  value,
  onChange,
  onSubmit,
  onChip,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (e: FormEvent) => void;
  onChip: (c: string) => void;
}) {
  return (
    <div
      style={{
        background: "var(--ink)",
        borderRadius: 13,
        padding: "18px 20px",
      }}
    >
      <h3 style={{ fontSize: 18, fontWeight: 600, color: "#fff", margin: 0, display: "flex", gap: 8 }}>
        <span aria-hidden>⟡</span> Pergunte ao cérebro
      </h3>
      <p style={{ fontSize: 13.5, lineHeight: 1.5, color: "oklch(82% 0.015 240)", marginTop: 8 }}>
        Escreva como você falaria com uma pessoa. A resposta sempre vem com a fonte.
      </p>
      <form onSubmit={onSubmit} style={{ display: "flex", gap: 8, marginTop: 14 }}>
        <SearchInput
          value={value}
          onChange={(e) => onChange(e.currentTarget.value)}
          placeholder="Qual o preço que combinamos com a Acme?"
          icon={<Icon name="search" size={16} />}
          aria-label="Pergunte ao cérebro"
          wrapStyle={{ flex: 1 }}
        />
        <Button type="submit" variant="primary" aria-label="Perguntar" style={{ flexShrink: 0 }}>
          <Icon name="arrow" size={16} />
        </Button>
      </form>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 7, marginTop: 12 }}>
        {ASK_CHIPS.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => onChip(c)}
            className="mono"
            style={{
              fontSize: 11.5,
              fontFamily: "var(--font)",
              color: "oklch(82% 0.015 240)",
              background: "transparent",
              border: "1px solid oklch(40% 0.02 240)",
              borderRadius: 99,
              padding: "5px 11px",
              cursor: "pointer",
            }}
          >
            {c}
          </button>
        ))}
      </div>
    </div>
  );
}


// --- 6. Última busca + selo (assinatura do produto) ------------------------

function UltimaBusca({
  query,
  hits,
  loading,
  error,
  onRetry,
  onSuggest,
  onAccess,
}: {
  query: string;
  hits: RetrieveHit[] | null;
  loading: boolean;
  error: Error | null;
  onRetry: () => void;
  onSuggest: () => void;
  onAccess: () => void;
}) {
  return (
    <section>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
          marginBottom: 14,
        }}
      >
        <h2 style={{ fontSize: 24, fontWeight: 600, letterSpacing: "-.02em", margin: 0 }}>Última busca</h2>
        {query ? (
          <span
            className="mono"
            style={{
              fontSize: 12,
              color: "var(--muted)",
              background: "var(--surface-2)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              padding: "3px 9px",
            }}
          >
            {query}
          </span>
        ) : null}
      </div>

      {error ? (
        <ErrorBanner message="Não consegui rodar a última busca." onRetry={onRetry} />
      ) : loading ? (
        <div style={{ display: "grid", gap: 14 }}>
          <Skeleton width="100%" height={120} radius={13} />
          <Skeleton width="100%" height={120} radius={13} />
        </div>
      ) : !hits || hits.length === 0 ? (
        <EmptySearch onSuggest={onSuggest} query={query} />
      ) : (
        <div style={{ display: "grid", gap: 14, maxWidth: 560 }}>
          {hits.map((h, i) => (
            <Seal key={`${h.slug}-${i}`} selo={toUiSelo(h)} citeHref="#">
              <Excerpt text={h.excerpt} />
            </Seal>
          ))}
        </div>
      )}

      {/* Legenda + nota de governança (RBAC) — só com resultados reais */}
      {!loading && !error && hits && hits.length > 0 && (
        <>
          <Legend />
          <GovernanceNote onAccess={onAccess} />
        </>
      )}
    </section>
  );
}

/** Mapeia o hit do retrieve para o shape de selo do componente Ui. */
function toUiSelo(h: RetrieveHit): UiSelo {
  const s = h.selo;
  return {
    status: s.status,
    confidence: s.confidence,
    tipo: s.tipo,
    fonte: s.fonte,
    valid_from: s.valid_from,
    valid_to: s.valid_to,
    supersede: s.supersede ?? null,
    tags: s.tags ?? [],
    via: s.via,
    cite: s.cite,
    sensitivity: s.sensitivity,
  };
}

/** Realça os trechos entre **asteriscos** (ou só texto cru). */
function Excerpt({ text }: { text: string }) {
  if (!text) return null;
  const parts = text.split(/\*\*(.+?)\*\*/g);
  return (
    <>
      {parts.map((p, i) => (i % 2 === 1 ? <b key={i}>{p}</b> : <span key={i}>{p}</span>))}
    </>
  );
}

function EmptySearch({ onSuggest, query }: { onSuggest: () => void; query: string }) {
  const semBusca = !query.trim();
  return (
    <Card style={{ maxWidth: 560, padding: "28px 24px", textAlign: "center" }}>
      <p className="muted" style={{ fontSize: 14, marginBottom: 16 }}>
        {semBusca
          ? "Você ainda não fez nenhuma busca neste cérebro. Sua última busca aparece aqui."
          : `Nada encontrado para “${query}”.`}
      </p>
      <Button variant="primary" icon={<Icon name="search" size={15} />} onClick={onSuggest}>
        {semBusca ? "Fazer uma busca" : `Perguntar: ${query}`}
      </Button>
    </Card>
  );
}

function Legend() {
  const items: Array<{ label: string; hint: string; dot: string }> = [
    { label: "Fato", hint: "confirmado", dot: "var(--st-fact)" },
    { label: "Hipótese", hint: "ainda um palpite", dot: "var(--st-hypo)" },
    { label: "Organizando", hint: "chegando agora", dot: "var(--st-reg)" },
    { label: "Arquivado", hint: "guardado", dot: "var(--st-arch)" },
  ];
  return (
    <div
      style={{
        maxWidth: 560,
        marginTop: 16,
        padding: "14px 16px",
        border: "1px solid var(--border)",
        borderRadius: 12,
        background: "var(--surface)",
      }}
    >
      <div style={{ display: "flex", flexWrap: "wrap", gap: 14 }}>
        {items.map((it) => (
          <span key={it.label} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5 }}>
            <span aria-hidden style={{ width: 8, height: 8, borderRadius: "50%", background: it.dot }} />
            <b>{it.label}</b>
            <span className="faint">{it.hint}</span>
          </span>
        ))}
      </div>
      <p className="faint" style={{ fontSize: 12, marginTop: 10, marginBottom: 0 }}>
        Toda memória mostra de onde veio e o quanto pode confiar.
      </p>
    </div>
  );
}

function GovernanceNote({ onAccess }: { onAccess: () => void }) {
  return (
    <div
      style={{
        maxWidth: 560,
        marginTop: 12,
        padding: "12px 16px",
        borderLeft: "3px solid var(--sn-conf)",
        background: "var(--sn-conf-soft)",
        borderRadius: 8,
        fontSize: 13,
        color: "var(--fg)",
      }}
    >
      Respondi com o que você pode ver.{" "}
      <button
        type="button"
        onClick={onAccess}
        style={{ background: "none", border: "none", color: "var(--accent-ink)", fontWeight: 600, cursor: "pointer", padding: 0 }}
      >
        Ver acesso →
      </button>
    </div>
  );
}
