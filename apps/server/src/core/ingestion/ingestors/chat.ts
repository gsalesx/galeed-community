/** Ingestor "chat" — canal de conversa UNIVERSAL, com janela de conversa por construção.
 *
 *  REGRA DA PLATAFORMA (decisão do fundador): todo canal com comportamento de CHAT acumula
 *  na janela de conversa — mensagem sozinha não carrega contexto ("Consegue remarcar?" sem
 *  o "claro, sexta 15h" que vem depois). Este ingestor dá isso pra QUALQUER ferramenta de
 *  chat sem escrever ingestor novo: Instagram DM (ManyChat/Zapier), Telegram, livechat do
 *  site (Crisp/Tawk), Slack, Teams… a automação só mapeia os campos e posta.
 *
 *  Aceita UMA mensagem:
 *    { "canal": "instagram", "chat_id": "dm-8817", "chat_label": "Instagram — @beatriz",
 *      "quem": "Beatriz", "texto": "Tem horário sábado?", "quando"?: ISO, "ref"?: "id" }
 *  ou LOTE: { "canal": "...", "mensagens": [ { chat_id, quem, texto, ... }, ... ] }
 *
 *  O chatId é prefixado pelo canal (instagram:dm-8817) — chats de ferramentas diferentes
 *  nunca se misturam na mesma janela. Ver janela.ts pros parâmetros de fechamento. */
import { createHash } from "node:crypto";
import type { Ingestor, IngestorItem } from "./types.ts";

function sha16(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : v === null || v === undefined ? "" : String(v).trim();
}

interface MsgCrua {
  canal: string;
  chat_id?: unknown;
  chat_label?: unknown;
  quem?: unknown;
  texto?: unknown;
  quando?: unknown;
  ref?: unknown;
}

function itemDe(m: MsgCrua): IngestorItem | null {
  const canal = str(m.canal) || "chat";
  const chatIdBruto = str(m.chat_id);
  const texto = str(m.texto);
  if (!chatIdBruto || !texto) return null; // sem chat ou sem fala → ignora (ack/ping)

  const chatId = `${canal}:${chatIdBruto}`;
  const chatLabel = str(m.chat_label) || `${canal} ${chatIdBruto}`;
  const quem = str(m.quem) || "Contato";
  const quandoRaw = str(m.quando);
  const quando = quandoRaw && !Number.isNaN(Date.parse(quandoRaw))
    ? new Date(quandoRaw).toISOString()
    : new Date().toISOString();
  const ref = str(m.ref) || `chat:${sha16(`${chatId}\n${quem}\n${quando}\n${texto}`)}`;

  return {
    // content standalone: usado SÓ com a janela desligada (GALEED_JANELA_MIN=0).
    content: `**${chatLabel}** · ${quem} · ${quando.slice(0, 16).replace("T", " ")}\n\n${texto}`,
    contentType: "text/markdown",
    timestamp: quando,
    externalRef: ref,
    title: chatLabel,
    janela: { chatId, chatLabel, quem, texto },
  };
}

export const chatIngestor: Ingestor = {
  slug: "chat",
  nome: "Chat (qualquer canal de conversa)",
  descricao: "Instagram DM, Telegram, livechat do site, Slack… — com janela de conversa: o diálogo inteiro vira uma memória só.",
  exemplo: `{ "canal": "instagram", "chat_id": "dm-8817", "chat_label": "Instagram — @beatriz", "quem": "Beatriz", "texto": "Vocês têm horário no sábado?" }`,

  sourceSeed() {
    return {
      name: "Chats",
      channel: "chat",
      type: "conversa",
      recipe: { fields: [] },
    };
  },

  normalize(body): IngestorItem[] {
    const b = (body ?? {}) as Record<string, unknown>;
    // envelope do lote: canal/chat_id/chat_label valem pra TODAS as mensagens que não
    // trouxerem os seus (o caso comum é um lote de UM chat só — a automação manda o id 1×).
    const canal = str(b.canal) || str(b.channel) || "chat";
    const chatIdEnvelope = str(b.chat_id);
    const chatLabelEnvelope = str(b.chat_label);
    const lote = Array.isArray(b.mensagens)
      ? (b.mensagens as Record<string, unknown>[])
      : Array.isArray(b.messages)
        ? (b.messages as Record<string, unknown>[])
        : [b];
    const itens: IngestorItem[] = [];
    for (const m of lote) {
      const cru = m as MsgCrua;
      const item = itemDe({
        ...cru,
        canal: str(cru.canal) || canal,
        chat_id: str(cru.chat_id) || chatIdEnvelope,
        chat_label: str(cru.chat_label) || chatLabelEnvelope,
      });
      if (item) itens.push(item);
    }
    return itens;
  },
};
