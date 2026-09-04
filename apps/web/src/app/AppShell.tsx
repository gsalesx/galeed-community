/** M8/S1 — Chassi do console (app-shell.md §2): grid topbar + sidebar + main.
 *
 *  .shell = grid 236px / 1fr, rows auto / 1fr, min-height 100vh.
 *  Topbar ocupa as duas colunas (sticky topo); Sidebar sticky abaixo; <Outlet/> no .main.
 *  Estados globais (ApiErrorBanner / FtsBanner) ficam no topo do .main, sobre toda tela.
 *  `slim`: variante do /portal — sem sidebar de admin (só topbar + conteúdo).
 *  Responsivo: <860px colapsa a sidebar (vira coluna única).
 */
import { Suspense, useEffect, useState } from "react";
import { Outlet, NavLink, useNavigate } from "react-router-dom";
import { Loading, Modal, Button } from "../ui";
import { useBrain } from "../lib/auth";
import { onPaymentRequired, type PaymentRequiredDetail } from "../lib/api";
import { Topbar } from "./Topbar";
import { Sidebar } from "./Sidebar";
import { ApiErrorBanner, FtsBanner } from "./GlobalStates";
import { RouteErrorBoundary } from "./ErrorBoundary";

export interface AppShellProps {
  /** variante slim (/portal): sem sidebar de admin. */
  slim?: boolean;
  /** mostra o banner de modo FTS (sem chave de IA). O shell pode derivar de /api/stats. */
  fts?: boolean;
}

export function AppShell({ slim = false, fts = false }: AppShellProps) {
  return (
    <div
      className={slim ? "shell shell-slim" : "shell"}
      style={{
        display: "grid",
        gridTemplateColumns: slim ? "1fr" : "236px 1fr",
        gridTemplateRows: "auto 1fr",
        minHeight: "100vh",
      }}
    >
      <Topbar />
      {!slim && <Sidebar />}
      <main
        style={{
          gridColumn: slim ? "1 / 2" : "2 / 3",
          padding: "24px 28px 60px",
          width: "100%",
          maxWidth: 1180,
          margin: "0 auto",
        }}
      >
        <ApiErrorBanner />
        <FtsBanner show={fts} />
        <Suspense fallback={<Loading variant="bar" lines={4} />}>
          <RouteErrorBoundary>
            <Outlet />
          </RouteErrorBoundary>
        </Suspense>
        <ShellFooter />
      </main>
      <PaymentRequiredModal />
    </div>
  );
}

/** Modal global de SALDO INSUFICIENTE (402): qualquer chamada que volte 402 emite
 *  galeed:payment-required → este modal abre com CTA pro /app/plano. */
function PaymentRequiredModal() {
  const [detail, setDetail] = useState<PaymentRequiredDetail | null>(null);
  const navigate = useNavigate();
  useEffect(() => onPaymentRequired(setDetail), []);
  const isCap = detail?.reason === "cap";
  const isEntitlement = detail?.reason === "entitlement";
  const title = isCap
    ? "Teto de gasto atingido"
    : isEntitlement
      ? "Pagamento pendente"
      : "Saldo de créditos insuficiente";
  const cta = isCap ? "Ajustar teto" : isEntitlement ? "Atualizar pagamento" : "Ver planos & recarga";
  return (
    <Modal
      open={!!detail}
      onClose={() => setDetail(null)}
      title={title}
      footer={
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <Button variant="ghost" onClick={() => setDetail(null)}>
            Agora não
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              setDetail(null);
              navigate("/app/plano");
            }}
          >
            {cta}
          </Button>
        </div>
      }
    >
      <p style={{ color: "var(--muted)", fontSize: 14, margin: 0 }}>
        {isCap
          ? "Você atingiu o teto de gasto que definiu para este mês. Ajuste o teto em Plano e créditos para voltar a jogar e perguntar."
          : isEntitlement
            ? "O pagamento da sua assinatura não foi concluído. Atualize o método de pagamento em Plano e créditos para retomar as ações pagas."
            : `${
                detail?.needed != null
                  ? `Essa ação custa ${detail.needed} créditos${detail.balance != null ? ` e você tem ${detail.balance}` : ""}.`
                  : "Você está sem créditos para essa ação."
              } Recarregue ou ative um plano para continuar.`}
      </p>
    </Modal>
  );
}

/** Footer do conteúdo (app-shell.md §8). */
function ShellFooter() {
  return (
    <footer
      style={{
        marginTop: 48,
        paddingTop: 16,
        borderTop: "1px solid var(--border)",
        display: "flex",
        flexWrap: "wrap",
        gap: 12,
        justifyContent: "space-between",
        alignItems: "center",
        fontSize: 12.5,
        color: "var(--muted)",
      }}
    >
      <span>
        Galeed · cérebro <BrainSlug />
      </span>
      <span style={{ display: "inline-flex", gap: 14 }}>
        <NavLink to="/criar-cerebro">Criar cérebro</NavLink>
      </span>
    </footer>
  );
}

function BrainSlug() {
  const { current } = useBrain();
  return <span className="mono">{current?.name ?? "—"}</span>;
}

export default AppShell;
