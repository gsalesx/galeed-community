/** Achado criacao-de-fatos #3 — o preâmbulo ANTES da 1ª linha de falante (resumo executivo,
 *  participantes, action-items de notetaker) era descartado quando a página parseava como conversa:
 *  parseConversationMessages só anexava continuação "se houver" mensagem anterior, e o trecho mais
 *  denso da página nunca virava fato. Fix no PARSER (conserta os 4 consumidores de uma vez):
 *  linhas pré-cabeçalho acumulam e viram mensagem inicial sintética {speaker:"", timestamp:""}.
 *  Puro, sem DB/LLM (molde conversation-whatsapp.test.ts). */
import { describe, it, expect } from "vitest";
import { parseConversationMessages } from "../../src/lib/conversation.ts";
import { buildExtractionUnits } from "../../src/core/ingestion/segment.ts";
import type { PageRow } from "../../src/core/platform/engine.ts";

const page = (body: string): PageRow => ({
  slug: "p", type: "reunioes", title: "call", date: "2026-06-01", path: "", body, content_hash: "p",
});

describe("parseConversationMessages — preâmbulo vira mensagem inicial sintética", () => {
  it("prosa antes das falas → 1ª mensagem {speaker:'', timestamp:''} com o preâmbulo inteiro", () => {
    const body = [
      "Resumo executivo da call: o cliente aceitou o reajuste e pediu prazo de 30 dias.",
      "Pontos principais discutidos abaixo.",
      "Kelvin Cleto: seguimos então com o reajuste aprovado",
      "Bruno Souza: confirmo, encaminho o aditivo amanhã",
    ].join("\n");
    const m = parseConversationMessages(body, { fallbackDate: "2026-06-01" });
    expect(m).toHaveLength(3);
    expect(m[0].speaker).toBe(""); // caminho já suportado (msg de sistema WhatsApp)
    expect(m[0].timestamp).toBe(""); // não dispara gap nem polui startIso/endIso na segmentação
    expect(m[0].text).toContain("Resumo executivo da call");
    expect(m[0].text).toContain("Pontos principais");
    expect(m[1].speaker).toBe("Kelvin Cleto");
  });

  it("'Resumo: …' (rejeitado como falante pelo STOP set) também é preâmbulo, não lixo", () => {
    const body = [
      "Resumo: cliente aceitou o reajuste de 12% e pediu prazo de 30 dias.",
      "Kelvin Cleto: vou formalizar o aceite por e-mail",
      "Bruno Souza: perfeito, aguardo a formalização do aceite",
    ].join("\n");
    const m = parseConversationMessages(body, { fallbackDate: "2026-06-01" });
    expect(m).toHaveLength(3);
    expect(m[0].text).toContain("cliente aceitou o reajuste");
  });

  it("o preâmbulo CHEGA à extração: units contêm 'Resumo executivo' (antes: fora de todas as units)", () => {
    const body = [
      "Resumo executivo da call: o cliente aceitou o reajuste e pediu prazo de 30 dias.",
      "Pontos principais discutidos abaixo.",
      "Kelvin Cleto: seguimos então com o reajuste aprovado",
      "Bruno Souza: confirmo, encaminho o aditivo amanhã",
    ].join("\n");
    const all = buildExtractionUnits(page(body)).map((u) => u.body).join("\n");
    expect(all).toContain("Resumo executivo");
    expect(all).toContain("prazo de 30 dias");
  });

  it("doc/nota comum SEM fala nenhuma → [] como antes (contrato preservado: chunkBySize cobre o corpo)", () => {
    const m = parseConversationMessages("linha um do documento\nlinha dois do documento");
    expect(m).toEqual([]);
    // e o buildExtractionUnits cobre o corpo INTEIRO via chunkBySize:
    const units = buildExtractionUnits(page("linha um do documento\nlinha dois do documento"));
    expect(units).toHaveLength(1);
    expect(units[0].body).toContain("linha um");
  });

  it("efeito colateral documentado: 1 preâmbulo + 1 fala vira caminho de conversa (msgs=2) — conteúdo total coberto", () => {
    const body = [
      "Ata da reunião: orçamento de R$ 40 mil aprovado pela diretoria.",
      "Kelvin Cleto: aprovado, vamos executar o plano no próximo ciclo",
    ].join("\n");
    const m = parseConversationMessages(body, { fallbackDate: "2026-06-01" });
    expect(m).toHaveLength(2); // antes: 1 msg → chunkBySize; agora: preâmbulo + fala
    const all = buildExtractionUnits(page(body)).map((u) => u.body).join("\n");
    expect(all).toContain("R$ 40 mil");
    expect(all).toContain("vamos executar");
  });

  it("regressão: corpo que JÁ começa com fala não ganha mensagem sintética", () => {
    const m = parseConversationMessages("[2026-06-01 10:00] Kelvin Cleto: oi, seguimos com o plano");
    expect(m).toHaveLength(1);
    expect(m[0].speaker).toBe("Kelvin Cleto");
  });
});
