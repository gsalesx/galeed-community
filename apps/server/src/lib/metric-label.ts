/** Canonicaliza o LABEL de uma métrica para snake_case estável (M9/S1).
 *  Tenant-neutro: seed MÍNIMO e GERAL (não embute vocabulário de um negócio). O tenant inventa
 *  métrica sem code change — labels desconhecidos caem no fallback lowercase+underscore.
 *  Ver docs/adr/ADR-002-tenant-neutralidade.md. */

/** Seed mínimo: só sinônimos universais óbvios. NÃO adicionar termos de um domínio específico aqui —
 *  isso é trabalho do schema-pack do tenant (S4). */
export const METRIC_NORMALIZATION_MAP: Record<string, string> = {
  preço: "preco",
  preco: "preco",
  price: "preco",
  valor: "preco",
  custo: "preco",
  cost: "preco",
  mrr: "mrr",
  arr: "arr",
  receita: "receita",
  revenue: "receita",
};

/** Normaliza um label cru → snake_case canônico. Desconhecido → lowercase + espaços→underscore. */
export function normalizeMetricLabel(raw: string | undefined | null): string {
  const s = (raw ?? "").toLowerCase().trim();
  if (!s) return "";
  if (METRIC_NORMALIZATION_MAP[s]) return METRIC_NORMALIZATION_MAP[s];
  return s.replace(/[^\p{L}\p{N}]+/gu, "_").replace(/^_+|_+$/g, "");
}
