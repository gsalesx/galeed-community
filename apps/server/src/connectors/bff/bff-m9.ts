/** M10/S2 — handlers do BFF p/ a LEITURA tipada do M9 (facts tipado + ask enriquecido + custo).
 *  Handlers PUROS (recebem home/params, devolvem objeto serializável ou lançam BffError) — espelham
 *  os handlers de RBAC leitura do web-server.ts (rbacPrincipals(home) etc.). O web-server.ts (zona
 *  neutra) só importa estes e roteia. Motor INTOCÁVEL: só IMPORTA query/ask/extract-receipt/engine. */
import { facts as queryFacts, retrieve, type FactHitDecayed } from "../../core/retrieval/query.ts";
import { ask, matchEntities, rankSeriesForQuestion } from "../../core/retrieval/ask.ts";
import { usageRollup } from "../../core/platform/usage.ts";
import { getEngine, type FactHit } from "../../core/platform/engine.ts";
import { type Brain } from "../../core/access/accounts.ts";
import { inScope, type Scope } from "../../core/access/scope.ts";
// M10 (reconcile): BffError UNIFICADO (uma só classe; o catch do web-server trata via instanceof).
import { BffError } from "./bff-common.ts";

export { BffError }; // re-export p/ compat dos imports existentes de "./bff-m9.ts"

/** Item de fato tipado exposto pelo BFF (M9). É o shape que /api/facts e o `facts` do /api/ask devolvem,
 *  e que o front (web/src/lib/api.ts — S4) consome. Espelha FactHit do engine, só os campos do contrato. */
export interface FactItem {
  source_slug: string;
  dimension?: string; // dimensão do fato (decisions/action_items/…) — o front (Dossiê) agrupa por ela
  text?: string; // conteúdo do fato (dims textuais: decisions/entities/quotes) — essencial p/ corpus conversacional
  entity?: string;
  predicate?: string;
  value?: string; // grafia original p/ exibição ("R$ 30 mil")
  value_num?: number | null; // valor numérico CRU (30000) — null/ausente = não-numérico
  unit?: string; // "BRL" | "USD" | "pct" | …
  period?: string; // "monthly" | "annual" | …
  tier?: string; // "enterprise" | "pro" | "starter" | … ("" = sem tier)
  valid_from?: string;
  valid_to?: string; // "" = vigente
  status?: string; // "fato" | "arquivado" | "hipotese" | "registrado"
  confidence?: number;
}

/** mapeia o FactHitDecayed do core → FactItem (preserva os tipados; NÃO achata). */
function toFactItem(f: FactHitDecayed): FactItem {
  return {
    source_slug: f.source_slug,
    dimension: f.dimension ?? "",
    text: f.text ?? "",
    entity: f.entity,
    predicate: f.predicate,
    value: f.value,
    value_num: f.value_num ?? null,
    unit: f.unit ?? "",
    period: f.period ?? "",
    tier: f.tier ?? "",
    valid_from: f.valid_from ?? "",
    valid_to: f.valid_to ?? "",
    status: f.status,
    confidence: f.confidence,
  };
}

/** filtra fatos pelo escopo via a PÁGINA-fonte (`f.source_slug`) — espelho fiel do factsInScope
 *  do ask.ts (fail-closed): sem scope devolve tudo intacto; com scope descarta o fato cuja página
 *  não passe em inScope (sem página conhecida → cai). Mantém o BFF auto-suficiente (sem importar o
 *  helper não-exportado do ask.ts). */
async function factsInScope<T extends { source_slug: string }>(home: string, facts: T[], scope?: Scope): Promise<T[]> {
  if (!scope) return facts;
  const e = await getEngine(home);
  const pages = await e.pagesBySlug([...new Set(facts.map((f) => f.source_slug))]);
  return facts.filter((f) => {
    const p = pages.get(f.source_slug);
    return !!p && inScope({ type: p.type, tags: p.tags, sensitivity: p.sensitivity }, scope);
  });
}

/** /api/facts → FactItem[]. Espelha o handler inline atual do web-server.ts, mas tipado e sem achatar. */
export async function factsHandler(
  home: string,
  params: { dim: string; type?: string; asOf?: string; currentOnly?: boolean; limit?: number },
): Promise<FactItem[]> {
  const rows = await queryFacts(home, params.dim || "decisions", {
    type: params.type,
    asOf: params.asOf,
    currentOnly: params.currentOnly,
    limit: params.limit,
  });
  return rows.map(toFactItem);
}

/** Hit de retrieve no shape que o front consome (com selo). Reusa o que /api/retrieve já devolve. */
type RetrieveHitShape = Awaited<ReturnType<typeof retrieve>>[number];

/** Normalização mínima do selo (réplica consciente de normHits@web-server.ts — não exportado): garante
 *  `selo.tipo` (preferido pelo front) a partir de `selo.natureza` quando ausente. Mantém o handler puro
 *  e sem importar o web-server.ts (evita ciclo). Documentado no ARTIFACTS. */
function normHit<T>(h: T): T {
  const hit = h as unknown as { selo?: Record<string, unknown> };
  if (hit && hit.selo && hit.selo.tipo === undefined && hit.selo.natureza !== undefined) {
    return { ...(h as object), selo: { ...hit.selo, tipo: hit.selo.natureza } } as T;
  }
  return h;
}

/** Série tipada (vigentes + timeline histórica) das entidades casadas na pergunta. Dedupe por
 *  (entity,predicate,tier,valid_from,value) — preserva a evolução por degrau (igual ao ask).
 *  P1-B: corte por relevância via rankSeriesForQuestion — a série do predicado perguntado não é
 *  decapitada. EXPORTADA p/ a prova executável (só toca o engine). */
export async function seriesForQuery(home: string, q: string, scope?: Scope): Promise<FactItem[]> {
  const e = await getEngine(home);
  // BLOCKER fix (defesa-em-profundidade): a série enriquecida também herda o escopo da página-fonte.
  // Sem scope (owner/full-access do BFF) → curScoped === cur, comportamento atual byte-idêntico.
  const cur = await factsInScope(home, (await e.currentFacts()).filter((f) => f.entity && f.value), scope);
  if (!cur.length) return [];
  const matched = new Set(matchEntities(q, [...new Set(cur.map((f) => f.entity!))]));
  if (!matched.size) return [];
  const all: FactHit[] = [];
  for (const ent of matched) {
    try {
      all.push(...(await e.timeline(ent, { limit: 200 })));
    } catch {
      /* ignora */
    }
  }
  // timeline (histórico) também filtrada por escopo via página-fonte (fail-closed).
  const allScoped = await factsInScope(home, all, scope);
  const merged = [...allScoped, ...cur.filter((f) => matched.has(f.entity!) && f.predicate)];
  // P1-B (A2c/A3): MESMO pré-sort determinístico + dedupe + corte por relevância do
  // factsForQuery (ask.ts) — uma heurística, dois consumidores; fim do slice(0,60) alfabético.
  const ordered = merged
    .filter((f) => matched.has(f.entity!) && f.predicate)
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
    const k = `${f.entity}|${f.predicate}|${f.tier ?? ""}|${f.valid_from ?? ""}|${f.value}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return rankSeriesForQuestion(q, deduped, 60).map((f) => toFactItem(f as FactHitDecayed));
}

/** /api/ask → { answer, citations, facts, gaps? }. Espelha o handler inline do web-server.ts (mesma
 *  montagem de citations + normHit do selo) + acrescenta `facts` (a série). NÃO altera o motor ask(). */
export async function askHandler(
  home: string,
  q: string,
  k: number,
  scope?: Scope,
): Promise<{ answer: string; citations: RetrieveHitShape[]; facts: FactItem[]; gaps?: string[] }> {
  // BLOCKER fix: repassa o scope a TODA a cadeia. ask() já aplica fail-closed (retrieve/factsInScope/
  // percepcoesInScope com scope); o BFF é que não repassava → a prosa era sintetizada sobre o corpus
  // inteiro. Sem scope (chamada do BFF dono = owner/full-access) → undefined = comportamento atual.
  const r = await ask(home, q, k, scope);
  const sources: string[] = Array.isArray(r.sources) ? r.sources : [];
  const hits = (await retrieve(home, q, k, { scope })).map(normHit); // hits COM selo, já escopados (consistência)
  const bySlug = new Map(hits.map((h) => [h.slug, h]));
  const picked = sources.map((s) => bySlug.get(s)).filter(Boolean) as RetrieveHitShape[];
  const citations = picked.length ? picked : hits;
  const facts = await seriesForQuery(home, q, scope);
  const gaps = Array.isArray((r as { gaps?: string[] }).gaps) ? (r as { gaps?: string[] }).gaps : undefined;
  return { answer: r.answer, citations, facts, ...(gaps ? { gaps } : {}) };
}

/** Carga ANCORADA p/ o `done` do SSE (M18/S3 — seam do Integrador). citations(+selo)/facts SEM síntese:
 *  NÃO chama ask() (a prosa cara já foi streamada por askStream; re-chamar ask() = 2ª chamada LLM). Reusa
 *  retrieve+normHit+seriesForQuery — as MESMAS funções que askHandler usa pra montar a camada confiável.
 *  Custo: 1 retrieve + 1 seriesForQuery (recuperação barata), ZERO LLM. gaps fica de fora (a prosa já
 *  embute a seção "Lacunas:" no texto streamado). */
export async function askStreamPayload(
  home: string,
  q: string,
  k: number,
): Promise<{ citations: RetrieveHitShape[]; facts: FactItem[] }> {
  const citations = (await retrieve(home, q, k)).map(normHit); // hits COM selo (idêntico ao askHandler)
  const facts = await seriesForQuery(home, q);
  return { citations, facts };
}

export interface CostBreakdown {
  op?: string;
  model?: string;
  calls: number;
  cost_usd: number;
  tokens_in: number;
  tokens_out: number;
}
export interface CostRollup {
  calls: number;
  cost_usd_total: number;
  tokens_in_total: number;
  tokens_out_total: number;
  by_op: CostBreakdown[];
  by_model: CostBreakdown[];
}

/** /api/cost → CostRollup (M20). Soma o custo REAL de IA do brain (galeed_llm_usage: extração, síntese,
 *  perguntas, embeddings), com quebra por operação e por modelo. SÓ OWNER (D4): o brain `home` precisa
 *  estar em `brains` com role 'owner'. */
export async function costHandler(home: string, brains: Brain[]): Promise<CostRollup> {
  const b = brains.find((x) => x.id === home);
  if (!b || b.role !== "owner") throw new BffError(403, "custo é visível só pro dono do brain");
  return usageRollup(home);
}
