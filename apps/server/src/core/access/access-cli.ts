/** M7/R16 — handlers dos comandos de ACESSO & GOVERNANÇA. Puros: sem process.exit, sem console,
 *  sem ler process.argv. Recebem (home, pos, flags) e devolvem um objeto serializável (o cli.ts
 *  imprime). Casca fina sobre principals.ts (S4) / scope.ts (S2) / engine (S1). */
import { getEngine, SENSITIVITY_LEVELS, type PrincipalKind } from "../platform/engine.ts";
import { createPrincipal, setGrant, issueToken, accessTest, hashToken } from "./principals.ts";

type Pos = string[];                 // posicionais (pos[0] = comando; pos[1..] = args)
type Flags = Record<string, string | boolean | undefined>;

const isLevel = (s: string): boolean => (SENSITIVITY_LEVELS as readonly string[]).includes(s);
const csv = (v: string | boolean | undefined): string[] =>
  typeof v === "string" && v.trim() ? v.split(",").map((x) => x.trim()).filter(Boolean) : [];

/** galeed principal add <id> --kind=human|agent --label=... [--email=...] */
export async function cmdPrincipalAdd(home: string, pos: Pos, flags: Flags) {
  const id = pos[1];
  const kind = String(flags.kind ?? "");
  if (!id) return { error: "uso: principal add <id> --kind=human|agent --label=..." };
  if (kind !== "human" && kind !== "agent") return { error: "--kind deve ser human ou agent" };
  const p = await createPrincipal(home, { id, kind: kind as PrincipalKind, label: String(flags.label ?? id), email: flags.email ? String(flags.email) : undefined });
  return { ok: true, principal: p };
}

/** flag booleana FAIL-CLOSED: presença-sem-valor (`--can-ingest`) OU `--can-ingest=true` → true; resto false. */
const flag = (v: string | boolean | undefined): boolean => v === true || v === "true";

/** galeed grant <principalId> --areas=a,b --max=interno [--deny=t1,t2] [--can-ingest] */
export async function cmdGrant(home: string, pos: Pos, flags: Flags) {
  const principalId = pos[1];
  const max = String(flags.max ?? "");
  if (!principalId) return { error: "uso: grant <principalId> --areas=a,b --max=<nivel> [--deny=t1,t2] [--can-ingest]" };
  if (!isLevel(max)) return { error: `--max deve ser um de: ${SENSITIVITY_LEVELS.join(", ")}` };
  const grant = await setGrant(home, {
    principalId, areas: csv(flags.areas), sensitivityMax: max, denyTypes: csv(flags.deny),
    canIngest: flag(flags["can-ingest"]),
  });
  return { ok: true, grant };
}

/** galeed token issue <principalId> [--label=...] → imprime o token CRU UMA vez. */
export async function cmdTokenIssue(home: string, pos: Pos, flags: Flags) {
  const principalId = pos[1];
  if (!principalId) return { error: "uso: token issue <principalId> [--label=...]" };
  const { token, tokenHash } = await issueToken(home, { principalId, label: flags.label ? String(flags.label) : undefined });
  return { ok: true, token, tokenHash, warning: "copie o token AGORA — ele não pode ser recuperado." };
}

/** galeed token revoke <tokenHashOuCru> — aceita o hash; se vier o cru, hasheia. */
export async function cmdTokenRevoke(home: string, pos: Pos, _flags: Flags) {
  const arg = pos[1];
  if (!arg) return { error: "uso: token revoke <tokenHash>" };
  const e = await getEngine(home);
  const tokenHash = arg.includes("_") ? hashToken(arg) : arg; // tolera cru (qualquer prefixo `_…`) ou hash
  await e.revokeToken(tokenHash);
  return { ok: true, revoked: tokenHash };
}

/** galeed principal disable|enable <id> — pos[0] já roteado pelo cli; status vem do comando. */
export async function cmdPrincipalStatus(home: string, pos: Pos, _flags: Flags, status: "active" | "disabled") {
  const id = pos[1];
  if (!id) return { error: "uso: principal disable|enable <id>" };
  const e = await getEngine(home);
  await e.setPrincipalStatus(id, status);
  return { ok: true, id, status };
}

/** galeed area attach <slug> --area=<x> */
export async function cmdAreaAttach(home: string, pos: Pos, flags: Flags) {
  const slug = pos[1]; const area = String(flags.area ?? "");
  if (!slug || !area) return { error: "uso: area attach <slug> --area=<slug-da-area>" };
  const e = await getEngine(home);
  const changed = await e.setArea(slug, area);
  return { ok: true, slug, area, changed };
}

/** galeed area detach <slug> --area=<x> */
export async function cmdAreaDetach(home: string, pos: Pos, flags: Flags) {
  const slug = pos[1]; const area = String(flags.area ?? "");
  if (!slug || !area) return { error: "uso: area detach <slug> --area=<slug-da-area>" };
  const e = await getEngine(home);
  const changed = await e.removeArea(slug, area);
  return { ok: true, slug, area, changed };
}

/** galeed sensitivity set <slug> --level=<nivel> */
export async function cmdSensitivitySet(home: string, pos: Pos, flags: Flags) {
  const slug = pos[1]; const level = String(flags.level ?? "");
  if (!slug) return { error: "uso: sensitivity set <slug> --level=<nivel>" };
  if (!isLevel(level)) return { error: `--level deve ser um de: ${SENSITIVITY_LEVELS.join(", ")}` };
  const e = await getEngine(home);
  await e.setSensitivity(slug, level);
  return { ok: true, slug, level };
}

/** galeed access-test <principalId> — preview do que o grant vê. */
export async function cmdAccessTest(home: string, pos: Pos, _flags: Flags) {
  const principalId = pos[1];
  if (!principalId) return { error: "uso: access-test <principalId>" };
  return { ok: true, ...(await accessTest(home, principalId)) };
}

/** galeed access-log [--principal=<id>] [--limit=N] — trilha de auditoria. */
export async function cmdAccessLog(home: string, pos: Pos, flags: Flags) {
  const limit = flags.limit ? Number(flags.limit) : 20;
  const e = await getEngine(home);
  let rows = await e.recentAccessLog(limit);
  if (flags.principal) rows = rows.filter((r) => r.principal_id === String(flags.principal));
  return { ok: true, entries: rows };
}
