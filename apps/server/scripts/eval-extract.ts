/** EVAL — extrai (LLM via claude CLI) o subconjunto curado e organiza. */
import { getEngine, closeEngines } from "../src/core/platform/engine.ts";
import { extractOne } from "../src/core/extraction/extract.ts";
import { buildIndex } from "../src/core/retrieval/indexer.ts";

const HOME = "eval-a360";
const EXTERNAL_IDS = [
  "transcripts/2025-08-07-028-kelvin-joao.md",
  "transcripts/2025-08-14-035-kelvin-joao.md",
  "transcripts/2025-08-21-042-kelvin-joao.md",
  "transcripts/2025-08-24-045-kelvin-joao.md",
  "transcripts/2025-09-08-053-kelvin-paulo.md",
  "transcripts/2025-12-04-127-caike-kelvin.md",
  "transcripts/2026-03-26-180-kelvin-ronaldo.md",
  "transcripts/2026-04-07-204-a360-sessao-estrategica-matheus-zafred-kelvin-cleto.md",
  "transcripts/2026-04-03-197-onboarding-a360-ezequias-bercy-silva.md",
];

const e: any = await getEngine(HOME);
const t0 = Date.now();
const done: string[] = [];
for (const xid of EXTERNAL_IDS) {
  const rows = await e.sql`select slug from galeed_pages where brain=${HOME} and external_id=${xid}`;
  const slug = rows[0]?.slug;
  if (!slug) { console.error("MISSING", xid); continue; }
  const page = await e.getPage(slug);
  const full = await e.allPages(); // getPage não traz body? garante: pega da lista
  const pg = full.find((p: any) => p.slug === slug) ?? page;
  try {
    const r = await extractOne(HOME, pg);
    done.push(slug);
    console.error(`✓ ${slug} (${(Date.now() - t0) / 1000 | 0}s)`);
  } catch (err) {
    console.error(`✗ ${slug}: ${(err as Error).message}`);
  }
}
console.error("organizando…");
const idx = await buildIndex(HOME);
console.log(JSON.stringify({ extracted: done.length, idx, ms: Date.now() - t0 }));
await closeEngines();
process.exit(0);
