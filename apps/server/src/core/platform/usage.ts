/** Registro de custo de IA (M20). Grava CADA chamada de IA (extração, síntese do ask, embeddings,
 *  rerank) em galeed_llm_usage com a `usage` REAL do provider + custo (pricing.ts). É o sink injetado
 *  como `meter` em src/lib/llm.ts e nos clientes de embedding — o caller (core) fecha home+op.
 *
 *  REGRA: custo é OBSERVABILIDADE. `recordUsage` é FAIL-SOFT — uma falha de gravação NUNCA derruba o
 *  caminho do usuário (extração/pergunta); loga e segue. */
import { getEngine } from "./engine.ts";
import { costUsd } from "../../lib/pricing.ts";

export interface UsageEvent {
  /** extract | extract:batch | synthesis | ask:stream | embed | embed:query | rerank | hyde */
  op: string;
  provider: string; // "api" | "cli" | "openai" | "voyage"
  model: string;
  tokensIn: number;
  tokensOut: number;
  cacheRead?: number;
  cacheWrite?: number;
  /** custo já reportado pelo provider (ex.: envelope do `claude` CLI). Quando dado, vence o cálculo. */
  costUsdReported?: number;
  meta?: Record<string, unknown> | null;
}

/** Grava uma chamada de IA. Calcula o custo de pricing.ts quando o provider não reporta. Fail-soft. */
export async function recordUsage(home: string, ev: UsageEvent): Promise<void> {
  try {
    const cost =
      ev.costUsdReported != null
        ? ev.costUsdReported
        : costUsd(ev.model, { tokensIn: ev.tokensIn, tokensOut: ev.tokensOut, cacheRead: ev.cacheRead, cacheWrite: ev.cacheWrite });
    const e = await getEngine(home);
    await e.putLlmUsage({
      brain: home,
      op: ev.op,
      provider: ev.provider,
      model: ev.model,
      tokens_in: ev.tokensIn,
      tokens_out: ev.tokensOut,
      cache_read: ev.cacheRead ?? 0,
      cache_write: ev.cacheWrite ?? 0,
      cost_usd: cost,
      meta: ev.meta ?? null,
    });
  } catch (err) {
    console.error(`[usage] falha ao gravar custo (${ev.op}/${ev.model}):`, (err as Error)?.message ?? err);
  }
}

/** Rollup de custo do brain (totais + por op + por modelo). `sinceIso` opcional filtra por período. */
export async function usageRollup(home: string, sinceIso?: string) {
  const e = await getEngine(home);
  return e.llmUsageRollup(sinceIso);
}

/** Últimas N chamadas de IA do brain (auditoria). */
export async function recentUsage(home: string, limit?: number) {
  const e = await getEngine(home);
  return e.recentLlmUsage(limit);
}
