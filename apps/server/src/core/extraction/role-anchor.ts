/** M11/S2 — PRÉ-PASSO DETERMINÍSTICO de ancoragem por papéis. SEM LLM, puro, sem IO.
 *
 *  Dado o `BrainContext` (self + papéis declarados pelo tenant) e o corpo da fonte, mapeia os falantes
 *  parseados (`parseConversationMessages`) aos papéis declarados e monta um BLOCO DE TEXTO pro prompt que
 *  instrui o LLM a ancorar a métrica/atributo de CADA falante na entidade do PAPEL dele — a métrica do
 *  cliente ancora no slug do cliente, a oferta/preço do self ancora no self.
 *
 *  ADR-002 (tenant-neutralidade): ZERO literal de domínio aqui — tudo vem de `ctx`. Brain sem contexto
 *  (self.slug==="") → bloco vazio → o prompt cai no comportamento legado (frequência), byte-idêntico.
 *  ADR-003 (ancoragem verbatim): não inventa número/entidade — só mapeia falante→papel do que o contexto
 *  + o parse declaram. A criação do SLUG do cliente é do LLM; o bloco só INSTRUI a ancorar no papel certo. */
import { parseConversationMessages } from "../../lib/conversation.ts";
import type { BrainContext, Role } from "./brain-context.ts";

/** Resultado do pré-passo: papéis identificados na fonte + o bloco de prompt pronto. */
export interface RoleAnchoring {
  /** self do brain (vazio se não declarado). */
  selfSlug: string;
  /** falantes mapeados a papéis (só os que casaram um papel != "other"). */
  speakers: { name: string; role: Role }[];
  /** papel default do "outro" (não-self) p/ este tipo de fonte (de sourceTypes[type].otherRole). "other" se n/d. */
  otherRole: Role;
  /** bloco de texto a injetar no prompt (ANTES do corpo untrusted). "" se não há contexto útil. */
  block: string;
}

/** label legível de um papel, a partir do roles[] declarado (cosmético). "" se não declarado. */
function roleLabel(ctx: BrainContext, role: Role): string {
  const spec = ctx.roles.find((r) => r.role === role);
  return spec?.label?.trim() ?? "";
}

/** Mapeia falantes→papéis e monta o bloco de ancoragem por contexto. DETERMINÍSTICO.
 *  - `ctx` vazio (self.slug==="") → retorna { selfSlug:"", speakers:[], otherRole:"other", block:"" }.
 *  - `type` casa um sourceTypes[].type → usa seu otherRole; senão "other".
 *  - falante casa self.aliases (case-insensitive, trim) → role "self"; casa roles[].speakers → aquele role;
 *    senão recebe o otherRole do tipo.
 *  Tenant-neutro: zero literal de domínio; tudo vem de `ctx`. */
export function anchorRoles(ctx: BrainContext, body: string, type: string, fallbackDate?: string): RoleAnchoring {
  const selfSlug = (ctx.self?.slug || "").toLowerCase().trim();

  // sem self declarado → sem âncora de contexto → bloco vazio (comportamento legado de frequência).
  if (!selfSlug) {
    return { selfSlug: "", speakers: [], otherRole: "other", block: "" };
  }

  // otherRole default p/ este tipo de fonte (de sourceTypes). "other" se o tipo não foi declarado.
  const typeSpec = ctx.sourceTypes.find((s) => s.type === type);
  const otherRole: Role = typeSpec?.otherRole ?? "other";

  // conjuntos de casamento (case-insensitive, trim): self.aliases (+slug) → "self"; roles[].speakers → role.
  const selfNames = new Set<string>(
    [selfSlug, ...(ctx.self?.aliases ?? [])].map((a) => a.toLowerCase().trim()).filter(Boolean),
  );
  const speakerToRole = new Map<string, Role>(); // nome falante (lower) → role declarado
  for (const r of ctx.roles) {
    for (const sp of r.speakers ?? []) {
      const key = sp.toLowerCase().trim();
      if (key && !speakerToRole.has(key)) speakerToRole.set(key, r.role);
    }
  }

  // falantes parseados do corpo (determinístico, sem LLM). dedup preservando a ordem de aparição.
  const msgs = parseConversationMessages(body, { fallbackDate: fallbackDate || undefined });
  const seen = new Set<string>();
  const speakers: { name: string; role: Role }[] = [];
  for (const m of msgs) {
    const name = (m.speaker || "").trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const role: Role = selfNames.has(key) ? "self" : speakerToRole.get(key) ?? otherRole;
    // só os que casaram um papel != "other" (conforme contrato do RoleAnchoring.speakers).
    if (role !== "other") speakers.push({ name, role });
  }

  const block = buildBlock(ctx, selfSlug, speakers);
  return { selfSlug, speakers, otherRole, block };
}

/** Monta o `block` por partes (cada parte só aparece se houver dado). Vazio só não acontece aqui —
 *  o caller já garantiu self.slug != "". Texto = CONTRATO da DESIGN-SPEC §1.1 (genérico, tenant-neutro). */
function buildBlock(ctx: BrainContext, selfSlug: string, speakers: { name: string; role: Role }[]): string {
  const selfLabel = (ctx.self?.label || "").trim() || selfSlug;
  const lines: string[] = [];
  lines.push("CONTEXTO DESTE BRAIN (config do tenant — prioritário p/ ancoragem):");
  lines.push(
    `- SELF (o dono/sujeito recorrente): ${selfLabel} (slug canônico: ${selfSlug}). ` +
      `Métricas, ofertas, preços e atributos DO SELF ancoram em entity="${selfSlug}".`,
  );
  if (speakers.length) {
    const parts = speakers.map((s) => `"${s.name}" = ${roleLabel(ctx, s.role) || s.role}`);
    lines.push(`- PAPÉIS nesta fonte: ${parts.join("; ")}.`);
  }
  lines.push(
    `- REGRA DE ANCORAGEM: o número/atributo que um falante afirma sobre SI MESMO ou sobre a ORGANIZAÇÃO DELE ` +
      `ancora na ENTIDADE do papel desse falante — NÃO no self e NÃO em quem fala. Ex.: o faturamento que o ` +
      `CLIENTE relata é fato do CLIENTE (entity = slug do cliente), não do self. O preço/oferta que o SELF ` +
      `cota é fato do self (entity="${selfSlug}").`,
  );
  const purpose = (ctx.purpose || "").trim();
  if (purpose) lines.push(`- PROPÓSITO do brain: ${purpose}`);
  return "\n\n" + lines.join("\n");
}
