/** M12/S5 — leitura do status da fila de ingestão (porta do front p/ o polling). Escopado por home
 *  (requireBrain garante 403 cross-tenant ANTES; getJob também filtra por brain → não vaza). */
import { listJobs, getJob, type IngestJob } from "../../core/ingestion/ingest-queue.ts";
import { BffError } from "./bff-common.ts";

/** Jobs do brain, mais recentes primeiro. */
export async function listJobsHandler(home: string): Promise<IngestJob[]> {
  return listJobs(home);
}

/** Status de 1 job DO BRAIN. 404 se não existe ou não é do brain (não vaza cross-tenant). */
export async function getJobHandler(home: string, jobId: string): Promise<IngestJob> {
  const job = await getJob(home, jobId);
  if (!job) throw new BffError(404, "job não encontrado.");
  return job;
}
