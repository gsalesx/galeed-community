/** M23-A (S1) — grounding em estágios do ask (BRIEF §3 Peça 1, protocolo MEMO §4.4 adaptado a
 *  retrieval). Detector DETERMINÍSTICO-primeiro decide QUANDO decompor; a decomposição é UMA
 *  chamada Haiku structured/tool_use (padrão do wizard M11-S4 — nunca texto livre parseado à
 *  mão), bounded (≤4 sub-perguntas, zero loop, fail-open). Temporal explícito continua 100%
 *  determinístico: o modelo PRESERVA o trecho verbatim e o temporalCutPt (P1-B) dispara na
 *  sub-pergunta dentro do factsForQuery — o LLM NUNCA devolve datas/asOf. */
import { config } from "../platform/config.ts";
import { resolveProvider, structured, type Provider } from "../../lib/llm.ts";
import { type Tool } from "../../lib/anthropic.ts";
import { recordUsage } from "../platform/usage.ts";

/** fold idêntico ao do matchPredicates (ask.ts)/temporal-cut.ts: caixa baixa + remove acentos. */
const fold = (s: string) => s.toLowerCase().normalize("NFD").replace(/\p{M}+/gu, "");

export type StagedKind = "simples" | "composta" | "ambigua";

const INTERROG = "quantos|quantas|quanto|quais|qual|quem|quando|onde|como|por que|o que";

/** Detector determinístico de pergunta COMPOSTA (texto puro, zero LLM, zero estado).
 *  Sinais (sobre o texto folded; pronomes interrogativos PT = vocabulário do IDIOMA, ADR-002):
 *  D1 — "quando" SUBORDINADO (precedido por outra palavra): "custava X quando Y entrou".
 *       "Quando o Teobaldo entrou?" (quando inicial) NÃO dispara.
 *  D2 — ≥2 pronomes interrogativos: "qual o preço e quem fechou?".
 *  D3 — faixa temporal: ≥2 NOMES de mês distintos ("de janeiro a março de 2024") OU
 *       "de <aaaa> a|até <aaaa>" OU "entre <aaaa> e <aaaa>" (1900..2099).
 *  Qualquer sinal → "composta". Nenhum → "simples". (O grau "ambigua" — 2 entidades
 *  independentes casadas — é decidido pelo ORQUESTRADOR no ask.ts, que tem a lista de
 *  entidades; este módulo não importa matchEntities.) */
export function detectComposite(q: string): "composta" | "simples" {
  const f = fold(q);
  // D1: "quando" subordinado — precedido por palavra (não é o início da pergunta).
  if (/[\p{L}\p{N}][^\p{L}\p{N}]+quando(?![\p{L}\p{N}])/u.test(f)) return "composta";
  // D2: ≥2 pronomes interrogativos (ocorrências, com fronteira de palavra).
  const ints = [...f.matchAll(new RegExp(`(?<![\\p{L}\\p{N}])(${INTERROG})(?![\\p{L}\\p{N}])`, "gu"))];
  if (ints.length >= 2) return "composta";
  // D3: faixa temporal (≥2 meses nomeados, ou faixa de anos com preposição).
  const MESES = "janeiro|jan|fevereiro|fev|marco|mar|abril|abr|maio|mai|junho|jun|julho|jul|agosto|ago|setembro|set|outubro|out|novembro|nov|dezembro|dez";
  const meses = new Set([...f.matchAll(new RegExp(`(?<![\\p{L}\\p{N}])(${MESES})(?![\\p{L}\\p{N}])`, "gu"))].map((m) => m[1]));
  if (meses.size >= 2) return "composta";
  if (/(?<![\p{L}\p{N}])(?:de|entre)\s+(19|20)\d{2}\s+(?:a|ate|e)\s+(19|20)\d{2}(?![\p{L}\p{N}])/u.test(f)) return "composta";
  return "simples";
}

/** Entidades INDEPENDENTES de uma lista casada: remove as redundantes por sobreposição de
 *  tokens — se tokens(A) ⊆ tokens(B) (tokens = split /[_\s]+/, len>2, folded), A é alias/
 *  refinamento de B e conta como UMA ("accelera" vs "accelera 360"). Empate de tokens iguais →
 *  mantém a lexicograficamente menor. Determinística, exportada p/ teste. */
export function independentEntities(entities: string[]): string[] {
  const toks = (e: string) => new Set(fold(e).split(/[_\s]+/).filter((t) => t.length > 2));
  const subset = (a: Set<string>, b: Set<string>) => [...a].every((t) => b.has(t));
  return entities.filter((e, i) => {
    const te = toks(e);
    return !entities.some((o, j) => {
      if (i === j) return false;
      const to = toks(o);
      const eIsSub = subset(te, to);
      const oIsSub = subset(to, te);
      if (eIsSub && !oIsSub) return true; // e ⊂ o → e é redundante
      if (eIsSub && oIsSub) return j < i; // tokens iguais → sobrevive o primeiro (ordem estável)
      return false;
    });
  });
}

/** resultado da decomposição (bounded). */
export interface Grounding {
  /** 2..4 sub-perguntas atômicas, auto-contidas, na ordem devolvida pelo modelo. */
  subs: string[];
}

const GROUND_TOOL = {
  name: "decompor_pergunta",
  description:
    "Decide se a pergunta é COMPOSTA (precisa de mais de um fato independente pra ser " +
    "respondida) e, se for, a decompõe em sub-perguntas atômicas e auto-contidas.",
  input_schema: {
    type: "object",
    properties: {
      composta: { type: "boolean", description: "true se a pergunta precisa de 2+ fatos independentes" },
      sub_perguntas: {
        type: "array",
        items: { type: "string" },
        description:
          "2 a 4 sub-perguntas atômicas. Cada uma auto-contida (nomeia a entidade pelo nome) e " +
          "preservando VERBATIM qualquer recorte temporal explícito da pergunta original.",
      },
    },
    required: ["composta", "sub_perguntas"],
  },
} as const;

const GROUND_SYSTEM =
  "Você decompõe uma pergunta COMPOSTA sobre a memória de longo prazo de uma empresa em " +
  "sub-perguntas ATÔMICAS (cada uma respondível por UM fato). Regras: cada sub-pergunta é " +
  "AUTO-CONTIDA — nomeia a entidade pelo nome, nunca 'ele', 'ela' ou 'isso'; preserve VERBATIM " +
  "qualquer recorte temporal explícito da pergunta original (ex.: 'em março de 2024' permanece " +
  "idêntico na sub-pergunta); NÃO responda às perguntas; NÃO invente entidade que a pergunta " +
  "original não menciona; se a pergunta já é simples (um único fato resolve), devolva " +
  "composta=false e sub_perguntas=[]. No máximo 4 sub-perguntas, na ordem em que precisam ser " +
  "entendidas.";

/** UMA chamada Haiku (provider/config — mesmo resolver do wizard M11-S4) que decide
 *  composta×simples e decompõe. TODA falha (sem provider, JSON inválido, composta=false,
 *  <2 subs) → null (fail-open: o chamador segue o caminho atual). Custo medido no M20
 *  (op "ask:ground"). NUNCA re-tenta além do que structured() já faz. */
export async function groundQuestion(home: string, q: string): Promise<Grounding | null> {
  let provider: Provider;
  try {
    provider = resolveProvider(config(home).provider);
  } catch {
    return null;
  }
  const cfg = config(home);
  // right-size (LEI II do M17): grounding é classificação barata → tier da EXTRAÇÃO (Haiku/
  // apiModel), NUNCA o synthModel. provider cli usa cliModel (degradação dev — ver §7).
  const model = provider === "cli" ? cfg.cliModel : cfg.apiModel;
  try {
    const out = await structured({
      provider,
      model,
      system: GROUND_SYSTEM,
      prompt: `Pergunta: ${q}`,
      tool: GROUND_TOOL as unknown as Tool,
      dims: [GROUND_TOOL.name], // mesmo padrão do wizard M11-S4 (bff-onboarding.ts)
      meter: (ev) =>
        void recordUsage(home, {
          op: "ask:ground",
          provider: ev.provider,
          model: ev.model,
          tokensIn: ev.tokensIn,
          tokensOut: ev.tokensOut,
          cacheRead: ev.cacheRead,
          cacheWrite: ev.cacheWrite,
          costUsdReported: ev.costUsdReported,
          meta: { q: q.slice(0, 120) },
        }),
    });
    if (!out || out.composta !== true || !Array.isArray(out.sub_perguntas)) return null;
    const subs = out.sub_perguntas
      .filter((s: unknown): s is string => typeof s === "string" && !!s.trim())
      .map((s: string) => s.trim().slice(0, 300))
      .slice(0, 4);
    return subs.length >= 2 ? { subs } : null;
  } catch {
    return null; // fail-open: pergunta segue o caminho atual
  }
}
