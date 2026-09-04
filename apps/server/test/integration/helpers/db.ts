/** Helper dos testes de INTEGRAÇÃO — precisam de um Postgres+pgvector real (docker compose up -d).
 *  Carrega o .env manualmente (vitest não o lê), expõe `hasDb()` p/ gate de skip, e `wipeBrain()`
 *  p/ deixar o brain de teste limpo antes/depois. Usa um brain dedicado e descartável — nunca toca
 *  dados de produção. */
import { readFileSync } from "node:fs";

/** Carrega .env da raiz pro process.env (idempotente). tsx/vitest não fazem isso sozinhos. */
export function loadEnv(): void {
  if (process.env.__GALEED_ENV_LOADED) return;
  try {
    const raw = readFileSync(new URL("../../../.env", import.meta.url), "utf8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (!m || line.trim().startsWith("#")) continue;
      const key = m[1];
      let val = m[2].replace(/^["']|["']$/g, "");
      if (val && process.env[key] === undefined) process.env[key] = val;
    }
  } catch {
    /* sem .env — confia no que já está no ambiente */
  }
  process.env.__GALEED_ENV_LOADED = "1";
}

loadEnv();

export function hasDb(): boolean {
  return !!(process.env.DATABASE_URL || process.env.GALEED_DB_URL || process.env.SUPABASE_DB_URL);
}

/** Conexão crua (mesma config do engine) — p/ teardown e p/ o teste de RLS sob role dedicada. */
export async function rawConnect(url?: string) {
  const postgres = (await import("postgres")).default;
  const u = url || process.env.DATABASE_URL || process.env.GALEED_DB_URL || process.env.SUPABASE_DB_URL!;
  const isLocal = u.includes("localhost") || u.includes("127.0.0.1");
  return postgres(u, {
    prepare: false,
    max: 2,
    idle_timeout: 5,
    connect_timeout: 5,
    ssl: isLocal ? false : "require",
    onnotice: () => {},
  });
}

const BRAIN_TABLES = [
  "galeed_pages", "galeed_extractions", "galeed_facts", "galeed_edges", "galeed_vectors",
  "galeed_reconcile", "galeed_entity_resolve", "galeed_hypotheses", "galeed_reflections",
  "galeed_contradictions", "galeed_eval_golden", "galeed_eval_runs",
  "galeed_principals", "galeed_grants", "galeed_tokens", "galeed_access_log",
  "galeed_extract_receipts", "galeed_llm_usage", "galeed_blobs", "galeed_ingest_jobs",
  "galeed_brain_context", "galeed_schema_packs", "galeed_sources", "galeed_ingest_review",
  "galeed_percepcoes", "galeed_judge_batches",
  "galeed_webhooks", "galeed_webhook_deliveries",
];

/** Apaga TODAS as linhas de um brain de teste (em todas as tabelas que têm coluna `brain`). */
export async function wipeBrain(brain: string): Promise<void> {
  const sql = await rawConnect();
  try {
    for (const t of BRAIN_TABLES) {
      await sql.unsafe(`delete from ${t} where brain = $1`, [brain]).catch(() => {});
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}
