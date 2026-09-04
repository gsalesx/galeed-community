/** Schema/migrações/RLS do PostgresEngine.
 *  Responsabilidade isolada para manter `postgres.ts` focado na fachada operacional do Engine. */
import { MIGRATIONS } from "../platform/migrations.ts";

const RLS_TABLES = [
  "galeed_pages",
  "galeed_extractions",
  "galeed_facts",
  "galeed_edges",
  "galeed_vectors",
  "galeed_reconcile",
  "galeed_entity_resolve",
  "galeed_hypotheses",
  "galeed_reflections",
  "galeed_contradictions",
  "galeed_eval_golden",
  "galeed_eval_runs",
  "galeed_principals",
  "galeed_grants",
  "galeed_tokens",
  "galeed_access_log",
  "galeed_sources",
  "galeed_ingest_review",
  "galeed_percepcoes",
] as const;

/** Garante o baseline DB-native, aplica migrações append-only e habilita RLS quando GALEED_RLS=1. */
export async function ensurePostgresSchema(sql: any, dims: number): Promise<void> {
  await sql.unsafe("create extension if not exists vector");
  await sql.unsafe(`
    create table if not exists galeed_pages (
      brain text, slug text, type text, title text, date text, path text, body text,
      content_hash text, external_id text, people jsonb, tags jsonb, extract_version text,
      created_at timestamptz default now(),
      primary key (brain, slug)
    );
    create table if not exists galeed_extractions (
      brain text, source_slug text, type text, date text,
      content_hash text, prompt_version text, extractions jsonb,
      primary key (brain, source_slug)
    );
    create table if not exists galeed_facts (
      id bigserial primary key, brain text, source_slug text, type text, dimension text,
      idx int, text text, quote text, meta jsonb,
      entity text, predicate text, value text,
      valid_from text, valid_to text, confidence real, status text
    );
    create table if not exists galeed_edges (brain text, src text, dst text, kind text, weight real);
    create table if not exists galeed_vectors (
      brain text, hash text, slug text, chunk_idx int, text text, vec vector(${dims}),
      primary key (brain, hash)
    );
    create table if not exists galeed_reconcile (
      brain text, entity text, predicate text, canonical text,
      primary key (brain, entity, predicate)
    );
    create table if not exists galeed_entity_resolve (
      brain text, alias text, canonical text,
      primary key (brain, alias)
    );
    create table if not exists galeed_hypotheses (
      brain text, slug text, a text, b text, shared jsonb, surprise int,
      status text, confidence text, text text,
      primary key (brain, slug)
    );
    create table if not exists galeed_reflections (
      brain text, id bigserial, question text, text text, sources jsonb, created_at timestamptz default now()
    );
    create table if not exists galeed_contradictions (
      brain text, hash text, entity text,
      a_slug text, a_text text, a_value text, a_valid_from text,
      b_slug text, b_text text, b_value text, b_valid_from text,
      rule text, verdict text, severity text, confidence real,
      created_at timestamptz default now(),
      primary key (brain, hash)
    );
    create table if not exists galeed_eval_golden (
      brain text, qid text, query text, expected jsonb, note text,
      created_at timestamptz default now(),
      primary key (brain, qid)
    );
    create table if not exists galeed_eval_runs (
      brain text, run_id bigserial, k int,
      p_at_k real, recall_at_k real, mrr real, n_queries int,
      per_query jsonb, params jsonb,
      created_at timestamptz default now()
    );
    create table if not exists galeed_sources (
      brain text not null,
      id text not null,
      name text not null,
      channel text not null default 'upload',
      type text not null default '',
      recipe jsonb not null default '{"fields":[]}'::jsonb,
      default_sensitivity text not null default 'restrito',
      status text not null default 'ativa',
      last_read_at timestamptz,
      created_at timestamptz default now(),
      primary key (brain, id)
    );
    create table if not exists galeed_ingest_review (
      brain text not null,
      id text not null,
      source_id text not null default '',
      source_slug text not null,
      dimension text not null default '',
      text text not null default '',
      quote text not null default '',
      claim jsonb not null default '{}'::jsonb,
      reason text not null,
      status text not null default 'pendente',
      decided_by text not null default '',
      created_at timestamptz default now(),
      decided_at timestamptz,
      primary key (brain, id)
    );
  `);
  await sql.unsafe(
    "create index if not exists galeed_ingest_review_status on galeed_ingest_review(brain, status, created_at desc)",
  );
  await sql.unsafe("alter table galeed_facts add column if not exists source_id text not null default ''");
  await sql.unsafe("create index if not exists galeed_facts_source_id on galeed_facts(brain, source_id)");
  await sql.unsafe("create index if not exists galeed_contradictions_entity on galeed_contradictions(brain, entity)");

  await sql.unsafe(`
    alter table galeed_pages add column if not exists content_hash text;
    alter table galeed_pages add column if not exists external_id text;
    alter table galeed_pages add column if not exists people jsonb;
    alter table galeed_pages add column if not exists tags jsonb;
    alter table galeed_pages add column if not exists extract_version text;
    alter table galeed_pages add column if not exists reflected boolean default false;
    alter table galeed_pages add column if not exists archived boolean default false;
    alter table galeed_pages add column if not exists synopsis text;
    alter table galeed_pages add column if not exists synopsis_hash text;
    alter table galeed_pages add column if not exists salience real default 0;
    alter table galeed_pages add column if not exists created_at timestamptz default now();
  `);

  await sql.unsafe(
    "alter table galeed_pages add column if not exists fts tsvector " +
      "generated always as (to_tsvector('portuguese', coalesce(title,'') || ' ' || coalesce(body,''))) stored",
  );
  await sql.unsafe("create index if not exists galeed_pages_fts on galeed_pages using gin(fts)");
  await sql.unsafe("create index if not exists galeed_pages_extid on galeed_pages(brain, external_id)");
  await sql.unsafe("create index if not exists galeed_facts_dim on galeed_facts(brain, dimension)");
  await sql.unsafe("create index if not exists galeed_facts_entity on galeed_facts(brain, entity, predicate)");
  await sql.unsafe("create index if not exists galeed_edges_src on galeed_edges(brain, src)");
  await sql.unsafe("create index if not exists galeed_edges_dst on galeed_edges(brain, dst)");

  try {
    await sql.unsafe("create index if not exists galeed_vectors_vec on galeed_vectors using hnsw (vec vector_cosine_ops)");
  } catch {
    try {
      await sql.unsafe(
        "create index if not exists galeed_vectors_vec on galeed_vectors using ivfflat (vec vector_cosine_ops) with (lists = 100)",
      );
    } catch {
      /* sem índice ANN: a busca ainda funciona (seq scan), só mais lenta */
    }
  }

  await runPostgresMigrations(sql);
  // galeed_ingest_jobs nasce na migração 15 (não no baseline) → o alter lazy roda DEPOIS das migrações.
  await sql.unsafe("alter table galeed_ingest_jobs add column if not exists source_id text");
  if (process.env.GALEED_RLS) await applyPostgresRls(sql);
}

/** Aplica as migrações pendentes (MIGRATIONS) idempotentemente. `galeed_migrations` é estado global. */
async function runPostgresMigrations(sql: any): Promise<void> {
  await sql`create table if not exists galeed_migrations (
    id int primary key, name text, applied_at timestamptz default now())`;
  const done = new Set<number>(((await sql`select id from galeed_migrations`) as any[]).map((r) => r.id));
  for (const m of MIGRATIONS) {
    if (done.has(m.id)) continue;
    await sql.unsafe(m.sql);
    await sql`insert into galeed_migrations (id, name) values (${m.id}, ${m.name})
              on conflict (id) do nothing`;
  }
}

/** RLS: defesa em profundidade contra vazamento cross-tenant e escopo de área/sensibilidade. */
async function applyPostgresRls(sql: any): Promise<void> {
  for (const t of RLS_TABLES) {
    await sql.unsafe(`alter table ${t} enable row level security`);
    await sql.unsafe(`alter table ${t} force row level security`);
    await sql.unsafe(`drop policy if exists brain_iso on ${t}`);
    await sql.unsafe(
      `create policy brain_iso on ${t} using (brain = current_setting('galeed.brain', true)) with check (brain = current_setting('galeed.brain', true))`,
    );
  }
  // GATEWAY /v1 — lookup GLOBAL de token (authenticateTokenGlobal): o gateway público deriva o tenant
  // DO PRÓPRIO token (sha256), abrindo o engine de bootstrap (brainHome()) e buscando o token_hash SEM
  // saber o brain. Sob brain_iso isso retornaria vazio (o token vive no brain do cliente, não no de
  // bootstrap) → 401 falso. Special-case: uma policy PERMISSIVA de SELECT só na galeed_tokens.
  // Sob FORCE RLS, duas policies PERMISSIVE de SELECT são OR → a leitura por token_hash fica global,
  // mas SÓ para SELECT; brain_iso continua governando INSERT/UPDATE/DELETE (emissão/revogação seguem
  // presas ao brain da conexão).
  // POR QUE É SEGURO: token_hash = sha256(32 bytes aleatórios) (principals.ts:48-49) → segredo não
  // reversível; só vaza se você já tem o token cru (e aí já está autenticado). A tabela só guarda
  // metadados de baixa sensibilidade {brain, principal_id, token_hash, label, last_used_at, revoked}
  // — nada de conteúdo. As tabelas de CONTEÚDO (pages/facts/grants/vectors/...) mantêm brain_iso
  // intacto → o isolamento de tenant do que importa NÃO é afrouxado. Necessária para o gateway público.
  // TRADE-OFF HONESTO: `using(true)` torna ESSES metadados (hashes, label, principal_id de TODOS os
  // brains) enumeráveis por qualquer conexão app com SQL cru — meta-vazamento, não credencial. É
  // INALCANÇÁVEL pela borda /v1 (o gateway só busca por token_hash=$1; cliente público nunca tem SQL
  // cru). Só importaria se outra superfície desse SQL arbitrário ao tenant. A alternativa mais apertada
  // (SECURITY DEFINER que retorna só a linha do hash exato) exige role BYPASSRLS sob FORCE RLS — mais
  // infra; ficou como opção futura se a enumerabilidade virar preocupação real.
  await sql.unsafe(`drop policy if exists token_hash_global_select on galeed_tokens`);
  await sql.unsafe(
    `create policy token_hash_global_select on galeed_tokens as permissive for select using (true)`,
  );
  await sql.unsafe(`drop policy if exists scope_area_sens on galeed_pages`);
  await sql.unsafe(`create policy scope_area_sens on galeed_pages as restrictive using (
    brain = current_setting('galeed.brain', true)
    and (
      current_setting('galeed.area_scope', true) is null
      or galeed_in_area_scope(tags, current_setting('galeed.area_scope', true))
    )
    and (
      current_setting('galeed.sensitivity_max', true) is null
      or galeed_sensitivity_ok(coalesce(sensitivity,'restrito'), current_setting('galeed.sensitivity_max', true))
    )
  )`);
}
