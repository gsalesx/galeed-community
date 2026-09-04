/** M7/R16 — escopo de acesso de um principal DENTRO de um brain.
 *  ENFORCEMENT REAL (produção) = o filtro ESPELHO da app: inScope()/filterByScope(), aplicado em
 *  TODA borda de leitura (gateway /v1, MCP, BFF, retrieval). Hoje é camada ÚNICA — rota de leitura
 *  nova TEM que passar por ele (contrato fail-closed provado em test/unit/scope-espelho-fail-closed).
 *  A camada RLS (applyScopeToSession → GUCs galeed.area_scope/galeed.sensitivity_max) NÃO é armada
 *  por nenhum caminho de produção: só é provada em scripts/htc-m7-rls.ts; a policy scope_area_sens
 *  é no-op sem os GUCs, cobre só galeed_pages (não galeed_facts nem deny_types) e exige GALEED_RLS=1
 *  (default do produto: 0). PENDÊNCIA (decisão de arquitetura, fora deste fix): armar a camada RLS
 *  de verdade = engine.withScope(sql.begin + applyScopeToSession) + policy em galeed_facts/deny_types.
 *  Falha fechado: escopo sem áreas / sem grant = vê nada. */
import { getEngine, sensitivityRank, type GrantRow } from "../platform/engine.ts";

export interface Scope {
  principalId: string;     // quem (p/ access-log)
  areas: string[];         // slugs de área permitidos (N:N). [] = NENHUMA área → vê nada de restrito
  sensitivityMax: string;  // teto (um SENSITIVITY_LEVEL). default 'publico'
  denyTypes: string[];     // tipos negados (override fino)
  canIngest: boolean;      // capacidade de ESCRITA (gateway /v1/ingest gateia por isto). fail-closed: false = só lê
}

/** escopo VAZIO — falha fechado (sem grant, principal disabled): vê nada de conteúdo escopado e NÃO escreve. */
export const EMPTY_SCOPE: Scope = { principalId: "", areas: [], sensitivityMax: "publico", denyTypes: [], canIngest: false };

/** grant cru (S1) → Scope. Determinístico, sem I/O. */
export function scopeFromGrant(principalId: string, grant: GrantRow | undefined): Scope {
  if (!grant) return { ...EMPTY_SCOPE, principalId };
  return {
    principalId,
    areas: grant.areas ?? [],
    sensitivityMax: grant.sensitivity_max || "publico",
    denyTypes: grant.deny_types ?? [],
    canIngest: grant.can_ingest === true, // fail-closed: ausente/false/null = sem escrita
  };
}

/** resolve o escopo efetivo de um principal: principal disabled OU sem grant → EMPTY_SCOPE. */
export async function resolveScope(home: string, principalId: string): Promise<Scope> {
  const e = await getEngine(home);
  const p = await e.getPrincipal(principalId);
  if (!p || p.status !== "active") return { ...EMPTY_SCOPE, principalId };
  return scopeFromGrant(principalId, await e.getGrant(principalId));
}

/** item escopável: o que o filtro espelho precisa pra decidir. tags inclui as `area:<slug>`. */
export interface ScopableItem { type?: string; tags?: string[]; sensitivity?: string; }

/** extrai os slugs de área de uma lista de tags (`area:produto` → `produto`). */
export function areasOf(tags: string[] | undefined): string[] {
  return (tags ?? []).filter((t) => t.startsWith("area:")).map((t) => t.slice(5));
}

/** ACESSO TOTAL de área: grant com areas=['*'] pula o filtro de área (sigilo/denyTypes seguem
 *  valendo). Existe pros BOTS DE INTEGRAÇÃO: páginas de MODO LIVRE não têm tag `area:` e ficavam
 *  invisíveis pra qualquer token escopado — um beco silencioso (/v1/facts=[] sem pista). O '*' é
 *  EXPLÍCITO e por-principal; convidado humano restrito continua fail-closed como sempre. */
export const AREA_TOTAL = "*";

export function temAcessoTotal(scope: Scope): boolean {
  return scope.areas.includes(AREA_TOTAL);
}

/** o item passa no escopo? Regras (fail-closed):
 *  - tipo negado (denyTypes) → false;
 *  - áreas: acesso total ('*') pula o filtro; senão alguma área do item ∈ scope.areas (basta UMA);
 *  - rank(sensibilidade do item) ≤ rank(sensitivityMax) → senão false.
 *  Item sem área nenhuma só passa com acesso total (areas=[] do item → false num escopo por área). */
export function inScope(item: ScopableItem, scope: Scope): boolean {
  if (scope.denyTypes.includes(item.type ?? "")) return false;
  if (!temAcessoTotal(scope)) {
    const itemAreas = areasOf(item.tags);
    if (!itemAreas.some((a) => scope.areas.includes(a))) return false;
  }
  if (sensitivityRank(item.sensitivity) > sensitivityRank(scope.sensitivityMax)) return false;
  return true;
}

/** filtra uma lista pelo escopo (filtro ESPELHO da app — camada 2). */
export function filterByScope<T extends ScopableItem>(items: T[], scope: Scope): T[] {
  return items.filter((it) => inScope(it, scope));
}

/** seta os GUCs de escopo na sessão SQL ativa (camada RLS — ver cabeçalho: SEM chamador de
 *  produção; prova manual em scripts/htc-m7-rls.ts). set_config(..., true) = LOCAL: só tem efeito
 *  dentro de sql.begin(). area_scope = csv dos slugs; sensitivity_max = o nível. */
export async function applyScopeToSession(sql: any, scope: Scope): Promise<void> {
  await sql`select set_config('galeed.area_scope', ${scope.areas.join(",")}, true)`;
  await sql`select set_config('galeed.sensitivity_max', ${scope.sensitivityMax}, true)`;
}
