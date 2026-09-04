/** P0-C — VARREDURA DE REPARO de estado parcial (auditoria C3b + M3a). Roda no boot do worker,
 *  PERIODICAMENTE (repairTick no ingest-worker — GALEED_REPAIR_INTERVAL_MS, default 15 min; sem
 *  isso, worker de longa duração nunca curava página presa) e no `--repair-only`. Só varre brains
 *  SEM job ativo (listRepairableBrains — não corre contra um job
 *  em voo nem contra um lote pendente). Leituras de detecção em SQL direto na pool compartilhada
 *  (mesmo padrão do ingest-queue.ts: brain-independente na conexão, escopada por brain na query);
 *  TODA escrita passa pelo pipeline/engine (digestPendingPages, deriveIncremental, buildEmbeddings,
 *  mergeJobResult). Tenant-neutro (ADR-002): zero literal de domínio, zero ramo de formato. */
import { getSharedSql } from "../platform/db-conn.ts";
import { listRepairableBrains, listJobsWithFailedEmbeddings, mergeJobResult } from "./ingest-queue.ts";
import { digestPendingPages } from "./process-blob-job.ts";
import { deriveIncremental } from "../retrieval/indexer.ts";
import { buildEmbeddings } from "../retrieval/embeddings.ts";

export interface RepairReport {
  brains: number;            // brains varridos
  pagesDigested: number;     // páginas extract_version='' que passaram pela Fase B
  pagesSkipped: number;      // puladas (fonte pausada/inexistente, erro de grupo)
  underivedDerived: number;  // páginas com extração sem fato → deriveIncremental
  embeddingsRetried: number; // brains com re-tentativa de buildEmbeddings
  jobsEmbeddingsOk: number;  // jobs cujo flag 'failed' flipou pra 'ok'
}

/** Varre e repara. `maxPages` limita o custo LLM por passada (default GALEED_REPAIR_MAX_PAGES=200). */
export async function runRepairSweep(opts: { maxPages?: number } = {}): Promise<RepairReport> {
  const sql = await getSharedSql();
  const maxPagesTotal =
    opts.maxPages ??
    (() => {
      const n = Number(process.env.GALEED_REPAIR_MAX_PAGES);
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : 200;
    })();

  const report: RepairReport = {
    brains: 0,
    pagesDigested: 0,
    pagesSkipped: 0,
    underivedDerived: 0,
    embeddingsRetried: 0,
    jobsEmbeddingsOk: 0,
  };

  let budget = maxPagesTotal; // orçamento de páginas (custo LLM) por passada, compartilhado entre brains
  const brains = await listRepairableBrains();
  report.brains = brains.length;

  for (const brain of brains) {
    // 1) PÁGINAS SEM FASE B (detecção read-only): capturadas (extract_version='') e não-arquivadas.
    if (budget > 0) {
      const pendentes = (await sql.unsafe(
        `select slug from galeed_pages
          where brain = $1
            and coalesce(extract_version, '') = ''
            and coalesce(archived, false) = false
          order by date, slug
          limit $2`,
        [brain, budget],
      )) as any[];
      if (pendentes.length) {
        const slugs = pendentes.map((r) => r.slug as string);
        const { digested, skipped } = await digestPendingPages(brain, slugs);
        report.pagesDigested += digested;
        report.pagesSkipped += skipped;
        budget -= slugs.length;
      }
    }

    // 2) EXTRAÇÃO PERSISTIDA SEM DERIVE (crash entre putExtraction e deriveIncremental). Falso-positivo
    //    possível (extração cujos claims legitimamente não viram fato) custa só um re-derive idempotente
    //    (L5) — deriveIncremental é função pura das extrações, não infla confiança nem re-paga LLM.
    const underived = (await sql.unsafe(
      `select x.source_slug from galeed_extractions x
        where x.brain = $1
          and exists (select 1 from jsonb_each(coalesce(x.extractions, '{}'::jsonb)) d(k, v)
                       where jsonb_typeof(d.v) = 'array' and jsonb_array_length(d.v) > 0)
          and not exists (select 1 from galeed_facts f
                           where f.brain = x.brain and f.source_slug = x.source_slug)`,
      [brain],
    )) as any[];
    if (underived.length) {
      const slugs = underived.map((r) => r.source_slug as string);
      await deriveIncremental(brain, slugs);
      report.underivedDerived += slugs.length;
    }
  }

  // 3) EMBEDDINGS FALHOS (M3a): jobs terminais com result_json.embeddings='failed', agrupados por brain.
  //    sucesso → flipa o flag pra 'ok' em cada job do brain; falha → log + mantém o flag (próxima varredura).
  const failedJobs = await listJobsWithFailedEmbeddings();
  const byBrain = new Map<string, string[]>();
  for (const j of failedJobs) {
    const arr = byBrain.get(j.brain) ?? [];
    arr.push(j.id);
    byBrain.set(j.brain, arr);
  }
  for (const [brain, jobIds] of byBrain) {
    report.embeddingsRetried++;
    try {
      await buildEmbeddings(brain);
      for (const id of jobIds) await mergeJobResult(id, { embeddings: "ok" });
      report.jobsEmbeddingsOk += jobIds.length;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[repair] re-tentativa de embeddings falhou (brain ${brain}): ${msg}`);
    }
  }

  console.log(
    `[repair] brains=${report.brains} pagesDigested=${report.pagesDigested} ` +
      `pagesSkipped=${report.pagesSkipped} underived=${report.underivedDerived} ` +
      `embeddingsRetried=${report.embeddingsRetried}`,
  );
  return report;
}
