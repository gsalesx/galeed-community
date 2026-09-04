/** Tela AJUSTES (Settings) — MVP funcional (M8/S11).
 *  Renderiza dentro do <main> do AppShell. Só expõe ações com backend REAL:
 *    - Conta: nome/email (useAuth) + Sair (logout).
 *    - Brains/Projetos: lista (useBrain), papel owner/member, atual destacado,
 *      criar novo (api.brains.create via Modal) e trocar (switchBrain).
 *    - Membros: sem backend → estado honesto "em breve".
 *    - Preferências: idioma pt-BR fixo + fuso informativo (somente leitura).
 *  Tudo que não tem backain é rotulado "em breve" — nada de botão falso. */
import { useCallback, useEffect, useState } from "react";
import { Button, Card, Chip, Icon, Modal, Toast } from "../../ui";
import { useAuth, useBrain } from "../../lib/auth";
import { api, ApiError, getCurrentBrain } from "../../lib/api";
import type { Brain } from "../../lib/api";

type ToastState = { msg: string; tone: "ok" | "neutral" | "danger" } | null;

// ---------------------------------------------------------------------------
// SEAM (M11/S6): cliente + tipos da edição de contexto / preview / re-extração.
//
// api.ts é ZONA NEUTRA do Integrador. A chave `api.context` JÁ EXISTE (S4 pôs os
// `onboarding*` lá). O ARTIFACTS declara os métodos de S6 a FUNDIR NA MESMA chave
// (`api.context.get/save/preview/reextractEstimate/reextractRun`) — NÃO uma chave nova.
// Até o merge, o cliente vive AQUI, local à tela, espelhando EXATAMENTE esse bloco.
// Pós-merge, o Integrador troca `ctxApi.*` por `api.context.*` e remove este bloco.
// INVARIANTE (ADR-005-d): o `context` viaja só como state — NUNCA renderizado como JSON.
// ---------------------------------------------------------------------------
type CtxRole = "self" | "client" | "host" | "participant" | "other";
interface CtxRoleSpec { role: CtxRole; speakers: string[]; label: string }
interface CtxSourceTypeSpec { type: string; label: string; otherRole: CtxRole }
interface CtxSelf { slug: string; label: string; aliases: string[] }
interface CtxContext { self: CtxSelf; purpose: string; roles: CtxRoleSpec[]; sourceTypes: CtxSourceTypeSpec[] }
interface CtxView { context: CtxContext; version: number; card: string }
interface CtxPreview { summary: string }
interface CtxReextractEstimate { staleDocs: number; totalDocs: number; costUsdEstimate: number }
interface CtxReextractResult { reextracted: number; message: string }

async function ctxReq<T>(path: string, method: "GET" | "POST", body?: unknown): Promise<T> {
  const brain = getCurrentBrain();
  const url = path + (brain ? `?brain=${encodeURIComponent(brain)}` : "");
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      credentials: "include",
      headers: method === "POST" ? { "content-type": "application/json" } : {},
      body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
    });
  } catch (e) {
    throw new ApiError(0, `falha de rede: ${(e as Error).message}`);
  }
  if (!res.ok) {
    const raw = await res.text().catch(() => "");
    throw new ApiError(res.status, raw || `erro ${res.status}`);
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/** Espelho local de `api.context` (apenas os métodos do S6 — Integrador funde com os `onboarding*` do S4). */
const ctxApi = {
  get: () => ctxReq<CtxView>("/api/context", "GET"),
  save: (context: CtxContext) => ctxReq<CtxView>("/api/context", "POST", { context }),
  preview: (sampleText: string, type: string) =>
    ctxReq<CtxPreview>("/api/context/preview", "POST", { sampleText, type }),
  reextractEstimate: () => ctxReq<CtxReextractEstimate>("/api/context/reextract", "GET"),
  reextractRun: () => ctxReq<CtxReextractResult>("/api/context/reextract", "POST", {}),
};

const ROLE_LABELS: Record<CtxRole, string> = {
  self: "Você / sua equipe",
  client: "Clientes",
  host: "Apresentador",
  participant: "Participantes",
  other: "Outros",
};

function emptyContext(): CtxContext {
  return { self: { slug: "", label: "", aliases: [] }, purpose: "", roles: [], sourceTypes: [] };
}

export default function Ajustes() {
  const { session, logout } = useAuth();
  const { current, brains, switchBrain } = useBrain();

  const [toast, setToast] = useState<ToastState>(null);

  // criar brain
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createErr, setCreateErr] = useState<string | null>(null);

  // sair
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  // ── Contexto do cérebro (M11/S6) ──
  const [ctx, setCtx] = useState<CtxContext>(emptyContext());
  const [ctxCard, setCtxCard] = useState("");
  const [ctxVersion, setCtxVersion] = useState(0);
  const [ctxLoading, setCtxLoading] = useState(true);
  const [ctxErr, setCtxErr] = useState<string | null>(null);
  const [ctxSaving, setCtxSaving] = useState(false);

  // preview
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewText, setPreviewText] = useState("");
  const [previewType, setPreviewType] = useState("");
  const [previewing, setPreviewing] = useState(false);
  const [previewResult, setPreviewResult] = useState<string | null>(null);
  const [previewErr, setPreviewErr] = useState<string | null>(null);

  // re-extração (D3: aviso de custo antes de rodar)
  const [reextOpen, setReextOpen] = useState(false);
  const [reextEst, setReextEst] = useState<CtxReextractEstimate | null>(null);
  const [reextLoading, setReextLoading] = useState(false);
  const [reextRunning, setReextRunning] = useState(false);
  const [reextErr, setReextErr] = useState<string | null>(null);

  const brainId = current?.id;

  useEffect(() => {
    let alive = true;
    setCtxLoading(true);
    setCtxErr(null);
    ctxApi
      .get()
      .then((v) => {
        if (!alive) return;
        setCtx(v.context ?? emptyContext());
        setCtxCard(v.card ?? "");
        setCtxVersion(v.version ?? 0);
      })
      .catch((e) => {
        if (!alive) return;
        setCtxErr(e instanceof ApiError ? e.message : "Não foi possível carregar o contexto.");
      })
      .finally(() => {
        if (alive) setCtxLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [brainId]);

  async function handleSaveContext() {
    setCtxSaving(true);
    setCtxErr(null);
    try {
      const v = await ctxApi.save(ctx);
      setCtx(v.context ?? ctx);
      setCtxCard(v.card ?? "");
      setCtxVersion(v.version ?? ctxVersion);
      setToast({ msg: "Contexto salvo. Da próxima leitura eu já uso ele.", tone: "ok" });
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : "Não foi possível salvar o contexto.";
      setCtxErr(msg);
      setToast({ msg, tone: "danger" });
    } finally {
      setCtxSaving(false);
    }
  }

  function openPreview() {
    setPreviewResult(null);
    setPreviewErr(null);
    setPreviewText("");
    setPreviewType(ctx.sourceTypes[0]?.type ?? "reunioes");
    setPreviewOpen(true);
  }

  async function handlePreview() {
    const sample = previewText.trim();
    if (!sample) {
      setPreviewErr("Cole um trecho de exemplo pra eu mostrar o que extrairia.");
      return;
    }
    setPreviewing(true);
    setPreviewErr(null);
    setPreviewResult(null);
    try {
      const r = await ctxApi.preview(sample, previewType || "reunioes");
      setPreviewResult(r.summary);
    } catch (e) {
      setPreviewErr(e instanceof ApiError ? e.message : "Não consegui gerar o preview agora.");
    } finally {
      setPreviewing(false);
    }
  }

  async function openReextract() {
    setReextErr(null);
    setReextEst(null);
    setReextOpen(true);
    setReextLoading(true);
    try {
      const est = await ctxApi.reextractEstimate();
      setReextEst(est);
    } catch (e) {
      setReextErr(e instanceof ApiError ? e.message : "Não consegui estimar o impacto agora.");
    } finally {
      setReextLoading(false);
    }
  }

  async function handleReextractRun() {
    setReextRunning(true);
    setReextErr(null);
    try {
      const r = await ctxApi.reextractRun();
      setReextOpen(false);
      setToast({ msg: r.message, tone: "ok" });
      // o contexto não muda, mas re-puxa o card pra refletir o estado.
      const est = await ctxApi.reextractEstimate().catch(() => null);
      if (est) setReextEst(est);
    } catch (e) {
      setReextErr(e instanceof ApiError ? e.message : "Não consegui re-extrair agora.");
    } finally {
      setReextRunning(false);
    }
  }

  const account = session?.account ?? null;

  const openCreate = useCallback(() => {
    setNewName("");
    setCreateErr(null);
    setCreateOpen(true);
  }, []);

  async function handleCreate() {
    const name = newName.trim();
    if (!name) {
      setCreateErr("Dê um nome ao projeto.");
      return;
    }
    setCreating(true);
    setCreateErr(null);
    try {
      const brain = await api.brains.create({ name });
      switchBrain(brain.id);
      setCreateOpen(false);
      setToast({ msg: `Projeto "${brain.name}" criado.`, tone: "ok" });
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : "Não foi possível criar o projeto.";
      setCreateErr(msg);
    } finally {
      setCreating(false);
    }
  }

  function handleSwitch(b: Brain) {
    if (b.id === current?.id) return;
    switchBrain(b.id);
    setToast({ msg: `Você está no projeto "${b.name}".`, tone: "neutral" });
  }

  async function handleLogout() {
    setLoggingOut(true);
    try {
      await logout();
      // O AuthProvider derruba a sessão → o router (S1) redireciona para login.
    } finally {
      setLoggingOut(false);
      setConfirmLogout(false);
    }
  }

  return (
    <div>
      {/* page head */}
      <header style={{ marginBottom: 20 }}>
        <h1 style={{ margin: 0, fontSize: 32, fontWeight: 700, letterSpacing: "-.025em" }}>Ajustes</h1>
        <p style={{ margin: "6px 0 0", fontSize: 14.5, color: "var(--muted)", maxWidth: 560, lineHeight: 1.5 }}>
          Sua conta, seus projetos e suas preferências. O que ainda não está pronto aparece marcado como “em breve”.
        </p>
      </header>

      <div style={{ display: "grid", gap: 18, maxWidth: 720 }}>
        {/* ───────────────────── Conta ───────────────────── */}
        <Card header={<SectionTitle>Conta</SectionTitle>}>
          {account ? (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 14, minWidth: 0 }}>
                <Avatar name={account.name} />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 15, fontWeight: 600 }}>{account.name}</div>
                  <div style={{ fontSize: 13, color: "var(--muted)", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {account.email}
                  </div>
                </div>
              </div>
              <Button variant="secondary" icon={<Icon name="arrow" size={15} />} onClick={() => setConfirmLogout(true)}>
                Sair
              </Button>
            </div>
          ) : (
            <p style={{ margin: 0, color: "var(--muted)", fontSize: 14 }}>Carregando sua conta…</p>
          )}
        </Card>

        {/* ─────────────── Brains / Projetos ─────────────── */}
        <Card
          header={
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
              <SectionTitle>Projetos</SectionTitle>
              <Button size="sm" variant="primary" icon={<Icon name="plus" size={14} />} onClick={openCreate}>
                Novo projeto
              </Button>
            </div>
          }
        >
          {brains.length === 0 ? (
            <p style={{ margin: 0, color: "var(--muted)", fontSize: 14 }}>
              Você ainda não tem projetos. Crie o primeiro para começar.
            </p>
          ) : (
            <div style={{ display: "grid", gap: 8 }}>
              {brains.map((b) => {
                const isCurrent = b.id === current?.id;
                return (
                  <div
                    key={b.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 12,
                      padding: "11px 13px",
                      borderRadius: 10,
                      border: `1px solid ${isCurrent ? "oklch(88% 0.04 150)" : "var(--border)"}`,
                      background: isCurrent ? "var(--accent-soft)" : "var(--surface)",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                      <span style={{ fontSize: 14.5, fontWeight: 600, color: isCurrent ? "var(--accent-ink)" : "var(--fg)" }}>
                        {b.name}
                      </span>
                      <RoleTag role={b.role} />
                    </div>
                    {isCurrent ? (
                      <Chip active dotColor="var(--ok)">
                        Atual
                      </Chip>
                    ) : (
                      <Button size="sm" variant="secondary" onClick={() => handleSwitch(b)}>
                        Usar
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </Card>

        {/* ─────────────── Contexto do cérebro (M11/S6) ─────────────── */}
        <Card
          header={
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
              <SectionTitle>Contexto do cérebro</SectionTitle>
              {ctxVersion > 0 && (
                <span style={{ fontSize: 12, color: "var(--muted)" }}>versão {ctxVersion}</span>
              )}
            </div>
          }
        >
          {ctxLoading ? (
            <p style={{ margin: 0, color: "var(--muted)", fontSize: 14 }}>Carregando o contexto…</p>
          ) : (
            <div style={{ display: "grid", gap: 18 }}>
              {/* cartão-resumo legível (prosa, NUNCA JSON) */}
              <div
                style={{
                  padding: "12px 14px",
                  borderRadius: 10,
                  background: "var(--accent-soft)",
                  color: "var(--accent-ink)",
                  fontSize: 13.5,
                  lineHeight: 1.55,
                }}
              >
                {ctxCard || "Sem contexto declarado — vou usar o modo geral."}
              </div>

              {ctxErr && <p style={{ margin: 0, fontSize: 13, color: "var(--danger)" }}>{ctxErr}</p>}

              {/* self — campo rotulado */}
              <Field label="De quem é este cérebro" hint="O nome da sua empresa ou o seu nome.">
                <input
                  value={ctx.self.label}
                  onChange={(e) =>
                    setCtx((c) => ({ ...c, self: { ...c.self, label: e.target.value } }))
                  }
                  placeholder="Ex.: Accelera, Maria Silva…"
                  style={inputStyle}
                />
              </Field>

              {/* propósito — o que importa */}
              <Field label="Pra que serve" hint="O que você mais quer lembrar ou consultar depois.">
                <textarea
                  value={ctx.purpose}
                  onChange={(e) => setCtx((c) => ({ ...c, purpose: e.target.value }))}
                  placeholder="Ex.: lembrar preços, decisões e combinados com clientes."
                  rows={2}
                  style={{ ...inputStyle, height: "auto", padding: "9px 12px", resize: "vertical" }}
                />
              </Field>

              {/* papéis — lista amigável */}
              <Field label="Quem costuma aparecer" hint="De um lado você/sua equipe; do outro, quem você atende.">
                <RolesEditor roles={ctx.roles} onChange={(roles) => setCtx((c) => ({ ...c, roles }))} />
              </Field>

              {/* tipos de fonte — chips/cards adicionáveis */}
              <Field label="Tipos de coisa que você joga aqui" hint="Cada tipo lembra quem costuma estar do outro lado.">
                <SourceTypesEditor
                  sourceTypes={ctx.sourceTypes}
                  onChange={(sourceTypes) => setCtx((c) => ({ ...c, sourceTypes }))}
                />
              </Field>

              {/* ações */}
              <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
                <Button variant="primary" onClick={handleSaveContext} disabled={ctxSaving}>
                  {ctxSaving ? "Salvando…" : "Salvar contexto"}
                </Button>
                <Button variant="secondary" icon={<Icon name="search" size={14} />} onClick={openPreview}>
                  Ver o que eu extrairia
                </Button>
                <Button variant="secondary" icon={<Icon name="clock" size={14} />} onClick={openReextract}>
                  Re-extrair com o contexto novo
                </Button>
              </div>
            </div>
          )}
        </Card>

        {/* ─────────────── GitHub do cérebro (espelho legível + entrada) ─────────────── */}
        <GithubSection onToast={(msg, tone) => setToast({ msg, tone })} />

        {/* ───────────────────── Membros ───────────────────── */}
        <Card header={<SectionTitle>Membros</SectionTitle>}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ display: "grid", placeItems: "center", width: 34, height: 34, borderRadius: 9, background: "var(--surface-2)", color: "var(--muted)", flexShrink: 0 }}>
              <Icon name="info" size={17} />
            </span>
            <div>
              <div style={{ fontSize: 14, fontWeight: 600 }}>
                Convites e permissões
              </div>
              <p style={{ margin: "3px 0 0", fontSize: 13, color: "var(--muted)", lineHeight: 1.5 }}>
                Convites e permissões moram em <a href="/app/acesso" style={{ color: "var(--accent-ink)", textDecoration: "none", fontWeight: 600 }}>Acesso</a>.
              </p>
            </div>
          </div>
        </Card>

        {/* ─────────────────── Preferências ─────────────────── */}
        <Card header={<SectionTitle>Preferências</SectionTitle>}>
          <div style={{ display: "grid", gap: 14 }}>
            <PrefRow label="Idioma" value="Português (Brasil)" hint="Único idioma disponível por ora." />
            <PrefRow
              label="Fuso horário"
              value={localTimezone()}
              hint="Detectado do seu navegador (informativo)."
            />
            <PrefRow label="Tema" value="Claro" hint="Personalização de tema — em breve." muted />
          </div>
        </Card>
      </div>

      {/* ───────── Modal: criar projeto ───────── */}
      <Modal
        open={createOpen}
        onClose={() => (creating ? undefined : setCreateOpen(false))}
        title="Novo projeto"
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreateOpen(false)} disabled={creating}>
              Cancelar
            </Button>
            <Button variant="primary" onClick={handleCreate} disabled={creating}>
              {creating ? "Criando…" : "Criar projeto"}
            </Button>
          </>
        }
      >
        <label style={{ display: "block", fontSize: 13, fontWeight: 600, marginBottom: 7 }}>Nome do projeto</label>
        <input
          autoFocus
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !creating) handleCreate();
          }}
          placeholder="Ex.: Vendas, Jurídico, Suporte…"
          style={inputStyle}
        />
        {createErr && (
          <p style={{ margin: "9px 0 0", fontSize: 13, color: "var(--danger)" }}>{createErr}</p>
        )}
      </Modal>

      {/* ───────── Modal: confirmar saída ───────── */}
      <Modal
        open={confirmLogout}
        onClose={() => (loggingOut ? undefined : setConfirmLogout(false))}
        title="Sair da conta"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmLogout(false)} disabled={loggingOut}>
              Cancelar
            </Button>
            <Button variant="primary" onClick={handleLogout} disabled={loggingOut} style={{ background: "var(--danger)", borderColor: "var(--danger)" }}>
              {loggingOut ? "Saindo…" : "Sair"}
            </Button>
          </>
        }
      >
        <p style={{ margin: 0, fontSize: 14, lineHeight: 1.55 }}>
          Você vai encerrar a sessão neste dispositivo. É só entrar de novo quando voltar.
        </p>
      </Modal>

      {/* ───────── Modal: preview "o que eu extrairia" (prosa, M11/S6) ───────── */}
      <Modal
        open={previewOpen}
        onClose={() => (previewing ? undefined : setPreviewOpen(false))}
        title="O que eu extrairia"
        width={560}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPreviewOpen(false)} disabled={previewing}>
              Fechar
            </Button>
            <Button variant="primary" onClick={handlePreview} disabled={previewing}>
              {previewing ? "Lendo…" : "Mostrar"}
            </Button>
          </>
        }
      >
        <p style={{ margin: "0 0 10px", fontSize: 13.5, color: "var(--muted)", lineHeight: 1.5 }}>
          Cole um trecho de exemplo. Eu mostro, em linguagem natural, o que guardaria dele com o contexto atual.
        </p>
        <textarea
          autoFocus
          value={previewText}
          onChange={(e) => setPreviewText(e.target.value)}
          placeholder="Ex.: Plano Enterprise da Accelera: R$ 30 mil/mês."
          rows={4}
          style={{ ...inputStyle, height: "auto", padding: "9px 12px", resize: "vertical" }}
        />
        {previewErr && <p style={{ margin: "9px 0 0", fontSize: 13, color: "var(--danger)" }}>{previewErr}</p>}
        {previewResult && (
          <div
            style={{
              marginTop: 12,
              padding: "12px 14px",
              borderRadius: 10,
              background: "var(--surface-2)",
              fontSize: 14,
              lineHeight: 1.55,
            }}
          >
            {previewResult}
          </div>
        )}
      </Modal>

      {/* ───────── Modal: re-extrair com aviso de custo (D3, M11/S6) ───────── */}
      <Modal
        open={reextOpen}
        onClose={() => (reextRunning ? undefined : setReextOpen(false))}
        title="Re-extrair com o contexto novo"
        footer={
          <>
            <Button variant="ghost" onClick={() => setReextOpen(false)} disabled={reextRunning}>
              Cancelar
            </Button>
            <Button
              variant="primary"
              onClick={handleReextractRun}
              disabled={reextRunning || reextLoading || !reextEst || reextEst.staleDocs === 0}
            >
              {reextRunning ? "Re-extraindo…" : "Re-extrair agora"}
            </Button>
          </>
        }
      >
        {reextLoading ? (
          <p style={{ margin: 0, fontSize: 14, color: "var(--muted)" }}>Calculando o impacto…</p>
        ) : reextErr ? (
          <p style={{ margin: 0, fontSize: 13.5, color: "var(--danger)" }}>{reextErr}</p>
        ) : reextEst && reextEst.staleDocs > 0 ? (
          <p style={{ margin: 0, fontSize: 14, lineHeight: 1.55 }}>
            <strong>{reextEst.staleDocs}</strong> {reextEst.staleDocs === 1 ? "documento vai" : "documentos vão"} ser
            relido{reextEst.staleDocs === 1 ? "" : "s"} com o contexto novo · custo estimado de IA{" "}
            <strong>~US$ {reextEst.costUsdEstimate.toFixed(4)}</strong>. Isso só roda quando você confirmar.
          </p>
        ) : (
          <p style={{ margin: 0, fontSize: 14, lineHeight: 1.55 }}>
            Tudo já está atualizado — nada a re-extrair.
          </p>
        )}
      </Modal>

      {/* toast */}
      {toast && (
        <div style={{ position: "fixed", left: 0, right: 0, bottom: 24, display: "grid", placeItems: "center", zIndex: 1100, pointerEvents: "none" }}>
          <div style={{ pointerEvents: "auto" }}>
            <Toast tone={toast.tone} onClose={() => setToast(null)}>
              {toast.msg}
            </Toast>
          </div>
        </div>
      )}
    </div>
  );
}

// ───────────────────────── subcomponentes ─────────────────────────

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <strong style={{ fontSize: 14, fontWeight: 600 }}>{children}</strong>;
}

function RoleTag({ role }: { role: Brain["role"] }) {
  const owner = role === "owner";
  return (
    <span
      className="mono"
      style={{
        fontSize: 10.5,
        fontWeight: 600,
        letterSpacing: ".02em",
        textTransform: "uppercase",
        padding: "2px 7px",
        borderRadius: 6,
        color: "var(--muted)",
        background: "var(--surface-2)",
        border: "1px solid var(--border)",
        flexShrink: 0,
      }}
    >
      {owner ? "Dono" : "Membro"}
    </span>
  );
}

function Avatar({ name }: { name: string }) {
  const initial = (name?.trim()?.[0] ?? "?").toUpperCase();
  return (
    <div
      aria-hidden
      style={{
        display: "grid",
        placeItems: "center",
        width: 42,
        height: 42,
        borderRadius: "50%",
        background: "var(--accent-soft)",
        color: "var(--accent-ink)",
        fontSize: 17,
        fontWeight: 700,
        flexShrink: 0,
      }}
    >
      {initial}
    </div>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      <span style={{ display: "grid", placeItems: "center", width: 34, height: 34, borderRadius: 9, background: "var(--surface-2)", color: "var(--muted)", flexShrink: 0 }}>
        <Icon name="info" size={17} />
      </span>
      <div>
        <div style={{ fontSize: 14, fontWeight: 600 }}>
          {title}{" "}
          <SoonBadge />
        </div>
        <p style={{ margin: "3px 0 0", fontSize: 13, color: "var(--muted)", lineHeight: 1.5 }}>{body}</p>
      </div>
    </div>
  );
}

function PrefRow({ label, value, hint, muted }: { label: string; value: string; hint?: string; muted?: boolean }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16 }}>
      <div>
        <div style={{ fontSize: 14, fontWeight: 600, display: "flex", alignItems: "center", gap: 7 }}>
          {label}
          {muted && <SoonBadge />}
        </div>
        {hint && <p style={{ margin: "2px 0 0", fontSize: 12.5, color: "var(--muted)" }}>{hint}</p>}
      </div>
      <span style={{ fontSize: 13.5, color: muted ? "var(--muted)" : "var(--fg)", fontWeight: 500, whiteSpace: "nowrap" }}>
        {value}
      </span>
    </div>
  );
}

function SoonBadge() {
  return (
    <span
      style={{
        fontSize: 10.5,
        fontWeight: 600,
        letterSpacing: ".02em",
        textTransform: "uppercase",
        padding: "2px 7px",
        borderRadius: 99,
        color: "var(--muted)",
        background: "var(--surface-2)",
        border: "1px solid var(--border)",
        whiteSpace: "nowrap",
      }}
    >
      em breve
    </span>
  );
}

// ───────────────────── contexto: subcomponentes (M11/S6) ─────────────────────

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "grid", gap: 6 }}>
      <label style={{ fontSize: 13, fontWeight: 600 }}>{label}</label>
      {hint && <p style={{ margin: 0, fontSize: 12.5, color: "var(--muted)", lineHeight: 1.45 }}>{hint}</p>}
      {children}
    </div>
  );
}

/** Editor de papéis: linhas amigáveis (papel + rótulo). Nada de JSON. */
function RolesEditor({ roles, onChange }: { roles: CtxRoleSpec[]; onChange: (r: CtxRoleSpec[]) => void }) {
  function update(i: number, patch: Partial<CtxRoleSpec>) {
    onChange(roles.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  }
  function add() {
    onChange([...roles, { role: "self", speakers: [], label: "" }]);
  }
  function remove(i: number) {
    onChange(roles.filter((_, j) => j !== i));
  }
  return (
    <div style={{ display: "grid", gap: 8 }}>
      {roles.map((r, i) => (
        <div key={i} style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <select
            value={r.role}
            onChange={(e) => update(i, { role: e.target.value as CtxRole })}
            style={{ ...inputStyle, width: 180, flexShrink: 0 }}
          >
            {(Object.keys(ROLE_LABELS) as CtxRole[]).map((k) => (
              <option key={k} value={k}>
                {ROLE_LABELS[k]}
              </option>
            ))}
          </select>
          <input
            value={r.label}
            onChange={(e) => update(i, { label: e.target.value })}
            placeholder="Como chamar (ex.: Equipe de vendas)"
            style={inputStyle}
          />
          <Button size="sm" variant="ghost" icon={<Icon name="x" size={13} />} onClick={() => remove(i)}>
            {""}
          </Button>
        </div>
      ))}
      <div>
        <Button size="sm" variant="secondary" icon={<Icon name="plus" size={13} />} onClick={add}>
          Adicionar papel
        </Button>
      </div>
    </div>
  );
}

/** Editor de tipos de fonte: chips adicionáveis; cada um lembra o papel-default do "outro lado". */
function SourceTypesEditor({
  sourceTypes,
  onChange,
}: {
  sourceTypes: CtxSourceTypeSpec[];
  onChange: (t: CtxSourceTypeSpec[]) => void;
}) {
  const [draft, setDraft] = useState("");
  function slugify(s: string) {
    return s
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40);
  }
  function add() {
    const label = draft.trim();
    if (!label) return;
    const type = slugify(label);
    if (!type || sourceTypes.some((t) => t.type === type)) {
      setDraft("");
      return;
    }
    onChange([...sourceTypes, { type, label, otherRole: "client" }]);
    setDraft("");
  }
  function update(i: number, patch: Partial<CtxSourceTypeSpec>) {
    onChange(sourceTypes.map((t, j) => (j === i ? { ...t, ...patch } : t)));
  }
  function remove(i: number) {
    onChange(sourceTypes.filter((_, j) => j !== i));
  }
  return (
    <div style={{ display: "grid", gap: 10 }}>
      {sourceTypes.length > 0 && (
        <div style={{ display: "grid", gap: 8 }}>
          {sourceTypes.map((t, i) => (
            <div key={t.type} style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <Chip active>{t.label || t.type}</Chip>
              <span style={{ fontSize: 12.5, color: "var(--muted)" }}>o outro lado costuma ser:</span>
              <select
                value={t.otherRole}
                onChange={(e) => update(i, { otherRole: e.target.value as CtxRole })}
                style={{ ...inputStyle, width: 180, height: 32, flexShrink: 0 }}
              >
                {(Object.keys(ROLE_LABELS) as CtxRole[]).map((k) => (
                  <option key={k} value={k}>
                    {ROLE_LABELS[k]}
                  </option>
                ))}
              </select>
              <Button size="sm" variant="ghost" icon={<Icon name="x" size={13} />} onClick={() => remove(i)}>
                {""}
              </Button>
            </div>
          ))}
        </div>
      )}
      <div style={{ display: "flex", gap: 8 }}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          placeholder="Ex.: Call de venda, Aula, Suporte…"
          style={inputStyle}
        />
        <Button size="sm" variant="secondary" icon={<Icon name="plus" size={13} />} onClick={add}>
          Adicionar
        </Button>
      </div>
    </div>
  );
}

// ───────────────────────── helpers ─────────────────────────

const inputStyle: React.CSSProperties = {
  width: "100%",
  height: 38,
  padding: "0 12px",
  borderRadius: 9,
  border: "1px solid var(--border-strong)",
  background: "var(--surface)",
  color: "var(--fg)",
  fontFamily: "var(--font)",
  fontSize: 14,
  outline: "none",
  boxSizing: "border-box",
};

function localTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Sao_Paulo";
  } catch {
    return "America/Sao_Paulo";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GitHub do cérebro — espelho organizado PRA PESSOAS (reuniões/conversas/documentos/anotações
// por ano + conhecimento/ com dossiês + README painel) e entrada/ por diff (arquivo some
// quando vira memória). Config por cérebro: owner/repo/branch + PAT (fine-grained,
// contents:write, UM repo) + o que espelhar (default: tudo — o repo é do próprio dono).
// ─────────────────────────────────────────────────────────────────────────────

interface GhConfigView {
  enabled: boolean;
  temPat: boolean;
  owner?: string;
  repo?: string;
  branch?: string;
  sigiloMax?: string;
  retidas?: number; // memórias fora do espelho pelo filtro de sigilo
  lastSyncAt?: string | null;
  lastCommit?: string | null;
  lastError?: string | null;
}

async function ghReq<T>(path: string, method: "GET" | "PUT" | "POST", body?: unknown): Promise<T> {
  const brain = getCurrentBrain();
  const url = path + (brain ? `?brain=${encodeURIComponent(brain)}` : "");
  const res = await fetch(url, {
    method,
    credentials: "include",
    headers: method !== "GET" ? { "content-type": "application/json" } : {},
    body: method !== "GET" ? JSON.stringify(body ?? {}) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error || `erro ${res.status}`);
  return data as T;
}

function GithubSection({ onToast }: { onToast: (msg: string, tone: "ok" | "neutral" | "danger") => void }) {
  const [cfg, setCfg] = useState<GhConfigView | null>(null);
  const [owner, setOwner] = useState("");
  const [repo, setRepo] = useState("");
  const [branch, setBranch] = useState("main");
  const [pat, setPat] = useState("");
  const [sigiloMax, setSigiloMax] = useState("restrito");
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState<"salvar" | "sync" | null>(null);

  useEffect(() => {
    ghReq<GhConfigView>("/api/github/config", "GET")
      .then((c) => {
        setCfg(c);
        setOwner(c.owner ?? "");
        setRepo(c.repo ?? "");
        setBranch(c.branch ?? "main");
        setSigiloMax(c.sigiloMax ?? "restrito");
        setEnabled(c.enabled === true);
      })
      .catch(() => setCfg({ enabled: false, temPat: false }));
  }, []);

  async function salvar() {
    setBusy("salvar");
    try {
      const c = await ghReq<GhConfigView>("/api/github/config", "PUT", { owner, repo, branch, pat, sigiloMax, enabled });
      setCfg(c);
      setPat("");
      onToast("Config do GitHub salva.", "ok");
    } catch (e) {
      onToast(`Não deu pra salvar: ${(e as Error).message}`, "danger");
    } finally {
      setBusy(null);
    }
  }

  async function sincronizar() {
    setBusy("sync");
    try {
      const r = await ghReq<{
        entradaIngeridos: number; entradaRemovidos: number;
        espelhoEnviados: number; espelhoRemovidos: number; commit: string | null;
      }>("/api/github/sync", "POST", {});
      const partes = [`${r.espelhoEnviados} no espelho`];
      if (r.espelhoRemovidos) partes.push(`${r.espelhoRemovidos} removido(s)`);
      if (r.entradaIngeridos) partes.push(`${r.entradaIngeridos} da entrada pra fila`);
      if (r.entradaRemovidos) partes.push(`${r.entradaRemovidos} da entrada viraram memória`);
      onToast(`Sync ok: ${partes.join(" · ")}.`, "ok");
      ghReq<GhConfigView>("/api/github/config", "GET").then(setCfg).catch(() => {});
    } catch (e) {
      onToast(`Sync falhou: ${(e as Error).message}`, "danger");
    } finally {
      setBusy(null);
    }
  }

  const input: React.CSSProperties = {
    width: "100%", height: 36, padding: "0 10px", borderRadius: 8,
    border: "1px solid var(--border-strong)", background: "var(--surface)",
    color: "var(--fg)", fontSize: 13.5, boxSizing: "border-box",
  };
  const label: React.CSSProperties = { fontSize: 12.5, fontWeight: 600, display: "block", marginBottom: 4 };

  return (
    <Card header={<SectionTitle>GitHub do cérebro</SectionTitle>}>
      <p className="muted" style={{ fontSize: 13, lineHeight: 1.55, margin: "0 0 14px", maxWidth: "62ch" }}>
        A memória vira um repositório que qualquer pessoa navega: pastas de{" "}
        <b>reuniões, conversas, documentos e anotações</b> por ano (arquivos com data e título),{" "}
        <code className="mono" style={{ fontSize: 12 }}>conhecimento/</code> com um dossiê por
        pessoa/empresa/assunto e um README-painel com o resumo do que o cérebro sabe.
        Solte arquivos em <code className="mono" style={{ fontSize: 12 }}>entrada/</code> — quando o
        arquivo <b>some</b> de lá, virou memória; se ficou, ainda está processando (ou deu erro).
        Use um PAT <i>fine-grained</i> só com <i>contents: read/write</i> desse repo.
      </p>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, maxWidth: 620 }}>
        <div>
          <label style={label}>Dono (usuário/org)</label>
          <input style={input} value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="minha-conta" />
        </div>
        <div>
          <label style={label}>Repositório</label>
          <input style={input} value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="meu-cerebro" />
        </div>
        <div>
          <label style={label}>Branch</label>
          <input style={input} value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="main" />
        </div>
        <div>
          <label style={label}>PAT {cfg?.temPat ? "(salvo — preencha só pra trocar)" : ""}</label>
          <input style={input} type="password" value={pat} onChange={(e) => setPat(e.target.value)} placeholder={cfg?.temPat ? "••••••••" : "github_pat_…"} />
        </div>
        <div>
          <label style={label}>O que espelhar</label>
          <select style={{ ...input, height: 36 }} value={sigiloMax} onChange={(e) => setSigiloMax(e.target.value)}>
            <option value="restrito">Tudo (recomendado)</option>
            <option value="sensivel">Até sigiloso</option>
            <option value="interno">Até interno</option>
            <option value="publico">Só aberto</option>
          </select>
        </div>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 8 }}>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 13.5, cursor: "pointer" }}>
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            Sync ligada (a cada ~2 min)
          </label>
        </div>
      </div>
      <p className="muted" style={{ fontSize: 12.5, lineHeight: 1.5, margin: "10px 0 0", maxWidth: "62ch" }}>
        ⚠ Quem tem acesso ao repositório no GitHub vê tudo que está nele — use um repositório <b>privado</b>.
      </p>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 14 }}>
        <Button variant="primary" size="sm" onClick={salvar} disabled={busy !== null}>
          {busy === "salvar" ? "Salvando…" : "Salvar"}
        </Button>
        <Button size="sm" onClick={sincronizar} disabled={busy !== null || !cfg?.temPat || !enabled}>
          {busy === "sync" ? "Sincronizando…" : "Sincronizar agora"}
        </Button>
        {cfg?.lastSyncAt && (
          <span className="faint" style={{ fontSize: 12 }}>
            última sync {new Date(cfg.lastSyncAt).toLocaleString("pt-BR")}
            {cfg.lastCommit ? ` · ${cfg.lastCommit.slice(0, 8)}` : ""}
          </span>
        )}
        {(cfg?.retidas ?? 0) > 0 && (
          <span style={{ fontSize: 12, color: "var(--sn-secret)" }}>
            {cfg!.retidas} memória{cfg!.retidas === 1 ? "" : "s"} retida{cfg!.retidas === 1 ? "" : "s"} pelo filtro de sigilo
          </span>
        )}
        {cfg?.lastError && <span style={{ fontSize: 12, color: "var(--sn-secret)" }}>erro: {cfg.lastError.slice(0, 80)}</span>}
      </div>
    </Card>
  );
}
