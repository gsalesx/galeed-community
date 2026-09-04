/** Ingestão de DOCUMENTO (M3/S2): extrai texto, FATIA (nunca trunca/descarta) e captura N páginas-slice.
 *  Fecha o invariante #5 — o `extract` trunca em 60k; aqui fatiamos em janelas folgadas antes disso. */
import { createHash } from "node:crypto";
import { capture } from "./capture.ts";
import { extractDocText, detectDocKind } from "../../lib/extract-doc.ts";
import { getBlobStore } from "./blob-store.ts";
import { closeSharedSql, getSharedSql, sharedSqlGeneration } from "../platform/db-conn.ts";

/** Fatia em janelas <= maxChars na FRONTEIRA DE PARÁGRAFO (nunca corta palavra, nunca descarta). */
export function sliceForIngest(text: string, maxChars = 40000): { part: number; total: number; text: string }[] {
  const t = text || "";
  if (t.length <= maxChars) return [{ part: 1, total: 1, text: t }];

  const chunks: string[] = [];
  let buf = "";
  const flush = () => {
    if (buf.trim()) chunks.push(buf.trim());
    buf = "";
  };
  const pushPiece = (piece: string) => {
    if (piece.length > maxChars) {
      // parágrafo gigante → quebra por sentença; sentença gigante → janela de char (último recurso)
      const sentences = piece.split(/(?<=[.!?])\s+/);
      for (const s of sentences) {
        if (s.length > maxChars) {
          for (let i = 0; i < s.length; i += maxChars) {
            if (buf) flush();
            chunks.push(s.slice(i, i + maxChars));
          }
        } else {
          if (buf.length + s.length + 1 > maxChars) flush();
          buf += (buf ? " " : "") + s;
        }
      }
      return;
    }
    if (buf.length + piece.length + 2 > maxChars) flush();
    buf += (buf ? "\n\n" : "") + piece;
  };

  for (const para of t.split(/\n\s*\n/)) pushPiece(para);
  flush();

  const total = chunks.length;
  return chunks.map((text, i) => ({ part: i + 1, total, text }));
}

export interface IngestDocInput {
  home: string;
  buffer: Buffer;
  contentType?: string;
  filename?: string;
  title?: string;
  date?: string;
  source?: string;
  externalId?: string;
  type?: string;
}
export interface IngestDocResult {
  docHash: string;
  total: number;
  slugs: string[];
  kind: string;
  skipped: number;
  blobKey: string; // M11: chave do original verbatim no BlobStore
}

/** Metadados de proveniência do blob (subset do que o BlobStore guarda). */
export interface PutBlobMeta {
  contentType?: string;
  filename?: string;
  source?: string; // "upload" | "paste" | ... (default "upload")
}

/** Resultado do "grava SÓ o blob" — o que o handler async (S5) precisa pra enfileirar o job. */
export interface PutBlobResult {
  docHash: string; // sha256(buffer).slice(0,16) — chave do blob e content_hash do job
  blobKey: string; // chave de armazenamento (fs path / supabase key)
  kind: string; // DocKind detectado (pdf|csv|tsv|markdown|text|...) — pista p/ o pipeline
}

/** M12/S2 — grava SÓ o ORIGINAL VERBATIM no blob + ponteiro galeed_blobs. NÃO fatia, NÃO captura, NÃO
 *  extrai. Rápido o bastante p/ rodar na request HTTP (o handler async chama isto + enfileira o job).
 *  Idempotente por (home, docHash) — re-upload do mesmo arquivo não regrava (hash é o conteúdo). */
export async function putBlobOnly(
  home: string,
  buffer: Buffer,
  meta: PutBlobMeta,
): Promise<PutBlobResult> {
  const docHash = createHash("sha256").update(buffer).digest("hex").slice(0, 16);
  const mime = meta.contentType || "application/octet-stream";
  const filename = meta.filename || "";
  const source = meta.source || "upload";
  const kind = detectDocKind(meta.contentType, meta.filename); // de ../lib/extract-doc.ts
  const { key: blobKey } = await getBlobStore().put(home, docHash, buffer, { mime, filename, source });
  await upsertBlobPointer(home, { content_hash: docHash, key: blobKey, mime, filename, source });
  return { docHash, blobKey, kind };
}

export async function ingestDocument(inp: IngestDocInput): Promise<IngestDocResult> {
  const { text, kind } = await extractDocText(inp.buffer, inp.contentType, inp.filename);

  // M11/M12: grava o ORIGINAL VERBATIM no blob (idempotente por hash) + ponteiro/proveniência, ANTES de
  // fatiar/capturar — via putBlobOnly (M12/S2, mesmo código de hash/store/ponteiro de antes). O `body`
  // continua derivado de extractDocText (usamos o `kind` dele, não o de putBlobOnly, p/ preservar 100%
  // o comportamento) — a captura NÃO muda. O blob é a evidência crua (com PII); o download dele herda o
  // RBAC do M7 (ver bff-blob.ts).
  const { docHash, blobKey } = await putBlobOnly(inp.home, inp.buffer, {
    contentType: inp.contentType,
    filename: inp.filename,
    source: inp.source,
  });

  const base = inp.externalId || docHash;
  const slices = sliceForIngest(text);

  const slugs: string[] = [];
  let skipped = 0;
  for (const sl of slices) {
    const r = await capture({
      home: inp.home,
      text: sl.text,
      type: inp.type,
      title: `${inp.title || inp.filename || "documento"} (parte ${sl.part}/${sl.total})`,
      date: inp.date,
      source: inp.source,
      externalId: `${base}#${sl.part}`,
      tags: [`doc:${docHash}`],
    });
    slugs.push(r.slug);
    if (r.skipped) skipped++;
  }
  return { docHash, total: slices.length, slugs, kind, skipped, blobKey };
}

// ---------- ponteiro do blob em galeed_blobs (proveniência) ----------
// Schema lazy sobre a conexão compartilhada: brain-independente na conexão, escopada por `brain` na query.
// NÃO mexe no Engine (dono único, fora do território). A tabela vem da migração id 14 (migrations.ts);
// aqui um `create table if not exists` idempotente no boot lazy, pra não depender da ordem de execução
// das migrações do engine.

let _ready: Promise<void> | null = null;
let _readyGeneration = -1;

async function db(): Promise<any> {
  const sql = await getSharedSql();
  const gen = sharedSqlGeneration();
  if (_ready && _readyGeneration === gen) {
    await _ready;
    return sql;
  }
  _readyGeneration = gen;
  _ready = (async () => {
    // idempotente — espelha a migração id 14 (migrations.ts). Boot lazy não depende da ordem do engine.
    await sql.unsafe(`
      create table if not exists galeed_blobs (
        brain text, content_hash text, key text, mime text, filename text, source text,
        ingested_at timestamptz default now(),
        primary key (brain, content_hash)
      )
    `);
  })();
  await _ready;
  return sql;
}

/** Fecha a conexão do módulo de blobs (testes / shutdown). No-op se nunca abriu. */
export async function closeBlobPointers(): Promise<void> {
  _ready = null;
  _readyGeneration = -1;
  await closeSharedSql();
}

/** Registra o ponteiro do blob. Idempotente: re-ingestão do mesmo (brain, content_hash) não duplica. */
async function upsertBlobPointer(
  home: string,
  p: { content_hash: string; key: string; mime: string; filename: string; source: string },
): Promise<void> {
  const sql = await db();
  await sql`
    insert into galeed_blobs (brain, content_hash, key, mime, filename, source, ingested_at)
    values (${home}, ${p.content_hash}, ${p.key}, ${p.mime}, ${p.filename}, ${p.source}, now())
    on conflict (brain, content_hash) do nothing`;
}

/** Resolve o ponteiro do original de um (brain, content_hash). null se não há blob guardado.
 *  O `bff-blob.ts` usa ISTO + getBlobStore().get para servir o download (GATED pelo RBAC do M7). */
export async function blobPointerFor(
  home: string,
  contentHash: string,
): Promise<{ key: string; mime: string; filename: string } | null> {
  const sql = await db();
  const rows = (await sql`
    select key, mime, filename
    from galeed_blobs
    where brain = ${home} and content_hash = ${contentHash}
    limit 1`) as any[];
  if (!rows.length) return null;
  return { key: rows[0].key, mime: rows[0].mime, filename: rows[0].filename };
}
