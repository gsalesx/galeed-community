/** M8 — Tela Saúde (Observabilidade). O painel de infra do cérebro.
 *  Renderiza dentro do AppShell (export default sem props).
 *
 *  Espelha o dashboard de infra estilo Zep: separa o HOT path (leitura, ms — o
 *  caminho quente que o usuário sente) do COLD path (organização, batch — o
 *  trabalho de fundo). Mostra SÓ o que dá pra medir de verdade:
 *
 *   1. PAGE HEAD "Saúde"
 *   2. STATUS DO SISTEMA — badge OK/erro a partir de /api/health (liveness real)
 *   3. KPIs DO BRAIN — /api/stats (pages/facts/edges/vectors), números reais
 *   4. LATÊNCIA DE LEITURA (amostra) — tempo REAL medido no cliente
 *      (performance.now() antes/depois de uma chamada api.stats) — rotulado
 *      "amostra", "sem série histórica ainda". NÃO inventamos p50/p95.
 *   5. HOT path vs COLD path — separação visual explicativa
 *   6. THROUGHPUT / TAXA DE ERRO — "sem dados ainda" honesto (sem séries fake)
 *
 *  REGRA DE OURO: só métrica mensurável de verdade. O resto = estado
 *  "ainda não medido" rotulado. Jamais um número inventado.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Card, Chip, Icon, KpiTile, Skeleton } from "../../ui";
import { ApiError, api, type CostRollup, type Stats } from "../../lib/api";
import { useBrain } from "../../lib/auth";
import { useQuery } from "../../lib/useQuery";
import { fmtNumber } from "../../lib/format";
import PercepcoesCard from "./Percepcoes";
import SonoCard from "./Sono";
import LixeiraCard from "./Lixeira";

// resultado da sonda de liveness (/api/health → { ok: true })
interface Health {
  ok: boolean;
}

// uma amostra de latência: chamada real cronometrada no cliente.
interface LatencySample {
  ms: number; // performance.now() depois - antes
  at: number; // timestamp da medição (Date.now())
}

export default function Saude() {
  const { current } = useBrain();
  const slug = current?.name ?? "";

  // --- dados reais ----------------------------------------------------------
  // liveness: /api/health não é tenant (sonda de processo); fetch direto.
  const health = useQuery<Health>("saude:health", (signal) => fetchHealth(signal), []);
  // números do brain: /api/stats (tenant — re-busca ao trocar de cérebro).
  const stats = useQuery<Stats>("saude:stats", () => api.stats(), [current?.id]);
  // custo de extração: /api/cost — SÓ OWNER (D4). 403 = member → escondemos graciosamente.
  const cost = useQuery<CostRollup>("saude:cost", () => api.cost(), [current?.id]);

  // --- latência observada (medida no cliente) -------------------------------
  // cronometramos UMA chamada real de leitura (api.stats) com performance.now().
  // É uma amostra honesta da última leitura — não uma série histórica.
  const [latency, setLatency] = useState<LatencySample | null>(null);
  const [measuring, setMeasuring] = useState(false);
  const [latError, setLatError] = useState(false);
  const ranOnce = useRef(false);

  const measure = useCallback(async () => {
    setMeasuring(true);
    setLatError(false);
    const t0 = performance.now();
    try {
      await api.stats();
      const ms = performance.now() - t0;
      setLatency({ ms, at: Date.now() });
    } catch {
      setLatError(true);
    } finally {
      setMeasuring(false);
    }
  }, []);

  // mede uma vez no mount e sempre que o cérebro mudar.
  useEffect(() => {
    ranOnce.current = true;
    void measure();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id]);

  const systemOk = !health.loading && !health.error && health.data?.ok === true;
  const systemDown = !health.loading && (!!health.error || health.data?.ok === false);

  // cérebro vazio = stats carregou tudo zerado (sem tráfego pra observar)
  const isEmptyBrain =
    !stats.loading &&
    !stats.error &&
    !!stats.data &&
    stats.data.pages === 0 &&
    stats.data.facts === 0 &&
    stats.data.edges === 0;

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
          <h1 style={{ fontSize: 32, fontWeight: 700, letterSpacing: "-.025em", margin: 0 }}>Saúde</h1>
          <p className="muted" style={{ fontSize: 14, marginTop: 6 }}>
            {slug ? (
              <>
                Como o cérebro <b className="mono" style={{ color: "var(--muted)" }}>{slug}</b> está
                respondendo, por dentro.
              </>
            ) : (
              "Como o cérebro está respondendo, por dentro."
            )}
          </p>
        </div>
        <SystemBadge ok={systemOk} down={systemDown} loading={health.loading} onRetry={health.refetch} />
      </header>

      {/* KPIs DO BRAIN (4) — números reais de /api/stats ------------------- */}
      <section
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, 1fr)",
          gap: 14,
          marginBottom: 20,
        }}
        className="saude-kpis"
      >
        {stats.loading ? (
          Array.from({ length: 4 }).map((_, i) => <KpiSkeleton key={i} />)
        ) : stats.error ? (
          <div style={{ gridColumn: "1 / -1" }}>
            <ErrorBanner message="Não consegui ler os números do cérebro." onRetry={stats.refetch} />
          </div>
        ) : (
          <>
            <KpiTile label="Fontes guardadas" value={fmtNumber(stats.data?.pages)} />
            <KpiTile label="Fatos organizados" value={fmtNumber(stats.data?.facts)} />
            <KpiTile label="Conexões" value={fmtNumber(stats.data?.edges)} />
            <KpiTile label="Vetores indexados" value={fmtNumber(stats.data?.vectors)} />
          </>
        )}
      </section>

      {/* PERCEPÇÕES (M24-E) — o item mais "produto" da tela: vem antes da infra. */}
      <div style={{ marginBottom: 18 }}>
        <PercepcoesCard />
      </div>

      {/* SONO E MEMÓRIA + LIXEIRA — o estado real que era invisível: quando o cérebro dormiu,
          o que fez (fases/falhas/podáveis), o peso da memória e o que foi arquivado (reversível). */}
      <section
        style={{
          display: "grid",
          gridTemplateColumns: "1.1fr 1fr",
          gap: 18,
          alignItems: "start",
          marginBottom: 18,
        }}
        className="saude-grid"
      >
        <SonoCard />
        <LixeiraCard />
      </section>

      {/* GRID: latência (esquerda) + hot/cold (direita) -------------------- */}
      <section
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1.1fr",
          gap: 18,
          alignItems: "start",
          marginBottom: 18,
        }}
        className="saude-grid"
      >
        <LatencyCard
          sample={latency}
          measuring={measuring}
          error={latError}
          onRemeasure={measure}
        />
        <HotColdCard
          vectors={stats.data?.vectors ?? null}
          loading={stats.loading}
        />
      </section>

      {/* CUSTO DE EXTRAÇÃO — só owner (/api/cost). Member (403) → some sem ruído. */}
      <CostCard
        data={cost.data}
        loading={cost.loading}
        error={cost.error}
        onRetry={cost.refetch}
      />

      {/* THROUGHPUT / TAXA DE ERRO — sem série histórica ainda (honesto) --- */}
      <NotMeasuredYet empty={isEmptyBrain} />

      {/* CSS responsivo (≤1080px → KPIs 2 col, grid 1 col) */}
      <style>{`
        @media (max-width: 1080px) {
          .saude-kpis { grid-template-columns: repeat(2, 1fr) !important; }
          .saude-grid { grid-template-columns: 1fr !important; }
        }
      `}</style>
    </div>
  );
}

// ===========================================================================
// Fetchers
// ===========================================================================

/** /api/health — liveness do processo (não toca DB, não é tenant). */
async function fetchHealth(signal?: AbortSignal): Promise<Health> {
  const res = await fetch("/api/health", { credentials: "include", signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = (await res.json()) as Partial<Health>;
  return { ok: j?.ok === true };
}

// ===========================================================================
// Sub-componentes
// ===========================================================================

/** Badge de status do sistema, a partir de /api/health. */
function SystemBadge({
  ok,
  down,
  loading,
  onRetry,
}: {
  ok: boolean;
  down: boolean;
  loading: boolean;
  onRetry: () => void;
}) {
  if (loading) {
    return (
      <div
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 9,
          padding: "8px 14px",
          borderRadius: 10,
          border: "1px solid var(--border)",
          background: "var(--surface)",
        }}
      >
        <Skeleton width={9} height={9} radius={99} />
        <Skeleton width={90} height={11} />
      </div>
    );
  }

  if (down) {
    return (
      <div
        role="alert"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 10,
          padding: "7px 12px",
          borderRadius: 10,
          border: "1px solid var(--danger)",
          background: "var(--sn-secret-soft)",
          color: "var(--fg)",
        }}
      >
        <span aria-hidden style={{ width: 9, height: 9, borderRadius: "50%", background: "var(--danger)" }} />
        <span style={{ fontSize: 13, fontWeight: 600 }}>Sistema fora do ar</span>
        <Button size="sm" variant="secondary" onClick={onRetry} style={{ marginLeft: 4 }}>
          Verificar
        </Button>
      </div>
    );
  }

  return (
    <div
      role="status"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 9,
        padding: "8px 14px",
        borderRadius: 10,
        border: "1px solid oklch(88% 0.04 150)",
        background: "var(--st-fact-soft)",
        color: "var(--st-fact)",
      }}
    >
      <span
        aria-hidden
        style={{
          width: 9,
          height: 9,
          borderRadius: "50%",
          background: ok ? "var(--st-fact)" : "var(--st-reg)",
          boxShadow: ok ? "0 0 0 4px var(--st-fact-soft)" : undefined,
        }}
      />
      <span style={{ fontSize: 13, fontWeight: 600 }}>Sistema no ar</span>
      <span className="mono faint" style={{ fontSize: 10.5 }}>/api/health</span>
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

function ErrorBanner({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div
      role="alert"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "10px 14px",
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

// --- Latência de leitura (amostra) -----------------------------------------
// Tempo REAL de uma chamada api.stats, cronometrado com performance.now() no
// cliente. É a latência observada da ÚLTIMA leitura — uma amostra, não uma
// série. Deixamos isso explícito: "amostra" + "sem série histórica ainda".

function LatencyCard({
  sample,
  measuring,
  error,
  onRemeasure,
}: {
  sample: LatencySample | null;
  measuring: boolean;
  error: boolean;
  onRemeasure: () => void;
}) {
  return (
    <Card
      header={
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8, fontWeight: 600 }}>
            <Icon name="clock" size={15} />
            Latência de leitura
            <span
              className="mono"
              style={{
                fontSize: 10,
                fontWeight: 600,
                letterSpacing: ".03em",
                textTransform: "uppercase",
                color: "var(--st-reg)",
                background: "var(--st-reg-soft)",
                borderRadius: 6,
                padding: "2px 7px",
              }}
            >
              amostra
            </span>
          </span>
          <span className="mono faint" style={{ fontSize: 11 }}>HOT path</span>
        </div>
      }
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, minHeight: 36 }}>
        {measuring ? (
          <Skeleton width={90} height={30} radius={6} />
        ) : error ? (
          <span style={{ fontSize: 15, color: "var(--danger)", fontWeight: 600 }}>falha ao medir</span>
        ) : sample ? (
          <>
            <b className="mono" style={{ fontSize: 34, fontWeight: 600, lineHeight: 1, color: "var(--accent)" }}>
              {Math.round(sample.ms)}
            </b>
            <span className="mono muted" style={{ fontSize: 14 }}>ms</span>
          </>
        ) : (
          <span className="muted" style={{ fontSize: 14 }}>—</span>
        )}
      </div>

      <p className="muted" style={{ fontSize: 12.5, lineHeight: 1.5, marginTop: 12, marginBottom: 0 }}>
        Tempo real da <b>última</b> chamada de leitura, medido aqui no navegador
        (<span className="mono">performance.now()</span> em volta de <span className="mono">/api/stats</span>).
      </p>
      <p className="faint" style={{ fontSize: 12, lineHeight: 1.5, marginTop: 8, marginBottom: 0 }}>
        É uma amostra pontual — <b>sem série histórica ainda</b>. p50/p95 ao longo
        do tempo virão quando houver coleta no servidor.
      </p>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginTop: 14 }}>
        <Button size="sm" variant="secondary" onClick={onRemeasure} disabled={measuring}>
          Medir de novo
        </Button>
      </div>
    </Card>
  );
}

// --- HOT path vs COLD path (explicativo) -----------------------------------
// Separação visual de como o produto funciona por dentro, estilo Zep:
//   HOT  = leitura, síncrono, milissegundos (o que o usuário sente)
//   COLD = organização, batch, segundos/minutos (trabalho de fundo)

function HotColdCard({ vectors, loading }: { vectors: number | null; loading: boolean }) {
  return (
    <Card
      header={
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8, fontWeight: 600 }}>
          Os dois caminhos do cérebro
          <span className="faint" style={{ fontWeight: 400, fontSize: 12.5 }}>como ele funciona por dentro</span>
        </span>
      }
    >
      <div style={{ display: "grid", gap: 14 }}>
        <PathRow
          kind="hot"
          title="HOT — leitura"
          sub="quando você pergunta"
          chips={["síncrono", "milissegundos", "o que você sente"]}
          desc="Busca, retrieve e resposta. É o caminho quente: precisa ser rápido. A latência ao lado mede exatamente isto."
        />
        <div style={{ height: 1, background: "var(--border)" }} aria-hidden />
        <PathRow
          kind="cold"
          title="COLD — organização"
          sub="quando algo entra"
          chips={["em lote", "segundos a minutos", "trabalho de fundo"]}
          desc={
            loading
              ? undefined
              : vectors === 0
                ? "Indexação, extração de fatos e ligações. Hoje sem embeddings (vetores = 0) — busca rápida ligada."
                : "Indexação, extração de fatos e ligações. Roda em segundo plano sem segurar a leitura."
          }
        />
      </div>
    </Card>
  );
}

function PathRow({
  kind,
  title,
  sub,
  chips,
  desc,
}: {
  kind: "hot" | "cold";
  title: string;
  sub: string;
  chips: string[];
  desc?: string;
}) {
  const dot = kind === "hot" ? "var(--accent)" : "var(--st-reg)";
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 8 }}>
        <span aria-hidden style={{ width: 9, height: 9, borderRadius: "50%", background: dot, flexShrink: 0 }} />
        <b style={{ fontSize: 14.5 }}>{title}</b>
        <span className="faint" style={{ fontSize: 12.5 }}>{sub}</span>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 7, marginBottom: desc ? 8 : 0 }}>
        {chips.map((c) => (
          <Chip key={c} dotColor={dot}>{c}</Chip>
        ))}
      </div>
      {desc ? (
        <p className="muted" style={{ fontSize: 13, lineHeight: 1.5, margin: 0 }}>{desc}</p>
      ) : (
        <Skeleton width="80%" style={{ marginTop: 4 }} />
      )}
    </div>
  );
}

// --- Custo de extração (rollup) — base de pricing, SÓ OWNER ----------------
// /api/cost devolve runs/cost_usd_total/tokens_in/out do brain (COLD path: o
// trabalho de extração que custa LLM). É a base do pricing por uso. O endpoint
// é só-owner (D4): um member recebe 403 e a tela some o card sem ruído.

function fmtUsd(n: number | null | undefined): string {
  const v = typeof n === "number" && isFinite(n) ? n : 0;
  return `$${v.toLocaleString("en-US", { minimumFractionDigits: v < 1 ? 4 : 2, maximumFractionDigits: 4 })}`;
}

/** rótulo legível por operação de IA (M20). */
const OP_LABEL: Record<string, string> = {
  extract: "Extração (ingestão)",
  "extract:batch": "Extração em lote",
  synthesis: "Perguntas (síntese)",
  "ask:stream": "Perguntas (ao vivo)",
  embed: "Embeddings (ingestão)",
  "embed:query": "Embeddings (busca)",
  rerank: "Reordenação",
  hyde: "Expansão de busca",
};

function CostCard({
  data,
  loading,
  error,
  onRetry,
}: {
  data: CostRollup | null;
  loading: boolean;
  error: ApiError | Error | null;
  onRetry: () => void;
}) {
  // member (403) ou owner-only ausente → não renderiza nada (gracioso).
  if (error instanceof ApiError && error.status === 403) return null;

  return (
    <div style={{ marginBottom: 18 }}>
      <Card
        header={
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8, fontWeight: 600 }}>
              <Icon name="info" size={15} />
              Custo de IA (estimativa, US$)
              <span
                className="mono"
                style={{
                  fontSize: 10,
                  fontWeight: 600,
                  letterSpacing: ".03em",
                  textTransform: "uppercase",
                  color: "var(--accent-ink)",
                  background: "var(--accent-soft)",
                  borderRadius: 6,
                  padding: "2px 7px",
                }}
              >
                só dono
              </span>
            </span>
            <span className="mono faint" style={{ fontSize: 11 }}>uso real</span>
          </div>
        }
      >
        {loading ? (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 14 }} className="saude-cost-grid">
            {Array.from({ length: 4 }).map((_, i) => <KpiSkeleton key={i} />)}
          </div>
        ) : error ? (
          <ErrorBanner message="Não consegui ler o custo de extração." onRetry={onRetry} />
        ) : (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 14 }} className="saude-cost-grid">
              <KpiTile label="Custo total (IA)" value={fmtUsd(data?.cost_usd_total)} />
              <KpiTile label="Chamadas de IA" value={fmtNumber(data?.calls)} />
              <KpiTile label="Tokens de entrada" value={fmtNumber(data?.tokens_in_total)} />
              <KpiTile label="Tokens de saída" value={fmtNumber(data?.tokens_out_total)} />
            </div>

            {/* M20: quebra por operação (extração, perguntas, embeddings…) */}
            {data && data.by_op.length > 0 && (
              <div style={{ marginTop: 16 }}>
                <div className="mono faint" style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 8 }}>
                  Por operação
                </div>
                <div style={{ display: "grid", gap: 1, background: "var(--border)", borderRadius: 8, overflow: "hidden" }}>
                  {data.by_op.map((b) => (
                    <div
                      key={b.op}
                      style={{ display: "grid", gridTemplateColumns: "1fr auto auto", gap: 12, alignItems: "center",
                        background: "var(--surface)", padding: "8px 12px", fontSize: 13 }}
                    >
                      <span style={{ fontWeight: 600 }}>{OP_LABEL[b.op ?? ""] ?? b.op}</span>
                      <span className="mono faint" style={{ fontSize: 11.5 }}>{fmtNumber(b.calls)} ch.</span>
                      <span className="mono" style={{ fontWeight: 600, minWidth: 72, textAlign: "right" }}>{fmtUsd(b.cost_usd)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <p className="faint" style={{ fontSize: 12.5, lineHeight: 1.5, marginTop: 14, marginBottom: 0 }}>
              O custo de IA deste cérebro, estimado dos tokens medidos do provider — extração na
              ingestão, perguntas e embeddings. Só o <b>dono</b> do cérebro vê isto.
            </p>
          </>
        )}
        <style>{`
          @media (max-width: 1080px) {
            .saude-cost-grid { grid-template-columns: repeat(2, 1fr) !important; }
          }
        `}</style>
      </Card>
    </div>
  );
}

// --- Throughput / Taxa de erro — sem dados ainda (honesto) -----------------
// Sem coleta de série temporal no servidor, não há throughput nem taxa de erro
// confiável. Mostramos placeholders ROTULADOS — nunca números fake.

function NotMeasuredYet({ empty }: { empty: boolean }) {
  return (
    <Card
      header={
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8, fontWeight: 600 }}>
          Vazão e taxa de erro
          <span className="faint" style={{ fontWeight: 400, fontSize: 12.5 }}>ao longo do tempo</span>
        </span>
      }
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(2, 1fr)",
          gap: 14,
        }}
        className="saude-empty-grid"
      >
        <PlaceholderMetric label="Leituras por minuto" />
        <PlaceholderMetric label="Taxa de erro" />
      </div>

      <p className="faint" style={{ fontSize: 12.5, lineHeight: 1.5, marginTop: 14, marginBottom: 0 }}>
        {empty ? (
          <>
            Sem tráfego ainda — quando o cérebro começar a ser usado, a vazão e os
            erros aparecem aqui. <b>Ainda não medido.</b>
          </>
        ) : (
          <>
            Ainda não coletamos série temporal no servidor, então não inventamos
            vazão nem taxa de erro. <b>Ainda não medido</b> — virá com a coleta no servidor.
          </>
        )}
      </p>

      <style>{`
        @media (max-width: 1080px) {
          .saude-empty-grid { grid-template-columns: 1fr !important; }
        }
      `}</style>
    </Card>
  );
}

function PlaceholderMetric({ label }: { label: string }) {
  return (
    <div
      style={{
        border: "1px dashed var(--border-strong)",
        borderRadius: 11,
        padding: "16px 15px",
        background: "var(--surface-2)",
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <b className="mono faint" style={{ fontSize: 24, fontWeight: 600, lineHeight: 1 }}>—</b>
      </div>
      <small style={{ display: "block", marginTop: 8, fontSize: 11.5, color: "var(--faint)" }}>{label}</small>
      <span
        className="mono"
        style={{
          display: "inline-block",
          marginTop: 8,
          fontSize: 10,
          fontWeight: 600,
          letterSpacing: ".03em",
          textTransform: "uppercase",
          color: "var(--muted)",
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: 6,
          padding: "2px 7px",
        }}
      >
        ainda não medido
      </span>
    </div>
  );
}
