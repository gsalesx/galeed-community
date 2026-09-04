/** Pricing de IA — preço por modelo (USD por 1M tokens) + cálculo de custo. PURO (sem I/O, sem DB).
 *  Fonte da verdade do custo: a `usage` REAL devolvida pelos providers (Anthropic/OpenAI), não estimativa.
 *
 *  Versionado: quando a tabela de preço do provider mudar, atualizar aqui (e o histórico já gravado em
 *  galeed_llm_usage guarda o cost_usd da época — não se recalcula retroativamente). Valores em USD/1M tok.
 *  Referências (públicas, 2025/2026): Anthropic Claude 4.x; OpenAI embeddings; Voyage rerank. */

export interface Rate {
  /** USD por 1M tokens de input (prompt). */
  input: number;
  /** USD por 1M tokens de output (geração). 0 p/ embeddings/rerank. */
  output: number;
  /** USD por 1M tokens lidos do cache de prompt (~0.1× input na Anthropic). */
  cacheRead?: number;
  /** USD por 1M tokens escritos no cache de prompt (~1.25× input na Anthropic). */
  cacheWrite?: number;
}

/** Tabela de preço por família de modelo. A resolução é por SUBSTRING (ver `rateFor`) pra tolerar
 *  sufixos de data/versão (claude-haiku-4-5-20251001, claude-sonnet-4-5-20250929, etc). */
export const MODEL_PRICING: Record<string, Rate> = {
  // Anthropic Claude (USD/1M)
  "claude-opus": { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  "claude-sonnet": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-haiku": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  // OpenAI embeddings (USD/1M; só input)
  "text-embedding-3-small": { input: 0.02, output: 0 },
  "text-embedding-3-large": { input: 0.13, output: 0 },
  // OpenAI chat curto (HyDE/query-expansion)
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  // Voyage rerank (USD/1M tokens processados)
  "rerank": { input: 0.05, output: 0 },
};

/** Fallback conservador quando o modelo não casa nenhuma chave (registra o custo sem zerar). */
export const DEFAULT_RATE: Rate = { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 };

/** Resolve a tarifa de um modelo por substring (tolerante a sufixo de versão/data). */
export function rateFor(model: string): Rate {
  const m = (model || "").toLowerCase();
  // ordem importa: chaves mais específicas primeiro (embedding/gpt/rerank antes das de claude)
  for (const key of [
    "text-embedding-3-small",
    "text-embedding-3-large",
    "gpt-4o-mini",
    "rerank",
    "claude-opus",
    "claude-sonnet",
    "claude-haiku",
  ]) {
    if (m.includes(key)) return MODEL_PRICING[key];
  }
  return DEFAULT_RATE;
}

export interface TokenUsage {
  tokensIn: number;
  tokensOut: number;
  /** tokens lidos do cache de prompt (Anthropic prompt caching). */
  cacheRead?: number;
  /** tokens escritos no cache de prompt. */
  cacheWrite?: number;
}

/** Custo em USD a partir da usage REAL e do modelo. Cache read/write cobrados às suas tarifas; o
 *  `tokensIn` aqui é o input NÃO-cacheado (a Anthropic reporta input_tokens já SEM os de cache). */
export function costUsd(model: string, u: TokenUsage): number {
  const r = rateFor(model);
  const cr = r.cacheRead ?? r.input;
  const cw = r.cacheWrite ?? r.input;
  return (
    (u.tokensIn * r.input +
      u.tokensOut * r.output +
      (u.cacheRead ?? 0) * cr +
      (u.cacheWrite ?? 0) * cw) /
    1_000_000
  );
}
