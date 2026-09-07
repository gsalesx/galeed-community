/** Exclui um ingest MANUAL (upload/colar da UI Adicionar).
 *
 *  Não existe delete de página no engine — só arquivo (lixeira). Este handler é o menor
 *  cascade honesto: apaga o job + páginas/fatos/extrações/vetores QUE SÓ este job criou.
 *  Fonte WhatsApp, jobs de conector e páginas de outro ingest NÃO entram.
 *
 *  Distinção (não há flag `manual` / instance_id):
 *   - kind=text → UI Adicionar ou /v1/ingest; WhatsApp/conectores NUNCA criam kind=text
 *     (passam por deliverConnectorPayload → kind=file + blob source=connector).
 *   - kind=file → só se galeed_blobs.source='upload', ou (sem blob ainda) nome com
 *     extensão da dropzone (.pdf/.md/.txt/.csv/.tsv) e não `wa:`.
 */
import { getSharedSql } from "../../core/platform/db-conn.ts";
import { deleteJob, getJob, type IngestJob } from "../../core/ingestion/ingest-queue.ts";
import { BffError } from "./bff-common.ts";

const MANUAL_FILE_EXT = /\.(pdf|md|markdown|txt|csv|tsv)$/i;

export function isManualIngestJob(
  job: Pick<IngestJob, "kind" | "filename">,
  blobSource?: string | null,
): boolean {
  if (job.kind === "text") return true;
  if (job.kind !== "file") return false;
  if (blobSource === "upload") return true;
  if (blobSource === "connector" || blobSource === "github") return false;
  const fn = job.filename || "";
  if (!fn || /^wa:/i.test(fn)) return false;
  return !blobSource && MANUAL_FILE_EXT.test(fn);
}

export interface DeleteManualIngestResult {
  deleted: true;
  jobId: string;
  slugs: string[];
  facts: number;
  pages: number;
}

function slugsFromResult(job: IngestJob): string[] {
  const raw = job.resultJson?.slugs;
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((s): s is string => typeof s === "string" && !!s.trim()).map((s) => s.trim()))];
}

async function blobSourceOf(home: string, contentHash: string | null): Promise<string | null> {
  if (!contentHash) return null;
  try {
    const sql = await getSharedSql();
    const rows = (await sql`
      select source from galeed_blobs
       where brain = ${home} and content_hash = ${contentHash}
       limit 1`) as any[];
    return rows[0]?.source != null ? String(rows[0].source) : null;
  } catch {
    return null;
  }
}

export async function blobSourcesByHash(home: string, hashes: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!hashes.length) return out;
  try {
    const sql = await getSharedSql();
    const rows = (await sql`
      select content_hash, source from galeed_blobs
       where brain = ${home} and content_hash = any(${hashes})`) as any[];
    for (const r of rows) {
      if (r.content_hash) out.set(String(r.content_hash), String(r.source ?? ""));
    }
  } catch {
    /* sem galeed_blobs ainda — lista segue; canDelete cai na heurística de filename */
  }
  return out;
}

async function extraSlugs(home: string, job: IngestJob): Promise<string[]> {
  try {
    const sql = await getSharedSql();
    const found: string[] = [];
    if (job.kind === "file" && job.contentHash) {
      const tag = `doc:${job.contentHash}`;
      const rows = (await sql`
        select slug from galeed_pages
         where brain = ${home} and tags @> ${sql.json([tag])}`) as any[];
      for (const r of rows) if (r.slug) found.push(String(r.slug));
    }
    if (job.kind === "text" && job.contentHash) {
      const rows = (await sql`
        select slug from galeed_pages
         where brain = ${home}
           and content_hash = ${job.contentHash}
           and tags @> ${sql.json(["fonte:paste"])}`) as any[];
      for (const r of rows) if (r.slug) found.push(String(r.slug));
    }
    return found;
  } catch {
    return [];
  }
}

async function slugsClaimedByOthers(home: string, jobId: string): Promise<Set<string>> {
  const sql = await getSharedSql();
  const rows = (await sql`
    select result_json from galeed_ingest_jobs
     where brain = ${home} and id <> ${jobId} and status not in ('error', 'dead')`) as any[];
  const claimed = new Set<string>();
  for (const r of rows) {
    const slugs = r.result_json?.slugs;
    if (!Array.isArray(slugs)) continue;
    for (const s of slugs) if (typeof s === "string" && s.trim()) claimed.add(s.trim());
  }
  return claimed;
}

/** DELETE /api/ingest/jobs/:id — só job manual do brain. 404 alheio; 409 se não for upload/colar.
 *
 *  Cada fato tem UM source_slug (não há fato multi-fonte). Apaga só linhas cujo slug é deste
 *  documento. Fatos do WhatsApp/outras páginas (outro slug) ficam. NÃO chama extract, derive,
 *  buildIndex nem relê fontes — o resto do cérebro não é reprocessado. */
export async function deleteManualIngestHandler(home: string, jobId: string): Promise<DeleteManualIngestResult> {
  const id = (jobId || "").trim();
  if (!id) throw new BffError(400, "diga qual envio remover.");

  const job = await getJob(home, id);
  if (!job) throw new BffError(404, "esse envio não existe mais.");

  const blobSource = await blobSourceOf(home, job.contentHash);
  if (!isManualIngestJob(job, blobSource)) {
    throw new BffError(409, "só dá pra remover o que entrou pelo Adicionar (arquivo ou texto colado).");
  }

  const claimed = await slugsClaimedByOthers(home, job.id);
  const candidates = [...new Set([...slugsFromResult(job), ...(await extraSlugs(home, job))])];
  const slugs = candidates.filter((s) => !claimed.has(s));

  const sql = await getSharedSql();
  let facts = 0;
  let pages = 0;
  if (slugs.length) {
    const factRows = (await sql`
      delete from galeed_facts
       where brain = ${home} and source_slug = any(${slugs})
       returning source_slug`) as any[];
    facts = factRows.length;
    await sql`delete from galeed_extractions where brain = ${home} and source_slug = any(${slugs})`;
    await sql`delete from galeed_ingest_review where brain = ${home} and source_slug = any(${slugs})`;
    await sql`delete from galeed_vectors where brain = ${home} and slug = any(${slugs})`;
    await sql`
      delete from galeed_edges
       where brain = ${home}
         and kind = 'semantic'
         and (src = any(${slugs}) or dst = any(${slugs}))`;
    await sql`
      delete from galeed_contradictions
       where brain = ${home}
         and (a_slug = any(${slugs}) or b_slug = any(${slugs}))`.catch(() => []);
    const pageRows = (await sql`
      delete from galeed_pages
       where brain = ${home} and slug = any(${slugs})
       returning slug`) as any[];
    pages = pageRows.length;
  }

  const removed = await deleteJob(home, job.id);
  if (!removed) throw new BffError(404, "esse envio não existe mais.");

  if (job.contentHash && blobSource === "upload") {
    await sql`
      delete from galeed_blobs
       where brain = ${home}
         and content_hash = ${job.contentHash}
         and source = 'upload'
         and not exists (
           select 1 from galeed_ingest_jobs j
            where j.brain = ${home}
              and j.content_hash = ${job.contentHash}
              and j.id <> ${job.id}
         )`.catch(() => []);
  }

  return { deleted: true, jobId: job.id, slugs, facts, pages };
}
