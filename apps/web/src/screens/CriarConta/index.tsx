/** CriarConta (signup) — tela pública (sem shell). M8.
 *
 *  Card central: Brand + título "Criar conta" + campos
 *  (nome · email · senha · confirmação · nome do primeiro brain opcional)
 *  → signup real via useAuth().signup({name,email,password,brainName?}).
 *  Sucesso → /criar-cerebro (onboarding conversacional); se o brain veio no
 *  signup, direto → /app. Validação client com erros inline,
 *  estado loading, erro do servidor (email já existe → mensagem útil).
 *
 *  Convenção ARCHITECTURE §3: export default sem props; dados via lib/auth.
 */
import { useId, useState, type CSSProperties, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Brand, Button, Card, Icon } from "../../ui";
import { useAuth } from "../../lib/auth";
import { ApiError } from "../../lib/api";

// sugestão amigável pro primeiro brain (campo opcional)
const BRAIN_SUGGESTION = "Meu cérebro";
const MIN_PASSWORD = 8;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface Errors {
  name?: string;
  email?: string;
  password?: string;
  confirm?: string;
}

export default function CriarConta() {
  const navigate = useNavigate();
  const { signup } = useAuth();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [brainName, setBrainName] = useState("");

  const [errors, setErrors] = useState<Errors>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // só validamos inline depois da primeira tentativa de submit (menos ruído)
  const [submitted, setSubmitted] = useState(false);

  function validate(): Errors {
    const e: Errors = {};
    if (!name.trim()) e.name = "Diga como devemos te chamar.";
    if (!email.trim()) e.email = "Informe seu email.";
    else if (!EMAIL_RE.test(email.trim())) e.email = "Esse email não parece válido.";
    if (!password) e.password = "Crie uma senha.";
    else if (password.length < MIN_PASSWORD)
      e.password = `Use ao menos ${MIN_PASSWORD} caracteres.`;
    if (!confirm) e.confirm = "Repita a senha.";
    else if (confirm !== password) e.confirm = "As senhas não conferem.";
    return e;
  }

  async function onSubmit(ev: FormEvent) {
    ev.preventDefault();
    setServerError(null);
    setSubmitted(true);
    const e = validate();
    setErrors(e);
    if (Object.keys(e).length > 0) return;

    setLoading(true);
    try {
      await signup({
        name: name.trim(),
        email: email.trim(),
        password,
        brainName: brainName.trim() || undefined,
      });
      // com brain criado no signup vai direto ao console; sem, cai no wizard conversacional
      navigate(brainName.trim() ? "/app" : "/criar-cerebro", { replace: true });
    } catch (err) {
      if (err instanceof ApiError) {
        // o BFF sinaliza email duplicado por status (409) ou pela mensagem
        // ("email já cadastrado", hoje propagada como 500) — tratamos os dois.
        const dup =
          err.status === 409 || /j[áa]\s*cadastrad|already|exist/i.test(err.message || "");
        if (dup) {
          setServerError(
            "Já existe uma conta com esse email. Tente entrar — ou use outro email.",
          );
        } else if (err.status === 0) {
          setServerError("Não foi possível conectar. Verifique sua internet e tente de novo.");
        } else {
          setServerError(err.message || "Não foi possível criar a conta. Tente novamente.");
        }
      } else {
        setServerError("Algo deu errado. Tente novamente em instantes.");
      }
      setLoading(false);
    }
  }

  // revalida um campo conforme o usuário corrige, mas só após o 1º submit
  function revalidate() {
    if (submitted) setErrors(validate());
  }

  return (
    <main
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        padding: "40px 20px",
      }}
    >
      <div style={{ width: "100%", maxWidth: 420 }}>
        {/* topo: voltar */}
        <div style={{ marginBottom: 18 }}>
          <Link
            to="/entrar"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              fontSize: 13,
              fontWeight: 600,
              color: "var(--muted)",
            }}
          >
            <span aria-hidden style={{ transform: "rotate(180deg)", display: "inline-flex" }}>
              <Icon name="arrow" size={15} />
            </span>
            Voltar
          </Link>
        </div>

        <Card elevated padding="26px 26px 24px">
          <div style={{ marginBottom: 18 }}>
            <Brand size={34} />
          </div>

          <h1 style={{ fontSize: 24, fontWeight: 700, letterSpacing: "-0.02em" }}>Criar conta</h1>
          <p style={{ fontSize: 14, color: "var(--muted)", marginTop: 6 }}>
            Comece seu cérebro do zero — do primeiro fato em diante.
          </p>

          {serverError && (
            <div
              role="alert"
              style={{
                marginTop: 16,
                padding: "10px 12px",
                borderRadius: 8,
                fontSize: 13,
                lineHeight: 1.45,
                color: "var(--danger)",
                background: "oklch(95.5% 0.05 25)",
                border: "1px solid oklch(88% 0.07 25)",
              }}
            >
              {serverError}
            </div>
          )}

          <form onSubmit={onSubmit} noValidate style={{ marginTop: 18 }}>
            <Field
              label="Nome"
              type="text"
              autoComplete="name"
              placeholder="Como te chamamos?"
              value={name}
              error={errors.name}
              onChange={(v) => {
                setName(v);
                revalidate();
              }}
            />
            <Field
              label="Email"
              type="email"
              autoComplete="email"
              placeholder="voce@empresa.com"
              value={email}
              error={errors.email}
              onChange={(v) => {
                setEmail(v);
                revalidate();
              }}
            />
            <Field
              label="Senha"
              type="password"
              autoComplete="new-password"
              placeholder={`Ao menos ${MIN_PASSWORD} caracteres`}
              value={password}
              error={errors.password}
              onChange={(v) => {
                setPassword(v);
                revalidate();
              }}
            />
            <Field
              label="Confirmar senha"
              type="password"
              autoComplete="new-password"
              placeholder="Repita a senha"
              value={confirm}
              error={errors.confirm}
              onChange={(v) => {
                setConfirm(v);
                revalidate();
              }}
            />
            <Field
              label="Nome do primeiro cérebro"
              optional
              type="text"
              placeholder={BRAIN_SUGGESTION}
              value={brainName}
              hint={`Opcional — se deixar em branco, criamos "${BRAIN_SUGGESTION}".`}
              onChange={setBrainName}
            />

            <Button
              type="submit"
              variant="primary"
              disabled={loading}
              style={{ width: "100%", height: 40, marginTop: 6 }}
            >
              {loading ? "Criando conta…" : "Criar conta"}
            </Button>
          </form>
        </Card>

        <p style={{ textAlign: "center", marginTop: 18, fontSize: 13, color: "var(--muted)" }}>
          Já tem conta?{" "}
          <Link to="/entrar" style={{ fontWeight: 600 }}>
            Entrar
          </Link>
        </p>
      </div>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Field — campo rotulado (input 38px conforme fundação §4) com erro inline.
// ---------------------------------------------------------------------------
interface FieldProps {
  label: string;
  type: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  autoComplete?: string;
  error?: string;
  hint?: string;
  optional?: boolean;
}

function Field({
  label,
  type,
  value,
  onChange,
  placeholder,
  autoComplete,
  error,
  hint,
  optional,
}: FieldProps) {
  const id = useId();
  const errId = `${id}-err`;
  const hintId = `${id}-hint`;

  const inputStyle: CSSProperties = {
    width: "100%",
    height: 38,
    border: `1px solid ${error ? "var(--danger)" : "var(--border-strong)"}`,
    borderRadius: 8,
    padding: "0 12px",
    background: "var(--surface)",
    color: "var(--fg)",
    fontFamily: "var(--font)",
    fontSize: 14,
  };

  return (
    <div style={{ marginBottom: 14 }}>
      <label
        htmlFor={id}
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 6,
          marginBottom: 6,
          fontSize: 13,
          fontWeight: 600,
          color: "var(--fg)",
        }}
      >
        {label}
        {optional && (
          <span style={{ fontWeight: 400, fontSize: 12, color: "var(--faint)" }}>(opcional)</span>
        )}
      </label>
      <input
        id={id}
        type={type}
        value={value}
        placeholder={placeholder}
        autoComplete={autoComplete}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errId : hint ? hintId : undefined}
        onChange={(e) => onChange(e.target.value)}
        style={inputStyle}
      />
      {error ? (
        <p id={errId} style={{ marginTop: 5, fontSize: 12.5, color: "var(--danger)" }}>
          {error}
        </p>
      ) : hint ? (
        <p id={hintId} style={{ marginTop: 5, fontSize: 12, color: "var(--faint)" }}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}
