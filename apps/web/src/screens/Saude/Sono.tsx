/** Card "Sono e memória" na tela Saúde — o estado REAL que era invisível (achado consulta-e-saida):
 *  o sono roda no worker e grava um rastro auditável (galeed_sono_state.last_trace), mas nenhuma
 *  tela lia — o dono via "Sistema no ar" verde mesmo com o sono falhando todo dia. Aqui: quando o
 *  cérebro dormiu, o que fez (fases + falhas), candidatas à poda, o peso da memória (ativas/frias/
 *  na lixeira) e a fila de ingestão por status (falhas incluídas). Leitura pura, ZERO LLM. */
import { Button, Card, Chip, Skeleton } from "../../ui";
import { INGEST_NAO_TERMINAIS, api, type SaudeView, type SonoFaseView } from "../../lib/api";
import { useBrain } from "../../lib/auth";
import { useQuery } from "../../lib/useQuery";
import { fmtNumber } from "../../lib/format";

/** status do último sono → rótulo leigo + cor. Estados de gate também têm cara amigável. */
const SONO_STATUS: Record<string, { label: string; cor: string }> = {
  dormiu: { label: "dormiu e trabalhou", cor: "var(--st-fact)" },
  noop: { label: "dormiu — nada novo pra organizar", cor: "var(--muted)" },
  parcial: { label: "dormiu, mas tropeçou em algumas fases", cor: "var(--st-reg)" },
  falhou: { label: "o último sono falhou", cor: "var(--danger)" },
  desligado: { label: "sono automático desligado", cor: "var(--muted)" },
  aguardando_acumulo: { label: "acordado — esperando material novo", cor: "var(--muted)" },
  cooldown: { label: "descansando (já dormiu nas últimas 24h)", cor: "var(--muted)" },
  fila_ocupada: { label: "esperando a fila esvaziar pra dormir", cor: "var(--muted)" },
};

/** nome de fase interno → rótulo leigo. */
const FASE_LABEL: Record<string, string> = {
  reconcile: "arrumar nomes",
  consolidacao: "consolidação",
  salience: "recalcular importância",
  detectores: "detectores",
  sonho: "sonho",
  reflexao: "reflexão",
  prune: "poda",
  shed: "resfriamento",
};

function dataLocal(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  } catch {
    return iso.slice(0, 10);
  }
}

function Linha({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 13, lineHeight: 1.55, marginTop: 6 }}>{children}</div>;
}

export default function SonoCard() {
  const { current } = useBrain();
  const { data, error, loading, refetch } = useQuery<SaudeView>(
    "saude:sono",
    () => api.saude(),
    [current?.id],
  );

  const sono = data?.sono ?? null;
  const trace = sono?.trace ?? null;
  const storage = data?.storage ?? null;
  const jobs = data?.jobs ?? {};

  // fases que falharam no último ciclo (o rastro é fail-soft por fase: uma falha não derruba o sono)
  const fasesFalhas: [string, SonoFaseView][] = Object.entries(trace?.fases ?? {}).filter(
    ([, f]) => f && f.status === "falhou",
  );
  const podaveis = Number((trace?.fases?.prune as SonoFaseView | undefined)?.podaveis ?? NaN);
  const st = SONO_STATUS[trace?.status ?? ""] ?? null;

  // fila: em andamento (não-terminais, batch incluso) e falhas persistentes (error + dead)
  const emAndamento = INGEST_NAO_TERMINAIS.reduce((n, s) => n + (jobs[s] ?? 0), 0);
  const falharam = (jobs.error ?? 0) + (jobs.dead ?? 0);

  return (
    <Card>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
        <div>
          <h3 style={{ margin: 0, fontSize: 15 }}>Sono e memória</h3>
          <span className="mono" style={{ color: "var(--muted)", fontSize: 11.5 }}>
            o que o cérebro fez dormindo — e o peso do que guarda
          </span>
        </div>
        {!loading && !error && sono?.lastSleepAt && (
          <span className="mono" style={{ color: "var(--muted)", fontSize: 12 }}>
            último sono {dataLocal(sono.lastSleepAt)}
          </span>
        )}
      </div>

      {loading ? (
        <>
          <Skeleton width="85%" height={14} style={{ marginTop: 10 }} />
          <Skeleton width="60%" height={14} style={{ marginTop: 8 }} />
        </>
      ) : error ? (
        <div
          style={{
            padding: 12, borderRadius: 8, background: "var(--sn-secret-soft)", color: "var(--danger)",
            fontSize: 13, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
          }}
        >
          <span>Não consegui ler o estado do sono.</span>
          <Button size="sm" variant="secondary" onClick={refetch}>Tentar de novo</Button>
        </div>
      ) : (
        <>
          {/* ── último sono ── */}
          {!sono || !trace ? (
            <p style={{ fontSize: 13, color: "var(--muted)", lineHeight: 1.6, margin: "8px 0 0" }}>
              O cérebro ainda não dormiu. O sono roda sozinho quando entra material suficiente — é
              dormindo que ele revisa, consolida e marca o que pode esquecer.
            </p>
          ) : (
            <div style={{ marginTop: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <Chip dotColor={st?.cor ?? "var(--muted)"}>{st?.label ?? trace.status ?? "—"}</Chip>
                {typeof trace.fontes_novas === "number" && trace.fontes_novas > 0 && (
                  <span className="mono" style={{ fontSize: 11.5, color: "var(--muted)" }}>
                    {fmtNumber(trace.fontes_novas)} fontes novas desde o sono anterior
                  </span>
                )}
              </div>
              {Number.isFinite(podaveis) && (
                <Linha>
                  <span className="mono" style={{ color: "var(--muted)", fontSize: 12 }}>
                    {podaveis === 0
                      ? "nenhuma memória candidata a esquecer neste ciclo"
                      : `${fmtNumber(podaveis)} memória${podaveis === 1 ? "" : "s"} candidata${podaveis === 1 ? "" : "s"} a esquecer (nada foi apagado — ver Lixeira)`}
                  </span>
                </Linha>
              )}
              {fasesFalhas.length > 0 && (
                <div style={{ marginTop: 8, padding: "8px 10px", borderRadius: 8, background: "var(--st-hypo-soft)", border: "1px solid var(--st-hypo)" }}>
                  <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 4 }}>
                    Fases que falharam no último sono:
                  </div>
                  {fasesFalhas.map(([nome, f]) => (
                    <div key={nome} className="mono" style={{ fontSize: 11.5, color: "var(--muted)" }}>
                      {FASE_LABEL[nome] ?? nome}
                      {f.erro ? ` — ${f.erro}` : ""}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ── peso da memória (ativas / frias / lixeira) ── */}
          {storage && (
            <div style={{ marginTop: 12, paddingTop: 10, borderTop: "1px solid var(--border)" }}>
              <div className="mono" style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: ".06em", color: "var(--faint)", marginBottom: 6 }}>
                Peso da memória
              </div>
              <div style={{ display: "flex", gap: 14, flexWrap: "wrap", fontSize: 13 }}>
                <span><b className="mono">{fmtNumber(storage.pagesHot)}</b> <span className="muted">ativas</span></span>
                <span><b className="mono">{fmtNumber(storage.pagesCold)}</b> <span className="muted">frias (sem vetores; voltam sob demanda)</span></span>
                <span><b className="mono">{fmtNumber(storage.pagesArchived)}</b> <span className="muted">na lixeira</span></span>
              </div>
            </div>
          )}

          {/* ── fila de ingestão (falhas incluídas — antes invisíveis nesta tela) ── */}
          <div style={{ marginTop: 12, paddingTop: 10, borderTop: "1px solid var(--border)" }}>
            <div className="mono" style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: ".06em", color: "var(--faint)", marginBottom: 6 }}>
              Fila de organização
            </div>
            <div style={{ display: "flex", gap: 14, flexWrap: "wrap", fontSize: 13 }}>
              <span>
                <b className="mono">{fmtNumber(emAndamento)}</b>{" "}
                <span className="muted">em andamento{(jobs.batch_submitted ?? 0) + (jobs.batch_harvesting ?? 0) > 0 ? " (inclui digestão em lote — pode levar horas)" : ""}</span>
              </span>
              <span style={{ color: falharam > 0 ? "var(--danger)" : undefined }}>
                <b className="mono">{fmtNumber(falharam)}</b>{" "}
                <span className={falharam > 0 ? "" : "muted"}>
                  {falharam > 0 ? "falharam — veja o motivo na tela Adicionar" : "falhas"}
                </span>
              </span>
            </div>
          </div>
        </>
      )}
    </Card>
  );
}
