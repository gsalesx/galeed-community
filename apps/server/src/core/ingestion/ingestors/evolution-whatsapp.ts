/** Ingestor "evolution-whatsapp" — mensagens do WhatsApp via Evolution API (self-hosted, o gateway
 *  de WhatsApp mais comum no ecossistema BR). Configure na instância o webhook do evento
 *  MESSAGES_UPSERT apontando pra POST /v1/ingestors/evolution-whatsapp (com o token gld_).
 *
 *  O que o middleware faz aqui:
 *   - aceita o evento `messages.upsert` (case-insensitive; `data` objeto OU lote em array);
 *   - extrai só o TEXTO (conversation, extendedTextMessage.text, caption de mídia) — mídia sem
 *     legenda é ignorada (áudio/imagem pura não passa; transcreva fora e mande como texto);
 *   - monta a proveniência legível (chat/grupo, quem falou, quando) NO conteúdo;
 *   - dedupe pelo id da mensagem (key.id): re-entrega do webhook não duplica. */
import type { Ingestor, IngestorItem } from "./types.ts";

interface EvoKey { remoteJid?: string; fromMe?: boolean; id?: string }
interface EvoMessage {
  conversation?: string;
  extendedTextMessage?: { text?: string };
  imageMessage?: { caption?: string };
  videoMessage?: { caption?: string };
  documentMessage?: { caption?: string; fileName?: string };
}
interface EvoData {
  key?: EvoKey;
  pushName?: string;
  message?: EvoMessage;
  messageTimestamp?: number | string;
}

function textOf(m: EvoMessage | undefined): string {
  if (!m) return "";
  return (
    m.conversation ??
    m.extendedTextMessage?.text ??
    m.imageMessage?.caption ??
    m.videoMessage?.caption ??
    m.documentMessage?.caption ??
    ""
  ).trim();
}

/** "5547999998888@s.whatsapp.net" → "+55 47 99999-8888 (aprox.)"? Não: sem heurística de máscara —
 *  só remove o sufixo técnico. Grupo (@g.us) vira "grupo <id-curto>" quando não há nome. */
function chatLabel(remoteJid: string): { chat: string; grupo: boolean } {
  const grupo = remoteJid.endsWith("@g.us");
  const bare = remoteJid.replace(/@.+$/, "");
  return { chat: grupo ? `grupo ${bare.slice(-8)}` : bare, grupo };
}

function toIso(ts: number | string | undefined): string {
  const n = Number(ts);
  if (Number.isFinite(n) && n > 0) {
    // Evolution manda epoch em SEGUNDOS; tolera ms (13 dígitos).
    return new Date(n > 1e12 ? n : n * 1000).toISOString();
  }
  return new Date().toISOString();
}

function itemDe(data: EvoData): IngestorItem | null {
  const texto = textOf(data.message);
  const id = data.key?.id?.trim();
  if (!texto || !id) return null; // mídia sem legenda / ack / sem id estável → ignora

  const remoteJid = data.key?.remoteJid ?? "";
  const { chat, grupo } = chatLabel(remoteJid);
  const quem = data.key?.fromMe ? "Você" : (data.pushName?.trim() || chat);
  const quando = toIso(data.messageTimestamp);

  return {
    // content standalone: usado SÓ quando a janela está desligada (GALEED_JANELA_MIN=0).
    content:
      `**WhatsApp** · ${grupo ? "grupo" : "conversa"} ${chat} · ${quem} · ${quando.slice(0, 16).replace("T", " ")}\n\n` +
      texto,
    contentType: "text/markdown",
    timestamp: quando,
    externalRef: `wa:${id}`,
    title: `WhatsApp: ${chat}`,
    // canal de CONVERSA: com o buffer ligado (default), a mensagem acumula na janela do chat
    // e a conversa INTEIRA vira uma página quando fechar (contexto completo — ver janela.ts).
    janela: {
      chatId: remoteJid,
      chatLabel: grupo ? `grupo ${chat.replace(/^grupo /, "")}` : `WhatsApp ${chat}${data.key?.fromMe ? "" : ` (${quem})`}`,
      quem,
      texto,
    },
  };
}

export const evolutionWhatsappIngestor: Ingestor = {
  slug: "evolution-whatsapp",
  nome: "WhatsApp (Evolution API)",
  descricao: "Mensagens de texto do WhatsApp entregues pela sua instância Evolution (evento MESSAGES_UPSERT).",
  exemplo: `{ "event": "messages.upsert", "data": { "key": { "remoteJid": "554799998888@s.whatsapp.net", "fromMe": false, "id": "BAE594145F4C59B4" }, "pushName": "Mariana", "message": { "conversation": "Fechado, pode agendar quinta às 14h" }, "messageTimestamp": 1751414400 } }`,

  sourceSeed() {
    return {
      name: "WhatsApp",
      channel: "whatsapp",
      type: "conversa",
      recipe: { fields: [] }, // modo livre; receita pode ser criada depois na tela Fontes
    };
  },

  normalize(body): IngestorItem[] {
    const b = (body ?? {}) as { event?: string; data?: EvoData | EvoData[] };
    const evento = String(b.event ?? "").toLowerCase().replace(/_/g, ".");
    if (evento !== "messages.upsert") return []; // outros eventos (presence, status…) → ignora

    const lote = Array.isArray(b.data) ? b.data : b.data ? [b.data] : [];
    const itens: IngestorItem[] = [];
    for (const d of lote) {
      const item = itemDe(d);
      if (item) itens.push(item);
    }
    return itens;
  },
};
