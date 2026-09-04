/** M17 · S4 — Gates #2/#3/#4 (E2E). A PROVA do M17 (§6 do brief / ADR-011).
 *
 *   - Gate #4 (right-size): PURO, sempre roda. config().synthModel = env quando setada; = apiModel no
 *     fallback (sem GALEED_SYNTH_MODEL). Confirma a LEI II sem custo de LLM.
 *   - Gate #2 (caso-canônico "médico"): E2E REAL via LLM (invariante #9 — nada "pronto" sem input real).
 *     Brain semeado DIRETO com a página do Bruno (fonte de verdade do quote). `ask("Existe algum
 *     médico?")` com GALEED_SYNTH_MODEL (Sonnet) deve (a) AFIRMAR médico, (b) NÃO conter "cardiovascular"
 *     (0× no corpus — a alucinação do HTC NÃO sobrevive), (c) NÃO conter "29 anos". OPT-IN: M17_E2E=1
 *     + chave/CLI + DB (padrão M16: skip por default no test:all, roda 1× no aceite).
 *   - Gate #3 (não-regressão): `npm run test:all` (comando, não arquivo) — golden M9/série 3k→30k verdes.
 *
 *  Território: SÓ teste novo. ZERO edição de produção. Importa engine/ask/config/helpers (não edita). */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { loadEnv, hasDb, wipeBrain } from "./helpers/db.ts";
import { getEngine, type PageRow } from "../../src/core/platform/engine.ts";
import { ask } from "../../src/core/retrieval/ask.ts";
import { config } from "../../src/core/platform/config.ts";

loadEnv();
const BRAIN = "__test_m17_medico"; // descartável (prefixo __test_m17_*); NUNCA toca Accelera real.

// invariante #9: o caso-canônico usa LLM REAL. Opt-in pra não custar no CI default (padrão M16).
// provider `cli` não precisa de ANTHROPIC_API_KEY; `api` precisa. Aceitamos qualquer um (|| true p/ cli).
const E2E_ON =
  process.env.M17_E2E === "1" &&
  hasDb() &&
  (!!process.env.ANTHROPIC_API_KEY || true /* provider cli não exige a chave */);

// ---- Gate #4 (right-size / LEI II) — PURO, sempre roda (sem DB, sem LLM) ----
describe("M17/S4 Gate#4 — right-size (synthModel = env | fallback apiModel)", () => {
  it("synthModel = env quando setado; = apiModel no fallback", () => {
    const save = process.env.GALEED_SYNTH_MODEL;
    // (a) env explícita vence
    process.env.GALEED_SYNTH_MODEL = "claude-sonnet-4-6";
    expect(config(BRAIN).synthModel).toBe("claude-sonnet-4-6");
    // (b) sem env → cai no apiModel (não quebra ambiente que não configurou o Sonnet)
    delete process.env.GALEED_SYNTH_MODEL;
    expect(config(BRAIN).synthModel).toBe(config(BRAIN).apiModel);
    // restaura o ambiente do processo (não vazar entre testes)
    if (save == null) delete process.env.GALEED_SYNTH_MODEL;
    else process.env.GALEED_SYNTH_MODEL = save;
  });

  it("synthModel NÃO é um id hardcoded de Sonnet no código (ADR-011 §3 — default Sonnet é política via env)", () => {
    const save = process.env.GALEED_SYNTH_MODEL;
    delete process.env.GALEED_SYNTH_MODEL;
    // sem a env, o synthModel é exatamente o apiModel (Haiku) — prova que o "Sonnet default" não está
    // cravado no código (cravar quebraria ambiente sem acesso ao modelo).
    expect(config(BRAIN).synthModel).toBe(config(BRAIN).apiModel);
    if (save == null) delete process.env.GALEED_SYNTH_MODEL;
    else process.env.GALEED_SYNTH_MODEL = save;
  });
});

// ---- Gate #2 (caso-canônico médico, LLM REAL — invariante #9) ----
describe.skipIf(!E2E_ON)("M17/S4 Gate#2 — caso-canônico 'médico' (LLM real, invariante #9)", () => {
  beforeAll(async () => {
    await wipeBrain(BRAIN);
    const e = await getEngine(BRAIN);
    // semeia a página DIRETO (sem extração) — o `body` é a fonte de verdade do quote. O retrieve cai
    // pra FTS sem vetores (mesmo padrão do fixture de smoke), e o body contém "médico" → recuperável.
    const page: PageRow = {
      slug: "bio-bruno",
      type: "doc",
      title: "Bruno Canguçu",
      date: "2024-01-01",
      path: "",
      body:
        "Bruno Canguçu é médico Cirurgião Vascular e Endovascular, sócio da Accelera 360, " +
        "com mais de 28 anos de experiência clínica.",
      content_hash: "bio-bruno",
      tags: [],
      sensitivity: "publico",
    };
    await e.upsertPage(page);
  });
  afterAll(async () => {
    await wipeBrain(BRAIN);
  });

  it("afirma médico, NÃO inventa 'cardiovascular' nem '29 anos'", async () => {
    // garante a síntese no Sonnet (right-size); se o aceite já setou a env, respeita.
    process.env.GALEED_SYNTH_MODEL ||= "claude-sonnet-4-6";
    const r = await ask(BRAIN, "Existe algum médico na Accelera 360?", 8);
    const a = (r.answer || "").toLowerCase();
    // (a) afirmativo e ancorado: a resposta menciona "médico" (a fonte diz literalmente "é médico").
    expect(a).toContain("médico");
    // (b) a alucinação do HTC NÃO sobrevive: "cardiovascular" é 0× no corpus.
    expect(a).not.toContain("cardiovascular");
    // (c) número não-ancorado cortado: a fonte diz "mais de 28 anos", nunca "29 anos".
    expect(a).not.toContain("29 anos");
    // sanidade: a resposta NÃO ficou vazia (claim legítimo sobreviveu — gate não mutila a verdade).
    expect(a.length).toBeGreaterThan(0);
  }, 60_000);
});
