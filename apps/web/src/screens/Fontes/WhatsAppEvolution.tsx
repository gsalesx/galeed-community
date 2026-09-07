/** WhatsApp (Evolution) — vários números na mesma fonte. Mora em Fontes. */
import { useEffect, useState } from "react";
import { Button, Card, Modal } from "../../ui";
import { api } from "../../lib/api";
import type { EvolutionStatus } from "../../lib/api";
import { useQuery } from "../../lib/useQuery";
import { EndpointHeader } from "../shared/plugue";

export type ToastFn = (t: { msg: string; tone: "ok" | "neutral" | "danger" | "warn" } | null) => void;

/** Status não traz QR/código — o poll não pode apagar o que o connect acabou de devolver. */
export function keepPendingCodes(next: EvolutionStatus, prev: EvolutionStatus | null): EvolutionStatus {
  const prevList = prev?.instances?.length
    ? prev.instances
    : prev?.instanceName
      ? [{
          instanceName: prev.instanceName,
          state: prev.state,
          connected: prev.connected,
          qrBase64: prev.qrBase64,
          pairingCode: prev.pairingCode ?? null,
          lastError: prev.lastError,
        }]
      : [];
  const prevByName = new Map(prevList.map((i) => [i.instanceName, i]));
  const list = (next.instances ?? []).map((inst) => {
    if (inst.connected) return { ...inst, qrBase64: null, pairingCode: null };
    const p = prevByName.get(inst.instanceName);
    return {
      ...inst,
      qrBase64: inst.qrBase64 || p?.qrBase64 || null,
      pairingCode: inst.pairingCode || p?.pairingCode || null,
    };
  });
  const focus = list.find((i) => !i.connected && (i.qrBase64 || i.pairingCode));
  return {
    ...next,
    instances: list,
    qrBase64: next.qrBase64 || focus?.qrBase64 || null,
    pairingCode: next.pairingCode || focus?.pairingCode || null,
  };
}

export function WhatsAppEvolution({ setToast, embedded }: { setToast: ToastFn; embedded?: boolean }) {
  const stQ = useQuery("fontes:evolution", () => api.evolution.status(), []);
  const [busy, setBusy] = useState<string | null>(null);
  const [local, setLocal] = useState<Awaited<ReturnType<typeof api.evolution.connect>> | null>(null);
  const [mode, setMode] = useState<"qr" | "number">("qr");
  const [number, setNumber] = useState("");
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
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
  const hasPending = instances.some((i) => !i.connected);
  const waiting = instances.some((i) => !i.connected && (i.qrBase64 || i.pairingCode || i.state === "connecting"));
  const canAddAnother = instances.length > 0 && !hasPending;

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

  async function removeNumber(instanceName: string) {
    setBusy(instanceName);
    try {
      const r = await api.evolution.disconnect({ instanceName });
      apply(r);
      setToast({ msg: r.message || "Número removido.", tone: "neutral" });
    } catch (e) {
      setToast({ msg: (e as Error).message || "Falha ao remover o número.", tone: "danger" });
    } finally {
      setBusy(null);
      setRemoving(null);
    }
  }

  useEffect(() => {
    if (!view?.online || !waiting) return;
    const t = setInterval(() => {
      api.evolution.status().then((s) => {
        const now = s.instances ?? [];
        const was = instances.filter((i) => !i.connected).map((i) => i.instanceName);
        const newly = now.filter((i) => i.connected && was.includes(i.instanceName));
        setLocal((prev) => keepPendingCodes(s, prev));
        if (newly.length) {
          setToast({ msg: newly.length === 1 ? "WhatsApp conectado!" : "Contas WhatsApp conectadas.", tone: "ok" });
          stQ.refetch();
        }
      }).catch(() => {});
    }, 4000);
    return () => clearInterval(t);
  }, [view?.online, waiting, instances.map((i) => `${i.instanceName}:${i.connected}`).join("|")]);

  const digitsHint = number.replace(/\D/g, "");

  const body = (
    <>
      {!embedded && <EndpointHeader kind="WHATSAPP" title="WhatsApp (Evolution)" note="QR ou número" />}
      <p style={{ margin: embedded ? "0 0 12px" : "8px 0 12px", fontSize: 13, color: "var(--muted)", lineHeight: 1.55 }}>
        Várias contas no mesmo cérebro. Cada uma tem instância e QR/código próprios — remover um
        número não derruba os outros nem apaga a memória.
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
                  onClick={() => setRemoving(inst.instanceName)}
                  style={{ color: "var(--danger)" }}
                >
                  Remover número
                </Button>
              </>
            ) : mode === "number" ? (
              <Button
                size="sm"
                variant="primary"
                disabled={busy !== null || digitsHint.length < 10 || view?.configured === false}
                onClick={() => connect({ instanceName: inst.instanceName, number: digitsHint })}
              >
                {busy === inst.instanceName ? "Conectando…" : "Pedir código"}
              </Button>
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
              </>
            )}
          </div>
        </div>
      ))}

      {(adding || instances.length === 0 || hasPending) && view?.configured !== false && (
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
          {(instances.length === 0 || adding) && !hasPending && (
            <Button
              variant="primary"
              disabled={busy !== null || view?.online === false || (mode === "number" && digitsHint.length < 10)}
              onClick={() =>
                connect({
                  add: canAddAnother,
                  number: mode === "number" ? digitsHint : undefined,
                })
              }
            >
              {busy === "add" || busy === "new" ? "Conectando…" : instances.length ? "Gerar conta" : "Conectar WhatsApp"}
            </Button>
          )}
          {hasPending && mode === "number" && (
            <Button
              variant="primary"
              disabled={busy !== null || view?.online === false || digitsHint.length < 10}
              onClick={() => {
                const pending = instances.find((i) => !i.connected);
                if (!pending) return;
                connect({ instanceName: pending.instanceName, number: digitsHint });
              }}
            >
              Pedir código
            </Button>
          )}
        </div>
      )}

      {view?.lastError && !instances.some((i) => i.lastError) && (
        <p style={{ margin: "0 0 10px", fontSize: 12.5, color: "var(--danger)", lineHeight: 1.45 }}>{view.lastError}</p>
      )}

      {view?.online && canAddAnother && !adding && (
        <Button variant="secondary" disabled={busy !== null} onClick={() => { setAdding(true); setMode("qr"); }}>
          Adicionar WhatsApp
        </Button>
      )}

      <Modal
        open={!!removing}
        onClose={() => setRemoving(null)}
        title="Remover número"
        footer={
          <>
            <Button variant="ghost" onClick={() => setRemoving(null)}>Cancelar</Button>
            <Button
              variant="primary"
              disabled={busy !== null}
              onClick={() => removing && removeNumber(removing)}
              style={{ background: "var(--danger)", borderColor: "var(--danger)" }}
            >
              {busy === removing ? "Removendo…" : "Remover este número"}
            </Button>
          </>
        }
      >
        <p style={{ margin: 0, fontSize: 14.5, lineHeight: 1.5 }}>
          Desloga e apaga só este aparelho. Os outros números seguem. A memória do WhatsApp não é apagada.
        </p>
      </Modal>
    </>
  );

  if (embedded) return body;
  return (
    <Card padding="16px 18px 18px" style={{ marginBottom: 16 }}>
      {body}
    </Card>
  );
}
