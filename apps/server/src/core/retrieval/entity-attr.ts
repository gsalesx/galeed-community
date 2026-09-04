/** M23-A (S2) — entity surfacing na consulta (BRIEF §3 Peça 2, estágio 2 do MEMO sem treinar
 *  nada): quando a pergunta DESCREVE a entidade sem nomeá-la ("o aluno que fechou o Pocket"),
 *  os fatos vigentes JÁ são o índice de atributos — valor `pocket` → entidade candidata.
 *  Determinístico-primeiro (token raro de VALUE, word-boundary, guarda de frequência);
 *  confirmação barata por Haiku SÓ no empate; fail-open (null → caminho atual de passagem).
 *  Tenant-neutro: zero literal de domínio — só folding, fronteira de palavra e frequência. */
import { config } from "../platform/config.ts";
import { resolveProvider, structured, type Provider } from "../../lib/llm.ts";
import { type Tool } from "../../lib/anthropic.ts";
import { recordUsage } from "../platform/usage.ts";

/** shape mínimo de fato que o resolvedor lê (subconjunto estrutural de FactHit do engine). */
export interface AttrFact {
  entity?: string;
  predicate?: string;
  value?: string;
  source_slug: string;
}

export interface AttrEvidence {
  predicate: string;
  value: string;
  source_slug: string;
}

export interface AttrCandidate {
  entity: string;
  score: number;
  /** tokens raros da pergunta que casaram em values desta entidade (ordenados asc). */
  hitTokens: string[];
  /** fatos que sustentam a candidatura (≤5, determinístico). */
  evidence: AttrEvidence[];
}

const fold = (s: string) => s.toLowerCase().normalize("NFD").replace(/\p{M}+/gu, "");
function hasWord(text: string, token: string): boolean {
  const esc = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])`, "u").test(text);
}
const valueTokens = (v: string) => [...new Set(fold(v).split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 4))];

/** "predicado casa a pergunta" — MESMA disciplina do matchPredicates do ask.ts (tokens len≥3
 *  do predicado, fold dos dois lados, hasWord, ≥1 token len≥4 OU todos casaram). Re-implementada
 *  localmente (4 linhas) pra não criar ciclo de import com ask.ts. */
function predicateMatchesQuery(fq: string, predicate: string): boolean {
  const toks = fold(predicate).split(/[_\s]+/).filter((t) => t.length >= 3);
  if (!toks.length) return false;
  const hit = toks.filter((t) => hasWord(fq, t));
  if (!hit.length) return false;
  return hit.some((t) => t.length >= 4) || hit.length === toks.length;
}

/** Candidatas DETERMINÍSTICAS (puro, zero LLM, zero DB — recebe os fatos já carregados):
 *  1) token de VALUE: fold(value) split por não-letra/não-dígito, só tokens len≥4;
 *  2) guarda de frequência (anti-genérico): um token só é EVIDÊNCIA se aparece em values de
 *     ≤3 entidades distintas (df ≤ 3) — "pocket" (1 entidade) conta; um rótulo repetido em
 *     dezenas de entidades não conta;
 *  3) fato-evidência = tem ≥1 token raro presente na pergunta como PALAVRA INTEIRA (hasWord,
 *     fold dos dois lados);
 *  4) score(entity) = hitTokens.size*10 + (algum predicado das evidências casa a pergunta
 *     pela MESMA regra de tokens do matchPredicates? +5) + min(evidence.length, 5);
 *  5) ordena score desc, entity asc; devolve no máximo 5 candidatas, evidence ≤5 por
 *     candidata (ordem: source_slug asc, predicate asc, value asc). */
export function entityCandidatesByAttributes(q: string, facts: AttrFact[]): AttrCandidate[] {
  const fq = fold(q);
  const usable = facts.filter((f) => f.entity && f.value);
  // df(token) = nº de entidades DISTINTAS em cujos values o token aparece — UMA vez sobre facts.
  const df = new Map<string, Set<string>>();
  for (const f of usable) {
    const ent = fold(f.entity!);
    for (const t of valueTokens(f.value!)) {
      if (!df.has(t)) df.set(t, new Set());
      df.get(t)!.add(ent);
    }
  }
  // por entidade: acumula hitTokens (raros, na pergunta) e evidências.
  const byEntity = new Map<
    string,
    { hits: Set<string>; preds: Set<string>; evidence: AttrEvidence[] }
  >();
  for (const f of usable) {
    const rare = valueTokens(f.value!).filter((t) => (df.get(t)?.size ?? 0) <= 3);
    const matched = rare.filter((t) => hasWord(fq, t));
    if (!matched.length) continue; // fato só é evidência se ≥1 token raro casa a pergunta
    const ent = f.entity!;
    if (!byEntity.has(ent)) byEntity.set(ent, { hits: new Set(), preds: new Set(), evidence: [] });
    const acc = byEntity.get(ent)!;
    for (const t of matched) acc.hits.add(t);
    if (f.predicate) acc.preds.add(f.predicate);
    acc.evidence.push({ predicate: f.predicate ?? "", value: f.value!, source_slug: f.source_slug });
  }
  const candidates: AttrCandidate[] = [...byEntity.entries()].map(([entity, acc]) => {
    const evidence = [...acc.evidence]
      .sort(
        (a, b) =>
          a.source_slug.localeCompare(b.source_slug) ||
          a.predicate.localeCompare(b.predicate) ||
          a.value.localeCompare(b.value),
      )
      .slice(0, 5);
    const predBonus = [...acc.preds].some((p) => predicateMatchesQuery(fq, p)) ? 5 : 0;
    const score = acc.hits.size * 10 + predBonus + Math.min(evidence.length, 5);
    return { entity, score, hitTokens: [...acc.hits].sort(), evidence };
  });
  return candidates
    .sort((a, b) => b.score - a.score || a.entity.localeCompare(b.entity))
    .slice(0, 5);
}

const CONFIRM_TOOL = {
  name: "confirmar_entidade",
  description:
    "Escolhe qual entidade candidata a pergunta descreve, ou nenhuma. Devolve o slug EXATO de " +
    "UMA candidata, ou a string vazia.",
  input_schema: {
    type: "object",
    properties: {
      entity: { type: "string", description: "slug exato de UMA candidata, ou \"\" se nenhuma corresponde com segurança" },
    },
    required: ["entity"],
  },
} as const;

const CONFIRM_SYSTEM =
  "A pergunta do usuário descreve uma entidade por atributos, sem nomeá-la. Abaixo estão as " +
  "candidatas com os fatos que casaram. Escolha a entidade que a pergunta descreve, devolvendo " +
  "o slug EXATO de UMA candidata — ou a string vazia se nenhuma corresponde com segurança. NÃO " +
  "invente slug.";

/** Resolução completa (orquestra o determinístico + a confirmação barata):
 *  - 0 candidatas → null (zero LLM);
 *  - vencedora ÚNICA (só 1 candidata, ou score estritamente maior que a 2ª) → devolve direto
 *    (zero LLM), via: "atributos";
 *  - EMPATE no topo (2..5 candidatas com o mesmo score máximo) → 1 chamada Haiku
 *    (CONFIRM_TOOL, op M20 "ask:entity"); só aceita slug EXATO de uma das empatadas; resposta
 *    vazia/inválida/erro → null (fail-open), via: "confirmacao". */
export async function surfaceEntity(
  home: string,
  q: string,
  facts: AttrFact[],
): Promise<{ entity: string; via: "atributos" | "confirmacao" } | null> {
  const cands = entityCandidatesByAttributes(q, facts);
  if (!cands.length) return null;
  if (cands.length === 1 || cands[0].score > cands[1].score) {
    return { entity: cands[0].entity, via: "atributos" };
  }
  // EMPATE no topo — só as que empatam no score máximo entram na confirmação.
  const top = cands[0].score;
  const empatadas = cands.filter((c) => c.score === top);

  let provider: Provider;
  try {
    provider = resolveProvider(config(home).provider);
  } catch {
    return null;
  }
  const cfg = config(home);
  const model = provider === "cli" ? cfg.cliModel : cfg.apiModel;
  const prompt =
    `Pergunta: ${q}\n\nCandidatas:\n` +
    empatadas
      .map((c) => `- ${c.entity}:\n${c.evidence.map((e) => `  · ${e.predicate}: ${e.value}`).join("\n")}`)
      .join("\n");
  try {
    const out = await structured({
      provider,
      model,
      system: CONFIRM_SYSTEM,
      prompt,
      tool: CONFIRM_TOOL as unknown as Tool,
      dims: [CONFIRM_TOOL.name],
      meter: (ev) =>
        void recordUsage(home, {
          op: "ask:entity",
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
    if (!out || typeof out.entity !== "string" || !empatadas.some((c) => c.entity === out.entity)) {
      return null;
    }
    return { entity: out.entity, via: "confirmacao" };
  } catch {
    return null; // fail-open
  }
}
