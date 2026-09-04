/** Tokens OAuth de LLM por brain (ChatGPT/Codex). Lazy DDL — padrão galeed_evolution / github-sync.
 *  Nunca logar o JSON de tokens. */
import { getSharedSql, sharedSqlGeneration } from "./db-conn.ts";

export const CODEX_PROVIDER = "codex";

export interface LlmOauthTokens {
  access_token: string;
  refresh_token: string;
  id_token?: string;
  account_id?: string;
}

export interface LlmOauthRow {
  brain: string;
  provider: string;
  tokens: LlmOauthTokens;
  updatedAt: string | null;
}

let _ready: Promise<void> | null = null;
let _readyGeneration = -1;

async function db(): Promise<any> {
  const sql = await getSharedSql();
  const gen = sharedSqlGeneration();
  if (_ready && _readyGeneration === gen) {
    await _ready;
    return sql;
  }
  _readyGeneration = gen;
  _ready = (async () => {
    await sql.unsafe(`
      create table if not exists galeed_llm_oauth (
        brain text not null,
        provider text not null,
        tokens jsonb not null,
        updated_at timestamptz not null default now(),
        primary key (brain, provider)
      )`);
  })();
  await _ready;
  return sql;
}

function parseTokens(raw: unknown): LlmOauthTokens | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Record<string, unknown>;
  const access = typeof t.access_token === "string" ? t.access_token.trim() : "";
  const refresh = typeof t.refresh_token === "string" ? t.refresh_token.trim() : "";
  if (!access || !refresh) return null;
  return {
    access_token: access,
    refresh_token: refresh,
    id_token: typeof t.id_token === "string" && t.id_token ? t.id_token : undefined,
    account_id: typeof t.account_id === "string" && t.account_id ? t.account_id : undefined,
  };
}

export async function getLlmOauth(brain: string, provider = CODEX_PROVIDER): Promise<LlmOauthRow | null> {
  const sql = await db();
  const rows = (await sql`
    select brain, provider, tokens, updated_at
    from galeed_llm_oauth
    where brain = ${brain} and provider = ${provider}
    limit 1`) as any[];
  if (!rows.length) return null;
  const tokens = parseTokens(rows[0].tokens);
  if (!tokens) return null;
  return {
    brain,
    provider,
    tokens,
    updatedAt: rows[0].updated_at ? String(rows[0].updated_at) : null,
  };
}

/** Fallback single-tenant: uma linha Codex no banco (VPS com um cérebro). */
export async function getUniqueLlmOauth(provider = CODEX_PROVIDER): Promise<LlmOauthRow | null> {
  const sql = await db();
  const rows = (await sql`
    select brain, provider, tokens, updated_at
    from galeed_llm_oauth
    where provider = ${provider}
    limit 2`) as any[];
  if (rows.length !== 1) return null;
  const tokens = parseTokens(rows[0].tokens);
  if (!tokens) return null;
  return {
    brain: String(rows[0].brain),
    provider,
    tokens,
    updatedAt: rows[0].updated_at ? String(rows[0].updated_at) : null,
  };
}

export async function upsertLlmOauth(
  brain: string,
  tokens: LlmOauthTokens,
  provider = CODEX_PROVIDER,
): Promise<void> {
  const sql = await db();
  await sql`
    insert into galeed_llm_oauth (brain, provider, tokens, updated_at)
    values (${brain}, ${provider}, ${sql.json(tokens as any)}, now())
    on conflict (brain, provider) do update set
      tokens = excluded.tokens,
      updated_at = now()`;
}

export async function deleteLlmOauth(brain: string, provider = CODEX_PROVIDER): Promise<void> {
  const sql = await db();
  await sql`delete from galeed_llm_oauth where brain = ${brain} and provider = ${provider}`;
}
