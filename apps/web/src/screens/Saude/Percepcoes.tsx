/** M24-E — card "Percepções" na tela Saúde (decisão (b) do fundador: SEM tela nova). Lista as
 *  percepções que o cérebro produziu DORMINDO (saída do ciclo de sono M24-A/C/D): classe, texto,
 *  severidade, o "porquê" com os NÚMEROS do detector, fontes clicáveis (o selo) e a data do sono.
 *  Vivas primeiro; stale/arquivadas atrás de um toggle. Estado vazio honesto. ZERO LLM. */
import { useState } from "react";
import { Button, Card, Chip, Skeleton } from "../../ui";
import { api, type Percepcao, type PercepcoesPage } from "../../lib/api";
import { useBrain } from "../../lib/auth";
import { useQuery } from "../../lib/useQuery";

const VAZIO =
  "O cérebro ainda não percebeu nada — precisa de mais dados (e de mais sonos). As percepções nascem enquanto o cérebro dorme: quando houver fontes e séries suficientes, elas aparecem aqui.";

function sevColor(s: string): string {
  return s === "alta" ? "var(--danger)" : s === "media" ? "var(--st-reg)" : "var(--muted)";
}

function porque(numbers: Record<string, number | string>): string {
  return Object.entries(numbers ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join(" · ");
}

function PercepcaoItem({ p, brainId }: { p: Percepcao; brainId?: string }) {
  const sono = (p.created_at || "").slice(0, 10);
  return (
    <div style={{ padding: "12px 0", borderTop: "1px solid var(--border)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <Chip dotColor="var(--muted)"><span className="mono">{p.classe}</span></Chip>
        <Chip dotColor={sevColor(p.severidade)}>{p.severidade}</Chip>
        {p.tier && <span className="mono" style={{ color: "var(--muted)", fontSize: 11.5 }}>[{p.tier}]</span>}
        {p.estado === "stale" && (
          <span className="mono" style={{ color: "var(--st-reg)", fontSize: 11.5 }}>desatualizada — um fato-base mudou</span>
        )}
        {p.estado === "arquivada" && (
          <span className="mono" style={{ color: "var(--muted)", fontSize: 11.5, opacity: 0.7 }}>arquivada</span>
        )}
      </div>
      <p style={{ fontSize: 13.5, margin: "8px 0 6px", lineHeight: 1.5 }}>{p.texto}</p>
      <div className="mono" style={{ color: "var(--muted)", fontSize: 11.5, marginBottom: 4 }}>
        porquê: {porque(p.numbers) || "—"}
      </div>
      <div className="mono" style={{ color: "var(--muted)", fontSize: 11.5, display: "flex", gap: 8, flexWrap: "wrap" }}>
        <span>sono de {sono || "—"}</span>
        {p.cites.source_slugs.map((slug) => (
          <a
            key={slug}
            className="mono"
            href={`/api/source?slug=${encodeURIComponent(slug)}${brainId ? `&brain=${encodeURIComponent(brainId)}` : ""}`}
            target="_blank"
            rel="noreferrer"
            style={{ color: "var(--accent)" }}
          >
            {slug}
          </a>
        ))}
      </div>
    </div>
  );
}

export default function PercepcoesCard() {
  const { current } = useBrain();
  const [showAntigas, setShowAntigas] = useState(false);
  const { data, error, loading, refetch } = useQuery<PercepcoesPage>(
    "saude:percepcoes",
    () => api.percepcoes.list({ estado: "todas", k: 100 }),
    [current?.id],
  );

  const items = data?.items ?? [];
  const vivas = items.filter((p) => p.estado === "viva");
  const antigas = items.filter((p) => p.estado !== "viva");

  return (
    <Card>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
        <div>
          <h3 style={{ margin: 0, fontSize: 15 }}>Percepções</h3>
          <span className="mono" style={{ color: "var(--muted)", fontSize: 11.5 }}>
            o que o cérebro percebeu dormindo
          </span>
        </div>
        {!loading && !error && <span className="mono" style={{ color: "var(--muted)", fontSize: 12 }}>{vivas.length} vivas</span>}
      </div>

      {loading ? (
        <>
          <Skeleton width="90%" height={14} style={{ marginTop: 10 }} />
          <Skeleton width="70%" height={14} style={{ marginTop: 8 }} />
        </>
      ) : error ? (
        <div
          style={{
            padding: 12,
            borderRadius: 8,
            background: "var(--danger-bg, rgba(220,50,50,0.08))",
            color: "var(--danger)",
            fontSize: 13,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <span>Não consegui ler as percepções.</span>
          <Button size="sm" variant="secondary" onClick={refetch}>Tentar de novo</Button>
        </div>
      ) : items.length === 0 ? (
        <p style={{ fontSize: 13, color: "var(--muted)", lineHeight: 1.6, margin: "8px 0 0" }}>{VAZIO}</p>
      ) : (
        <>
          {vivas.map((p) => <PercepcaoItem key={p.id} p={p} brainId={current?.id} />)}
          {antigas.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <Button size="sm" variant="secondary" onClick={() => setShowAntigas((v) => !v)}>
                {showAntigas ? "Esconder antigas" : `Mostrar antigas (${antigas.length})`}
              </Button>
              {showAntigas && (
                <div style={{ marginTop: 8, borderTop: "1px solid var(--border)" }}>
                  {antigas.map((p) => <PercepcaoItem key={p.id} p={p} brainId={current?.id} />)}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </Card>
  );
}
