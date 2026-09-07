/** Cadeia ordenada de LLMs por cérebro. Só ids + enabled — sem secrets (chaves continuam no env). */
import { getSharedSql, sharedSqlGeneration } from "./db-conn.ts";

export const LLM_SLOT_IDS = ["chatgpt", "anthropic", "openai", "qwen"] as const;
export type LlmSlotId = (typeof LLM_SLOT_IDS)[number];

export interface LlmChainSlot {
  id: LlmSlotId;
  enabled: boolean;
}

const DEFAULT_SLOTS: LlmChainSlot[] = [
  { id: "chatgpt", enabled: true },
  { id: "anthropic", enabled: true },
  { id: "openai", enabled: true },
  { id: "qwen", enabled: true },
];

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
      create table if not exists galeed_llm_chain (
        brain text primary key,
        slots jsonb not null,
        updated_at timestamptz not null default now()
      )`);
  })();
  await _ready;
  return sql;
}

export function normalizeLlmChain(raw: unknown): LlmChainSlot[] {
  const seen = new Set<LlmSlotId>();
  const out: LlmChainSlot[] = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const id = item && typeof item === "object" ? String((item as { id?: unknown }).id) : "";
      if (!LLM_SLOT_IDS.includes(id as LlmSlotId) || seen.has(id as LlmSlotId)) continue;
      seen.add(id as LlmSlotId);
      const enabled = (item as { enabled?: unknown }).enabled !== false;
      out.push({ id: id as LlmSlotId, enabled });
    }
  }
  for (const d of DEFAULT_SLOTS) {
    if (!seen.has(d.id)) out.push({ ...d });
  }
  return out;
}

export async function getLlmChain(brain: string): Promise<LlmChainSlot[]> {
  if (!brain) return DEFAULT_SLOTS.map((s) => ({ ...s }));
  const sql = await db();
  const rows = (await sql`select slots from galeed_llm_chain where brain = ${brain} limit 1`) as any[];
  if (!rows.length) return DEFAULT_SLOTS.map((s) => ({ ...s }));
  return normalizeLlmChain(rows[0].slots);
}

export async function saveLlmChain(brain: string, slots: unknown): Promise<LlmChainSlot[]> {
  const normalized = normalizeLlmChain(slots);
  const sql = await db();
  await sql`
    insert into galeed_llm_chain (brain, slots, updated_at)
    values (${brain}, ${sql.json(normalized as any)}, now())
    on conflict (brain) do update set slots = excluded.slots, updated_at = now()`;
  return normalized;
}
