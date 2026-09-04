/** Ingestor "chat" — canal de conversa universal. REGRA: todo canal com comportamento de
 *  chat declara `janela` (decisão do fundador); aqui é por construção. */
import { describe, it, expect } from "vitest";
import { chatIngestor } from "../../src/core/ingestion/ingestors/chat.ts";
import type { IngestorCtx } from "../../src/core/ingestion/ingestors/types.ts";

const CTX: IngestorCtx = { brain: "teste", sourceId: "src-1", slug: "chat" };

describe("ingestor chat (universal)", () => {
  it("mensagem única declara janela; chatId é prefixado pelo canal (canais não se misturam)", () => {
    const [a] = chatIngestor.normalize(
      { canal: "instagram", chat_id: "dm-8817", chat_label: "Instagram — @beatriz", quem: "Beatriz", texto: "Tem horário sábado?", quando: "2026-07-02T13:00:00Z", ref: "ig-1" },
      CTX,
    );
    expect(a.janela).toBeDefined();
    expect(a.janela!.chatId).toBe("instagram:dm-8817");
    expect(a.janela!.quem).toBe("Beatriz");
    expect(a.externalRef).toBe("ig-1");
    const [b] = chatIngestor.normalize({ canal: "telegram", chat_id: "dm-8817", quem: "X", texto: "oi" }, CTX);
    expect(b.janela!.chatId).toBe("telegram:dm-8817"); // MESMO id de chat, canal diferente → janela diferente
  });

  it("lote de UM chat: chat_id/chat_label do ENVELOPE valem pra todas as mensagens", () => {
    const itens = chatIngestor.normalize(
      {
        canal: "instagram",
        chat_id: "dm-8817",
        chat_label: "Instagram — @beatriz",
        mensagens: [
          { quem: "Beatriz", texto: "O peeling serve pra pele sensível?" },
          { quem: "Você", texto: "Serve sim! Primeira avaliação é grátis" },
        ],
      },
      CTX,
    );
    expect(itens).toHaveLength(2);
    expect(itens[0].janela!.chatId).toBe("instagram:dm-8817");
    expect(itens[1].janela!.chatId).toBe("instagram:dm-8817");
    expect(itens[0].janela!.chatLabel).toBe("Instagram — @beatriz");
  });

  it("lote { canal, mensagens: [...] } herda o canal; msg pode sobrescrever", () => {
    const itens = chatIngestor.normalize(
      {
        canal: "livechat",
        mensagens: [
          { chat_id: "v-1", quem: "Visitante", texto: "Qual o preço?" },
          { chat_id: "v-1", quem: "Atendente", texto: "R$ 180" },
          { canal: "telegram", chat_id: "t-9", quem: "Ana", texto: "oi" },
        ],
      },
      CTX,
    );
    expect(itens).toHaveLength(3);
    expect(itens[0].janela!.chatId).toBe("livechat:v-1");
    expect(itens[1].janela!.chatId).toBe("livechat:v-1"); // mesma janela
    expect(itens[2].janela!.chatId).toBe("telegram:t-9"); // override por mensagem
  });

  it("sem ref explícito o hash é estável (dedupe); sem chat_id ou texto → ignora", () => {
    const p = { canal: "x", chat_id: "c1", quem: "A", texto: "mesma fala", quando: "2026-07-02T10:00:00Z" };
    const [a] = chatIngestor.normalize(p, CTX);
    const [b] = chatIngestor.normalize(p, CTX);
    expect(a.externalRef).toBe(b.externalRef);
    expect(chatIngestor.normalize({ canal: "x", quem: "A", texto: "sem chat" }, CTX)).toEqual([]);
    expect(chatIngestor.normalize({ canal: "x", chat_id: "c1", quem: "A" }, CTX)).toEqual([]);
  });

  it("defaults amigáveis: quem='Contato', label 'canal chatId', quando=agora", () => {
    const [a] = chatIngestor.normalize({ canal: "site", chat_id: "sess-4", texto: "olá" }, CTX);
    expect(a.janela!.quem).toBe("Contato");
    expect(a.janela!.chatLabel).toBe("site sess-4");
    expect(Number.isNaN(Date.parse(a.timestamp))).toBe(false);
  });
});
