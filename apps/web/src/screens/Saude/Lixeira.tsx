/** Card "Lixeira" na tela Saúde — achado "Painel não tem lixeira nem restauração" (validado):
 *  página arquivada sumia do painel sem NENHUMA tela pra ver o que foi arquivado ou clicar
 *  "restaurar" — pro usuário leigo, indistinguível de deleção. Aqui: lista das memórias
 *  arquivadas (GET /api/lixeira) + botão Restaurar (POST /api/lixeira/restaurar → restoreCold,
 *  que cobre tanto arquivada-quente quanto fria). Nada é apagado; restaurar é sempre possível. */
import { useState } from "react";
import { Button, Card, Skeleton } from "../../ui";
import { ApiError, api, type LixeiraItem, type LixeiraPage } from "../../lib/api";
import { useBrain } from "../../lib/auth";
import { useQuery } from "../../lib/useQuery";
import { fmtNumber } from "../../lib/format";

const EXPLICA =
  "O Galeed guarda aqui o que decidiu esquecer; nada é apagado — dá pra trazer de volta.";
const VAZIA =
  "A lixeira está vazia. Quando o cérebro (ou você) arquivar uma memória, ela aparece aqui — e dá pra restaurar com um clique.";

function LixeiraLinha({
  item,
  ocupado,
  onRestaurar,
}: {
  item: LixeiraItem;
  ocupado: boolean;
  onRestaurar: (slug: string) => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "10px 0",
        borderTop: "1px solid var(--border)",
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{ fontSize: 13.5, fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
          title={item.slug}
        >
          {item.title || item.slug}
        </div>
        <div className="mono" style={{ fontSize: 11, color: "var(--faint)", marginTop: 2, display: "flex", gap: 8, flexWrap: "wrap" }}>
          <span>{item.type || "memória"}</span>
          {item.date && <span>{item.date}</span>}
          {item.tier === "cold" && <span style={{ color: "var(--st-reg)" }}>fria — volta completa ao restaurar</span>}
        </div>
      </div>
      <Button size="sm" variant="secondary" disabled={ocupado} onClick={() => onRestaurar(item.slug)}>
        {ocupado ? "Restaurando…" : "Restaurar"}
      </Button>
    </div>
  );
}

export default function LixeiraCard() {
  const { current } = useBrain();
  const { data, error, loading, refetch } = useQuery<LixeiraPage>(
    "saude:lixeira",
    () => api.lixeira.list(),
    [current?.id],
  );
  const [restaurando, setRestaurando] = useState<string | null>(null);
  const [aviso, setAviso] = useState<{ msg: string; ok: boolean } | null>(null);

  const items = data?.items ?? [];
  const total = data?.total ?? items.length;

  async function restaurar(slug: string) {
    setRestaurando(slug);
    setAviso(null);
    try {
      const r = await api.lixeira.restore(slug);
      if (r.restored) {
        setAviso({ msg: "Memória de volta ao cérebro — já aparece na busca de novo.", ok: true });
      } else {
        setAviso({ msg: "Nada a restaurar: essa memória já está ativa (ou não existe mais).", ok: false });
      }
      refetch();
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : "não consegui restaurar agora.";
      setAviso({ msg, ok: false });
    } finally {
      setRestaurando(null);
    }
  }

  return (
    <Card>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
        <div>
          <h3 style={{ margin: 0, fontSize: 15 }}>Lixeira</h3>
          <span className="mono" style={{ color: "var(--muted)", fontSize: 11.5 }}>
            memórias arquivadas — reversível
          </span>
        </div>
        {!loading && !error && total > 0 && (
          <span className="mono" style={{ color: "var(--muted)", fontSize: 12 }}>
            {fmtNumber(total)} arquivada{total === 1 ? "" : "s"}
          </span>
        )}
      </div>

      <p style={{ fontSize: 13, color: "var(--muted)", lineHeight: 1.6, margin: "6px 0 0" }}>{EXPLICA}</p>

      {aviso && (
        <div
          role="status"
          style={{
            marginTop: 10,
            padding: "8px 12px",
            borderRadius: 8,
            fontSize: 12.5,
            background: aviso.ok ? "var(--st-fact-soft)" : "var(--st-hypo-soft)",
            border: `1px solid ${aviso.ok ? "var(--st-fact)" : "var(--st-hypo)"}`,
          }}
        >
          {aviso.msg}
        </div>
      )}

      {loading ? (
        <>
          <Skeleton width="85%" height={14} style={{ marginTop: 12 }} />
          <Skeleton width="65%" height={14} style={{ marginTop: 8 }} />
        </>
      ) : error ? (
        <div
          style={{
            marginTop: 10, padding: 12, borderRadius: 8, background: "var(--sn-secret-soft)", color: "var(--danger)",
            fontSize: 13, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
          }}
        >
          <span>Não consegui abrir a lixeira.</span>
          <Button size="sm" variant="secondary" onClick={refetch}>Tentar de novo</Button>
        </div>
      ) : items.length === 0 ? (
        <p style={{ fontSize: 13, color: "var(--muted)", lineHeight: 1.6, margin: "10px 0 0" }}>{VAZIA}</p>
      ) : (
        <div style={{ marginTop: 10 }}>
          {items.map((it) => (
            <LixeiraLinha key={it.slug} item={it} ocupado={restaurando === it.slug} onRestaurar={restaurar} />
          ))}
          {total > items.length && (
            <div className="mono" style={{ fontSize: 11.5, color: "var(--faint)", marginTop: 8 }}>
              mostrando {fmtNumber(items.length)} de {fmtNumber(total)} — restaure as mais recentes pra ver o resto.
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
