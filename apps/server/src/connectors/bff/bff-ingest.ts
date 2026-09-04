/** M12/S5 — handler de IMPORT ASSÍNCRONO (ADR-006). Inverte o M11/S5: em vez de ingerir síncrono na
 *  request, grava SÓ o blob (putBlobOnly, S2) + enfileira um JOB (S1) + devolve rápido { jobId, status }.
 *  O WORKER (S4) processa depois (fatia → captura → extractOne → buildIndex).
 *  Invariantes: rápido (zero extração na request); 202 no web-server; escopo por home (requireBrain). */
import { createHash } from "node:crypto";
import { putBlobOnly } from "../../core/ingestion/ingest-doc.ts";
import { enqueueIngestJob, type IngestJobStatus } from "../../core/ingestion/ingest-queue.ts";
import { getEngine } from "../../core/platform/engine.ts";
import { detectDocKind } from "../../lib/extract-doc.ts";
import { BffError } from "./bff-common.ts";

/** Formatos de DOCUMENTO aceitos (o que extractDocText lê). */
const ACCEPTED_DOC_KINDS = new Set(["pdf", "csv", "tsv", "markdown", "text"]);

/** Entrada do import via front. `kind` decide o caminho. Tudo escopado por `home` (requireBrain). */
export interface IngestInput {
  kind: "file" | "text";
  type: string;            // tipo DECLARADO (D4)
  base64?: string;         // file
  filename?: string;       // file
  contentType?: string;    // file
  text?: string;           // text
  title?: string;
  date?: string;           // YYYY-MM-DD
  sourceId?: string;       // M21/S3 — fonte (galeed_sources.id) sob cujo contrato este doc entra
}

/** Resposta do enqueue — o web-server responde 202 com isto. (NÃO é o resultado da ingestão; é o ticket.) */
export interface EnqueueResult {
  jobId: string;
  status: IngestJobStatus;   // sempre "queued" no enqueue
}

export async function ingestHandler(home: string, input: IngestInput): Promise<EnqueueResult> {
  // M21/S3 — ingestão por uma FONTE: valida na borda que ela existe e está ativa; o tipo da fonte
  // vira o default. SEM sourceId, nenhuma linha do fluxo atual muda.
  const sourceId = typeof input.sourceId === "string" && input.sourceId ? input.sourceId : undefined;
  if (sourceId) {
    const e = await getEngine(home);
    const source = await e.getSource(sourceId);
    if (!source) throw new BffError(404, "essa fonte não existe mais.");
    if (source.status === "pausada")
      throw new BffError(409, "essa fonte está pausada — retome a leitura pra adicionar.");
    if (!input.type) input.type = source.type; // tipo default da fonte
  }

  const type = (input.type || "").trim();
  if (!type) throw new BffError(400, "diga que tipo de coisa é (ex.: call de venda, conversa).");

  if (input.kind === "file") {
    if (!input.base64) throw new BffError(400, "arquivo vazio.");
    const kind = detectDocKind(input.contentType, input.filename);
    if (!ACCEPTED_DOC_KINDS.has(kind)) {
      throw new BffError(415, `formato não suportado ainda: ${kind}. Use PDF, Markdown, TXT ou CSV — ou cole o texto. (.zip de WhatsApp: descompacte e suba o _chat.txt.)`);
    }
    const buffer = Buffer.from(input.base64, "base64");
    // grava SÓ o blob (rápido) — o worker lê depois pelo content_hash.
    const { docHash } = await putBlobOnly(home, buffer, {
      contentType: input.contentType, filename: input.filename, source: "upload",
    });
    const { jobId, status } = await enqueueIngestJob({
      brain: home, kind: "file", type,
      contentHash: docHash,
      filename: input.filename, mime: input.contentType,
      title: input.title, jobDate: input.date, sourceId,
    });
    return { jobId, status };
  }

  // text colado
  const text = (input.text || "").trim();
  if (!text) throw new BffError(400, "cole algum texto.");
  const contentHash = createHash("sha256").update(text).digest("hex").slice(0, 16); // idempotência do paste
  const { jobId, status } = await enqueueIngestJob({
    brain: home, kind: "text", type,
    contentHash, textBody: text,
    title: input.title, jobDate: input.date, sourceId,
  });
  return { jobId, status };
}
