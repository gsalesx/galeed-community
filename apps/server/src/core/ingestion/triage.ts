/** STAGE 0 — TRIAGEM (M15/S1, ADR-009): o PORTEIRO determinístico, GENÉRICO, custo zero.
 *  Decide, ANTES do LLM, o que merece a chamada de extração — "a chamada mais barata é a que não se
 *  faz" (invariante II do M15). É a aplicação à EXTRAÇÃO do princípio 5 de `classify.ts` ("crava o óbvio
 *  barato, escala só o ambíguo"), com a MESMA mecânica de resolução de `channels.ts::resolveChannel`.
 *
 *  A LEI (invariante III — o que o fundador trava): UM motor genérico (`scoreSegment`) + perfis como
 *  DADO. NENHUM sinal conhece "whatsapp"/"email"/etc. Detectar ruído (emoji-only, "kkkk", saudação) é
 *  remoção de baixa-informação GENÉRICA expressa como regra de CONFIG (NOISE_RULES por id) — nunca
 *  `if (formato === whatsapp)`. Isso é o que evita ressuscitar o `whatsapp-zip.ts` (invariante #9).
 *
 *  PURA e SÍNCRONA: `scoreSegment(input, profile)` não toca LLM/IO/env/Date.now/Math.random. A leitura
 *  de config (async/DB) fica em `resolveTriageProfile`, chamada 1× por página. Fail-open: brain novo /
 *  sem config / tipo desconhecido → conservador (default genérico, corta só o ruído inequívoco); a
 *  resolução NUNCA lança. Ver docs/adr/ADR-009-triagem-generica-perfis-dado.md. */

import { loadSchemaPackAsync } from "../extraction/schema-pack.ts";

// =====================================================================================================
// Tipos (contrato de NOMES EXATOS — S2/S3/S4 importam, não traduzem; ver DESIGN-SPEC §0).
// =====================================================================================================

/** Sinais UNIVERSAIS de densidade de informação. NENHUM conhece formato (whatsapp/email/…). */
export type TriageSignal =
  | "number"       // tem número/moeda/%/quantidade (regex universal de dígito/símbolo monetário)
  | "date"         // tem data/timestamp resolvível (Date.parse de um token, ISO, dd/mm, etc.)
  | "entity"       // menciona uma entityHint conhecida do brain (match case-insensitive)
  | "assertion"    // é asserção declarativa OU pergunta (tem verbo/"?", não é só interjeição)
  | "tokenDensity" // razão de tokens substantivos vs ruído (pontuação/emoji/risada) acima de um piso
  | "length";      // corpo acima do comprimento mínimo (minTokens)

/** Knobs de triagem de um (canal, tipo). DADO. Resolvido DB > seed > default-genérico. */
export interface TriageProfile {
  signalWeights: Record<TriageSignal, number>; // peso de cada sinal (soma normalizada → score 0..1)
  threshold: number;                            // score mínimo p/ worthy (conservador no default)
  minTokens: number;                            // piso de tokens p/ não ser ruído curto
  noiseRules: string[];                         // ids de NOISE_RULES ATIVAS (genéricas: empty/emojiOnly/laugh/greeting)
}

export interface TriageInput {
  text: string;          // corpo do segmento (unit.body) — o que vai (ou não) pro LLM
  entityHints: string[]; // entidades conhecidas do brain (de extract.entityHints) — alimenta o sinal "entity"
  channel: string;       // job.source normalizado — SÓ p/ RESOLVER perfil (nunca ramifica o algoritmo)
  type: string;          // page.type / classify.tipo — SÓ p/ RESOLVER perfil
  confident: boolean;    // classify.confident — false ⇒ perfil GENÉRICO (disciplina 1 do BRIEF §5)
}

export interface TriageVerdict {
  worthy: boolean;   // true ⇒ vale a chamada LLM
  score: number;     // 0..1 (soma ponderada normalizada dos sinais disparados)
  signals: string[]; // sinais disparados + perfil aplicado (auditável; espelha classify.signals)
  profile: string;   // "default" | "<canal>:<tipo>" — id do perfil resolvido
}

/** Perfil com o id resolvido embutido (interno; o id é só p/ auditoria/signals, não muda o algoritmo). */
type ResolvedProfile = TriageProfile & { __id?: string };

// =====================================================================================================
// Default GENÉRICO conservador (DESIGN-SPEC §3). Ponto de partida; sobe por config/tipo PROVADO no gate.
// =====================================================================================================

/** Default GENÉRICO conservador — fail-open. Exportado p/ o gate e p/ resolveTriageProfile.
 *  Conservador: só corta o ÓBVIO ruído (vazio, só-emoji, ≤minTokens, zero número/entidade/asserção). */
export const DEFAULT_TRIAGE_PROFILE: TriageProfile = {
  signalWeights: { number: 0.30, entity: 0.30, date: 0.15, assertion: 0.15, tokenDensity: 0.07, length: 0.03 },
  threshold: 0.20,                 // BAIXO ⇒ conservador: quase tudo passa; só ruído puro cai
  minTokens: 4,                    // ≤4 tokens sem número/entidade = candidato a ruído
  noiseRules: ["empty", "emojiOnly", "laugh", "greeting"],
};

// =====================================================================================================
// NOISE_RULES — regras de baixa-informação GENÉRICAS (não "regras de WhatsApp"). Cada uma é um id +
// um predicado puro sobre o TEXTO. Detectam ruído inequívoco em QUALQUER domínio/idioma latino básico.
// =====================================================================================================

/** Emoji / símbolo / pontuação (faixas Unicode comuns de emoji + pictogramas). Genérico, sem formato. */
const EMOJI_RE =
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{1F1E6}-\u{1F1FF}\u{200D}\u{2122}\u{2139}\u{23E9}-\u{23FA}\u{25AA}-\u{25FE}]/gu;

/** Risada repetida (qualquer idioma latino): "kkkk", "hahaha", "rsrs", "hehe", "huehue". GENÉRICO. */
const LAUGH_RE = /^(?:k{3,}|(?:ha){2,}h?|(?:he){2,}h?|(?:rs){1,}|(?:hue){2,}|kk+)$/i;

/** Saudações/agradecimentos curtos e isolados (PT + universais curtos). SÓ ruído quando sem sinal forte. */
const GREETING_RE =
  /^(?:oi+|ol[áa]|e[ai]+|bom\s+dia|boa\s+tarde|boa\s+noite|obrigad[oa]+|valeu|vlw|ok+|okay|blz|beleza|tchau|at[ée]\s+mais|abra[çc]o[s]?|falou|fmz|tmj|isso|sim|n[ãa]o|nao|certo|combinado|perfeito|👍|joia|jóia)[\s!.…]*$/i;

/** Catálogo de regras de ruído por id. PURO. Cada predicado recebe só o texto + tokens — NUNCA o canal. */
const NOISE_RULES: Record<string, (text: string, tokens: string[]) => boolean> = {
  empty: (text) => text.trim().length === 0,
  emojiOnly: (text) => {
    const stripped = text.replace(EMOJI_RE, "").replace(/[\s\p{P}\p{S}]/gu, "");
    return text.trim().length > 0 && stripped.length === 0;
  },
  laugh: (text) => LAUGH_RE.test(text.trim()),
  greeting: (text) => GREETING_RE.test(text.trim()),
};

/** Bate alguma noiseRule ATIVA do perfil? (id desconhecido é ignorado — fail-open). */
function matchNoiseRules(text: string, tokens: string[], active: string[]): string[] {
  const hit: string[] = [];
  for (const id of active) {
    const rule = NOISE_RULES[id];
    if (rule && rule(text, tokens)) hit.push(id);
  }
  return hit;
}

// =====================================================================================================
// Helpers UNIVERSAIS de sinal (todos puros; NENHUM recebe channel/formato).
// =====================================================================================================

/** Tokeniza por espaço/pontuação. Universal. */
function tokenize(text: string): string[] {
  return text
    .split(/[\s]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/** Tem número/moeda/%/quantidade? Dígito OU símbolo monetário/percentual. */
function hasNumber(text: string): boolean {
  return /\d/.test(text) || /[%$€£¥]/.test(text) || /R\$/.test(text);
}

/** Tem data/timestamp resolvível? dd/mm[/aaaa], ISO YYYY-MM-DD, HH:MM, ou mês por extenso (PT/EN). */
function hasDate(text: string): boolean {
  if (/\b\d{1,2}[/\-.]\d{1,2}(?:[/\-.]\d{2,4})?\b/.test(text)) return true; // 12/03, 12-03-2026
  if (/\b\d{4}-\d{2}-\d{2}\b/.test(text)) return true;                       // ISO
  if (/\b\d{1,2}:\d{2}(?::\d{2})?\b/.test(text)) return true;                // HH:MM
  // mês por extenso (PT/EN) — âncora temporal universal mesmo sem dígito ("em janeiro", "March").
  if (
    /\b(?:janeiro|fevereiro|mar[çc]o|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro|january|february|march|april|june|july|august|september|october|november|december)\b/i.test(
      text,
    )
  )
    return true;
  return false;
}

/** Menciona uma entityHint conhecida do brain? Match case-insensitive de palavra. Genérico. */
function mentionsEntity(text: string, hints: string[]): boolean {
  if (!hints || hints.length === 0) return false;
  const lower = text.toLowerCase();
  for (const h of hints) {
    const ent = (h || "").toLowerCase().trim();
    if (ent.length >= 2 && lower.includes(ent)) return true;
  }
  return false;
}

/** Cópulas/auxiliares curtas (PT+EN, latim básico). Universal — não é vocabulário de domínio. */
const COPULAS = new Set([
  "é", "e", "foi", "será", "sera", "são", "sao", "está", "esta", "estão", "estao",
  "tem", "têm", "tinha", "houve", "há", "ha", "fez", "faz", "vai", "vamos", "fica", "ficou",
  "is", "are", "was", "were", "has", "have", "had", "will", "did", "does", "be",
]);

/** É asserção declarativa OU pergunta? Termina em "?" OU tem um verbo plausível (heurística genérica). */
function isAssertionOrQuestion(text: string, tokens: string[]): boolean {
  if (/\?/.test(text)) return true;
  // Verbo plausível: terminações verbais comuns PT (-ar/-er/-ir/-ou/-mos/-ado/-ido/-am/-ção) OU
  // um conjunto pequeno e universal de cópulas/auxiliares. Genérico (latim básico), sem domínio.
  for (const raw of tokens) {
    const t = raw.toLowerCase().replace(/[^\p{L}]/gu, "");
    if (t.length === 0) continue;
    // cópulas/auxiliares curtas (inclui as de 1 letra: "é", "e", "vai", "há").
    if (COPULAS.has(t)) return true;
    if (t.length < 2) continue;
    if (/(?:ar|er|ir|ou|mos|ado|ido|am|ndo|ção|cao|ram|sse|ará|erá|irá)$/u.test(t)) return true;
  }
  return false;
}

/** Conta tokens substantivos (não-pontuação, não-emoji, não-risada). Universal. */
function substantiveTokens(tokens: string[]): number {
  let n = 0;
  for (const raw of tokens) {
    const stripped = raw.replace(EMOJI_RE, "").replace(/[\p{P}\p{S}]/gu, "");
    if (stripped.length < 2) continue;            // pontuação/emoji isolado → ruído
    if (LAUGH_RE.test(stripped)) continue;        // risada → ruído
    n++;
  }
  return n;
}

/** Densidade de tokens substantivos vs ruído (pontuação/emoji/risada). Razão 0..1. Universal. */
function tokenDensity(text: string, tokens: string[]): number {
  if (tokens.length === 0) return 0;
  return substantiveTokens(tokens) / tokens.length;
}

const TOKEN_DENSITY_FLOOR = 0.5; // piso: ≥50% dos tokens são substantivos
const MIN_SUBSTANTIVE = 2;       // 1 token isolado não é "denso" (fragmento) — pede ≥2 substantivos

// =====================================================================================================
// scoreSegment — o algoritmo GENÉRICO (DESIGN-SPEC §1). PURO. Sem ramo por formato.
// =====================================================================================================

/** PURA e SÍNCRONA: scoreia um segmento com o perfil JÁ resolvido (2º arg). Mesmo input → mesmo verdict.
 *  Salvaguarda de recall POR CONSTRUÇÃO (gate #4): segmento com sinal `number` OU `entity` é SEMPRE
 *  worthy — a triagem NUNCA pula um segmento de call de venda (preço/cliente/métrica). */
export function scoreSegment(input: TriageInput, profile: TriageProfile): TriageVerdict {
  const p = profile as ResolvedProfile;
  const text = input.text ?? "";
  const tokens = tokenize(text);

  // 1) NOISE GATE (barato): regras de baixa-informação genéricas ATIVAS no perfil.
  const noiseHits = matchNoiseRules(text, tokens, profile.noiseRules ?? []);

  // 2) SINAIS UNIVERSAIS → score ponderado.
  const subst = substantiveTokens(tokens);
  const fired: TriageSignal[] = [];
  if (hasNumber(text)) fired.push("number");
  if (hasDate(text)) fired.push("date");
  if (mentionsEntity(text, input.entityHints)) fired.push("entity");
  // asserção/densidade só contam com ≥MIN_SUBSTANTIVE tokens substantivos — 1 fragmento isolado
  // ("header", "Responder") não é asserção informativa nem "denso". Pergunta ("?") sempre conta
  // (é informativa por si). Universal (não conhece formato).
  if (/\?/.test(text) || (subst >= MIN_SUBSTANTIVE && isAssertionOrQuestion(text, tokens))) fired.push("assertion");
  if (subst >= MIN_SUBSTANTIVE && tokenDensity(text, tokens) >= TOKEN_DENSITY_FLOOR) fired.push("tokenDensity");
  if (tokens.length >= (profile.minTokens ?? 0)) fired.push("length");

  // score = soma ponderada normalizada pela soma TOTAL dos pesos (0..1, estável p/ qualquer perfil).
  const weights = profile.signalWeights ?? ({} as Record<TriageSignal, number>);
  let totalWeight = 0;
  for (const w of Object.values(weights)) totalWeight += w > 0 ? w : 0;
  let raw = 0;
  for (const s of fired) raw += weights[s] ?? 0;
  const score = totalWeight > 0 ? Math.min(1, Math.max(0, raw / totalWeight)) : 0;

  // 3) VEREDITO (fail-open).
  // SALVAGUARDA: number OU entity ⇒ SEMPRE worthy (protege o golden M9: call de venda nunca é cega).
  const hasStrongSignal = fired.includes("number") || fired.includes("entity");
  const isNoise = noiseHits.length > 0 && !hasStrongSignal;
  // pula só quando: é ruído inequívoco E o score não bate o limiar. Senão worthy.
  const worthy = hasStrongSignal || (!isNoise && score >= profile.threshold);

  const profileId = p.__id ?? "default";
  const signals: string[] = [
    ...fired,
    ...noiseHits.map((id) => `noise:${id}`),
    `profile:${profileId}`,
  ];

  return { worthy, score, signals, profile: profileId };
}

// =====================================================================================================
// resolveTriageProfile — espelha resolveChannel + getBrainContext (DESIGN-SPEC §2). NUNCA lança.
// Precedência: DB (SchemaPack.triage por brain) > seed > DEFAULT_TRIAGE_PROFILE. Mais-específico-vence.
// =====================================================================================================

/** lowercase+trim (igual resolveChannel). */
function norm(s: string): string {
  return (s || "").toLowerCase().trim();
}

/** Merge de um Partial<TriageProfile> sobre a base; signalWeights faz shallow-merge (override por sinal). */
function merge(base: ResolvedProfile, partial: Partial<TriageProfile>, id: string): ResolvedProfile {
  return {
    ...base,
    ...partial,
    signalWeights: { ...base.signalWeights, ...(partial.signalWeights ?? {}) },
    __id: id,
  };
}

/** Resolve o perfil (canal,tipo) — async porque lê o SchemaPack (DB-native). NUNCA lança (fail-open).
 *  Mais-específico-vence: override "default" do tenant sempre que existir; "<canal>:<tipo>" SÓ quando
 *  classify.confident (disciplina 1 do BRIEF §5 — não arrisca perfil errado que derruba fato). */
export async function resolveTriageProfile(
  home: string,
  channel: string,
  type: string,
  confident: boolean,
): Promise<TriageProfile> {
  let profile: ResolvedProfile = { ...DEFAULT_TRIAGE_PROFILE, __id: "default" };
  try {
    const pack = await loadSchemaPackAsync(home); // DB > pack-env > vazio (M13). Fail-soft (nunca lança).
    const profiles = pack.triage?.profiles ?? {};
    // override genérico do brain ("default" no pack do tenant), se existir.
    if (profiles.default) profile = merge(profile, profiles.default, "default");
    // override específico SÓ quando confident.
    if (confident) {
      const key = `${norm(channel)}:${norm(type)}`;
      if (profiles[key]) profile = merge(profile, profiles[key], key);
    }
  } catch {
    /* fail-open: sem DB/erro → DEFAULT_TRIAGE_PROFILE (NUNCA lança) */
  }
  return profile;
}
