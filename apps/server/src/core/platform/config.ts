/** Config do Galeed — env-driven (DB-native). Substitui o antigo galeed.json em arquivo.
 *  Tudo vem do ambiente, com defaults sãos. Carregado de .env pelo entrypoint (cli.ts). */

export interface EmbCfg {
  enabled: boolean;
  model: string;
  dims: number;
}

export interface Config {
  /** id do tenant/empresa — isola as linhas no Postgres (coluna `brain`). */
  brain: string;
  /** provider do LLM: "auto" (prefere a assinatura via CLI), "cli" ou "api". */
  provider: string;
  /** modelo p/ o provider cli (alias, ex.: "haiku"). */
  cliModel: string;
  /** modelo p/ o provider api (id completo). */
  apiModel: string;
  /** M17 — modelo da SÍNTESE (right-size, LEI II). Mais forte que a extração: a resposta é o produto,
   *  1 chamada/pergunta, alto valor. Default recomendado: um Sonnet atual (ex.: claude-sonnet-4-6).
   *  Env GALEED_SYNTH_MODEL. Sem a env, cai no apiModel (não quebra ambiente que não setou). A
   *  EXTRAÇÃO segue no apiModel (Haiku) — só o ask() usa synthModel na chamada de síntese (S2). */
  synthModel: string;
  /** busca semântica (OpenAI). Sem OPENAI_API_KEY, cai pra FTS de qualquer forma. */
  embeddings: EmbCfg;
}

/** Resolve a config do ambiente. `brainOverride` vem do flag --brain (precede a env). */
export function config(brainOverride?: string): Config {
  const apiModel = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";
  return {
    brain: brainOverride || process.env.GALEED_BRAIN || "galeed",
    provider: process.env.GALEED_PROVIDER || "auto",
    cliModel: process.env.GALEED_CLI_MODEL || "haiku",
    apiModel,
    // M17: síntese no modelo certo. Env explícita vence; sem env → fallback ao apiModel (mesmo
    // comportamento de hoje, não quebra). O default Sonnet é POLÍTICA do operador (setar a env);
    // o código não hardcoda um id de Sonnet que pode não existir no ambiente.
    synthModel: process.env.GALEED_SYNTH_MODEL || apiModel,
    embeddings: {
      enabled: process.env.GALEED_EMBED_DISABLED ? false : true,
      model: process.env.GALEED_EMBED_MODEL || "text-embedding-3-small",
      dims: Number(process.env.GALEED_EMBED_DIMS || 1536),
    },
  };
}
