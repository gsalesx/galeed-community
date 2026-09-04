/** EVAL — ingestão em lote multi-fonte dos dados brutos (capture é grátis/sem LLM).
 *  Tagueia `source` por pasta (proveniência), parseia data do frontmatter, externalId=path (idempotência). */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { capture } from "../src/core/ingestion/capture.ts";
import { closeEngines } from "../src/core/platform/engine.ts";

const HOME = process.env.EVAL_BRAIN || "eval-a360";
const ROOT = "docs/dados-brutos-teste";

const SOURCES: { dir: string; source: string }[] = [
  { dir: "transcripts", source: "notetaker" },
  { dir: "transcripts-whatsapp", source: "whatsapp" },
  { dir: "youtube-transcript/transcripts", source: "youtube" },
  { dir: "youtube-transcript/comments", source: "youtube-comments" },
];

function parseDate(text: string): string | undefined {
  const fm = text.match(/^---\n([\s\S]*?)\n---/);
  const blk = fm ? fm[1] : text.slice(0, 600);
  const d =
    blk.match(/^date:\s*["']?(\d{4}-\d{2}-\d{2})/m) ||
    blk.match(/^date_start:\s*["']?(\d{4}-\d{2}-\d{2})/m) ||
    blk.match(/Publicado:\**\s*(\d{4}-\d{2}-\d{2})/);
  return d?.[1];
}

let ok = 0, skip = 0, err = 0, big = 0;
const t0 = Date.now();
const perSource: Record<string, number> = {};

for (const { dir, source } of SOURCES) {
  const abs = join(ROOT, dir);
  let files: string[] = [];
  try { files = readdirSync(abs).filter((f) => f.endsWith(".md")); } catch { continue; }
  for (const f of files) {
    try {
      const text = readFileSync(join(abs, f), "utf8");
      if (text.length > 60000) big++; // flag: vai estourar o truncate(60k) do extract
      const r = await capture({ home: HOME, text, date: parseDate(text), externalId: `${dir}/${f}`, source });
      r.skipped ? skip++ : ok++;
      perSource[source] = (perSource[source] ?? 0) + 1;
    } catch (e) {
      err++;
      console.error(`✗ ${dir}/${f}: ${(e as Error).message}`);
    }
  }
  console.error(`  ${dir}: ${files.length} arquivos`);
}

console.log(JSON.stringify({ brain: HOME, captured: ok, skipped: skip, errors: err, over60k: big, perSource, ms: Date.now() - t0 }));
await closeEngines();
process.exit(0);
