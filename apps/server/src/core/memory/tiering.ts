/** R1 — esquecimento de VERDADE, reversível: descarta o peso regenerável (vetores) das páginas frias
 *  e permite trazê-las de volta (re-embedando do body). Determinístico no shed; zero LLM. */
import { getEngine } from "../platform/engine.ts";
import { buildEmbeddings } from "../retrieval/embeddings.ts";

export interface ShedResult {
  cooled: number;        // páginas movidas hot→cold
  vectorsShed: number;   // total de linhas de vetor descartadas
  pages: string[];       // slugs resfriados
  dryRun: boolean;
}

/** Resfria as candidatas (archived=true E tier='hot'): descarta vetores + tier='cold'.
 *  dryRun → só conta (lista candidatas, não muta). */
export async function shedCold(home: string, opts?: { dryRun?: boolean }): Promise<ShedResult> {
  const e = await getEngine(home);
  const cand = await e.shedCandidates(); // já é archived+hot

  if (opts?.dryRun) {
    return { cooled: cand.length, vectorsShed: 0, pages: cand.map((p) => p.slug), dryRun: true };
  }

  let vectorsShed = 0;
  const pages: string[] = [];
  for (const p of cand) {
    vectorsShed += await e.shedVectors(p.slug);
    await e.setTier(p.slug, "cold");
    pages.push(p.slug);
  }

  return { cooled: pages.length, vectorsShed, pages, dryRun: false };
}

export interface RestoreResult {
  slug: string;
  restored: boolean;       // true se a página existia e estava cold OU arquivada
  vectorsRebuilt: number;  // chunks re-embedados (0 se sem OPENAI key)
}

/** Reverte o esquecimento de UMA página: desarquiva, tier='hot' e re-embeda do body (buildEmbeddings
 *  incremental). Cobre DOIS estados (achado decaimento-lixeira#3): cold (pós-shed) E archived+hot
 *  (pós-prune/consolidate SEM shed) — antes o guard exigia tier='cold' e a página arquivada-hot não
 *  tinha NENHUM caminho de restauração ("arquivar reversível" falhava no arrependimento imediato). */
export async function restoreCold(home: string, slug: string): Promise<RestoreResult> {
  const e = await getEngine(home);
  const pg = await e.getPage(slug); // getPage projeta tier E archived (fix no postgres.ts) e não filtra lixeira
  if (!pg) return { slug, restored: false, vectorsRebuilt: 0 };
  if (pg.tier !== "cold" && !pg.archived) return { slug, restored: false, vectorsRebuilt: 0 }; // já ativa

  // desarquiva ANTES de embedar: buildEmbeddings varre allPages (que pula arquivadas);
  // sem desarquivar a re-embedação não acha a página. Idempotente no caso archived-hot
  // (setTier('hot') é no-op; o buildEmbeddings incremental só embeda o que faltar).
  await e.setArchived(slug, false);
  await e.setTier(slug, "hot");

  const r = await buildEmbeddings(home); // incremental: só embeda chunks pendentes
  const vectorsRebuilt = (r as any).embedded ?? 0; // `skipped` (sem key/desabilitado) → 0

  return { slug, restored: true, vectorsRebuilt };
}
