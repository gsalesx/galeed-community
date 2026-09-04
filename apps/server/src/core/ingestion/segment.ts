/** CAMADA 2 — segmentação de âncora (M9/S2). Substitui o `truncate(60000)` do extract.ts (S1) por
 *  segmentação temporal + header de âncora. Cada segmento de uma conversa longa sai DATADO com um header
 *  "Conversa entre A e B de <data> a <data>" ANTES do corpo, pra o LLM extrair fatos com a data/contexto
 *  certos. Endereça R10 (truncate mata contexto e data).
 *
 *  Porta `splitIntoSegments` + `renderSegmentForExtraction` + as constantes
 *  (DEFAULT_SEGMENT_GAP_MINUTES / DEFAULT_SEGMENT_MAX_MESSAGES / MIN_SEGMENT_MESSAGES /
 *  SEGMENT_TEXT_CHAR_LIMIT) do gbrain
 *  (references/gbrain/src/commands/extract-conversation-facts.ts:101-396), adaptado ao shape
 *  `ExtractionUnit` declarado pelo S1 e com o header em PT. Determinístico e puro: sem IO, sem LLM, sem env. */

import {
  parseConversationMessages,
  type ConversationMessage,
} from "../../lib/conversation.ts";
import type { PageRow } from "../platform/engine.ts";
// SEAM #1 (reconcile onda 1 M9): `ExtractionUnit` é o tipo-contrato compartilhado, DONO = ./extract.ts.
// import type-only → erasure em runtime, sem ciclo de import (extract.ts importa o VALOR
// buildExtractionUnits daqui; aqui importamos só o TIPO de lá).
import type { ExtractionUnit } from "../extraction/extract.ts";
// M15/S5 (gap-S3-cut): o Stage 0 por-mensagem reusa o porteiro GENÉRICO do S1 (sem ramo de formato).
// IMPORTA `scoreSegment`/`DEFAULT_TRIAGE_PROFILE` — NÃO altera triage.ts (o algoritmo está certo; só a
// ENTRADA muda: `m.text` semântico em vez do `unit.body` renderizado com `Speaker (ISO):`).
import { scoreSegment, DEFAULT_TRIAGE_PROFILE } from "./triage.ts";

// ---------------------------------------------------------------------------
// Constantes (portadas EXATAS do gbrain — extract-conversation-facts.ts:101,110,113,124).
// ---------------------------------------------------------------------------

/** Gap máximo entre msgs adjacentes antes de cortar um novo segmento. */
export const DEFAULT_SEGMENT_GAP_MINUTES = 30;
/** Teto duro de mensagens por segmento, independente do tempo. */
export const DEFAULT_SEGMENT_MAX_MESSAGES = 30;
/** Mínimo de msgs p/ um segmento valer extração. */
export const MIN_SEGMENT_MESSAGES = 2;
/** Cap de chars do unit (folga sob o limite do LLM; o header SEMPRE sobrevive ao corte). */
export const SEGMENT_TEXT_CHAR_LIMIT = 6500;

// ---------------------------------------------------------------------------
// Tipos.
// ---------------------------------------------------------------------------

export interface ConversationSegment {
  messages: ConversationMessage[];
  startIso: string; // timestamp da 1ª msg do segmento ("" se nenhuma datada)
  endIso: string; // timestamp da última msg
  participants: string[]; // falantes distintos, na ordem de 1ª aparição
}

export interface SplitSegmentsOpts {
  gapMinutes?: number; // default DEFAULT_SEGMENT_GAP_MINUTES
  maxMessages?: number; // default DEFAULT_SEGMENT_MAX_MESSAGES
}

// ---------------------------------------------------------------------------
// splitIntoSegments — porta gbrain (extract-conversation-facts.ts:321-372),
// adaptado a timestamp possivelmente vazio (msg sem hora não dispara corte por gap).
// ---------------------------------------------------------------------------

/** Corta as mensagens em segmentos: novo segmento quando o gap de tempo > gapMinutes OU ao atingir
 *  maxMessages. Segmento curto (< MIN_SEGMENT_MESSAGES) NUNCA é descartado: FUNDE no segmento
 *  anterior (ou acumula pra frente se ainda não há nenhum) — a decisão que chega horas depois da
 *  discussão ("decidimos fechar com o fornecedor X") perdia-se aqui em silêncio, irrecuperável até
 *  por re-extração (achado criacao-de-fatos #1). O MIN segue cumprindo o propósito (nenhuma unit
 *  magrinha sem contexto); ruído puro após gap morre no lugar certo — pruneSegmentMessages (Stage 0).
 *  Mensagens sem timestamp datável (timestamp==="") NÃO disparam corte por gap (só por contagem) e
 *  ficam no segmento corrente. */
export function splitIntoSegments(
  messages: ConversationMessage[],
  opts: SplitSegmentsOpts = {},
): ConversationSegment[] {
  const gapMs = (opts.gapMinutes ?? DEFAULT_SEGMENT_GAP_MINUTES) * 60_000;
  const maxMessages = opts.maxMessages ?? DEFAULT_SEGMENT_MAX_MESSAGES;

  const out: ConversationSegment[] = [];
  let cur: ConversationMessage[] = [];
  let lastTs: number | null = null;

  const flush = () => {
    if (cur.length < MIN_SEGMENT_MESSAGES) {
      // Fusão, nunca descarte: cada linha do body carrega o próprio timestamp via renderSegmentBody
      // ("Speaker (ISO): texto"), então o LLM vê a hora REAL da mensagem fundida mesmo com o
      // endIso esticado — a âncora temporal não mente.
      if (cur.length === 0) return;
      if (out.length === 0) return; // fusão pra FRENTE: cur fica; as próximas msgs acumulam nele
      const prev = out[out.length - 1];
      prev.messages = prev.messages.concat(cur);
      // recomputa âncora e participantes do segmento fundido (mesma lógica do caminho normal abaixo).
      const merged = prev.messages
        .map((m) => m.timestamp)
        .filter((t) => t !== "" && Number.isFinite(Date.parse(t)));
      prev.startIso = merged[0] ?? "";
      prev.endIso = merged[merged.length - 1] ?? "";
      for (const m of cur) {
        if (m.speaker && !prev.participants.includes(m.speaker)) prev.participants.push(m.speaker);
      }
      cur = [];
      return;
    }
    const seen = new Set<string>();
    const participants: string[] = [];
    for (const m of cur) {
      if (m.speaker && !seen.has(m.speaker)) {
        seen.add(m.speaker);
        participants.push(m.speaker);
      }
    }
    // startIso/endIso usam o 1º/último timestamp NÃO vazio do segmento (msg sem hora não conta).
    const dated = cur.map((m) => m.timestamp).filter((t) => t !== "" && Number.isFinite(Date.parse(t)));
    out.push({
      messages: cur,
      startIso: dated[0] ?? "",
      endIso: dated[dated.length - 1] ?? "",
      participants,
    });
    cur = [];
  };

  for (const m of messages) {
    const ts = Date.parse(m.timestamp);
    const dated = Number.isFinite(ts);
    // Corte por gap só quando AMBOS os lados têm hora (msg sem hora não muda lastTs).
    if (dated && lastTs !== null && ts - lastTs > gapMs) flush();
    cur.push(m);
    if (dated) lastTs = ts;
    if (cur.length >= maxMessages) {
      flush();
      lastTs = null;
    }
  }
  flush();
  return out;
}

// ---------------------------------------------------------------------------
// Header de âncora (compartilhado por renderSegmentForExtraction e buildExtractionUnits).
// ---------------------------------------------------------------------------

/** Monta SÓ o header de âncora topical/temporal de um segmento (sem o corpo). Em PT — alinha com o
 *  ask/UI em português; valor de âncora idêntico ao gbrain ("Conversa entre A e B de <ini> a <fim>"). */
function renderHeaderOnly(pageTitle: string, segment: ConversationSegment): string {
  const lines = [`Fonte: ${pageTitle}`];
  const { participants, startIso, endIso } = segment;
  if (startIso && endIso) {
    const who = participants.length > 0 ? `entre ${participants.join(" e ")} ` : "";
    lines.push(`Conversa ${who}de ${startIso} a ${endIso}`);
  }
  lines.push("---");
  return lines.join("\n");
}

/** Renderiza um segmento como texto pronto p/ extração, com header de âncora topical/temporal.
 *  O cap de chars (SEGMENT_TEXT_CHAR_LIMIT) PRESERVA o header e corta o FIM do corpo.
 *  Função "pública" testável que prova a paridade com o gbrain (header+corpo juntos). */
export function renderSegmentForExtraction(
  pageTitle: string,
  segment: ConversationSegment,
): string {
  const header = renderHeaderOnly(pageTitle, segment);
  const body = renderSegmentBody(segment);
  const full = `${header}\n${body}`;
  if (full.length <= SEGMENT_TEXT_CHAR_LIMIT) return full;
  // Corta a partir do FIM do corpo, mantendo o header íntegro (a âncora topical/temporal sobrevive).
  const slack = SEGMENT_TEXT_CHAR_LIMIT - header.length - 16;
  return `${header}\n${body.slice(0, Math.max(0, slack))}\n…(truncado)`;
}

/** Corpo do segmento: cada msg como "<speaker> (<timestamp>): <texto>". */
function renderSegmentBody(segment: ConversationSegment): string {
  return segment.messages
    .map((m) => `${m.speaker} (${m.timestamp}): ${m.text}`)
    .join("\n");
}

// ---------------------------------------------------------------------------
// buildExtractionUnits — o SEAM do S1 (assinatura EXATA). Substitui o truncate do extract.ts.
// ---------------------------------------------------------------------------

/** Constrói as unidades de extração de uma página (M9/S2 — substitui o truncate do S1).
 *  Conversa datável → 1 unit por segmento temporal (header de âncora + corpo do segmento + data do
 *  início do segmento). Doc sem mensagens datáveis → segmentação por TAMANHO (chunks de
 *  SEGMENT_TEXT_CHAR_LIMIT, header simples, date = page.date) — NUNCA trunca o total.
 *
 *  ATENÇÃO ao shape do S1: `extract.ts` monta o prompt como `unit.header + "\n\n" + wrapUntrusted(unit.body)`.
 *  Por isso `header` e `body` vão SEPARADOS — o header NÃO entra no wrapUntrusted (é instrução de âncora,
 *  não dado não-confiável). */
export function buildExtractionUnits(page: PageRow): ExtractionUnit[] {
  const msgs = parseConversationMessages(page.body, { fallbackDate: page.date || undefined });
  if (msgs.length >= MIN_SEGMENT_MESSAGES) {
    const segs = splitIntoSegments(msgs);
    if (segs.length) {
      const title = page.title || page.slug;
      const out: ExtractionUnit[] = [];
      for (const seg of segs) {
        // M15/S5 — Stage 0 por-mensagem (puro/sync): descarta ruído INEQUÍVOCO ANTES de montar a unit.
        const kept = pruneSegmentMessages(seg.messages);
        if (kept.length === 0) continue; // segmento todo-social some → 0 units (menos chamadas LLM).
        // header/date derivam do segmento ORIGINAL (âncora temporal/participantes preservada mesmo que
        // a 1ª/última msg seja ruído). Só body/triageText usam os sobreviventes.
        const prunedSeg = { ...seg, messages: kept };
        out.push({
          header: renderHeaderOnly(title, seg),
          body: renderSegmentBody(prunedSeg), // só sobreviventes → menos tokens p/ o LLM
          triageText: kept.map((m) => m.text).join("\n"), // SEMÂNTICO, sem "Speaker (ISO):"
          date: (seg.startIso || page.date || "").slice(0, 10), // YYYY-MM-DD do início do segmento
        });
      }
      return out;
    }
  }
  return chunkBySize(page);
}

// ---------------------------------------------------------------------------
// pruneSegmentMessages (M15/S5, gap-S3-cut) — o Stage 0 por-mensagem. PURO/SYNC, GENÉRICO.
// ---------------------------------------------------------------------------

/** Assentimento/negação curtos e isolados — o ato de fala que SELA ou RECUSA um acordo ("Combinado",
 *  "sim", "não", "perfeito", "fechado"). Sobreposto de propósito ao GREETING_RE do S1: lá (nível de
 *  UNIT) essas palavras isoladas SÃO ruído e o corte do corpus rotulado depende disso; AQUI (poda
 *  por-mensagem, com contexto conversacional) a mesma palavra logo após uma mensagem mantida é a
 *  RESPOSTA que fecha aquela mensagem — podá-la invertia o sentido do trecho (pergunta em aberto no
 *  lugar de acordo selado; recusa sumida). Achado criacao-de-fatos #2. */
const ASSENT_RE =
  /^(?:isso|sim|n[ãa]o|nao|certo|combinado|perfeito|ok+|okay|blz|beleza|fechado)[\s!.…]*$/i;

/** Stage 0 por-mensagem: descarta ruído ANTES de montar a unit, preservando recall.
 *  GENÉRICO — usa o MESMO motor `scoreSegment` + `NOISE_RULES` do S1, aplicado ao `m.text` (SEM o
 *  scaffold `Speaker (ISO):`, pra `hasNumber` não disparar no timestamp). NÃO conhece formato.
 *  Mantém a mensagem sse `scoreSegment(...).worthy` — no DEFAULT_TRIAGE_PROFILE caem as noise rules
 *  (kkkk, emoji-only, saudação/assentimento, vazio) E mensagem curta sem sinal com score<threshold
 *  (honestidade: não é "só ruído inequívoco" — o threshold também derruba). A salvaguarda
 *  `number → worthy` roda no nível da MENSAGEM: uma `m.text` com "R$ 30 mil" tem `number` → NUNCA é
 *  dropada (golden M9 preservado).
 *  RESGATE CONTEXTUAL (achado criacao-de-fatos #2): assentimento/negação (ASSENT_RE) imediatamente
 *  após mensagem MANTIDA sobrevive junto — é o fechamento da decisão, não ruído. Isolado entre ruído
 *  continua caindo (medido: corte agregado do gate M15/S4 inalterado; recall intacto).
 *  entityHints=[] de propósito: o filtro é brain-NEUTRO (sync); a proteção entity-de-brain + o perfil
 *  resolvido por tenant rodam na 2ª pista (S3, async, com `home`). Duas camadas, mesma função. */
function pruneSegmentMessages(messages: ConversationMessage[]): ConversationMessage[] {
  const kept: ConversationMessage[] = [];
  let prevKept = false;
  for (const m of messages) {
    const text = m.text ?? "";
    const v = scoreSegment(
      { text, entityHints: [], channel: "", type: "", confident: false },
      DEFAULT_TRIAGE_PROFILE,
    );
    let keep = v.worthy; // worthy=true ⇒ mantém (DEFAULT conservador).
    // "Combinado"/"não" respondendo a uma mensagem sobrevivente viaja junto pro LLM (sela/recusa).
    if (!keep && prevKept && ASSENT_RE.test(text.trim())) keep = true;
    if (keep) kept.push(m);
    prevKept = keep;
  }
  return kept;
}

// ---------------------------------------------------------------------------
// Fallback por tamanho — doc/nota sem conversa datável. Cobre o corpo INTEIRO (R10: nada truncado-e-perdido).
// ---------------------------------------------------------------------------

/** Doc/nota sem conversa datável: corta o corpo em chunks de SEGMENT_TEXT_CHAR_LIMIT, header simples,
 *  todos com a data da página. Doc curto (≤ limite) → 1 unit (equivalente ao default S1, SEM o truncate). */
function chunkBySize(page: PageRow): ExtractionUnit[] {
  const title = page.title || page.slug;
  const header = `Fonte: ${title} (${page.date || "sem data"})`;
  const date = page.date || "";
  const body = page.body ?? "";

  const chunkChars = Math.max(1, SEGMENT_TEXT_CHAR_LIMIT - header.length - 16);

  if (body.length === 0) {
    // M15/S5: chunk já é texto semântico (sem scaffold) → triageText = body. Vazio → "".
    return [{ header, body: "", triageText: "", date }];
  }

  const units: ExtractionUnit[] = [];
  for (let i = 0; i < body.length; i += chunkChars) {
    const chunk = body.slice(i, i + chunkChars);
    // M15/S5: doc/chunk é texto semântico sem scaffold → triageText = body do chunk.
    units.push({ header, body: chunk, triageText: chunk, date });
  }
  return units;
}
