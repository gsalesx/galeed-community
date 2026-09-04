/** Achado criacao-de-fatos #1 — segmento com < MIN_SEGMENT_MESSAGES era DESCARTADO em silêncio no
 *  flush() de splitIntoSegments: a decisão que chega horas depois da discussão (gap >30min abre
 *  segmento novo de 1 msg) nunca chegava à extração — sem log, sem bypass, sem re-extração.
 *  Agora o flush FUNDE: segmento curto entra no anterior (ou acumula pra frente se ainda não há
 *  nenhum). Puro, sem DB/LLM (padrão m15-pipeline-cut, lado unit). */
import { describe, it, expect } from "vitest";
import { parseConversationMessages } from "../../src/lib/conversation.ts";
import { splitIntoSegments, buildExtractionUnits } from "../../src/core/ingestion/segment.ts";
import type { PageRow } from "../../src/core/platform/engine.ts";

const page = (body: string): PageRow => ({
  slug: "p", type: "reunioes", title: "conversa", date: "2026-06-01", path: "", body, content_hash: "p",
});

describe("splitIntoSegments — fusão do segmento órfão (nunca descarta mensagem)", () => {
  it("mensagem ÚNICA após gap >30min é PRESERVADA: funde no segmento anterior, endIso/participants atualizados", () => {
    const body = [
      "[2026-06-01 10:00] Kelvin Cleto: precisamos decidir o fornecedor do projeto",
      "[2026-06-01 10:02] Kelvin Cleto: vou analisar as propostas com o financeiro",
      "[2026-06-01 15:00] Bruno Silva: decidimos fechar com o fornecedor Alfa porque o SLA deles é melhor",
    ].join("\n");
    const msgs = parseConversationMessages(body);
    expect(msgs).toHaveLength(3);
    const segs = splitIntoSegments(msgs);
    // antes: 1 segmento SÓ com as 2 msgs das 10h (a decisão das 15h morria no flush).
    expect(segs).toHaveLength(1);
    expect(segs[0].messages).toHaveLength(3);
    expect(segs[0].startIso).toBe("2026-06-01T10:00:00Z");
    expect(segs[0].endIso).toBe("2026-06-01T15:00:00Z"); // âncora recomputada pós-fusão
    expect(segs[0].participants).toEqual(["Kelvin Cleto", "Bruno Silva"]); // falante novo entra em ordem de 1ª aparição
  });

  it("a DECISÃO das 15h chega à extração: buildExtractionUnits contém o texto (fim da perda silenciosa)", () => {
    const body = [
      "[2026-06-01 10:00] Kelvin Cleto: precisamos decidir o fornecedor do projeto",
      "[2026-06-01 10:02] Kelvin Cleto: vou analisar as propostas com o financeiro",
      "[2026-06-01 15:00] Bruno Silva: decidimos fechar com o fornecedor Alfa porque o SLA deles é melhor",
    ].join("\n");
    const units = buildExtractionUnits(page(body));
    const all = units.map((u) => u.body).join("\n");
    expect(all).toContain("fornecedor Alfa");
  });

  it("fusão pra FRENTE: 1ª mensagem sozinha antes do gap acumula no segmento seguinte (startIso dela)", () => {
    const body = [
      "[2026-06-01 09:00] Kelvin Cleto: o orçamento aprovado foi de R$ 40 mil",
      "[2026-06-01 15:00] Bruno Silva: retomando a pauta do orçamento aprovado",
      "[2026-06-01 15:01] Kelvin Cleto: vamos executar conforme combinado no contrato",
    ].join("\n");
    const segs = splitIntoSegments(parseConversationMessages(body));
    expect(segs).toHaveLength(1);
    expect(segs[0].messages).toHaveLength(3);
    expect(segs[0].startIso).toBe("2026-06-01T09:00:00Z");
  });

  it("cauda do maxMessages: conversa de 31 mensagens preserva a 31ª (fundida ao segmento de 30)", () => {
    const lines: string[] = [];
    for (let i = 0; i < 31; i++) {
      const mm = String(i).padStart(2, "0");
      lines.push(`[2026-06-01 10:${mm}] Kelvin Cleto: item ${i} da pauta foi discutido e aprovado`);
    }
    const msgs = parseConversationMessages(lines.join("\n"));
    expect(msgs).toHaveLength(31);
    const segs = splitIntoSegments(msgs);
    const total = segs.reduce((n, s) => n + s.messages.length, 0);
    expect(total).toBe(31); // antes: a 31ª morria (30 vão pro segmento, a cauda <2 era descartada)
    expect(segs.some((s) => s.messages.some((m) => m.text.includes("item 30")))).toBe(true);
  });

  it("propriedade de CONSERVAÇÃO: com ≥2 mensagens, soma dos segmentos === total de entrada (nenhuma perda)", () => {
    // padrões de gap variados (gap no início, no meio, no fim, consecutivos) — determinístico.
    const patterns = [
      [0, 300, 302, 304], // órfã no início
      [0, 2, 300, 600], // 2 órfãs consecutivas no fim
      [0, 2, 300, 302, 600], // órfã no fim após segmento válido
      [0, 2], // sem gap
    ];
    for (const mins of patterns) {
      const body = mins
        .map((m, i) => {
          const t = new Date(Date.parse("2026-06-01T08:00:00Z") + m * 60_000);
          const ts = t.toISOString().slice(0, 16).replace("T", " ");
          return `[${ts}] Kelvin Cleto: registro ${i} da conversa sobre o contrato`;
        })
        .join("\n");
      const msgs = parseConversationMessages(body);
      const segs = splitIntoSegments(msgs);
      const total = segs.reduce((n, s) => n + s.messages.length, 0);
      expect(total, `pattern=${JSON.stringify(mins)}`).toBe(msgs.length);
    }
  });

  it("ruído puro após gap continua morrendo — mas no lugar CERTO (pruneSegmentMessages), não no split", () => {
    const body = [
      "[2026-06-01 10:00] Kelvin Cleto: o contrato foi assinado por R$ 25 mil",
      "[2026-06-01 10:02] Bruno Silva: vou registrar a assinatura no sistema",
      "[2026-06-01 15:00] Bruno Silva: kkkk",
    ].join("\n");
    // o split PRESERVA (conservação)…
    const segs = splitIntoSegments(parseConversationMessages(body));
    expect(segs.reduce((n, s) => n + s.messages.length, 0)).toBe(3);
    // …e o Stage 0 poda o ruído antes da unit (o LLM não vê "kkkk").
    const all = buildExtractionUnits(page(body)).map((u) => u.body).join("\n");
    expect(all).toContain("R$ 25 mil");
    expect(all).not.toContain("kkkk");
  });
});
