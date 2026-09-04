/** Resolução do schema de extração por tenant (M9/S4). SUBSTITUI os SCHEMAS hardcoded do extract.ts:
 *  o tenant declara `extractable[type]` no pack; ausente → default GERAL tenant-neutro. ADR-002.
 *
 *  Adaptado do gbrain `src/core/schema-pack/extractable.ts` (extractableSpecsFromPack/getExtractableSpec):
 *  a ideia "o pack declara o que é extraível e suas dims" é a mesma; aqui o pack do Galeed é um JSON
 *  flat com `extractable: Record<type, spec>` (vs. o manifest YAML `page_types[]` do gbrain). O default
 *  GERAL substitui o `gbrain-base` (que preservava os tipos legados) — no Galeed o legado vira PACK. */
import { loadSchemaPack, readPackFile, type ExtractableSpec } from "./schema-pack.ts";

/** Default GERAL (tenant-neutro) quando o pack não declara o tipo. NÃO contém "reunioes"/"preço" —
 *  dims universais de conhecimento de negócio. (Os exemplos de domínio vivem NO PACK, não aqui.)
 *  "action_items" ENTROU no default (achado criacao-de-fatos #8): compromisso é universal de
 *  negócio, não domínio — o exemplo de COMPROMISSO do prompt (extract.ts) aponta pra action_items,
 *  health.ts já declara a curva de decay e o espelho GitHub (github-sync.ts) já monta a seção
 *  'compromissos' desta dim; sem ela no default, o LLM que seguisse o exemplo à letra tinha os
 *  claims DESCARTADOS sem log (extractUnit só lê ctx.dims) e as duas superfícies ficavam mortas em
 *  install limpo. Nota: extrações antigas continuam "frescas" (isFresh compara prompt_version, não
 *  dims) — a dim nova só aparece em páginas novas/re-extraídas. */
export const DEFAULT_EXTRACT_DIMS = ["facts", "decisions", "action_items", "entities", "open_questions", "quotes"];
export const DEFAULT_EXTRACT_DESC = "documento de negócio";

/** Spec do tipo no pack do brain, ou undefined. */
export function getExtractableSpec(home: string, type: string): ExtractableSpec | undefined {
  return loadSchemaPack(home).extractable[type];
}

/** Tipo é extraível por declaração do tenant? (true se há spec; o core sempre extrai algo via default,
 *  mas o S5/gate usa isto p/ saber quais tipos têm fixtures próprias.) */
export function isExtractable(home: string, type: string): boolean {
  return !!getExtractableSpec(home, type);
}

/** Dims de extração do tipo (pack → default geral). */
export function extractableDims(home: string, type: string): string[] {
  const spec = getExtractableSpec(home, type);
  return spec?.eval_dimensions?.length ? spec.eval_dimensions : DEFAULT_EXTRACT_DIMS;
}

/** SEAM do S1 — assinatura EXATA p/ os campos `desc`/`dims` (extract.ts + extract-benchmark.ts já
 *  consomem). `guidance` é ADITIVO (default ""): conteúdo do `prompt_template` do tenant, injetado no
 *  prompt de extração quando o pack declara o tipo. É assim que o DOMÍNIO entra pela config do tenant
 *  (não pelo core) — fecha o gap de o template existir no pack mas nunca chegar ao LLM. Tenant-neutro. */
export function getExtractSchema(home: string, type: string): { desc: string; dims: string[]; guidance: string } {
  const spec = getExtractableSpec(home, type);
  return {
    desc: spec ? `documento do tipo '${type}'` : DEFAULT_EXTRACT_DESC,
    dims: spec?.eval_dimensions?.length ? spec.eval_dimensions : DEFAULT_EXTRACT_DIMS,
    // M13: guidance INLINE (pack do banco, self-contained) tem precedência; senão lê o prompt_template
    // (pack de arquivo, relativo ao pack-root). Assim o gate roda igual com pack do banco OU de env.
    guidance: spec ? (spec.guidance?.trim() || readPackFile(home, spec.prompt_template).trim()) : "",
  };
}
