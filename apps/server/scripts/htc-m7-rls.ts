/** HTC M7 — prova que a RLS de escopo (scope_area_sens RESTRICTIVE) bloqueia sob role NÃO-superuser.
 *  Brain htc-m7-rls já preparado (produto/interno + vendas/restrito, principal bot-cs grant produto<=interno). */
import postgres from "postgres";
import { applyScopeToSession, resolveScope } from "../src/core/access/scope.ts";
import { closeEngines } from "../src/core/platform/engine.ts";

const B = "htc-m7-rls";

async function main() {
  const scope = await resolveScope(B, "bot-cs");
  console.log("scope", JSON.stringify(scope));
  const sql = postgres(process.env.GALEED_TEST_ROLE_URL!, { prepare: false, max: 2, ssl: false, onnotice: () => {} });
  await sql.begin(async (t) => {
    await t`select set_config('galeed.brain', ${B}, true)`;
    await applyScopeToSession(t as any, scope);
    const rows = (await t`select type, sensitivity, tags from galeed_pages`) as any[];
    console.log("n_rows", rows.length);
    console.log("linhas", JSON.stringify(rows.map((r) => ({ t: r.type, s: r.sensitivity, tags: r.tags }))));
    console.log("rls_so_produto", rows.length > 0 && rows.every((r) => r.type === "produtos"));
    console.log("rls_bloqueia_vendas", !rows.some((r) => JSON.stringify(r.tags || []).includes("area:vendas")));
  });
  await sql.end({ timeout: 5 });
  await closeEngines();
}

main().then(() => process.exit(0)).catch((e) => { console.error("ERRO", e.message); process.exit(1); });
