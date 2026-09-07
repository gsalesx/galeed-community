/** M12/S5 — leitura do status da fila de ingestão (porta do front p/ o polling). Escopado por home
 *  (requireBrain garante 403 cross-tenant ANTES; getJob também filtra por brain → não vaza). */
import { listJobs, getJob, type IngestJob } from "../../core/ingestion/ingest-queue.ts";
import { blobSourcesByHash, isManualIngestJob } from "./bff-ingest-delete.ts";
import { BffError } from "./bff-common.ts";

export type IngestJobView = IngestJob & { canDelete: boolean };

/** Jobs do brain, mais recentes primeiro. `canDelete` só em upload/colar da UI Adicionar. */
export async function listJobsHandler(home: string): Promise<IngestJobView[]> {
  const jobs = await listJobs(home);
  const hashes = [...new Set(jobs.map((j) => j.contentHash).filter((h): h is string => !!h))];
  const sources = await blobSourcesByHash(home, hashes);
  return jobs.map((j) => ({
    ...j,
    canDelete: isManualIngestJob(j, j.contentHash ? sources.get(j.contentHash) ?? null : null),
  }));
}

/** Status de 1 job DO BRAIN. 404 se não existe ou não é do brain (não vaza cross-tenant). */
export async function getJobHandler(home: string, jobId: string): Promise<IngestJob> {
  const job = await getJob(home, jobId);
  if (!job) throw new BffError(404, "job não encontrado.");
  return job;
}
