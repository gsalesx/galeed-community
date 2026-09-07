/** Webhook de entrada + ingestores prontos — alimenta a memória. Mora em Fontes. */
import { Card } from "../../ui";
import { useQuery } from "../../lib/useQuery";
import { EndpointHeader, FieldRow, TokenBlock, V1_BASE } from "../shared/plugue";

export function WebhookIngest({ copy }: { copy: (text: string, label?: string) => void }) {
  const webhookExample = `curl -X POST "${V1_BASE}/ingest" \\
  -H "Authorization: Bearer gld_live_SUA_CHAVE" \\
  -H "Content-Type: application/json" \\
  -d '{"source":"zapier","content":"Reunião com a Acme — fechamos o piloto."}'`;

  return (
    <Card
      padding="16px 18px 18px"
      style={{ marginBottom: 16 }}
      header={
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <EndpointHeader kind="WEBHOOK" title="Entrada automática" note="POST · JSON" />
          </div>
          <p style={{ margin: "6px 0 0", fontSize: 13, color: "var(--muted)", lineHeight: 1.5 }}>
            O que alimenta o cérebro. Aponte Zapier, Make ou qualquer canal que fala webhook para a URL abaixo.
            A chave de leitura/ingestão se emite em <b>Acesso</b>.
          </p>
        </div>
      }
    >
      <FieldRow label="Endpoint" value={`${V1_BASE}/ingest`} onCopy={() => copy(`${V1_BASE}/ingest`, "URL copiada.")} />
      <p style={{ margin: "14px 0 7px", fontSize: 12.5, color: "var(--muted)", fontWeight: 600 }}>
        Exemplo · enviar um evento
      </p>
      <TokenBlock code={webhookExample} onCopy={() => copy(webhookExample, "Comando copiado.")} />
      <IngestoresProntos copy={copy} />
    </Card>
  );
}

function IngestoresProntos({ copy }: { copy: (text: string, label?: string) => void }) {
  const q = useQuery<{ ingestors: { slug: string; nome: string; descricao: string; exemplo?: string }[] }>(
    "fontes:ingestors",
    () => fetch("/api/ingestors").then((r) => r.json()),
    [],
  );
  const lista = q.data?.ingestors ?? [];
  if (!lista.length) return null;

  return (
    <details style={{ marginTop: 14, borderTop: "1px solid var(--border)", paddingTop: 4 }}>
      <summary style={{ cursor: "pointer", padding: "10px 0 4px" }}>
        <EndpointHeader kind="INGESTORES" title="Ingestores prontos" note="avançado" />
      </summary>
      <div>
        <p style={{ margin: "0 0 4px", fontSize: 13, color: "var(--muted)", lineHeight: 1.55 }}>
          Canais com o formato já tratado. Autentica com{" "}
          <span className="mono">Authorization: Bearer</span> (ou <span className="mono">?token=</span>).
        </p>
        {lista.map((ing) => (
          <div key={ing.slug} style={{ marginTop: 14 }}>
            <div style={{ fontSize: 13.5, fontWeight: 600 }}>{ing.nome}</div>
            <p style={{ margin: "2px 0 8px", fontSize: 12.5, color: "var(--muted)", lineHeight: 1.5 }}>
              {ing.descricao}
            </p>
            <FieldRow
              label="Endpoint"
              value={`${V1_BASE}/ingestors/${ing.slug}`}
              onCopy={() => copy(`${V1_BASE}/ingestors/${ing.slug}`, "URL copiada.")}
            />
          </div>
        ))}
      </div>
    </details>
  );
}
