/** PASTA-WATCHER — o ingestor de PASTA LOCAL (`galeed pasta --dir <pasta>`).
 *
 *  Pra que serve: "leitura de arquivos em pastas do Drive" SEM OAuth — o aluno instala o
 *  Google Drive for Desktop (ou OneDrive/Dropbox), sincroniza a pasta pro disco e aponta o
 *  watcher pra ela. Todo arquivo novo/alterado entra na MESMA fila assíncrona da tela
 *  Adicionar (worker processa; progresso aparece no painel).
 *
 *  Robustez:
 *   - dedupe RESTART-SAFE: o hash do arquivo é consultado na fila (galeed_ingest_jobs) antes de
 *     enfileirar — rodar de novo não re-ingere o que já entrou (mesmo comportamento do seam);
 *   - arquivo "quieto": só ingere quando o mtime está estável há STABLE_MS (evita pegar um
 *     arquivo no meio do sync);
 *   - formatos: os MESMOS da tela Adicionar (pdf/md/txt/csv/tsv). Atalhos do Drive (.gdoc/.gsheet/
 *     .gslides) são PONTEIROS, não o conteúdo — são pulados com aviso (exporte como PDF).
 *
 *  Sem daemon novo: é um comando do CLI que fica rodando (Ctrl-C pra parar; --once pra 1 varredura). */
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, extname, basename } from "node:path";
import { putBlobOnly } from "../core/ingestion/ingest-doc.ts";
import { enqueueIngestJob } from "../core/ingestion/ingest-queue.ts";
import { getSharedSql } from "../core/platform/db-conn.ts";

const EXT_OK = new Map<string, string>([
  [".pdf", "application/pdf"],
  [".md", "text/markdown"],
  [".markdown", "text/markdown"],
  [".txt", "text/plain"],
  [".csv", "text/csv"],
  [".tsv", "text/tab-separated-values"],
]);
const DRIVE_POINTERS = new Set([".gdoc", ".gsheet", ".gslides", ".gdraw"]);
const SKIP_PREFIXES = ["~$", "."]; // temporários de editor + ocultos
const STABLE_MS = 5_000; // arquivo precisa estar "quieto" há 5s (sync no meio do caminho)
const MAX_DEPTH = 6;
const MAX_BYTES = 25 * 1024 * 1024; // 25 MB por arquivo (mesmo teto do webhook legado)

export interface PastaOpts {
  brain: string;
  dir: string;
  type: string; // tipo declarado dos docs (default "documento")
  intervalMs: number;
  once: boolean;
  log?: (msg: string) => void;
}

interface Achado { path: string; mtimeMs: number; size: number }

async function varrer(dir: string, depth: number, out: Achado[], log: (m: string) => void): Promise<void> {
  if (depth > MAX_DEPTH) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (e) {
    log(`aviso: não consegui ler ${dir}: ${e instanceof Error ? e.message : e}`);
    return;
  }
  for (const ent of entries) {
    const p = join(dir, ent.name);
    if (SKIP_PREFIXES.some((pre) => ent.name.startsWith(pre))) continue;
    if (ent.isDirectory()) {
      await varrer(p, depth + 1, out, log);
      continue;
    }
    const ext = extname(ent.name).toLowerCase();
    if (DRIVE_POINTERS.has(ext)) {
      log(`pulado (atalho do Drive, não é o conteúdo): ${ent.name} — exporte como PDF pra ingerir.`);
      continue;
    }
    if (!EXT_OK.has(ext)) continue;
    try {
      const s = await stat(p);
      if (s.size === 0 || s.size > MAX_BYTES) {
        if (s.size > MAX_BYTES) log(`pulado (maior que 25 MB): ${ent.name}`);
        continue;
      }
      out.push({ path: p, mtimeMs: s.mtimeMs, size: s.size });
    } catch {
      /* sumiu entre o readdir e o stat — ignora */
    }
  }
}

/** dedupe restart-safe: já existe job (não-erro) deste conteúdo neste brain? */
async function jaEntrou(brain: string, docHash: string): Promise<boolean> {
  const sql = await getSharedSql();
  const rows = (await sql`
    select id from galeed_ingest_jobs
     where brain = ${brain} and content_hash = ${docHash} and status not in ('error','dead')
     limit 1`) as unknown[];
  return rows.length > 0;
}

export async function runPastaWatcher(opts: PastaOpts): Promise<void> {
  const log = opts.log ?? ((m: string) => console.error(`[pasta] ${m}`));
  // hash local por caminho+mtime: evita re-hashear arquivo não modificado a cada varredura.
  const vistos = new Map<string, number>(); // path → mtimeMs já processado

  log(`vigiando ${opts.dir} (brain=${opts.brain}, tipo=${opts.type}, a cada ${Math.round(opts.intervalMs / 1000)}s)`);
  log(`formatos: pdf, md, txt, csv, tsv · Google Docs nativos: exporte como PDF (o .gdoc é só um atalho)`);

  for (;;) {
    const achados: Achado[] = [];
    await varrer(opts.dir, 0, achados, log);
    const agora = Date.now();

    for (const a of achados) {
      if (vistos.get(a.path) === a.mtimeMs) continue; // sem mudança desde a última vez
      if (agora - a.mtimeMs < STABLE_MS) continue; // ainda "quente" (sync no meio) — próxima volta pega

      try {
        const buffer = await readFile(a.path);
        const docHash = createHash("sha256").update(buffer).digest("hex").slice(0, 16);
        if (await jaEntrou(opts.brain, docHash)) {
          vistos.set(a.path, a.mtimeMs); // conteúdo já está no cérebro — marca e segue
          continue;
        }
        const nome = basename(a.path);
        const mime = EXT_OK.get(extname(nome).toLowerCase());
        await putBlobOnly(opts.brain, buffer, { contentType: mime, filename: nome, source: "pasta" });
        const { jobId } = await enqueueIngestJob({
          brain: opts.brain,
          kind: "file",
          type: opts.type,
          contentHash: docHash,
          filename: nome,
          mime,
          title: nome,
        });
        vistos.set(a.path, a.mtimeMs);
        log(`enfileirado: ${nome} (job ${jobId})`);
      } catch (e) {
        log(`erro em ${a.path}: ${e instanceof Error ? e.message : e}`);
      }
    }

    if (opts.once) return;
    await new Promise((r) => setTimeout(r, opts.intervalMs));
  }
}
