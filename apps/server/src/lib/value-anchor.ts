/** Ancoragem VERBATIM do valor numérico (M9/S3, anti-alucinação dura do número). Puro, sem IO.
 *  Princípio (ADR-003): número que não aparece literalmente na fonte NÃO vira fato — degrada p/
 *  passagem. Complementa o quoteIsGrounded textual (M4, fuzzy 70%) SEM substituí-lo.
 *
 *  Vai ALÉM do gbrain: o gbrain (references/gbrain/src/core/facts-fence.ts) só DECLARA no prompt
 *  "evidence_quote MUST be a verbatim substring of the page body" — sem enforcement por código.
 *  Aqui o predicado é VERIFICADO: substring numérica em alguma grafia plausível ou rebaixa.
 *
 *  Retorna true (ancorado) quando:
 *   - o claim NÃO tem número (valueNum==null e `value` sem dígito) → este check não se aplica; ou
 *   - o número do claim aparece no body em ALGUMA grafia equivalente (dígitos, milhar com . ou ,,
 *     "k"/"mil"/"M"/"milhões", percentual).
 *  Retorna false (rebaixar) quando há número no claim mas NENHUMA grafia equivalente está no body. */
export function valueIsAnchored(value: string, valueNum: number | null, body: string): boolean {
  const hasNumber = valueNum != null || /\d/.test(value || "");
  if (!hasNumber) return true; // claim textual — fora do escopo deste check

  const b = (body || "").toLowerCase();

  // (a) caminho barato: a grafia ORIGINAL do value aparece literal no body?
  const vRaw = (value || "").toLowerCase().trim();
  if (vRaw && b.includes(vRaw)) return true;
  // tenta também a parte numérica crua do value (sem moeda/sufixo)
  const vDigits = vRaw.replace(/[^\d.,]/g, "");
  if (vDigits.length >= 1 && b.includes(vDigits)) return true;

  // (b) caminho semântico: gerar as grafias canônicas do número-alvo e procurar cada uma no body.
  const target = valueNum != null ? valueNum : parseFloatLoose(value);
  if (target == null || !Number.isFinite(target)) {
    // tem dígito mas não deu p/ extrair número → ser permissivo (não inventa rejeição)
    return true;
  }
  for (const form of numberSurfaceForms(target)) {
    if (form && b.includes(form)) return true;
  }

  // (c) número por EXTENSO pt-BR (achado criacao-de-fatos #6): "o prazo é de trinta dias" ancora
  // value_num=30 — antes rebaixava claim com quote perfeita só porque a fonte escreveu por extenso.
  // Fronteira de PALAVRA obrigatória (NUNCA includes cru: "dez"⊂"dezembro", "cem"⊂"recém" criariam
  // âncora falsa e furariam a cerca ADR-003): tokeniza o body com o MESMO separador do quote-check
  // e casa cada forma (inclusive compostas, "cem mil") no corpo re-join com espaços normalizados.
  const words = numberWordForms(target);
  if (words.length) {
    const joined = ` ${b.split(/[^a-zà-ú0-9]+/i).filter((t) => t.length > 0).join(" ")} `;
    for (const w of words) {
      if (joined.includes(` ${w} `)) return true;
    }
  }
  return false;
}

/** Tabela mínima de extenso pt-BR. n=1 EXCLUÍDO de propósito: "um"/"uma" são artigos onipresentes —
 *  âncora falsa garantida (a exclusão é a guarda anti-alucinação, não preguiça). */
const NUMBER_WORDS: Record<number, string[]> = {
  2: ["dois", "duas"], 3: ["três", "tres"], 4: ["quatro"], 5: ["cinco"], 6: ["seis"],
  7: ["sete"], 8: ["oito"], 9: ["nove"], 10: ["dez"], 11: ["onze"], 12: ["doze"],
  13: ["treze"], 14: ["quatorze", "catorze"], 15: ["quinze"], 16: ["dezesseis"],
  17: ["dezessete"], 18: ["dezoito"], 19: ["dezenove"], 20: ["vinte"],
  30: ["trinta"], 40: ["quarenta"], 50: ["cinquenta", "cinqüenta"], 60: ["sessenta"],
  70: ["setenta"], 80: ["oitenta"], 90: ["noventa"], 100: ["cem"], 1000: ["mil"],
};

/** Formas por EXTENSO pt-BR de um número INTEIRO (achado criacao-de-fatos #6): 2–20 (pares de
 *  gênero dois/duas), dezenas 30–90, "cem", "mil", e composição de magnitude — múltiplo de mil com
 *  k=2..100 na tabela → "<extenso(k)> mil" ("trinta mil", "cem mil"); análogo pra milhão/milhões.
 *  NÃO exaustivo (sem compostos "vinte e três"): cobre as grafias redondas comuns de prazo/preço em
 *  conversa PT-BR. Retorna lowercase; o CALLER é obrigado a casar com fronteira de palavra. */
export function numberWordForms(n: number): string[] {
  if (!Number.isFinite(n) || !Number.isInteger(n)) return [];
  const out: string[] = [...(NUMBER_WORDS[n] ?? [])];
  // composição de milhar: k limitado a 2..100 (k=1000 geraria "mil mil"; k=1 é o artigo excluído).
  if (n >= 2000 && n % 1000 === 0) {
    const k = n / 1000;
    if (k >= 2 && k <= 100) for (const w of NUMBER_WORDS[k] ?? []) out.push(`${w} mil`);
  }
  if (n >= 2_000_000 && n % 1_000_000 === 0) {
    const k = n / 1_000_000;
    if (k >= 2 && k <= 100)
      for (const w of NUMBER_WORDS[k] ?? []) out.push(`${w} milhões`, `${w} milhoes`, `${w} milhão`, `${w} milhao`);
  }
  return out;
}

/** Ancoragem VERBATIM de valor TEXTUAL (achado criacao-de-fatos #5 — simetria com o número no C4):
 *  o gate dava ao NÚMERO um caminho de ancoragem próprio (valor no body via numberSurfaceForms, sem
 *  quote) que o fato QUALITATIVO não tinha — claim textual dependia 100% de o LLM colar a quote e
 *  caía na fila numa taxa estruturalmente maior. Este helper fecha a assimetria: value não-numérico
 *  que aparece VERBATIM (normalizado) no body conta como evidência no lugar da quote ausente.
 *  Guardas anti-coincidência: value normalizado ≥4 chars E ≥1 sequência ALFABÉTICA de ≥4 letras
 *  ("sim"/"ok"/valor só-dígitos NÃO ancoram — dígito sem value_num continua no caminho numérico/C4,
 *  onde substring curta casaria timestamp por acaso). Honestidade epistêmica: negação/contexto NÃO
 *  são checados — exatamente o MESMO nível já aceito pro número ancorado. Puro, sem IO.
 *  Usado nos 3 espelhos do C4 (applyRecipeGate, gateClaimAnchoring, derivePageFacts) — mudou num,
 *  muda nos três JUNTOS (disciplina C4/fix-1). */
export function textValueIsAnchored(value: string, body: string): boolean {
  const norm = (s: string) => (s || "").toLowerCase().replace(/\s+/g, " ").trim();
  const v = norm(value);
  if (v.length < 4) return false;
  if (!/[a-zà-ú]{4,}/i.test(v)) return false; // exige substância alfabética; dígitos não reabrem a porta
  return norm(body).includes(v);
}

/** Parse tolerante: "R$ 30.000,00" → 30000; "5%" → 5; "30 mil" → 30000; "1,2 M" → 1200000.
 *  Reconhece sufixos de magnitude (k/mil, m/mi/milhão/milhões), separadores pt-BR e en, e %. */
export function parseFloatLoose(s: string): number | null {
  let t = (s || "").toLowerCase().trim();
  if (!t) return null;

  // remove moeda e ruído de espaço; preserva dígitos, . , % e letras de sufixo
  t = t.replace(/r\$|reais?|brl|usd|us\$|\$|€/g, " ").trim();

  // detecta sufixo de magnitude (e %): pega a parte numérica + a unidade adjacente
  // sufixos ordenados do MAIS longo p/ o mais curto (alternância casa a 1ª que dá match:
  // "mil" tem de vir antes de "mi"/"m", "milhões" antes de "mi", etc.)
  // 1ª alt: grupos de milhar (requer ≥1 separador de 3, ex "30.000"/"1.200.000"); 2ª alt: número
  // plano com decimal opcional ("30000", "0.05", "1,2"). Plano não pode vir 1º senão "30.000"
  // pararia em "30"; a alt de milhar exige separador p/ não engolir "30000" → "300".
  const m = t.match(
    /(-?\d{1,3}(?:[.,]\d{3})+|-?\d+(?:[.,]\d+)?)\s*(milh(?:ões|ão|oes|ao)|milhoes|milhao|mil|mm|mi|k|m|%)?/i,
  );
  if (!m) return null;
  const numRaw = m[1];
  const suffix = (m[2] || "").toLowerCase();

  const base = parseNumericToken(numRaw);
  if (base == null) return null;

  switch (suffix) {
    case "k":
    case "mil":
      return base * 1_000;
    case "m":
    case "mi":
    case "mm":
    case "milhao":
    case "milhão":
    case "milhões":
    case "milhoes":
      return base * 1_000_000;
    case "%":
      return base; // "5%" → 5 (semântica: o número é 5; a ponte 0.05↔5% mora em numberSurfaceForms)
    default:
      return base;
  }
}

/** Converte um token numérico cru ("30.000", "30,000", "2.500,00", "1,2", "0.05") em number.
 *  Heurística pt-BR/en: se há ',' decimal (1-2 casas após a última vírgula) trata '.' como milhar. */
function parseNumericToken(raw: string): number | null {
  let n = raw.trim();
  if (!/\d/.test(n)) return null;

  const hasDot = n.includes(".");
  const hasComma = n.includes(",");

  if (hasDot && hasComma) {
    // o último separador é o decimal
    if (n.lastIndexOf(",") > n.lastIndexOf(".")) {
      // pt-BR: 2.500,00 → milhar '.', decimal ','
      n = n.replace(/\./g, "").replace(",", ".");
    } else {
      // en: 2,500.00 → milhar ',', decimal '.'
      n = n.replace(/,/g, "");
    }
  } else if (hasComma) {
    // só vírgula: decimal pt-BR se 1-2 casas no fim ("1,2" / "0,05"), senão milhar en ("30,000")
    if (/,\d{1,2}$/.test(n)) n = n.replace(/\./g, "").replace(",", ".");
    else n = n.replace(/,/g, "");
  } else if (hasDot) {
    // só ponto: milhar pt-BR se grupos de 3 ("30.000" / "1.200.000"), senão decimal ("0.05")
    if (/^\d{1,3}(\.\d{3})+$/.test(n)) n = n.replace(/\./g, "");
    // caso contrário deixa o '.' como decimal
  }

  const f = parseFloat(n);
  return Number.isFinite(f) ? f : null;
}

/** Formata um número removendo zeros decimais inúteis: 30000 → "30000", 1.2 → "1.2", 0.05 → "0.05". */
function fmt(n: number): string {
  if (Number.isInteger(n)) return String(n);
  // até 6 casas, sem zeros à direita
  return String(parseFloat(n.toFixed(6)));
}

/** Versão com vírgula decimal pt-BR: 1.2 → "1,2"; 30000 → "30000" (inteiro inalterado). */
function fmtComma(n: number): string {
  const s = fmt(n);
  return s.includes(".") ? s.replace(".", ",") : s;
}

/** Insere separador de milhar de grupos de 3 a partir da direita (parte inteira só).
 *  sep="." → "1.200.000"; sep="," → "1,200,000". Aplica só se houver >3 dígitos inteiros. */
function withThousands(n: number, sep: string): string | null {
  if (!Number.isInteger(n) || Math.abs(n) < 1000) return null;
  const neg = n < 0 ? "-" : "";
  const digits = String(Math.abs(n));
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
  return neg + grouped;
}

/** Grafias de superfície de um número, p/ casar contra o body (todas lowercase, sem moeda):
 *  ex.: 30000 → ["30000","30.000","30,000","30 mil","30mil","30k"]; 0.05 → ["0.05","0,05","5%","5 %"];
 *  1200000 → ["1200000","1.200.000","1,2 mi","1.2m","1,2 milhão","1,2 milhões"].
 *  Gera as formas COMUNS pt-BR e en; cobre milhar (. e ,), sufixos k/mil/M/mi/milhão/milhões, e %
 *  quando o número é fração ≤ 1 (0.05 ↔ "5%"). NÃO exaustivo — cobre os casos do golden + outro domínio. */
export function numberSurfaceForms(n: number): string[] {
  if (!Number.isFinite(n)) return [];
  const out = new Set<string>();

  // forma plana (lowercase, sem zeros inúteis)
  out.add(fmt(n));
  out.add(fmtComma(n));

  // separador de milhar (pt usa '.', en usa ',')
  const th = withThousands(n, ".");
  if (th) out.add(th);
  const thEn = withThousands(n, ",");
  if (thEn) out.add(thEn);

  // sufixos de magnitude — milhar
  if (Number.isInteger(n) && Math.abs(n) >= 1000 && n % 1000 === 0) {
    const k = n / 1000;
    out.add(`${fmt(k)} mil`);
    out.add(`${fmt(k)}mil`);
    out.add(`${fmtComma(k)} mil`);
    out.add(`${fmt(k)}k`);
    out.add(`${fmtComma(k)}k`);
  }
  // sufixos de magnitude — milhão (inclui não-múltiplos exatos, ex.: 1.200.000 → "1,2 mi")
  if (Math.abs(n) >= 1_000_000) {
    const mm = n / 1_000_000;
    out.add(`${fmt(mm)} mi`);
    out.add(`${fmtComma(mm)} mi`);
    out.add(`${fmt(mm)}m`);
    out.add(`${fmtComma(mm)}m`);
    out.add(`${fmt(mm)} milhão`);
    out.add(`${fmtComma(mm)} milhão`);
    out.add(`${fmt(mm)} milhões`);
    out.add(`${fmtComma(mm)} milhões`);
    out.add(`${fmt(mm)} milhao`);
    out.add(`${fmtComma(mm)} milhao`);
  }

  // fração 0<n<1 → ponte percentual (0.05 ↔ "5%")
  if (n > 0 && n < 1) {
    const pct = n * 100;
    out.add(`${fmt(pct)}%`);
    out.add(`${fmt(pct)} %`);
    out.add(`${fmtComma(pct)}%`);
    out.add(`${fmtComma(pct)} %`);
  }

  return Array.from(out).filter((s) => s.length > 0);
}
