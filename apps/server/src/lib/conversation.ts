/** Parser determinístico de conversa/transcrição (M9/S2). Sem LLM. Extrai mensagens datadas do corpo
 *  pra a segmentação temporal. Reaproveita o padrão "Nome: texto" de speakers.ts (`SPEAKER_RE`), e tenta
 *  achar um timestamp por linha (prefixo/sufixo de data/hora). Corpo sem mensagens datáveis → [] (o caller
 *  cai p/ segmentação por tamanho). Tenant-neutro: nenhum vocabulário de domínio.
 *
 *  Porta a heurística de mensagem do gbrain
 *  (references/gbrain/src/commands/extract-conversation-facts.ts → ConversationMessage + a forma de render
 *  `<speaker> (<timestamp>): <texto>`), adaptada ao parser de falante existente do Galeed (core/speakers.ts
 *  → SPEAKER_RE). Determinístico e puro, sem IO. */

export interface ConversationMessage {
  speaker: string; // nome legível do falante ("Kelvin Cleto") ou "" se anônimo
  timestamp: string; // ISO 8601 ("2024-03-01T14:30:00Z") ou "" se a linha não tiver hora
  text: string; // o texto da fala
}

export interface ParseConversationOpts {
  /** data de fallback (YYYY-MM-DD) p/ mensagens sem timestamp próprio (ex.: a data da página). */
  fallbackDate?: string;
}

// Nome do falante: mesmo espírito do SPEAKER_RE de core/speakers.ts — 1–4 palavras Capitalizadas,
// permitindo `.'-` interno. Fica sem âncora de início/fim porque é usado como sub-padrão nas variantes.
const SPEAKER = "[A-ZÀ-Ú][\\p{L}.'-]+(?:\\s+[A-ZÀ-Ú][\\p{L}.'-]+){0,3}";

// Timestamp tolerante: YYYY-MM-DD, YYYY-MM-DD HH:MM(:SS)?, YYYY-MM-DDTHH:MM(:SS)?(Z)?
const TS = "\\d{4}-\\d{2}-\\d{2}(?:[ T]\\d{2}:\\d{2}(?::\\d{2})?Z?)?";

// 1. "[2024-03-01 14:30] Nome: texto"   (timestamp entre colchetes + falante)
const RE_BRACKET = new RegExp(`^\\[(${TS})\\]\\s*(${SPEAKER}):\\s?(.*)$`, "u");
// 2. "Nome (2024-03-01 14:30): texto"   (falante + timestamp entre parênteses — forma do render gbrain)
const RE_PAREN = new RegExp(`^(${SPEAKER})\\s*\\((${TS})\\):\\s?(.*)$`, "u");
// 3. "Nome: texto"                       (sem hora → timestamp = fallbackDate@T00:00 se houver)
const RE_PLAIN = new RegExp(`^(${SPEAKER}):\\s?(.*)$`, "u");

const STOP = new Set(["transcrição", "transcricao", "participantes", "resumo", "ata", "notas", "obs"]);

// ─────────────────────────────────────────────────────────────────────────────
// P0-A — formatos REAIS de export do WhatsApp (Android cru, iOS cru, bold-ISO do blob-store).
// Tudo INTERNO ao módulo (módulo de normalização isolado, invariante III: zero conhecimento de
// formato no core; aqui é o lugar certo). As regexes novas entram DEPOIS das 3 existentes
// (aditividade — os formatos já aceitos parseiam byte-idêntico).
// ─────────────────────────────────────────────────────────────────────────────

// Marcas direcionais/invisíveis que o WhatsApp real injeta (iOS: U+200E antes do "["; nomes de
// não-contato: "~" + U+200E). Removidas do timestamp e do falante; NUNCA do texto da mensagem
// (exceto as de prefixo de LINHA, que são scaffold do export, não conteúdo).
const DIR_MARKS = /[‎‏‪-‮⁦-⁩]/g;

// Timestamp WhatsApp cru: d/m/aaaa ou d/m/aa, vírgula opcional, hh:mm(:ss)?, AM/PM opcional.
const WTS = "\\d{1,2}\\/\\d{1,2}\\/\\d{2,4},?\\s+\\d{1,2}:\\d{2}(?::\\d{2})?(?:\\s?[AaPp]\\.?[Mm]\\.?)?";

// 4. "[<ts>] <resto>" — iOS cru E o formato bold-ISO do blob-store. <ts> = qualquer conteúdo até o
//    1º "]"; só vira cabeçalho se NORMALIZAR (ISO ou DD/MM). <resto> divide em falante/texto (§2.3).
const RE_WA_BRACKET = /^\[(.+?)\]\s?(.*)$/u;
// 5. "<ts> - <resto>" — Android cru. <ts> no formato DD/MM, separador " - " (tolera – e —).
const RE_WA_DASH = new RegExp(`^(${WTS})\\s[-–—]\\s(.*)$`, "u");

// Componente d/m/a cru, p/ a passada de detecção de ordem dia/mês.
const RE_DMY_TOKEN = /(\d{1,2})\/(\d{1,2})\/(\d{2,4})/g;

/** Ordem dia/mês do corpo INTEIRO (uma passada, determinístico, por arquivo — nunca por linha, evita
 *  corpus misto): se algum token d/m/a tem 1º componente >12 → "dm"; senão, se algum tem 2º >12 →
 *  "md"; senão "dm" (produto é PT-BR — default DD/MM, decisão do CTO). */
function detectDayMonthOrder(body: string): "dm" | "md" {
  RE_DMY_TOKEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  let sawMd = false;
  while ((m = RE_DMY_TOKEN.exec(body)) !== null) {
    const c1 = Number(m[1]);
    const c2 = Number(m[2]);
    if (c1 > 12) return "dm"; // 1º componente é dia inequívoco
    if (c2 > 12) sawMd = true; // 2º componente >12 → só faz sentido como dia (MM/DD)
  }
  return sawMd ? "md" : "dm";
}

/** Normaliza um timestamp WhatsApp pra ISO ("" se não parsear):
 *  - forma ISO já aceita hoje ("2026-04-17 14:52:08") → delega pra normalizeIso (REUSA, não duplica);
 *  - "12/03/2024, 14:30[:15]" → "2024-03-12T14:30:[15|00]Z" (ordem por `order`);
 *  - ano de 2 dígitos: 2000 + aa ("24" → 2024 — WhatsApp não existia antes de 2009);
 *  - AM/PM ("9:30:15 PM", "2:30 p.m."): 12AM→00h, 12PM→12h, PM soma 12;
 *  - valida faixas (dia 1-31, mês 1-12, hora ≤23, min ≤59) → fora delas devolve "". */
function normalizeWaTimestamp(raw: string, order: "dm" | "md"): string {
  const t = raw.trim();
  // ISO já suportado (bold-ISO do blob-store cai aqui): reusa o normalizador existente.
  const iso = normalizeIso(t);
  if (iso) return iso;
  const m = t.match(
    /^(\d{1,2})\/(\d{1,2})\/(\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s?([AaPp])\.?[Mm]\.?)?$/,
  );
  if (!m) return "";
  const [, c1, c2, yRaw, hhRaw, mmRaw, ssRaw, ap] = m;
  const day = order === "md" ? Number(c2) : Number(c1);
  const mon = order === "md" ? Number(c1) : Number(c2);
  let year = Number(yRaw);
  if (yRaw.length <= 2) year = 2000 + year; // "24" → 2024
  let hour = Number(hhRaw);
  if (ap) {
    const upper = ap.toUpperCase();
    if (upper === "A") {
      if (hour === 12) hour = 0; // 12 AM → 00h
    } else if (hour !== 12) {
      hour += 12; // PM soma 12 (12 PM fica 12h)
    }
  }
  const min = Number(mmRaw);
  const sec = ssRaw ? Number(ssRaw) : 0;
  if (day < 1 || day > 31 || mon < 1 || mon > 12 || hour > 23 || min > 59) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${year}-${pad(mon)}-${pad(day)}T${pad(hour)}:${pad(min)}:${pad(sec)}Z`;
}

/** Limpa o nome do falante dos formatos WhatsApp reais: remove DIR_MARKS, asteriscos de bold do
 *  formato do blob-store ("**Kelvin Cleto**" → "Kelvin Cleto"), prefixo "~ " de não-contato
 *  ("~ Bruno" → "Bruno"), trim. Resultado "" → tratado como mensagem de sistema pelo caller. */
function cleanSpeakerName(raw: string): string {
  let s = raw.replace(DIR_MARKS, "");
  s = s.replace(/\*\*/g, "");
  s = s.replace(/^~\s*/, "");
  return s.trim();
}

/** Divide o resto da linha (após o timestamp estrutural) em falante/texto no PRIMEIRO ": " (cap de
 *  96 chars pro falante — acima disso é texto com dois-pontos, não nome). Sem ": " → mensagem de
 *  SISTEMA do export ("As mensagens são protegidas…", "Você criou o grupo…"): speaker="" e o texto
 *  preservado — o timestamp continua valendo pra segmentação. URLs ("://") não disparam o split. */
function splitSpeakerText(rest: string): { speaker: string; text: string } {
  const idx = rest.indexOf(": ");
  if (idx < 0 || idx > 96) return { speaker: "", text: rest };
  const speaker = cleanSpeakerName(rest.slice(0, idx));
  const text = rest.slice(idx + 2);
  return { speaker, text };
}

/** Normaliza uma data/hora tolerante p/ ISO 8601. `""` se não parsear.
 *  - "2024-03-01"            → "2024-03-01T00:00:00Z"
 *  - "2024-03-01 14:30"      → "2024-03-01T14:30:00Z"
 *  - "2024-03-01T14:30:00Z"  → mantém (preenche segundos/Z se faltar) */
function normalizeIso(raw: string): string {
  const m = raw.match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?Z?)?$/);
  if (!m) return "";
  const [, day, hh, mm, ss] = m;
  const h = hh ?? "00";
  const min = mm ?? "00";
  const s = ss ?? "00";
  return `${day}T${h}:${min}:${s}Z`;
}

/** valida o nome de falante com os mesmos cortes de ruído de core/speakers.ts. */
function validSpeaker(name: string): boolean {
  const n = name.trim();
  if (n.length < 3 || n.length > 40) return false;
  if (!/[A-ZÀ-Ú]/.test(n[0])) return false;
  if (STOP.has(n.toLowerCase())) return false;
  return true;
}

/** Quebra o corpo em mensagens. Heurística de linha (em ordem de tentativa):
 *  1. "[2024-03-01 14:30] Nome: texto"
 *  2. "Nome (2024-03-01 14:30): texto"
 *  3. "Nome: texto"  (sem hora → timestamp = fallbackDate@T00:00 se houver, senão "")
 *  Linhas de continuação (sem cabeçalho) anexam ao text da última mensagem.
 *  PREÂMBULO (achado criacao-de-fatos #3): linhas ANTES da 1ª fala reconhecida (resumo executivo,
 *  participantes, action-items de notetaker — inclusive "Resumo: …", que o STOP set rejeita como
 *  falante) eram descartadas e NUNCA chegavam à extração. Agora acumulam e viram a mensagem inicial
 *  sintética {speaker:"", timestamp:""}: speaker vazio já é caminho suportado (msg de sistema do
 *  WhatsApp) e timestamp vazio não dispara corte por gap nem polui startIso/endIso na segmentação —
 *  a âncora temporal do header continua vindo da 1ª fala real.
 *  Retorna [] se nenhuma linha casar (doc/nota comum — o preâmbulo morre junto e o caller cai no
 *  chunkBySize, que cobre o corpo inteiro). */
export function parseConversationMessages(
  body: string,
  opts: ParseConversationOpts = {},
): ConversationMessage[] {
  const fallbackIso = opts.fallbackDate ? normalizeIso(opts.fallbackDate) : "";
  const out: ConversationMessage[] = [];
  const preamble: string[] = [];
  // 1ª mensagem REAL descarrega o preâmbulo acumulado ANTES dela (uma vez só — depois out.length>0).
  const pushMsg = (m: ConversationMessage) => {
    if (out.length === 0 && preamble.length > 0)
      out.push({ speaker: "", timestamp: "", text: preamble.join("\n") });
    out.push(m);
  };
  // P0-A: ordem dia/mês decidida UMA vez por corpo (nunca por linha — evita corpus misto).
  const order = detectDayMonthOrder(body);

  for (const rawLine of body.split("\n")) {
    const line = rawLine.replace(/\r$/, "");

    let speaker: string | null = null;
    let tsRaw = "";
    let text = "";

    const b = line.match(RE_BRACKET);
    const p = b ? null : line.match(RE_PAREN);
    const pl = b || p ? null : line.match(RE_PLAIN);

    if (b) {
      tsRaw = b[1];
      speaker = b[2];
      text = b[3];
    } else if (p) {
      speaker = p[1];
      tsRaw = p[2];
      text = p[3];
    } else if (pl) {
      speaker = pl[1];
      text = pl[2];
    }

    if (speaker !== null && validSpeaker(speaker)) {
      const ts = tsRaw ? normalizeIso(tsRaw) : fallbackIso;
      pushMsg({ speaker: speaker.trim(), timestamp: ts, text });
      continue;
    }

    // P0-A — formatos WhatsApp reais (DEPOIS das 3 regexes acima → aditividade). Strip de marca
    // direcional NO INÍCIO da linha (iOS real emite U+200E/U+200F antes do "[").
    const stripped = line.replace(/^[‎‏]+/, "");
    let waTs = "";
    let waRest: string | null = null;
    const wb = stripped.match(RE_WA_BRACKET);
    if (wb) {
      const t = normalizeWaTimestamp(wb[1].replace(DIR_MARKS, ""), order);
      if (t) {
        waTs = t;
        waRest = wb[2];
      }
    }
    if (waRest === null) {
      const wd = stripped.match(RE_WA_DASH);
      if (wd) {
        const t = normalizeWaTimestamp(wd[1], order);
        if (t) {
          waTs = t;
          waRest = wd[2];
        }
      }
    }
    if (waRest !== null) {
      const { speaker: spk, text: txt } = splitSpeakerText(waRest);
      pushMsg({ speaker: spk, timestamp: waTs, text: txt });
      continue;
    }

    // Linha de continuação: anexa ao texto da última mensagem (se houver).
    if (out.length > 0 && line.length > 0) {
      out[out.length - 1].text += "\n" + line;
    } else if (out.length === 0 && line.trim().length > 0) {
      // ainda não há mensagem: candidata a preâmbulo (resumo/participantes/action-items de notetaker).
      preamble.push(line);
    }
  }

  return out;
}
