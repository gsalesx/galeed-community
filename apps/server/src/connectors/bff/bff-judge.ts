/** M25-B/BFF — handlers PUROS do juiz triador (/api/hypotheses/judge[/calibration|/estimate]).
 *  Espelha bff-sources.ts: recebe (home, body), devolve serializável ou lança BffError. Borda fina,
 *  zero lógica: o core (review-judge.ts) decide; aqui só traduz erro pra HTTP legível.
 *
 *  O juiz RECOMENDA, NUNCA decide (invariante #5) — estes handlers não tocam aprovação/descarte. */
import { hasKey } from "../../lib/anthropic.ts";
import {
  judgePending,
  judgeCalibration,
  judgeEstimate,
  type JudgeRunResult,
  type JudgeCalibration,
  type CalibrationSegment,
  type JudgeEstimate,
} from "../../core/ingestion/review-judge.ts";
import { getEngine } from "../../core/platform/engine.ts";
import { BffError } from "./bff-common.ts";

/** POST /api/hypotheses/judge — uma fase do juiz (§2.4). body: { force?: boolean }.
 *  Sem chave → BffError(503). Outro erro do core → BffError(500) legível. */
export async function judgeHandler(home: string, body: { force?: boolean }): Promise<JudgeRunResult> {
  if (!hasKey()) throw new BffError(503, "o juiz precisa de ANTHROPIC_API_KEY no servidor.");
  try {
    return await judgePending(home, { force: !!body?.force });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // sem chave detectada no core (corrida) → 503; demais → 500.
    if (/ANTHROPIC_API_KEY/.test(msg)) throw new BffError(503, "o juiz precisa de ANTHROPIC_API_KEY no servidor.");
    throw new BffError(500, msg);
  }
}

/** GET /api/hypotheses/judge/calibration — JudgeCalibration + nome da fonte resolvido (join em
 *  memória via listSources — MESMO padrão de listHypothesesHandler). */
export async function judgeCalibrationHandler(
  home: string,
): Promise<JudgeCalibration & { segmentos: (CalibrationSegment & { source_name: string })[] }> {
  try {
    const cal = await judgeCalibration(home);
    const e = await getEngine(home);
    const sources = await e.listSources();
    const names = new Map(sources.map((s) => [s.id, s.name]));
    return {
      ...cal,
      segmentos: cal.segmentos.map((s) => ({ ...s, source_name: names.get(s.source_id) ?? "" })),
    };
  } catch (err) {
    throw new BffError(500, err instanceof Error ? err.message : String(err));
  }
}

/** GET /api/hypotheses/judge/estimate — estimativa read-only (zero LLM). */
export async function judgeEstimateHandler(home: string): Promise<JudgeEstimate> {
  try {
    return await judgeEstimate(home);
  } catch (err) {
    throw new BffError(500, err instanceof Error ? err.message : String(err));
  }
}
