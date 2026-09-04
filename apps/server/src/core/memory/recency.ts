/** Decaimento por recência — multiplicador determinístico do score de retrieve (S1/M2).
 *  Sem LLM, sem IO: função pura de (date, type). "a verdade atual ganha." */

export interface DecayCfg {
  /** meia-vida em dias. 0 = evergreen (não decai, fator sempre 1.0). */
  halfLifeDays: number;
  /** força do decaimento em [0,1]. 0 = sem efeito; 1 = decaimento pleno até o piso. */
  coeff: number;
}

/** Meia-vida por TIPO de fonte. Tipos ausentes caem no `default`. */
export const DECAY_BY_TYPE: Record<string, DecayCfg> = {
  reunioes: { halfLifeDays: 120, coeff: 0.5 },
  notas: { halfLifeDays: 120, coeff: 0.4 },
  decisoes: { halfLifeDays: 365, coeff: 0.3 },
  clientes: { halfLifeDays: 180, coeff: 0.3 },
  conceitos: { halfLifeDays: 0, coeff: 0 }, // evergreen
  produtos: { halfLifeDays: 0, coeff: 0 }, // evergreen
  pessoas: { halfLifeDays: 0, coeff: 0 }, // evergreen
  default: { halfLifeDays: 180, coeff: 0.3 },
};

/** Fator multiplicativo em [1 - coeff, 1]. Evergreen ou data ausente/inválida/futura → 1.0. */
export function recencyFactor(date: string, type: string, now?: Date): number {
  const cfg = DECAY_BY_TYPE[type] ?? DECAY_BY_TYPE.default;
  if (cfg.halfLifeDays <= 0) return 1.0; // evergreen
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return 1.0;
  const d = new Date(date + "T00:00:00Z");
  if (isNaN(d.getTime())) return 1.0;
  const ref = now ?? new Date();
  const daysOld = Math.floor((ref.getTime() - d.getTime()) / 86400000);
  if (daysOld <= 0) return 1.0; // hoje ou futuro → neutro
  const raw = cfg.halfLifeDays / (cfg.halfLifeDays + daysOld);
  return 1 - cfg.coeff * (1 - raw);
}
