/** KILL-SWITCH de custo de LLM por BRAIN (M20+). A ÚNICA chamada cara da borda pública é o /v1/ask
 *  (síntese real do provider). Este módulo decide se o brain JÁ estourou o teto DIÁRIO de custo de LLM
 *  — se sim, o gateway barra NOVAS chamadas com 402 (Payment Required) ANTES de tocar o motor.
 *
 *  TETO: env `GALEED_LLM_DAILY_BUDGET_USD` (default 25). Janela = HOJE em UTC (00:00Z → agora).
 *
 *  OVERSHOOT: o custo da síntese é gravado DEPOIS da chamada (ask.ts) E há micro-cache de 15s, então a
 *  quota só barra quando o acumulado JÁ visível passou do teto. O overshoot real = ~1 chamada + tudo que
 *  couber na janela de 15s do cache (limitado pelo rate-limit por token, 60/min). É um kill-switch que
 *  estanca hemorragia de custo, NÃO um limite transacional exato — aceitável para o objetivo.
 *
 *  CACHE: micro-cache em memória por brain (15s) p/ não bater no DB a cada request (poupa DB sob rajada);
 *  reduzir o TTL aperta o overshoot ao custo de mais queries. */
import { getEngine } from "./engine.ts";

const DEFAULT_DAILY_BUDGET_USD = 25;
const CACHE_TTL_MS = 15_000; // 15s por brain

export interface CostQuotaResult {
  exceeded: boolean;
  current_usd: number;
  limit_usd: number;
  window: "daily";
}

/** teto diário (USD) do env, com default 25. Valor inválido/≤0 cai no default. */
function dailyBudgetUsd(): number {
  const raw = process.env.GALEED_LLM_DAILY_BUDGET_USD;
  if (raw == null || raw === "") return DEFAULT_DAILY_BUDGET_USD;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_DAILY_BUDGET_USD;
}

/** início do dia de HOJE em UTC, em ISO (00:00:00.000Z) — limite inferior da janela diária. */
function startOfUtcDayIso(now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}

// micro-cache: brain → { current_usd acumulado, expira }. Curtíssimo (15s) p/ poupar o DB sob rajada.
const cache = new Map<string, { current: number; expiresAt: number }>();

/** Quota de custo de LLM do brain para HOJE (UTC). `exceeded` = acumulado >= teto. Lê a soma enxuta de
 *  custo (engine.llmCostSince) com micro-cache de 15s por brain. */
export async function checkLlmCostQuota(brain: string): Promise<CostQuotaResult> {
  const limit_usd = dailyBudgetUsd();
  const now = Date.now();
  const hit = cache.get(brain);
  let current_usd: number;
  if (hit && hit.expiresAt > now) {
    current_usd = hit.current;
  } else {
    current_usd = await (await getEngine(brain)).llmCostSince(startOfUtcDayIso());
    cache.set(brain, { current: current_usd, expiresAt: now + CACHE_TTL_MS });
  }
  return { exceeded: current_usd >= limit_usd, current_usd, limit_usd, window: "daily" };
}

/** Invalida o cache (para testes/admin). Sem brain = limpa tudo. */
export function _resetCostQuotaCache(brain?: string): void {
  if (brain) cache.delete(brain);
  else cache.clear();
}
