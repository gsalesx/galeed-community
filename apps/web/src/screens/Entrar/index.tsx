/** M8 — Tela pública "Entrar" (login). Sem shell.
 *
 *  Card central: Brand no topo, título "Entrar", campos email + senha,
 *  botão primário (loading → "Entrando…"), erro inline amigável (sem stacktrace),
 *  link "Criar conta" → /criar-conta.
 *
 *  Auth real via useAuth().login({email,password}) (lib/auth). Sucesso → /app.
 *  Sessão já ativa → /app direto (edição community: sem landing, esta é a raiz).
 *  Estilo fiel a _design/00-foundation.md: tema claro, tokens oklch, accent verde.
 */
import { useId, useState, type CSSProperties, type FormEvent } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { Brand, Button } from "../../ui";
import { ApiError } from "../../lib/api";
import { useAuth } from "../../lib/auth";

/** Traduz o erro do BFF em uma mensagem de gente (sem stacktrace). */
function mensagemDeErro(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 401) return "E-mail ou senha incorretos. Confira e tente de novo.";
    if (e.status === 0) return "Sem conexão com o servidor. Verifique sua internet e tente de novo.";
    if (e.status === 429) return "Muitas tentativas. Espere um instante e tente de novo.";
    if (e.status >= 500) return "O servidor tropeçou. Tente de novo em instantes.";
    return e.message || "Não foi possível entrar. Tente de novo.";
  }
  return "Não foi possível entrar. Tente de novo.";
}

const fieldLabel: CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: "var(--fg)",
  marginBottom: 6,
  display: "block",
};

const fieldInput: CSSProperties = {
  width: "100%",
  height: 38,
  padding: "0 12px",
  borderRadius: 8,
  border: "1px solid var(--border-strong)",
  background: "var(--surface)",
  color: "var(--fg)",
  fontFamily: "var(--font)",
  fontSize: 14,
  outline: "none",
  boxSizing: "border-box",
};

export default function Entrar() {
  const navigate = useNavigate();
  const { login, session, loading: authLoading } = useAuth();
  const emailId = useId();
  const senhaId = useId();
  const erroId = useId();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  async function onSubmit(ev: FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    if (loading) return;
    setErro(null);
    setLoading(true);
    try {
      await login({ email: email.trim(), password });
      navigate("/app", { replace: true });
    } catch (e) {
      setErro(mensagemDeErro(e));
      setLoading(false);
    }
  }

  const focus = (on: boolean) => (e: { currentTarget: HTMLInputElement }) => {
    e.currentTarget.style.borderColor = on ? "var(--accent)" : "var(--border-strong)";
    e.currentTarget.style.boxShadow = on ? "0 0 0 3px var(--accent-soft)" : "none";
  };

  if (!authLoading && session) return <Navigate to="/app" replace />;

  return (
    <main
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        background: "var(--bg)",
        padding: 24,
        boxSizing: "border-box",
      }}
    >
      <div style={{ width: "100%", maxWidth: 380, display: "flex", flexDirection: "column", gap: 18 }}>
        <div style={{ display: "flex", justifyContent: "center" }}>
          <Brand size={34} />
        </div>

        <div
          style={{
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 13,
            boxShadow: "var(--shadow)",
            padding: "26px 24px",
          }}
        >
          <h1
            style={{
              margin: "0 0 4px",
              fontSize: 24,
              fontWeight: 600,
              letterSpacing: "-0.02em",
              color: "var(--fg)",
            }}
          >
            Entrar
          </h1>
          <p style={{ margin: "0 0 20px", fontSize: 14, color: "var(--muted)" }}>
            Acesse a memória do seu time.
          </p>

          <form onSubmit={onSubmit} noValidate>
            <div style={{ marginBottom: 14 }}>
              <label htmlFor={emailId} style={fieldLabel}>
                E-mail
              </label>
              <input
                id={emailId}
                type="email"
                name="email"
                inputMode="email"
                autoComplete="email"
                autoFocus
                required
                placeholder="voce@empresa.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onFocus={focus(true)}
                onBlur={focus(false)}
                disabled={loading}
                aria-invalid={erro ? true : undefined}
                aria-describedby={erro ? erroId : undefined}
                style={fieldInput}
              />
            </div>

            <div style={{ marginBottom: 18 }}>
              <label htmlFor={senhaId} style={fieldLabel}>
                Senha
              </label>
              <input
                id={senhaId}
                type="password"
                name="password"
                autoComplete="current-password"
                required
                placeholder="Sua senha"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onFocus={focus(true)}
                onBlur={focus(false)}
                disabled={loading}
                aria-invalid={erro ? true : undefined}
                aria-describedby={erro ? erroId : undefined}
                style={fieldInput}
              />
            </div>

            {erro && (
              <div
                id={erroId}
                role="alert"
                style={{
                  marginBottom: 16,
                  padding: "9px 12px",
                  borderRadius: 8,
                  border: "1px solid oklch(85% 0.06 25)",
                  background: "oklch(95.5% 0.05 25)",
                  color: "oklch(45% 0.16 25)",
                  fontSize: 13,
                  lineHeight: 1.4,
                }}
              >
                {erro}
              </div>
            )}

            <Button
              type="submit"
              variant="primary"
              disabled={loading}
              style={{ width: "100%" }}
            >
              {loading ? "Entrando…" : "Entrar"}
            </Button>
          </form>
        </div>

        <div style={{ textAlign: "center", fontSize: 14, color: "var(--muted)" }}>
          Não tem conta?{" "}
          <Link to="/criar-conta" style={{ color: "var(--accent-ink)", fontWeight: 600, textDecoration: "none" }}>
            Criar conta
          </Link>
        </div>

      </div>
    </main>
  );
}
