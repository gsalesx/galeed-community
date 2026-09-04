/** M8/S1 — Estados globais do shell (app-shell.md §6).
 *
 *  - <ApiErrorBanner/>: escuta o evento global `galeed:unauthorized` + um evento
 *    próprio `galeed:apierror` (qualquer tela pode disparar `window.dispatchEvent(
 *    new CustomEvent("galeed:apierror", { detail: { message } }))`). Banner em tom
 *    --danger com ação "Tentar de novo" (recarrega a rota atual).
 *  - <FtsBanner/>: aviso âmbar "busca em modo FTS — embeddings desligados". Só
 *    aparece quando `hasAiKey === false` (passado pelo shell; default não mostra).
 *  - <EmConstrucao/>: placeholder reutilizável "tela em construção" — usado pelas
 *    rotas cujo módulo de tela ainda não foi entregue pelos Devs S4–S11.
 */
import { useEffect, useState } from "react";
import { Brand, Button, Card, Icon } from "../ui";

/** Evento que qualquer camada pode disparar pra erguer o banner de erro global. */
export const API_ERROR_EVENT = "galeed:apierror";

interface ApiErrorDetail {
  message?: string;
}

/** Banner de erro de API (escuta 401 e erros explícitos). Topbar/sidebar seguem operáveis. */
export function ApiErrorBanner() {
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    function onUnauthorized() {
      setMsg("Sua sessão expirou. Entre de novo pra continuar.");
    }
    function onApiError(e: Event) {
      const detail = (e as CustomEvent<ApiErrorDetail>).detail;
      setMsg(detail?.message || "Algo deu errado ao falar com o servidor.");
    }
    window.addEventListener("galeed:unauthorized", onUnauthorized);
    window.addEventListener(API_ERROR_EVENT, onApiError);
    return () => {
      window.removeEventListener("galeed:unauthorized", onUnauthorized);
      window.removeEventListener(API_ERROR_EVENT, onApiError);
    };
  }, []);

  if (!msg) return null;

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
      <span style={{ flex: 1 }}>{msg}</span>
      <Button
        size="sm"
        variant="secondary"
        onClick={() => {
          setMsg(null);
          window.location.reload();
        }}
      >
        Tentar de novo
      </Button>
    </div>
  );
}

export interface FtsBannerProps {
  /** o shell descobre via /api/stats ou config; default: não mostra. */
  show?: boolean;
}

/** Banner âmbar: busca rodando em modo FTS (sem chave de IA → sem embeddings/reranker). */
export function FtsBanner({ show }: FtsBannerProps) {
  if (!show) return null;
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
      <span style={{ flex: 1 }}>
        Busca rápida ligada. Pra respostas mais espertas, conecte uma chave de IA.
      </span>
      <a href="/app/conectar" style={{ fontWeight: 600, whiteSpace: "nowrap" }}>
        Conectar →
      </a>
    </div>
  );
}

export interface EmConstrucaoProps {
  /** nome amigável da tela (ex "Fatos"). */
  nome?: string;
}

/** Placeholder honesto "tela em construção". As telas reais (S4–S11) sobrescrevem o módulo. */
export function EmConstrucao({ nome }: EmConstrucaoProps) {
  return (
    <div style={{ display: "grid", placeItems: "center", minHeight: "50vh", padding: 24 }}>
      <Card style={{ maxWidth: 420, textAlign: "center", padding: "32px 28px" }}>
        <div style={{ display: "grid", placeItems: "center", marginBottom: 16 }}>
          <Brand size={34} glyphOnly />
        </div>
        <h3 style={{ marginBottom: 8 }}>{nome ? `${nome} — em construção` : "Em construção"}</h3>
        <p className="muted" style={{ fontSize: 14 }}>
          Essa tela está sendo montada. Volte em breve.
        </p>
      </Card>
    </div>
  );
}

export default EmConstrucao;
