/** CAMADA 3 — leitura: search / retrieve / get / facts / graph / stats.
 *  Casca fina sobre o engine ativo (SQLite ou Supabase). Sem LLM. */
import { getEngine, type Hit, type FactHit, type FactsOpts } from "../platform/engine.ts";
import { semanticSearch } from "./embeddings.ts";
import { recencyFactor } from "../memory/recency.ts";
import { effectiveConfidence } from "../memory/health.ts";
import { rerank, rerankAvailable } from "./reranker.ts";
import { chatComplete } from "../../lib/openai.ts";
import { inScope, type Scope } from "../access/scope.ts";
import { isTechTag } from "../ingestion/tags.ts";

/** HyDE/query-expansion (M6/D7): gera um "trecho hipotético" que responde a pergunta e o concatena à
 *  query SÓ para o embedding — casa o vocabulário do documento (query factual ≠ texto do chunk). FTS e
 *  reranker continuam usando a query REAL (intenção). Opt-in via GALEED_QUERY_EXPANSION=1; cacheado. */
const _expCache = new Map<string, string>();
async function expandForEmbedding(q: string): Promise<string> {
  if (process.env.GALEED_QUERY_EXPANSION !== "1") return q;
  if (_expCache.has(q)) return _expCache.get(q)!;
  const ans = await chatComplete(
    `Pergunta: ${q}\n\nEscreva 1–2 frases curtas como se fossem um TRECHO de documento que RESPONDE a pergunta — com os termos, números e nomes prováveis. Não diga que não sabe; gere plausível (é só para casar a busca).`,
    "Você gera um documento hipotético curto (HyDE) para melhorar a busca semântica. Responda só o trecho, sem preâmbulo.",
    { maxTokens: 100 },
  ).catch(() => "");
  const out = ans ? `${q}\n${ans}` : q;
  _expCache.set(q, out);
  return out;
}

export type { Hit, FactHit, FactsOpts } from "../platform/engine.ts";

export async function search(home: string, q: string, k = 8, type?: string, scope?: Scope): Promise<Hit[]> {
  const e = await getEngine(home);
  const hits = await e.search(q, k, type);
  if (!scope) return hits;
  // `Hit` não traz tags/sensitivity → buscar as páginas e filtrar (filtro espelho).
  const pages = await e.pagesBySlug(hits.map((h) => h.slug));
  return hits.filter((h) => {
    const p = pages.get(h.slug);
    return !!p && inScope({ type: p.type, tags: p.tags, sensitivity: p.sensitivity }, scope);
  });
}

/** SELO EPISTÊMICO — metadados determinísticos anexados a cada trecho, pra a LLM consumidora
 *  raciocinar sobre a QUALIDADE da memória (não só o texto). Montado sem LLM, sem custo.
 *  v0.3 MVP: eixos de PROVENIÊNCIA (status/natureza/fonte/valid_from/via/cite). Os eixos
 *  epistêmicos plenos (confidence + valid_to + supersede + tags semânticas) entram com a
 *  camada de FATOS bitemporal. Ver ARQUITETURA-MEMORIA-v0.3.md §Selo Epistêmico. */
export interface Selo {
  /** estado epistêmico. Trecho de FONTE = "registrado" (é registro, não juízo).
   *  "fato"/"hipotese"/"arquivado" passam a valer quando o hit vier da camada de fatos. */
  status: "registrado" | "fato" | "hipotese" | "arquivado";
  natureza: string; // o que é: reuniao, decisao, cliente, conceito, nota...
  fonte: string; // proveniência legível derivada da natureza (call, registro, doc...)
  valid_from: string; // valid-time: data da fonte (placeholder até o bitemporal pleno)
  via: "vec" | "fts" | "grafo"; // qual sinal recuperou (peso/debug)
  cite: string; // slug pra buscar o detalhe
  tags: string[]; // tags semânticas (eixo DINÂMICO — emerge do negócio; ver tags.ts)
}

/** Proveniência legível por tipo de fonte (determinístico, curado — não tag livre). */
const FONTE_POR_TIPO: Record<string, string> = {
  reunioes: "reunião/call",
  clientes: "registro de cliente",
  decisoes: "decisão registrada",
  produtos: "doc de produto",
  conceitos: "nota conceitual",
  pessoas: "perfil de pessoa",
  notas: "nota",
};

/** exportado p/ teste unit (função pura). Só tags SEMÂNTICAS entram no selo: as técnicas
 *  (src:<uuid>, doc:<sha16>, canal:, area:, fonte: — isTechTag) são proveniência/escopo, não
 *  semântica do negócio — `[#src:3f2a…]` no header seria ruído apresentado à LLM como significado. */
export function montarSelo(type: string, date: string, slug: string, via: Selo["via"], tags: string[]): Selo {
  return {
    status: "registrado",
    natureza: type || "nota",
    fonte: FONTE_POR_TIPO[type] || "registro",
    valid_from: date || "",
    via,
    cite: slug,
    tags: (tags || []).map((t) => String(t).trim().toLowerCase()).filter((t) => t && !isTechTag(t)),
  };
}

/** Cabeçalho legível do selo (modo humano/texto).
 *  Ex.: `[registrado · reunião/call] [12/jun] [#pricing #estrategia] [via:vec] [cite:slug]` */
export function seloHeader(s: Selo): string {
  const parts = [`[${s.status} · ${s.fonte}]`];
  if (s.valid_from) parts.push(`[${s.valid_from}]`);
  if (s.tags.length) parts.push(`[${s.tags.map((t) => "#" + t).join(" ")}]`);
  parts.push(`[via:${s.via}]`, `[cite:${s.cite}]`);
  return parts.join(" ");
}

export interface RetrieveStage {
  base: number; // score pós-RRF/graph já com recency
  recency: number; // fator de recência (S1)
  salience: number; // fator de salience-boost (S4)
  final: number; // score final usado no ranking
}
export interface RetrieveHit {
  slug: string;
  type: string;
  title: string;
  date: string;
  excerpt: string;
  citation: string;
  via: "vec" | "fts" | "grafo";
  score: number; // score de fusão RRF (determinístico)
  selo: Selo;
  stage?: RetrieveStage; // só quando explain=true (M3/S4)
}

const RRF_K = 60; // constante padrão do Reciprocal Rank Fusion (Cormack et al.)

/** Modo agente-nativo HÍBRIDO com FUSÃO RRF + GRAPH-EXPANSION (tudo determinístico, sem LLM):
 *  1. roda busca semântica (se disponível) e FTS em paralelo, cada uma um ranking;
 *  2. funde os rankings por Reciprocal Rank Fusion: score = Σ 1/(K + rank) — robusto a escalas
 *     diferentes (cosine vs bm25), sem precisar normalizar;
 *  3. graph-expansion: segue os [[wikilinks]] (1 salto) dos top hits e injeta vizinhos ainda não
 *     presentes com um peso menor — recall de coisas ligadas que a busca textual não pegou.
 *  Cada hit volta com SELO EPISTÊMICO — o trecho NUNCA é nu. */
const SAL_K = 0.25; // força do salience-boost (log-comprimido)

export async function retrieve(home: string, q: string, k = 6, opts?: { explain?: boolean; scope?: Scope }): Promise<RetrieveHit[]> {
  // M6/D1: com reranker, busca um pool FUNDO de candidatos (recall) e deixa o reranker fazer a
  // precisão; sem reranker, mantém o pool enxuto da fusão pura.
  const reranking = rerankAvailable();
  // recall NÃO pode escalar com k: o reranker precisa de um pool FUNDO de candidatos sempre (senão
  // o doc certo nem entra). Piso de 150 candidatos quando há reranker (medido: pool raso derruba recall@6).
  const pool = reranking ? Math.max(k * 8, Number(process.env.GALEED_RETRIEVE_POOL || 150)) : Math.max(k * 3, 12);
  const semText = await expandForEmbedding(q); // HyDE p/ o vetor; FTS/rerank usam a query real
  const [sem, fts] = await Promise.all([
    semanticSearch(home, q, pool, true, semText).catch(() => null),
    search(home, q, pool),
  ]);

  // acumula score RRF por slug, guardando o melhor excerpt/texto/metadados e a via de maior peso.
  // `text` é o melhor trecho disponível p/ o reranker (chunk do vetor > excerpt do FTS).
  interface Acc { slug: string; type: string; title: string; date: string; excerpt: string; text: string; score: number; via: RetrieveHit["via"]; }
  const acc = new Map<string, Acc>();
  const bump = (slug: string, rank: number, via: RetrieveHit["via"], data: Partial<Acc>) => {
    const add = 1 / (RRF_K + rank);
    const cur = acc.get(slug);
    if (cur) {
      cur.score += add;
      if (!cur.excerpt && data.excerpt) cur.excerpt = data.excerpt;
      // p/ rerank: prefere o chunk do vetor, ou o texto mais longo disponível
      if (data.text && (data.via === "vec" || data.text.length > (cur.text?.length || 0))) cur.text = data.text;
      if (data.via === "vec") cur.via = "vec"; // vetor ganha como via exibida (semântico > lexical)
    } else {
      acc.set(slug, { slug, type: data.type || "", title: data.title || slug, date: data.date || "", excerpt: data.excerpt || "", text: data.text || data.excerpt || "", score: add, via });
    }
  };

  (sem ?? []).forEach((s, i) => bump(s.slug, i, "vec", { type: s.type, title: s.title, date: s.date, excerpt: s.text.slice(0, 220), text: s.text, via: "vec" }));
  fts.forEach((h, i) => bump(h.slug, i, "fts", { type: h.type, title: h.title, date: h.date, excerpt: h.excerpt, text: h.excerpt }));

  // --- graph-expansion: 1 salto de wikilink a partir dos top hits diretos ---
  const top = [...acc.values()].sort((a, b) => b.score - a.score).slice(0, k);
  const e = await getEngine(home);
  const nbrs = await e.neighbors(top.map((t) => t.slug)).catch(() => new Map<string, string[]>());
  const fresh = new Set<string>();
  for (const list of nbrs.values()) for (const n of list) if (!acc.has(n)) fresh.add(n);
  if (fresh.size) {
    const pages = await e.pagesBySlug([...fresh]).catch(() => new Map());
    for (const slug of fresh) {
      const p = pages.get(slug);
      // vizinho fantasma (wikilink sem página) OU ARQUIVADO — ignora na expansão. As arestas pra
      // página arquivada persistem em galeed_edges (setArchived não as toca), então sem o check de
      // p.archived a lixeira voltava via 'grafo' com selo 'registrado' (achado decaimento-lixeira#2).
      if (!p || p.archived) continue;
      // peso de vizinho: equivalente a um rank baixo (entra só se sobrar espaço)
      acc.set(slug, { slug, type: p.type, title: p.title, date: p.date, excerpt: (p.body || "").slice(0, 220), text: (p.body || "").slice(0, 800), score: 1 / (RRF_K + pool + 5), via: "grafo" });
    }
  }

  // páginas dos candidatos (uma query): salience (boost) + tags (selo). Antes do sort p/ o boost rankear.
  const candPages = await e.pagesBySlug([...acc.keys()]).catch(() => new Map());

  // --- FILTRO ESPELHO (camada 2 / S2): least-privilege fail-closed. ---
  // Roda APÓS candPages (única fonte de tags+sensitivity) e cobre diretos + vizinhos de grafo numa
  // varredura só. Slug sem página em candPages (fantasma) → fora quando há escopo (fail-closed).
  if (opts?.scope) {
    const scope = opts.scope;
    for (const slug of [...acc.keys()]) {
      const p = candPages.get(slug);
      if (!p || !inScope({ type: p.type, tags: p.tags, sensitivity: p.sensitivity }, scope)) acc.delete(slug);
    }
  }

  const stages = new Map<string, RetrieveStage>();
  for (const a of acc.values()) {
    const rec = recencyFactor(a.date, a.type); // S1
    const base = a.score * rec; // RRF/graph × recência
    const sal = candPages.get(a.slug)?.salience ?? 0; // S3
    const salBoost = 1 + SAL_K * Math.log(1 + sal * 8); // S4: sal∈[0,1] → boost∈[1,~1.5]
    a.score = base * salBoost;
    if (opts?.explain) stages.set(a.slug, { base, recency: rec, salience: salBoost, final: a.score });
  }
  // M6/D1: ordena por fusão (recall) e, havendo reranker, ele é o ÁRBITRO da precisão (top-k final).
  const ranked = [...acc.values()].sort((a, b) => b.score - a.score);
  const RERANK_POOL = Number(process.env.GALEED_RERANK_POOL || 50); // candidatos enviados ao reranker
  let final: Acc[] = ranked.slice(0, k);
  const rerankScore = new Map<string, number>();
  if (reranking) {
    const cands = ranked.slice(0, RERANK_POOL);
    const rr = await rerank(q, cands.map((a) => ({ id: a.slug, text: a.text || a.excerpt || a.title })), k, home).catch(() => null);
    if (rr && rr.length) {
      const byId = new Map(ranked.map((a) => [a.slug, a]));
      for (const h of rr) rerankScore.set(h.id, h.score);
      final = rr.map((h) => byId.get(h.id)).filter((a): a is Acc => !!a);
    }
  }
  return final.map((a) => ({
    slug: a.slug,
    type: a.type,
    title: a.title,
    date: a.date,
    excerpt: a.excerpt,
    citation: `[[${a.slug}]]`,
    via: a.via,
    score: rerankScore.get(a.slug) ?? a.score,
    selo: montarSelo(a.type, a.date, a.slug, a.via, candPages.get(a.slug)?.tags ?? []),
    ...(opts?.explain ? { stage: stages.get(a.slug) } : {}),
  }));
}

/** Açúcar p/ o CLI `retrieve --explain`: retorna os hits com o breakdown de score. */
export async function retrieveExplained(home: string, q: string, k = 6): Promise<RetrieveHit[]> {
  return retrieve(home, q, k, { explain: true });
}

export async function getPage(home: string, slug: string) {
  const e = await getEngine(home);
  return e.getPage(slug);
}

/** FactHit com a confiança EFETIVA (decaída no tempo); `raw_confidence` preserva o valor armazenado. */
export type FactHitDecayed = FactHit & { raw_confidence?: number };

export async function facts(home: string, dimension: string, opts: FactsOpts = {}): Promise<FactHitDecayed[]> {
  const e = await getEngine(home);
  const rows = await e.facts(dimension, opts);
  // decay de LEITURA (M3/S3): a confiança envelhece; o valor cru fica preservado em raw_confidence.
  return rows.map((f) => ({
    ...f,
    raw_confidence: f.confidence,
    confidence: f.confidence != null ? effectiveConfidence(f.confidence, f.valid_from || "", f.dimension) : f.confidence,
  }));
}

/** Linha do tempo bitemporal de uma entidade (como o cérebro "mudou de ideia"). */
export async function timeline(home: string, entity: string, opts: { predicate?: string; limit?: number } = {}) {
  const e = await getEngine(home);
  const canonical = await e.resolveEntity(entity); // alias ("Acme Corp") → canônico ("acme")
  return e.timeline(canonical, opts);
}

/** Cabeçalho de selo para um FATO bitemporal (mais rico que o de fonte): inclui status real,
 *  confiança e janela de validade. Ex.: `[FATO · conf 0.92 · decisoes] [válido 2026-06-12 → agora]` */
export function factSeloHeader(f: FactHit): string {
  const status = (f.status || "fato").toUpperCase();
  const conf = typeof f.confidence === "number" ? ` · conf ${f.confidence.toFixed(2)}` : "";
  const parts = [`[${status}${conf} · ${f.dimension}]`];
  if (f.valid_from || f.valid_to) {
    const ate = f.valid_to ? f.valid_to : "agora";
    parts.push(`[válido ${f.valid_from || "?"} → ${ate}]`);
  }
  parts.push(`[cite:${f.source_slug}]`);
  return parts.join(" ");
}

export async function graph(home: string, slug: string) {
  const e = await getEngine(home);
  return e.graph(slug);
}

/** Grafo inteiro (nós+arestas) para visualização estilo Obsidian. */
export async function graphAll(home: string) {
  const e = await getEngine(home);
  return e.graphAll();
}

/** Grafo de ENTIDADES (o Mapa do cérebro): entidades + co-ocorrência/relações. */
export async function entityGraph(home: string, opts?: { minFacts?: number; minShared?: number; maxNodes?: number }) {
  const e = await getEngine(home);
  return e.entityGraph(opts);
}

/** Fatos ligados a UMA entidade (saída/entrada) — alimenta o inspetor do Mapa. */
export async function entityFacts(home: string, node: string, opts?: { currentOnly?: boolean; limit?: number }) {
  const e = await getEngine(home);
  return e.graphQuery(node, { currentOnly: opts?.currentOnly ?? false, limit: opts?.limit ?? 200 });
}

export async function stats(home: string) {
  const e = await getEngine(home);
  return e.stats();
}
