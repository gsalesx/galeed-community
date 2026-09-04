/** INGESTORES — contrato do registry + normalizadores PUROS dos built-ins (sem DB/IO).
 *  O normalize() é o middleware: payload cru do canal → itens prontos pro seam. */
import { describe, it, expect, beforeEach } from "vitest";
import { registerIngestor, getIngestor, listIngestors, clearIngestors } from "../../src/core/ingestion/ingestors/registry.ts";
import { registerBuiltinIngestors } from "../../src/core/ingestion/ingestors/boot.ts";
import { textoIngestor } from "../../src/core/ingestion/ingestors/texto.ts";
import { evolutionWhatsappIngestor } from "../../src/core/ingestion/ingestors/evolution-whatsapp.ts";
import { notetakerIngestor } from "../../src/core/ingestion/ingestors/notetaker.ts";
import type { IngestorCtx } from "../../src/core/ingestion/ingestors/types.ts";

const CTX: IngestorCtx = { brain: "teste", sourceId: "src-1", slug: "x" };

describe("registry de ingestores", () => {
  beforeEach(() => clearIngestors());

  it("registra, resolve por slug e lista em ordem estável (sem expor normalize)", () => {
    registerIngestor(notetakerIngestor);
    registerIngestor(textoIngestor);
    expect(getIngestor("texto")).toBe(textoIngestor);
    const lista = listIngestors();
    expect(lista.map((i) => i.slug)).toEqual(["notetaker", "texto"]);
    expect((lista[0] as Record<string, unknown>).normalize).toBeUndefined();
  });

  it("rejeita slug fora do kebab-case (a URL do webhook deriva dele)", () => {
    expect(() => registerIngestor({ ...textoIngestor, slug: "Meu Ingestor" })).toThrow(/kebab-case/);
  });

  it("boot dos built-ins é idempotente e registra os 7 de fábrica", () => {
    registerBuiltinIngestors();
    registerBuiltinIngestors();
    expect(listIngestors().map((i) => i.slug)).toEqual([
      "chat",
      "chatwoot",
      "evolution-whatsapp",
      "formulario",
      "notetaker",
      "planilha",
      "texto",
    ]);
  });
});

describe("ingestor texto (template)", () => {
  it("aceita { text } e monta markdown com título quando houver", () => {
    const [item] = textoIngestor.normalize({ title: "Ata", text: "Decidimos X.", occurred_at: "2026-07-01" }, CTX);
    expect(item.content).toBe("# Ata\n\nDecidimos X.");
    expect(item.contentType).toBe("text/markdown");
    expect(item.timestamp.startsWith("2026-07-01")).toBe(true);
    expect(item.title).toBe("Ata");
  });

  it("ref explícito vence; sem ref o hash do conteúdo é ESTÁVEL (dedupe de re-entrega)", () => {
    const [a] = textoIngestor.normalize({ text: "mesmo texto" }, CTX);
    const [b] = textoIngestor.normalize({ text: "mesmo texto" }, CTX);
    const [c] = textoIngestor.normalize({ text: "outro texto", ref: "meu-id" }, CTX);
    expect(a.externalRef).toBe(b.externalRef);
    expect(c.externalRef).toBe("meu-id");
  });

  it("sem texto → [] (ping/ack não vira ingestão)", () => {
    expect(textoIngestor.normalize({}, CTX)).toEqual([]);
    expect(textoIngestor.normalize({ text: "   " }, CTX)).toEqual([]);
  });
});

describe("ingestor evolution-whatsapp", () => {
  const base = {
    event: "messages.upsert",
    data: {
      key: { remoteJid: "554799998888@s.whatsapp.net", fromMe: false, id: "BAE594145F4C59B4" },
      pushName: "Mariana",
      message: { conversation: "Fechado, pode agendar quinta às 14h" },
      messageTimestamp: 1751414400, // epoch em SEGUNDOS
    },
  };

  it("mensagem de texto vira 1 item com proveniência e dedupe pelo id da mensagem", () => {
    const [item] = evolutionWhatsappIngestor.normalize(base, CTX);
    expect(item.externalRef).toBe("wa:BAE594145F4C59B4");
    expect(item.content).toContain("Fechado, pode agendar quinta às 14h");
    expect(item.content).toContain("Mariana");
    expect(item.timestamp).toBe(new Date(1751414400 * 1000).toISOString());
    expect(item.title).toBe("WhatsApp: 554799998888");
  });

  it("extendedTextMessage e caption de mídia também são texto", () => {
    const ext = { ...base, data: { ...base.data, message: { extendedTextMessage: { text: "reply com link" } } } };
    const cap = { ...base, data: { ...base.data, message: { imageMessage: { caption: "foto do orçamento" } } } };
    expect(evolutionWhatsappIngestor.normalize(ext, CTX)[0].content).toContain("reply com link");
    expect(evolutionWhatsappIngestor.normalize(cap, CTX)[0].content).toContain("foto do orçamento");
  });

  it("fromMe vira 'Você'; grupo (@g.us) é rotulado como grupo", () => {
    const grupo = {
      ...base,
      data: {
        ...base.data,
        key: { remoteJid: "120363042123456789@g.us", fromMe: true, id: "ID2" },
      },
    };
    const [item] = evolutionWhatsappIngestor.normalize(grupo, CTX);
    expect(item.content).toContain("Você");
    expect(item.content).toContain("grupo");
  });

  it("eventos que não são messages.upsert e mídia sem legenda → [] (ignora, não erra)", () => {
    expect(evolutionWhatsappIngestor.normalize({ event: "presence.update", data: base.data }, CTX)).toEqual([]);
    const audio = { ...base, data: { ...base.data, message: {} } };
    expect(evolutionWhatsappIngestor.normalize(audio, CTX)).toEqual([]);
  });

  it("aceita MESSAGES_UPSERT (maiúsculo do painel) e lote em array", () => {
    const lote = {
      event: "MESSAGES_UPSERT",
      data: [base.data, { ...base.data, key: { ...base.data.key, id: "OUTRO" } }],
    };
    const itens = evolutionWhatsappIngestor.normalize(lote, CTX);
    expect(itens).toHaveLength(2);
    expect(itens[1].externalRef).toBe("wa:OUTRO");
  });
});

describe("ingestor notetaker", () => {
  it("transcript com título, participantes (array OU string) e data vira markdown ancorado", () => {
    const [a] = notetakerIngestor.normalize(
      { title: "Comercial — Acme", transcript: "Kelvin: fechamos em R$ 2.500/mês.", participants: ["Kelvin", "Mariana"], occurred_at: "2026-07-01T14:00:00Z" },
      CTX,
    );
    expect(a.content).toContain("# Comercial — Acme");
    expect(a.content).toContain("Participantes — Kelvin, Mariana");
    expect(a.content).toContain("R$ 2.500/mês");
    const [b] = notetakerIngestor.normalize({ text: "resumo", participants: "Ana; Bia" }, CTX);
    expect(b.content).toContain("Participantes — Ana, Bia");
  });

  it("meeting_id vira ref de dedupe; sem transcript → [] (ping cru do Fireflies é ignorado)", () => {
    const [a] = notetakerIngestor.normalize({ transcript: "t", meeting_id: "m-123" }, CTX);
    expect(a.externalRef).toBe("m-123");
    expect(notetakerIngestor.normalize({ meetingId: "só-o-ping", eventType: "Transcription completed" }, CTX)).toEqual([]);
  });
});
