/** M8 — ErrorBoundary: captura erro de render de uma subárvore e mostra um fallback amigável
 *  em vez da tela branca com stack. Mantém o resto do app vivo (quando usado em volta do
 *  <Outlet/>, a topbar/sidebar continuam funcionando). Oferece "tentar de novo", "recarregar"
 *  e "copiar erro" (pra reportar rápido).
 *
 *  React só captura erro de render em CLASS component (getDerivedStateFromError / componentDidCatch),
 *  por isso esta é uma classe. O wrapper RouteErrorBoundary reseta o estado a cada navegação (key).
 */
import { Component, type ReactNode, type ErrorInfo } from "react";
import { useLocation } from "react-router-dom";
import { Button } from "../ui";

interface Props {
  children: ReactNode;
  /** rótulo do contexto (ex.: "esta tela"), só cosmético. */
  scope?: string;
}
interface State {
  error: Error | null;
  info: ErrorInfo | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // fica no console do navegador pra inspeção; não derruba o app.
    console.error("[Galeed] erro capturado pelo ErrorBoundary:", error, info.componentStack);
    this.setState({ info });
  }

  reset = () => this.setState({ error: null, info: null });

  render() {
    const { error, info } = this.state;
    if (!error) return this.props.children;

    const detail = [
      error.message,
      "",
      error.stack ?? "",
      info?.componentStack ? `\nComponentes:${info.componentStack}` : "",
    ].join("\n");

    return (
      <div
        style={{
          maxWidth: 640,
          margin: "24px auto",
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: 14,
          padding: "26px 28px",
          boxShadow: "var(--shadow)",
        }}
      >
        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--danger)", marginBottom: 6 }}>
          Algo quebrou {this.props.scope ?? "nesta tela"}
        </div>
        <h2 style={{ margin: "0 0 8px", fontSize: 20 }}>O resto do app continua funcionando.</h2>
        <p style={{ margin: "0 0 18px", color: "var(--muted)", fontSize: 14, lineHeight: 1.6 }}>
          Tentamos renderizar e algo deu errado. Você pode tentar de novo, recarregar, ou copiar o erro
          e mandar pra quem cuida do sistema.
        </p>

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 18 }}>
          <Button variant="primary" size="sm" onClick={this.reset}>
            Tentar de novo
          </Button>
          <Button variant="secondary" size="sm" onClick={() => window.location.reload()}>
            Recarregar a página
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              navigator.clipboard?.writeText(detail).catch(() => {});
            }}
          >
            Copiar erro
          </Button>
        </div>

        <details style={{ fontSize: 12 }}>
          <summary style={{ cursor: "pointer", color: "var(--faint)", fontFamily: "var(--mono)" }}>
            detalhes técnicos
          </summary>
          <pre
            style={{
              marginTop: 10,
              padding: 12,
              background: "var(--ink)",
              color: "oklch(90% 0.01 240)",
              borderRadius: 8,
              overflow: "auto",
              maxHeight: 280,
              fontFamily: "var(--mono)",
              fontSize: 11.5,
              lineHeight: 1.5,
              whiteSpace: "pre-wrap",
            }}
          >
            {detail}
          </pre>
        </details>
      </div>
    );
  }
}

/** Boundary que RESETA a cada navegação (key = pathname) — usar em volta do <Outlet/>. */
export function RouteErrorBoundary({ children }: { children: ReactNode }) {
  const loc = useLocation();
  return <ErrorBoundary key={loc.pathname}>{children}</ErrorBoundary>;
}

export default ErrorBoundary;
