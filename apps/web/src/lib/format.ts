/** M8/S3 — helpers de formatação PT-BR (datas, números, confiança).
 *  Usam Intl nativo; sem libs. Tolerantes a entrada inválida (devolvem "" / "—"). */

const MESES = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];

function parse(iso: string | number | Date | null | undefined): Date | null {
  if (iso === null || iso === undefined || iso === "") return null;
  const d = iso instanceof Date ? iso : new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

/** Data curta: "12 jun" (sem ano). */
export function fmtDate(iso: string | number | Date | null | undefined): string {
  const d = parse(iso);
  if (!d) return "";
  return `${d.getDate()} ${MESES[d.getMonth()]}`;
}

/** Data completa: "12 de junho de 2026". */
export function fmtDateFull(iso: string | number | Date | null | undefined): string {
  const d = parse(iso);
  if (!d) return "";
  return new Intl.DateTimeFormat("pt-BR", { day: "numeric", month: "long", year: "numeric" }).format(d);
}

/** Tempo relativo PT-BR: "agora", "há 5 min", "há 2 h", "ontem", "há 3 dias", senão data curta. */
export function relativeTime(iso: string | number | Date | null | undefined, now: Date = new Date()): string {
  const d = parse(iso);
  if (!d) return "";
  const diffMs = now.getTime() - d.getTime();
  const future = diffMs < 0;
  const s = Math.abs(diffMs) / 1000;
  const pre = future ? "em " : "há ";

  if (s < 45) return "agora";
  const min = Math.round(s / 60);
  if (min < 60) return `${pre}${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `${pre}${h} h`;
  const days = Math.round(h / 24);
  if (days === 1) return future ? "amanhã" : "ontem";
  if (days < 7) return `${pre}${days} dias`;
  // mais de uma semana → data curta (com ano se for outro ano)
  return d.getFullYear() === now.getFullYear() ? fmtDate(d) : fmtDateFull(d);
}

/** Número com separador de milhar pt-BR: 2418 → "2.418". */
export function fmtNumber(n: number | null | undefined): string {
  if (n === null || n === undefined || isNaN(n)) return "—";
  return new Intl.NumberFormat("pt-BR").format(n);
}

/** Confiança 0..1 → "92%" (clampa fora do intervalo). */
export function fmtConfidence(c: number | null | undefined): string {
  if (c === null || c === undefined || isNaN(c)) return "—";
  const pct = Math.round(Math.min(1, Math.max(0, c)) * 100);
  return `${pct}%`;
}
