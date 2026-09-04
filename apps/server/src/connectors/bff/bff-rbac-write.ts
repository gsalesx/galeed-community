/** M10/S3 — handlers do BFF p/ a ESCRITA RBAC (invite/grant/token/revoke). Handlers PUROS (recebem
 *  home+body, devolvem objeto serializável ou lançam BffError). PLUGAM o motor M7 (principals.ts) — NÃO
 *  reescrevem. requireBrain (no web-server) valida sessão+membership ANTES: escrita em brain alheio
 *  nunca chega aqui (403 antes). Falha-fechado/auditoria do M7 preservados.
 *
 *  ZONING (ver ARTIFACTS §seam): o shape `Principal` (toPrincipalShape/labelOfArea/uiLevelOf) vive HOJE
 *  privado em web-server.ts. O Integrador EXTRAI essas 3 funções p/ `src/connectors/bff-rbac-shape.ts`
 *  e troca o helper local `principalShape()` abaixo por um import de `toPrincipalShape`. Enquanto o
 *  módulo não existe (S3 roda ANTES do reconcile), mantemos uma cópia FIEL de toPrincipalShape aqui,
 *  marcada como ponto de substituição — NÃO é nova regra de acesso, é só o shape de leitura do front. */
import { createPrincipal, setGrant, issueToken } from "../../core/access/principals.ts";
import { getEngine, SENSITIVITY_LEVELS, type PrincipalKind } from "../../core/platform/engine.ts";
import { accountByEmail, brainsOf, removeBrainMembership } from "../../core/access/accounts.ts";
// M10 (reconcile): BffError UNIFICADO + shape de leitura EXTRAÍDO de web-server.ts (bff-rbac-shape.ts).
import { BffError } from "./bff-common.ts";
import { toPrincipalShape } from "./bff-rbac-shape.ts";

export { BffError }; // re-export p/ compat dos imports existentes de "./bff-rbac-write.ts"

// --- Tipos de entrada (validados nas fronteiras) ---

/** corpo de POST /api/rbac/invite (espelha InviteReq do front). */
export interface InviteBody {
  kind: PrincipalKind; // "human" | "agent"
  label: string;
  email?: string;
  areas: string[];
  sensitivityMax: string; // ∈ SENSITIVITY_LEVELS
  denyTypes?: string[];
  id?: string; // opcional; default = slug(label) | gerado
  can_ingest?: boolean; // capacidade de ESCRITA (/v1/ingest). FAIL-CLOSED: ausente = false
}

/** corpo de POST /api/rbac/grant (espelha GrantReq + principalId). */
export interface GrantBody {
  principalId: string;
  areas: string[];
  sensitivityMax: string;
  denyTypes?: string[];
  can_ingest?: boolean; // capacidade de ESCRITA (/v1/ingest). FAIL-CLOSED: ausente = false
}

/** corpo de POST /api/rbac/token. */
export interface TokenIssueBody {
  principalId: string;
  label?: string;
}

// --- Validação (helper local — reusa a LÓGICA do access-cli.ts, NÃO importa o handler CLI) ---

function reqStr(v: unknown, field: string): string {
  if (typeof v !== "string" || !v.trim()) throw new BffError(400, `campo obrigatório: ${field}`);
  return v.trim();
}
function reqLevel(v: unknown): string {
  const s = typeof v === "string" ? v : "";
  if (!(SENSITIVITY_LEVELS as readonly string[]).includes(s)) {
    throw new BffError(400, `sensitivityMax deve ser um de: ${SENSITIVITY_LEVELS.join(", ")}`);
  }
  return s;
}
function reqKind(v: unknown): PrincipalKind {
  if (v !== "human" && v !== "agent") throw new BffError(400, "kind deve ser human ou agent");
  return v;
}
function arr(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim())
    : [];
}
/** booleano FAIL-CLOSED: só `true` (ou "true") libera; qualquer outra coisa = false. */
function bool(v: unknown): boolean {
  return v === true || v === "true";
}
/** slug determinístico p/ id quando não vier (tenant-neutro). */
function slugId(label: string, kind: PrincipalKind): string {
  const base =
    label
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "") || kind;
  return `${kind === "agent" ? "agent" : "user"}-${base}`;
}

// --- Handlers (assinaturas EXATAS — DESIGN-SPEC §3) ---

/** POST /api/rbac/invite → cria principal + grant inicial. Devolve o Principal (shape do front). */
export async function rbacInvite(home: string, body: Record<string, unknown>): Promise<unknown> {
  const kind = reqKind(body.kind);
  const label = reqStr(body.label, "label");
  const sensitivityMax = reqLevel(body.sensitivityMax);
  const id = typeof body.id === "string" && body.id.trim() ? body.id.trim() : slugId(label, kind);
  const email = typeof body.email === "string" ? body.email.trim() : undefined;
  await createPrincipal(home, { id, kind, label, email });
  await setGrant(home, { principalId: id, areas: arr(body.areas), sensitivityMax, denyTypes: arr(body.denyTypes), canIngest: bool(body.can_ingest) });
  await logGov(home, { event: "principal.invited", principalId: id, summary: `convidou ${label}` });
  return loadPrincipal(home, id);
}

/** POST /api/rbac/grant → substitui o grant de um principal existente. Devolve o Principal atualizado. */
export async function rbacGrant(home: string, body: Record<string, unknown>): Promise<unknown> {
  const principalId = reqStr(body.principalId, "principalId");
  const sensitivityMax = reqLevel(body.sensitivityMax);
  const e = await getEngine(home);
  if (!(await e.getPrincipal(principalId))) throw new BffError(404, "principal não encontrado");
  await setGrant(home, { principalId, areas: arr(body.areas), sensitivityMax, denyTypes: arr(body.denyTypes), canIngest: bool(body.can_ingest) });
  await logGov(home, { event: "grant.changed", principalId, summary: "acesso alterado" });
  return loadPrincipal(home, principalId);
}

/** POST /api/rbac/token → emite token CRU (1×) + devolve o principal. */
export async function rbacTokenIssue(home: string, body: Record<string, unknown>): Promise<unknown> {
  const principalId = reqStr(body.principalId, "principalId");
  const e = await getEngine(home);
  if (!(await e.getPrincipal(principalId))) throw new BffError(404, "principal não encontrado");
  const label = typeof body.label === "string" ? body.label.trim() : undefined;
  const { token } = await issueToken(home, { principalId, label });
  await logGov(home, { event: "token.issued", principalId, summary: "chave emitida" });
  const principal = await loadPrincipal(home, principalId);
  return { token, principal, warning: "copie o token AGORA — ele não pode ser recuperado." };
}

/** DELETE /api/rbac/token?principal=<id> → revoga TODOS os tokens ativos do principal (por
 *  principalId). Opera igual ao passo de revogação de rbacTokenRotate — o front nunca tem o hash
 *  completo (só last4), então a revogação DEVE ser por principal. Tolerante: sem token ativo = ok. */
export async function rbacTokenRevoke(
  home: string,
  params: { principalId: string; actor?: string },
): Promise<unknown> {
  const principalId = reqStr(params.principalId, "principalId");
  const e = await getEngine(home);
  for (const t of await e.tokensOf(principalId)) {
    if (!t.revoked) await e.revokeToken(t.token_hash);
  }
  await logGov(home, { event: "token.revoked", principalId, actor: params.actor, summary: "chave revogada" });
  return { ok: true, principalId };
}

// --- Shape do front (toPrincipalShape vem de ./bff-rbac-shape.ts — extraído de web-server.ts no reconcile) ---

/** lê principal+grant+tokens e monta o shape do front (mesmo `toPrincipalShape` de /api/rbac/principals). */
async function loadPrincipal(home: string, id: string): Promise<unknown> {
  const e = await getEngine(home);
  const p = await e.getPrincipal(id);
  if (!p) throw new BffError(404, "principal não encontrado após escrita");
  const grant = await e.getGrant(id);
  const tokens = await e.tokensOf(id);
  return toPrincipalShape(p, grant, tokens);
}

/** grava um evento de governança no MESMO timeline do access_log (event/actor preenchidos). best-effort. */
async function logGov(home: string, ev: { event: string; principalId: string; actor?: string; summary: string }): Promise<void> {
  try {
    const e = await getEngine(home);
    await e.appendAccessLog({ principal_id: ev.principalId, query: ev.summary, areas_touched: [], n_returned: 0, event: ev.event, actor: ev.actor });
  } catch (err) {
    console.error("[rbac] logGov (fail-soft):", err instanceof Error ? err.message : String(err));
  }
}

/** POST /api/rbac/token/rotate → revoga a(s) chave(s) ATIVA(s) do principal e emite uma nova. Devolve o cru 1×. */
export async function rbacTokenRotate(home: string, body: Record<string, unknown>, actor?: string): Promise<unknown> {
  const principalId = reqStr(body.principalId, "principalId");
  const e = await getEngine(home);
  if (!(await e.getPrincipal(principalId))) throw new BffError(404, "principal não encontrado");
  for (const t of await e.tokensOf(principalId)) {
    if (!t.revoked) await e.revokeToken(t.token_hash);
  }
  const { token } = await issueToken(home, { principalId });
  await logGov(home, { event: "token.rotated", principalId, actor, summary: "chave rotacionada" });
  const principal = await loadPrincipal(home, principalId);
  return { token, principal, warning: "copie o token AGORA — a chave anterior já não vale." };
}

/** DELETE /api/rbac/principal?id=<id> → remove de vez (grant+tokens+principal; pessoa perde o membership do brain). */
export async function rbacPrincipalRemove(home: string, body: Record<string, unknown>, actor?: string): Promise<unknown> {
  const principalId = reqStr(body.principalId, "principalId");
  const e = await getEngine(home);
  const p = await e.getPrincipal(principalId);
  if (!p) throw new BffError(404, "principal não encontrado");
  if (p.kind === "human" && p.email) {
    const acc = await accountByEmail(p.email);
    if (acc) {
      const brains = await brainsOf(acc.id);
      const entry = brains.find((b) => b.id === home);
      if (entry?.role === "owner") throw new BffError(403, "o dono do cérebro não pode ser removido");
      await removeBrainMembership(acc.id, home);
    }
  }
  await e.deletePrincipal(principalId);
  await logGov(home, { event: "principal.removed", principalId, actor, summary: `acesso removido: ${p.label}` });
  return { ok: true, removed: principalId };
}
