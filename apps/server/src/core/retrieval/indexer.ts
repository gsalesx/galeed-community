/** ORGANIZE (antigo "index") — deriva os fatos/grafo a partir do que já está no banco
 *  (galeed_pages + galeed_extractions). O DB-native não reconstrói de arquivos: lê as fontes
 *  e as extrações cruas do engine, deriva e grava de volta os DERIVADOS (facts/edges).
 *
 *  Derivação BITEMPORAL determinística (sem LLM): os fatos que carregam (entity, predicate,
 *  value) passam por SUPERSESSÃO — agrupados por (entity, predicate), ordenados por valid_from,
 *  cada versão fecha o valid_to da anterior quando o VALOR muda; quando o valor se REPETE de
 *  fontes distintas, a confiança sobe. Função pura das extrações → idempotente. */
import { slugify } from "../../lib/slug.ts";
import { normalizeValue } from "../../lib/normalize.ts";
import { quoteIsGrounded } from "../../lib/quote-check.ts";
import { valueIsAnchored, textValueIsAnchored } from "../../lib/value-anchor.ts";
import { entityIsVague } from "../../lib/vague-entity.ts";
import { normalizeMetricLabel } from "../../lib/metric-label.ts";
import { extractSpeakers } from "../extraction/speakers.ts";
import {
  getEngine,
  type PageRow,
  type FactRow,
  type EdgeRow,
  type ExtractionRow,
  type ReconcileMap,
  type EntityResolveMap,
  type FactGroupKey,
} from "../platform/engine.ts";

const CONF_BASE = 0.6; // confiança de um fato (triple) ancorado visto 1×
const CONF_STEP = 0.15; // ganho por corroboração de fonte distinta
const CONF_MAX = 0.98;
// Registrado = observação textual sem triple (entity·predicate·value). NÃO é "sem certeza":
// se o quote está ancorado na fonte, é suportado — só não é um claim estruturado/corroborável.
// Decoupla SUPORTE EPISTÊMICO (grounded) de ESTRUTURA (triple). Antes era 0 hardcoded → 76% do
// cérebro nascia 0% e a UI escondia (o usuário via só 22% do que o cérebro sabia).
const CONF_REGISTERED = 0.45; // registrado com quote ancorado na fonte
const CONF_UNGROUNDED = 0.1; // registrado sem âncora na fonte (sem quote ou quote não-verbatim) — suspeito
// Teto da corroboração de REGISTRADO (achado criacao-de-fatos #7): deliberadamente < CONF_BASE +
// corroboração — registrado corroborado nunca compete de igual com triple ancorado, mas deixa de
// ser cidadão de segunda classe capado a 0.45 pra sempre (texto repetido em N fontes distintas
// AGORA sobe, como número sobe).
const CONF_REGISTERED_MAX = 0.75;

/** Confiança-base de um fato derivado, ANTES da corroboração/decay (política do fundador):
 *  triple ancorado = 0.60 (sobe por corroboração até 0.98); triple não-ancorado = 0.30;
 *  registrado ancorado na fonte = 0.45; registrado sem âncora = 0.10. Decoupla SUPORTE
 *  epistêmico (grounded) de ESTRUTURA (triple). Pura → test/unit/confidence-base.test.ts. */
export function baseConfidence(hasTriple: boolean, anchored: boolean, groundedRegistro: boolean): number {
  if (hasTriple) return CONF_BASE * (anchored ? 1 : 0.5);
  return groundedRegistro ? CONF_REGISTERED : CONF_UNGROUNDED;
}

/** Igualdade de valor p/ supersessão: numérica quando ambos têm value_num; senão por string normalizada
 *  (legado intacto — D1: fatos sem value_num decidem por normalizeValue). */
function sameFactValue(a: FactRow, b: FactRow): boolean {
  if (typeof a.value_num === "number" && typeof b.value_num === "number") {
    return a.value_num === b.value_num && (a.unit ?? "") === (b.unit ?? "") && (a.period ?? "") === (b.period ?? "");
  }
  return normalizeValue(a.value) === normalizeValue(b.value);
}

/** Índices de resolução de wikilink: exato, por título, e por "cauda" (slug sem prefixo de data). */
interface LinkResolver {
  slugs: Set<string>;
  byTitle: Map<string, string>;
  byTail: Map<string, string>;
}

const DATE_PREFIX = /^\d{4}-\d{2}-\d{2}-/;

function buildLinkResolver(pages: PageRow[]): LinkResolver {
  const slugs = new Set<string>();
  const byTitle = new Map<string, string>();
  const tailCount = new Map<string, string[]>();
  for (const pg of pages) {
    slugs.add(pg.slug);
    if (pg.title) byTitle.set(slugify(pg.title), pg.slug);
    const tail = pg.slug.replace(DATE_PREFIX, "");
    (tailCount.get(tail) ?? tailCount.set(tail, []).get(tail)!).push(pg.slug);
  }
  const byTail = new Map<string, string>();
  for (const [tail, list] of tailCount) if (list.length === 1) byTail.set(tail, list[0]);
  return { slugs, byTitle, byTail };
}

function resolveLink(target: string, r: LinkResolver): string {
  if (r.slugs.has(target)) return target;
  const last = target.split("/").pop() || target;
  const s = slugify(last);
  if (r.slugs.has(s)) return s;
  if (r.byTitle.has(s)) return r.byTitle.get(s)!;
  if (r.byTail.has(s)) return r.byTail.get(s)!;
  return s; // fantasma canônico
}

/** P1-A/A1d: só ISO entra na cadeia bitemporal — YYYY | YYYY-MM | YYYY-MM-DD (timestamp ISO
 *  "YYYY-MM-DDTHH:mm..." é truncado pra data). Qualquer outra coisa ("março de 2024", "Q1",
 *  "ontem", "2024/03/12") → "" (inválido). NUNCA interpreta linguagem natural (invariante #9 —
 *  sem parser à mão de suposição): inválido cai no fallback determinístico de factValidFrom.
 *  Lexicográfico == cronológico sobre o domínio aceito (a comparação da cadeia e o filtro asOf
 *  do engine seguem por string). Exportada p/ teste (test/unit/p1a-valid-from.test.ts). */
export function normalizeValidFrom(raw: unknown): string {
  if (raw == null) return "";
  let s = String(raw).trim();
  if (/^\d{4}-\d{2}-\d{2}[T ]/.test(s)) s = s.slice(0, 10); // timestamp ISO → data
  if (/^\d{4}$/.test(s)) return s;
  if (/^\d{4}-(0[1-9]|1[0-2])$/.test(s)) return s;
  if (/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(s)) return s;
  return "";
}

/** Data do fato: primeiro candidato VÁLIDO entre valid_from (LLM) → date (carimbo da unit,
 *  P0-A stampUnitDate) → since (legado) → sourceDate (ex.date = data da extração/página).
 *  Nada válido → "" (ordena como o mais antigo, não supersede datado — guarda existente).
 *  Exportada p/ teste (test/unit/p1a-valid-from.test.ts). */
export function factValidFrom(it: any, sourceDate: string): string {
  return (
    normalizeValidFrom(it?.valid_from) ||
    normalizeValidFrom(it?.date) ||
    normalizeValidFrom(it?.since) ||
    normalizeValidFrom(sourceDate) ||
    ""
  );
}

/** Supersessão bitemporal in-place sobre os fatos com (entity, predicate, tier). Determinístico.
 *  M9: a chave de grupo inclui `tier` (série por tier, D4) e a igualdade de valor prefere `value_num`
 *  quando ambos os fatos comparados o têm (senão cai pro normalizeValue legado — sem quebrar fatos
 *  sem value_num). Ver `sameFactValue`.
 *  Exportada p/ teste de invariante (test/unit/supersession.test.ts) — é o coração da verdade. */
export function applyBitemporal(facts: FactRow[]): void {
  const groups = new Map<string, FactRow[]>();
  for (const f of facts) {
    if (!f.entity || !f.predicate) continue;
    const key = `${f.entity} ${f.predicate} ${f.tier ?? ""}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(f);
  }
  for (const group of groups.values()) {
    // D5: sort DETERMINÍSTICO com tie-break — a ordem do input (DB sem ORDER BY no factsInGroups
    // + concat others/raw do deriveIncremental) deixa de importar. Fato SEM data ordena como o
    // mais ANTIGO ("0000"), não o mais novo — não supersede datado.
    group.sort(
      (a, b) =>
        (a.valid_from || "0000").localeCompare(b.valid_from || "0000") ||
        a.source_slug.localeCompare(b.source_slug) ||
        a.idx - b.idx,
    );
    // dedupe de duplicata exata da MESMA fonte + R5 ('nao-verificado' fora da cadeia) — INTACTO.
    // Constrói a `chain` (membros do grupo que passaram dos dois filtros) sem mutar a ordem.
    const seenDup = new Set<string>();
    const chain: FactRow[] = [];
    for (const f of group) {
      // duplicata exata da MESMA fonte (mesmo valor normalizado + value_num + tier + mesma vigência) → colapsa
      const dupKey = `${f.source_slug}|${normalizeValue(f.value)}|${f.value_num ?? ""}|${f.tier ?? ""}|${f.valid_from}`;
      if (seenDup.has(dupKey)) {
        f.status = "duplicata"; // filtrada antes de gravar (ver buildIndex)
        continue;
      }
      seenDup.add(dupKey);
      // R5: fato não-ancorado não entra na cadeia — não corrobora nem supersede (não infla confiança).
      if (f.status === "nao-verificado") continue;
      chain.push(f);
    }
    if (!chain.length) continue;

    // (a) RESET — idempotência (M2/L2): o estado DERIVADO anterior (valid_to/status/confidence
    // vindos do banco via factsInGroups) é descartado e recomputado do zero. Reabilita os elos
    // 'corroborado'/'arquivado' que re-entram na cadeia no incremental.
    for (const f of chain) {
      f.valid_to = "";
      f.status = "fato";
    }

    // (b) RUNS de valor: sequência CONTÍGUA (pós-sort) de sameFactValue. Por run, confiança
    // recomputada (D2) = min(CONF_MAX, CONF_BASE + CONF_STEP * (nº de source_slug DISTINTOS − 1)),
    // aplicada a TODOS os membros do run. NUNCA += sobre confiança armazenada.
    let runStart = 0;
    for (let i = 0; i <= chain.length; i++) {
      if (i < chain.length && i > runStart && sameFactValue(chain[i - 1], chain[i])) continue;
      // fecha o run [runStart, i)
      const sources = new Set<string>();
      for (let j = runStart; j < i; j++) sources.add(chain[j].source_slug);
      const conf = Math.min(CONF_MAX, CONF_BASE + CONF_STEP * (sources.size - 1));
      for (let j = runStart; j < i; j++) chain[j].confidence = conf;
      runStart = i;
    }

    // (c) FECHAMENTO da cadeia: cada elo (exceto o ÚLTIMO do grupo) fecha no início do sucessor.
    // Sucessor sem data não fecha a janela (mesma guarda de hoje). Status:
    //   'corroborado' quando o sucessor tem o MESMO valor (corroboração, não mudança de ideia — D1);
    //   'arquivado'   quando o valor MUDA (supersessão clássica).
    // O último elo fica status='fato', valid_to='' → EXATAMENTE 1 vigente por grupo (L1).
    for (let i = 0; i < chain.length - 1; i++) {
      const cur = chain[i];
      const next = chain[i + 1];
      cur.valid_to = next.valid_from || cur.valid_to;
      cur.status = sameFactValue(cur, next) ? "corroborado" : "arquivado";
    }
  }
}

/** Corroboração de REGISTRADOS (achado criacao-de-fatos #7 — fato sem triple era cidadão de
 *  segunda classe POR CONSTRUÇÃO: teto 0.45, sem corroboração possível, N repetições = N linhas a
 *  0.45). Espelha a mecânica dos runs de applyBitemporal para os fatos SEM triple: agrupa
 *  registrados GROUNDED (confidence === CONF_REGISTERED; os 0.10 ungrounded ficam FORA — corroborar
 *  suspeita não é corroborar) por texto normalizado (normalizeValue(f.text) — a MESMA lib do dupKey
 *  da cadeia triple) e, por grupo: (a) duplicata exata da MESMA fonte colapsa (status 'duplicata',
 *  igual à cadeia triple — hoje registrado nem isso tinha); (b) confidence = min(CONF_REGISTERED_MAX,
 *  CONF_REGISTERED + CONF_STEP × (fontes DISTINTAS − 1)) aplicada a TODOS os membros vigentes.
 *  NUNCA += sobre confiança armazenada (recomputa do zero → idempotente, mesma disciplina D2).
 *  PURA e determinística — testável sem DB (test/unit/registrado-corroboracao.test.ts).
 *  Chamada no buildIndex (corpus inteiro). LIMITAÇÃO HONESTA (não silenciosa): deriveIncremental
 *  NÃO corrobora registrados entre fontes fora do lote (exigiria método novo de engine, tipo
 *  factsInGroups por chave de texto) — o incremental grava a 0.45 e a corroboração CONVERGE no
 *  próximo rebuild (organize/buildIndex). Registrado corroborado continua FORA de currentFacts
 *  (invariante L1/D3 intacta — exposição com selo 'registrado' é decisão de outra camada). */
export function applyRegistradoCorroboration(facts: FactRow[]): void {
  const groups = new Map<string, FactRow[]>();
  for (const f of facts) {
    if (f.entity || f.status !== "registrado") continue;
    if (f.confidence !== CONF_REGISTERED) continue; // só grounded; ungrounded (0.10) não corrobora
    const key = normalizeValue(f.text);
    if (!key) continue;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(f);
  }
  for (const group of groups.values()) {
    const seenSource = new Set<string>();
    const kept: FactRow[] = [];
    for (const f of group) {
      // (a) repetição na MESMA fonte = duplicata (colapsa; não infla confiança) — 1ª ocorrência fica.
      if (seenSource.has(f.source_slug)) {
        f.status = "duplicata"; // filtrada antes de gravar (ver buildIndex)
        continue;
      }
      seenSource.add(f.source_slug);
      kept.push(f);
    }
    // (b) corroboração por fonte distinta, teto CONF_REGISTERED_MAX (< triple corroborado).
    const conf = Math.min(CONF_REGISTERED_MAX, CONF_REGISTERED + CONF_STEP * (seenSource.size - 1));
    for (const f of kept) f.confidence = conf;
  }
}

/** Mapas de canonicalização FIXOS no instante da derivação (condição do write-path, ADR-008). */
export interface DeriveMaps {
  reconcileMap: ReconcileMap;
  entityMap: EntityResolveMap;
}

/** Deriva os FactRow CRUS (ANTES de applyBitemporal) das páginas/extrações dadas: canonicaliza
 *  entidade (entityMap) e predicado (reconcileMap → normalizeMetricLabel), ancora quote (quoteIsGrounded)
 *  e valor (valueIsAnchored), define status (fato|nao-verificado|registrado) e confidence (baseConfidence).
 *  PURA e determinística — é EXATAMENTE o bloco §4 do buildIndex de hoje, sem I/O. `bodyBySlug` é
 *  derivado das `pages` (p/ checar ancoragem). buildIndex e deriveIncremental compartilham ESTA função
 *  → garante equivalência byte-idêntica (M14/§8.1). */
export function derivePageFacts(
  pages: PageRow[],
  extractions: ExtractionRow[],
  maps: DeriveMaps,
): FactRow[] {
  const { reconcileMap, entityMap } = maps;
  const bodyBySlug = new Map(pages.map((p) => [p.slug, p.body])); // p/ verificar ancoragem do quote (R4)
  const facts: FactRow[] = [];
  for (const ex of extractions) {
    const sourceDate = String(ex.date || "");
    for (const [dim, arr] of Object.entries(ex.extractions || {})) {
      let items: any = arr;
      if (typeof items === "string") {
        try {
          items = JSON.parse(items);
        } catch {
          continue;
        }
      }
      if (!Array.isArray(items)) continue;
      items.forEach((it: any, i: number) => {
        const text = String(it.text || it.name || (typeof it === "string" ? it : JSON.stringify(it)));
        let entity = String(it.entity || "").toLowerCase().trim();
        if (entity && entityMap[entity]) entity = entityMap[entity]; // canonicaliza a ENTIDADE primeiro
        let predicate = String(it.predicate || "").toLowerCase().trim().replace(/\s+/g, "_");
        if (entity && predicate && reconcileMap[entity]?.[predicate]) predicate = reconcileMap[entity][predicate];
        if (entity && predicate) predicate = normalizeMetricLabel(predicate); // M9: canonicaliza grafia
        const value = String(it.value ?? "").trim();
        // M9: campos do claim TIPADO (tolerante à ausência — fato legado/não-numérico fica null/"").
        const value_num = typeof it.value_num === "number" && Number.isFinite(it.value_num) ? it.value_num : null;
        const unit = String(it.unit ?? "").trim();
        const period = String(it.period ?? "").trim();
        const tier = String(it.tier ?? "").trim();
        const hasTriple = !!(entity && predicate);
        const quote = String(it.context_quote || it.quote || "");
        // R4: quote não ancorado na fonte → suspeito de alucinação (marca + penaliza, não deleta)
        const grounded = quoteIsGrounded(quote, bodyBySlug.get(ex.source_slug) || "");
        const numAnchored = valueIsAnchored(value, value_num, bodyBySlug.get(ex.source_slug) || "");
        // P1-A/C4: triple SEM value_num, SEM context_quote e SEM o value verbatim no body =
        // evidência NENHUMA → nunca 'fato'. quoteIsGrounded("")→true e valueIsAnchored(sem dígito)
        // →true não penalizam AUSÊNCIA — este predicado penaliza. textValueIsAnchored (achado
        // criacao-de-fatos #5) fecha o viés numérico residual: valor TEXTUAL presente literal na
        // fonte ancora como número ancora (mesma evidência ⇒ mesma barra epistêmica).
        // PREDICADO CANÔNICO (o P1-C espelha ESTA expressão no golden-rule — consistência
        // adjudicada pelo CTO; value_num===0 É numérico e quote = String(context_quote||quote||"")
        // SEM trim — só-espaços conta como presente; mudança futura edita as DUAS specs):
        // hasTriple && value_num === null && quote === "" && !textValueIsAnchored(value, body)
        const semEvidencia =
          hasTriple && value_num === null && quote === "" &&
          !textValueIsAnchored(value, bodyBySlug.get(ex.source_slug) || "");
        // ── M23-B/LEI II: fato sem dono claro NÃO é fato. ──────────────────────────────
        // CADEIA DE GATES (ordem CRAVADA M23-B — motivo mais ESPECÍFICO primeiro):
        //   1. fora_da_receita (só no gate M21) → 2. entidade_vaga → 3. nao_ancorado/C4
        //   (evidência NENHUMA) → 4. nao_ancorado/ancoragem (evidência não confere).
        // Entidade pronominal/genérica (lista tenant-neutra de LÍNGUA — src/lib/vague-entity.ts)
        // que NÃO resolveu pelo entityMap (a canonicalização já rodou acima) → nunca 'fato'.
        // Exceção ÚNICA: marcador review='aprovada' (posto por approveReviewItem — decisão
        // humana da fila M21; o humano É o resolvedor do referente). A exceção NUNCA se aplica
        // à ancoragem (grounded/numAnchored/semEvidencia continuam mandando — aprovação não
        // inventa âncora). ESPELHADO no golden-rule (applyRecipeGate) SEM a exceção (lá o
        // claim é PRÉ-decisão) — mudou aqui, muda LÁ JUNTO (mesma disciplina do C4/fix-1).
        const entidadeVaga = hasTriple && it?.review !== "aprovada" && entityIsVague(entity);
        const anchored = grounded && numAnchored && !semEvidencia && !entidadeVaga; // S3 + C4 + M23-B
        // registrado (sem triple) é GROUNDED quando tem quote E o quote está na fonte. `grounded`
        // sozinho retorna true p/ quote vazio (não penaliza ausência) — aqui exigimos a âncora real.
        const groundedRegistro = !!quote && grounded;
        const status = hasTriple ? (anchored ? "fato" : "nao-verificado") : "registrado";
        facts.push({
          source_slug: ex.source_slug,
          type: ex.type,
          dimension: dim,
          idx: i,
          text,
          quote,
          meta: it,
          entity: hasTriple ? entity : "",
          predicate: hasTriple ? predicate : "",
          value: hasTriple ? value : "",
          value_num: hasTriple ? value_num : null,
          unit: hasTriple ? unit : "",
          period: hasTriple ? period : "",
          tier: hasTriple ? tier : "",
          // FIX-A: registrado TAMBÉM herda a cadeia valid_from→date→since→ex.date (factValidFrom).
          // Forense 2026-06-12: 3.645/7.299 fatos sem data eram TODOS registrados COM a data sentada
          // em meta.date (carimbo P0-A) — o elo quebrado era este ternário. Sem data válida em nenhum
          // elo → "" (limitação honesta do dado; nunca inventa).
          valid_from: factValidFrom(it, sourceDate),
          valid_to: "",
          confidence: baseConfidence(hasTriple, anchored, groundedRegistro),
          status,
          source_id: String(it.source_id ?? ""), // M21 — carimbo da fonte (viaja no claim desde o gate)
        });
      });
    }
  }
  return facts;
}

export async function buildIndex(home: string) {
  const e = await getEngine(home);
  const pages: PageRow[] = await e.allPages();

  // 1) wikilinks crus + FALANTES (grafo de pessoas, determinístico) a partir do corpo das fontes
  const rawLinks: { src: string; target: string }[] = [];
  const speakerEdges: { src: string; person: string }[] = [];
  const speakerNames = new Map<string, string>();
  for (const pg of pages) {
    for (const m of pg.body.matchAll(/\[\[([^\]]+)\]\]/g)) {
      rawLinks.push({ src: pg.slug, target: m[1].split("|")[0].trim() });
    }
    if (pg.type === "reunioes") {
      for (const sp of extractSpeakers(pg.body)) {
        speakerEdges.push({ src: pg.slug, person: sp.slug });
        if (!speakerNames.has(sp.slug)) speakerNames.set(sp.slug, sp.name);
      }
    }
  }

  // 2) materializa nós-PESSOA que ainda não têm fonte própria (vira nó real, não fantasma)
  const existingSlugs = new Set(pages.map((pg) => pg.slug));
  const newPersons: PageRow[] = [];
  for (const [pslug, name] of speakerNames) {
    if (existingSlugs.has(pslug)) continue;
    const row: PageRow = {
      slug: pslug,
      type: "pessoas",
      title: name,
      date: "",
      path: "",
      body: "Pessoa identificada por participação em reuniões (grafo de falantes).",
      content_hash: "",
    };
    newPersons.push(row);
    pages.push(row);
    existingSlugs.add(pslug);
  }
  for (const p of newPersons) await e.upsertPage(p);

  // 3) resolução de wikilinks → slug canônico (entity resolution determinística)
  const resolver = buildLinkResolver(pages);
  const edges: EdgeRow[] = [];
  const seenEdge = new Set<string>();
  const pushEdge = (src: string, target: string) => {
    const dst = resolveLink(target, resolver);
    if (dst === src) return;
    const key = `${src} ${dst}`;
    if (seenEdge.has(key)) return;
    seenEdge.add(key);
    edges.push({ src, dst });
  };
  for (const { src, target } of rawLinks) pushEdge(src, target);
  for (const { src, person } of speakerEdges) pushEdge(src, person);

  // 4) extrações cruas → fatos; canonicaliza predicado (reconcile) antes da supersessão.
  // A derivação por-página vive em derivePageFacts (pura) — buildIndex e deriveIncremental
  // compartilham ESSA função (equivalência byte-idêntica, M14/§8.1).
  const reconcileMap = await e.getReconcile();
  const entityMap = await e.getEntityResolve();
  const extractions = await e.allExtractions();
  const facts: FactRow[] = derivePageFacts(pages, extractions, { reconcileMap, entityMap });

  applyBitemporal(facts);
  // registrados (sem triple) corroboram/dedupam por texto normalizado — achado criacao-de-fatos #7.
  applyRegistradoCorroboration(facts);

  // descarta as duplicatas marcadas e grava os derivados ATOMICAMENTE (leitor nunca vê parcial)
  const finalFacts = facts.filter((f) => f.status !== "duplicata");

  // arestas TIPADAS (S2): entity --predicate--> value, só quando value é entidade/página conhecida
  // (evita poluir o grafo com escalares como "R$ 499"). A canonicalização de entity já foi aplicada.
  for (const f of finalFacts) {
    if (!f.entity || !f.predicate || !f.value || f.status === "arquivado") continue;
    const v = f.value.toLowerCase().trim();
    const valueSlug = entityMap[v] ?? slugify(f.value);
    const dstIsEntity = existingSlugs.has(valueSlug) || entityMap[v] !== undefined;
    if (!dstIsEntity) continue;
    const key = `${f.entity} ${valueSlug} ${f.predicate}`;
    if (seenEdge.has(key)) continue;
    seenEdge.add(key);
    edges.push({ src: f.entity, dst: valueSlug, kind: f.predicate, weight: f.confidence });
  }

  await e.replaceDerived(finalFacts, edges);

  const bitemporal = finalFacts.filter((f) => f.entity).length;
  const ungrounded = finalFacts.filter((f) => f.status === "nao-verificado").length;
  return { pages: pages.length, facts: finalFacts.length, edges: edges.length, bitemporal, ungrounded };
}

/** Arestas no caminho INCREMENTAL (M14/§5). Reusa as MESMAS regras do buildIndex, mas restrito ao lote:
 *  (a) arestas TIPADAS dos `facts` afetados (entity --predicate--> value, só quando value é entidade
 *      conhecida — entityMap ou slug das páginas novas); (b) arestas de wikilink/speaker das `pages`
 *      NOVAS (cujo src é o SLUG da página). Dedup por chave, igual buildIndex. Helper local (não export). */
function buildIncrementalEdges(pages: PageRow[], facts: FactRow[], entityMap: EntityResolveMap): EdgeRow[] {
  const edges: EdgeRow[] = [];
  const seenEdge = new Set<string>();

  // (a) wikilinks crus + FALANTES das páginas NOVAS — mesma extração do buildIndex (passo 1).
  // Resolve contra o conjunto de slugs das páginas do lote (bound §5: alvos fora do lote caem no
  // fantasma canônico por slugify — mesma degradação que o buildIndex já tem p/ alvo não-encontrado).
  const resolver = buildLinkResolver(pages);
  const pushLinkEdge = (src: string, target: string) => {
    const dst = resolveLink(target, resolver);
    if (dst === src) return;
    const key = `${src} ${dst}`;
    if (seenEdge.has(key)) return;
    seenEdge.add(key);
    edges.push({ src, dst });
  };
  for (const pg of pages) {
    for (const m of pg.body.matchAll(/\[\[([^\]]+)\]\]/g)) {
      pushLinkEdge(pg.slug, m[1].split("|")[0].trim());
    }
    if (pg.type === "reunioes") {
      for (const sp of extractSpeakers(pg.body)) pushLinkEdge(pg.slug, sp.slug);
    }
  }

  // (b) arestas TIPADAS dos fatos afetados — MESMA lógica de buildIndex:253-263.
  const slugsSet = new Set(pages.map((p) => p.slug));
  for (const f of facts) {
    if (!f.entity || !f.predicate || !f.value || f.status === "arquivado") continue;
    const v = f.value.toLowerCase().trim();
    const valueSlug = entityMap[v] ?? slugify(f.value);
    const dstIsEntity = slugsSet.has(valueSlug) || entityMap[v] !== undefined;
    if (!dstIsEntity) continue;
    const key = `${f.entity} ${valueSlug} ${f.predicate}`;
    if (seenEdge.has(key)) continue;
    seenEdge.add(key);
    edges.push({ src: f.entity, dst: valueSlug, kind: f.predicate, weight: f.confidence });
  }

  return edges;
}

/** Write-path INCREMENTAL (M14, BRIEF §4a). Re-deriva SÓ os grupos (entity,predicate,tier) que as
 *  páginas `slugs` tocam, lendo só as cadeias afetadas e escrevendo só as linhas afetadas — custo
 *  O(f_P + f_G), independente do tamanho N do corpus. Equivalente byte-idêntico a buildIndex(C∪P) com
 *  mapas fixos. `slugs=[]` → no-op. Idempotente por source_slug. Reusa derivePageFacts + applyBitemporal. */
export async function deriveIncremental(
  home: string,
  slugs: string[],
): Promise<{ groups: number; facts: number; edges: number }> {
  if (!slugs.length) return { groups: 0, facts: 0, edges: 0 };
  const e = await getEngine(home);

  // 3) páginas do lote + extrações do lote (leitura dirigida §4: filtra allExtractions pelo lote —
  // traz JSON cru, NÃO materializa FactRow; o pico de FactRow vem de derivePageFacts(lote)+factsInGroups(G)).
  const pageMap = await e.pagesBySlug(slugs);
  const pages: PageRow[] = slugs.map((s) => pageMap.get(s)).filter((p): p is PageRow => !!p);
  const exAll: ExtractionRow[] = await e.allExtractions();
  const slugSet = new Set(slugs);
  const extractions = exAll.filter((x) => slugSet.has(x.source_slug));

  // 4) mapas FIXOS (condição do write-path, ADR-008)
  const reconcileMap = await e.getReconcile();
  const entityMap = await e.getEntityResolve();

  // 5) raw da MESMA função pura → equivalência byte-idêntica
  const raw = derivePageFacts(pages, extractions, { reconcileMap, entityMap });

  // 6) triple-facts (agrupáveis) vs registrados (sem-triple: append por fonte, escopado por source_slug)
  const rawTriples = raw.filter((f) => f.entity && f.predicate);
  const registrados = raw.filter((f) => !(f.entity && f.predicate));

  // 7) grupos afetados G = distinct(entity,predicate,tier) sobre os triple-facts
  const seenG = new Set<string>();
  const G: FactGroupKey[] = [];
  for (const f of rawTriples) {
    const tier = f.tier ?? "";
    const key = `${f.entity} ${f.predicate} ${tier}`;
    if (seenG.has(key)) continue;
    seenG.add(key);
    G.push({ entity: f.entity, predicate: f.predicate, tier });
  }

  // 8) cadeias dos grupos de G de OUTRAS fontes (exclui versões antigas das próprias slugs → idempotência)
  const existentes = await e.factsInGroups(G);
  const others = existentes.filter((f) => !slugSet.has(f.source_slug));

  // 9) re-supersede SÓ os grupos de G (applyBitemporal é por-grupo independente)
  const chain = [...others, ...rawTriples];
  applyBitemporal(chain);
  const finalTriples = chain.filter((f) => f.status !== "duplicata");

  // 10) registrados entram escopados por source_slug ∈ slugs. Corroboração/dedupe SÓ dentro do
  // lote (applyRegistradoCorroboration é pura): corroborar contra registrados de OUTRAS fontes
  // exigiria método novo de engine (análogo ao factsInGroups, por chave de texto) — degradação
  // HONESTA e documentada (achado criacao-de-fatos #7): o incremental pode gravar a 0.45 e a
  // corroboração cross-fonte CONVERGE no próximo rebuild (organize/buildIndex).
  applyRegistradoCorroboration(registrados);
  const finalFacts = [...finalTriples, ...registrados.filter((f) => f.status !== "duplicata")];

  // 11) arestas tipadas de G + wikilink/speaker das páginas novas
  const edges = buildIncrementalEdges(pages, finalTriples, entityMap);

  // 12) escrita dirigida atômica (S1): DELETE por source_slug ∈ slugs OU grupo ∈ G; INSERT finalFacts+edges
  await e.replaceFactsForSourcesAndGroups(slugs, G, finalFacts, edges);

  return { groups: G.length, facts: finalFacts.length, edges: edges.length };
}
