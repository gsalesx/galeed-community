/** Saúde de memória (M3/S3) — decay de confiança e salience. PURO: zero imports do projeto,
 *  determinístico, injetável `now` p/ teste. O decay é LEITURA (não altera o valor armazenado). */

export interface ConfDecayCfg {
  halfLifeDays: number;
  floor: number;
}

/** Meia-vida da CONFIANÇA por dimensão. Crença/decisão duram; evento/ação somem rápido.
 *  As chaves cobrem as DIMENSÕES REAIS que a extração produz (achado decaimento-lixeira#7):
 *  DEFAULT_EXTRACT_DIMS (extractable.ts) + as dims PT do pack embarcado a360.json — antes,
 *  open_questions/quotes e todo o pack afinado caíam no default 365d, contrariando a intenção
 *  ("evento/ação somem rápido"). A dimensão é gravada CRUA em galeed_facts (sem normalização),
 *  então a chave aqui tem que bater literalmente com o que o extrator emite. */
export const CONF_HALFLIFE: Record<string, ConfDecayCfg> = {
  // dims default do extrator (DEFAULT_EXTRACT_DIMS):
  facts: { halfLifeDays: 540, floor: 0.4 },
  decisions: { halfLifeDays: 540, floor: 0.4 },
  entities: { halfLifeDays: 0, floor: 1.0 }, // identidade não decai
  open_questions: { halfLifeDays: 30, floor: 0.1 }, // "em aberto esperando resposta" — mesma classe de follow_ups_pending
  quotes: { halfLifeDays: 0, floor: 1.0 }, // fala literal é registro histórico: "foi dito" não envelhece
  // dims declaráveis por pack (DIM_SEMANTICS, extract.ts) — só produzidas por packs que as declarem:
  action_items: { halfLifeDays: 30, floor: 0.1 },
  follow_ups_pending: { halfLifeDays: 30, floor: 0.1 },
  objections: { halfLifeDays: 120, floor: 0.2 },
  claims: { halfLifeDays: 365, floor: 0.3 },
  // dims PT do pack embarcado a360.json (o tenant afinado do próprio repo):
  decisoes: { halfLifeDays: 540, floor: 0.4 },
  compromissos: { halfLifeDays: 30, floor: 0.1 },
  objecoes: { halfLifeDays: 120, floor: 0.2 },
  precos: { halfLifeDays: 365, floor: 0.3 },
  relacoes: { halfLifeDays: 0, floor: 1.0 },
  default: { halfLifeDays: 365, floor: 0.3 },
};

function daysOld(date: string, now?: Date): number {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return 0;
  const d = new Date(date + "T00:00:00Z").getTime();
  if (isNaN(d)) return 0;
  const old = Math.floor(((now ?? new Date()).getTime() - d) / 86400000);
  return old > 0 ? old : 0;
}

/** Confiança projetada no tempo. Nunca sobe; clamp [floor, confidence]. hl<=0 → sem decay. */
export function effectiveConfidence(confidence: number, validFrom: string, dimension: string, now?: Date): number {
  const cfg = CONF_HALFLIFE[dimension] ?? CONF_HALFLIFE.default;
  if (cfg.halfLifeDays <= 0) return confidence;
  const old = daysOld(validFrom, now);
  if (old === 0) return confidence;
  const factor = cfg.floor + (1 - cfg.floor) * (cfg.halfLifeDays / (cfg.halfLifeDays + old));
  const eff = confidence * factor;
  return Math.max(Math.min(eff, confidence), cfg.floor * confidence);
}

const REF_FACTS = 8;
const REF_DEGREE = 6;
const ANCHOR = new Set(["pessoas", "clientes", "conceitos"]);
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const lognorm = (x: number, ref: number) => clamp01(Math.log(1 + Math.max(0, x)) / Math.log(1 + ref));

/** Salience [0..1] — "quanto isso importa". Determinístico, log-comprimido. */
export function salienceScore(p: { factCount: number; degree: number; type: string; date: string }, now?: Date): number {
  const old = daysOld(p.date, now);
  const recency = 180 / (180 + old); // meia-vida 180d
  let s = 0.4 * lognorm(p.factCount, REF_FACTS) + 0.4 * lognorm(p.degree, REF_DEGREE) + 0.2 * recency;
  if (ANCHOR.has(p.type)) s += 0.1;
  return clamp01(s);
}
