/** M7/R16 — fachada de gestão de PRINCIPAIS (humano|agente) e tokens escopados. Sem HTTP aqui:
 *  os servers (api/mcp) e o CLI (S5) chamam estas funções. Princípio genérico: humano e bot são o
 *  mesmo principal + grant; o humano usa sessão, o bot usa TOKEN. v1 = só-leitura (scope='read'). */
import { createHash, randomBytes } from "node:crypto";
import { getEngine, type PrincipalRow, type GrantRow, type PrincipalKind } from "../platform/engine.ts";
import { brainHome } from "../platform/brain.ts";
import { resolveScope, scopeFromGrant, type Scope } from "./scope.ts";

/** sha256 hex de um token cru. O cru NUNCA é persistido nem logado. */
export function hashToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

/** cria/atualiza um principal. */
export async function createPrincipal(
  home: string,
  input: { id: string; kind: PrincipalKind; label: string; email?: string },
): Promise<PrincipalRow> {
  const e = await getEngine(home);
  const row: PrincipalRow = { id: input.id, kind: input.kind, label: input.label, email: input.email ?? "", status: "active" };
  await e.upsertPrincipal(row);
  return row;
}

/** grava/substitui o grant de um principal (1:1). v1: scope sempre 'read'. `canIngest` é a capacidade
 *  de ESCRITA (gateway /v1/ingest); FAIL-CLOSED: ausente = false (grant explícito é quem libera escrita). */
export async function setGrant(
  home: string,
  input: { principalId: string; areas: string[]; sensitivityMax: string; denyTypes?: string[]; canIngest?: boolean },
): Promise<GrantRow> {
  const e = await getEngine(home);
  // acesso total ('*', ver scope.ts/AREA_TOTAL): se presente, normaliza pra ['*'] sozinho —
  // misturar '*' com slugs seria ambíguo e o csv do GUC de RLS espera exatamente '*'.
  const areas = input.areas.includes("*") ? ["*"] : input.areas;
  const grant: GrantRow = {
    principal_id: input.principalId, areas, sensitivity_max: input.sensitivityMax,
    deny_types: input.denyTypes ?? [], scope: "read", can_ingest: input.canIngest === true,
  };
  await e.putGrant(grant);
  return grant;
}

/** emite um token NOVO p/ um principal: gera o cru, persiste só o sha256. Retorna o cru UMA vez. */
export async function issueToken(
  home: string,
  input: { principalId: string; label?: string },
): Promise<{ token: string; tokenHash: string }> {
  const e = await getEngine(home);
  // Prefixo gateado por env (a doc pública usa `gld_live_…`). A validação é por HASH do token
  // INTEIRO → tokens `gal_…` antigos seguem válidos (o prefixo não entra na decisão de auth).
  const prefix = process.env.GALEED_TOKEN_PREFIX || "gld_live_";
  const token = `${prefix}${randomBytes(32).toString("hex")}`; // cru — só agora é visível
  const tokenHash = hashToken(token);
  await e.upsertToken({ principal_id: input.principalId, token_hash: tokenHash, label: input.label ?? "", revoked: false });
  return { token, tokenHash };
}

/** autentica um token CRU → principal + escopo. null se inválido/revogado/principal disabled.
 *  MESMA função p/ API e MCP (um sistema só). Atualiza last_used_at (auditoria leve). */
export async function authenticateToken(
  home: string,
  rawToken: string,
): Promise<{ principal: PrincipalRow; scope: Scope } | null> {
  if (!rawToken) return null;
  const e = await getEngine(home);
  const tok = await e.tokenByHash(hashToken(rawToken));
  if (!tok || tok.revoked) return null;
  const principal = await e.getPrincipal(tok.principal_id);
  if (!principal || principal.status !== "active") return null;
  await e.touchToken(tok.token_hash);
  const scope = scopeFromGrant(principal.id, await e.getGrant(principal.id));
  return { principal, scope };
}

/** GATEWAY /v1 — autentica um token CRU SEM saber o brain de antemão: deriva o tenant DO PRÓPRIO
 *  token. (1) hashToken; (2) busca GLOBAL em galeed_tokens (engine de bootstrap, brainHome()) →
 *  { brain, principal_id }; (3) abre o engine DAQUELE brain, valida principal ativo, resolve scope
 *  (grant) e toca last_used_at. Isolamento de tenant POR CONSTRUÇÃO: o brain vem do token, nunca do
 *  cliente. Fail-closed: token vazio/inexistente/revogado/principal inativo → null (401). Erro de INFRA
 *  (DB/schema/conexão) é RE-LANÇADO → 500 honesto no gateway (não 401, que mascararia deploy quebrado).
 *  NÃO toca authenticateToken(home,token) — o BFF/api-server continuam usando aquele.
 *  RLS (RESOLVIDO): sob GALEED_RLS=1 o passo (2) roda no brain de bootstrap, e a policy brain_iso
 *  esconderia tokens de OUTROS brains (o token vive no brain do cliente) → 401 falso. O fix é a policy
 *  PERMISSIVA de SELECT `token_hash_global_select` em galeed_tokens (postgres-schema.ts, applyPostgresRls):
 *  libera a leitura global por token_hash SÓ para SELECT (emissão/revogação seguem presas a brain_iso).
 *  Seguro porque token_hash = sha256 não reversível e a tabela só tem metadados — conteúdo (pages/facts/
 *  grants) continua isolado por brain_iso. */
export async function authenticateTokenGlobal(
  rawToken: string,
): Promise<{ brain: string; principal: PrincipalRow; scope: Scope } | null> {
  if (!rawToken) return null;
  try {
    const tokenHash = hashToken(rawToken);
    // (1) descobre o tenant — busca global por token_hash (engine de bootstrap, sem ?brain do cliente).
    const boot = await getEngine(brainHome());
    const found = await boot.tokenByHashGlobal(tokenHash);
    if (!found || !found.brain || !found.principal_id) return null;
    // (2) valida principal + grant NO BRAIN DO TOKEN.
    const e = await getEngine(found.brain);
    const principal = await e.getPrincipal(found.principal_id);
    if (!principal || principal.status !== "active") return null;
    await e.touchToken(tokenHash);
    const scope = scopeFromGrant(principal.id, await e.getGrant(principal.id));
    return { brain: found.brain, principal, scope };
  } catch (err) {
    // Fail-closed CONTINUA (erro nunca vira acesso), mas erro de INFRA (Postgres fora, coluna/tabela
    // ausente, schema quebrado) deve virar 500 HONESTO no gateway — não 401. 401 fingiria "token
    // inválido" e mascararia um deploy quebrado (foi o que confundiu a revisão). Os casos de token de
    // fato inválido já retornaram null acima, SEM exceção; aqui só caem erros inesperados → re-lança
    // (o handler do gateway converte em 500 genérico).
    console.error("authenticateTokenGlobal: erro de infra ao resolver token:", (err as Error)?.message);
    throw err;
  }
}

/** preview: o que um grant VÊ (sem rodar query) — áreas, teto, tipos negados + contagem de páginas
 *  visíveis. Determinístico; usa o engine. Para o CLI `access-test` (S5) e o endpoint de preview. */
export async function accessTest(
  home: string,
  principalId: string,
): Promise<{ scope: Scope; visiblePages: number; sampleSlugs: string[] }> {
  const e = await getEngine(home);
  const scope = await resolveScope(home, principalId);
  const { filterByScope } = await import("./scope.ts");
  const pages = await e.allPages();
  const visible = filterByScope(pages.map((p) => ({ ...p })), scope);
  return { scope, visiblePages: visible.length, sampleSlugs: visible.slice(0, 10).map((p) => p.slug) };
}
