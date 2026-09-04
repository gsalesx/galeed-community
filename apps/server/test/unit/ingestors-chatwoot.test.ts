/** Ingestor "chatwoot" — o hub omnichannel. Shape do webhook message_created dos docs
 *  oficiais; canal de CHAT ⇒ declara janela (regra da plataforma). */
import { describe, it, expect } from "vitest";
import { chatwootIngestor } from "../../src/core/ingestion/ingestors/chatwoot.ts";
import type { IngestorCtx } from "../../src/core/ingestion/ingestors/types.ts";

const CTX: IngestorCtx = { brain: "teste", sourceId: "src-1", slug: "chatwoot" };

const BASE = {
  event: "message_created",
  id: 901,
  content: "Tem horário no sábado?",
  message_type: "incoming",
  created_at: 1783600000,
  sender: { name: "Beatriz Alves", type: "contact" },
  account: { id: 1 },
  conversation: { id: 42, channel: "Channel::Whatsapp", meta: { sender: { name: "Beatriz Alves" } } },
};

describe("ingestor chatwoot", () => {
  it("message_created vira item COM janela; chatId por conta:conversa; canal legível no label", () => {
    const [a] = chatwootIngestor.normalize(BASE, CTX);
    expect(a.janela).toBeDefined();
    expect(a.janela!.chatId).toBe("chatwoot:1:42");
    expect(a.janela!.chatLabel).toBe("whatsapp — Beatriz Alves (via Chatwoot)");
    expect(a.janela!.quem).toBe("Beatriz Alves");
    expect(a.externalRef).toBe("cw:1:901");
    expect(a.timestamp).toBe(new Date(1783600000 * 1000).toISOString());
  });

  it("resposta do atendente (outgoing) e nota interna (private) são distinguidas", () => {
    const [resp] = chatwootIngestor.normalize(
      { ...BASE, id: 902, content: "Temos sim, 10h!", message_type: "outgoing", sender: { name: "Júlia", type: "user" } },
      CTX,
    );
    expect(resp.janela!.quem).toBe("Júlia");
    const [nota] = chatwootIngestor.normalize(
      { ...BASE, id: 903, content: "cliente VIP, dar prioridade", message_type: "outgoing", private: true, sender: { name: "Júlia", type: "user" } },
      CTX,
    );
    expect(nota.janela!.quem).toBe("Júlia (nota interna)");
  });

  it("mesma conversa em canais diferentes do Chatwoot cai na MESMA janela (é o mesmo diálogo)", () => {
    const [ig] = chatwootIngestor.normalize(
      { ...BASE, conversation: { ...BASE.conversation, channel: "Channel::Instagram" } },
      CTX,
    );
    expect(ig.janela!.chatId).toBe("chatwoot:1:42"); // conversa 42, seja qual for o canal
    expect(ig.janela!.chatLabel).toContain("instagram");
  });

  it("outros eventos, atividade (message_type 2) e payload sem texto → [] (ignora)", () => {
    expect(chatwootIngestor.normalize({ ...BASE, event: "conversation_created" }, CTX)).toEqual([]);
    expect(chatwootIngestor.normalize({ ...BASE, message_type: 2 }, CTX)).toEqual([]);
    expect(chatwootIngestor.normalize({ ...BASE, content: "" }, CTX)).toEqual([]);
    expect(chatwootIngestor.normalize({}, CTX)).toEqual([]);
  });
});
