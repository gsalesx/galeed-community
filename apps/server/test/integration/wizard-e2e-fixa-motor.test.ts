/** FIX-A/BUG 1 — GATE E2E do wizard, fim a fim e determinístico: brain criado via wizard (degrade,
 *  sem IA) → fonte com receita = dims REAIS → captura página real sob a fonte → extração emite
 *  EXATAMENTE as dims que a receita conhece (por construção: o mock devolve claims nas dims do
 *  próprio tool.required) → 0 fora_da_receita → fatos NASCEM. DB real :5434 + llm.ts mocado. */
// IA desligada no wizard (degrade determinístico) + pack-env global isolado ANTES dos imports.
process.env.GALEED_PROVIDER = "";
process.env.GALEED_SCHEMA_PACK = "";

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { hasDb, wipeBrain, rawConnect } from "./helpers/db.ts";

// mock de structured: devolve claims NAS DIMS que o tool.input_schema.required declara (por
// construção — o que o tool emite, a receita conhece) com context_quote verbatim do corpo.
const mock = vi.hoisted(() => ({ tool: null as any, body: "" }));
vi.mock("../../src/lib/llm.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/llm.ts")>();
  return {
    ...actual,
    resolveExtractionProvider: vi.fn(() => "api" as const),
    structured: vi.fn(async (args: any) => {
      mock.tool = args?.tool ?? null;
      const dims: string[] = args?.tool?.input_schema?.required ?? args?.dims ?? [];
      const out: Record<string, any[]> = {};
      // 1 claim REGISTRADO por dim (sem entity/predicate → registrado), com quote verbatim do corpo.
      for (const d of dims) {
        out[d] = [{ text: `observação de ${d}`, context_quote: "Kelvin usa Claude Code no dia a dia da operação" }];
      }
      return out;
    }),
  };
});

import {
  wizardStart,
  wizardReply,
  wizardConfirm,
  effectiveExtractType,
  type WizardTurn,
} from "../../src/connectors/bff/bff-wizard.ts";
import { loadSchemaPackAsync, clearSchemaPackCache } from "../../src/core/extraction/schema-pack.ts";
import { getEngine, closeEngines } from "../../src/core/platform/engine.ts";
import { capture } from "../../src/core/ingestion/capture.ts";
import { extractOne } from "../../src/core/extraction/extract.ts";
import { deriveIncremental } from "../../src/core/retrieval/indexer.ts";
import { closeAccounts } from "../../src/core/access/accounts.ts";

const BRAIN = "wizard-e2e-fixa-motor";
const ACCT = "__wizard-e2e-acct";
// corpo inspirado num transcript real (transcricao-yt/002) — verbatim do quote do mock.
const BODY =
  "Meu setup REAL de IA. Kelvin usa Claude Code no dia a dia da operação. " +
  "Mostro como empreender agora sem ficar procurando nicho perfeito.";

async function cleanup() {
  if (!hasDb()) return;
  await wipeBrain(BRAIN);
  const sql = await rawConnect();
  try {
    await sql.unsafe(`delete from galeed_account_brains where brain = $1`, [BRAIN]).catch(() => {});
  } finally {
    await sql.end({ timeout: 5 });
  }
}

describe.skipIf(!hasDb())("FIX-A/BUG 1 — gate E2E do wizard (DB real, LLM mocado)", () => {
  beforeAll(cleanup);
  afterAll(async () => {
    await cleanup();
    await closeEngines();
    await closeAccounts();
  });

  it("brain do wizard → captura real → extração → 0 fora_da_receita → fatos NASCEM", async () => {
    clearSchemaPackCache();
    // 1. wizard: purpose → areas → sources (toggle 'Calls de vendas') → go → sensitivity → review
    let t: WizardTurn = await wizardStart();
    t = await wizardReply({ state: t.state, message: "wizard e2e fixa motor" }); // purpose (degrade)
    t = await wizardReply({ state: t.state, message: "clientes, vendas" }); // areas
    expect(t.state.step).toBe("sources");
    t = await wizardReply({ state: t.state, message: "Calls de vendas", action: "toggle" });
    expect(t.state.step).toBe("sources");
    t = await wizardReply({ state: t.state, message: "Pronto →", action: "go" });
    expect(t.state.step).toBe("sensitivity");
    t = await wizardReply({ state: t.state, message: "tudo interno" });
    expect(t.state.step).toBe("review");
    // o slug do brain saiu do purpose (degrade) — força o BRAIN conhecido p/ cleanup determinístico.
    t.state.draft.name = BRAIN;
    t.state.draft.label = BRAIN;

    const r = await wizardConfirm(ACCT, { state: t.state });
    expect(r.brain.id).toBe(BRAIN);

    // assert: receita da fonte = DEFAULT_EXTRACT_DIMS; pack tem AMBAS as chaves (source.type E efetiva).
    const e = await getEngine(BRAIN);
    const srcs = await e.listSources();
    expect(srcs.length).toBe(1);
    const source = srcs[0];
    const recipeDims = source.recipe.fields.map((f) => f.dimension);
    // criacao-de-fatos #8: "action_items" entrou no DEFAULT_EXTRACT_DIMS (compromisso é universal).
    expect(recipeDims).toEqual(["facts", "decisions", "action_items", "entities", "open_questions", "quotes"]);

    clearSchemaPackCache();
    const pack = await loadSchemaPackAsync(BRAIN);
    const eff = effectiveExtractType(source.type); // 'calls-de-vendas' → 'notas'
    expect(source.type).toBe("calls-de-vendas");
    expect(eff).toBe("notas");
    expect(pack.extractable[source.type]?.eval_dimensions).toEqual(recipeDims);
    expect(pack.extractable[eff]?.eval_dimensions).toEqual(recipeDims);

    // 2. captura página real sob a fonte (type da fonte + tag src:<id>)
    const cap = await capture({
      home: BRAIN,
      type: source.type,
      title: "transcript 002",
      text: BODY,
      tags: [`src:${source.id}`],
      date: "2026-04-17",
    } as any);
    const slug = (cap as any).slug ?? (cap as any).page?.slug;
    const page = (await e.getPage(slug))!;
    // page.type = funil EFETIVO (resolveTipo) — capture.ts:36
    expect(page.type).toBe(effectiveExtractType(source.type));

    // 3. extração (mock emite claims nas dims do tool.required = o que a receita conhece)
    await extractOne(BRAIN, page);

    // 4. GATE: 0 itens fora_da_receita; extrações aprovadas; fatos NASCEM
    const pend = await e.listReview({ status: "pendente", limit: 999 });
    const foraReceita = pend.filter((p) => p.reason === "fora_da_receita");
    expect(foraReceita.length).toBe(0);

    const ex = await e.getExtraction(slug);
    const totalClaims = Object.values(ex!.extractions ?? {}).reduce((n, arr: any) => n + (Array.isArray(arr) ? arr.length : 0), 0);
    expect(totalClaims).toBeGreaterThan(0);

    const d = await deriveIncremental(BRAIN, [slug]);
    expect(d.facts).toBeGreaterThan(0);

    const sql = await rawConnect();
    try {
      const fc = (await sql.unsafe(`select count(*)::int c from galeed_facts where brain=$1`, [BRAIN])) as any[];
      expect(fc[0].c).toBeGreaterThan(0);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });
});
