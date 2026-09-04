/** Tela ACESSO ("Quem vê o quê") — governança/RBAC do Galeed (M8/_design/acesso.md).
 *  Renderiza dentro do <main> do AppShell (page head + KPIs + grid).
 *  Dados via api.rbac.* — o RBAC é real no BFF (cria principal + grant + log de governança
 *  de verdade); o que era mock ficava só na apresentação do front. Fail-closed é a regra de ouro. */
import { useCallback, useMemo, useState } from "react";
import {
  Button,
  Card,
  Icon,
  KpiTile,
  LockChip,
  Modal,
  Skeleton,
  Toast,
} from "../../ui";
import type { LockLevel } from "../../ui";
import { ApiError, api } from "../../lib/api";
import type { AccessLogEntry, AccessPreview, AreaView, Principal, Token } from "../../lib/api";
import { useBrain } from "../../lib/auth";
import { useMutation, useQuery } from "../../lib/useQuery";
import { relativeTime } from "../../lib/format";
import { dotDeArea, lockText, SENS_TO_CODE } from "./data";
import { InviteWizard, type InviteResult } from "./InviteWizard";
import { ViewAsOverlay } from "./ViewAsOverlay";

export default function Acesso() {
  // deps [current?.id]: trocar de cérebro REFAZ as consultas (sem isso a tela mostrava
  // pessoas/áreas/histórico do cérebro anterior até um reload — dado de outro tenant na tela).
  const { current } = useBrain();
  const principalsQ = useQuery<Principal[]>("rbac:principals", (signal) =>
    fetchPrincipals(signal),
  [current?.id]);
  const principals = principalsQ.data ?? [];
  const logQ = useQuery<AccessLogEntry[]>("rbac:log", () => api.rbac.log(), [current?.id]);
  // áreas REAIS do cérebro (tags area: + grants) — nada de lista inventada no front.
  const areasQ = useQuery<AreaView[]>("rbac:areas", () => api.rbac.areas(), [current?.id]);
  const areas = areasQ.data ?? [];

  // --- estado de UI ---
  const [view, setView] = useState<"list" | "matrix">("list");
  const [toast, setToast] = useState<{ msg: string; tone: "ok" | "neutral" | "danger" } | null>(null);

  // wizard convidar/editar
  const [wizardOpen, setWizardOpen] = useState(false);
  const [editing, setEditing] = useState<Principal | null>(null);
  const [freshToken, setFreshToken] = useState<string | null>(null);
  const [freshTokenLabel, setFreshTokenLabel] = useState<string | null>(null); // label do bot recém-criado, pro toast no fim do fluxo

  // ver como vê
  const [viewAs, setViewAs] = useState<Principal | null>(null);
  const previewQ = useQuery<AccessPreview | null>(
    `rbac:preview:${viewAs?.id ?? ""}`,
    (signal) => (viewAs ? api.rbac.preview(viewAs.id, "preço consultoria Acme") : Promise.resolve(null)),
    [viewAs?.id],
  );

  // revogar token
  const [revoking, setRevoking] = useState<{ p: Principal; token: Token } | null>(null);

  // rotacionar / remover de vez
  const [rotating, setRotating] = useState<Principal | null>(null);
  const [removing, setRemoving] = useState<Principal | null>(null);
  const [freshRotated, setFreshRotated] = useState<string | null>(null);
  const rotateMut = useMutation<string, { token: string; principal: Principal }>((principalId) =>
    api.rbac.rotateToken(principalId),
  );
  const removeMut = useMutation<string, { ok: boolean; removed: string }>((principalId) =>
    api.rbac.removePrincipal(principalId),
  );

  const inviteMut = useMutation<InviteResult, Principal>(async ({ body, editing: ed }) => {
    if (ed) return api.rbac.setGrant(ed.id, body);
    return api.rbac.invite(body);
  });
  const tokenMut = useMutation<string, { token: string; principal: Principal }>((principalId) =>
    api.rbac.issueToken(principalId),
  );
  const revokeMut = useMutation<string, void>((principalId) =>
    api.rbac.revokeToken(principalId),
  );

  const humans = principals.filter((p) => p.kind === "human").length;
  const agents = principals.filter((p) => p.kind === "agent").length;

  const openInvite = useCallback(() => {
    setEditing(null);
    setFreshToken(null);
    setWizardOpen(true);
  }, []);

  const openEdit = useCallback((p: Principal) => {
    setEditing(p);
    setFreshToken(null);
    setWizardOpen(true);
  }, []);

  async function handleSubmit(r: InviteResult) {
    const saved = await inviteMut.mutate(r);
    principalsQ.refetch();
    // bot novo → emite token cru e mostra UMA vez
    if (!r.editing && r.body.kind === "agent") {
      try {
        const t = await tokenMut.mutate(saved.id);
        setFreshToken(t.token);
        setFreshTokenLabel(r.body.label);
        principalsQ.refetch();
        return; // mantém o modal no aviso de token
      } catch {
        /* emissão da chave falhou; o principal já foi criado, segue sem travar o fluxo */
      }
    }
    setWizardOpen(false);
    setToast({
      msg: r.editing ? "Acesso atualizado." : `Acesso criado pra ${r.body.label}. Avise a pessoa você mesmo.`,
      tone: "ok",
    });
  }

  async function confirmRevoke() {
    if (!revoking) return;
    await revokeMut.mutate(revoking.p.id);
    setRevoking(null);
    principalsQ.refetch();
    setToast({ msg: `Chave do ${revoking.p.label} revogada.`, tone: "danger" });
  }

  async function confirmRotate() {
    if (!rotating) return;
    try {
      const r = await rotateMut.mutate(rotating.id);
      setFreshRotated(r.token);
      principalsQ.refetch();
    } catch (e) {
      setToast({ msg: `Não deu pra rotacionar: ${(e as Error).message}`, tone: "danger" });
    } finally {
      setRotating(null);
    }
  }

  async function confirmRemove() {
    if (!removing) return;
    try {
      await removeMut.mutate(removing.id);
      setToast({ msg: `Acesso de ${removing.label} removido.`, tone: "danger" });
      principalsQ.refetch();
    } catch (e) {
      setToast({ msg: `Não deu pra remover: ${(e as Error).message}`, tone: "danger" });
    } finally {
      setRemoving(null);
    }
  }

  function copyToken(t: string) {
    if (typeof navigator !== "undefined" && navigator.clipboard) navigator.clipboard.writeText(t).catch(() => {});
    setToast({ msg: "Chave copiada.", tone: "neutral" });
  }

  const empty = !principalsQ.loading && principals.length === 0;

  return (
    <div>
      {/* page head */}
      <header style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, marginBottom: 20 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 32, fontWeight: 700, letterSpacing: "-.025em" }}>Quem vê o quê</h1>
          <p style={{ margin: "6px 0 0", fontSize: 14.5, color: "var(--muted)", maxWidth: 560, lineHeight: 1.5 }}>
            Cada pessoa ou bot só vê a parte do cérebro que você liberou. O resto fica trancado, sozinho.
          </p>
        </div>
        <Button variant="primary" icon={<Icon name="plus" size={15} />} onClick={openInvite}>
          Convidar
        </Button>
      </header>

      {/* KPIs */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12, marginBottom: 22 }}>
        <KpiTile value={principalsQ.loading ? "—" : humans} label="pessoas · com login" />
        <KpiTile value={principalsQ.loading ? "—" : agents} label="bots · com chave" />
        <KpiTile value={areasQ.loading ? "—" : areas.length} label="áreas · assuntos" />
        <div
          style={{
            border: "1px solid oklch(88% 0.04 150)",
            borderRadius: 11,
            padding: "13px 15px",
            background: "var(--accent-soft)",
          }}
        >
          <b style={{ fontSize: 18, fontWeight: 700, color: "var(--accent-ink)", display: "block", lineHeight: 1.1 }}>Nada vaza</b>
          <small style={{ display: "block", marginTop: 6, fontSize: 11.5, color: "var(--accent-ink)" }}>por padrão</small>
        </div>
      </div>

      {/* grid 2 colunas (colapsa em 1 col em viewport estreito) */}
      <div className="acesso-grid" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.7fr) minmax(0, 1fr)", gap: 18, alignItems: "start" }}>
        {/* esquerda: pessoas e bots */}
        <Card
          padding={0}
          header={
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
              <div>
                <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Pessoas e bots</h3>
                <span style={{ fontSize: 12.5, color: "var(--muted)" }}>{principals.length} com acesso</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <ViewToggle view={view} onChange={setView} />
              </div>
            </div>
          }
        >
          {principalsQ.loading && <PrincipalsSkeleton />}
          {principalsQ.error && <ErrorState error={principalsQ.error} onRetry={principalsQ.refetch} />}
          {empty && <EmptyState onInvite={openInvite} />}
          {!principalsQ.loading && !principalsQ.error && principals.length > 0 && (
            <>
              {view === "list" ? (
                <div>
                  {principals.map((p) => (
                    <PrincipalRow
                      key={p.id}
                      p={p}
                      onEdit={() => openEdit(p)}
                      onViewAs={() => setViewAs(p)}
                      onRevoke={(t) => setRevoking({ p, token: t })}
                      onRotate={() => setRotating(p)}
                      onRemove={() => setRemoving(p)}
                    />
                  ))}
                </div>
              ) : (
                <AccessMatrix principals={principals} areas={areas} />
              )}
              <div style={{ padding: "12px 20px", borderTop: "1px solid var(--border)" }}>
                <a href="#historico" style={{ fontSize: 13, color: "var(--accent-ink)", textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 5 }}>
                  Histórico de acesso <Icon name="arrow" size={14} />
                </a>
              </div>
            </>
          )}
        </Card>

        {/* direita: áreas + explainer */}
        <div style={{ display: "grid", gap: 18 }}>
          <Card padding={0} header={<h3 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Áreas <span style={{ fontWeight: 400, color: "var(--muted)", fontSize: 13 }}>· assuntos do cérebro</span></h3>}>
            <div>
              {areasQ.loading && (
                <div style={{ padding: "14px 20px" }}><Skeleton height={14} width="60%" /></div>
              )}
              {!areasQ.loading && areas.length === 0 && (
                <p style={{ margin: 0, padding: "14px 20px", fontSize: 13, color: "var(--muted)", lineHeight: 1.5 }}>
                  Nenhuma área definida ainda — as memórias deste cérebro entram sem etiqueta de assunto.
                  Pra dar acesso a bots nesse caso, use <b>Todas as áreas</b> no convite.
                </p>
              )}
              {areas.map((a, i) => (
                <div key={a.slug} style={{ display: "flex", alignItems: "center", gap: 11, padding: "11px 20px", borderBottom: "1px solid var(--border)" }}>
                  <span aria-hidden style={{ width: 10, height: 10, borderRadius: "50%", background: dotDeArea(i), flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 600 }}>{a.label}</div>
                    <div style={{ fontSize: 12, color: "var(--faint)" }}>
                      {a.count > 0 ? `${a.count} memória${a.count === 1 ? "" : "s"}` : "citada num convite · sem memórias ainda"}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </Card>

          <Card header={<h3 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Como o acesso funciona</h3>}>
            <ExplainerStep n={1} title="Áreas" body="O assunto de cada coisa: Vendas, Suporte, Financeiro…" />
            <ExplainerStep n={2} title="Nível de sigilo" body="Do Aberto ao Secreto. Você libera só até onde quiser." />
            <ExplainerStep n={3} title="Nada vaza por padrão" body="Coisa nova entra trancada. Você é quem abre." last />
          </Card>
        </div>
      </div>

      {/* histórico de acesso — alvo do link "#historico" */}
      <section id="historico" style={{ marginTop: 28, scrollMarginTop: 70 }}>
        <Card
          padding={0}
          header={
            <div>
              <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Histórico de acesso</h3>
              <span style={{ fontSize: 12.5, color: "var(--muted)" }}>Consultas e mudanças de acesso, mais recentes primeiro.</span>
            </div>
          }
        >
          {logQ.loading && <p style={{ padding: "18px 20px", color: "var(--muted)" }}>Carregando…</p>}
          {logQ.error && <p style={{ padding: "18px 20px", color: "var(--danger)" }}>Não deu pra carregar o histórico: {logQ.error.message}</p>}
          {!logQ.loading && !logQ.error && (logQ.data ?? []).length === 0 && (
            <p style={{ padding: "28px 20px", textAlign: "center", color: "var(--muted)" }}>Nada por aqui ainda. Consultas e mudanças de acesso aparecem neste feed.</p>
          )}
          {!logQ.loading && !logQ.error && (logQ.data ?? []).map((e, i) => <HistoryRow key={`${e.ts}-${i}`} e={e} />)}
        </Card>
      </section>

      {/* wizard convidar / editar */}
      <InviteWizard
        open={wizardOpen}
        onClose={() => setWizardOpen(false)}
        catalogo={areas}
        editing={editing}
        onSubmit={handleSubmit}
        saving={inviteMut.loading || tokenMut.loading}
        freshToken={freshToken}
        onCopyToken={copyToken}
        onDoneToken={() => {
          setFreshToken(null);
          setWizardOpen(false);
          setToast({
            msg: `Acesso criado pra ${freshTokenLabel ?? "o bot"}. Avise a pessoa você mesmo.`,
            tone: "ok",
          });
          setFreshTokenLabel(null);
        }}
      />

      {/* ver como ela vê */}
      <ViewAsOverlay
        open={!!viewAs}
        onClose={() => setViewAs(null)}
        principal={viewAs}
        preview={previewQ.data}
        loading={previewQ.loading}
        error={previewQ.error ? previewQ.error.message : null}
      />

      {/* rotacionar = confirmação */}
      <Modal
        open={!!rotating}
        onClose={() => setRotating(null)}
        title="Rotacionar chave"
        footer={
          <>
            <Button variant="ghost" onClick={() => setRotating(null)}>Cancelar</Button>
            <Button variant="primary" onClick={confirmRotate} disabled={rotateMut.loading}>
              {rotateMut.loading ? "Rotacionando…" : "Gerar nova chave"}
            </Button>
          </>
        }
      >
        {rotating && (
          <p style={{ margin: 0, fontSize: 14.5, lineHeight: 1.5 }}>
            Gerar uma chave nova para <b>{rotating.label}</b>? A chave atual <b>para de funcionar na hora</b> — o agente precisa receber a nova.
          </p>
        )}
      </Modal>

      {/* chave nova (mostrada UMA vez) */}
      <Modal
        open={!!freshRotated}
        onClose={() => setFreshRotated(null)}
        title="Nova chave gerada"
        width={520}
        footer={<Button variant="ghost" onClick={() => setFreshRotated(null)}>Já guardei</Button>}
      >
        {freshRotated && (
          <div>
            <p style={{ margin: "0 0 12px", fontSize: 13, lineHeight: 1.45 }}>
              Copie agora — <b>esta é a única vez</b> que a chave aparece inteira. A anterior já não vale.
            </p>
            <div className="mono" style={{ padding: "11px 13px", borderRadius: 10, background: "var(--ink)", color: "oklch(90% 0.015 240)", fontSize: 12.5, wordBreak: "break-all" }}>
              {freshRotated}
            </div>
            <Button variant="secondary" style={{ marginTop: 10 }} onClick={() => copyToken(freshRotated)}>Copiar a chave</Button>
          </div>
        )}
      </Modal>

      {/* remover de vez = confirmação destrutiva */}
      <Modal
        open={!!removing}
        onClose={() => setRemoving(null)}
        title="Remover acesso"
        footer={
          <>
            <Button variant="ghost" onClick={() => setRemoving(null)}>Cancelar</Button>
            <Button variant="primary" onClick={confirmRemove} disabled={removeMut.loading} style={{ background: "var(--danger)", borderColor: "var(--danger)" }}>
              {removeMut.loading ? "Removendo…" : "Remover de vez"}
            </Button>
          </>
        }
      >
        {removing && (
          <p style={{ margin: 0, fontSize: 14.5, lineHeight: 1.5 }}>
            Remover o acesso de <b>{removing.label}</b> de vez? {removing.kind === "agent" ? "A chave é revogada e o bot some daqui." : "A pessoa perde o acesso a este cérebro."} Para voltar, é um novo convite.
          </p>
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
            Revogar a chave <span className="mono">····{revoking.token.last4}</span> do <b>{revoking.p.label}</b>? Ele perde o acesso na hora.
          </p>
        )}
      </Modal>

      {/* toasts */}
      {toast && (
        <div style={{ position: "fixed", left: 0, right: 0, bottom: 24, display: "grid", placeItems: "center", zIndex: 1100, pointerEvents: "none" }}>
          <div style={{ pointerEvents: "auto" }}>
            <Toast tone={toast.tone} onClose={() => setToast(null)}>{toast.msg}</Toast>
          </div>
        </div>
      )}

      {/* responsivo: ≤920px → grid principal em 1 coluna (lista de pessoas/bots não estoura) */}
      <style>{`
        @media (max-width: 920px) {
          .acesso-grid { grid-template-columns: 1fr !important; }
        }
      `}</style>
    </div>
  );
}

// ---------------------------------------------------------------------------
// fetch helper (api.rbac.principals com signal não suportado — chamamos direto)
// ---------------------------------------------------------------------------
function fetchPrincipals(_signal?: AbortSignal): Promise<Principal[]> {
  return api.rbac.principals();
}

// ---------------------------------------------------------------------------
// subcomponentes locais
// ---------------------------------------------------------------------------

function ViewToggle({ view, onChange }: { view: "list" | "matrix"; onChange: (v: "list" | "matrix") => void }) {
  return (
    <div style={{ display: "inline-flex", border: "1px solid var(--border-strong)", borderRadius: 8, overflow: "hidden" }}>
      {(["list", "matrix"] as const).map((v) => (
        <button
          key={v}
          type="button"
          onClick={() => onChange(v)}
          aria-pressed={view === v}
          style={{
            padding: "5px 12px",
            border: "none",
            background: view === v ? "var(--accent-soft)" : "var(--surface)",
            color: view === v ? "var(--accent-ink)" : "var(--muted)",
            fontSize: 12.5,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          {v === "list" ? "Lista" : "Matriz"}
        </button>
      ))}
    </div>
  );
}

function PrincipalRow({
  p, onEdit, onViewAs, onRevoke, onRotate, onRemove,
}: {
  p: Principal;
  onEdit: () => void;
  onViewAs: () => void;
  onRevoke: (t: Token) => void;
  onRotate: () => void;
  onRemove: () => void;
}) {
  const code: LockLevel = SENS_TO_CODE[p.grant.sensitivity_max];
  const human = p.kind === "human";
  const activeToken = p.tokens.find((t) => !t.revoked);
  const initials = p.label.split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();

  const sub = human
    ? `${p.email}${p.subline ? ` · ${p.subline}` : ""}`
    : `${activeToken ? `chave ····${activeToken.last4}` : "sem chave"}${p.subline ? ` · ${p.subline}` : ""}`;

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 13, padding: "14px 20px", borderBottom: "1px solid var(--border)" }}>
      {/* avatar */}
      {human ? (
        <span
          aria-hidden
          className="mono"
          style={{
            display: "grid",
            placeItems: "center",
            width: 38,
            height: 38,
            borderRadius: 10,
            background: "linear-gradient(135deg, var(--st-ent), var(--accent-ink))",
            color: "#fff",
            fontSize: 13,
            fontWeight: 600,
            flexShrink: 0,
          }}
        >
          {initials}
        </span>
      ) : (
        <span
          aria-hidden
          style={{ display: "grid", placeItems: "center", width: 38, height: 38, borderRadius: 10, background: "var(--surface-2)", border: "1px solid var(--border)", color: "var(--accent-ink)", flexShrink: 0 }}
        >
          <Icon name="info" size={18} />
        </span>
      )}

      {/* nome + sub + áreas */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 14.5, fontWeight: 600 }}>{p.label}</span>
          <span
            className="mono"
            style={{
              fontSize: 10,
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: ".04em",
              padding: "1px 6px",
              borderRadius: 5,
              color: human ? "var(--muted)" : "var(--accent-ink)",
              background: human ? "var(--surface-2)" : "var(--accent-soft)",
            }}
          >
            {human ? "pessoa" : "bot"}
          </span>
        </div>
        <div className="mono" style={{ fontSize: 11.5, color: "var(--faint)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sub}</div>
        <div style={{ display: "flex", gap: 6, marginTop: 7, flexWrap: "wrap" }}>
          {p.areas_labels.map((a) => (
            <span key={a} className="mono" style={{ fontSize: 11, padding: "2px 7px", borderRadius: 99, background: "var(--surface-2)", border: "1px solid var(--border)", color: "var(--muted)" }}>{a}</span>
          ))}
        </div>
      </div>

      {/* cadeado */}
      <LockChip level={code} showLabel={false} style={{ flexShrink: 0 }} />
      <span style={{ fontSize: 11.5, color: "var(--muted)", whiteSpace: "nowrap", flexShrink: 0 }}>{lockText(code)}</span>

      {/* ações */}
      <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
        {!human && activeToken && (
          <IconBtn label="Rotacionar chave" onClick={onRotate}>
            <Icon name="round" size={15} />
          </IconBtn>
        )}
        {!human && activeToken && (
          <IconBtn label="Revogar chave" onClick={() => onRevoke(activeToken)} danger>
            <Icon name="x" size={15} />
          </IconBtn>
        )}
        <IconBtn label="Ver como ele/ela vê" onClick={onViewAs}>
          <Icon name="search" size={15} />
        </IconBtn>
        <IconBtn label="Editar acesso" onClick={onEdit}>
          <Icon name="chevron" size={15} />
        </IconBtn>
        <IconBtn label="Remover acesso" onClick={onRemove} danger>
          <Icon name="x" size={15} />
        </IconBtn>
      </div>
    </div>
  );
}

function IconBtn({ children, label, onClick, danger }: { children: React.ReactNode; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      style={{
        display: "grid",
        placeItems: "center",
        width: 30,
        height: 30,
        borderRadius: 8,
        border: "1px solid var(--border)",
        background: "var(--surface)",
        color: danger ? "var(--danger)" : "var(--muted)",
        cursor: "pointer",
      }}
    >
      {children}
    </button>
  );
}

/** Matriz: linha = principal, coluna = área REAL do cérebro, célula = nível até onde vê
 *  (mesmo nível em todas as células preenchidas da linha, pois sensitivity_max é único por grant). */
function AccessMatrix({ principals, areas }: { principals: Principal[]; areas: AreaView[] }) {
  const cols = areas;
  if (!cols.length) {
    return (
      <p style={{ margin: 0, padding: "16px 20px", fontSize: 13, color: "var(--muted)", lineHeight: 1.5 }}>
        Sem áreas definidas ainda — a matriz aparece quando o cérebro tiver memórias etiquetadas
        por assunto (ou convites citando áreas). Quem tem <b>Todas as áreas</b> vê tudo.
      </p>
    );
  }
  return (
    <div style={{ padding: "0 0 4px", overflowX: "auto" }}>
      <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12.5 }}>
        <thead>
          <tr>
            <th style={{ textAlign: "left", padding: "10px 14px 10px 20px", color: "var(--faint)", fontWeight: 600, fontSize: 11.5, whiteSpace: "nowrap" }} className="mono">Quem \ Área</th>
            {cols.map((c) => (
              <th key={c.slug} style={{ padding: "10px 8px", color: "var(--muted)", fontWeight: 600, fontSize: 12, whiteSpace: "nowrap" }}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {principals.map((p) => {
            const code: LockLevel = SENS_TO_CODE[p.grant.sensitivity_max];
            return (
              <tr key={p.id} style={{ borderTop: "1px solid var(--border)" }}>
                <td style={{ padding: "10px 14px 10px 20px", fontWeight: 600, whiteSpace: "nowrap" }}>{p.label}</td>
                {cols.map((c) => {
                  // '*' = acesso total: vê todas as áreas (e o conteúdo sem área) — matriz cheia.
                  const sees = p.grant.areas.includes("*") || p.grant.areas.includes(c.slug);
                  return (
                    <td key={c.slug} style={{ padding: "6px 6px", textAlign: "center" }}>
                      {sees ? <MatrixCell code={code} /> : <span style={{ color: "var(--faint)" }}>·</span>}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="mono" style={{ display: "flex", gap: 14, flexWrap: "wrap", padding: "12px 20px", fontSize: 11, color: "var(--muted)", borderTop: "1px solid var(--border)" }}>
        <LegendDot code="open" /> <LegendDot code="int" /> <LegendDot code="conf" /> <LegendDot code="secret" />
        <span style={{ color: "var(--faint)" }}>· = não vê nada dessa área.</span>
      </div>
    </div>
  );
}

const CELL_LABEL: Record<LockLevel, string> = { open: "Aberto", int: "Interno", conf: "Sigiloso", secret: "Secreto" };
const CELL_SOFT: Record<LockLevel, string> = {
  open: "var(--sn-open-soft)",
  int: "var(--sn-int-soft)",
  conf: "var(--sn-conf-soft)",
  secret: "var(--sn-secret-soft)",
};
const CELL_FG: Record<LockLevel, string> = {
  open: "var(--sn-open)",
  int: "var(--sn-int)",
  conf: "var(--sn-conf)",
  secret: "var(--sn-secret)",
};

function MatrixCell({ code }: { code: LockLevel }) {
  return (
    <span className="mono" style={{ display: "inline-block", padding: "3px 8px", borderRadius: 6, background: CELL_SOFT[code], color: CELL_FG[code], fontSize: 11, fontWeight: 600 }}>
      {CELL_LABEL[code]}
    </span>
  );
}

function LegendDot({ code }: { code: LockLevel }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
      <span style={{ width: 9, height: 9, borderRadius: 3, background: CELL_FG[code] }} />
      {CELL_LABEL[code]}
    </span>
  );
}

function ExplainerStep({ n, title, body, last }: { n: number; title: string; body: string; last?: boolean }) {
  return (
    <div style={{ display: "flex", gap: 12, paddingBottom: last ? 0 : 14, marginBottom: last ? 0 : 14, borderBottom: last ? "none" : "1px solid var(--border)" }}>
      <span className="mono" style={{ display: "grid", placeItems: "center", width: 24, height: 24, borderRadius: 8, background: "var(--accent-soft)", color: "var(--accent-ink)", fontSize: 12, fontWeight: 600, flexShrink: 0 }}>{n}</span>
      <div>
        <b style={{ fontSize: 14, fontWeight: 600 }}>{title}</b>
        <p style={{ margin: "2px 0 0", fontSize: 13, color: "var(--muted)", lineHeight: 1.45 }}>{body}</p>
      </div>
    </div>
  );
}

/** Loading da lista de principais — linhas com Skeleton (consistente com Fatos/Saúde). */
function PrincipalsSkeleton() {
  return (
    <div>
      {[0, 1, 2, 3].map((r) => (
        <div key={r} style={{ display: "flex", alignItems: "center", gap: 13, padding: "14px 20px", borderBottom: "1px solid var(--border)" }}>
          <Skeleton width={38} height={38} radius={10} />
          <div style={{ flex: 1, minWidth: 0, display: "grid", gap: 7 }}>
            <Skeleton width="32%" height={12} />
            <Skeleton width="55%" height={10} />
            <div style={{ display: "flex", gap: 6 }}>
              <Skeleton width={56} height={18} radius={99} />
              <Skeleton width={44} height={18} radius={99} />
            </div>
          </div>
          <Skeleton width={70} height={22} radius={8} />
        </div>
      ))}
    </div>
  );
}

/** Erro honesto (sem stack). 403 → "sem acesso"; 401 é tratado pelo AuthProvider global. */
function ErrorState({ error, onRetry }: { error: Error; onRetry: () => void }) {
  const is403 = error instanceof ApiError && error.status === 403;
  return (
    <div role="alert" style={{ padding: "20px 20px", display: "flex", alignItems: "center", gap: 14 }}>
      <span aria-hidden style={{ color: "var(--sn-secret)", display: "grid", placeItems: "center", flexShrink: 0 }}>
        <Icon name={is403 ? "lock-closed" : "info"} size={20} />
      </span>
      <div style={{ flex: 1 }}>
        <b style={{ fontSize: 14.5 }}>
          {is403 ? "Você não tem acesso a esta área." : "Não consegui carregar quem tem acesso."}
        </b>
        <div style={{ fontSize: 13, color: "var(--muted)", marginTop: 4 }}>
          {is403 ? "Peça ao dono do cérebro pra liberar a governança." : error.message}
        </div>
      </div>
      {!is403 && (
        <Button size="sm" variant="secondary" onClick={onRetry} style={{ flexShrink: 0 }}>
          Tentar de novo
        </Button>
      )}
    </div>
  );
}

function EmptyState({ onInvite }: { onInvite: () => void }) {
  return (
    <div style={{ padding: "44px 20px", textAlign: "center" }}>
      <span style={{ display: "inline-grid", placeItems: "center", width: 54, height: 54, borderRadius: 14, background: "var(--surface-2)", border: "1px solid var(--border)", color: "var(--sn-secret)", marginBottom: 14 }}>
        <Icon name="lock-closed" size={26} />
      </span>
      <h3 style={{ margin: "0 0 6px", fontSize: 17, fontWeight: 600 }}>Nada vaza por padrão</h3>
      <p style={{ margin: "0 auto 16px", maxWidth: 360, fontSize: 13.5, color: "var(--muted)", lineHeight: 1.5 }}>
        Tudo que entra fica trancado até você liberar. Você decide quem vê o quê.
      </p>
      <Button variant="primary" icon={<Icon name="plus" size={15} />} onClick={onInvite}>Convidar</Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Histórico de acesso — EVENT_LABEL + HistoryRow
// ---------------------------------------------------------------------------

const EVENT_LABEL: Record<string, string> = {
  "token.issued": "chave emitida",
  "token.revoked": "chave revogada",
  "token.rotated": "chave rotacionada",
  "principal.invited": "acesso concedido",
  "grant.changed": "acesso alterado",
  "principal.removed": "acesso removido",
};

function HistoryRow({ e }: { e: AccessLogEntry }) {
  const gov = !!e.event;
  const areas = e.areas_touched ?? [];
  const title = gov
    ? `${EVENT_LABEL[e.event!] ?? e.event} · ${e.principal_id}`
    : `${e.principal_id} consultou "${e.query ?? ""}"`;
  const sub = gov
    ? (e.actor ? `por ${e.actor}` : "")
    : `${e.n_returned} resultado${e.n_returned === 1 ? "" : "s"}${areas.length ? ` · ${areas.join(", ")}` : ""}`;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 20px", borderBottom: "1px solid var(--border)" }}>
      <span aria-hidden style={{ display: "grid", placeItems: "center", width: 30, height: 30, borderRadius: 8, background: gov ? "var(--accent-soft)" : "var(--surface-2)", color: gov ? "var(--accent-ink)" : "var(--muted)", flexShrink: 0 }}>
        <Icon name={gov ? "lock-closed" : "search"} size={15} />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</div>
        {sub && <div className="mono" style={{ fontSize: 11.5, color: "var(--faint)" }}>{sub}</div>}
      </div>
      <span style={{ fontSize: 11.5, color: "var(--faint)", whiteSpace: "nowrap", flexShrink: 0 }}>{e.ts ? relativeTime(e.ts) : ""}</span>
    </div>
  );
}
