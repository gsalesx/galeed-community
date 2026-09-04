/** M24-A — entrada ÚNICA do signal-engine. O M24-D (sono no worker) chama isto no idle;
 *  o M24-C (reflexão-v2) verbaliza o retorno. Zero LLM aqui dentro (LEI I do BRIEF).
 *  Parse de env (ex.: K vindo de GALEED_SONO_K) é responsabilidade do CHAMADOR (M24-D) —
 *  este módulo só aceita config explícita (testabilidade + zero env mágica no core). */
import { resolveSignalConfig, type RankedSignal, type SignalConfigPatch } from "./types.ts";
import { loadSignalInputs } from "./load.ts";
import { detectTendencia } from "./d1-tendencia.ts";
import { detectSilencio } from "./d2-silencio.ts";
import { detectCompromissoVencido } from "./d3-compromisso.ts";
import { prioritizeSignals } from "./prioritizer.ts";

export async function detectSignals(
  home: string,
  opts: { now?: Date; config?: SignalConfigPatch } = {},
): Promise<RankedSignal[]> {
  const cfg = resolveSignalConfig(opts.config);
  const inputs = await loadSignalInputs(home, opts.now);
  const sinais = [
    ...detectTendencia(inputs, cfg),
    ...detectSilencio(inputs, cfg),
    ...detectCompromissoVencido(inputs, cfg),
  ];
  return prioritizeSignals(sinais, inputs, cfg, opts.now);
}

export * from "./types.ts";
export { loadSignalInputs } from "./load.ts";
export { detectTendencia, olsFit, cusumTripIndex, diaUtc } from "./d1-tendencia.ts";
export { detectSilencio, medianaInferior, medianaMad } from "./d2-silencio.ts";
export { detectCompromissoVencido } from "./d3-compromisso.ts";
export { prioritizeSignals, recencia, salienceDe } from "./prioritizer.ts";
