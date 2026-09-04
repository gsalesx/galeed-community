/** INTEGRAÇÃO: isolamento multi-tenant — a garantia que torna o produto vendável B2B.
 *  DUAS camadas:
 *   (1) filtro de aplicação por `brain` (SEMPRE ligado): brain A nunca lê linha de brain B. Sempre roda.
 *   (2) RLS real sob role NÃO-superuser (o piso de defesa): só roda se GALEED_TEST_ROLE_URL apontar pra
 *       uma conexão com role limitada — o dev `galeed` é superuser e BYPASSA RLS (ver LEARNINGS).
 *  Precisa de Postgres. */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { hasDb, wipeBrain, rawConnect } from "./helpers/db.ts";
import { getEngine, closeEngines, type PageRow } from "../../src/core/platform/engine.ts";

const A = "__test_iso_a";
const B = "__test_iso_b";
const page = (slug: string): PageRow => ({ slug, type: "notas", title: slug, date: "2026-01-01", path: "", body: `corpo de ${slug}`, content_hash: slug });

describe.skipIf(!hasDb())("isolamento de tenant — camada de aplicação (sempre)", () => {
  beforeAll(async () => {
    await wipeBrain(A);
    await wipeBrain(B);
    const ea = await getEngine(A);
    const eb = await getEngine(B);
    await ea.upsertPage(page("segredo-de-a"));
    await eb.upsertPage(page("segredo-de-b"));
  });

  afterAll(async () => {
    await wipeBrain(A);
    await wipeBrain(B);
    await closeEngines();
  });

  it("allPages de A só vê páginas de A", async () => {
    const ea = await getEngine(A);
    const slugs = (await ea.allPages()).map((p) => p.slug);
    expect(slugs).toContain("segredo-de-a");
    expect(slugs).not.toContain("segredo-de-b");
  });

  it("getPage de A não acessa página de B pelo slug", async () => {
    const ea = await getEngine(A);
    expect(await ea.getPage("segredo-de-b")).toBeUndefined();
  });
});

/** RLS de verdade: sob role limitada (sem BYPASSRLS), uma query sem o GUC galeed.brain correto não
 *  enxerga a linha do outro tenant. Gate: precisa de GALEED_TEST_ROLE_URL (role não-superuser) + as
 *  políticas RLS aplicadas (GALEED_RLS). Documenta a única camada que o teste de app não cobre. */
describe.skipIf(!hasDb() || !process.env.GALEED_TEST_ROLE_URL)("isolamento de tenant — RLS sob role não-superuser", () => {
  let sql: any;
  beforeAll(async () => {
    await wipeBrain(A);
    const e = await getEngine(A);
    await e.upsertPage(page("segredo-de-a"));
    sql = await rawConnect(process.env.GALEED_TEST_ROLE_URL);
  });
  afterAll(async () => {
    await wipeBrain(A);
    if (sql) await sql.end({ timeout: 5 });
    await closeEngines();
  });

  it("com GUC de OUTRO brain, a linha de A não aparece", async () => {
    await sql.unsafe(`set galeed.brain = 'outro_tenant'`);
    const rows = await sql.unsafe(`select slug from galeed_pages where slug = 'segredo-de-a'`);
    expect(rows.length).toBe(0); // RLS bloqueia mesmo com a linha existindo
  });
});
