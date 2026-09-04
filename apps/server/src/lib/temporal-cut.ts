/** P1-B (mata A3) — recorte temporal EXPLÍCITO da pergunta, em PT, 100% DETERMINÍSTICO (zero
 *  LLM — o grounding por LLM é M23). Gramática FECHADA validada por fixtures reais:
 *    "em março de 2024" | "março de 2024"      → 2024-03
 *    "em março/24" | "mar/2024"                → 2024-03
 *    "em 03/2024"                              → 2024-03   (mm/aaaa; mm/aa NÃO — ambíguo com dd/mm)
 *    "em 2023" | "durante 2023" | "no ano de 2023" → 2023  (ano sozinho EXIGE preposição)
 *  Sem recorte explícito E completo → null (o chamador mantém o comportamento atual — fail-closed).
 *  Pergunta com ≥2 períodos distintos ou ≥2 meses nomeados → null (pergunta composta/faixa = M23).
 *  Mês SEM ano ("em março?") → null (ano implícito é suposição — invariante #9; M23 resolve).
 *  ADR-002: vocabulário de CALENDÁRIO do idioma (mesma classe do DD/MM→ISO do P0-A) — não é
 *  literal de domínio/negócio. */
export interface TemporalCut {
  /** ponto ISO usado na comparação asOf = o ÚLTIMO dia do período: "2024-03" → "2024-03-31",
   *  "2023" → "2023-12-31". Espelha a semântica de PONTO do engine (postgres.ts, facts asOf). */
  asOf: string;
  /** o período no grão pedido: "2023" (ano) | "2024-03" (mês) — vai no header do bloco FATOS. */
  label: string;
  /** o trecho da pergunta que casou (telemetria/testes). */
  matched: string;
}

/** fold interno (mesmo padrão de slug.ts): caixa baixa + remove acentos. */
const fold = (s: string) => s.toLowerCase().normalize("NFD").replace(/\p{M}+/gu, "");

/** MESES (nome completo + abreviação de 3 letras → 1..12). Já em forma FOLDED ("marco"). */
const MONTHS: Record<string, number> = {
  janeiro: 1, jan: 1,
  fevereiro: 2, fev: 2,
  marco: 3, mar: 3,
  abril: 4, abr: 4,
  maio: 5, mai: 5,
  junho: 6, jun: 6,
  julho: 7, jul: 7,
  agosto: 8, ago: 8,
  setembro: 9, set: 9,
  outubro: 10, out: 10,
  novembro: 11, nov: 11,
  dezembro: 12, dez: 12,
};

const MONTH_ALT = Object.keys(MONTHS).join("|");

/** último dia do período, sempre zero-padded YYYY-MM-DD. ano → "YYYY-12-31"; mês → último dia
 *  real (cobre bissexto: 2024-02 → "2024-02-29"). */
function endOfMonth(year: number, month: number): string {
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(last).padStart(2, "0")}`;
}

interface Match {
  label: string;
  asOf: string;
  matched: string;
  monthName?: string; // nome FOLDED do mês, p/ a guarda G1
}

export function temporalCutPt(q: string): TemporalCut | null {
  const f = fold(q);

  // G1: ≥2 NOMES de mês DISTINTOS na pergunta (faixa "de janeiro a março de 2024") → null.
  const namesSeen = new Set<number>();
  const nameRe = new RegExp(`(?<![\\p{L}\\p{N}])(${MONTH_ALT})(?![\\p{L}\\p{N}])`, "gu");
  for (const m of f.matchAll(nameRe)) namesSeen.add(MONTHS[m[1]]);
  if (namesSeen.size >= 2) return null;

  const matches: Match[] = [];

  // R1: <mês> de <aaaa> → mês.
  const r1 = new RegExp(`(?<![\\p{L}\\p{N}])(${MONTH_ALT})\\s+de\\s+(\\d{4})(?![\\p{L}\\p{N}])`, "gu");
  for (const m of f.matchAll(r1)) {
    const mo = MONTHS[m[1]];
    const yr = Number(m[2]);
    matches.push({ label: `${yr}-${String(mo).padStart(2, "0")}`, asOf: endOfMonth(yr, mo), matched: m[0], monthName: m[1] });
  }

  // R2: <mês>/<aa|aaaa> → mês (espaços opcionais em volta da barra; aa → 2000+aa).
  const r2 = new RegExp(`(?<![\\p{L}\\p{N}])(${MONTH_ALT})\\s*/\\s*(\\d{2}|\\d{4})(?![\\p{L}\\p{N}])`, "gu");
  for (const m of f.matchAll(r2)) {
    const mo = MONTHS[m[1]];
    const yr = m[2].length === 2 ? 2000 + Number(m[2]) : Number(m[2]);
    matches.push({ label: `${yr}-${String(mo).padStart(2, "0")}`, asOf: endOfMonth(yr, mo), matched: m[0], monthName: m[1] });
  }

  // R3: <mm>/<aaaa> com mm ∈ 01..12 (zero opcional). Guarda anti-data-completa: (?<!\d/) antes
  // e (?!\s*/) depois — em "12/03/2024" o trecho "03/2024" é parte de uma DATA, não casa.
  const r3 = new RegExp(`(?<![\\p{L}\\p{N}])(?<!\\d/)(\\d{1,2})\\s*/\\s*(\\d{4})(?!\\s*/)(?![\\p{L}\\p{N}])`, "gu");
  for (const m of f.matchAll(r3)) {
    const mo = Number(m[1]);
    if (mo < 1 || mo > 12) continue;
    const yr = Number(m[2]);
    matches.push({ label: `${yr}-${String(mo).padStart(2, "0")}`, asOf: endOfMonth(yr, mo), matched: m[0] });
  }

  // R4: (em|durante|no ano de) <aaaa> com aaaa ∈ 1900..2099 → ano. Ano sem preposição NÃO é recorte.
  const r4 = new RegExp(`(?<![\\p{L}\\p{N}])(?:em|durante|no\\s+ano\\s+de)\\s+(\\d{4})(?![\\p{L}\\p{N}])`, "gu");
  for (const m of f.matchAll(r4)) {
    const yr = Number(m[1]);
    if (yr < 1900 || yr > 2099) continue;
    matches.push({ label: `${yr}`, asOf: `${yr}-12-31`, matched: m[0] });
  }

  // G3: zero matches → null.
  if (!matches.length) return null;

  // G2: ≥2 labels DISTINTOS → null. Mas um match R4 cujo ANO é o mesmo de um match de mês NÃO
  // conta como label distinto (ex.: "março de 2024" produz "2024-03"; um "em 2024" no mesmo q
  // não deve disparar G2). Reduzimos os labels de ano que coincidem com o ano de algum mês.
  const monthYears = new Set(matches.filter((m) => m.label.includes("-")).map((m) => m.label.slice(0, 4)));
  const effective = matches.filter((m) => {
    // ano puro (4 chars) cujo valor coincide com o ano de um mês casado → absorvido.
    if (!m.label.includes("-") && monthYears.has(m.label)) return false;
    return true;
  });
  const labels = new Set(effective.map((m) => m.label));
  if (labels.size >= 2) return null;

  // o vencedor: prefere o grão de MÊS (mais específico) ao ano puro quando ambos sobram.
  const winner = effective.find((m) => m.label.includes("-")) ?? effective[0];
  return { asOf: winner.asOf, label: winner.label, matched: winner.matched };
}
