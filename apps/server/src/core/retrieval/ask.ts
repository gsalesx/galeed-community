/** CAMADA 3 — síntese feita pelo CÉREBRO (para chamadores não-LLM). Usa o contrato do query do gbrain:
 *  resposta ancorada + citações [n] + análise de lacunas explícita. */
import { retrieve, getPage } from "./query.ts";
import { semanticSearch } from "./embeddings.ts";
import { config } from "../platform/config.ts";
import { resolveProvider, structuredSynthesis, streamProse } from "../../lib/llm.ts";
import { withCodexBrain, getCodexBrain } from "../../lib/chatgpt-codex.ts";
import { recordUsage } from "../platform/usage.ts"; // M20 — custo de IA por pergunta
import { getEngine, type PercepcaoRow } from "../platform/engine.ts";
import { inScope, type Scope } from "../access/scope.ts";
import { verifyAnswer, type Claim, type VerifySource, type DroppedClaim } from "./answer-verify.ts";
import { temporalCutPt } from "../../lib/temporal-cut.ts";
import { detectComposite, groundQuestion, independentEntities, type StagedKind } from "./ground.ts";
import { surfaceEntity } from "./entity-attr.ts";

/** SYSTEM da SÍNTESE ESTRUTURADA (M17/ADR-011). A resposta é um conjunto de CLAIMS verificáveis: cada
 *  afirmação carrega o `quote` = a MENOR frase VERBATIM da fonte `cite_slug` que sustenta EXATAMENTE o
 *  `text`. Quote MÍNIMO é a defesa contra o fuzzy ≥70% do quoteIsGrounded (LEARNINGS S1): um quote LARGO
 *  de contexto pode embutir um termo inventado e ainda passar a porta; a frase curta que sustenta o termo
 *  específico não passa se o termo é inventado. O `text` só pode afirmar o que está no `quote`. */
const SYSTEM =
  "Você é a memória de longo prazo de uma empresa. Sua resposta é um conjunto de CLAIMS verificáveis. " +
  "Para CADA afirmação, devolva { text, cite_slug, quote }: `quote` é a MENOR frase COPIADA LITERALMENTE " +
  "(verbatim) de UMA das fontes do contexto que sustenta EXATAMENTE o `text` — NÃO um trecho largo de " +
  "contexto, e sim a frase curta que prova a afirmação. `cite_slug` é o slug dessa fonte (um dos slugs " +
  "mostrados como [n] (slug, …) no contexto). NÃO afirme nada que um `quote` literal não sustente. NÃO " +
  "inclua no `text` nenhum número, nome ou termo que não apareça no `quote` — se a fonte diz 'Vascular e " +
  "Endovascular', NÃO escreva 'cardiovascular'; se diz 'mais de 28 anos', NÃO escreva '29 anos'. Quando " +
  "fontes se contradizem, faça um claim por lado. Prefira FATOS VIGENTES a trechos antigos. Para " +
  'afirmações baseadas nos FATOS VIGENTES, use cite_slug: "__facts__" e copie como `quote` a linha do ' +
  "fato. Em `gaps`, liste o que o cérebro NÃO sabe ou pode estar desatualizado. Nunca invente; um claim " +
  "sem quote literal de apoio NÃO deve ser feito.";

/** Tool da SÍNTESE estruturada (M17). Shape distinto da extração: claims com quote verbatim + gaps.
 *  LOCAL ao ask.ts (NÃO reusa a tool de extração entity/predicate/value). */
const SYNTH_TOOL = {
  name: "answer",
  description: "Resposta como claims verificáveis (cada um com quote verbatim da fonte) + lacunas.",
  input_schema: {
    type: "object",
    properties: {
      claims: {
        type: "array",
        items: {
          type: "object",
          properties: {
            text: { type: "string", description: "a afirmação em prosa para a resposta" },
            cite_slug: { type: "string", description: "slug da fonte citada (de [n] (slug, …)) ou __facts__" },
            quote: { type: "string", description: "a MENOR frase VERBATIM da fonte cite_slug que sustenta text" },
          },
          required: ["text", "cite_slug", "quote"],
        },
      },
      gaps: { type: "array", items: { type: "string" } },
    },
    required: ["claims", "gaps"],
  },
} as const;

/** Lacunas = gaps do modelo + o que foi DROPADO por falta de âncora (transparência, decisão §8c). */
function gapsList(modelGaps: string[], dropped: DroppedClaim[]): string[] {
  const removed = dropped.map(
    (d) => `removido por falta de âncora: "${d.claim.text.slice(0, 120)}" (${d.reason})`,
  );
  return [...modelGaps, ...removed];
}

/** Monta a prosa final SÓ dos claims verificados. [n] = índice 1-based da fonte (passagem) citada;
 *  claims de fato (__facts__) citam [fatos]. Junta os texts + seção Lacunas (gaps + dropados). */
function renderAnswer(
  verified: Claim[],
  slugToIndex: Map<string, number>,
  modelGaps: string[],
  dropped: DroppedClaim[],
): string {
  if (!verified.length) {
    const lac = gapsList(modelGaps, dropped);
    return (
      `Não há afirmação ancorada nas fontes para responder isso com segurança.` +
      (lac.length ? `\n\nLacunas:\n- ${lac.join("\n- ")}` : "")
    );
  }
  const body = verified
    .map((c) => {
      const idx = slugToIndex.get(c.cite_slug);
      const cite =
        c.cite_slug === "__facts__" ? " [fatos]"
        : c.cite_slug === "__percepcoes__" ? " [percepção]"
        : idx ? ` [${idx}]` : "";
      return `${c.text.trim()}${cite}`;
    })
    .join(" ");
  const lac = gapsList(modelGaps, dropped);
  return lac.length ? `${body}\n\nLacunas:\n- ${lac.join("\n- ")}` : body;
}

/** Linha de um fato vigente p/ o bloco de contexto. M9: inclui tier + value_num/unit/period quando há,
 *  pra a evolução por tier ficar legível pro sintetizador (ex.: "accelera · preco [enterprise]: R$ 30 mil
 *  (30000 BRL/monthly, desde 2024-06-05)"). */
function factLine(f: { entity?: string; predicate?: string; value?: string; value_num?: number | null; unit?: string; period?: string; tier?: string; valid_from?: string; valid_to?: string; source_slug: string }): string {
  const tierTag = f.tier ? ` [${f.tier}]` : "";
  const num = f.value_num != null ? ` (${f.value_num}${f.unit ? " " + f.unit : ""}${f.period ? "/" + f.period : ""})` : "";
  const ate = f.valid_to ? ` até ${f.valid_to}` : "";
  return `- ${f.entity} · ${f.predicate}${tierTag}: ${f.value}${num} (desde ${f.valid_from || "?"}${ate}, cite:${f.source_slug})`;
}

/** filtra fatos pelo escopo: o fato herda área+sensibilidade da PÁGINA-fonte (`f.source_slug`).
 *  Quando há scope, descarta fato cuja página-fonte não passe em inScope (fail-closed). */
async function factsInScope<T extends { source_slug: string }>(home: string, facts: T[], scope?: Scope): Promise<T[]> {
  if (!scope) return facts;
  const e = await getEngine(home);
  const pages = await e.pagesBySlug([...new Set(facts.map((f) => f.source_slug))]);
  return facts.filter((f) => {
    const p = pages.get(f.source_slug);
    return !!p && inScope({ type: p.type, tags: p.tags, sensitivity: p.sensitivity }, scope);
  });
}

/** FATOS VIGENTES das fontes recuperadas (R8): injeta a verdade ATUAL pra ganhar do trecho antigo. */
async function fatosVigentes(home: string, sources: string[], scope?: Scope): Promise<string> {
  try {
    const e = await getEngine(home);
    const cur = await factsInScope(home, (await e.currentFacts()).filter((f) => sources.includes(f.source_slug) && f.entity && f.value), scope);
    if (!cur.length) return "";
    // P1-B (A2c): consumo DETERMINÍSTICO — currentFacts() hoje vem sem ORDER BY (o ORDER BY no
    // engine é P1-A); pré-sort estável pra o dedupe eleger SEMPRE o mesmo vigente por chave:
    // mais recente (valid_from desc) > maior confiança > source_slug asc.
    const ordered = [...cur].sort(
      (a, b) =>
        `${a.entity}|${a.predicate}|${a.tier ?? ""}`.localeCompare(`${b.entity}|${b.predicate}|${b.tier ?? ""}`) ||
        (b.valid_from ?? "").localeCompare(a.valid_from ?? "") ||
        (b.confidence ?? 0) - (a.confidence ?? 0) ||
        a.source_slug.localeCompare(b.source_slug),
    );
    const seen = new Set<string>();
    const linhas = ordered
      .filter((f) => {
        const k = `${f.entity}|${f.predicate}|${f.tier ?? ""}`; // M9: tier na chave — não colapsa planos
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .slice(0, 20)
      .map((f) => factLine(f));
    return `FATOS VIGENTES (preferir a trechos antigos):\n${linhas.join("\n")}\n\n---\n\n`;
  } catch {
    return "";
  }
}

/** P1-B (mata A3) — token presente como PALAVRA INTEIRA (fronteira = não-letra/não-dígito
 *  unicode), não substring: "aceleradora" NÃO contém a palavra "accelera". */
function hasWord(text: string, token: string): boolean {
  const esc = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])`, "u").test(text);
}

/** Entity-linking DETERMINÍSTICO e tenant-neutro: dado o texto da pergunta e a lista de entidades
 *  conhecidas, devolve as que a pergunta menciona. Robusto a sufixos de extração (ex.: `inject_system`
 *  p/ pergunta "Inject"): casa quando a pergunta contém ≥1 token distintivo (len≥4) E ≥50% dos tokens
 *  da entidade — sem exigir TODOS (frágil) nem aceitar 1 token genérico solto (falso-positivo). Sem
 *  lista de negócio, qualquer idioma. EXPORTADA (M10): o BFF (bff-m9.ts) reusa a MESMA função em vez
 *  de duplicar a heurística — refator puro, comportamento idêntico ao inline anterior.
 *  P1-B: casa por PALAVRA INTEIRA (word-boundary), não substring — "aceleradora" NÃO casa a entidade "accelera". */
export function matchEntities(q: string, entities: string[]): string[] {
  const nq = q.toLowerCase();
  return entities.filter((ent) => {
    const toks = ent.split(/[_\s]+/).filter((t) => t.length > 2);
    if (!toks.length) return false;
    const hit = toks.filter((t) => hasWord(nq, t));
    const hasDistinctive = hit.some((t) => t.length >= 4);
    return hasDistinctive && hit.length / toks.length >= 0.5;
  });
}

/** P1-B (mata A3) — predicados que a pergunta MENCIONA: mesma disciplina do matchEntities
 *  (tokens + word-boundary), com fold de acentos nos DOIS lados ("preço" na pergunta casa o
 *  predicado `preco`). Predicados são curtos (`preco`, `aluno_de`, `mrr`): casa quando ≥1 token
 *  (len≥3) do predicado é palavra da pergunta E (o token casado tem len≥4 OU todos os tokens
 *  casaram — cobre `mrr`). Tenant-neutro: zero léxico de negócio, só fold+boundary; sinônimo
 *  ("custava"→preco) é grounding do M23. EXPORTADA p/ o BFF e p/ a prova executável. */
export function matchPredicates(q: string, predicates: string[]): string[] {
  const fold = (s: string) => s.toLowerCase().normalize("NFD").replace(/\p{M}+/gu, "");
  const fq = fold(q);
  return predicates.filter((p) => {
    const toks = fold(p).split(/[_\s]+/).filter((t) => t.length >= 3);
    if (!toks.length) return false;
    const hit = toks.filter((t) => hasWord(fq, t));
    if (!hit.length) return false;
    return hit.some((t) => t.length >= 4) || hit.length === toks.length;
  });
}

/** P1-B (mata A3) — ordena e CORTA a série injetada por RELEVÂNCIA à pergunta, nunca por
 *  alfabeto. Regras (determinísticas):
 *  1) séries (entity·predicate·tier) cujo predicate casa a pergunta (matchPredicates) vêm
 *     PRIMEIRO e entram INTEIRAS — o corte NUNCA decapita a série do predicado perguntado
 *     (se as séries quentes sozinhas excedem `limit`, elas entram inteiras mesmo assim; o teto
 *     natural é o limit=200 da timeline por entidade, já filtrado por escopo);
 *  2) as demais séries entram por RECÊNCIA (maior valid_from da série, desc) até o limit —
 *     linha a linha (só a série quente é indecapitável);
 *  3) dentro de cada série, ordem CRONOLÓGICA (valid_from asc) — a evolução fica legível;
 *  4) todo empate desempata por chave lexicográfica `entity|predicate|tier` (+ value) —
 *     mesma entrada, mesma saída, sempre.
 *  COMPARTILHADA por factsForQuery (ask) e seriesForQuery (bff-m9): UMA heurística, dois
 *  consumidores — fim da cópia divergente. */
export function rankSeriesForQuestion<
  T extends { entity?: string; predicate?: string; tier?: string; valid_from?: string; value?: string },
>(q: string, facts: T[], limit = 60): T[] {
  const keyOf = (f: T) => `${f.entity}|${f.predicate}|${f.tier ?? ""}`;
  const groups = new Map<string, T[]>();
  for (const f of facts) {
    const k = keyOf(f);
    groups.set(k, [...(groups.get(k) ?? []), f]);
  }
  const preds = [...new Set(facts.map((f) => f.predicate).filter((p): p is string => !!p))];
  const hot = new Set(matchPredicates(q, preds));
  const inSeries = (a: T, b: T) =>
    (a.valid_from ?? "").localeCompare(b.valid_from ?? "") || (a.value ?? "").localeCompare(b.value ?? "");
  const maxFrom = (g: T[]) => g.reduce((m, f) => ((f.valid_from ?? "") > m ? f.valid_from! : m), "");
  const entries = [...groups.entries()].map(([k, g]) => ({ k, g: [...g].sort(inSeries), hot: hot.has(g[0].predicate ?? "") }));
  const hotLines = entries.filter((e) => e.hot).sort((a, b) => a.k.localeCompare(b.k)).flatMap((e) => e.g);
  const coldGroups = entries
    .filter((e) => !e.hot)
    .sort((a, b) => maxFrom(b.g).localeCompare(maxFrom(a.g)) || a.k.localeCompare(b.k));
  const out = [...hotLines];
  for (const e of coldGroups) {
    for (const f of e.g) {
      if (out.length >= limit) return out;
      out.push(f);
    }
  }
  return out;
}

/** ROUTER DE FATOS (M6/D4) — para perguntas FACTUAIS sobre entidade conhecida, a verdade estruturada
 *  (timeline bitemporal) vence a passagem. Usa o entity-linking determinístico de `matchEntities`. */
export async function factsForQuery(home: string, q: string, scope?: Scope): Promise<{ block: string; entities: string[]; surfaced?: string }> {
  try {
    const e = await getEngine(home);
    const cur = await factsInScope(home, (await e.currentFacts()).filter((f) => f.entity && f.value), scope);
    if (!cur.length) return { block: "", entities: [] };
    const entities = [...new Set(cur.map((f) => f.entity))].filter((x): x is string => !!x);
    let matched = matchEntities(q, entities);
    let surfaced: string | undefined;
    if (!matched.length) {
      // M23-A (S2): a pergunta não NOMEIA entidade — tenta resolver por ATRIBUTOS sobre os
      // fatos vigentes já carregados (zero leitura extra; LLM só no empate). Fail-open:
      // null → comportamento atual de passagem, shape vazio EXATO (p1b depende).
      const s = await surfaceEntity(home, q, cur);
      if (!s) return { block: "", entities: [] };
      matched = [s.entity];
      surfaced = s.entity;
    }
    const set = new Set(matched);
    // M9: para mostrar a EVOLUÇÃO (não só o preço vigente de cada tier), puxa a TIMELINE bitemporal das
    // entidades casadas — inclui versões superseded (valid_to != ""). Filtrada por escopo via source_slug.
    const tlAll: typeof cur = [];
    for (const ent of matched) {
      try { tlAll.push(...(await e.timeline(ent, { limit: 200 }))); } catch { /* ignora */ }
    }
    const timeline = await factsInScope(home, tlAll.filter((f) => f.entity && f.predicate && f.value), scope);
    // une timeline (histórico) + vigentes; dedupe por (entity,predicate,tier,valid_from,value) p/ não repetir.
    const merged = [...timeline, ...cur.filter((f) => set.has(f.entity!) && f.predicate)];
    // P1-B (A2c): pré-sort DETERMINÍSTICO antes do dedupe — o vencedor de cada chave (e o
    // source_slug citado) não depende da ordem de chegada do engine (o ORDER BY lá é P1-A).
    const ordered = [...merged]
      .filter((f) => set.has(f.entity!) && f.predicate)
      .sort(
        (a, b) =>
          `${a.entity}|${a.predicate}|${a.tier ?? ""}|${a.valid_from ?? ""}|${a.value}`.localeCompare(
            `${b.entity}|${b.predicate}|${b.tier ?? ""}|${b.valid_from ?? ""}|${b.value}`,
          ) ||
          (b.confidence ?? 0) - (a.confidence ?? 0) ||
          a.source_slug.localeCompare(b.source_slug),
      );
    const seen = new Set<string>();
    const deduped = ordered.filter((f) => {
      // a chave de dedupe inclui `tier` E `valid_from` — cada (entity,predicate,tier) é uma SÉRIE
      // no tempo; sem tier os planos colapsam; sem valid_from os degraus da evolução colapsam.
      const key = `${f.entity}|${f.predicate}|${f.tier ?? ""}|${f.valid_from ?? ""}|${f.value}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // P1-B (mata A3): recorte temporal EXPLÍCITO da pergunta → timeline FILTRADA pelo MESMO
    // predicado asOf do engine (postgres.ts, facts(opts.asOf)) — vigente NO PONTO (fim do
    // período). Sem recorte (ou recorte que não casa nenhum fato) → comportamento atual.
    const cut = temporalCutPt(q);
    let pool = deduped;
    let header = "FATOS (verdade estruturada — série bitemporal por entidade·atributo·tier; prefira a trechos):";
    if (cut) {
      const noPonto = deduped.filter(
        (f) =>
          ((f.valid_from ?? "") === "" || f.valid_from! <= cut.asOf) &&
          ((f.valid_to ?? "") === "" || cut.asOf < f.valid_to!),
      );
      if (noPonto.length) {
        pool = noPonto;
        header = `FATOS (recorte temporal da pergunta: ${cut.label} — fatos vigentes nesse ponto, asOf ${cut.asOf}; prefira-os aos trechos):`;
      }
    }

    // P1-B (mata A3): corte por RELEVÂNCIA — a série do predicado perguntado entra INTEIRA;
    // nunca mais slice(0,60) após sort alfabético.
    const nota = surfaced
      ? `(entidade localizada por atributos: ${surfaced} — a pergunta a descreve sem nomear)\n`
      : "";
    const linhas = rankSeriesForQuestion(q, pool, 60).map((f) => factLine(f));
    return {
      block: linhas.length ? `${header}\n${nota}${linhas.join("\n")}\n\n---\n\n` : "",
      entities: matched,
      ...(surfaced ? { surfaced } : {}),
    };
  } catch {
    return { block: "", entities: [] };
  }
}

/** header do bloco rotulado da pergunta composta (S1). */
const COMPOSTA_HEADER =
  "PERGUNTA COMPOSTA (decomposta em sub-perguntas — os FATOS abaixo estão rotulados por sub-pergunta; responda COMBINANDO as partes):";
/** linha de sub-pergunta sem fatos estruturados. */
const SEM_FATOS_SUB = "(sem fatos estruturados para esta sub-pergunta)";

/** telemetria do estágio (vai pra testes/log — NÃO muda o shape de ask()/askStream()). */
export interface StagedInfo {
  kind: StagedKind;
  /** sub-perguntas usadas (presente SÓ quando decompôs de verdade). */
  subs?: string[];
  /** entidade resolvida por atributos (S2), quando houve. */
  surfaced?: string;
}

/** M23-A (S1) — CONSULTA EM ESTÁGIOS por cima do router de fatos (BRIEF §3 Peça 1).
 *  Caminho SIMPLES = exatamente o factsForQuery de hoje (1 chamada, zero LLM extra, zero
 *  latência extra — decisão do CTO, BRIEF §8b). Composta (detector determinístico) ou ambígua
 *  (≥2 entidades INDEPENDENTES casadas) → 1 chamada Haiku decompõe (groundQuestion); cada
 *  sub-pergunta roda o factsForQuery EXISTENTE (o temporalCutPt/asOf do P1-B dispara dentro
 *  dela quando a sub-pergunta carrega o trecho temporal verbatim); o bloco final rotula os
 *  resultados parciais por sub-pergunta pra síntese M17/M18. Fail-open em TODA falha:
 *  devolve o resultado single-shot original. NÃO é loop: sub-pergunta nunca re-decompõe. */
export async function factsForQueryStaged(
  home: string,
  q: string,
  scope?: Scope,
): Promise<{ block: string; entities: string[]; staged: StagedInfo }> {
  const fq = await factsForQuery(home, q, scope);
  let kind: StagedKind = detectComposite(q);
  if (kind === "simples" && independentEntities(fq.entities).length >= 2) kind = "ambigua";
  if (kind === "simples") {
    return { block: fq.block, entities: fq.entities, staged: { kind, surfaced: fq.surfaced } };
  }
  const g = await groundQuestion(home, q);
  if (!g) {
    // fail-open: o LLM disse "simples" (composta=false) ou falhou → single-shot original.
    return { block: fq.block, entities: fq.entities, staged: { kind, surfaced: fq.surfaced } };
  }
  const partes = await Promise.all(g.subs.map((s) => factsForQuery(home, s, scope)));
  if (partes.every((p) => !p.block)) {
    return { block: fq.block, entities: fq.entities, staged: { kind, surfaced: fq.surfaced } };
  }
  const corpo = g.subs
    .map((s, i) => {
      const b = partes[i].block ? partes[i].block.replace(/\n\n---\n\n$/, "") : SEM_FATOS_SUB;
      return `[S${i + 1}] ${s}\n${b}`;
    })
    .join("\n\n");
  const entities = [...new Set(partes.flatMap((p) => p.entities))];
  const surfaced = partes.find((p) => p.surfaced)?.surfaced ?? fq.surfaced;
  return {
    block: `${COMPOSTA_HEADER}\n\n${corpo}\n\n---\n\n`,
    entities,
    staged: { kind, subs: g.subs, surfaced },
  };
}

// ============================================================================
// M24-E — bloco "PERCEPÇÕES DO CÉREBRO" no contexto da síntese. Match DETERMINÍSTICO
// (mesmo padrão do factsForQuery): só injeta percepções VIVAS cujas entidades/predicados casam
// a pergunta; custo ZERO quando não casa (prompt byte-idêntico ao atual). ZERO LLM neste caminho.
// ============================================================================

/** M24-E: teto de percepções injetadas no contexto (LEI V — o custo do bloco é K, não o corpus). */
const PERCEP_BLOCK_K = Number(process.env.GALEED_PERCEPCOES_BLOCK_K || 3);
/** M24-E: quantas percepções vivas o match varre por pergunta (1 query SQL barata). */
const PERCEP_SCAN_LIMIT = Number(process.env.GALEED_PERCEPCOES_SCAN || 200);

const PERCEP_HEADER =
  "PERCEPÇÕES DO CÉREBRO (padrões que o cérebro detectou dormindo — camada DISTINTA dos fatos e dos " +
  "trechos; NÃO são fatos confirmados; cada uma carrega o porquê numérico do detector e as fontes). " +
  'Para afirmações baseadas nelas use cite_slug: "__percepcoes__", copie a linha da percepção como ' +
  "quote e rotule na resposta como percepção do cérebro, citando a data do sono:";

/** fontes únicas de uma percepção (deriva dos cites — helper usado na linha, no escopo e no BFF). */
function percepcaoSlugs(p: PercepcaoRow): string[] {
  return [...new Set((p.cites ?? []).map((c) => c.source_slug).filter(Boolean))];
}

/** linha de UMA percepção no bloco. `numbers` ordenado por chave (determinismo: mesma entrada → mesmos bytes). */
function percepcaoLine(p: PercepcaoRow): string {
  const tierTag = p.tier ? ` [${p.tier}]` : "";
  const why = Object.entries(p.numbers ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
  const fontes = percepcaoSlugs(p).slice(0, 3).join(", ");
  const sono = (p.created_at ?? "").slice(0, 10);
  return `- [${p.classe} · ${p.severidade}]${tierTag} ${p.texto} (porquê: ${why || "—"} · sono de ${sono || "—"} · fontes: ${fontes || "—"})`;
}

/** percepções in-scope (espelha factsInScope, fail-closed): mantém só as com ≥1 página de fonte
 *  que passa inScope. Percepção sem fonte nos cites cai quando há scope. */
async function percepcoesInScope(home: string, rows: PercepcaoRow[], scope?: Scope): Promise<PercepcaoRow[]> {
  if (!scope) return rows;
  const e = await getEngine(home);
  const slugs = [...new Set(rows.flatMap(percepcaoSlugs))];
  const pages = await e.pagesBySlug(slugs);
  return rows.filter((p) =>
    percepcaoSlugs(p).some((s) => {
      const pg = pages.get(s);
      return pg ? inScope(pg, scope) : false;
    }),
  );
}

/** match DETERMINÍSTICO de percepções vivas pra pergunta (mesmo padrão do factsForQuery). Fail-open:
 *  qualquer erro/tabela ausente → "" (pergunta segue intacta). ZERO LLM. */
export async function percepcoesForQuery(home: string, q: string, scope?: Scope): Promise<string> {
  try {
    const e = await getEngine(home);
    const vivas = await e.listPercepcoes({ estado: "viva", limit: PERCEP_SCAN_LIMIT });
    if (vivas.length === 0) return "";
    const partes = (p: PercepcaoRow) => p.entity.split(",").map((s) => s.trim()).filter(Boolean);
    const matched = new Set(matchEntities(q, [...new Set(vivas.flatMap(partes))]));
    let picked = vivas.filter((p) => partes(p).some((e2) => matched.has(e2)));
    if (picked.length === 0) return "";
    picked = await percepcoesInScope(home, picked, scope);
    if (picked.length === 0) return "";
    const hot = new Set(matchPredicates(q, [...new Set(picked.map((p) => p.predicate).filter(Boolean))]));
    const sev = (s: string) => (s === "alta" ? 3 : s === "media" ? 2 : s === "baixa" ? 1 : 0);
    picked.sort(
      (a, b) =>
        Number(hot.has(b.predicate)) - Number(hot.has(a.predicate)) ||
        sev(b.severidade) - sev(a.severidade) ||
        (b.created_at ?? "").localeCompare(a.created_at ?? "") ||
        a.id.localeCompare(b.id),
    );
    const linhas = picked.slice(0, PERCEP_BLOCK_K).map(percepcaoLine);
    return `${PERCEP_HEADER}\n${linhas.join("\n")}\n\n---\n\n`;
  } catch {
    return "";
  }
}

/** SYSTEM da SÍNTESE STREAMADA (M18). PROSA (não estruturada): a resposta é texto corrido ancorado no
 *  contexto, citando [n], com uma seção "Lacunas" ao fim. NÃO é a SYNTH_TOOL (claims+quote verificados):
 *  a prosa streamada é NÃO-verificada por decisão do fundador (LEI III) — a confiança mora nos fatos/
 *  citações ancorados que chegam no `done`. Mantém o tom anti-alucinação por INSTRUÇÃO (best-effort). */
const SYSTEM_STREAM =
  "Você é a memória de longo prazo de uma empresa. Responda à pergunta SOMENTE com base no contexto " +
  "fornecido (fatos vigentes e trechos das fontes). Cite as fontes como [n] usando o número que aparece " +
  "no contexto. Prefira os FATOS VIGENTES aos trechos antigos. NÃO invente números, nomes ou termos que " +
  "não estejam no contexto — se a fonte diz 'Vascular e Endovascular', não escreva 'cardiovascular'; se " +
  "diz 'mais de 28 anos', não escreva '29 anos'. Seja direto e objetivo. Ao final, se houver, inclua uma " +
  "seção 'Lacunas:' listando o que o cérebro não sabe ou pode estar desatualizado. Se o contexto não " +
  "responde, diga isso honestamente — não preencha com suposição.";

/** Bloco de RECUPERAÇÃO compartilhado por ask() e askStream(): retrieve reranqueado + bestChunk +
 *  bodies + ctx + fatos (factsForQuery|fatosVigentes). Idêntico ao que ask() fazia inline (M17). NÃO
 *  muda comportamento — só FATORA. Retorna o material p/ a síntese (estruturada em ask, prosa em askStream). */
interface Retrieved {
  hits: Awaited<ReturnType<typeof retrieve>>;
  sources: string[];
  ctx: string;
  vigentes: string;
  percep: string; // M24-E — bloco PERCEPÇÕES DO CÉREBRO ("" quando não casa → prompt byte-idêntico)
  bestChunk: Map<string, string>;
  bodies: (Awaited<ReturnType<typeof getPage>> | null)[];
}

async function retrieveForAnswer(home: string, q: string, k: number, scope?: Scope): Promise<Retrieved | null> {
  // M6/D4: o `retrieve` RERANQUEADO é quem escolhe as FONTES certas (o reranker é o árbitro) — antes
  // o ask usava chunks crus por cosine e perdia o doc certo em escala. O contexto é montado com o
  // melhor CHUNK de cada fonte reranqueada (sem dedupe traz o trecho exato, mesmo de reuniões enormes).
  // S2: com scope, retrieve já devolve só fontes in-scope; os fatos são filtrados pela página-fonte.
  const hits = await retrieve(home, q, k, { scope });
  if (!hits.length) return null;
  const sources = hits.map((h) => h.slug);
  const chunks = (await semanticSearch(home, q, 60, false).catch(() => null)) || [];
  const bestChunk = new Map<string, string>();
  for (const c of chunks) if (sources.includes(c.slug) && !bestChunk.has(c.slug)) bestChunk.set(c.slug, c.text);
  const bodies = await Promise.all(hits.map((h) => (bestChunk.has(h.slug) ? Promise.resolve(null) : getPage(home, h.slug))));
  const ctx = hits
    .map((h, i) => `[${i + 1}] (${h.slug}, ${h.date || "sem data"})\n${bestChunk.get(h.slug) || bodies[i]?.body?.slice(0, 1500) || h.excerpt}`)
    .join("\n\n---\n\n");

  // M6/D4: fatos da ENTIDADE da pergunta (verdade estruturada) primeiro; senão, fatos das fontes (R8).
  // M23-A: via factsForQueryStaged — pergunta simples segue o caminho atual intocado; composta
  // chega à síntese M17/M18 com resultados parciais ROTULADOS por sub-pergunta (só o CONTEXTO
  // muda — SYSTEM/SYNTH_TOOL/verifyAnswer/renderAnswer intocados).
  const fq = await factsForQueryStaged(home, q, scope);
  const vigentes = fq.block || (await fatosVigentes(home, sources, scope));
  // M24-E: bloco de percepções (match determinístico; "" quando não casa → custo ZERO a mais).
  const percep = await percepcoesForQuery(home, q, scope);
  return { hits, sources, ctx, vigentes, percep, bestChunk, bodies };
}

export async function ask(home: string, q: string, k = 8, scope?: Scope) {
  if (getCodexBrain() !== home) return withCodexBrain(home, () => ask(home, q, k, scope));
  const r = await retrieveForAnswer(home, q, k, scope);
  if (!r) {
    return { answer: "O cérebro não tem nada indexado sobre isso.", sources: [] as string[], gaps: ["nenhuma fonte encontrada"] };
  }
  const { hits, sources, ctx, vigentes, percep, bestChunk, bodies } = r;
  const cfg = config(home);
  const provider = resolveProvider(cfg.provider);
  // M17 (LEI II / right-size): a síntese roda no synthModel (default Sonnet via env; fallback apiModel),
  // NÃO no apiModel/Haiku. A EXTRAÇÃO segue no apiModel — intacta. provider cli usa cliModel.
  const model = provider === "cli" ? cfg.cliModel : cfg.synthModel;

  // SÍNTESE ESTRUTURADA (LEI I): o modelo devolve claims {text,cite_slug,quote} + gaps. A verificação
  // determinística (verifyAnswer, S1) dropa todo claim sem quote verbatim na fonte / número não-ancorado.
  let out: { claims?: Claim[]; gaps?: string[] };
  try {
    out = await structuredSynthesis({
      provider,
      model,
      system: SYSTEM,
      prompt: `Pergunta: ${q}\n\nContexto:\n${vigentes}${percep}${ctx}`,
      tool: SYNTH_TOOL as any,
      // M20: registra o custo da síntese (pergunta). Fail-soft.
      meter: (ev) =>
        void recordUsage(home, {
          op: "synthesis",
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
  } catch (err) {
    // fail-safe: modelo sem JSON → não derruba o ask; responde sem claims (Lacuna explícita).
    // MAS loga a causa — sem isto, "falta ANTHROPIC_API_KEY / claude ENOENT" vira um silêncio
    // que o usuário lê como "o cérebro não sabe nada" (impossível de diagnosticar).
    console.error("[ask] síntese estruturada falhou (respondendo sem claims):", err instanceof Error ? err.message : err);
    out = { claims: [], gaps: ["a síntese não retornou claims estruturados"] };
  }
  const rawClaims: Claim[] = Array.isArray(out.claims) ? out.claims : [];
  const modelGaps: string[] = Array.isArray(out.gaps) ? out.gaps.map((g) => String(g)) : [];

  // FONTES verificáveis: passagens (o MESMO material do ctx) + fatos (bloco vigente como fonte sintética
  // de slug estável "__facts__" — evita parser à mão de slugs de fato; invariante #9, decisão do Arquiteto).
  const passageSources: VerifySource[] = hits.map((h, i) => ({
    slug: h.slug,
    body: bestChunk.get(h.slug) || bodies[i]?.body || h.excerpt || "",
  }));
  const factSources: VerifySource[] = [
    ...(vigentes ? [{ slug: "__facts__", body: vigentes }] : []),
    ...(percep ? [{ slug: "__percepcoes__", body: percep }] : []),
  ];

  const { verified, dropped } = verifyAnswer(rawClaims, passageSources, factSources);

  // RENDER só dos verificados: [n] = índice 1-based da fonte real; claims de fato → [fatos].
  const slugToIndex = new Map(sources.map((s, i) => [s, i + 1]));
  const answer = renderAnswer(verified, slugToIndex, modelGaps, dropped);
  return { answer, sources, provider, gaps: gapsList(modelGaps, dropped) };
}

/** Carga ANCORADA devolvida ao fim do stream (M18). Base da MESMA carga do ask()/askHandler: os slugs
 *  das fontes + os gaps. As CITAÇÕES ricas (RetrieveHit[] com selo) e a SÉRIE de fatos são hidratadas na
 *  costura do BFF (S3) — askStream devolve `sources`/`gaps`; o S3 reusa o caminho do askHandler p/ as
 *  citations/facts. (Mantém askStream enxuto e sem duplicar a montagem de selo do BFF.) */
export interface StreamPayload {
  sources: string[]; // = hits.map(h=>h.slug) — idêntico ao ask()
  gaps: string[]; // lacunas (best-effort: aqui sem os "dropados" do verifyAnswer, pois não há verificação)
  provider?: string; // qual provider sintetizou (debug/telemetria), igual ao ask()
}

/** IRMÃO STREAMADO do ask() (M18, ADITIVO). Recuperação IDÊNTICA ao ask(); síntese em PROSA streamada
 *  (streamProse + SYSTEM_STREAM, NÃO a SYNTH_TOOL); a prosa NÃO é verificada (LEI III). Cada delta do LLM
 *  vai pro onToken. Ao fim, devolve a carga ancorada (sources/gaps). ask() permanece intocado.
 *
 *  @param onToken chamado a cada delta de texto do LLM (token-a-token).
 *  @returns StreamPayload — a base da carga ancorada (o S3 enriquece com citations/facts via askHandler). */
export async function askStream(
  home: string,
  q: string,
  onToken: (delta: string) => void,
  k = 8,
  scope?: Scope,
): Promise<StreamPayload> {
  if (getCodexBrain() !== home) return withCodexBrain(home, () => askStream(home, q, onToken, k, scope));
  const r = await retrieveForAnswer(home, q, k, scope);
  if (!r) {
    // espelha o "nada indexado" do ask(): nenhum token de prosa, carga vazia + gap honesto.
    return { sources: [], gaps: ["nenhuma fonte encontrada"] };
  }
  const cfg = config(home);
  const provider = resolveProvider(cfg.provider);
  // M17/LEI II right-size: a síntese roda no synthModel (api) / cliModel (cli) — MESMO tier do ask().
  const model = provider === "cli" ? cfg.cliModel : cfg.synthModel;
  // SÍNTESE STREAMADA em PROSA (LEI III): streamProse + SYSTEM_STREAM (prosa ancorada, cita [n], Lacunas).
  // NÃO usa SYNTH_TOOL/verifyAnswer — a prosa é NÃO-verificada (decisão do fundador). Cada delta → onToken.
  // Se a síntese falhar (depois de abrir), propaga p/ o S3 emitir event:error (front cai no fallback api.ask).
  await streamProse(
    {
      provider,
      model,
      system: SYSTEM_STREAM,
      prompt: `Pergunta: ${q}\n\nContexto:\n${r.vigentes}${r.percep}${r.ctx}`,
      // M20: registra o custo da pergunta streamada. Fail-soft.
      meter: (ev) =>
        void recordUsage(home, {
          op: "ask:stream",
          provider: ev.provider,
          model: ev.model,
          tokensIn: ev.tokensIn,
          tokensOut: ev.tokensOut,
          cacheRead: ev.cacheRead,
          cacheWrite: ev.cacheWrite,
          costUsdReported: ev.costUsdReported,
          meta: { q: q.slice(0, 120) },
        }),
    },
    onToken,
  );
  // gaps:[] no sucesso — a prosa já EMBUTE a seção "Lacunas:" (instrução do SYSTEM_STREAM); não há `dropped`
  // do verifyAnswer aqui (sem verificação, LEI III). `gaps` fica p/ sinais estruturais. Não fabricar gaps.
  return { sources: r.sources, gaps: [], provider };
}
