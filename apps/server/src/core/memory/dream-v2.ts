/** M24-B — SONHO v2: link-prediction no grafo de ENTIDADES (BRIEF M24 §3 D5).
 *  Conserta o dream legado (sleep.ts), que rodava vizinhos-em-comum CRUS no grafo de PÁGINAS
 *  (0 arestas no corpus real — M19) e era dominado por hubs. Aqui:
 *   - grafo REAL: entityGraph (M19) — nós = entidades com fatos; arestas = co-ocorrência + relações;
 *   - Adamic-Adar (Σ 1/ln grau) + Resource Allocation (Σ 1/grau): vizinho RARO em comum vale
 *     mais que hub; score = média das normalizações (calibrado no corpus — ver DESIGN-SPEC §2.1.3);
 *   - cap por grau (hub não vira ponta de par) + anti-hub estrutural (≥1 justificativa não-hub);
 *   - comunidades por label propagation DETERMINÍSTICO (sinal informativo — NÃO vira hipótese);
 *   - destino: fila de revisão M21 (motivo 'conexao_sugerida', id determinístico por par —
 *     re-sono não duplica); aprovar → ARESTA tipada no entityGraph, NUNCA fato (LEI III).
 *  100% determinístico — ZERO LLM (LEI I). NOOP é saída válida (LEI VI). */
import { createHash } from "node:crypto";
import { getEngine, type GraphData, type ReviewItemRow } from "../platform/engine.ts";

/** Defaults do detector — config como DADO (ADR-002): override por opts/flags, nunca mágica
 *  espalhada. maxDegree calibrado no corpus Accelera (hubs reais: grau 127, 120, 69). */
export const DREAM_DEFAULTS = {
  maxDegree: 60,     // grau > maxDegree ⇒ HUB: não vira ponta de par nem justificativa única
  minShared: 2,      // mínimo de vizinhos em comum pra um par ser candidato
  topK: 10,          // orçamento de hipóteses por sono (LEI V)
  minClusterSize: 3, // comunidade só vira sinal com ≥ 3 membros
  lpaMaxIter: 20,    // teto de iterações do label propagation
} as const;

export interface DreamV2Options {
  maxDegree?: number;
  minShared?: number;
  topK?: number;
  minClusterSize?: number;
  /** default true; false = dry-run (computa tudo, não escreve na fila). */
  enqueue?: boolean;
}

export interface DreamHypothesis {
  id: string;       // determinístico por PAR: sha256(`sonho|${a}|${b}`).slice(0,32), com a<b
  a: string;        // entidade (a < b lexicográfico — ordem normalizada)
  b: string;
  shared: string[]; // vizinhos em comum (evidência), ordenados por grau ASC (o mais raro primeiro)
  aa: number;       // Adamic-Adar bruto: Σ 1/ln(grau(v)) sobre shared
  ra: number;       // Resource Allocation bruto: Σ 1/grau(v) sobre shared
  score: number;    // [0..1] — média de (aa/maxAA, ra/maxRA) sobre o conjunto de candidatos
  text: string;     // frase PT determinística com os NÚMEROS (detector imprime números, não vibes)
}

export interface EntityCluster {
  id: string;        // determinístico: sha256(`cluster|${members.join("|")}`).slice(0,32)
  members: string[]; // ordenados ASC
  size: number;      // = members.length
  density: number;   // arestas internas / pares possíveis, [0..1]
}

export interface DreamV2Result {
  hypotheses: DreamHypothesis[]; // ≤ topK, ordenadas por score DESC (empate: chave do par ASC)
  clusters: EntityCluster[];     // sinal informativo (consumo: priorizador M24-A via M24-D — §2.2)
  enqueued: number;              // itens enviados a addReviewItems (0 em dry-run e no NOOP)
  noop: boolean;                 // LEI VI: true ⇔ hypotheses.length === 0 (nada foi escrito)
  graph: { nodes: number; edges: number; candidates: number };
}

/** Adjacência não-direcionada a partir de g.edges: dedup por par, ignora self-loop. */
function buildAdjacency(g: GraphData): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (!a || !b || a === b) return; // ignora self-loop
    (adj.get(a) ?? adj.set(a, new Set()).get(a)!).add(b);
    (adj.get(b) ?? adj.set(b, new Set()).get(b)!).add(a);
  };
  for (const e of g.edges) link(e.src, e.dst);
  return adj;
}

interface Candidate {
  a: string;
  b: string;
  shared: string[]; // já ordenado por grau ASC, empate alfabético
  aa: number;
  ra: number;
}

/** Conjunto de pares ELEGÍVEIS (antes do score/topK), com aa/ra brutos e shared ordenado. */
function eligiblePairs(g: GraphData, opts?: DreamV2Options): { adj: Map<string, Set<string>>; deg: (n: string) => number; cands: Candidate[] } {
  const maxDegree = opts?.maxDegree ?? DREAM_DEFAULTS.maxDegree;
  const minShared = opts?.minShared ?? DREAM_DEFAULTS.minShared;
  const adj = buildAdjacency(g);
  const deg = (n: string): number => adj.get(n)?.size ?? 0;
  const nodes = [...adj.keys()].sort();
  const cands: Candidate[] = [];

  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i] < nodes[j] ? nodes[i] : nodes[j];
      const b = nodes[i] < nodes[j] ? nodes[j] : nodes[i];
      const sa = adj.get(a)!, sb = adj.get(b)!;
      if (sb.has(a)) continue; // já ligados diretamente → não é descoberta
      if (deg(a) > maxDegree || deg(b) > maxDegree) continue; // cap por grau — hub não vira ponta
      const shared: string[] = [];
      for (const v of sa) if (sb.has(v)) shared.push(v);
      if (shared.length < minShared) continue;
      // anti-hub estrutural: ≥1 justificativa NÃO-hub
      if (!shared.some((v) => deg(v) <= maxDegree)) continue;
      // shared ordenado por grau ASC (mais raro primeiro), empate alfabético
      shared.sort((x, y) => deg(x) - deg(y) || (x < y ? -1 : x > y ? 1 : 0));
      let aa = 0, ra = 0;
      for (const v of shared) {
        const d = deg(v); // d >= 2 por construção (ligado a a E b) ⇒ ln(d) > 0
        aa += 1 / Math.log(d);
        ra += 1 / d;
      }
      cands.push({ a, b, shared, aa, ra });
    }
  }
  return { adj, deg, cands };
}

function hypId(a: string, b: string): string {
  return createHash("sha256").update(`sonho|${a}|${b}`).digest("hex").slice(0, 32);
}

function hypText(h: { a: string; b: string; shared: string[]; aa: number; ra: number; score: number }): string {
  return `${h.a} e ${h.b} compartilham ${h.shared.length} vizinhos (${h.shared.slice(0, 3).join(", ")}) sem ligação direta no mapa — pode existir relação. Sinal: AA ${h.aa.toFixed(2)} · RA ${h.ra.toFixed(3)} · score ${h.score.toFixed(2)}.`;
}

/** Link-prediction PURO sobre o grafo (sem IO/env/clock) — exportado pra teste e pro gate
 *  no corpus real (§5.E roda isto sobre o entityGraph do Accelera, leitura). */
export function predictLinks(g: GraphData, opts?: DreamV2Options): DreamHypothesis[] {
  const topK = opts?.topK ?? DREAM_DEFAULTS.topK;
  const { cands } = eligiblePairs(g, opts);
  if (!cands.length) return [];
  const maxAA = Math.max(...cands.map((c) => c.aa));
  const maxRA = Math.max(...cands.map((c) => c.ra));
  const scored = cands.map((c) => {
    const score = ((maxAA > 0 ? c.aa / maxAA : 0) + (maxRA > 0 ? c.ra / maxRA : 0)) / 2;
    return { ...c, score };
  });
  // score DESC; empate → `${a}|${b}` ASC
  scored.sort((x, y) => {
    if (y.score !== x.score) return y.score - x.score;
    const kx = `${x.a}|${x.b}`, ky = `${y.a}|${y.b}`;
    return kx < ky ? -1 : kx > ky ? 1 : 0;
  });
  return scored.slice(0, topK).map((c) => {
    const base = { id: hypId(c.a, c.b), a: c.a, b: c.b, shared: c.shared, aa: c.aa, ra: c.ra, score: c.score };
    return { ...base, text: hypText(base) };
  });
}

/** Comunidades por label propagation determinístico, PURO (sem IO). Hubs (grau > maxDegree)
 *  ficam FORA do cálculo (pertencem a "tudo" e colapsam a partição). */
export function detectClusters(g: GraphData, opts?: DreamV2Options): EntityCluster[] {
  const maxDegree = opts?.maxDegree ?? DREAM_DEFAULTS.maxDegree;
  const minClusterSize = opts?.minClusterSize ?? DREAM_DEFAULTS.minClusterSize;
  const maxIter = DREAM_DEFAULTS.lpaMaxIter;

  // grau no grafo COMPLETO (define hub)
  const fullAdj = buildAdjacency(g);
  const fullDeg = (n: string): number => fullAdj.get(n)?.size ?? 0;

  // 1) subgrafo sem hubs — só nós com grau <= maxDegree e arestas entre eles
  const subNodes = [...fullAdj.keys()].filter((n) => fullDeg(n) <= maxDegree);
  const subSet = new Set(subNodes);
  // vizinhos no subgrafo + peso por par (somatório dos weights das arestas, default 1)
  const subAdj = new Map<string, Map<string, number>>();
  for (const n of subNodes) subAdj.set(n, new Map());
  for (const e of g.edges) {
    if (!subSet.has(e.src) || !subSet.has(e.dst) || e.src === e.dst) continue;
    const w = typeof e.weight === "number" ? e.weight : 1;
    const ma = subAdj.get(e.src)!, mb = subAdj.get(e.dst)!;
    ma.set(e.dst, (ma.get(e.dst) ?? 0) + w);
    mb.set(e.src, (mb.get(e.src) ?? 0) + w);
  }

  // 2) label inicial = próprio id
  const label = new Map<string, string>();
  for (const n of subNodes) label.set(n, n);

  // 3) iterar em ordem lexicográfica ASC (in-place), até estabilizar ou maxIter
  const ordered = [...subNodes].sort();
  for (let it = 0; it < maxIter; it++) {
    let changed = false;
    for (const n of ordered) {
      const nbrs = subAdj.get(n)!;
      if (!nbrs.size) continue; // sem vizinho no subgrafo → mantém próprio label
      // soma de weight por label dos vizinhos; empate → label lexicograficamente MENOR
      const weightByLabel = new Map<string, number>();
      for (const [m, w] of nbrs) {
        const lm = label.get(m)!;
        weightByLabel.set(lm, (weightByLabel.get(lm) ?? 0) + w);
      }
      let best = "";
      let bestW = -Infinity;
      for (const [lab, w] of weightByLabel) {
        if (w > bestW || (w === bestW && lab < best)) {
          best = lab;
          bestW = w;
        }
      }
      if (best && best !== label.get(n)) {
        label.set(n, best);
        changed = true;
      }
    }
    if (!changed) break;
  }

  // 4) agrupa por label
  const groups = new Map<string, string[]>();
  for (const n of subNodes) {
    const l = label.get(n)!;
    (groups.get(l) ?? groups.set(l, []).get(l)!).push(n);
  }

  const clusters: EntityCluster[] = [];
  for (const members of groups.values()) {
    if (members.length < minClusterSize) continue;
    members.sort();
    const mset = new Set(members);
    // arestas internas (não-direcionadas, dedup) entre membros, no subgrafo
    let internal = 0;
    const counted = new Set<string>();
    for (const m of members) {
      for (const other of subAdj.get(m)!.keys()) {
        if (!mset.has(other)) continue;
        const key = m < other ? `${m}>${other}` : `${other}>${m}`;
        if (counted.has(key)) continue;
        counted.add(key);
        internal++;
      }
    }
    const size = members.length;
    const possible = (size * (size - 1)) / 2;
    const density = possible > 0 ? internal / possible : 0;
    const id = createHash("sha256").update(`cluster|${members.join("|")}`).digest("hex").slice(0, 32);
    clusters.push({ id, members, size, density });
  }

  // 5) ordena por size DESC, empate por id ASC
  clusters.sort((x, y) => (y.size - x.size) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  return clusters;
}

function toReviewItem(h: DreamHypothesis): ReviewItemRow {
  return {
    id: h.id,                 // determinístico por par (§2.1.2-7)
    source_id: "",            // hipótese do SONO — não nasce de fonte M21
    source_slug: "",          // nem de página (colunas NOT NULL default '' — verificado no schema)
    dimension: "conexao",
    text: h.text,
    quote: "",                // não há trecho literal — a evidência é estrutural (claim.shared)
    claim: { origem: "sonho-v2", a: h.a, b: h.b, shared: h.shared, aa: h.aa, ra: h.ra, score: h.score, kind: "conexao" },
    reason: "conexao_sugerida",
    status: "pendente",
    decided_by: "",
    decided_at: null,
  };
}

/** O sono v2 do brain: lê o entityGraph, prevê links, detecta clusters e enfileira as
 *  hipóteses na fila M21. NOOP (LEI VI): hypotheses vazio ⇒ NENHUMA escrita (addReviewItems
 *  nem é chamado). */
export async function dreamV2(home: string, opts: DreamV2Options = {}): Promise<DreamV2Result> {
  const e = await getEngine(home);
  const g = await e.entityGraph(); // defaults do M19 (minFacts 3, minShared 2, maxNodes 240)
  const hypotheses = predictLinks(g, opts);
  const clusters = detectClusters(g, opts);
  const candidates = eligiblePairs(g, opts).cands.length; // nº de pares elegíveis ANTES do topK
  const enqueue = opts.enqueue !== false;
  let enqueued = 0;
  if (enqueue && hypotheses.length) {        // LEI VI: vazio ⇒ NENHUMA escrita
    await e.addReviewItems(hypotheses.map(toReviewItem));
    enqueued = hypotheses.length;            // o dedup é do banco (on conflict do nothing)
  }
  return {
    hypotheses,
    clusters,
    enqueued,
    noop: hypotheses.length === 0,
    graph: { nodes: g.nodes.length, edges: g.edges.length, candidates },
  };
}
