/** Popup de leitura: MCP + /v1 + chave + histórico real do principal. */
import { Button, Modal } from "../../ui";
import type { AccessLogEntry, Principal, Token } from "../../lib/api";
import { relativeTime } from "../../lib/format";
import { FieldRow, TokenBlock, MCP_API_URL, mcpSnippet } from "../shared/plugue";

const EVENT_LABEL: Record<string, string> = {
  "token.issued": "chave emitida",
  "token.revoked": "chave revogada",
  "token.rotated": "chave rotacionada",
  "principal.invited": "acesso concedido",
  "grant.changed": "acesso alterado",
  "principal.removed": "acesso removido",
};

export function BotCredsModal({
  open,
  onClose,
  principal,
  freshToken,
  history,
  generating,
  onCopy,
  onGenerate,
  onRevoke,
  onRotate,
}: {
  open: boolean;
  onClose: () => void;
  principal: Principal | null;
  freshToken?: string | null;
  history: AccessLogEntry[];
  generating?: boolean;
  onCopy: (text: string, label?: string) => void;
  onGenerate: () => void;
  onRevoke: (t: Token) => void;
  onRotate: () => void;
}) {
  const p = principal;
  if (!p) return null;
  const agent = p.kind === "agent";
  const active = p.tokens.find((t) => !t.revoked);
  const tokenForSnippet = freshToken || "gld_live_SUA_CHAVE";
  const mcp = mcpSnippet(tokenForSnippet);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={agent ? `Como ${p.label} lê o cérebro` : `Acesso de ${p.label}`}
      width={560}
      footer={<Button variant="ghost" onClick={onClose}>Fechar</Button>}
    >
      {agent ? (
        <div>
          <p style={{ margin: "0 0 12px", fontSize: 13.5, color: "var(--muted)", lineHeight: 1.5 }}>
            Isto é leitura do cérebro (MCP e API). Não é o motor de IA — ChatGPT fica em <b>Conectar</b>.
          </p>
          <FieldRow label="Base da API" value={MCP_API_URL} onCopy={() => onCopy(MCP_API_URL, "Base copiada.")} />
          <p style={{ margin: "12px 0 7px", fontSize: 12.5, color: "var(--muted)", fontWeight: 600 }}>MCP</p>
          <TokenBlock code={mcp} onCopy={() => onCopy(mcp, "Config MCP copiada.")} />
          <p style={{ margin: "14px 0 8px", fontSize: 13, fontWeight: 600 }}>Chave</p>
          {freshToken ? (
            <div>
              <p style={{ margin: "0 0 8px", fontSize: 13, lineHeight: 1.45 }}>
                Copie agora — <b>esta é a única vez</b> que a chave aparece inteira.
              </p>
              <TokenBlock code={freshToken} onCopy={() => onCopy(freshToken, "Chave copiada.")} oneLine />
            </div>
          ) : active ? (
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
              <span className="mono" style={{ fontSize: 13 }}>····{active.last4}</span>
              <Button size="sm" variant="secondary" onClick={onRotate}>
                Rotacionar
              </Button>
              <Button size="sm" variant="secondary" onClick={() => onRevoke(active)} style={{ color: "var(--danger)" }}>
                Revogar
              </Button>
            </div>
          ) : (
            <Button size="sm" variant="primary" disabled={generating} onClick={onGenerate}>
              {generating ? "Gerando…" : "Gerar chave"}
            </Button>
          )}
        </div>
      ) : (
        <p style={{ margin: "0 0 12px", fontSize: 13.5, color: "var(--muted)", lineHeight: 1.5 }}>
          {p.label} entra com login. Não usa chave MCP.
        </p>
      )}

      {history.length > 0 && (
        <>
          <p style={{ margin: "18px 0 8px", fontSize: 13, fontWeight: 600 }}>Histórico deste acesso</p>
          <div>
            {history.slice(0, 12).map((e, i) => {
              const gov = !!e.event;
              const title = gov
                ? `${EVENT_LABEL[e.event!] ?? e.event} · ${e.principal_id}`
                : `${e.principal_id} consultou "${e.query ?? ""}"`;
              return (
                <div key={`${e.ts}-${i}`} style={{ padding: "8px 0", borderBottom: "1px solid var(--border)", fontSize: 13 }}>
                  <div style={{ fontWeight: 600 }}>{title}</div>
                  <div className="mono" style={{ fontSize: 11.5, color: "var(--faint)" }}>{e.ts ? relativeTime(e.ts) : ""}</div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </Modal>
  );
}
