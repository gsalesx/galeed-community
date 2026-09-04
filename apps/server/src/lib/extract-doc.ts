/** Documento → TEXTO (determinístico, sem LLM). PDF é best-effort (dep opcional 'unpdf').
 *  Princípio (invariante #5): nunca devolver texto parcial/garbage em silêncio — ou extrai, ou erra claro. */

export type DocKind = "pdf" | "csv" | "tsv" | "markdown" | "text" | "unknown";

/** Tipo por content-type E/OU extensão do nome (o que vier). */
export function detectDocKind(contentType: string | undefined, filename: string | undefined): DocKind {
  const ct = (contentType || "").toLowerCase();
  const ext = (filename || "").toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || "";
  if (ct.includes("pdf") || ext === "pdf") return "pdf";
  if (ct.includes("csv") || ext === "csv") return "csv";
  if (ct.includes("tab-separated") || ext === "tsv") return "tsv";
  if (ct.includes("markdown") || ext === "md" || ext === "markdown") return "markdown";
  if (ct.startsWith("text/") || ext === "txt") return "text";
  return "unknown";
}

/** Parser CSV/TSV próprio (zero-dep): respeita aspas duplas e o delimitador. */
function parseDelimited(raw: string, delim: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (inQuotes) {
      if (c === '"') {
        if (raw[i + 1] === '"') { field += '"'; i++; } // aspas escapada ""
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === delim) {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && raw[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim().length));
}

/** Tabela → linhas legíveis "h1: v1 | h2: v2" (1ª linha = cabeçalho). */
function tabularToText(rows: string[][]): string {
  if (!rows.length) return "";
  const header = rows[0].map((h) => h.trim());
  const body = rows.slice(1);
  if (!body.length) return header.join(" | ");
  return body
    .map((r) => header.map((h, i) => `${h}: ${(r[i] ?? "").trim()}`).join(" | "))
    .join("\n");
}

export async function extractDocText(
  buffer: Buffer,
  contentType?: string,
  filename?: string,
): Promise<{ text: string; kind: DocKind }> {
  const kind = detectDocKind(contentType, filename);
  if (kind === "text" || kind === "markdown") return { text: buffer.toString("utf8"), kind };
  if (kind === "csv") return { text: tabularToText(parseDelimited(buffer.toString("utf8"), ",")), kind };
  if (kind === "tsv") return { text: tabularToText(parseDelimited(buffer.toString("utf8"), "\t")), kind };
  if (kind === "pdf") {
    let unpdf: any;
    try {
      unpdf = await import("unpdf");
    } catch {
      throw new Error("PDF requer 'unpdf' — rode: npm i unpdf");
    }
    const pdf = await unpdf.getDocumentProxy(new Uint8Array(buffer));
    const { text } = await unpdf.extractText(pdf, { mergePages: true });
    return { text: Array.isArray(text) ? text.join("\n") : String(text), kind };
  }
  // unknown: tenta utf8, mas recusa binário (>30% de bytes de controle)
  const sample = buffer.subarray(0, 4096);
  let ctrl = 0;
  for (const b of sample) if (b < 9 || (b > 13 && b < 32)) ctrl++;
  if (sample.length && ctrl / sample.length > 0.3) throw new Error(`tipo de documento não suportado: ${filename || "(sem nome)"}`);
  return { text: buffer.toString("utf8"), kind: "unknown" };
}
