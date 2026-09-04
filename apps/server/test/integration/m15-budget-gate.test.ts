/** M15/S4 — BUDGET GATE (a LEI do BRIEF §7 virando teste, no caminho REAL do worker). Materializa os
 *  gates #2 (encontrável ANTES de digerido), #3 (reversibilidade) e #4 (sem regressão / golden M9). O gate
 *  #1 (corte ≥50% / recall ≥0.95 por tipo) vive em `m15-pipeline-cut.test.ts` (PURO, sem DB/LLM) — este
 *  aqui prova as propriedades que SÓ aparecem rodando o pipeline ponta-a-ponta contra o Postgres real.
 *
 *  Precisa de Postgres (docker compose up -d → :5434) — skip automático sem DATABASE_URL (espelha
 *  `supersession-e2e.test.ts`). Brains descartáveis `__m15_gate_*` (NUNCA Accelera). Os gates #2 (ORDEM) é o
 *  assert RÍGIDO e determinístico (não depende de LLM); #3 usa o LLM (extração real) e só roda com chave
 *  (skip suave sem ANTHROPIC/OPENAI), espelhando o padrão de gate do M14/S4: a propriedade ESTRUTURAL é o
 *  assert; a latência absoluta é sinal. */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { hasDb, wipeBrain } from "./helpers/db.ts";
import { getEngine, closeEngines } from "../../src/core/platform/engine.ts";
import { processBlobJob, type IngestPhase } from "../../src/core/ingestion/process-blob-job.ts";
import type { IngestJob } from "../../src/core/ingestion/ingest-queue.ts";
import { retrieve } from "../../src/core/retrieval/query.ts";
import { scoreSegment, DEFAULT_TRIAGE_PROFILE } from "../../src/core/ingestion/triage.ts";

const hasLlm = (): boolean => !!(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY);

/** Monta um IngestJob `text` mínimo (sem blob store) — o pipeline lê `textBody` direto. */
function textJob(brain: string, text: string, type = "conversa"): IngestJob {
  return {
    id: `job-${brain}`,
    brain,
    kind: "text",
    status: "queued",
    type,
    contentHash: null,
    filename: null,
    mime: null,
    title: "fixture m15 gate",
    jobDate: "2026-01-10",
    textBody: text,
    progress: 0,
    message: null,
    resultJson: {},
    errorMessage: null,
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    // M16 — campos de lote (Batch API). Jobs síncronos M12–M15 têm os 3 null (caminho síncrono).
    // Mantém o literal honesto com IngestJob ampliado p/ um eventual gate tsc --noEmit não acusar.
    batchId: null,
    batchStatus: null,
    batchCustomMap: null,
    // M21 — fonte do job; P0-C — lease/retry. Defaults neutros (job de fixture sem contrato, nunca claimado).
    sourceId: null,
    leaseUntil: null,
    attempts: 0,
  };
}

/** Conversa datada estilo WhatsApp — um termo BUSCÁVEL único ("zarvox") + um fato denso, pra provar
 *  encontrabilidade na Fase A. Datada (vira segmentos), com ruído (kkkk) pra exercitar a triagem. */
const BUSCA_TERMO = "zarvox";
const CONVERSA = [
  "[2026-01-10 09:00] Bruno: bom dia",
  "[2026-01-10 09:01] Carla: oi",
  `[2026-01-10 09:02] Bruno: o projeto ${BUSCA_TERMO} fechou em R$ 30 mil por mês`,
  "[2026-01-10 09:03] Carla: kkkk",
  "[2026-01-10 09:04] Bruno: combinado",
  `[2026-01-10 09:05] Carla: a entrega do ${BUSCA_TERMO} é em março`,
].join("\n");

describe.skipIf(!hasDb())("M15/S4 — budget gate (a LEI virando teste, caminho real)", () => {
  // ---- Gate #2: encontrável ANTES de digerido (ORDEM = assert rígido; busca durante digesting) ----
  describe("gate #2 — encontrável (Fase A) antes de digerido (Fase B)", () => {
    const BRAIN = "__m15_gate_findable";
    const phases: IngestPhase[] = [];
    let hitsDuranteFindable = 0;
    let msAteFindable = 0;

    beforeAll(async () => {
      await wipeBrain(BRAIN);
      const t0 = Date.now();
      // onPhase: grava a ordem; na transição "findable" mede a latência E prova que o brain JÁ responde
      // (retrieve retorna ≥1 hit) com a extração (Fase B) ainda NÃO rodada.
      await processBlobJob(textJob(BRAIN, CONVERSA), undefined, async (p) => {
        phases.push(p);
        if (p === "findable") {
          msAteFindable = Date.now() - t0;
          const hits = await retrieve(BRAIN, BUSCA_TERMO, 6).catch(() => []);
          hitsDuranteFindable = hits.length;
        }
      });
      // eslint-disable-next-line no-console
      console.log(`[m15-gate#2] encontrável em ${msAteFindable}ms (sinal; alvo ≤60s) phases=${phases.join("→")}`);
    }, 180_000);

    afterAll(async () => {
      await wipeBrain(BRAIN);
    });

    it("a 1ª fase reportada é 'findable' (o cérebro fica buscável ANTES de qualquer extração)", () => {
      expect(phases[0]).toBe("findable");
    });

    it("'digesting' vem DEPOIS de 'findable' (sequência das duas pistas)", () => {
      expect(phases).toContain("digesting");
      expect(phases.indexOf("digesting")).toBeGreaterThan(phases.indexOf("findable"));
    });

    it("durante a Fase A (job ainda digesting) a BUSCA já responde (≥1 resultado p/ um termo presente)", () => {
      expect(hitsDuranteFindable).toBeGreaterThanOrEqual(1);
    });

    it("encontrabilidade é rápida (sinal informativo; o assert rígido de ≤60s real fica pro HTC)", () => {
      // assert FROUXO (CI ruidoso): só garante que mediu algo plausível; o ≤60s real é o HTC.
      expect(msAteFindable).toBeGreaterThanOrEqual(0);
    });
  });

  // ---- Gate #3: reversibilidade (segmento pulado pela triagem reaparece sob GALEED_TRIAGE_BYPASS=1) ----
  describe.skipIf(!hasLlm())("gate #3 — reversibilidade (re-extração com bypass recupera o pulado)", () => {
    const BRAIN_TRIADO = "__m15_gate_rev_triado";
    const BRAIN_FULL = "__m15_gate_rev_full";
    // conteúdo com MUITO ruído social (que a triagem pula) + 1 fato denso (que ela mantém). O brain FULL
    // (bypass) extrai TUDO; o brain TRIADO pula o ruído. Asserção: full ≥ triado (o pulado pode virar fato).
    const RUIDOSO = [
      "[2026-02-01 10:00] Ana: oi",
      "[2026-02-01 10:01] Rui: kkkk",
      "[2026-02-01 10:02] Ana: bom dia",
      "[2026-02-01 10:03] Rui: 👍",
      "[2026-02-01 10:04] Ana: o contrato com a acme é R$ 50 mil",
      "[2026-02-01 10:05] Rui: valeu",
      "[2026-02-01 10:06] Ana: blz",
    ].join("\n");
    let factsTriado = 0;
    let factsFull = 0;

    beforeAll(async () => {
      await wipeBrain(BRAIN_TRIADO);
      await wipeBrain(BRAIN_FULL);
      delete process.env.GALEED_TRIAGE_BYPASS;
      await processBlobJob(textJob(BRAIN_TRIADO, RUIDOSO));
      const eT = await getEngine(BRAIN_TRIADO);
      factsTriado = (await eT.currentFacts()).length;

      process.env.GALEED_TRIAGE_BYPASS = "1";
      try {
        await processBlobJob(textJob(BRAIN_FULL, RUIDOSO));
      } finally {
        delete process.env.GALEED_TRIAGE_BYPASS;
      }
      const eF = await getEngine(BRAIN_FULL);
      factsFull = (await eF.currentFacts()).length;
      // eslint-disable-next-line no-console
      console.log(`[m15-gate#3] factsTriado=${factsTriado} factsFull(bypass)=${factsFull}`);
    }, 300_000);

    afterAll(async () => {
      await wipeBrain(BRAIN_TRIADO);
      await wipeBrain(BRAIN_FULL);
    });

    it("o bypass (full) recupera AO MENOS tantos fatos quanto o triado — o pulado é reversível, não perdido", () => {
      // o segmento pulado NÃO é descartado (fica capturado+encontrável na Fase A); re-extrair com bypass
      // produz pelo menos o mesmo conjunto de fatos (≥). A triagem é decisão de ORÇAMENTO, não de recall.
      expect(factsFull).toBeGreaterThanOrEqual(factsTriado);
      expect(factsFull).toBeGreaterThan(0);
    });
  });

  // ---- Gate #4: sem regressão (mini-assert local; a suíte completa é `npm run test:all`) ----
  describe("gate #4 — sem regressão (a triagem nunca cega uma call de venda com preço/cliente)", () => {
    it("um claim 'X custa R$ N' com entityHint conhecida é SEMPRE worthy (salvaguarda do golden M9)", () => {
      const v = scoreSegment(
        { text: "A acme fechou o plano enterprise em R$ 30 mil por mês", entityHints: ["acme"], channel: "notetaker", type: "reunioes", confident: true },
        DEFAULT_TRIAGE_PROFILE,
      );
      expect(v.worthy).toBe(true);
      expect(v.signals.includes("number") || v.signals.includes("entity")).toBe(true);
    });
  });
});
