/** M11/S1 — FACHADA DE CONTEXTO da ingestão. É o contrato que S2 (motor), S4 (onboarding) e S6
 *  (Ajustes) trocam entre si: TODOS importam `BrainContext`/`getBrainContext` DAQUI, nunca de
 *  `schema-pack.ts` direto. Define O SHAPE do contexto e a precedência de fontes — não traduz pra
 *  linguagem natural (isso é S4/S6) nem embute domínio (ADR-002).
 *
 *  Precedência da fonte do contexto:
 *    banco (galeed_brain_context, editado pelo front S4/S6)  >  pack de env (loadSchemaPack, legado/dev)  >  vazio
 *
 *  Tenant-neutro: brain sem contexto → BrainContext com campos vazios (self.slug=""), NUNCA lança.
 *  Fail-soft: erro de DB/parse degrada pro pack-env e, no limite, pro contexto vazio.
 *
 *  Conexão: usa a pool compartilhada de platform/db-conn.ts, brain-independente na conexão mas escopada
 *  por `brain` na query. NÃO mexe no Engine (dono único, fora do território do S1). A tabela vem da
 *  migração id 13 (migrations.ts); aqui só um `create table if not exists` idempotente no boot lazy,
 *  pra não depender da ordem de execução das migrações do engine. */
import { loadSchemaPack, type Role, type SelfContext, type RoleSpec, type SourceTypeSpec } from "./schema-pack.ts";
import { closeSharedSql, getSharedSql, sharedSqlGeneration } from "../platform/db-conn.ts";

export type { Role, SelfContext, RoleSpec, SourceTypeSpec };

/** Contexto da ingestão de um brain (M11). É o shape que S2/S4/S6 trocam entre si. Tenant-neutro:
 *  brain sem contexto → todos os campos vazios (self.slug=""). NUNCA contém domínio hardcoded. */
export interface BrainContext {
  self: SelfContext; // self.slug "" = não declarado
  purpose: string; // "" = não declarado
  roles: RoleSpec[]; // [] = sem papéis declarados
  sourceTypes: SourceTypeSpec[]; // [] = sem tipos declarados
  version: number; // versão do contexto (sobe a cada save) — base da invalidação de re-extração
}

/** Contexto vazio NOVO (cópia profunda) — tenant-neutro. Função (não const) pra nunca compartilhar
 *  arrays/objetos mutáveis entre brains no cache. */
function freshEmpty(): BrainContext {
  return {
    self: { slug: "", label: "", aliases: [] },
    purpose: "",
    roles: [],
    sourceTypes: [],
    version: 0,
  };
}

const ctxCache = new Map<string, BrainContext>();

// ---------- schema lazy sobre a conexão compartilhada ----------

let _ready: Promise<void> | null = null;
let _readyGeneration = -1;

/** Garante o schema da tabela de contexto sobre a pool compartilhada. Lazy: só toca o banco quando
 *  a primeira operação acontece. Lança se DATABASE_URL ausente — o chamador (getBrainContext) captura
 *  e degrada pro pack-env (fail-soft). */
async function db(): Promise<any> {
  const sql = await getSharedSql();
  const gen = sharedSqlGeneration();
  if (_ready && _readyGeneration === gen) {
    await _ready;
    return sql;
  }
  _readyGeneration = gen;
  _ready = (async () => {
    // idempotente — espelha a migração id 13 (migrations.ts). Boot lazy não depende da ordem do engine.
    await sql.unsafe(`
      create table if not exists galeed_brain_context (
        brain text primary key,
        context_version int default 0,
        context_json jsonb default '{}'::jsonb,
        updated_at timestamptz default now()
      )
    `);
  })();
  await _ready;
  return sql;
}

/** Fecha a conexão (testes / shutdown). No-op se nunca abriu. */
export async function closeBrainContext(): Promise<void> {
  _ready = null;
  _readyGeneration = -1;
  await closeSharedSql();
}

// ---------- persistência ----------

interface ContextRow {
  context: Omit<BrainContext, "version">;
  context_version: number;
}

/** Normaliza um objeto cru (vindo do banco/parse) num contexto SEM version, defensivamente. Garante
 *  que os arrays nunca sejam undefined e que self exista — tenant-neutro, nunca quebra o consumidor. */
function normalizeContext(raw: any): Omit<BrainContext, "version"> {
  const r = raw && typeof raw === "object" ? raw : {};
  const self =
    r.self && typeof r.self === "object" && typeof r.self.slug === "string"
      ? {
          slug: r.self.slug,
          label: String(r.self.label ?? ""),
          aliases: Array.isArray(r.self.aliases) ? r.self.aliases.map(String) : [],
        }
      : { slug: "", label: "", aliases: [] };
  const roles: RoleSpec[] = Array.isArray(r.roles)
    ? r.roles
        .filter((x: any) => x && typeof x.role === "string")
        .map((x: any) => ({
          role: x.role as Role,
          speakers: Array.isArray(x.speakers) ? x.speakers.map(String) : [],
          label: String(x.label ?? ""),
        }))
    : [];
  const sourceTypes: SourceTypeSpec[] = Array.isArray(r.sourceTypes)
    ? r.sourceTypes
        .filter((x: any) => x && typeof x.type === "string")
        .map((x: any) => ({
          type: x.type,
          label: String(x.label ?? ""),
          otherRole: (typeof x.otherRole === "string" ? x.otherRole : "other") as Role,
        }))
    : [];
  return { self, purpose: typeof r.purpose === "string" ? r.purpose : "", roles, sourceTypes };
}

/** Lê a linha de contexto do brain no banco (null se não existe). Pode lançar (sem DB/tabela) — o
 *  chamador degrada. */
async function readContextRow(home: string): Promise<ContextRow | null> {
  const sql = await db();
  const rows = (await sql`
    select context_json, context_version
    from galeed_brain_context
    where brain = ${home}
    limit 1`) as any[];
  if (!rows.length) return null;
  const cj = rows[0].context_json;
  const parsed = typeof cj === "string" ? JSON.parse(cj) : cj; // jsonb costuma vir já parseado
  return {
    context: normalizeContext(parsed),
    context_version: typeof rows[0].context_version === "number" ? rows[0].context_version : Number(rows[0].context_version ?? 0),
  };
}

// ---------- API pública (S2/S4/S6 importam ISTO) ----------

/** Lê o contexto efetivo do brain (banco > pack-env > vazio). Cacheado por brain. NUNCA lança:
 *  erro de DB/parse → degrada p/ pack-env e, no limite, EMPTY_CONTEXT. */
export async function getBrainContext(home: string): Promise<BrainContext> {
  const hit = ctxCache.get(home);
  if (hit) return hit;
  let ctx: BrainContext = freshEmpty();

  // (1) pack de env (legado/dev) — base
  const pack = loadSchemaPack(home);
  if (pack.self || pack.purpose || pack.roles?.length || pack.sourceTypes?.length) {
    ctx = {
      self: pack.self ?? freshEmpty().self,
      purpose: pack.purpose ?? "",
      roles: pack.roles ?? [],
      sourceTypes: pack.sourceTypes ?? [],
      version: 0,
    };
  }

  // (2) banco (front) — SOBREPÕE quando existe linha p/ o brain
  try {
    const row = await readContextRow(home);
    if (row) ctx = { ...row.context, version: row.context_version };
  } catch {
    /* sem DB / sem tabela → fica com o pack-env */
  }

  ctxCache.set(home, ctx);
  return ctx;
}

/** Só a versão (barato; usado pelo S2 na chave de freshness e pelo S6 pra detectar mudança). */
export async function contextVersion(home: string): Promise<number> {
  return (await getBrainContext(home)).version;
}

/** Persiste um contexto novo no banco e BUMPA a versão. Retorna a versão nova. Invalida o cache.
 *  Chamado por S4 (confirmar onboarding) e S6 (salvar Ajustes). Tenant-neutro: grava o que vier,
 *  sem validar domínio. */
export async function saveBrainContext(home: string, ctx: Omit<BrainContext, "version">): Promise<number> {
  const sql = await db();
  const normalized = normalizeContext(ctx);
  const json = JSON.stringify(normalized);
  const rows = (await sql`
    insert into galeed_brain_context (brain, context_version, context_json, updated_at)
    values (${home}, 1, ${json}::jsonb, now())
    on conflict (brain) do update set
      context_version = galeed_brain_context.context_version + 1,
      context_json = excluded.context_json,
      updated_at = now()
    returning context_version`) as any[];
  clearBrainContextCache(home);
  const v = rows.length ? Number(rows[0].context_version) : 1;
  return v;
}

/** Sobe SÓ a versão (sem mudar o conteúdo) — usado se precisar forçar re-extração. Retorna a nova
 *  versão. Se não existe linha, cria uma vazia com version 1. Invalida o cache. */
export async function bumpContextVersion(home: string): Promise<number> {
  const sql = await db();
  const empty = JSON.stringify(normalizeContext({}));
  const rows = (await sql`
    insert into galeed_brain_context (brain, context_version, context_json, updated_at)
    values (${home}, 1, ${empty}::jsonb, now())
    on conflict (brain) do update set
      context_version = galeed_brain_context.context_version + 1,
      updated_at = now()
    returning context_version`) as any[];
  clearBrainContextCache(home);
  return rows.length ? Number(rows[0].context_version) : 1;
}

/** Invalida o cache de contexto de um brain (ou tudo). Chamado internamente nos saves; exportado p/ testes. */
export function clearBrainContextCache(home?: string): void {
  if (home === undefined) ctxCache.clear();
  else ctxCache.delete(home);
}
