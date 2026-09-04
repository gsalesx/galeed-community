/** M22-C — NORMALIZADOR Gmail: e-mail (record do Nango) → documento textual pro SEAM único.
 *  Módulo PURO e ISOLADO (invariante III / ADR-002): o core nunca sabe o que é "gmail" — quem o
 *  invoca é o dispatch do M22-A (registro = 1 linha do Integrador no reconcile). Zero IO, zero env,
 *  zero clock, zero fetch (NUNCA busca URL — o record chega pronto; SSRF impossível por construção).
 *
 *  FONTES (o "input real" = contrato oficial, invariante #9 adaptado):
 *   - Shape do Message (id/threadId/historyId/internalDate epoch-ms/snippet/payload com
 *     headers[]/mimeType/body.data base64url/parts[]/filename):
 *     https://developers.google.com/gmail/api/reference/rest/v1/users.messages
 *   - users.messages.get (format=full) — payload com body.data:
 *     https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/get
 *   - Formato de mensagem internet (header De/Para/Assunto/Data): RFC 2822
 *     https://www.rfc-editor.org/rfc/rfc2822 (Appendix A.1.1)
 *   - Template oficial Nango (modelo `Message`, provider key `google-mail`):
 *     https://github.com/NangoHQ/integration-templates/blob/main/integrations/google-mail/syncs/messages.ts */

import type { SourceRecipe, SourceRow } from "../../platform/engine.ts";

/** Shape do record que a sync (nango/google-mail/syncs/messages.ts, modelo `Message`) salva no
 *  Nango — espelho 1:1 do Message do Gmail API (users.messages.get format=full).
 *  Fonte: https://developers.google.com/gmail/api/reference/rest/v1/users.messages */
export interface GmailHeader {
  name: string;
  value: string;
}
export interface GmailMessagePart {
  mimeType?: string;
  filename?: string; // não-vazio ⇒ anexo (ignorado no v1)
  headers?: GmailHeader[];
  body?: { size?: number; data?: string; attachmentId?: string }; // data = base64url
  parts?: GmailMessagePart[]; // multipart/* aninha aqui
}
export interface GmailMessageRecord {
  id: string; // imutável — a base do externalRef
  threadId: string;
  historyId?: string;
  internalDate?: string; // epoch ms (string) — a DATA DO E-MAIL canônica
  snippet?: string;
  labelIds?: string[];
  payload?: GmailMessagePart;
  sizeEstimate?: number;
}

/** O documento que o conector EMITE pro seam (BRIEF §2-II). É o payload do seam SEM sourceId — o
 *  dispatch do M22-A espalha { ...doc, sourceId } ao entregar. camelCase byte-igual ao ConnectorPayload
 *  do M22-A sem o sourceId (adjudicação do árbitro: M22-C não importa tipo do M22-A — compat ESTRUTURAL). */
export interface EmailDocument {
  content: string; // cabeçalho determinístico PT + corpo texto (§4.2.1)
  contentType: "text/plain";
  timestamp: string; // ISO-8601 UTC — a data DO E-MAIL, nunca a da ingestão
  externalRef: string; // `gmail:${record.id}` — delta POR MENSAGEM (re-sync não duplica)
  title: string; // Assunto; "(sem assunto)" se vazio
}

/** Contexto que o dispatch do M22-A injeta no normalize estrutural (sourceId da fonte + model Nango).
 *  M22-C não importa o tipo do A — compat estrutural (adjudicação do árbitro). */
export interface GmailNormalizeCtx {
  sourceId: string;
  model?: string;
}

/** Payload de entrega = EmailDocument + sourceId injetado pelo dispatch (compat estrutural com o
 *  ConnectorPayload do M22-A). */
export type GmailDeliverPayload = EmailDocument & { sourceId: string };

/** Busca case-insensitive de um header em payload.headers. "" se ausente. */
function header(part: GmailMessagePart | undefined, name: string): string {
  const lower = name.toLowerCase();
  const h = part?.headers?.find((x) => x.name?.toLowerCase() === lower);
  return (h?.value ?? "").trim();
}

/** Decodifica base64url (alfabeto URL-safe: -/_ , sem padding) → utf8. */
function decodeBase64Url(data: string): string {
  return Buffer.from(data, "base64url").toString("utf8");
}

/** Coleta DFS (profundidade) os body.data das parts cujo mimeType === alvo, PULANDO anexos
 *  (filename não-vazio) e parts com attachmentId sem data. Determinístico (ordem da árvore). */
function collectParts(part: GmailMessagePart | undefined, mime: string, out: string[]): void {
  if (!part) return;
  // anexo (filename não-vazio) — ignorado no v1 inteiro (inclusive sua subárvore).
  if (part.filename && part.filename.trim() !== "") return;
  const isLeaf = !part.parts || part.parts.length === 0;
  if (isLeaf) {
    const data = part.body?.data;
    const hasAttachmentRef = !!part.body?.attachmentId;
    if ((part.mimeType ?? "") === mime && data && !hasAttachmentRef) {
      out.push(decodeBase64Url(data));
    }
    return;
  }
  for (const child of part.parts ?? []) collectParts(child, mime, out);
}

/** html → texto: conversão MÍNIMA determinística (§4.2.2 — invariante #9: SEM parser estrutural;
 *  remoção de markup bounded, espelho do espírito de slugify/normalize em src/lib/). Exportada pra
 *  teste direto. */
export function htmlParaTexto(html: string): string {
  let s = html;
  // 1) blocos não-textuais inteiros.
  s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gis, "");
  s = s.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gis, "");
  s = s.replace(/<head\b[^>]*>[\s\S]*?<\/head>/gis, "");
  // 2) tags de quebra → newline.
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, "\n");
  // 3) remove TODAS as demais tags.
  s = s.replace(/<[^>]+>/g, "");
  // 4) entidades.
  s = s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_m, d) => {
      const cp = Number(d);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : _m;
    })
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => {
      const cp = parseInt(h, 16);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : _m;
    });
  // 5) colapsa whitespace.
  s = s.replace(/[ \t]+/g, " ");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

/** Resolve o corpo textual do e-mail (preferência text/plain; senão html→texto; senão snippet).
 *  "" se nada recuperável. */
function resolveBody(record: GmailMessageRecord): string {
  const payload = record.payload;
  if (payload) {
    const plains: string[] = [];
    collectParts(payload, "text/plain", plains);
    if (plains.length) return plains.join("\n\n");
    const htmls: string[] = [];
    collectParts(payload, "text/html", htmls);
    if (htmls.length) {
      const texto = htmls.map((h) => htmlParaTexto(h)).filter((t) => t !== "").join("\n\n");
      if (texto !== "") return texto;
    }
  }
  // sem corpo (ou html só de imagem): cai no snippet.
  return (record.snippet ?? "").trim();
}

/** Data DO E-MAIL (a regra de ouro do pacote): internalDate (epoch ms) → ISO; senão header Date
 *  (RFC 2822); senão null. NUNCA new Date() corrente. */
function resolveTimestamp(record: GmailMessageRecord): string | null {
  const internal = record.internalDate;
  if (internal != null && internal !== "") {
    const n = Number(internal);
    if (Number.isFinite(n)) return new Date(n).toISOString();
  }
  const dateHeader = header(record.payload, "Date");
  if (dateHeader) {
    const d = new Date(dateHeader);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return null;
}

/** e-mail → documento. null = sem conteúdo/data recuperável (caller loga — nunca descarte mudo). */
export function normalizeGmailMessage(record: GmailMessageRecord): EmailDocument | null {
  const timestamp = resolveTimestamp(record);
  if (!timestamp) return null; // e-mail sem data ancorável não entra como fato datado-hoje.

  const body = resolveBody(record);
  if (body === "") return null; // sem corpo nem snippet.

  const de = header(record.payload, "From") || "—";
  const para = header(record.payload, "To") || "—";
  const cc = header(record.payload, "Cc"); // SÓ se presente
  const subjectRaw = header(record.payload, "Subject");
  const title = subjectRaw || "(sem assunto)";
  const data = timestamp.slice(0, 10);
  const externalRef = `gmail:${record.id}`;

  // Cabeçalho determinístico PT (linhas fixas, na ordem; Cc só se presente; Ref renderizado).
  const lines = [
    `De: ${de}`,
    `Para: ${para}`,
    ...(cc ? [`Cc: ${cc}`] : []),
    `Assunto: ${subjectRaw || "(sem assunto)"}`,
    `Data: ${data}`,
    `Ref: ${externalRef}`,
  ];
  const content = `${lines.join("\n")}\n\n${body}`;

  return {
    content,
    contentType: "text/plain",
    timestamp,
    externalRef,
    title,
  };
}

/** RECEITA da fonte e-mail comercial (DADO, ADR-016/invariante III): as 3 classes do M23-C
 *  (docs/M23-receitas-nao-numericas-CONVENCAO.md — predicado FIXO relacao/decisao/compromisso,
 *  quote obrigatório) + a dimensão numérica `precos`. `facts` fica FORA da receita de propósito:
 *  o extractable do tipo EFETIVO ('notas' no a360.json — capture colapsa 'email' via resolveTipo)
 *  ainda a emite e o gate a manda pra fila como fora_da_receita — o sinal honesto do M23-C (nada
 *  some em silêncio). O merge receita→pack grava sob AMBAS as chaves (schema-pack.expandRecipeEntries).
 *  area 'comercial' (M7): a área da receita vira a tag `area:comercial` na página (process-blob-job)
 *  — sem ela o e-mail nascia SEM área e ficava invisível a todo token escopado (scope.ts: item sem
 *  área só passa com acesso total '*'). É a receita do "e-mail COMERCIAL" — a área é coerente e o
 *  dono edita na tela Fontes. Fonte já conectada mantém a receita gravada (só novo connect herda). */
export const EMAIL_RECIPE: SourceRecipe = {
  fields: [
    { dimension: "relacoes", label: "vínculo declarado (cliente, fornecedor, parceiro)", area: "comercial" },
    { dimension: "decisoes", label: "decisão tomada ou descartada", area: "comercial" },
    { dimension: "compromissos", label: "promessa assumida (com prazo)", area: "comercial" },
    { dimension: "precos", label: "preço, valor ou proposta", area: "comercial" },
  ],
  guidance:
    "Fonte: e-mail comercial. O cabeçalho De/Para/Assunto/Data identifica remetente, destinatário " +
    "e a data do e-mail — use-a como data do evento. Priorize vínculos comerciais, decisões, " +
    "compromissos com prazo e valores monetários. Ignore assinaturas, disclaimers e rodapés.",
};

/** Seed da fonte e-mail (DADO): linha pronta pro upsertSource (M22-A/D usam ao "Conectar"). */
export function emailSourceSeed(id: string, name = "E-mail (Gmail)"): SourceRow {
  return {
    id,
    name,
    channel: "gmail", // vira tag canal:gmail na página (process-blob-job.ts)
    type: "email", // chave CRUA da receita; a extração lê o tipo EFETIVO (resolveTipo → 'notas') — o merge grava sob ambas
    recipe: EMAIL_RECIPE,
    default_sensitivity: "interno", // decisão do CTO: e-mail comercial = sigilo default INTERNO
    status: "ativa",
    last_read_at: null,
  };
}

/** Handler estrutural que o registry/dispatch do M22-A consome (o registro em si é 1 linha do
 *  Integrador no reconcile). Compat ESTRUTURAL — M22-A não é importado aqui. `normalize` recebe o
 *  record + ctx (sourceId/model) e devolve a lista de payloads de entrega (vazia se sem conteúdo/
 *  data — o caller loga, nunca descarta mudo). */
export const gmailConnector: {
  providerConfigKey: "google-mail";
  model: "Message";
  sourceSeed: (id: string, name?: string) => SourceRow;
  normalize: (record: GmailMessageRecord, ctx: GmailNormalizeCtx) => GmailDeliverPayload[];
} = {
  providerConfigKey: "google-mail", // provider key oficial do Nango
  model: "Message", // modelo da sync
  sourceSeed: emailSourceSeed,
  normalize(record, ctx) {
    const doc = normalizeGmailMessage(record);
    if (!doc) return [];
    return [{ ...doc, sourceId: ctx.sourceId }];
  },
};
