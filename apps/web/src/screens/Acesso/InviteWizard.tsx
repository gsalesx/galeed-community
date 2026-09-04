/** Convidar / Editar acesso — wizard de 3 passos no Modal (§3 do _design/acesso.md).
 *  Passo 1 "Quem é?" · Passo 2 "O que pode ver?" · Passo 3 "Até que nível de sigilo?".
 *  Em modo editar reusa o MESMO modal pré-preenchido; botão final vira "Salvar".
 *  Convidar bot → ao concluir, mostra o token CRU uma única vez (gal_…). */
import { useState } from "react";
import { Button, LockChip, Modal } from "../../ui";
import type { AreaView, GrantReq, InviteReq, Principal, PrincipalKind } from "../../lib/api";
import type { LockLevel } from "../../ui";
import {
  CODE_TO_SENS,
  DENY_TYPES,
  LEVEL_DOT,
  LEVEL_OPTIONS,
  SENS_TO_CODE,
  dotDeArea,
} from "./data";

export interface InviteResult {
  body: InviteReq;
  /** principal sendo editado (presente → Salvar/editar; ausente → Convidar/novo). */
  editing: Principal | null;
}

export interface InviteWizardProps {
  open: boolean;
  onClose: () => void;
  /** áreas REAIS do cérebro (api.rbac.areas) — o catálogo do passo 2. */
  catalogo: AreaView[];
  /** principal a editar (null = novo convite). */
  editing: Principal | null;
  /** dispara invite (novo) ou setGrant (edição). Resolve quando salvo. */
  onSubmit: (r: InviteResult) => Promise<void>;
  saving: boolean;
  /** token cru recém-emitido (mostrado UMA vez no passo final). */
  freshToken?: string | null;
  /** copiar o token cru. */
  onCopyToken?: (token: string) => void;
  /** fecha o aviso de token e encerra o fluxo. */
  onDoneToken?: () => void;
}

export function InviteWizard(props: InviteWizardProps) {
  const { open, onClose, catalogo, editing, onSubmit, saving, freshToken, onCopyToken, onDoneToken } = props;

  const [step, setStep] = useState(1);
  const [kind, setKind] = useState<PrincipalKind>("human");
  const [label, setLabel] = useState("");
  const [email, setEmail] = useState("");
  const [areas, setAreas] = useState<string[]>([]);
  const [level, setLevel] = useState<LockLevel>("secret");
  const [denyTypes, setDenyTypes] = useState<string[]>([]);
  // erro honesto da escrita real (400/403/404) — não quebra a tela.
  const [submitError, setSubmitError] = useState<string | null>(null);

  // (re)inicializa o form sempre que o modal abre — em edição puxa do principal.
  const initKey = `${open}:${editing?.id ?? "novo"}`;
  const [seenKey, setSeenKey] = useState("");
  if (open && seenKey !== initKey) {
    setSeenKey(initKey);
    setStep(1);
    setSubmitError(null);
    if (editing) {
      setKind(editing.kind);
      setLabel(editing.label);
      setEmail(editing.email);
      setAreas([...editing.grant.areas]);
      setLevel(SENS_TO_CODE[editing.grant.sensitivity_max]);
      setDenyTypes([...editing.grant.deny_types]);
    } else {
      setKind("human");
      setLabel("");
      setEmail("");
      setAreas([]); // nada pré-marcado — o convite diz a verdade desde o passo 2
      setLevel("secret");
      setDenyTypes([]);
    }
  }
  if (!open && seenKey !== "") setSeenKey("");

  const isEdit = !!editing;

  function toggleArea(slug: string) {
    // "*" = acesso total (scope.ts/AREA_TOTAL): sozinho por definição — ligar limpa os slugs,
    // marcar um slug específico desliga o total.
    if (slug === "*") return setAreas((a) => (a.includes("*") ? [] : ["*"]));
    setAreas((a) => (a.includes(slug) ? a.filter((s) => s !== slug) : [...a.filter((s) => s !== "*"), slug]));
  }
  function toggleDeny(slug: string) {
    setDenyTypes((d) => (d.includes(slug) ? d.filter((s) => s !== slug) : [...d, slug]));
  }

  const areaLabels = areas.includes("*")
    ? ["Todas as áreas"]
    : areas.map((slug) => catalogo.find((a) => a.slug === slug)?.label ?? slug);
  const summary =
    areas.length === 0
      ? "Nada ainda."
      : `Vai ver ${areaLabels.join(", ")} ${level === "open" ? "só no Aberto" : `até ${LEVEL_OPTIONS.find((o) => o.code === level)?.title}`}.`;

  const canStep1 = label.trim().length > 0 && (kind === "agent" || email.trim().length > 0);
  const finalLabel = isEdit ? "Salvar" : "Convidar";

  async function handleFinal() {
    const body: InviteReq = {
      kind,
      label: label.trim(),
      email: kind === "human" ? email.trim() : "",
      areas,
      sensitivityMax: CODE_TO_SENS[level],
      denyTypes,
    } as InviteReq & GrantReq;
    setSubmitError(null);
    try {
      await onSubmit({ body, editing });
    } catch (e) {
      // erro real do BFF (400 sem label, 403, 404…) — mensagem honesta, modal segue aberto.
      setSubmitError(e instanceof Error ? e.message : "Não consegui salvar agora.");
    }
  }

  // ---- aviso de token cru (só após convidar um bot novo) ----
  if (open && freshToken) {
    return (
      <Modal open onClose={() => onDoneToken?.()} title="Chave criada" width={520}>
        <p style={{ margin: "0 0 12px", fontSize: 14.5 }}>
          Esta é a chave do bot. <b>Copie agora</b> — não dá pra ver de novo.
        </p>
        <div
          className="mono"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "12px 14px",
            background: "var(--ink)",
            color: "oklch(90% 0.01 240)",
            borderRadius: 10,
            fontSize: 12.5,
            wordBreak: "break-all",
          }}
        >
          <span style={{ flex: 1 }}>{freshToken}</span>
          <Button size="sm" variant="ghost" onClick={() => onCopyToken?.(freshToken)} style={{ color: "oklch(82% 0.08 150)" }}>
            Copiar
          </Button>
        </div>
        <div style={{ marginTop: 18, display: "flex", justifyContent: "flex-end" }}>
          <Button variant="primary" onClick={() => onDoneToken?.()}>
            Pronto
          </Button>
        </div>
      </Modal>
    );
  }

  const title = isEdit ? `Editar acesso de ${editing?.label}` : "Convidar quem vai usar";

  const footer = (
    <div style={{ display: "flex", alignItems: "center", gap: 12, width: "100%" }}>
      <div style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: "var(--muted)" }}>{summary}</div>
      {step > 1 && (
        <Button variant="ghost" onClick={() => setStep((s) => s - 1)} disabled={saving}>
          Voltar
        </Button>
      )}
      {step < 3 ? (
        <Button variant="primary" onClick={() => setStep((s) => s + 1)} disabled={step === 1 && !canStep1}>
          Continuar
        </Button>
      ) : (
        <Button variant="primary" onClick={handleFinal} disabled={saving || areas.length === 0}>
          {saving ? "Salvando…" : finalLabel}
        </Button>
      )}
    </div>
  );

  return (
    <Modal open={open} onClose={onClose} title={title} footer={footer} width={520}>
      <ProgressBar step={step} />

      {submitError && (
        <div
          role="alert"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "9px 12px",
            marginBottom: 14,
            borderRadius: 8,
            border: "1px solid var(--danger)",
            background: "var(--sn-secret-soft)",
            color: "var(--fg)",
            fontSize: 13,
            lineHeight: 1.45,
          }}
        >
          <b style={{ color: "var(--danger)" }}>Não deu pra salvar.</b>
          <span style={{ color: "var(--muted)" }}>{submitError}</span>
        </div>
      )}

      {step === 1 && (
        <Step1
          kind={kind}
          setKind={setKind}
          label={label}
          setLabel={setLabel}
          email={email}
          setEmail={setEmail}
        />
      )}
      {step === 2 && <Step2 areas={areas} toggleArea={toggleArea} catalogo={catalogo} />}
      {step === 3 && (
        <Step3
          level={level}
          setLevel={setLevel}
          denyTypes={denyTypes}
          toggleDeny={toggleDeny}
        />
      )}
    </Modal>
  );
}

function ProgressBar({ step }: { step: number }) {
  return (
    <div style={{ display: "flex", gap: 6, marginBottom: 18 }}>
      {[1, 2, 3].map((n) => (
        <span
          key={n}
          style={{
            flex: 1,
            height: 4,
            borderRadius: 99,
            background: n <= step ? "var(--accent)" : "var(--border)",
            transition: "background .15s",
          }}
        />
      ))}
    </div>
  );
}

const HINT: React.CSSProperties = { margin: "0 0 14px", fontSize: 13.5, color: "var(--muted)", lineHeight: 1.5 };

function Step1(p: {
  kind: PrincipalKind;
  setKind: (k: PrincipalKind) => void;
  label: string;
  setLabel: (s: string) => void;
  email: string;
  setEmail: (s: string) => void;
}) {
  const { kind, setKind, label, setLabel, email, setEmail } = p;
  return (
    <div>
      <h4 style={{ margin: "0 0 6px", fontSize: 16, fontWeight: 600 }}>Quem é?</h4>
      <p style={HINT}>Pessoa entra com login. Bot entra com uma chave. O acesso funciona igual pros dois.</p>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 16 }}>
        <KindCard
          active={kind === "human"}
          title="Uma pessoa"
          hint="entra com e-mail e login"
          onClick={() => setKind("human")}
        />
        <KindCard
          active={kind === "agent"}
          title="Um bot / IA"
          hint="entra com uma chave"
          onClick={() => setKind("agent")}
        />
      </div>
      <Label>{kind === "human" ? "Nome da pessoa" : "Nome do bot"}</Label>
      <TextInput
        value={label}
        onChange={setLabel}
        placeholder={kind === "human" ? "ex: Mariana Lopes" : "ex: Bot de Suporte"}
      />
      {kind === "human" && (
        <>
          <Label>E-mail (só identificação — nada é enviado)</Label>
          <TextInput value={email} onChange={setEmail} placeholder="ex: mariana@acme.com" type="email" />
          <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--faint)", lineHeight: 1.45 }}>
            O e-mail fica registrado como rótulo da pessoa. Não sai convite nem notificação — avise ela você mesmo.
          </p>
        </>
      )}
    </div>
  );
}

/** o toggle do acesso total ('*') — mesmo visual dos cards de área, com explicação inline. */
function AreaTotalToggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={on}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 11,
        width: "100%",
        padding: "10px 12px",
        borderRadius: 10,
        border: `1px solid ${on ? "oklch(88% 0.04 150)" : "var(--border-strong)"}`,
        background: on ? "var(--accent-soft)" : "var(--surface)",
        cursor: "pointer",
        textAlign: "left",
      }}
    >
      <span aria-hidden style={{ width: 10, height: 10, borderRadius: "50%", background: "var(--accent)", flexShrink: 0 }} />
      <span style={{ flex: 1 }}>
        <span style={{ display: "block", fontSize: 14, fontWeight: 600 }}>Todas as áreas (acesso total)</span>
        <span style={{ display: "block", fontSize: 12, color: "var(--muted)", lineHeight: 1.4 }}>
          Recomendado pra integrações (n8n, API) — inclui o que entra sem área definida. O nível de sigilo continua valendo.
        </span>
      </span>
      <span
        aria-hidden
        style={{
          display: "grid",
          placeItems: "center",
          width: 18,
          height: 18,
          borderRadius: 5,
          border: `1px solid ${on ? "var(--accent)" : "var(--border-strong)"}`,
          background: on ? "var(--accent)" : "transparent",
          color: "#fff",
          fontSize: 12,
        }}
      >
        {on ? "✓" : ""}
      </span>
    </button>
  );
}

function Step2(p: { areas: string[]; toggleArea: (slug: string) => void; catalogo: AreaView[] }) {
  return (
    <div>
      <h4 style={{ margin: "0 0 6px", fontSize: 16, fontWeight: 600 }}>O que pode ver?</h4>
      <p style={HINT}>Marque os assuntos que essa pessoa ou bot pode acessar. O resto continua invisível.</p>
      <div style={{ display: "grid", gap: 8 }}>
        {/* ACESSO TOTAL ('*') — pra BOTS DE INTEGRAÇÃO (n8n, API): sem ele, o que entra em modo
            livre (sem área definida) fica invisível pro token — beco silencioso. O nível de sigilo
            do próximo passo continua valendo. Explícito, sozinho por definição e reversível. */}
        <AreaTotalToggle on={p.areas.includes("*")} onToggle={() => p.toggleArea("*")} />
        {!p.areas.includes("*") && p.catalogo.length === 0 && (
          <p style={{ ...HINT, margin: "4px 2px 0" }}>
            Este cérebro ainda não tem áreas definidas — as memórias entram sem etiqueta de assunto.
            Pra esse caso, o acesso certo é <b>Todas as áreas</b> acima (o nível de sigilo do próximo
            passo continua valendo).
          </p>
        )}
        {!p.areas.includes("*") && p.catalogo.map((a, i) => {
          const on = p.areas.includes(a.slug);
          return (
            <button
              key={a.slug}
              type="button"
              onClick={() => p.toggleArea(a.slug)}
              aria-pressed={on}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 11,
                width: "100%",
                padding: "10px 12px",
                borderRadius: 10,
                border: `1px solid ${on ? "oklch(88% 0.04 150)" : "var(--border-strong)"}`,
                background: on ? "var(--accent-soft)" : "var(--surface)",
                cursor: "pointer",
                textAlign: "left",
              }}
            >
              <span aria-hidden style={{ width: 10, height: 10, borderRadius: "50%", background: dotDeArea(i), flexShrink: 0 }} />
              <span style={{ flex: 1, fontSize: 14, fontWeight: 600 }}>{a.label}</span>
              <span
                aria-hidden
                style={{
                  display: "grid",
                  placeItems: "center",
                  width: 18,
                  height: 18,
                  borderRadius: 5,
                  border: `1px solid ${on ? "var(--accent)" : "var(--border-strong)"}`,
                  background: on ? "var(--accent)" : "transparent",
                  color: "#fff",
                  fontSize: 12,
                }}
              >
                {on ? "✓" : ""}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Step3(p: {
  level: LockLevel;
  setLevel: (l: LockLevel) => void;
  denyTypes: string[];
  toggleDeny: (slug: string) => void;
}) {
  return (
    <div>
      <h4 style={{ margin: "0 0 6px", fontSize: 16, fontWeight: 600 }}>Até que nível de sigilo?</h4>
      <p style={HINT}>Pode ver até este nível. O que for mais sigiloso fica escondido, mesmo dentro dos assuntos liberados.</p>
      <div
        style={{
          padding: "9px 12px",
          marginBottom: 14,
          borderRadius: 8,
          background: "var(--sn-secret-soft)",
          color: "var(--sn-secret)",
          fontSize: 12.5,
        }}
      >
        Começa no mais fechado. Você sobe o nível só até onde quiser, de propósito.
      </div>
      <div style={{ display: "grid", gap: 8 }}>
        {LEVEL_OPTIONS.map((o) => {
          const on = p.level === o.code;
          return (
            <button
              key={o.code}
              type="button"
              onClick={() => p.setLevel(o.code)}
              aria-pressed={on}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 11,
                width: "100%",
                padding: "10px 12px",
                borderRadius: 10,
                border: `1px solid ${on ? "var(--accent)" : "var(--border-strong)"}`,
                background: on ? "var(--accent-soft)" : "var(--surface)",
                cursor: "pointer",
                textAlign: "left",
              }}
            >
              <span aria-hidden style={{ width: 12, height: 12, borderRadius: "50%", background: LEVEL_DOT[o.code], flexShrink: 0 }} />
              <span style={{ flex: 1 }}>
                <b style={{ fontSize: 14, fontWeight: 600 }}>{o.title}</b>
                <span style={{ display: "block", fontSize: 12.5, color: "var(--muted)" }}>{o.hint}</span>
              </span>
            </button>
          );
        })}
      </div>

      <details style={{ marginTop: 16 }}>
        <summary style={{ cursor: "pointer", fontSize: 13.5, fontWeight: 600 }}>
          Nunca mostrar certos tipos <span style={{ color: "var(--faint)", fontWeight: 400 }}>[opcional]</span>
        </summary>
        <p style={{ ...HINT, marginTop: 10 }}>
          Mesmo dentro do que foi liberado, você pode esconder tipos específicos. Útil pra esconder, por exemplo, números de contrato.
        </p>
        <div style={{ display: "grid", gap: 7 }}>
          {DENY_TYPES.map((d) => {
            const on = p.denyTypes.includes(d.slug);
            return (
              <label
                key={d.slug}
                style={{ display: "flex", alignItems: "center", gap: 9, fontSize: 13.5, cursor: "pointer" }}
              >
                <input type="checkbox" checked={on} onChange={() => p.toggleDeny(d.slug)} />
                {d.label}
              </label>
            );
          })}
        </div>
      </details>
    </div>
  );
}

// ---- pequenos átomos locais do form ----

function KindCard(p: { active: boolean; title: string; hint: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={p.onClick}
      aria-pressed={p.active}
      style={{
        textAlign: "left",
        padding: "12px 13px",
        borderRadius: 11,
        border: `1px solid ${p.active ? "var(--accent)" : "var(--border-strong)"}`,
        background: p.active ? "var(--accent-soft)" : "var(--surface)",
        cursor: "pointer",
      }}
    >
      <b style={{ display: "block", fontSize: 14, fontWeight: 600 }}>{p.title}</b>
      <span style={{ fontSize: 12.5, color: "var(--muted)" }}>{p.hint}</span>
    </button>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <label style={{ display: "block", margin: "12px 0 6px", fontSize: 12.5, fontWeight: 600, color: "var(--muted)" }}>
      {children}
    </label>
  );
}

function TextInput(p: { value: string; onChange: (s: string) => void; placeholder?: string; type?: string }) {
  return (
    <input
      type={p.type || "text"}
      value={p.value}
      placeholder={p.placeholder}
      onChange={(e) => p.onChange(e.target.value)}
      style={{
        width: "100%",
        height: 38,
        border: "1px solid var(--border-strong)",
        borderRadius: 8,
        padding: "0 12px",
        background: "var(--surface)",
        color: "var(--fg)",
        fontFamily: "var(--font)",
        fontSize: 14,
      }}
    />
  );
}

// re-export por conveniência (LockChip usado no resumo em outras telas)
export { LockChip };
