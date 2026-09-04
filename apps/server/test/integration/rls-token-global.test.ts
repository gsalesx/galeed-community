/** INTEGRAÇÃO: o lookup GLOBAL de token do gateway /v1 sob RLS real.
 *
 *  O gateway público (authenticateTokenGlobal) deriva o tenant DO PRÓPRIO token: abre o engine de
 *  bootstrap (brainHome()) e busca o token_hash SEM saber o brain. Sob GALEED_RLS=1 a policy brain_iso
 *  esconderia tokens de OUTROS brains (o token vive no brain do CLIENTE, não no de bootstrap) → 401
 *  falso. O fix é a policy PERMISSIVA de SELECT `token_hash_global_select` em galeed_tokens
 *  (applyPostgresRls): libera a leitura por token_hash SÓ para SELECT; o conteúdo segue isolado.
 *
 *  Este teste PROVA, sob a role NÃO-superuser (GALEED_TEST_ROLE_URL = galeed_app, que NÃO bypassa RLS):
 *   (1) com a policy nova, o lookup global ACHA {brain:A, principal} mesmo conectado no brain de bootstrap;
 *   (2) SEM a policy nova (drop), o MESMO lookup volta vazio → o gateway daria 401 (a policy é necessária);
 *   (3) as tabelas de CONTEÚDO (galeed_pages) seguem isoladas: um SELECT cross-brain volta vazio.
 *
 *  Gate: precisa de Postgres + GALEED_TEST_ROLE_URL (role sem BYPASSRLS) + RLS aplicado (GALEED_RLS=1
 *  ao subir o schema). O dev `galeed` é superuser e BYPASSA RLS — por isso o teste roda QUERIES pela
 *  conexão da role limitada, não pelo engine. */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { hasDb, wipeBrain, rawConnect } from "./helpers/db.ts";
import { getEngine, closeEngines, type PageRow } from "../../src/core/platform/engine.ts";
import { issueToken, hashToken, authenticateTokenGlobal } from "../../src/core/access/principals.ts";
import { brainHome } from "../../src/core/platform/brain.ts";

const A = "__test_tok_a"; // brain do CLIENTE (onde o token é emitido)
const BOOT = brainHome(); // brain de bootstrap (onde authenticateTokenGlobal abre a conexão)
const page = (slug: string): PageRow => ({ slug, type: "notas", title: slug, date: "2026-01-01", path: "", body: `corpo de ${slug}`, content_hash: slug });

describe.skipIf(!hasDb() || !process.env.GALEED_TEST_ROLE_URL)("gateway /v1 — lookup global de token sob RLS (role não-superuser)", () => {
  let sql: any; // conexão da role limitada (galeed_app), conectada no brain de bootstrap
  let token = "";
  let tokenHash = "";

  beforeAll(async () => {
    await wipeBrain(A);
    // semeia no brain A (engine = superuser, bypassa RLS): principal + grant + token + uma página de conteúdo.
    const ea = await getEngine(A);
    await ea.upsertPrincipal({ id: "bot-a", kind: "agent", label: "Bot A", email: "", status: "active" });
    await ea.putGrant({ principal_id: "bot-a", areas: [], sensitivity_max: "restrito", deny_types: [], scope: "read" });
    await ea.upsertPage(page("segredo-de-a"));
    const issued = await issueToken(A, { principalId: "bot-a", label: "gw-test" });
    token = issued.token;
    tokenHash = issued.tokenHash;

    // conexão da role LIMITADA, simulando o que authenticateTokenGlobal faz: ela abre o engine de
    // bootstrap → o GUC galeed.brain dessa conexão = BOOT (NÃO o brain A do token).
    sql = await rawConnect(process.env.GALEED_TEST_ROLE_URL);
    const guc = BOOT.replace(/[^a-zA-Z0-9_-]/g, "");
    await sql.unsafe(`set galeed.brain = '${guc}'`);
  });

  afterAll(async () => {
    await wipeBrain(A);
    if (sql) await sql.end({ timeout: 5 });
    await closeEngines();
  });

  it("(1) com token_hash_global_select, o lookup global ACHA o token do brain A (conectado no bootstrap)", async () => {
    // a query EXATA do tokenByHashGlobal, rodando pela role limitada conectada no brain de bootstrap.
    const rows = await sql.unsafe(
      `select brain, principal_id from galeed_tokens where token_hash = '${tokenHash}' and revoked = false limit 1`,
    );
    expect(rows.length).toBe(1);
    expect(rows[0].brain).toBe(A); // achou o brain do CLIENTE a partir do token, sob RLS
    expect(rows[0].principal_id).toBe("bot-a");
  });

  it("(2) SEM a policy permissiva, o MESMO lookup volta vazio → gateway daria 401 (a policy é necessária)", async () => {
    // dropa só a policy nova; brain_iso continua. (a role não é dona da tabela → o drop roda como
    // superuser numa conexão à parte, depois reaplicamos.)
    const admin = await rawConnect(); // superuser
    try {
      await admin.unsafe(`drop policy if exists token_hash_global_select on galeed_tokens`);
      // mesma query, mesma conexão limitada no brain de bootstrap → agora brain_iso esconde o token de A.
      const blocked = await sql.unsafe(
        `select brain, principal_id from galeed_tokens where token_hash = '${tokenHash}' and revoked = false limit 1`,
      );
      expect(blocked.length).toBe(0); // sem a policy: 401 falso

      // reaplica a policy → o lookup volta a achar (idempotente).
      await admin.unsafe(
        `create policy token_hash_global_select on galeed_tokens as permissive for select using (true)`,
      );
      const restored = await sql.unsafe(
        `select brain, principal_id from galeed_tokens where token_hash = '${tokenHash}' and revoked = false limit 1`,
      );
      expect(restored.length).toBe(1);
      expect(restored[0].brain).toBe(A);
    } finally {
      await admin.end({ timeout: 5 });
    }
  });

  it("(3) conteúdo segue isolado: SELECT cross-brain em galeed_pages volta vazio sob a role limitada", async () => {
    // a página existe (semeada no brain A), mas a conexão está no brain de bootstrap → brain_iso a esconde.
    const rows = await sql.unsafe(`select slug from galeed_pages where slug = 'segredo-de-a'`);
    expect(rows.length).toBe(0); // RLS de conteúdo intacto — a policy de token NÃO afrouxa pages
  });

  it("(4) authenticateTokenGlobal(token) resolve {brain:A, principal} fim-a-fim", async () => {
    const res = await authenticateTokenGlobal(token);
    expect(res).not.toBeNull();
    expect(res!.brain).toBe(A);
    expect(res!.principal.id).toBe("bot-a");
    expect(res!.scope).toBeTruthy();
    // sanidade: o hash exposto é o sha256 do token cru (segredo não reversível).
    expect(hashToken(token)).toBe(tokenHash);
  });
});
