/** INTEGRAÇÃO M21/S4 — wizard "Criar um cérebro" (bff-wizard.ts). Asserts do CONTRACT:
 *   - wizardStart: step 'purpose', pergunta não-vazia, painel "Cérebro sem nome", 5 chips, done=false;
 *   - reply avança SEMPRE na ordem purpose→areas→sources→sensitivity→review, mesmo SEM provider
 *     (degrade determinístico — GALEED_PROVIDER="" desliga a IA; o wizard nunca trava);
 *   - no review: cartão legível sem JSON; panel.sources[i].fields = labels da receita;
 *   - confirm cria o brain (membership + contexto M11 + pack M13 em MERGE + fontes S1, sigilo
 *     degradado = 'restrito', falha-fechado);
 *   - colisão de slug (outra conta) → BffError 409 e NADA gravado.
 *  No-op sem DATABASE_URL/GALEED_DB_URL/SUPABASE_DB_URL (padrão ADR-014) nos testes que tocam DB. */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { hasDb, rawConnect, wipeBrain } from "./helpers/db.ts";

// IA explicitamente desligada (mesma semântica do smoke `env GALEED_PROVIDER=`): degrade
// determinístico em todos os turnos — teste estável, zero custo, zero rede.
process.env.GALEED_PROVIDER = "";

import {
  wizardStart,
  wizardReply,
  wizardConfirm,
  BffError,
  type WizardTurn,
} from "../../src/connectors/bff/bff-wizard.ts";
import { getBrainContext } from "../../src/core/extraction/brain-context.ts";
import { loadSchemaPackAsync } from "../../src/core/extraction/schema-pack.ts";
import { getEngine, closeEngines, SENSITIVITY_LEVELS } from "../../src/core/platform/engine.ts";
import { brainExists, closeAccounts } from "../../src/core/access/accounts.ts";

const BRAIN = "memoria-de-teste-do-wizard-m21wz"; // slugify('memoria de teste do wizard __m21wz')
const ACCT_A = "__m21wz-acct-a";
const ACCT_B = "__m21wz-acct-b";

async function cleanup(): Promise<void> {
  if (!hasDb()) return;
  await wipeBrain(BRAIN);
  const sql = await rawConnect();
  try {
    await sql.unsafe(`delete from galeed_account_brains where brain = $1`, [BRAIN]).catch(() => {});
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** percorre os 4 passos em degrade e devolve o turno de review. fix-2: o passo `sources` é coleção
 *  multi-seleção — texto livre ADICIONA e FICA; só o chip `go` ("Pronto →") avança. */
async function runToReview(): Promise<WizardTurn> {
  let t = await wizardStart();
  t = await wizardReply({ state: t.state, message: "memoria de teste do wizard __m21wz" });
  t = await wizardReply({ state: t.state, message: "clientes, propostas" });
  // sources: texto livre adiciona 2 fontes e PERMANECE no passo;
  t = await wizardReply({ state: t.state, message: "conversas, planilhas-internas" });
  expect(t.state.step).toBe("sources");
  // "Pronto →" avança pro sigilo;
  t = await wizardReply({ state: t.state, message: "Pronto →", action: "go" });
  expect(t.state.step).toBe("sensitivity");
  t = await wizardReply({ state: t.state, message: "tudo interno" });
  return t;
}

beforeAll(cleanup);
afterAll(async () => {
  await cleanup();
  await closeEngines();
  await closeAccounts();
});

describe("M21/S4 — wizardStart + roteiro determinístico (sem DB)", () => {
  it("start: step purpose, pergunta não-vazia, painel vazio com 5 chips (presets de propósito)", async () => {
    const t = await wizardStart();
    expect(t.state.step).toBe("purpose");
    expect(t.question.length).toBeGreaterThan(0);
    expect(t.card).toBe("");
    expect(t.panel.name).toBe("Cérebro sem nome");
    expect(t.panel.status).toBe("se montando…");
    expect(t.suggestions.length).toBe(5); // 5º preset "Estratégia e conhecimento" (cf801e7)
    expect(t.done).toBe(false);
  });

  it("reply avança na ordem fixa (purpose→areas auto; sources só com 'go'), mesmo sem provider", async () => {
    let t = await wizardStart();
    t = await wizardReply({ state: t.state, message: "memoria de teste do wizard __m21wz" });
    expect(t.state.step).toBe("areas");
    expect(t.state.draft.purpose).toBe("memoria de teste do wizard __m21wz");
    expect(t.state.draft.name).toBe(BRAIN);
    t = await wizardReply({ state: t.state, message: "clientes, propostas" });
    expect(t.state.step).toBe("sources");
    expect(t.state.draft.areas).toEqual(["clientes", "propostas"]);
    // fix-2: texto livre no passo sources ADICIONA e PERMANECE (não avança).
    t = await wizardReply({ state: t.state, message: "conversas, planilhas-internas" });
    expect(t.state.step).toBe("sources");
    expect(t.state.draft.sources.length).toBe(2);
    // só "Pronto →" (go) avança.
    t = await wizardReply({ state: t.state, message: "Pronto →", action: "go" });
    expect(t.state.step).toBe("sensitivity");
    t = await wizardReply({ state: t.state, message: "tudo interno" });
    expect(t.state.step).toBe("review");
    // degrade de sigilo = falha-fechado:
    expect(t.state.draft.sensitivity).toBe("restrito");
  });

  it("review: cartão legível SEM JSON; panel.sources[i].fields são labels da receita", async () => {
    const t = await runToReview();
    expect(t.card.length).toBeGreaterThan(0);
    expect(t.card).not.toContain("{");
    expect(t.card).not.toContain('"');
    expect(t.question).toBe("");
    expect(t.panel.status).toBe("pronto pra nascer");
    expect(t.panel.sources.length).toBe(2);
    for (const s of t.panel.sources) {
      expect(s.fields.length).toBeGreaterThan(0);
      for (const f of s.fields) {
        expect(typeof f).toBe("string");
        expect(f).not.toContain("{");
      }
    }
    // regra de ouro presente nas rules do painel:
    expect(t.panel.rules.length).toBe(2);
  });
});

// ----------------------------------------------------------------------------
// fix-2 (HTC do fundador): passo `sources` = COLEÇÃO multi-seleção (toggle+Pronto) e
// correção por texto livre NUNCA é engolida em qualquer passo. Tudo em degrade (sem IA).
// ----------------------------------------------------------------------------

/** chega ao passo `sources` em degrade. */
async function runToSources(): Promise<WizardTurn> {
  let t = await wizardStart();
  t = await wizardReply({ state: t.state, message: "financeiro __m21wz" });
  t = await wizardReply({ state: t.state, message: "faturas, contratos" });
  expect(t.state.step).toBe("sources");
  return t;
}

describe("M21/fix-2 — fontes multi-seleção (toggle+Pronto) + correção sempre respeitada", () => {
  it("passo sources serve chips toggle + 1 chip go ('Pronto →'); suggestions vazio", async () => {
    const t = await runToSources();
    expect(t.suggestions).toEqual([]);
    expect(t.chips.length).toBeGreaterThan(1);
    const go = t.chips.filter((c) => c.kind === "go");
    expect(go.length).toBe(1);
    expect(go[0].label).toContain("Pronto");
    expect(t.chips.filter((c) => c.kind === "toggle").length).toBeGreaterThanOrEqual(5);
  });

  it("clique num chip toggle adiciona a fonte e NÃO avança; chip vem com selected=true", async () => {
    let t = await runToSources();
    t = await wizardReply({ state: t.state, message: "WhatsApp", action: "toggle" });
    expect(t.state.step).toBe("sources"); // não avançou
    expect(t.state.draft.sources.map((s) => s.name)).toContain("WhatsApp");
    const wa = t.chips.find((c) => c.label === "WhatsApp");
    expect(wa?.selected).toBe(true);
  });

  it("toggle de novo no mesmo chip REMOVE a fonte (toggle real)", async () => {
    let t = await runToSources();
    t = await wizardReply({ state: t.state, message: "WhatsApp", action: "toggle" });
    expect(t.state.draft.sources.length).toBe(1);
    t = await wizardReply({ state: t.state, message: "WhatsApp", action: "toggle" });
    expect(t.state.draft.sources.length).toBe(0);
    expect(t.state.step).toBe("sources");
  });

  it("'Pronto →' (go) avança pro sigilo levando as fontes marcadas", async () => {
    let t = await runToSources();
    t = await wizardReply({ state: t.state, message: "WhatsApp", action: "toggle" });
    t = await wizardReply({ state: t.state, message: "Planilhas", action: "toggle" });
    expect(t.state.draft.sources.length).toBe(2);
    t = await wizardReply({ state: t.state, message: "Pronto →", action: "go" });
    expect(t.state.step).toBe("sensitivity");
    expect(t.state.draft.sources.length).toBe(2);
  });

  it("texto livre no passo sources adiciona MÚLTIPLAS fontes de uma frase e PERMANECE no passo", async () => {
    let t = await runToSources();
    t = await wizardReply({
      state: t.state,
      message: "planilhas excel, Conta Azul e e-mail",
    });
    expect(t.state.step).toBe("sources"); // não avançou
    expect(t.state.draft.sources.length).toBeGreaterThanOrEqual(2);
    // a nota confirma o que foi anotado (nunca engole):
    expect(t.question.toLowerCase()).toContain("anotei");
  });

  it("texto livre é CUMULATIVO com os toggles (não substitui)", async () => {
    let t = await runToSources();
    t = await wizardReply({ state: t.state, message: "WhatsApp", action: "toggle" });
    t = await wizardReply({ state: t.state, message: "planilhas e e-mail" });
    const names = t.state.draft.sources.map((s) => s.name.toLowerCase());
    expect(names).toContain("whatsapp");
    expect(t.state.draft.sources.length).toBeGreaterThanOrEqual(3);
  });

  it("CORREÇÃO de fontes no passo SIGILO (caso literal do fundador): adiciona e RE-pergunta sigilo", async () => {
    // WhatsApp via toggle → Pronto → no sigilo manda a frase literal do fundador.
    let t = await runToSources();
    t = await wizardReply({ state: t.state, message: "WhatsApp", action: "toggle" });
    t = await wizardReply({ state: t.state, message: "Pronto →", action: "go" });
    expect(t.state.step).toBe("sensitivity");
    expect(t.state.draft.sources.length).toBe(1);
    t = await wizardReply({
      state: t.state,
      message:
        "Minhas informações não vem apenas do whatsapp. Vem também de planilhas excel, Conta azul(meu ERP) e e-mail",
    });
    // NÃO avançou (não engoliu); adicionou as fontes faltantes:
    expect(t.state.step).toBe("sensitivity");
    expect(t.state.draft.sources.length).toBe(4); // whatsapp + 3 novas
    // respondeu confirmando (nunca silêncio):
    expect(t.question.length).toBeGreaterThan(0);
    expect(t.question.toLowerCase()).toMatch(/adicionei|fonte/);
  });

  it("degrade (sem IA): correção sem fonte identificável NÃO engole — re-pergunta honesto", async () => {
    let t = await runToSources();
    t = await wizardReply({ state: t.state, message: "WhatsApp", action: "toggle" });
    t = await wizardReply({ state: t.state, message: "Pronto →", action: "go" });
    // fala de fonte mas vazio de nomes parseáveis (só a palavra-gatilho) → não avança, responde.
    const before = t.state.draft.sources.length;
    t = await wizardReply({ state: t.state, message: "ah, e tem mais uma fonte por aí" });
    expect(t.state.step).toBe("sensitivity"); // não avançou engolindo
    expect(t.state.draft.sources.length).toBe(before);
    expect(t.question.length).toBeGreaterThan(0); // respondeu (não silêncio)
  });

  it("resposta de sigilo REAL (não fala de fonte) avança normalmente", async () => {
    let t = await runToSources();
    t = await wizardReply({ state: t.state, message: "WhatsApp", action: "toggle" });
    t = await wizardReply({ state: t.state, message: "Pronto →", action: "go" });
    t = await wizardReply({ state: t.state, message: "tudo pode ser interno" });
    expect(t.state.step).toBe("review");
  });

  it("correção de fontes no passo REVIEW também é respeitada (adiciona, fica no review)", async () => {
    let t = await runToReview(); // 2 fontes
    const before = t.state.draft.sources.length;
    t = await wizardReply({ state: t.state, message: "esqueci: também tem planilhas e e-mail" });
    expect(t.state.step).toBe("review");
    expect(t.state.draft.sources.length).toBeGreaterThan(before);
  });
});

describe.skipIf(!hasDb())("M21/S4 — wizardConfirm cria o brain (DB real)", () => {
  it("confirm grava membership + contexto + pack (merge) + fontes; sigilo degradado = restrito", async () => {
    const t = await runToReview();
    const r = await wizardConfirm(ACCT_A, { state: t.state });
    expect(r.brain.id).toBe(BRAIN);
    expect(r.card.length).toBeGreaterThan(0);
    expect(r.card).not.toContain("{");

    expect(await brainExists(BRAIN)).toBe(true);
    const ctx = await getBrainContext(BRAIN);
    expect(ctx.purpose).toBe(t.state.draft.purpose);

    const pack = await loadSchemaPackAsync(BRAIN);
    for (const s of t.state.draft.sources) {
      const dims = pack.extractable[s.type]?.eval_dimensions ?? [];
      for (const f of s.recipe.fields) expect(dims).toContain(f.dimension);
    }

    const e = await getEngine(BRAIN);
    const srcs = await e.listSources();
    expect(srcs.length).toBe(t.state.draft.sources.length);
    for (const s of srcs) {
      expect(SENSITIVITY_LEVELS).toContain(s.default_sensitivity as any);
      expect(s.default_sensitivity).toBe("restrito");
      expect(s.status).toBe("ativa");
    }
  });

  it("colisão de slug (OUTRA conta) → BffError 409 e NADA gravado", async () => {
    const t = await runToReview(); // mesmo slug do teste anterior (já existe)
    const e = await getEngine(BRAIN);
    const before = (await e.listSources()).length;
    let err: any = null;
    try {
      await wizardConfirm(ACCT_B, { state: t.state });
    } catch (x) {
      err = x;
    }
    expect(err).toBeInstanceOf(BffError);
    expect(err.code).toBe(409);
    // nada gravado: nem fonte nova, nem membership da outra conta.
    expect((await e.listSources()).length).toBe(before);
    const sql = await rawConnect();
    try {
      const rows = (await sql.unsafe(
        `select 1 from galeed_account_brains where brain = $1 and account_id = $2`,
        [BRAIN, ACCT_B],
      )) as any[];
      expect(rows.length).toBe(0);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it("confirm sem nome → 400 antes de qualquer escrita", async () => {
    const t = await wizardStart();
    let err: any = null;
    try {
      await wizardConfirm(ACCT_A, { state: t.state });
    } catch (x) {
      err = x;
    }
    expect(err).toBeInstanceOf(BffError);
    expect(err.code).toBe(400);
  });
});
