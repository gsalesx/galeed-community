/** M24-A — priorizador (BRIEF §3-priorizador): score determinístico
 *  score = efeito × recência × salience(entidade) × min(confidence dos fatos-base)
 *  e top-K global (default k=10). É AQUI que mora a eficiência: o teto de custo do ciclo de
 *  sono (M24-C/D) é K, não o tamanho do corpus. Lista vazia É resultado correto (LEI VI). */
import {
  type EntitySalienceInfo,
  type RankedSignal,
  type Signal,
  type SignalConfig,
  type SignalInputs,
} from "./types.ts";
import { salienceScore } from "../health.ts";
import { diaUtc } from "./d1-tendencia.ts";

/** recência [0..1]: meiaVida/(meiaVida + dias desde janela.ate). dias<0 → 1. */
export function recencia(ateIso: string, hoje: string, meiaVidaDias: number): number {
  const dias = diaUtc(hoje) - diaUtc(ateIso);
  if (dias < 0) return 1;
  return meiaVidaDias / (meiaVidaDias + dias);
}

/** salience da entidade via salienceScore (M3, health.ts) sobre EntitySalienceInfo;
 *  entidade ausente do mapa → cfg.salienceDefault. Multi-entidade → MAX entre elas. */
export function salienceDe(
  entities: string[],
  saliences: Map<string, EntitySalienceInfo>,
  cfg: SignalConfig,
  now?: Date,
): number {
  let max = 0;
  let viu = false;
  for (const e of entities) {
    const info = saliences.get(e);
    if (!info) continue;
    viu = true;
    const s = salienceScore({ factCount: info.factCount, degree: info.degree, type: info.role, date: info.firstSeen }, now);
    if (s > max) max = s;
  }
  return viu ? max : cfg.salienceDefault;
}

/** ordena por (score desc, detector asc, resumo asc), atribui rank 1-based e corta em cfg.k. */
export function prioritizeSignals(signals: Signal[], inputs: SignalInputs, cfg: SignalConfig, now?: Date): RankedSignal[] {
  const scored = signals.map((s) => {
    const score =
      s.efeito *
      recencia(s.janela.ate, inputs.hoje, cfg.recenciaMeiaVidaDias) *
      salienceDe(s.entities, inputs.saliences, cfg, now) *
      s.minConfidence;
    return { ...s, score } as RankedSignal;
  });
  scored.sort(
    (a, b) => b.score - a.score || a.detector.localeCompare(b.detector) || a.resumo.localeCompare(b.resumo),
  );
  return scored.slice(0, cfg.k).map((s, i) => ({ ...s, rank: i + 1 }));
}
