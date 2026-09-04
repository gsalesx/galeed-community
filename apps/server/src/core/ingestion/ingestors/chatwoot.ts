/** Ingestor "chatwoot" — o HUB omnichannel: uma integração = todos os canais que o Chatwoot
 *  agrega (WhatsApp, Instagram DM, Messenger, Telegram, e-mail, livechat do site…).
 *
 *  Por que ele: Chatwoot é open-source/self-hosted, padrão nas agências BR (casa com a
 *  Evolution API), e o webhook `message_created` tem shape CONSISTENTE entre canais:
 *  content + sender (contact|user|agent_bot) + conversation.id + inbox/channel.
 *  Configuração: Chatwoot → Settings → Integrations → Webhooks → URL
 *  `<galeed>/v1/ingestors/chatwoot?token=gld_live_...` marcando o evento message_created
 *  (o painel do Chatwoot não permite header custom — por isso o ?token= existe).
 *
 *  Comportamento (canal de CHAT ⇒ janela de conversa, regra da plataforma):
 *   - só `message_created` com content textual; outros eventos → [] (ignorado);
 *   - mensagens PRIVADAS (notas internas do atendente) entram MARCADAS como nota — é onde
 *     mora decisão/combinado que não foi dito ao cliente;
 *   - chatId = chatwoot:<account>:<conversation> — janela por conversa;
 *   - quem = nome do contato, ou do atendente (message_type incoming|outgoing). */
import type { Ingestor, IngestorItem } from "./types.ts";

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : v === null || v === undefined ? "" : String(v).trim();
}

interface CwPayload {
  event?: string;
  id?: number | string;
  content?: string;
  message_type?: number | string; // 0|"incoming" (cliente) · 1|"outgoing" (atendente) · 2 activity
  private?: boolean;
  created_at?: number | string;
  sender?: { name?: string; type?: string };
  account?: { id?: number | string; name?: string };
  inbox?: { id?: number | string; name?: string; channel_type?: string };
  conversation?: {
    id?: number | string;
    channel?: string;
    meta?: { sender?: { name?: string } };
  };
}

function toIso(v: unknown): string {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) {
    return new Date(v > 1e12 ? v : v * 1000).toISOString();
  }
  const s = str(v);
  if (s && !Number.isNaN(Date.parse(s))) return new Date(s).toISOString();
  return new Date().toISOString();
}

/** "Channel::Whatsapp" / "Channel::Api" → "whatsapp" / "api" (rótulo legível do canal). */
function canalDe(p: CwPayload): string {
  const raw = str(p.conversation?.channel) || str(p.inbox?.channel_type);
  return raw.replace(/^Channel::/i, "").toLowerCase() || "chat";
}

export const chatwootIngestor: Ingestor = {
  slug: "chatwoot",
  nome: "Chatwoot (inbox omnichannel)",
  descricao: "Todos os canais da sua inbox Chatwoot (WhatsApp, Instagram, e-mail, livechat…) — evento message_created.",
  exemplo: `{ "event": "message_created", "id": 901, "content": "Tem horário no sábado?", "message_type": "incoming", "created_at": 1783600000, "sender": { "name": "Beatriz Alves", "type": "contact" }, "conversation": { "id": 42, "channel": "Channel::Whatsapp" }, "account": { "id": 1 } }`,

  sourceSeed() {
    return {
      name: "Chatwoot",
      channel: "chatwoot",
      type: "conversa",
      recipe: { fields: [] },
    };
  },

  normalize(body): IngestorItem[] {
    const p = (body ?? {}) as CwPayload;
    if (str(p.event) !== "message_created") return []; // outros eventos do Chatwoot → ignora
    const texto = str(p.content);
    const convId = str(p.conversation?.id);
    const msgId = str(p.id);
    if (!texto || !convId || !msgId) return []; // anexo sem texto / payload incompleto → ignora

    const mt = str(p.message_type).toLowerCase();
    const doAtendente = mt === "1" || mt === "outgoing";
    const atividade = mt === "2" || mt === "activity"; // "conversa resolvida" etc. — ruído
    if (atividade) return [];

    const contato = str(p.conversation?.meta?.sender?.name);
    const quemBase = str(p.sender?.name) || (doAtendente ? "Atendente" : contato || "Contato");
    const quem = p.private ? `${quemBase} (nota interna)` : quemBase;
    const canal = canalDe(p);
    const accountId = str(p.account?.id) || "0";
    const quando = toIso(p.created_at);

    const chatId = `chatwoot:${accountId}:${convId}`;
    const chatLabel = `${canal} — ${contato || `conversa ${convId}`} (via Chatwoot)`;

    return [{
      // content standalone: usado SÓ com a janela desligada (GALEED_JANELA_MIN=0).
      content: `**${chatLabel}** · ${quem} · ${quando.slice(0, 16).replace("T", " ")}\n\n${texto}`,
      contentType: "text/markdown",
      timestamp: quando,
      externalRef: `cw:${accountId}:${msgId}`,
      title: chatLabel,
      janela: { chatId, chatLabel, quem, texto },
    }];
  },
};
