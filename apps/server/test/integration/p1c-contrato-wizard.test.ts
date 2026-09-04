/** P1-C/item 5 — wizard: sigilo POR FONTE + confirm com posse ATÔMICA (advisory lock) +
 *  compensação + id determinístico de fonte. Fecha o TOCTOU residual do P0-B/A9. DB real :5434. */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { hasDb, wipeBrain, rawConnect } from "./helpers/db.ts";
import { wizardConfirm, type WizardState } from "../../src/connectors/bff/bff-wizard.ts";
import { BffError } from "../../src/connectors/bff/bff-common.ts";
import {
  createAccount,
  claimBrainSlug,
  removeBrainOwnership,
  brainExists,
  accountByEmail,
  closeAccounts,
} from "../../src/core/access/accounts.ts";
import { getEngine, closeEngines } from "../../src/core/platform/engine.ts";

const BRAIN = "wiz-p1c-contrato";
const EMAIL_A = "a-p1c-contrato@galeed.test";
const EMAIL_B = "b-p1c-contrato@galeed.test";
const RACE = "race-p1c-contrato";

let savedProvider: string | undefined;

function stateWith(name: string, sources: Array<{ name: string; sens: string }>, globalSens: string): { state: WizardState } {
  return {
    state: {
      step: "review",
      asked: [],
      draft: {
        name,
        label: name,
        purpose: "",
        selfSlug: "",
        selfLabel: "",
        areas: [],
        sensitivity: globalSens,
        sources: sources.map((s) => ({
          name: s.name,
          channel: "upload" as const,
          type: "nota",
          recipe: { fields: [{ dimension: "decisions", label: "Decisões", area: "" }] },
          default_sensitivity: s.sens,
        })),
      },
    },
  };
}

async function cleanAll() {
  await wipeBrain(BRAIN);
  await wipeBrain(RACE);
  const sql = await rawConnect();
  try {
    await sql`delete from galeed_account_brains where brain in (${BRAIN}, ${RACE}, 'wiz-p1c-contrato-fb', 'wiz-p1c-signup-p1c')`;
    await sql`delete from galeed_accounts where email in (${EMAIL_A}, ${EMAIL_B})`;
    await sql`delete from galeed_brain_context where brain in (${BRAIN}, ${RACE})`.catch(() => {});
    await sql`delete from galeed_schema_packs where brain in (${BRAIN}, ${RACE})`.catch(() => {});
    await sql`delete from galeed_sources where brain in (${BRAIN}, ${RACE})`.catch(() => {});
  } finally {
    await sql.end({ timeout: 5 });
  }
}

describe.skipIf(!hasDb())("P1-C item 5 — wizard: sigilo por fonte + posse atômica (DB real)", () => {
  let accA: string;
  let accB: string;

  beforeAll(async () => {
    savedProvider = process.env.GALEED_PROVIDER;
    process.env.GALEED_PROVIDER = ""; // IA do wizard desligada — degrade determinístico
    await cleanAll();
    const a = await createAccount({ name: "A", email: EMAIL_A, password: "pw-p1c-123" });
    const b = await createAccount({ name: "B", email: EMAIL_B, password: "pw-p1c-123" });
    accA = a.id;
    accB = b.id;
  });
  afterAll(async () => {
    if (savedProvider === undefined) delete process.env.GALEED_PROVIDER;
    else process.env.GALEED_PROVIDER = savedProvider;
    await cleanAll();
    await closeEngines();
    await closeAccounts();
  });

  it("1. sigilo POR FONTE chega ao banco (não o global pra ambas)", async () => {
    await wizardConfirm(accA, stateWith(BRAIN, [
      { name: "Planilhas", sens: "secreto" },
      { name: "WhatsApp", sens: "interno" },
    ], "interno"));
    const e = await getEngine(BRAIN);
    const sources = await e.listSources();
    const planilhas = sources.find((s) => s.name === "Planilhas")!;
    const whats = sources.find((s) => s.name === "WhatsApp")!;
    expect(planilhas.default_sensitivity).toBe("secreto");
    expect(whats.default_sensitivity).toBe("interno");
  });

  it("2. fallback falha-fechado: fonte sem sensibilidade + draft sem global → 'restrito'", async () => {
    await wizardConfirm(accA, stateWith("wiz-p1c-contrato-fb", [{ name: "Solta", sens: "" }], ""));
    const e = await getEngine("wiz-p1c-contrato-fb");
    const sources = await e.listSources();
    expect(sources.find((s) => s.name === "Solta")!.default_sensitivity).toBe("restrito");
    await wipeBrain("wiz-p1c-contrato-fb");
  });

  it("3. colisão → 409 com a mensagem do contrato", async () => {
    let err: any;
    try {
      await wizardConfirm(accB, stateWith(BRAIN, [{ name: "X", sens: "interno" }], "interno"));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BffError);
    expect(err.code).toBe(409); // BffError usa `code` (não `status`) — API real (LEARNINGS M17/S4)
    expect(err.message).toBe("esse nome de cérebro já existe — escolha outro.");
  });

  it("4. TOCTOU fechado: 2 claims concorrentes do mesmo slug → exatamente 1 vence, 1 linha no banco", async () => {
    const results = await Promise.allSettled([
      claimBrainSlug(accA, RACE),
      claimBrainSlug(accB, RACE),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);
    const sql = await rawConnect();
    try {
      const rows = (await sql`select 1 from galeed_account_brains where brain = ${RACE}`) as any[];
      expect(rows).toHaveLength(1);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it("5. id determinístico/retry idempotente: re-confirm após compensação → 2 fontes (não 4)", async () => {
    await removeBrainOwnership(accA, BRAIN); // simula retry pós-compensação (posse desfeita)
    await wizardConfirm(accA, stateWith(BRAIN, [
      { name: "Planilhas", sens: "secreto" },
      { name: "WhatsApp", sens: "interno" },
    ], "interno"));
    const e = await getEngine(BRAIN);
    expect(await e.listSources()).toHaveLength(2);
  });

  it("6. compensação: cria posse → remove → brainExists false", async () => {
    const slug = "wiz-p1c-comp";
    await wipeBrain(slug);
    await claimBrainSlug(accA, slug);
    expect(await brainExists(slug)).toBe(true);
    await removeBrainOwnership(accA, slug);
    expect(await brainExists(slug)).toBe(false);
    await wipeBrain(slug);
  });

  it("7. signup sem regressão P0-B: createAccount com brainName colidente lança e NÃO cria a conta", async () => {
    const colEmail = "col-p1c-contrato@galeed.test";
    const sql = await rawConnect();
    try {
      await sql`delete from galeed_accounts where email = ${colEmail}`;
    } finally {
      await sql.end({ timeout: 5 });
    }
    await expect(
      createAccount({ name: "Col", email: colEmail, password: "pw-p1c-123", brainName: BRAIN }),
    ).rejects.toThrow("esse nome de cérebro já existe — escolha outro.");
    expect(await accountByEmail(colEmail)).toBeNull(); // conta NÃO foi criada
  });
});
