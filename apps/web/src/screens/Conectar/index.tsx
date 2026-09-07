/** Conectar — motor de LLM do cérebro. Ordem + fallback. Sem fontes, sem chaves de agente. */
import { useEffect, useState } from "react";
import { Button, Card, Chip, Toast } from "../../ui";
import { api } from "../../lib/api";
import type { LlmSlotId, LlmSlotView } from "../../lib/api";
import { useQuery } from "../../lib/useQuery";
import { useBrain } from "../../lib/auth";

const SLOT_LABEL: Record<LlmSlotId, string> = {
  chatgpt: "ChatGPT (assinatura)",
  anthropic: "API Anthropic",
  openai: "API OpenAI",
  qwen: "API Qwen / DashScope",
};

export default function Conectar() {
  const { current } = useBrain();
  const brainId = current?.id ?? "";
  const [toast, setToast] = useState<{ msg: string; tone: "ok" | "neutral" | "danger" } | null>(null);
  const chainQ = useQuery(`conectar:chain:${brainId}`, () => api.llmChain.status(), [brainId]);
  const [slots, setSlots] = useState<LlmSlotView[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (chainQ.data?.slots) setSlots(chainQ.data.slots);
  }, [chainQ.data]);

  async function persist(next: LlmSlotView[]) {
    setSlots(next);
    setSaving(true);
    try {
      const r = await api.llmChain.save(next.map((s) => ({ id: s.id, enabled: s.enabled })));
      setSlots(r.slots);
      setToast({ msg: "Ordem salva.", tone: "ok" });
    } catch (e) {
      setToast({ msg: (e as Error).message || "Não deu pra salvar a ordem.", tone: "danger" });
      chainQ.refetch();
    } finally {
      setSaving(false);
    }
  }

  function move(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= slots.length) return;
    const next = slots.slice();
    const tmp = next[i];
    next[i] = next[j]!;
    next[j] = tmp!;
    persist(next);
  }

  function setPrimary(i: number) {
    if (i === 0) return;
    const next = slots.slice();
    const [picked] = next.splice(i, 1);
    if (!picked) return;
    next.unshift(picked);
    persist(next);
  }

  function toggle(i: number) {
    const next = slots.map((s, k) => (k === i ? { ...s, enabled: !s.enabled } : s));
    persist(next);
  }

  return (
    <div>
      <header style={{ marginBottom: 22 }}>
        <h1 style={{ margin: 0, fontSize: 32, fontWeight: 700, letterSpacing: "-.025em" }}>Conectar</h1>
        <p style={{ margin: "6px 0 0", fontSize: 14.5, color: "var(--muted)", maxWidth: 640, lineHeight: 1.5 }}>
          O motor do cérebro. Ligue os provedores e coloque a <b>primária no topo</b>.
          Se a de cima falhar, tenta a de baixo. Uma de cada vez.
        </p>
      </header>

      <Card padding="16px 18px 18px" style={{ marginBottom: 16 }}>
        <h3 style={{ margin: "0 0 6px", fontSize: 16, fontWeight: 600 }}>Ordem das IAs</h3>
        <p style={{ margin: "0 0 14px", fontSize: 13, color: "var(--muted)", lineHeight: 1.5 }}>
          {chainQ.data?.message || "Se a de cima falhar, tenta a de baixo."}
        </p>
        {chainQ.loading && !slots.length && (
          <p style={{ margin: 0, fontSize: 13, color: "var(--muted)" }}>Carregando a cadeia…</p>
        )}
        {slots.map((s, i) => (
          <div
            key={s.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "12px 13px",
              marginBottom: 8,
              borderRadius: 12,
              border: "1px solid var(--border)",
              background: i === 0 && s.enabled ? "var(--accent-soft)" : "var(--surface-2)",
            }}
          >
            <span className="mono" style={{ fontSize: 12, fontWeight: 700, color: "var(--muted)", width: 22 }}>
              {i + 1}
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span style={{ fontSize: 14.5, fontWeight: 600 }}>{SLOT_LABEL[s.id]}</span>
                {i === 0 && s.enabled && <Chip active>Primária</Chip>}
                <Chip>{s.ready ? "pronta" : "sem credencial"}</Chip>
                {!s.enabled && <Chip>desligada</Chip>}
              </div>
              <p style={{ margin: "3px 0 0", fontSize: 12.5, color: "var(--muted)" }}>{s.hint}</p>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              <Button size="sm" variant="ghost" disabled={saving || i === 0} onClick={() => move(i, -1)}>
                Subir
              </Button>
              <Button size="sm" variant="ghost" disabled={saving || i === slots.length - 1} onClick={() => move(i, 1)}>
                Descer
              </Button>
              {i > 0 && (
                <Button size="sm" variant="secondary" disabled={saving} onClick={() => setPrimary(i)}>
                  Definir como primária
                </Button>
              )}
              <Button size="sm" variant="secondary" disabled={saving} onClick={() => toggle(i)}>
                {s.enabled ? "Desligar" : "Ligar"}
              </Button>
            </div>
          </div>
        ))}
      </Card>

      <ChatGptCodex setToast={setToast} />

      <Card padding="16px 18px 18px" style={{ marginBottom: 16 }}>
        <h3 style={{ margin: "0 0 6px", fontSize: 16, fontWeight: 600 }}>Outras APIs (Anthropic, OpenAI, Qwen)</h3>
        <p style={{ margin: 0, fontSize: 13, color: "var(--muted)", lineHeight: 1.55 }}>
          As chaves <span className="mono">ANTHROPIC_API_KEY</span>,{" "}
          <span className="mono">OPENAI_API_KEY</span> e{" "}
          <span className="mono">QWEN_API_KEY</span> (ou <span className="mono">DASHSCOPE_API_KEY</span>)
          moram no <b>.env do servidor</b> — não colamos secret na tela. Quando a chave existe,
          ligue e ordene o card acima. WhatsApp e ingestão ficam em <b>Fontes</b>; chaves de bot
          ficam em <b>Acesso</b>.
        </p>
      </Card>

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
      <h3 style={{ margin: "0 0 6px", fontSize: 16, fontWeight: 600 }}>ChatGPT (assinatura)</h3>
      <p style={{ margin: "0 0 12px", fontSize: 13, color: "var(--muted)", lineHeight: 1.55 }}>
        Conecte a conta ChatGPT (Plus/Pro). Os tokens ficam neste cérebro, no banco — sem arquivo no servidor.
      </p>
      {stQ.loading && !view && (
        <p style={{ margin: 0, fontSize: 13, color: "var(--muted)" }}>Checando ChatGPT…</p>
      )}
      {view?.connected && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
          <Chip active>Conectado</Chip>
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
