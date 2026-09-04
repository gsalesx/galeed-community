/** P0-B (mata C2) — SMOKE de takeover de brain por colisão de nome, via BFF REAL (porta efêmera).
 *  Prova que `POST /api/brains` e o signup recusam (409, mensagem do wizard) um nome de brain que JÁ
 *  existe — defesa contra takeover de tenant. Asserts de VALOR (não só status): a membership NÃO
 *  nasce, a conta órfã NÃO é criada, o caminho feliz segue, e o re-POST do próprio nome também dá 409.
 *
 *  Skip se não houver Postgres (hasDb()). Fixtures sufixadas `p0b-tenant` (3 devs no mesmo banco). */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { hasDb, rawConnect } from "../integration/helpers/db.ts";
import { startSmokeBff, stopBff, bff } from "./helpers/bff.ts";
import { closeEngines } from "../../src/core/platform/engine.ts";

const BRAIN_A = "smoke-a-p0b-tenant"; // brain da vítima
const BRAIN_NEW = "smoke-new-p0b-tenant"; // nome livre (criado e re-disputado no teste)
const EMAIL_A = "owner-a.p0b-tenant@galeed.test";
const EMAIL_B = "owner-b.p0b-tenant@galeed.test";
const EMAIL_FRESH = "fresh.p0b-tenant@galeed.test";
const PASS = "SmokeP0b!tenant";

const COLLISION_MSG = "esse nome de cérebro já existe — escolha outro.";

/** limpa as contas/sessões/memberships do fixture pelos emails + brains (padrão wipeFixture do seed M10). */
async function wipe(): Promise<void> {
  const sql = await rawConnect();
  try {
    const emails = [EMAIL_A, EMAIL_B, EMAIL_FRESH];
    const brains = [BRAIN_A, BRAIN_NEW];
    await sql
      .unsafe(`delete from galeed_sessions where account_id in (select id from galeed_accounts where email = any($1))`, [emails])
      .catch(() => {});
    await sql
      .unsafe(`delete from galeed_account_brains where account_id in (select id from galeed_accounts where email = any($1))`, [emails])
      .catch(() => {});
    // qualquer membership pendurada nos brains do fixture (defesa: nenhum outro tenant usa esses nomes)
    await sql.unsafe(`delete from galeed_account_brains where brain = any($1)`, [brains]).catch(() => {});
    await sql.unsafe(`delete from galeed_accounts where email = any($1)`, [emails]).catch(() => {});
  } finally {
    await sql.end({ timeout: 5 });
  }
}

describe.skipIf(!hasDb())("P0-B smoke — takeover de brain por colisão de nome → 409", () => {
  beforeAll(async () => {
    await wipe();
    await startSmokeBff();
    // conta A é dona do BRAIN_A (a vítima). signup já cria a membership owner.
    const r = await bff("/auth/signup", { method: "POST", body: { name: "Owner A", email: EMAIL_A, password: PASS, brainName: BRAIN_A }, auth: false });
    expect(r.status).toBe(200);
  });

  afterAll(async () => {
    await stopBff();
    await wipe();
    await closeEngines();
  });

  it("takeover via POST /api/brains → 409 e a membership NÃO nasce", async () => {
    // signup da conta B (SEM brainName) — o cookie de sessão de B passa a ser o ativo.
    const b = await bff("/auth/signup", { method: "POST", body: { name: "Owner B", email: EMAIL_B, password: PASS }, auth: false });
    expect(b.status).toBe(200);

    // B tenta roubar o brain de A pelo nome.
    const takeover = await bff("/api/brains", { method: "POST", body: { name: BRAIN_A } });
    expect(takeover.status).toBe(409);
    expect(takeover.json.error).toBe(COLLISION_MSG);

    // a lista de brains de B NÃO contém BRAIN_A — a membership não nasceu.
    const list = await bff("/api/brains", { method: "GET" });
    expect(list.status).toBe(200);
    expect((list.json as Array<{ id: string }>).map((x) => x.id)).not.toContain(BRAIN_A);
  });

  it("takeover via signup → 409 sem conta órfã (login depois → 401)", async () => {
    const dup = await bff("/auth/signup", { method: "POST", body: { name: "Fresh", email: EMAIL_FRESH, password: PASS, brainName: BRAIN_A }, auth: false });
    expect(dup.status).toBe(409);
    expect(dup.json.error).toBe(COLLISION_MSG);

    // a conta NÃO foi criada (guard roda ANTES do insert) → login falha com 401.
    const lg = await bff("/auth/login", { method: "POST", body: { email: EMAIL_FRESH, password: PASS }, auth: false });
    expect(lg.status).toBe(401);
  });

  it("caminho feliz preservado: nome livre → 200; segunda conta no mesmo nome → 409", async () => {
    // conta B cria um brain de nome livre.
    await bff("/auth/login", { method: "POST", body: { email: EMAIL_B, password: PASS }, auth: false });
    const ok = await bff("/api/brains", { method: "POST", body: { name: BRAIN_NEW } });
    expect(ok.status).toBe(200);
    expect(ok.json.id).toBe(BRAIN_NEW);

    // conta A tenta o mesmo nome → 409.
    await bff("/auth/login", { method: "POST", body: { email: EMAIL_A, password: PASS }, auth: false });
    const collide = await bff("/api/brains", { method: "POST", body: { name: BRAIN_NEW } });
    expect(collide.status).toBe(409);
    expect(collide.json.error).toBe(COLLISION_MSG);
  });

  it("re-POST do próprio nome → 409 (semântica nova, espelho do wizard)", async () => {
    await bff("/auth/login", { method: "POST", body: { email: EMAIL_B, password: PASS }, auth: false });
    const re = await bff("/api/brains", { method: "POST", body: { name: BRAIN_NEW } });
    expect(re.status).toBe(409);
    expect(re.json.error).toBe(COLLISION_MSG);
  });
});
