/** Tela CONECTAR — "o plugue" do Galeed (M8). Dois lados:
 *   (a) Para seu agente de IA: os endpoints (REST + MCP) que o agente do cliente
 *       usa pra ACESSAR o cérebro, e as chaves/tokens por brain (gerar/revogar).
 *   (b) Suas fontes/conexões: o webhook de ingestão que ALIMENTA o cérebro.
 *
 *  Renderiza dentro do <main> do AppShell. Dados de chave via api.rbac.* (mock no
 *  BFF até o M7; shapes idênticos). Token cru é mostrado UMA vez (gld_live_…); depois só
 *  ····last4. Endpoints são o contrato público /v1 (Caddy serve front e /v1 no mesmo domínio):
 *    - REST  → POST /v1/ask, /v1/facts, /v1/ingest  (Authorization: Bearer gld_live_…)
 *    - MCP   → pacote HTTP `@galeed/mcp` (npx). Autentica com a chave deste cérebro; sem Postgres.
 *    - brain → derivado do token (não precisa de header extra)
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Card, Chip, Icon, Modal, Toast } from "../../ui";
import { api } from "../../lib/api";
import type { Principal, Token } from "../../lib/api";
import { useMutation, useQuery } from "../../lib/useQuery";
import { useBrain } from "../../lib/auth";
import { relativeTime } from "../../lib/format";

// Base pública da API: o Caddy serve o front e o /v1 no MESMO domínio (prod e dev). Derivar do
// origin garante a URL certa sem hardcodar host. SSR-safe: cai pro host de prod fora do browser.
const V1_BASE = (typeof window !== "undefined" ? window.location.origin : "") + "/v1";
// docs só existem quando SERVIDAS (build Docker define VITE_DOCS_URL; Caddy serve /docs).
// Sem a var, o link some — em dev /docs cairia no SPA-fallback (abriria o próprio app).
const DOCS_URL = (import.meta.env.VITE_DOCS_URL as string | undefined) || "";

export default function Conectar() {
  const { current } = useBrain();
  const brainId = current?.id ?? "";
  const brainName = current?.name ?? "seu cérebro";

  const [toast, setToast] = useState<{ msg: string; tone: "ok" | "neutral" | "danger" } | null>(null);

  // chaves = tokens dos principals do tipo "agent" (bots). Mock no BFF até M7.
  const principalsQ = useQuery<Principal[]>(
    `conectar:principals:${brainId}`,
    () => api.rbac.principals(),
    [brainId],
  );
  const agents = useMemo(
    () => (principalsQ.data ?? []).filter((p) => p.kind === "agent"),
    [principalsQ.data],
  );

  // token cru exibido UMA vez (modal). principal = a quem a chave pertence.
  const [fresh, setFresh] = useState<{ token: string; principal: Principal } | null>(null);
  const [revoking, setRevoking] = useState<{ p: Principal; token: Token } | null>(null);

  const tokenMut = useMutation<string, { token: string; principal: Principal }>((principalId) =>
    api.rbac.issueToken(principalId),
  );
  const revokeMut = useMutation<string, void>((principalId) =>
    api.rbac.revokeToken(principalId),
  );

  const copy = useCallback((text: string, label = "Copiado.") => {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(text).catch(() => {});
    }
    setToast({ msg: label, tone: "neutral" });
  }, []);

  async function generateToken(p: Principal) {
    try {
      const t = await tokenMut.mutate(p.id);
      setFresh(t);
      principalsQ.refetch();
    } catch (e) {
      setToast({ msg: `Não deu pra gerar a chave: ${(e as Error).message}`, tone: "danger" });
    }
  }

  async function confirmRevoke() {
    if (!revoking) return;
    try {
      await revokeMut.mutate(revoking.p.id);
      setToast({ msg: `Chave ····${revoking.token.last4} revogada.`, tone: "danger" });
      principalsQ.refetch();
    } catch (e) {
      setToast({ msg: `Não deu pra revogar: ${(e as Error).message}`, tone: "danger" });
    } finally {
      setRevoking(null);
    }
  }

  // exemplos copiáveis com o contrato /v1 real
  const curlExample = `curl -X POST "${V1_BASE}/ask" \\
  -H "Authorization: Bearer gld_live_SUA_CHAVE" \\
  -H "Content-Type: application/json" \\
  -d '{"question":"quem é o Fernando?"}'`;

  // Contrato real de @galeed/mcp: GALEED_TOKEN + GALEED_API_URL (raiz /v1). Sem DB.
  const mcpConfig = `{
  "mcpServers": {
    "galeed": {
      "command": "npx",
      "args": ["-y", "@galeed/mcp"],
      "env": {
        "GALEED_TOKEN": "gld_live_SUA_CHAVE",
        "GALEED_API_URL": "${V1_BASE}"
      }
    }
  }
}`;

  const webhookExample = `curl -X POST "${V1_BASE}/ingest" \\
  -H "Authorization: Bearer gld_live_SUA_CHAVE" \\
  -H "Content-Type: application/json" \\
  -d '{"source":"zapier","content":"Reunião com a Acme — fechamos o piloto."}'`;

  return (
    <div>
      {/* page head */}
      <header style={{ marginBottom: 22 }}>
        <h1 style={{ margin: 0, fontSize: 32, fontWeight: 700, letterSpacing: "-.025em" }}>Conectar</h1>
        <p style={{ margin: "6px 0 0", fontSize: 14.5, color: "var(--muted)", maxWidth: 640, lineHeight: 1.5 }}>
          Os dois lados do plugue. <b>Seu agente de IA</b> acessa o cérebro pelos endpoints abaixo.
          E você liga <b>suas fontes</b> pra alimentá-lo. Tudo aponta para <b>{brainName}</b>.
        </p>
        {DOCS_URL && (
          <a href={DOCS_URL} target="_blank" rel="noopener noreferrer" style={{ display: "inline-flex", alignItems: "center", gap: 6, marginTop: 12, fontSize: 13.5, fontWeight: 600, color: "var(--accent-ink)", textDecoration: "none" }}>
            Ver a documentação completa <Icon name="arrow" size={14} />
          </a>
        )}
      </header>

      {/* ===================== Para seu agente de IA ===================== */}
      <SectionTitle
        icon="arrow"
        title="Para seu agente de IA"
        subtitle="Como o agente do seu cliente lê o cérebro: REST ou MCP. Autentica com uma chave deste cérebro."
      />

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: 18, marginBottom: 16 }}>
        {/* REST */}
        <Card
          padding="16px 18px 18px"
          header={
            <EndpointHeader
              kind="REST"
              title="API de leitura"
              note="HTTP · JSON"
            />
          }
        >
          <FieldRow label="Base da API" value={V1_BASE} onCopy={() => copy(V1_BASE, "Base copiada.")} />
          <p style={{ margin: "14px 0 7px", fontSize: 12.5, color: "var(--muted)", fontWeight: 600 }}>
            Exemplo · buscar contexto
          </p>
          <TokenBlock code={curlExample} onCopy={() => copy(curlExample, "Comando copiado.")} />
          <p style={{ margin: "10px 0 0", fontSize: 12, color: "var(--faint)", lineHeight: 1.5 }}>
            Rotas: <span className="mono">/ask</span> · <span className="mono">/facts</span> · <span className="mono">/ingest</span>
          </p>
        </Card>

        {/* MCP */}
        <Card
          padding="16px 18px 18px"
          header={
            <EndpointHeader
              kind="MCP"
              title="Servidor MCP (stdio)"
              note="Claude Code · runtimes MCP"
            />
          }
        >
          <p style={{ margin: "0 0 9px", fontSize: 12.5, color: "var(--muted)", lineHeight: 1.5 }}>
            Cole no <span className="mono">mcpServers</span> do cliente. Autentica com a chave deste cérebro.
            Não precisa de Postgres — o pacote fala só com <span className="mono">/v1</span>.
          </p>
          <TokenBlock code={mcpConfig} onCopy={() => copy(mcpConfig, "Config MCP copiada.")} />
          <p style={{ margin: "10px 0 0", fontSize: 12, color: "var(--faint)", lineHeight: 1.5 }}>
            Tools: <span className="mono">galeed_ask</span> · <span className="mono">galeed_facts</span> ·{" "}
            <span className="mono">galeed_ingest</span> · <span className="mono">galeed_ingest_status</span>.
            Pacote <span className="mono">npx @galeed/mcp</span>.
          </p>
        </Card>
      </div>

      {/* Chaves / tokens por brain */}
      <Card
        padding={0}
        style={{ marginBottom: 34 }}
        header={
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
            <div>
              <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Chaves deste cérebro</h3>
              <span style={{ fontSize: 12.5, color: "var(--muted)" }}>
                Uma chave por agente. Aparece inteira só na hora de gerar.
              </span>
            </div>
          </div>
        }
      >
        {principalsQ.loading && <p style={{ padding: "18px 20px", color: "var(--muted)" }}>Carregando…</p>}
        {principalsQ.error && (
          <p style={{ padding: "18px 20px", color: "var(--danger)" }}>
            Não deu pra carregar as chaves: {principalsQ.error.message}
          </p>
        )}
        {!principalsQ.loading && !principalsQ.error && agents.length === 0 && (
          <KeysEmpty />
        )}
        {!principalsQ.loading && !principalsQ.error && agents.length > 0 && (
          <div>
            {agents.map((p) => (
              <AgentKeyRow
                key={p.id}
                p={p}
                generating={tokenMut.loading}
                onGenerate={() => generateToken(p)}
                onRevoke={(t) => setRevoking({ p, token: t })}
              />
            ))}
          </div>
        )}
        <div style={{ padding: "12px 20px", borderTop: "1px solid var(--border)", fontSize: 12.5, color: "var(--faint)", lineHeight: 1.5 }}>
          Os agentes (bots) e o que cada um pode ver são definidos em <b>Quem vê o quê</b>. Aqui você só emite e revoga as chaves.
        </div>
      </Card>

      {/* ===================== Suas fontes / conexões ===================== */}
      <SectionTitle
        icon="plus"
        title="Suas fontes e conexões"
        subtitle="O que alimenta o cérebro. Aponte qualquer canal que fala webhook para a URL de ingestão."
      />

      <Card padding="16px 18px 18px" style={{ marginBottom: 16 }}>
        <EndpointHeader kind="WEBHOOK" title="URL de ingestão" note="POST · JSON" />
        <div style={{ height: 12 }} />
        <FieldRow label="Endpoint" value={`${V1_BASE}/ingest`} onCopy={() => copy(`${V1_BASE}/ingest`, "URL copiada.")} />
        <p style={{ margin: "14px 0 7px", fontSize: 12.5, color: "var(--muted)", fontWeight: 600 }}>
          Exemplo · enviar um evento
        </p>
        <TokenBlock code={webhookExample} onCopy={() => copy(webhookExample, "Comando copiado.")} />
        <p style={{ margin: "10px 0 0", fontSize: 12, color: "var(--faint)", lineHeight: 1.5 }}>
          Autentica com a chave do cérebro em <span className="mono">Authorization: Bearer</span>. O cérebro é derivado do token.
        </p>
      </Card>

      <WhatsAppEvolution setToast={setToast} />

      <ChatGptCodex setToast={setToast} />

      {/* ===================== Ingestores prontos ===================== */}
      <IngestoresProntos copy={copy} />

      <SourcesEmpty />

      {/* ===================== Modais & toasts ===================== */}

      {/* token cru — mostrado UMA vez */}
      <Modal
        open={!!fresh}
        onClose={() => setFresh(null)}
        title="Chave gerada"
        width={520}
        footer={
          <>
            <Button variant="ghost" onClick={() => setFresh(null)}>Já guardei</Button>
            {fresh && (
              <Button variant="primary" icon={<Icon name="check" size={15} />} onClick={() => copy(fresh.token, "Chave copiada.")}>
                Copiar a chave
              </Button>
            )}
          </>
        }
      >
        {fresh && (
          <div>
            <div
              style={{
                display: "flex",
                gap: 11,
                padding: "11px 13px",
                marginBottom: 14,
                borderRadius: 10,
                background: "var(--warn-soft, oklch(96% 0.05 85))",
                border: "1px solid oklch(85% 0.09 85)",
              }}
            >
              <span style={{ color: "var(--warn)", flexShrink: 0, display: "grid", placeItems: "center" }}>
                <Icon name="lock-closed" size={16} />
              </span>
              <p style={{ margin: 0, fontSize: 13, lineHeight: 1.45 }}>
                Copie agora — <b>esta é a única vez</b> que a chave aparece inteira. Depois só os últimos 4 dígitos.
                Chave de <b>{fresh.principal.label}</b>.
              </p>
            </div>
            <TokenBlock code={fresh.token} onCopy={() => copy(fresh.token, "Chave copiada.")} oneLine />
          </div>
        )}
      </Modal>

      {/* revogar = confirmação destrutiva */}
      <Modal
        open={!!revoking}
        onClose={() => setRevoking(null)}
        title="Revogar chave"
        footer={
          <>
            <Button variant="ghost" onClick={() => setRevoking(null)}>Cancelar</Button>
            <Button
              variant="primary"
              onClick={confirmRevoke}
              disabled={revokeMut.loading}
              style={{ background: "var(--danger)", borderColor: "var(--danger)" }}
            >
              {revokeMut.loading ? "Revogando…" : "Revogar a chave"}
            </Button>
          </>
        }
      >
        {revoking && (
          <p style={{ margin: 0, fontSize: 14.5, lineHeight: 1.5 }}>
            Revogar a chave <span className="mono">····{revoking.token.last4}</span> de <b>{revoking.p.label}</b>?
            O agente perde o acesso na hora.
          </p>
        )}
      </Modal>

      {toast && (
        <div style={{ position: "fixed", left: 0, right: 0, bottom: 24, display: "grid", placeItems: "center", zIndex: 1100, pointerEvents: "none" }}>
          <div style={{ pointerEvents: "auto" }}>
            <Toast tone={toast.tone} onClose={() => setToast(null)}>{toast.msg}</Toast>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// subcomponentes locais
// ---------------------------------------------------------------------------

function SectionTitle({ icon, title, subtitle }: { icon: "arrow" | "plus"; title: string; subtitle: string }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <h2 style={{ margin: 0, fontSize: 19, fontWeight: 700, letterSpacing: "-.01em", display: "flex", alignItems: "center", gap: 9 }}>
        <span style={{ display: "grid", placeItems: "center", width: 26, height: 26, borderRadius: 8, background: "var(--accent-soft)", color: "var(--accent-ink)" }}>
          <Icon name={icon} size={15} />
        </span>
        {title}
      </h2>
      <p style={{ margin: "5px 0 0 35px", fontSize: 13, color: "var(--muted)", lineHeight: 1.5, maxWidth: 620 }}>{subtitle}</p>
    </div>
  );
}

function EndpointHeader({ kind, title, note }: { kind: string; title: string; note: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <Chip>{kind}</Chip>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 15, fontWeight: 600 }}>{title}</div>
      </div>
      <span style={{ fontSize: 11.5, color: "var(--faint)", whiteSpace: "nowrap" }}>{note}</span>
    </div>
  );
}

/** Bloco de código com fundo --ink (tinta escura), mono, com botão copiar (tokenblock). */
function TokenBlock({ code, onCopy, oneLine }: { code: string; onCopy: () => void; oneLine?: boolean }) {
  return (
    <div style={{ position: "relative" }}>
      <pre
        className="mono"
        style={{
          margin: 0,
          padding: oneLine ? "13px 46px 13px 14px" : "13px 46px 13px 14px",
          background: "var(--ink)",
          color: "oklch(90% 0.015 240)",
          borderRadius: 10,
          fontSize: 12.5,
          lineHeight: 1.6,
          overflowX: "auto",
          whiteSpace: oneLine ? "nowrap" : "pre",
        }}
      >
        {code}
      </pre>
      <button
        type="button"
        aria-label="Copiar"
        title="Copiar"
        onClick={onCopy}
        style={{
          position: "absolute",
          top: 8,
          right: 8,
          display: "grid",
          placeItems: "center",
          width: 30,
          height: 30,
          borderRadius: 8,
          border: "1px solid oklch(40% 0.02 250)",
          background: "oklch(26% 0.02 250)",
          color: "oklch(82% 0.015 240)",
          cursor: "pointer",
        }}
      >
        <Icon name="plus" size={14} />
      </button>
    </div>
  );
}

function FieldRow({ label, value, onCopy, muted }: { label: string; value: string; onCopy: () => void; muted?: boolean }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ fontSize: 11.5, color: muted ? "var(--faint)" : "var(--muted)", fontWeight: 600, marginBottom: 4 }}>{label}</div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          border: "1px solid var(--border)",
          borderRadius: 9,
          background: "var(--surface-2)",
          padding: "7px 7px 7px 11px",
        }}
      >
        <span className="mono" style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: muted ? "var(--muted)" : "var(--fg)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {value}
        </span>
        <Button size="sm" variant="secondary" onClick={onCopy}>Copiar</Button>
      </div>
    </div>
  );
}

function AgentKeyRow({
  p,
  generating,
  onGenerate,
  onRevoke,
}: {
  p: Principal;
  generating: boolean;
  onGenerate: () => void;
  onRevoke: (t: Token) => void;
}) {
  const active = p.tokens.find((t) => !t.revoked);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 13, padding: "14px 20px", borderBottom: "1px solid var(--border)" }}>
      <span
        aria-hidden
        style={{ display: "grid", placeItems: "center", width: 36, height: 36, borderRadius: 10, background: "var(--surface-2)", border: "1px solid var(--border)", color: "var(--accent-ink)", flexShrink: 0 }}
      >
        <Icon name="info" size={17} />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14.5, fontWeight: 600 }}>{p.label}</div>
        <div className="mono" style={{ fontSize: 11.5, color: "var(--faint)", marginTop: 2 }}>
          {active ? (
            <>chave ····{active.last4}{active.last_used_at ? ` · usada ${relativeTime(active.last_used_at)}` : " · nunca usada"}</>
          ) : (
            "sem chave"
          )}
        </div>
      </div>
      {active ? (
        <Button size="sm" variant="secondary" onClick={() => onRevoke(active)} style={{ color: "var(--danger)", borderColor: "oklch(85% 0.07 25)" }}>
          Revogar
        </Button>
      ) : (
        <Button size="sm" variant="primary" disabled={generating} onClick={onGenerate}>
          {generating ? "Gerando…" : "Gerar token"}
        </Button>
      )}
    </div>
  );
}

function KeysEmpty() {
  return (
    <div style={{ padding: "40px 20px", textAlign: "center" }}>
      <span style={{ display: "inline-grid", placeItems: "center", width: 52, height: 52, borderRadius: 14, background: "var(--surface-2)", border: "1px solid var(--border)", color: "var(--muted)", marginBottom: 13 }}>
        <Icon name="lock-closed" size={24} />
      </span>
      <h3 style={{ margin: "0 0 6px", fontSize: 16.5, fontWeight: 600 }}>Nenhuma chave ainda</h3>
      <p style={{ margin: "0 auto", maxWidth: 380, fontSize: 13.5, color: "var(--muted)", lineHeight: 1.5 }}>
        Crie um agente em <b>Quem vê o quê</b> para emitir a primeira chave. Cada agente recebe a sua, com o acesso que você liberar.
      </p>
    </div>
  );
}

/** Ingestores prontos — webhooks de fábrica do registry (GET /api/ingestors). Cada um já sabe
 *  "trabalhar" o payload do canal (o middleware) antes de ingerir: é só apontar a ferramenta pra URL. */
function WhatsAppEvolution({
  setToast,
}: {
  setToast: (t: { msg: string; tone: "ok" | "neutral" | "danger" } | null) => void;
}) {
  const stQ = useQuery(
    "conectar:evolution",
    () => api.evolution.status(),
    [],
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [local, setLocal] = useState<Awaited<ReturnType<typeof api.evolution.connect>> | null>(null);
  const [mode, setMode] = useState<"qr" | "number">("qr");
  const [number, setNumber] = useState("");
  const [adding, setAdding] = useState(false);
  const view = local ?? stQ.data;
  const instances = view?.instances?.length
    ? view.instances
    : view?.instanceName
      ? [{
          instanceName: view.instanceName,
          state: view.state,
          connected: view.connected,
          qrBase64: view.qrBase64,
          pairingCode: view.pairingCode ?? null,
          lastError: view.lastError,
        }]
      : [];
  const waiting = instances.some((i) => !i.connected && (i.qrBase64 || i.pairingCode || i.state === "connecting"));

  function apply(r: Awaited<ReturnType<typeof api.evolution.connect>>) {
    setLocal(r);
    stQ.refetch();
  }

  async function connect(opts: { add?: boolean; instanceName?: string; number?: string }) {
    const key = opts.instanceName || (opts.add ? "add" : "new");
    setBusy(key);
    try {
      const r = await api.evolution.connect(opts);
      apply(r);
      setAdding(false);
      setToast({
        msg: r.message || (r.connected ? "WhatsApp conectado." : r.pairingCode ? "Código pronto." : "QR pronto — escaneie."),
        tone: "ok",
      });
    } catch (e) {
      setToast({ msg: (e as Error).message || "Falha ao conectar Evolution.", tone: "danger" });
    } finally {
      setBusy(null);
    }
  }

  async function refreshQr(instanceName?: string) {
    setBusy(instanceName || "qr");
    try {
      const r = await api.evolution.refreshQr({ instanceName });
      apply(r);
      setToast({ msg: r.message || "QR renovado.", tone: "neutral" });
    } catch (e) {
      setToast({ msg: (e as Error).message || "Falha ao renovar QR.", tone: "danger" });
    } finally {
      setBusy(null);
    }
  }

  async function disconnect(instanceName: string) {
    setBusy(instanceName);
    try {
      const r = await api.evolution.disconnect({ instanceName });
      apply(r);
      setToast({ msg: r.message || "Conta desconectada.", tone: "neutral" });
    } catch (e) {
      setToast({ msg: (e as Error).message || "Falha ao desconectar.", tone: "danger" });
    } finally {
      setBusy(null);
    }
  }

  useEffect(() => {
    if (!view?.online || !waiting) return;
    const t = setInterval(() => {
      api.evolution.status().then((s) => {
        const now = s.instances ?? [];
        const was = instances.filter((i) => !i.connected).map((i) => i.instanceName);
        const newly = now.filter((i) => i.connected && was.includes(i.instanceName));
        setLocal(s);
        if (newly.length) {
          setToast({ msg: newly.length === 1 ? "WhatsApp conectado!" : "Contas WhatsApp conectadas.", tone: "ok" });
          stQ.refetch();
        }
      }).catch(() => {});
    }, 4000);
    return () => clearInterval(t);
  }, [view?.online, waiting, instances.map((i) => `${i.instanceName}:${i.connected}`).join("|")]);

  const digitsHint = number.replace(/\D/g, "");

  return (
    <Card padding="16px 18px 18px" style={{ marginBottom: 16 }}>
      <EndpointHeader kind="WHATSAPP" title="WhatsApp (Evolution)" note="QR ou número" />
      <p style={{ margin: "8px 0 12px", fontSize: 13, color: "var(--muted)", lineHeight: 1.55 }}>
        Várias contas no mesmo cérebro. Cada uma tem instância e QR/código próprios — desconectar uma
        não derruba as outras.
      </p>

      {stQ.loading && !view && (
        <p style={{ margin: 0, fontSize: 13, color: "var(--muted)" }}>Checando Evolution…</p>
      )}

      {view && !view.configured && (
        <p style={{ margin: "0 0 12px", fontSize: 13, color: "var(--muted)", lineHeight: 1.5 }}>
          {view.message || "Evolution não configurada no .env."}
        </p>
      )}

      {view?.configured && !view.online && (
        <p style={{ margin: "0 0 12px", fontSize: 13, color: "var(--warn, #a60)", lineHeight: 1.5 }}>
          {view.message || "Evolution offline."}
        </p>
      )}

      {instances.map((inst) => (
        <div
          key={inst.instanceName}
          style={{
            marginBottom: 14,
            padding: "12px 13px",
            borderRadius: 12,
            border: "1px solid var(--border)",
            background: "var(--surface-2)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: inst.connected ? 0 : 10, flexWrap: "wrap" }}>
            <span
              className="mono"
              style={{
                fontSize: 11,
                fontWeight: 600,
                letterSpacing: "0.04em",
                textTransform: "uppercase",
                padding: "4px 9px",
                borderRadius: 999,
                background: inst.connected
                  ? "var(--st-fact-soft, oklch(95% 0.03 145))"
                  : "var(--surface)",
                color: inst.connected
                  ? "var(--st-fact, oklch(42% 0.12 145))"
                  : "var(--muted)",
              }}
            >
              {inst.connected ? "Conectado" : inst.state === "connecting" ? "Conectando" : inst.state || "Livre"}
            </span>
            <span style={{ fontSize: 12.5, color: "var(--muted)" }} className="mono">
              {inst.instanceName}
            </span>
          </div>

          {inst.state === "connecting" && !inst.qrBase64 && !inst.pairingCode && !inst.connected && (
            <p style={{ margin: "0 0 10px", fontSize: 12.5, color: "var(--muted)", lineHeight: 1.45 }}>
              Aguardando QR/código da Evolution… se não aparecer, renove abaixo.
            </p>
          )}

          {inst.pairingCode && !inst.connected && (
            <div style={{ marginBottom: 12 }}>
              <div
                className="mono"
                style={{
                  fontSize: 26,
                  fontWeight: 700,
                  letterSpacing: "0.16em",
                  padding: "12px 16px",
                  borderRadius: 10,
                  border: "1px solid var(--border)",
                  background: "var(--surface)",
                  width: "fit-content",
                }}
              >
                {inst.pairingCode}
              </div>
              <p style={{ margin: "8px 0 0", fontSize: 12.5, color: "var(--muted)", maxWidth: 420, lineHeight: 1.45 }}>
                WhatsApp → Aparelhos conectados → Conectar com número de telefone. O código expira ~60s.
              </p>
            </div>
          )}

          {inst.qrBase64 && !inst.connected && (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 10, marginBottom: 12 }}>
              <img
                src={inst.qrBase64}
                alt={`QR Code ${inst.instanceName}`}
                width={220}
                height={220}
                style={{ borderRadius: 12, border: "1px solid var(--border)", background: "#fff" }}
              />
              <p style={{ margin: 0, fontSize: 12.5, color: "var(--muted)", maxWidth: 360, lineHeight: 1.45 }}>
                WhatsApp → Aparelhos conectados → Conectar um aparelho. O QR expira ~60s.
              </p>
            </div>
          )}

          {inst.lastError && (
            <p style={{ margin: "0 0 10px", fontSize: 12.5, color: "var(--danger)", lineHeight: 1.45 }}>{inst.lastError}</p>
          )}

          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {inst.connected ? (
              <>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy !== null}
                  onClick={() => connect({ instanceName: inst.instanceName })}
                >
                  {busy === inst.instanceName ? "Aguardando…" : "Reconfigurar webhook"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy !== null}
                  onClick={() => disconnect(inst.instanceName)}
                  style={{ color: "var(--danger)" }}
                >
                  Desconectar
                </Button>
              </>
            ) : (
              <>
                <Button
                  size="sm"
                  variant="primary"
                  disabled={busy !== null || view?.configured === false}
                  onClick={() => connect({ instanceName: inst.instanceName })}
                >
                  {busy === inst.instanceName ? "Conectando…" : "Conectar (QR)"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy !== null}
                  onClick={() => refreshQr(inst.instanceName)}
                >
                  Renovar QR
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy !== null || digitsHint.length < 10}
                  onClick={() => connect({ instanceName: inst.instanceName, number: digitsHint })}
                >
                  Pedir código
                </Button>
              </>
            )}
          </div>
        </div>
      ))}

      {(adding || instances.length === 0 || instances.some((i) => !i.connected)) && view?.configured !== false && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
            <Button size="sm" variant={mode === "qr" ? "primary" : "secondary"} onClick={() => setMode("qr")}>
              QR
            </Button>
            <Button size="sm" variant={mode === "number" ? "primary" : "secondary"} onClick={() => setMode("number")}>
              Número
            </Button>
          </div>
          {mode === "number" && (
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 11.5, color: "var(--muted)", fontWeight: 600, marginBottom: 4 }}>
                Número (DDI+DDD, só dígitos)
              </div>
              <input
                value={number}
                onChange={(e) => setNumber(e.target.value)}
                placeholder="5511999998888"
                inputMode="numeric"
                autoComplete="tel"
                style={{
                  width: "100%",
                  maxWidth: 280,
                  border: "1px solid var(--border)",
                  borderRadius: 9,
                  background: "var(--surface-2)",
                  padding: "8px 11px",
                  fontSize: 14,
                  color: "var(--fg)",
                }}
              />
              {digitsHint && digitsHint.length < 10 && (
                <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--muted)" }}>
                  Inclua o país (55…) — {digitsHint.length} dígitos.
                </p>
              )}
            </div>
          )}
          <Button
            variant="primary"
            disabled={busy !== null || view?.online === false || (mode === "number" && digitsHint.length < 10)}
            onClick={() =>
              connect({
                add: instances.length > 0,
                number: mode === "number" ? digitsHint : undefined,
              })
            }
          >
            {busy === "add" || busy === "new" ? "Conectando…" : instances.length ? "Gerar conta" : "Conectar WhatsApp"}
          </Button>
        </div>
      )}

      {view?.lastError && !instances.some((i) => i.lastError) && (
        <p style={{ margin: "0 0 10px", fontSize: 12.5, color: "var(--danger)", lineHeight: 1.45 }}>{view.lastError}</p>
      )}

      {view?.online && instances.length > 0 && !adding && (
        <Button variant="secondary" disabled={busy !== null} onClick={() => { setAdding(true); setMode("qr"); }}>
          Adicionar WhatsApp
        </Button>
      )}
    </Card>
  );
}

function ChatGptCodex({
  setToast,
}: {
  setToast: (t: { msg: string; tone: "ok" | "neutral" | "danger" } | null) => void;
}) {
  const { current } = useBrain();
  const brainId = current?.id ?? "";
  const stQ = useQuery(`conectar:codex:${brainId}`, () => api.llmCodex.status(), [brainId]);
  const [busy, setBusy] = useState(false);
  const [local, setLocal] = useState<Awaited<ReturnType<typeof api.llmCodex.start>> | null>(null);
  const view = stQ.data;
  const pending = !view?.connected && !!(local || view?.pending);
  const userCode = local?.userCode || view?.userCode;
  const verificationUrl = local?.verificationUrl || view?.verificationUrl;
  const intervalMs = Math.max(3, local?.interval ?? 5) * 1000;

  async function connect() {
    if (pending && verificationUrl) {
      window.open(verificationUrl, "_blank", "noopener,noreferrer");
      return;
    }
    setBusy(true);
    try {
      const r = await api.llmCodex.start();
      setLocal(r);
      if (r.verificationUrl) window.open(r.verificationUrl, "_blank", "noopener,noreferrer");
      setToast({ msg: "Abra a aba do ChatGPT, entre com a conta e aprove o código.", tone: "ok" });
      stQ.refetch();
    } catch (e) {
      setToast({ msg: (e as Error).message || "Falha ao iniciar o login ChatGPT.", tone: "danger" });
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    try {
      await api.llmCodex.disconnect();
      setLocal(null);
      setToast({ msg: "ChatGPT desconectado.", tone: "neutral" });
      stQ.refetch();
    } catch (e) {
      setToast({ msg: (e as Error).message || "Falha ao desconectar.", tone: "danger" });
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (view?.connected || !pending || !userCode) return;
    const t = setInterval(() => {
      api.llmCodex.poll().then((s) => {
        if (s.connected) {
          setLocal(null);
          setToast({ msg: "ChatGPT conectado.", tone: "ok" });
          stQ.refetch();
        }
      }).catch(() => {});
    }, intervalMs);
    return () => clearInterval(t);
  }, [view?.connected, pending, userCode, intervalMs]);

  return (
    <Card padding="16px 18px 18px" style={{ marginBottom: 16 }}>
      <EndpointHeader kind="CHATGPT" title="ChatGPT (assinatura)" note="OAuth · Plus/Pro" />
      <p style={{ margin: "8px 0 12px", fontSize: 13, color: "var(--muted)", lineHeight: 1.55 }}>
        Conecte a conta ChatGPT (Plus/Pro) da mesma forma que no Hermes. Os tokens ficam neste cérebro,
        no banco — sem arquivo no servidor.
      </p>

      {stQ.loading && !view && (
        <p style={{ margin: 0, fontSize: 13, color: "var(--muted)" }}>Checando ChatGPT…</p>
      )}

      {view?.connected && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
          <span
            className="mono"
            style={{
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: "0.04em",
              textTransform: "uppercase",
              padding: "4px 9px",
              borderRadius: 999,
              background: "var(--st-fact-soft, oklch(95% 0.03 145))",
              color: "var(--st-fact, oklch(42% 0.12 145))",
            }}
          >
            Conectado
          </span>
          {view.expiresAt && (
            <span style={{ fontSize: 12.5, color: "var(--muted)" }}>
              sessão até {new Date(view.expiresAt).toLocaleString()}
            </span>
          )}
        </div>
      )}

      {pending && userCode && !view?.connected && (
        <div style={{ marginBottom: 14 }}>
          <p style={{ margin: "0 0 8px", fontSize: 13, color: "var(--muted)", lineHeight: 1.5 }}>
            Aprove no ChatGPT com este código
            {verificationUrl ? (
              <>
                {" "}
                (ou <a href={verificationUrl} target="_blank" rel="noreferrer">abra de novo</a>)
              </>
            ) : null}
            :
          </p>
          <div
            className="mono"
            style={{
              fontSize: 22,
              fontWeight: 700,
              letterSpacing: "0.12em",
              padding: "10px 14px",
              borderRadius: 10,
              border: "1px solid var(--border)",
              background: "var(--surface-2)",
              width: "fit-content",
            }}
          >
            {userCode}
          </div>
        </div>
      )}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {view?.connected ? (
          <Button variant="ghost" disabled={busy} onClick={disconnect}>
            Desconectar
          </Button>
        ) : (
          <Button variant="primary" disabled={busy} onClick={connect}>
            {pending ? "Abrir aprovação" : "Conectar ChatGPT"}
          </Button>
        )}
      </div>
    </Card>
  );
}

function IngestoresProntos({ copy }: { copy: (text: string, label?: string) => void }) {
  const q = useQuery<{ ingestors: { slug: string; nome: string; descricao: string; exemplo?: string }[] }>(
    "conectar:ingestors",
    () => fetch("/api/ingestors").then((r) => r.json()),
    [],
  );
  const lista = q.data?.ingestors ?? [];
  if (!lista.length) return null;

  return (
    <Card padding="16px 18px 18px" style={{ marginBottom: 16 }}>
      <EndpointHeader kind="INGESTORES" title="Ingestores prontos" note="POST · JSON" />
      <p style={{ margin: "8px 0 4px", fontSize: 13, color: "var(--muted)", lineHeight: 1.55 }}>
        Canais com o formato já tratado: aponte a ferramenta pra URL do ingestor e pronto — o payload
        cru é preparado antes de entrar no cérebro. Autentica com{" "}
        <span className="mono">Authorization: Bearer</span> (ou <span className="mono">?token=</span>{" "}
        quando a ferramenta não manda header).
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
      <p style={{ margin: "14px 0 0", fontSize: 12, color: "var(--faint)", lineHeight: 1.5 }}>
        Pasta local (Drive/OneDrive sincronizado): <span className="mono">npm run galeed -- pasta --dir ~/SuaPasta</span>.
        Pra criar o SEU ingestor (é 1 arquivo): <span className="mono">INGESTORES.md</span> na raiz do projeto.
      </p>
    </Card>
  );
}

function SourcesEmpty() {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 14,
        padding: "18px 20px",
        borderRadius: 13,
        border: "1px dashed var(--border-strong)",
        background: "var(--surface-2)",
      }}
    >
      <span style={{ display: "grid", placeItems: "center", width: 40, height: 40, borderRadius: 11, background: "var(--surface)", border: "1px solid var(--border)", color: "var(--muted)", flexShrink: 0 }}>
        <Icon name="plus" size={19} />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14.5, fontWeight: 600 }}>Nenhuma fonte conectada ainda</div>
        <p style={{ margin: "3px 0 0", fontSize: 13, color: "var(--muted)", lineHeight: 1.5 }}>
          Aponte um notetaker, Zapier/Make, WhatsApp ou e-mail para a URL acima.
        </p>
      </div>
    </div>
  );
}
