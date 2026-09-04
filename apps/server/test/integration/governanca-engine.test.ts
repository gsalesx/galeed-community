import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { hasDb, wipeBrain } from "./helpers/db.ts";
import { getEngine, closeEngines } from "../../src/core/platform/engine.ts";
import { issueToken } from "../../src/core/access/principals.ts";

const B = "__test_gov_engine";

describe.skipIf(!hasDb())("engine — tokensOf + deletePrincipal", () => {
  beforeAll(() => wipeBrain(B));
  afterAll(async () => { await wipeBrain(B); await closeEngines(); });

  it("tokensOf lista os tokens do principal", async () => {
    const e = await getEngine(B);
    await e.upsertPrincipal({ id: "bot-a", kind: "agent", label: "Bot A", email: "", status: "active" });
    await issueToken(B, { principalId: "bot-a", label: "k1" });
    const toks = await e.tokensOf("bot-a");
    expect(toks.length).toBe(1);
    expect(toks[0].revoked).toBe(false);
    expect(toks[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("deletePrincipal apaga principal + grant + tokens", async () => {
    const e = await getEngine(B);
    await e.upsertPrincipal({ id: "bot-b", kind: "agent", label: "Bot B", email: "", status: "active" });
    await e.putGrant({ principal_id: "bot-b", areas: ["vendas"], sensitivity_max: "interno", deny_types: [], scope: "read" });
    await issueToken(B, { principalId: "bot-b", label: "k" });
    await e.deletePrincipal("bot-b");
    expect(await e.getPrincipal("bot-b")).toBeUndefined();
    expect(await e.getGrant("bot-b")).toBeUndefined();
    expect((await e.tokensOf("bot-b")).length).toBe(0);
  });
});
