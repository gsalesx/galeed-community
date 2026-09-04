import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { hasDb, wipeBrain } from "./helpers/db.ts";
import { getEngine, closeEngines } from "../../src/core/platform/engine.ts";

const B = "__test_gov_log";

describe.skipIf(!hasDb())("access_log — event/actor (governança)", () => {
  beforeAll(() => wipeBrain(B));
  afterAll(async () => { await wipeBrain(B); await closeEngines(); });

  it("persiste e relê event/actor", async () => {
    const e = await getEngine(B);
    await e.appendAccessLog({ principal_id: "bot-x", query: "chave rotacionada", areas_touched: [], n_returned: 0, event: "token.rotated", actor: "dono@x.com" });
    const rows = await e.recentAccessLog(10);
    const row = rows.find((r) => r.event === "token.rotated");
    expect(row).toBeTruthy();
    expect(row!.actor).toBe("dono@x.com");
    expect(row!.principal_id).toBe("bot-x");
  });

  it("leitura sem event continua funcionando (event/actor nulos)", async () => {
    const e = await getEngine(B);
    await e.appendAccessLog({ principal_id: "bot-x", query: "preço", areas_touched: ["vendas"], n_returned: 3 });
    const rows = await e.recentAccessLog(10);
    const read = rows.find((r) => r.query === "preço");
    expect(read).toBeTruthy();
    expect(read!.event ?? null).toBeNull();
  });
});
