/** RESOLUÇÃO DE ENTIDADE — canonicalização do SUJEITO dos fatos (#R3 do RISCOS.md).
 *
 *  Problema: o extract gera a MESMA entidade real com nomes diferentes ("acme", "acme corp",
 *  "acme inc"). A supersessão bitemporal agrupa por (entity, predicate), então nomes distintos
 *  fragmentam o histórico — timelines e grafo apodrecem em silêncio ao longo do tempo.
 *
 *  Solução (espelha src/core/reconcile.ts, que faz o mesmo para PREDICADO): clusteriza nomes
 *  similares por similaridade determinística (edit + token + contenção), elege um canônico, e
 *  grava o mapa alias→canônico (galeed_entity_resolve). O `organize` reescreve a entidade antes
 *  da supersessão. O LLM é opt-in só pra desempatar o canônico — o agrupamento é grátis. */
import { config } from "../platform/config.ts";
import { resolveProvider, prose, structured, type Provider } from "../../lib/llm.ts";
import { getEngine, type EntityResolveMap, type GraphQueryHit } from "../platform/engine.ts";
import { createHash } from "node:crypto";

export interface EntityMerge {
  canonical: string;
  aliases: string[];
}
export interface ResolveEntitiesResult {
  entities: number; // nº de entidades distintas vistas
  merges: EntityMerge[]; // grupos REALIZADOS (forte + ambíguo desempatado) com ≥2 nomes
  provider: "deterministico" | "cli" | "api";
}

/** Fix sobre-fusão (#R3): a clusterização separa o sinal FORTE (grafia/token — funde sozinho,
 *  determinístico) do FRACO (contenção de tokens — ambíguo, precisa desempate). */
export interface ClusterResult {
  /** grupos ligados por sinal FORTE (coerentes) — fundem SEMPRE, sem LLM. */
  strong: EntityMerge[];
  /** grupos ambíguos (ponte por contenção OU componente forte incoerente) — vão pro desempate. */
  ambiguous: string[][];
}

// ---------- similaridade (determinística) ----------

/** distância de edição normalizada (0=idêntico, 1=totalmente diferente) → similaridade. */
function editSim(a: string, b: string): number {
  const m = a.length,
    n = b.length;
  if (!m || !n) return 0;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return 1 - d[m][n] / Math.max(m, n);
}

function tokens(s: string): Set<string> {
  return new Set(s.split(/[\s_]+/).filter(Boolean));
}

/** sobreposição de tokens (Jaccard). "acme corp" vs "acme inc" → 1/3. */
function tokenSim(a: string, b: string): number {
  const ta = tokens(a),
    tb = tokens(b);
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / new Set([...ta, ...tb]).size;
}

/** contenção: os tokens de um são subconjunto dos do outro (ex.: {acme} ⊂ {acme, corp}).
 *  Só conta com ≥1 token em comum e o menor tendo ≥1 token (evita casar tudo com tudo). */
function contains(a: string, b: string): boolean {
  const ta = tokens(a),
    tb = tokens(b);
  if (!ta.size || !tb.size) return false;
  const [small, big] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  for (const t of small) if (!big.has(t)) return false;
  return true;
}

/** caixa-baixa sem acentos (mesmo fold de ground.ts/ask.ts). */
const foldAccents = (s: string): string => s.toLowerCase().normalize("NFD").replace(/\p{M}+/gu, "");

/** SINAL FORTE — variantes genuínas: grafia quase idêntica (editSim) OU forte sobreposição de
 *  tokens (tokenSim). Funde SOZINHO, sem LLM. NÃO inclui contenção — essa é o vetor do over-merge.
 *
 *  DESVIO DA SPEC (justificado): a spec lista `silvia/sílvia` como merge FORTE por editSim, mas o
 *  editSim CRU delas é 0.833 (<0.85) e o tokenSim é 0 → não fundiriam, quebrando o anti-under-merge
 *  OBRIGATÓRIO. Por isso o forte também compara a forma SEM ACENTO (fold): "sílvia"→"silvia"→
 *  idênticas. editSim/tokenSim seguem intactos (spec: "ficam como estão"); o fold é sinal ADICIONAL,
 *  acento-insensível, que só COLAPSA variação diacrítica (não cria over-merge novo). */
function strongSame(a: string, b: string): boolean {
  if (editSim(a, b) >= 0.85 || tokenSim(a, b) >= 0.6) return true;
  const fa = foldAccents(a),
    fb = foldAccents(b);
  if (fa === a && fb === b) return false; // nada a folder → sem sinal novo
  return fa === fb || editSim(fa, fb) >= 0.85 || tokenSim(fa, fb) >= 0.6;
}

/** SINAL FRACO — contenção (prefixo/subconjunto de tokens) que NÃO é forte. Ambíguo: "joão" ⊂
 *  "joão silva" pode ser a mesma pessoa (nome completo) OU não (homônimo) → desempate, não funde só. */
function weakContains(a: string, b: string): boolean {
  return !strongSame(a, b) && contains(a, b);
}

// ---------- clusterização (PURA) ----------

/** Canônico de um grupo: mais frequente (empate → mais curto → ordem estável). */
function canonicalOf(group: string[], freq: Map<string, number>): string {
  return group.slice().sort((a, b) => (freq.get(b)! - freq.get(a)!) || a.length - b.length || (a < b ? -1 : 1))[0];
}

/** Dado { entidadeLowercase: frequência }, separa em dois tiers (fix sobre-fusão #R3):
 *  - `strong`: componentes ligados por sinal FORTE e COERENTES → fundem sozinhos (determinístico).
 *  - `ambiguous`: componentes ligados só por sinal FRACO (contenção) OU componentes fortes
 *    INCOERENTES (ponte transitiva) → vão pro desempate por LLM (ou conservador sem LLM).
 *
 *  Coerência (DESVIO justificado do pseudocódigo): um componente forte de ≥3 nomes só funde sozinho
 *  se for CLIQUE de strongSame. Se dois membros só se ligam por PONTE transitiva (ex.: "joão silva"
 *  é forte com "…santos" E com "…souza" via tokenSim 2/3, mas "…santos"≁"…souza"), o componente é
 *  AMBÍGUO. Isso REALIZA a matriz OBRIGATÓRIA da spec ("cadeia de 2-token bridge → ambiguous, não
 *  funde santos~souza direto"), que o union-find forte PURO (pseudocódigo) violaria — a mesma
 *  ponte-transitiva que o fix combate no `contains` reaparece no tokenSim≥0.6. Honra "na dúvida não
 *  funde". Componentes de 2 nomes são sempre clique (1 par forte) → nunca caem aqui. */
export function clusterEntities(freq: Map<string, number>): ClusterResult {
  const names = [...freq.keys()];

  // (1) union-find FORTE (transitivo) sobre TODOS os nomes.
  const parent = new Map(names.map((n) => [n, n]));
  const find = (x: string): string => (parent.get(x) === x ? x : parent.set(x, find(parent.get(x)!)).get(x)!);
  for (let i = 0; i < names.length; i++)
    for (let j = i + 1; j < names.length; j++) if (strongSame(names[i], names[j])) parent.set(find(names[i]), find(names[j]));

  const strongComps = new Map<string, string[]>();
  for (const n of names) (strongComps.get(find(n)) ?? strongComps.set(find(n), []).get(find(n))!).push(n);

  const strong: EntityMerge[] = [];
  const ambiguous: string[][] = [];
  const consumed = new Set<string>(); // nomes já resolvidos por um componente FORTE (coerente ou não)

  for (const group of strongComps.values()) {
    if (group.length < 2) continue; // singleton → participa do passo FRACO
    let clique = true;
    for (let i = 0; i < group.length && clique; i++)
      for (let j = i + 1; j < group.length; j++)
        if (!strongSame(group[i], group[j])) {
          clique = false;
          break;
        }
    if (clique) {
      const canonical = canonicalOf(group, freq);
      strong.push({ canonical, aliases: group.filter((g) => g !== canonical) });
    } else ambiguous.push(group.slice().sort());
    for (const n of group) consumed.add(n); // resolvido — NÃO reentra no passo FRACO (evita duplo destino)
  }

  // (2) union-find FRACO só sobre os nomes LIVRES (strong-singletons): um grupo ambíguo é um
  //     componente FRACO com ≥2 nomes (contenção cruzada). 1 nome = sem ponte = não ambíguo.
  const free = names.filter((n) => !consumed.has(n));
  const wparent = new Map(free.map((n) => [n, n]));
  const wfind = (x: string): string => (wparent.get(x) === x ? x : wparent.set(x, wfind(wparent.get(x)!)).get(x)!);
  for (let i = 0; i < free.length; i++)
    for (let j = i + 1; j < free.length; j++) if (weakContains(free[i], free[j])) wparent.set(wfind(free[i]), wfind(free[j]));

  const weakComps = new Map<string, string[]>();
  for (const n of free) (weakComps.get(wfind(n)) ?? weakComps.set(wfind(n), []).get(wfind(n))!).push(n);
  for (const group of weakComps.values()) if (group.length >= 2) ambiguous.push(group.slice().sort());

  return { strong, ambiguous };
}

// ---------- orquestração ----------

/** Conta as entidades distintas (lowercase) sobre todas as extrações do brain. */
async function entityFrequency(home: string): Promise<Map<string, number>> {
  const e = await getEngine(home);
  const freq = new Map<string, number>();
  for (const ex of await e.allExtractions()) {
    for (const arr of Object.values(ex.extractions || {})) {
      if (!Array.isArray(arr)) continue;
      for (const it of arr as any[]) {
        const ent = String(it.entity || "").toLowerCase().trim();
        if (!ent) continue;
        freq.set(ent, (freq.get(ent) ?? 0) + 1);
      }
    }
  }
  return freq;
}

/** Sanitiza a partição vinda da LLM: mantém só nomes ∈ `uniq`, deduplica (1º subgrupo vence),
 *  descarta nomes INVENTADOS (não ∈ uniq), e completa qualquer nome de uniq NÃO citado como
 *  singleton próprio. Determinística e testável — NUNCA perde nem inventa entidade. */
export function normalizePartition(grupos: unknown, uniq: string[]): string[][] {
  const allow = new Set(uniq);
  const seen = new Set<string>();
  const parts: string[][] = [];
  if (Array.isArray(grupos)) {
    for (const g of grupos) {
      if (!Array.isArray(g)) continue;
      const sub: string[] = [];
      for (const raw of g) {
        const name = String(raw).toLowerCase().trim();
        if (allow.has(name) && !seen.has(name)) {
          seen.add(name);
          sub.push(name);
        }
      }
      if (sub.length) parts.push(sub);
    }
  }
  for (const n of uniq) if (!seen.has(n)) parts.push([n]); // não citado → singleton (não funde)
  return parts;
}

/** Desempata um grupo AMBÍGUO: quais nomes são a MESMA entidade real? Devolve a PARTIÇÃO (lista de
 *  subgrupos). Conservador por padrão: sem LLM permitido/disponível → cada nome sozinho (NÃO funde —
 *  "na dúvida não funde", já é melhor que o over-merge de hoje). Cacheado por assinatura do grupo
 *  (galeed_entity_disambig) — perguntado 1× e estável, não re-pergunta toda ingestão. Fail-soft: LLM
 *  que lança vira conservador e NÃO cacheia (re-tenta quando houver LLM). */
export async function disambiguateGroup(
  home: string,
  names: string[],
  o: { provider: string; allow: boolean },
): Promise<string[][]> {
  const uniq = [...new Set(names.map((n) => n.toLowerCase().trim()))].sort();
  if (!o.allow || (o.provider !== "cli" && o.provider !== "api")) return uniq.map((n) => [n]); // conservador (0 LLM)
  const e = await getEngine(home);
  const key = createHash("sha256").update(uniq.join("")).digest("hex").slice(0, 32); // idioma de hash do repo
  const cached = await e.getEntityDisambig(key);
  if (cached) return cached; // cache hit → NÃO chama LLM
  try {
    const cfg = config(home);
    const out = await structured({
      provider: o.provider as Provider,
      model: o.provider === "cli" ? cfg.cliModel : cfg.apiModel,
      system:
        "Você agrupa nomes de entidades de negócio (pessoas/empresas). Nomes que se referem à MESMA entidade real ficam no MESMO grupo; nomes que se referem a entidades DIFERENTES ficam separados. Um nome curto/ambíguo (ex.: só o primeiro nome) que pode ser mais de uma pessoa fica SOZINHO. Na dúvida, separe.",
      prompt: `Nomes: ${uniq.join(", ")}`,
      tool: {
        name: "agrupar",
        description: "Partição dos nomes em entidades reais.",
        input_schema: {
          type: "object",
          required: ["grupos"],
          properties: { grupos: { type: "array", items: { type: "array", items: { type: "string" } } } },
        },
      },
      dims: [],
    });
    const parts = normalizePartition(out?.grupos, uniq);
    await e.putEntityDisambig(key, parts);
    return parts;
  } catch {
    return uniq.map((n) => [n]); // fail-soft conservador; NÃO cacheia
  }
}

/** Constrói/atualiza o mapa de canonicalização de entidade (fix sobre-fusão #R3).
 *  Dois tiers (ver clusterEntities):
 *   (A) FORTE — funde SEMPRE, determinístico. O LLM-canônico (nomear o grupo) é opt-in via `useLlm`
 *       (custo alto); no passo automático do consolidate segue DESLIGADO.
 *   (B) AMBÍGUO — desempate por LLM (só o grupo ambíguo, cacheado) quando `disambiguate!==false` E
 *       há provider; senão CONSERVADOR (não funde). */
export async function resolveEntities(
  home: string,
  opts: { useLlm?: boolean; disambiguate?: boolean } = {},
): Promise<ResolveEntitiesResult> {
  const freq = await entityFrequency(home);
  const { strong, ambiguous } = clusterEntities(freq);
  const cfg = config(home);
  const provider = resolveProvider(cfg.provider);
  const allowDisambig = opts.disambiguate !== false; // default: liga (só grupo ambíguo, cacheado)
  const hasProvider = provider === "cli" || provider === "api";
  const map: EntityResolveMap = {};
  const merges: EntityMerge[] = [];
  let usedLlm = false;

  // (A) FORTE — funde sempre (determinístico). canonical via LLM SÓ se opts.useLlm.
  for (const m of strong) {
    let canonical = m.canonical;
    if (opts.useLlm && hasProvider) {
      try {
        const ans = await prose({
          provider,
          model: provider === "cli" ? cfg.cliModel : cfg.apiModel,
          system: "Você normaliza nomes de entidades de negócio. Responda SÓ com o nome canônico curto, em minúsculas, nada mais.",
          prompt: `Estes nomes se referem à MESMA entidade: ${[m.canonical, ...m.aliases].join(", ")}. Qual é o melhor nome canônico?`,
        });
        const clean = ans.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 60);
        if (clean) {
          canonical = clean;
          usedLlm = true;
        }
      } catch {
        /* mantém o determinístico */
      }
    }
    const aliases: string[] = [];
    for (const alias of [m.canonical, ...m.aliases]) if (alias !== canonical) (map[alias] = canonical), aliases.push(alias);
    merges.push({ canonical, aliases });
  }

  // (B) AMBÍGUO — desempate por LLM (cacheado) ou conservador. Só os subgrupos ≥2 viram merge.
  for (const group of ambiguous) {
    const parts = await disambiguateGroup(home, group, { provider, allow: allowDisambig });
    for (const sub of parts) {
      if (sub.length < 2) continue;
      const canonical = canonicalOf(sub, freq);
      const aliases: string[] = [];
      for (const alias of sub) if (alias !== canonical) (map[alias] = canonical), aliases.push(alias);
      merges.push({ canonical, aliases });
    }
    if (allowDisambig && hasProvider && parts.some((s) => s.length >= 2)) usedLlm = true;
  }

  await (await getEngine(home)).putEntityResolve(map);
  return { entities: freq.size, merges, provider: usedLlm ? provider : "deterministico" };
}

/** Conexões tipadas de um nó no grafo de entidades — wrapper de leitura p/ o CLI `graph-query`.
 *  Resolve o alias da consulta para o canônico antes de buscar (ex.: "Acme Corp" → "acme"). */
export async function graphQuery(
  home: string,
  node: string,
  opts: { predicate?: string; currentOnly?: boolean; limit?: number } = {},
): Promise<GraphQueryHit[]> {
  const e = await getEngine(home);
  const canonical = await e.resolveEntity(node);
  return e.graphQuery(canonical, opts);
}
