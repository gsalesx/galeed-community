/** SCHEMA-PACK por brain (opcional) — vocabulário de DOMÍNIO/IDIOMA que o `reconcile` pode usar como
 *  ATALHO determinístico barato. O core NUNCA embute vocabulário de negócio: default = VAZIO, e o
 *  comportamento padrão é estrutural (typo/token) + LLM-judge — ambos GERAIS (qualquer idioma/domínio).
 *  Um tenant pluga o seu pack (clínica, jurídico, e-commerce…) ou deixa vazio. Isso é o que evita o
 *  produto nascer amarrado a um único negócio. Ver docs/adr/ADR-002-tenant-neutralidade.md.
 *
 *  Fontes (em ordem): env GALEED_SCHEMA_PACK_<BRAIN> (path) → env GALEED_SCHEMA_PACK (path) → vazio. */
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { resolveTipo } from "../platform/brain.ts";
import { getSharedSql, closeSharedSql, sharedSqlGeneration } from "../platform/db-conn.ts";
// M15/S1 — type-only (erasa em runtime → sem ciclo de import: triage.ts importa o VALOR
// loadSchemaPackAsync daqui; aqui só o TIPO de lá — mesmo padrão de ExtractionUnit entre segment↔extract).
import type { TriageProfile } from "../ingestion/triage.ts";

/** Spec de extração de um tipo de página (M9/S4). Declarado pelo tenant no pack — o core não embute
 *  domínio. Ver docs/adr/ADR-002-tenant-neutralidade.md + ADR-003. */
export interface ExtractableSpec {
  /** caminho RELATIVO ao pack-root do template de prompt editável (ex.: "prompts/extract/call.md"). */
  prompt_template?: string;
  /** M13: conteúdo INLINE da guidance (texto do prompt_template embutido). Self-contained — usado quando
   *  o pack vem do BANCO (sem pack-root pra resolver o caminho). O `pack seed` resolve o arquivo e embute
   *  aqui; `getExtractSchema` prefere isto ao `readPackFile`. Tenant-neutro (texto do tenant, não do core). */
  guidance?: string;
  /** caminho RELATIVO ao pack-root do corpus de fixtures JSONL (ex.: "fixtures/extract/call.jsonl"). */
  fixture_corpus?: string;
  /** dimensões semânticas a extrair p/ este tipo (substitui os `dims` hardcoded do core). */
  eval_dimensions: string[];
  /** piso de recall do gate (S5). Default aplicado pelo S5 = 0.8 quando ausente. */
  benchmark_min_recall?: number;
}

/** Papel semântico de um participante numa fonte (M11). Determina onde o fato ancora:
 *  'self' = o dono do brain (a métrica/oferta dele ancora nele); 'client' = o outro lado
 *  (a métrica DELE ancora no slug do cliente, não no self); 'host'/'participant'/'other' = neutros. */
export type Role = "self" | "client" | "host" | "participant" | "other";

/** Quem é o dono/sujeito recorrente do brain (M11). Tenant declara; core nunca embute. */
export interface SelfContext {
  /** slug canônico curto e estável do dono. É a entity-âncora do self. "" = não declarado. */
  slug: string;
  /** rótulo legível. Só p/ exibição no front; a extração usa o slug. */
  label: string;
  /** apelidos/grafias que se referem ao self. Ajuda o pré-passo de papéis. */
  aliases: string[];
}

/** Um papel declarado pro brain: nome do papel + pistas de quem o ocupa (M11). */
export interface RoleSpec {
  /** papel canônico (Role). */
  role: Role;
  /** nomes/falantes recorrentes que ocupam esse papel. [] = sem pista nominal. */
  speakers: string[];
  /** rótulo legível do papel pro front. Cosmético. */
  label: string;
}

/** Um tipo de fonte significativo + o papel-default de quem NÃO é o self naquela fonte (M11). */
export interface SourceTypeSpec {
  /** chave do tipo (casa com `page.type` / `extractable[type]`). */
  type: string;
  /** rótulo legível. */
  label: string;
  /** papel default do participante que NÃO é o self nesse tipo de fonte. */
  otherRole: Role;
}

export interface SchemaPack {
  /** classes de equivalência de predicado: cada linha são nomes que significam o MESMO atributo. */
  synonymClasses: string[][];
  /** papéis semânticos cujos predicados NUNCA fundem entre si (ex.: gasto ≠ receita ≠ contagem). */
  roleTokens: Record<string, string[]>;
  /** M9/S4: extração por tipo de página. Ausente/{} → core usa o default geral (tenant-neutro). */
  extractable: Record<string, ExtractableSpec>;
  // --- M11 (contexto da ingestão). Ausentes = brain tenant-neutro sem contexto (default). ---
  /** quem é o dono/sujeito recorrente do brain. undefined = não declarado. */
  self?: SelfContext;
  /** "pra que serve este brain" — saliência p/ extração + goal p/ reflect/dream. */
  purpose?: string;
  /** papéis declarados (self/client/host/…) com pistas de falante. */
  roles?: RoleSpec[];
  /** tipos significativos + papel-default do "outro". */
  sourceTypes?: SourceTypeSpec[];
  /** M15/ADR-009 — knobs de triagem por (canal,tipo). OPCIONAL: ausente ⇒ DEFAULT_TRIAGE_PROFILE
   *  (fail-open). DB-native (vive no pack_json, migração 16 — sem migração nova). Chave "default" |
   *  "<canal>:<tipo>". Tenant-neutro: o core não embute perfis; o tenant pluga via `pack seed`. */
  triage?: { profiles?: Record<string, Partial<TriageProfile>> };
}

export const EMPTY_PACK: SchemaPack = {
  synonymClasses: [],
  roleTokens: {},
  extractable: {},
  self: undefined,
  purpose: "",
  roles: [],
  sourceTypes: [],
  triage: undefined,
};

const cache = new Map<string, SchemaPack>();
/** pack-root (diretório do JSON do pack) por brain — p/ resolver `prompt_template`/`fixture_corpus`. */
const rootCache = new Map<string, string | null>();

function readPack(path: string): SchemaPack | null {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return {
      synonymClasses: Array.isArray(raw.synonymClasses) ? raw.synonymClasses : [],
      roleTokens: raw.roleTokens && typeof raw.roleTokens === "object" ? raw.roleTokens : {},
      extractable: raw.extractable && typeof raw.extractable === "object" ? raw.extractable : {},
      // --- M11 (contexto da ingestão) — parsing defensivo; ausente/tipo errado → undefined/[] ---
      self:
        raw.self && typeof raw.self === "object" && typeof raw.self.slug === "string"
          ? {
              slug: raw.self.slug,
              label: String(raw.self.label ?? ""),
              aliases: Array.isArray(raw.self.aliases) ? raw.self.aliases.map(String) : [],
            }
          : undefined,
      purpose: typeof raw.purpose === "string" ? raw.purpose : "",
      roles: Array.isArray(raw.roles)
        ? raw.roles
            .filter((r: any) => r && typeof r.role === "string")
            .map((r: any) => ({
              role: r.role as Role,
              speakers: Array.isArray(r.speakers) ? r.speakers.map(String) : [],
              label: String(r.label ?? ""),
            }))
        : [],
      sourceTypes: Array.isArray(raw.sourceTypes)
        ? raw.sourceTypes
            .filter((t: any) => t && typeof t.type === "string")
            .map((t: any) => ({
              type: t.type,
              label: String(t.label ?? ""),
              otherRole: (typeof t.otherRole === "string" ? t.otherRole : "other") as Role,
            }))
        : [],
      // M15/S1 — parsing DEFENSIVO de triage; ausente/tipo errado → undefined (fail-open → default).
      triage:
        raw.triage &&
        typeof raw.triage === "object" &&
        raw.triage.profiles &&
        typeof raw.triage.profiles === "object"
          ? { profiles: raw.triage.profiles }
          : undefined,
    };
  } catch {
    return null;
  }
}

/** Pack do brain (cacheado, SÍNCRONO). Cache-hit → cache; cache-miss → env → EMPTY_PACK.
 *  NÃO toca o banco (a leitura DB é async, via loadSchemaPackAsync/ensureSchemaPack que populam ESTE
 *  cache). Default VAZIO → core neutro a domínio/idioma. Comportamento byte-idêntico ao pré-M13. */
export function loadSchemaPack(home: string): SchemaPack {
  const hit = cache.get(home);
  if (hit) return hit;
  const envKey = `GALEED_SCHEMA_PACK_${home.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
  const path = process.env[envKey] || process.env.GALEED_SCHEMA_PACK;
  const pack = (path && readPack(path)) || EMPTY_PACK;
  cache.set(home, pack);
  rootCache.set(home, path ? dirname(resolve(path)) : null);
  return pack;
}

/** Lê o conteúdo de um arquivo declarado como caminho RELATIVO ao pack-root (ex.: `prompt_template`).
 *  Tenant-neutro: o core não embute domínio; o TEXTO do template é do tenant. Rejeita traversal/absoluto/
 *  symlink p/ fora do pack-root (mesma postura de scaffold-extractable). Retorna "" se não houver pack,
 *  caminho inválido, ou arquivo ausente — o chamador degrada para o comportamento default. */
export function readPackFile(home: string, relPath: string | undefined): string {
  if (!relPath) return "";
  if (!cache.has(home)) loadSchemaPack(home); // garante rootCache populado
  const root = rootCache.get(home);
  if (!root) return "";
  if (typeof relPath !== "string" || relPath.includes("\0") || isAbsolute(relPath)) return "";
  if (relPath.split(/[\\/]/).some((seg) => seg === "..")) return "";
  const abs = resolve(root, relPath);
  if (abs !== root && !abs.startsWith(root + sep)) return "";
  try {
    return readFileSync(abs, "utf8");
  } catch {
    return "";
  }
}

/** Invalida o cache do pack (M9/S4 + M13). Sem `home` → limpa tudo. As duas faces (síncrona e async)
 *  compartilham ESTE `cache`, logo invalidar aqui afeta ambas. Necessário após o scaffold mutar o JSON
 *  do pack OU após `saveSchemaPack` gravar no banco, senão a versão velha persiste no processo. */
export function clearSchemaPackCache(home?: string): void {
  if (home === undefined) {
    cache.clear();
    rootCache.clear();
  } else {
    cache.delete(home);
    rootCache.delete(home);
  }
}

// =====================================================================================================
// M13/S1 — FACE ASSÍNCRONA (DB-first). Espelha brain-context.ts (M11): precedência banco > pack-env >
// vazio, conexão lazy módulo-local (via db-conn.ts), fail-soft (NUNCA lança). Popula o MESMO `cache` de
// módulo que a face síncrona (loadSchemaPack) lê — é assim que o pack do banco chega ao hot-path
// síncrono sem tornar loadSchemaPack async. SÓ os 3 campos de CONFIG DE EXTRAÇÃO moram no banco; os
// campos de CONTEXTO (self/purpose/roles/sourceTypes) são donos do galeed_brain_context (M11).
// =====================================================================================================

/** Subconjunto do pack que mora no banco (config de EXTRAÇÃO + M15/triage). Os campos de CONTEXTO
 *  (self/purpose/roles/sourceTypes) NÃO entram aqui — são donos do galeed_brain_context (M11).
 *  M15/S1: `triage?` é DB-native (ADR-009) — vive no MESMO pack_json (migração 16, sem migração nova). */
type SchemaPackConfig = Pick<SchemaPack, "synonymClasses" | "roleTokens" | "extractable" | "triage">;

/** Abre a conexão compartilhada e garante o schema da tabela idempotente (espelha a migração id 16).
 *  Boot lazy não depende da ordem de execução das migrações do engine. LANÇA se sem DATABASE_URL — o
 *  chamador degrada (fail-soft). */
async function db(): Promise<any> {
  const sql = await getSharedSql();
  const gen = sharedSqlGeneration();
  if (!_packReady || _packReadyGeneration !== gen) {
    _packReadyGeneration = gen;
    _packReady = (async () => {
      // idempotente — espelha a migração id 16 (migrations.ts).
      await sql.unsafe(`
        create table if not exists galeed_schema_packs (
          brain text primary key,
          pack_version int default 0,
          pack_json jsonb default '{}'::jsonb,
          updated_at timestamptz default now()
        )
      `);
    })();
  }
  await _packReady;
  return sql;
}
let _packReady: Promise<void> | null = null;
let _packReadyGeneration = -1;

/** Normaliza os 3 campos de config defensivamente (MESMA lógica de readPack): array/objeto válido →
 *  valor; senão []/{}. Tenant-neutro, nunca quebra o consumidor. */
function normalizeConfig(raw: any): SchemaPackConfig {
  const r = raw && typeof raw === "object" ? raw : {};
  return {
    synonymClasses: Array.isArray(r.synonymClasses) ? r.synonymClasses : [],
    roleTokens: r.roleTokens && typeof r.roleTokens === "object" ? r.roleTokens : {},
    extractable: r.extractable && typeof r.extractable === "object" ? r.extractable : {},
    // M15/S1 — triage DB-native, parsing defensivo (MESMA lógica de readPack).
    triage:
      r.triage && typeof r.triage === "object" && r.triage.profiles && typeof r.triage.profiles === "object"
        ? { profiles: r.triage.profiles }
        : undefined,
  };
}

interface PackRow {
  config: SchemaPackConfig;
  pack_version: number;
}

/** Lê a linha do pack do brain no banco (null se não existe). Pode lançar (sem DB/tabela) — o
 *  chamador degrada (fail-soft). */
async function readPackRow(home: string): Promise<PackRow | null> {
  const sql = await db();
  const rows = (await sql`
    select pack_json, pack_version
    from galeed_schema_packs
    where brain = ${home}
    limit 1`) as any[];
  if (!rows.length) return null;
  const pj = rows[0].pack_json;
  const parsed = typeof pj === "string" ? JSON.parse(pj) : pj; // jsonb costuma vir já parseado
  return {
    config: normalizeConfig(parsed),
    pack_version:
      typeof rows[0].pack_version === "number" ? rows[0].pack_version : Number(rows[0].pack_version ?? 0),
  };
}

/** Pack do brain DB-FIRST (banco > pack-env > vazio). Normaliza defensivamente, popula o `cache` de
 *  módulo (a face síncrona passa a enxergar o pack do banco), e cacheia por brain. NUNCA lança:
 *  erro de DB/parse → degrada pro pack-env e, no limite, EMPTY_PACK. Espelha getBrainContext. */
export async function loadSchemaPackAsync(home: string): Promise<SchemaPack> {
  // (1) base = env (legado/dev) OU EMPTY_PACK — exatamente o que loadSchemaPack já faz hoje. Reusa o
  //     caminho síncrono pra montar a base + popular rootCache (resolução de prompt_template).
  let pack = loadSchemaPack(home);

  // (2) banco SOBREPÕE os 3 campos de CONFIG quando há linha p/ o brain. Fail-soft.
  try {
    const row = await readPackRow(home);
    if (row) {
      pack = {
        ...pack, // preserva self/purpose/roles/sourceTypes do env
        synonymClasses: row.config.synonymClasses, // banco vence nos campos de config
        roleTokens: row.config.roleTokens,
        extractable: row.config.extractable,
        // M15/S1: triage DB-native — banco vence quando há linha; ausente no row → undefined (default).
        triage: row.config.triage,
      };
    }
  } catch {
    /* sem DB / sem tabela → fica com o env (byte-equivalente ao atual) */
  }

  cache.set(home, pack); // a face SÍNCRONA passa a ver ISTO
  return pack;
}

/** Warm-up: garante que o `cache` de módulo do brain reflete o pack DB-first. Os entrypoints async
 *  (S3) chamam ISTO uma vez ANTES dos consumidores síncronos (loadSchemaPack) rodarem. Idempotente. */
export async function ensureSchemaPack(home: string): Promise<void> {
  await loadSchemaPackAsync(home);
}

/** Persiste a CONFIG do pack (3 campos) no banco e BUMPA a versão. Retorna a versão nova. Invalida o
 *  cache. Chamado por S2 (pack seed). Tenant-neutro: grava o que vier, sem validar domínio. Aceita
 *  Partial — campos ausentes viram vazio ([]/{}). Campos de contexto no input são IGNORADOS. */
export async function saveSchemaPack(home: string, pack: Partial<SchemaPack>): Promise<number> {
  const sql = await db();
  const config: SchemaPackConfig = {
    synonymClasses: Array.isArray(pack.synonymClasses) ? pack.synonymClasses : [],
    roleTokens: pack.roleTokens && typeof pack.roleTokens === "object" ? pack.roleTokens : {},
    extractable: pack.extractable && typeof pack.extractable === "object" ? pack.extractable : {},
    // M15/S1: triage DB-native — só persiste se vier no input (ausente ⇒ undefined → default fail-open).
    triage:
      pack.triage && typeof pack.triage === "object" && pack.triage.profiles
        ? { profiles: pack.triage.profiles }
        : undefined,
  };
  const json = JSON.stringify(config);
  const rows = (await sql`
    insert into galeed_schema_packs (brain, pack_version, pack_json, updated_at)
    values (${home}, 1, ${json}::jsonb, now())
    on conflict (brain) do update set
      pack_version = galeed_schema_packs.pack_version + 1,
      pack_json = excluded.pack_json,
      updated_at = now()
    returning pack_version`) as any[];
  clearSchemaPackCache(home);
  return rows.length ? Number(rows[0].pack_version) : 1;
}

/** Expande cada entry pro PAR de chaves {type CRU, tipo EFETIVO}. capture.ts:36 colapsa type custom
 *  via resolveTipo ('email'/'erp'/'tabela'/'call' → 'notas'), então gravar a receita SÓ sob o cru
 *  deixa a chave que a extração LÊ (getExtractSchema(home, page.type)) sem as dims — a dim vira
 *  fisicamente inemissível e o gate rejeita fora_da_receita ou perde o campo EM SILÊNCIO (a mesma
 *  causa-3 do 09b5e16, reaberta pelos caminhos fora do wizard). O wizardConfirm já fazia esse par
 *  por fora (effectiveExtractType); aqui é o ponto ÚNICO — conserta bff-connectors, ingestors/
 *  deliver e bff-sources de uma vez. Trade-off aceito por construção (igual ao wizard): tipos
 *  custom que colapsam pra 'notas' COMPARTILHAM as dims mergeadas. PURA (testável sem DB). */
export function expandRecipeEntries(
  entries: { type: string; dims: string[] }[],
): { type: string; dims: string[] }[] {
  return entries.flatMap((entry) => {
    if (!entry.type) return [entry]; // type vazio: o loop do merge já ignora — NÃO expandir pra 'notas'
    const eff = resolveTipo(entry.type);
    return eff === entry.type ? [entry] : [entry, { type: eff, dims: entry.dims }];
  });
}

/** M21/fix-1 (ADR-016 "receita ⊆ extractable") — UNIÃO das dims de receita em `extractable[type]`.
 *  Regra de DOMÍNIO única, reusada por bff-wizard (confirm) e bff-sources (create/update): campo de
 *  receita que o pack não declara vira dimensão INCLUÍDA — a receita especializa, nunca forka. Sem
 *  isso a extração nunca emite a dim e 100% do campo vira hipótese `fora_da_receita` (approved=0).
 *  Grava sob o type CRU e TAMBÉM sob o tipo EFETIVO de extração (expandRecipeEntries acima).
 *  Idempotente: todas as dims já declaradas → NÃO grava (versão não bumpa). NUNCA remove dim nem
 *  outro campo do pack (união, não substituição). Retorna true se persistiu mudança. */
export async function mergeRecipeDimsIntoPack(
  home: string,
  entries: { type: string; dims: string[] }[],
): Promise<boolean> {
  const pack = await loadSchemaPackAsync(home);
  const extractable = { ...pack.extractable };
  let changed = false;
  for (const { type, dims } of expandRecipeEntries(entries)) {
    const clean = dims.filter((d) => typeof d === "string" && d.trim());
    if (!type || !clean.length) continue;
    const current = extractable[type]?.eval_dimensions ?? [];
    const merged = [...new Set([...current, ...clean])]; // união preserva a ordem existente
    if (merged.length === current.length) continue; // superset: mesmo tamanho ⇒ nada novo (no-op)
    extractable[type] = { ...(extractable[type] ?? { eval_dimensions: [] }), eval_dimensions: merged };
    changed = true;
  }
  if (!changed) return false;
  await saveSchemaPack(home, {
    synonymClasses: pack.synonymClasses,
    roleTokens: pack.roleTokens,
    extractable,
    triage: pack.triage,
  });
  return true;
}

/** Só a versão do pack no banco (0 se não há linha). Fail-soft: erro de DB → 0. */
export async function schemaPackVersion(home: string): Promise<number> {
  try {
    const row = await readPackRow(home);
    return row ? row.pack_version : 0;
  } catch {
    return 0;
  }
}

/** Fecha a conexão do pack (testes / shutdown). No-op se nunca abriu. */
export async function closeSchemaPackDb(): Promise<void> {
  _packReady = null;
  _packReadyGeneration = -1;
  await closeSharedSql();
}
