import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { hasDb, wipeBrain, rawConnect } from "./helpers/db.ts";
import { getEngine, closeEngines } from "../../src/core/platform/engine.ts";
import { rbacTokenIssue, rbacTokenRevoke, rbacTokenRotate, rbacPrincipalRemove } from "../../src/connectors/bff/bff-rbac-write.ts";
import { createAccount, accountByEmail, addBrainMembership, brainsOf, closeAccounts } from "../../src/core/access/accounts.ts";

const B = "__test_gov_bff";
const HUMAN_EMAIL = "pessoa@test.gov";
const OWNER_EMAIL = "dono-brain@test.gov";

/** Apaga a conta de teste pelo email (idempotente — no-op se não existir). */
async function wipeTestAccount(email: string): Promise<void> {
  const sql = await rawConnect();
  try {
    const rows = (await sql.unsafe(`select id from galeed_accounts where email = $1`, [email])) as any[];
    if (rows.length > 0) {
      const id = rows[0].id;
      await sql.unsafe(`delete from galeed_account_brains where account_id = $1`, [id]).catch(() => {});
      await sql.unsafe(`delete from galeed_accounts where id = $1`, [id]).catch(() => {});
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

describe.skipIf(!hasDb())("BFF RBAC — rotate + remove + log", () => {
  beforeAll(async () => {
    await wipeBrain(B);
    await wipeTestAccount(HUMAN_EMAIL);
    await wipeTestAccount(OWNER_EMAIL);
    const e = await getEngine(B);
    await e.upsertPrincipal({ id: "agent-bot", kind: "agent", label: "Bot", email: "", status: "active" });
    await e.putGrant({ principal_id: "agent-bot", areas: ["vendas"], sensitivity_max: "interno", deny_types: [], scope: "read" });
  });
  afterAll(async () => {
    await wipeBrain(B);
    await wipeTestAccount(HUMAN_EMAIL);
    await wipeTestAccount(OWNER_EMAIL);
    await closeEngines();
    await closeAccounts();
  });

  it("rotate revoga a chave ativa e emite uma nova", async () => {
    const e = await getEngine(B);
    const issued = await rbacTokenIssue(B, { principalId: "agent-bot" }) as any;
    expect(issued.token).toMatch(/_/);
    const before = (await e.tokensOf("agent-bot")).filter((t) => !t.revoked).length;
    expect(before).toBe(1);

    const rotated = await rbacTokenRotate(B, { principalId: "agent-bot" }, "dono@x.com") as any;
    expect(rotated.token).toMatch(/_/);
    expect(rotated.token).not.toBe(issued.token);
    const active = (await e.tokensOf("agent-bot")).filter((t) => !t.revoked);
    expect(active.length).toBe(1); // exatamente uma ativa (a nova)

    const log = await e.recentAccessLog(10);
    expect(log.some((r) => r.event === "token.rotated" && r.actor === "dono@x.com")).toBe(true);
  });

  it("remove apaga o principal de vez e loga", async () => {
    const e = await getEngine(B);
    const out = await rbacPrincipalRemove(B, { principalId: "agent-bot" }, "dono@x.com") as any;
    expect(out.ok).toBe(true);
    expect(await e.getPrincipal("agent-bot")).toBeUndefined();
    const log = await e.recentAccessLog(10);
    expect(log.some((r) => r.event === "principal.removed")).toBe(true);
  });

  it("remove human principal apaga o principal E o membership do brain, mas preserva a conta global", async () => {
    const e = await getEngine(B);

    // 1. criar principal humano no engine
    await e.upsertPrincipal({ id: "user-pessoa", kind: "human", label: "Pessoa", email: HUMAN_EMAIL, status: "active" });
    await e.putGrant({ principal_id: "user-pessoa", areas: ["publico"], sensitivity_max: "interno", deny_types: [], scope: "read" });

    // 2. criar conta global e adicionar membership ao brain B
    const acc = await createAccount({ name: "Pessoa", email: HUMAN_EMAIL, password: "Senha-Forte-2026!" });
    await addBrainMembership(acc.id, B, "member");

    // 3. sanity: membership existe antes da remoção
    const brainsBefore = await brainsOf(acc.id);
    expect(brainsBefore.some((b) => b.id === B)).toBe(true);

    // 4. remover o principal humano via BFF
    const out = await rbacPrincipalRemove(B, { principalId: "user-pessoa" }, "dono@x.com") as any;
    expect(out.ok).toBe(true);

    // 5. principal apagado do engine (brain-level)
    expect(await e.getPrincipal("user-pessoa")).toBeUndefined();

    // 6. membership do brain removida da conta global
    const brainsAfter = await brainsOf(acc.id);
    expect(brainsAfter.some((b) => b.id === B)).toBe(false);

    // 7. conta global preservada (só o membership foi removido, não a conta em si)
    expect(await accountByEmail(HUMAN_EMAIL)).toBeTruthy();
  });

  it("revokeToken por principalId revoga o(s) token(s) ativo(s) e loga token.revoked", async () => {
    const e = await getEngine(B);

    // 1. criar principal agente limpo para este teste
    await e.upsertPrincipal({ id: "agent-revoke-test", kind: "agent", label: "RevokeBot", email: "", status: "active" });
    await e.putGrant({ principal_id: "agent-revoke-test", areas: ["vendas"], sensitivity_max: "interno", deny_types: [], scope: "read" });

    // 2. emitir token
    await rbacTokenIssue(B, { principalId: "agent-revoke-test" });
    const before = (await e.tokensOf("agent-revoke-test")).filter((t) => !t.revoked);
    expect(before.length).toBe(1);

    // 3. revogar por principalId (não por hash)
    const result = await rbacTokenRevoke(B, { principalId: "agent-revoke-test", actor: "dono@x.com" }) as any;
    expect(result.ok).toBe(true);
    expect(result.principalId).toBe("agent-revoke-test");

    // 4. nenhum token ativo restante
    const after = (await e.tokensOf("agent-revoke-test")).filter((t) => !t.revoked);
    expect(after.length).toBe(0);

    // 5. evento token.revoked no log
    const log = await e.recentAccessLog(20);
    expect(log.some((r) => r.event === "token.revoked" && r.actor === "dono@x.com")).toBe(true);

    // 6. idempotência: revogar sem token ativo não lança
    await expect(rbacTokenRevoke(B, { principalId: "agent-revoke-test", actor: "dono@x.com" })).resolves.toMatchObject({ ok: true });
  });

  it("não permite remover o dono do cérebro (403)", async () => {
    const e = await getEngine(B);

    // 1. criar principal humano com email do dono
    await e.upsertPrincipal({ id: "user-dono", kind: "human", label: "Dono", email: OWNER_EMAIL, status: "active" });
    await e.putGrant({ principal_id: "user-dono", areas: ["publico"], sensitivity_max: "interno", deny_types: [], scope: "read" });

    // 2. criar conta global e adicionar membership como OWNER
    const acc = await createAccount({ name: "Dono", email: OWNER_EMAIL, password: "Senha-Forte-2026!" });
    await addBrainMembership(acc.id, B, "owner");

    // 3. tentar remover o dono deve ser bloqueado com 403
    await expect(rbacPrincipalRemove(B, { principalId: "user-dono" }, "admin@x.com")).rejects.toMatchObject({ code: 403 });

    // 4. principal NÃO pode ter sido removido (nenhuma remoção parcial)
    expect(await e.getPrincipal("user-dono")).toBeTruthy();

    // 5. membership do brain também preservada
    const brains = await brainsOf(acc.id);
    expect(brains.some((b) => b.id === B && b.role === "owner")).toBe(true);
  });
});
