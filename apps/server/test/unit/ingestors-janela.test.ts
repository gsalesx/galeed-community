/** JANELA DE CONVERSA — partes PURAS (render + config) e o contrato do evolution-whatsapp
 *  de declarar a janela (o buffer/flush com DB é coberto pelo e2e). */
import { describe, it, expect, afterEach } from "vitest";
import { renderJanela, janelaConfig, type JanelaMsg } from "../../src/core/ingestion/ingestors/janela.ts";
import { evolutionWhatsappIngestor } from "../../src/core/ingestion/ingestors/evolution-whatsapp.ts";
import type { IngestorCtx } from "../../src/core/ingestion/ingestors/types.ts";

const CTX: IngestorCtx = { brain: "teste", sourceId: "src-1", slug: "evolution-whatsapp" };

describe("renderJanela — a página da conversa", () => {
  it("ordena por hora, uma linha por fala, título com chat e dia", () => {
    const msgs: JanelaMsg[] = [
      { quem: "Você", texto: "Claro! Sexta às 15h então.", quando: "2026-07-02T12:16:00.000Z", ref: "wa:2" },
      { quem: "Mariana Souza", texto: "Consegue remarcar pra sexta?", quando: "2026-07-02T12:14:00.000Z", ref: "wa:1" },
    ];
    const { content, title } = renderJanela("WhatsApp 554799991111 (Mariana Souza)", msgs);
    expect(title).toBe("Conversa — WhatsApp 554799991111 (Mariana Souza) (2026-07-02)");
    const linhas = content.split("\n");
    // ordem cronológica (a pergunta vem ANTES da resposta — o contexto que a mensagem solta não tem)
    const iPergunta = linhas.findIndex((l) => l.includes("Consegue remarcar"));
    const iResposta = linhas.findIndex((l) => l.includes("Sexta às 15h"));
    expect(iPergunta).toBeGreaterThan(-1);
    expect(iResposta).toBeGreaterThan(iPergunta);
    // hora local BR (UTC-3): 12:14Z → 09:14
    expect(linhas[iPergunta]).toContain("[09:14] Mariana Souza:");
  });
});

describe("janelaConfig — env", () => {
  afterEach(() => {
    delete process.env.GALEED_JANELA_MIN;
    delete process.env.GALEED_JANELA_MAX_MSGS;
  });

  it("defaults 30min/100 msgs; GALEED_JANELA_MIN=0 desliga; lixo cai no default", () => {
    expect(janelaConfig()).toEqual({ silencioMin: 30, maxMsgs: 100 });
    process.env.GALEED_JANELA_MIN = "0";
    expect(janelaConfig().silencioMin).toBe(0);
    process.env.GALEED_JANELA_MIN = "banana";
    expect(janelaConfig().silencioMin).toBe(30);
    process.env.GALEED_JANELA_MAX_MSGS = "5";
    expect(janelaConfig().maxMsgs).toBe(5);
  });
});

describe("evolution-whatsapp declara a janela", () => {
  it("item de mensagem carrega janela {chatId, quem, texto} — o buffer agrupa por chatId", () => {
    const [item] = evolutionWhatsappIngestor.normalize(
      {
        event: "messages.upsert",
        data: {
          key: { remoteJid: "554799991111@s.whatsapp.net", fromMe: false, id: "J1" },
          pushName: "Mariana Souza",
          message: { conversation: "Consegue remarcar pra sexta?" },
          messageTimestamp: 1751458440,
        },
      },
      CTX,
    );
    expect(item.janela).toBeDefined();
    expect(item.janela!.chatId).toBe("554799991111@s.whatsapp.net");
    expect(item.janela!.quem).toBe("Mariana Souza");
    expect(item.janela!.texto).toBe("Consegue remarcar pra sexta?");
    // o texto da janela é SÓ a fala (a página é montada no flush, com a conversa inteira)
    expect(item.janela!.texto).not.toContain("WhatsApp");
  });
});
