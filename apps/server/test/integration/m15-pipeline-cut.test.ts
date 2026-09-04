/** M15/S4 — GATE DE PIPELINE (a PROVA do invariante II no CAMINHO REAL). Revisão `gap-S3-cut/DECISION.md`.
 *
 *  O gate do S1 (`triage-gate.test.ts` + `*.jsonl`) prova o ALGORITMO em texto CRU por-mensagem — honesto
 *  pro algoritmo, INSUFICIENTE pro pipeline: o worker NÃO alimenta o porteiro com mensagens cruas, e sim
 *  com UNITS de `buildExtractionUnits` (segmentadas, com scaffold `Speaker (ISO):`). O blocker provou que o
 *  corte de 53% das fixtures EVAPORAVA na unit grossa (o timestamp do scaffold disparava `hasNumber` →
 *  hard-worthy). O S5 consertou a ENTRADA (poda por-mensagem + `triageText` semântico). ESTE gate mede o
 *  que o pipeline ENTREGA: `buildExtractionUnits(page)` REAL + `scoreSegment(u.triageText)` sobre `PageRow`
 *  realistas de MÚLTIPLAS fontes — provando que o corte SOBREVIVE à granularidade/forma-do-texto da unit.
 *
 *  É PURO (sem DB, sem LLM, sem env): input rotulado determinístico (invariante #9). Reusa as MESMAS
 *  fixtures rotuladas do S1 (`helpers/triage-fixtures/*.jsonl`) — o oráculo de "fato de alto valor" é a flag
 *  `highValue` (determinística), mas a MEDIÇÃO passa pelo caminho do worker, não pelas fixtures cruas.
 *
 *  Os dois eixos (BRIEF §7.1, linhas 146–148):
 *    (1) RECALL ≥ 0.95 POR TIPO — a triagem NUNCA derruba um fato de alto valor, em NENHUMA fonte (prova de
 *        que o porteiro não superajustou a chat). Vale p/ os 5 tipos.
 *    (2) CORTE ≥ 50% AGREGADO — o porteiro poupa ≥metade das chamadas LLM. Medido na granularidade em que o
 *        pipeline corta (mensagem, p/ fontes conversacionais) sobre o corpus ruidoso (o caso-canônico: o
 *        WhatsApp 4MB ~70% ruído + a call/notetaker com backchannel). Os docs densos (PDF/CSV/e-mail) são a
 *        prova do LADO da PRESERVAÇÃO (recall ≥0.95; chunk denso quase nunca corta, e NÃO deve — `gap-S3-cut`
 *        §"Doc/CSV/email"). */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  buildExtractionUnits,
  splitIntoSegments,
} from "../../src/core/ingestion/segment.ts";
import { parseConversationMessages } from "../../src/lib/conversation.ts";
import { scoreSegment, DEFAULT_TRIAGE_PROFILE } from "../../src/core/ingestion/triage.ts";
import type { PageRow } from "../../src/core/platform/engine.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "helpers", "triage-fixtures");

interface Fixture {
  text: string;
  channel: string;
  type: string;
  highValue: boolean;
  entityHints?: string[];
}

/** Fontes conversacionais (mensagens datadas, speakers) → caminho de SEGMENTAÇÃO (`splitIntoSegments`) +
 *  poda por-mensagem do S5. Aqui o corte é REAL (segmento todo-social some; misto encolhe). */
const CONVERSATIONAL = new Set(["call", "chat"]);
/** Fontes documentais (sem mensagens datáveis) → `chunkBySize` (1 chunk denso). Lado da PRESERVAÇÃO. */
const DOCUMENTAL = ["PDF", "csv", "email"] as const;
const TYPES = ["call", "PDF", "csv", "email", "chat"] as const;

/** entityHints do brain (mesmo conjunto que o gate do S1 e o worker usariam) — alimenta o sinal `entity`. */
const ENTITY_HINTS = ["acme", "e1"];

function loadFixture(tipo: string): Fixture[] {
  const raw = readFileSync(join(FIXTURES, `${tipo}.jsonl`), "utf8");
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Fixture);
}

/** Renderiza uma fonte conversacional como corpo REAL de WhatsApp/notetaker: `[ISO] Falante: texto`, com
 *  timestamps espaçados pra formar VÁRIOS segmentos (gap > 30min a cada ~6 msgs) — é o que produz segmentos
 *  todo-social (que somem) e mistos (que encolhem). Determinístico (datas fixas). */
function conversationalBody(segs: Fixture[]): string {
  let t = Date.parse("2026-01-10T09:00:00Z");
  return segs
    .map((s, i) => {
      const speaker = i % 2 === 0 ? "Bruno" : "Carla";
      t += (i % 6 === 0 ? 40 : 2) * 60_000; // gap grande a cada 6 → novo segmento
      const ts = new Date(t).toISOString().slice(0, 16).replace("T", " ");
      return `[${ts}] ${speaker}: ${s.text}`;
    })
    .join("\n");
}

function buildPage(tipo: string, segs: Fixture[]): PageRow {
  if (CONVERSATIONAL.has(tipo)) {
    return { slug: tipo, type: "conversa", title: tipo, date: "2026-01-10", path: "", body: conversationalBody(segs) };
  }
  // documento: corpo é o texto cru (linhas) — cai em chunkBySize (texto já semântico, sem scaffold).
  return { slug: tipo, type: tipo, title: tipo, date: "2026-01-10", path: "", body: segs.map((s) => s.text).join("\n") };
}

/** Roda o CAMINHO REAL do worker: `buildExtractionUnits(page)` (com a poda por-mensagem do S5) + o porteiro
 *  `scoreSegment(u.triageText)` (S1) com o DEFAULT genérico. Devolve as units WORTHY (as que vão pro LLM). */
function worthyUnits(page: PageRow) {
  const units = buildExtractionUnits(page);
  return units.filter(
    (u) =>
      scoreSegment(
        { text: u.triageText, entityHints: ENTITY_HINTS, channel: page.type, type: page.type, confident: true },
        DEFAULT_TRIAGE_PROFILE,
      ).worthy,
  );
}

/** Recall de fato de alto valor POR TIPO: um `highValue` é "recuperado" se o seu texto sobrevive em alguma
 *  unit WORTHY (i.e., o LLM ainda o vê). Mede a COMPOSIÇÃO segmentação×poda×triagem, não a fixture crua. */
function recallByType(tipo: string): { recall: number; dropped: string[] } {
  const segs = loadFixture(tipo);
  const page = buildPage(tipo, segs);
  const worthyText = worthyUnits(page)
    .map((u) => u.triageText)
    .join("\n");
  const hv = segs.filter((s) => s.highValue);
  const dropped = hv.filter((s) => !worthyText.includes(s.text)).map((s) => s.text);
  const recovered = hv.length - dropped.length;
  return { recall: hv.length ? recovered / hv.length : 1, dropped };
}

describe("M15/S4 — gate de PIPELINE (corte real: buildExtractionUnits + scoreSegment(triageText))", () => {
  it("RECALL ≥0.95 POR TIPO no CAMINHO REAL — a triagem nunca cega um fato de alto valor (5 fontes)", () => {
    for (const tipo of TYPES) {
      const { recall, dropped } = recallByType(tipo);
      if (recall < 0.95) {
        throw new Error(
          `recall(${tipo})=${recall.toFixed(3)} < 0.95 no pipeline; highValue cegados: ${JSON.stringify(dropped)}`,
        );
      }
      expect(recall, `${tipo}`).toBeGreaterThanOrEqual(0.95);
    }
  });

  it("CORTE ≥50% AGREGADO nas fontes ruidosas (caso-canônico WhatsApp/notetaker), medido na granularidade real", () => {
    // "Chamada LLM cortada" = mensagem-candidata que o pipeline PRE-S5 mandaria pro LLM (toda msg de um
    // segmento ≥ MIN_SEGMENT_MESSAGES) e que a poda por-mensagem + a triagem AGORA não mandam. Denominador =
    // mensagens dos segmentos (o que o worker via antes do S5); numerador = mensagens sobreviventes nas
    // units worthy (o que o LLM vê HOJE). É a economia REAL de chamadas, idêntica ao que o log
    // `[triage] unitsWorthy/unitsTotal` reflete em produção (BRIEF §4: ≤300 chamadas / corte ≥50–60%).
    let full = 0;
    let kept = 0;
    const perType: Record<string, string> = {};
    for (const tipo of TYPES) {
      if (!CONVERSATIONAL.has(tipo)) continue;
      const segs = loadFixture(tipo);
      const page = buildPage(tipo, segs);
      // baseline FULL (sem triagem): todas as mensagens dos segmentos extraíveis.
      const msgs = parseConversationMessages(page.body, { fallbackDate: "2026-01-10" });
      const fullMsgs = splitIntoSegments(msgs).reduce((n, s) => n + s.messages.length, 0);
      // TRIADO: mensagens que sobrevivem nas units worthy (o que vai pro LLM).
      const keptMsgs = worthyUnits(page).reduce(
        (n, u) => n + u.triageText.split("\n").filter((l) => l.trim().length > 0).length,
        0,
      );
      full += fullMsgs;
      kept += keptMsgs;
      perType[tipo] = `${(1 - keptMsgs / fullMsgs).toFixed(3)}`;
    }
    const cut = 1 - kept / full;
    // diagnóstico legível no output (sinal informativo por tipo + agregado).
    // eslint-disable-next-line no-console
    console.log(
      `[m15-pipeline-cut] corte agregado=${cut.toFixed(3)} (full=${full} kept=${kept}) porTipo=${JSON.stringify(perType)}`,
    );
    expect(cut, `corte agregado=${cut.toFixed(3)}`).toBeGreaterThanOrEqual(0.5);
  });

  it("docs densos (PDF/CSV/e-mail) são preservados — chunk denso NÃO corta (lado da preservação, gap-S3-cut)", () => {
    // Prova explícita do invariante de recall no lado documental: o chunk grosso é worthy (tem número/
    // entidade) e o fato denso sobrevive. NÃO esperamos corte aqui — o corte vem da conversa ruidosa.
    for (const tipo of DOCUMENTAL) {
      const { recall } = recallByType(tipo);
      expect(recall, `${tipo} preservação`).toBe(1);
    }
  });

  it("salvaguarda do golden M9: uma msg de call de venda com preço/cliente é SEMPRE worthy (number/entity)", () => {
    // O caso-canônico (Accelera): a mensagem de preço com `number` (e/ou `entity`) NUNCA é cortada — a
    // série de preço sobrevive ao porteiro no caminho real (recall do golden preservado por construção).
    const exemplos = [
      "Hoje o plano enterprise da acme custa R$ 30 mil por mês",
      "Fechamos com a acme por R$ 30 mil/mês no plano enterprise",
    ];
    for (const text of exemplos) {
      const v = scoreSegment(
        { text, entityHints: ENTITY_HINTS, channel: "notetaker", type: "reunioes", confident: true },
        DEFAULT_TRIAGE_PROFILE,
      );
      expect(v.worthy, `cegou a call de venda: ${text}`).toBe(true);
      expect(v.signals.includes("number") || v.signals.includes("entity"), text).toBe(true);
    }
  });

  it("determinismo: o caminho real é reprodutível (mesmas pages → mesmo corte/recall)", () => {
    const a = TYPES.map((t) => recallByType(t).recall).join(",");
    const b = TYPES.map((t) => recallByType(t).recall).join(",");
    expect(a).toBe(b);
  });
});
