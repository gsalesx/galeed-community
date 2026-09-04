/** Normalização de valor para COMPARAÇÃO (não exibição) — R6.
 *  Sem isto a supersessão bitemporal acha que "R$ 499", "499" e "R$499,00" são valores DIFERENTES
 *  e mantém crenças concorrentes espúrias. O valor original continua sendo gravado/exibido;
 *  esta função só gera a chave de comparação. */
export function normalizeValue(value: string): string {
  let s = (value || "").toLowerCase().trim();
  s = s.replace(/r\$|reais?|brl|usd|\$|€/g, " ").trim(); // remove moeda
  const compact = s.replace(/\s+/g, "");
  if (/^-?[\d.,]+$/.test(compact) && /\d/.test(compact)) {
    // parece número
    let n = compact;
    if (/,\d{1,2}$/.test(n))
      n = n.replace(/\./g, "").replace(",", "."); // pt-BR: 2.500,00 -> 2500.00
    else n = n.replace(/,/g, ""); // en: 2,500.00 -> 2500.00
    const f = parseFloat(n);
    if (!isNaN(f)) return String(f); // 2500.00 -> "2500"
  }
  return s.replace(/\s+/g, " ").replace(/[.;:!?]+$/, "").trim(); // texto
}
