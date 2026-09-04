/** M23-D — CONSOLIDAÇÃO AUTOMÁTICA no worker (BRIEF M23 §3 Peça 4; mata o achado M1 da auditoria:
 *  "entity resolution NUNCA roda no pipeline"). Faz `resolveEntities` (determinístico, 0 LLM) rodar
 *  como passo PÓS-derive do worker, com re-derive INCREMENTAL só dos slugs cujas entidades cruas
 *  mudaram de canônico quando o mapa alias→canônico muda.
 *
 *  A LEI do pacote (DESIGN-SPEC §0):
 *   1. automática e SEM LLM-canônico (resolveEntities SEM useLlm — nomear grupo forte fica OFF).
 *      Fix sobre-fusão #R3: o DESEMPATE de grupo ambíguo liga (disambiguate:true), mas é cacheado
 *      (galeed_entity_disambig) → quase sempre 0 chamadas; sem LLM → conservador (não funde);
 *   2. re-derive SEMPRE incremental (deriveIncremental, NUNCA buildIndex no hot path);
 *   3. idempotente (derive v2 do P1-A é RESET — confiança não infla no re-derive);
 *   4. fail-soft (padrão M3a do P0-C): NUNCA lança — qualquer erro vira status:'falhou';
 *   5. tenant-neutro (ADR-002): zero literal de domínio — "accelera" só em FIXTURE/prova.
 *
 *  Consome (sem editar): resolveEntities (../memory/entities.ts), deriveIncremental
 *  (../retrieval/indexer.ts), getEngine/tipos (../platform/engine.ts). */
import { resolveEntities } from "../memory/entities.ts";
import { deriveIncremental } from "../retrieval/indexer.ts";
import { getEngine, type EntityResolveMap, type ExtractionRow } from "../platform/engine.ts";

/** M23-D — rastro da consolidação automática gravado em result_json.consolidacao (aditivo,
 *  retrocompat: jobs antigos não têm a chave — mesmo padrão do rastro `embeddings` do P0-C). */
export interface ConsolidacaoTrace {
  status: "ok" | "sem_mudanca" | "desligada" | "falhou";
  merges: number; // nº de grupos REALIZADOS (forte + ambíguo desempatado) com ≥2 nomes
  aliases_mudados: number; // entradas do mapa alias→canônico que mudaram nesta passada
  fontes_rederivadas: number; // slugs re-derivados via deriveIncremental
  grupos: number; // grupos (entity,predicate,tier) re-superseded (retorno do derive)
  erro?: string; // mensagem legível (sem stack), só quando status='falhou'
}

/** Diff do mapa de canonicalização: aliases ADICIONADOS, ALTERADOS ou REMOVIDOS entre before e
 *  after (after[k] !== before[k] sobre a UNIÃO das chaves). Saída ordenada e sem duplicata.
 *  Um alias cujo canônico mudou (incluindo "canônico antigo virou alias do novo" — after["old"]=
 *  "new" com before["old"] ausente) entra no conjunto. */
export function diffEntityMaps(before: EntityResolveMap, after: EntityResolveMap): string[] {
  const changed = new Set<string>();
  const keys = new Set<string>([...Object.keys(before), ...Object.keys(after)]);
  for (const k of keys) if (after[k] !== before[k]) changed.add(k);
  return [...changed].sort();
}

/** Slugs das fontes cujas extrações cruas mencionam (entity, lowercase+trim) ∈ changed.
 *  MESMA normalização do derivePageFacts/entityFrequency: String(it.entity||"").toLowerCase().trim().
 *  MESMA tolerância do derivePageFacts: dimensão cujo valor é STRING tenta JSON.parse (array);
 *  não-array é ignorado. Saída: slugs únicos, ordenados. */
export function slugsAffectedByEntities(
  extractions: ExtractionRow[],
  changed: ReadonlySet<string>,
): string[] {
  const slugs = new Set<string>();
  for (const ex of extractions) {
    let hit = false;
    for (const arr of Object.values(ex.extractions || {})) {
      let items: any = arr;
      if (typeof items === "string") {
        try {
          items = JSON.parse(items);
        } catch {
          continue;
        }
      }
      if (!Array.isArray(items)) continue;
      for (const it of items as any[]) {
        const ent = String(it?.entity || "").toLowerCase().trim();
        if (ent && changed.has(ent)) {
          hit = true;
          break;
        }
      }
      if (hit) break;
    }
    if (hit) slugs.add(ex.source_slug);
  }
  return [...slugs].sort();
}

// serialização in-process por brain: os dois loops do worker (jobs + poller) nunca consolidam o
// MESMO brain em paralelo (putEntityResolve é replace-all — delete+insert — e não pode interfoliar).
const chains = new Map<string, Promise<ConsolidacaoTrace>>();

/** M23-D — passo de consolidação PÓS-derive do worker (BRIEF M23 §3 Peça 4; mata o achado M1).
 *  Determinístico (NUNCA passa useLlm — orçamento 0 LLM). FAIL-SOFT POR CONTRATO: nunca lança
 *  (qualquer erro vira status:'falhou' com mensagem legível). SERIALIZADO por brain no processo
 *  (promise-chain). */
export function runConsolidationStep(brain: string): Promise<ConsolidacaoTrace> {
  const prev = chains.get(brain) ?? Promise.resolve(undefined as unknown as ConsolidacaoTrace);
  const next = prev.then(() => doRun(brain), () => doRun(brain)); // a falha do anterior não propaga
  chains.set(brain, next);
  return next;
}

async function doRun(brain: string): Promise<ConsolidacaoTrace> {
  const zero = { merges: 0, aliases_mudados: 0, fontes_rederivadas: 0, grupos: 0 };
  if ((process.env.GALEED_CONSOLIDATE ?? "1") === "0") return { status: "desligada", ...zero };
  try {
    const e = await getEngine(brain);
    const before = await e.getEntityResolve();
    // Fix sobre-fusão #R3: o LLM-canônico (nomear grupo forte) segue OFF — PROIBIDO { useLlm: true }.
    // O desempate de grupo AMBÍGUO liga (disambiguate:true), mas é LIMITADO: só grupos ambíguos e
    // CACHEADO (galeed_entity_disambig) → a grande maioria das rodadas faz 0 chamadas de LLM. Sem
    // LLM disponível → conservador (não funde). Continua fail-soft (o step engole erro).
    const r = await resolveEntities(brain, { disambiguate: true });
    const after = await e.getEntityResolve();
    const changed = diffEntityMaps(before, after);
    if (!changed.length) return { status: "sem_mudanca", ...zero, merges: r.merges.length };
    const slugs = slugsAffectedByEntities(await e.allExtractions(), new Set(changed));
    const d = await deriveIncremental(brain, slugs); // ← NUNCA buildIndex (LEI 2)
    return {
      status: "ok",
      merges: r.merges.length,
      aliases_mudados: changed.length,
      fontes_rederivadas: slugs.length,
      grupos: d.groups,
    };
  } catch (err) {
    return { status: "falhou", ...zero, erro: err instanceof Error ? err.message : String(err) };
  }
}
