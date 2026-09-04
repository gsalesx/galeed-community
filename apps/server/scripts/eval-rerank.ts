/** EVAL throttled — mede Recall@6/@20/MRR com o reranker ligado, respeitando 3 RPM do tier grátis.
 *  Um processo só (reusa conexão), progresso por query, before/after no fim. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { retrieve } from "../src/core/retrieval/query.ts";
import { closeEngines } from "../src/core/platform/engine.ts";

const HOME = "eval-a360";
// caminho RELATIVO ao arquivo (não ao cwd): `eval/` é sibling de `scripts/` sob apps/server/.
const GOLDEN = fileURLToPath(new URL("../eval/golden-a360.json", import.meta.url));
const golden: { query: string; expected: string[] }[] = JSON.parse(readFileSync(GOLDEN, "utf8"));
const THROTTLE_MS = Number(process.env.EVAL_THROTTLE_MS || 21000); // 3 RPM → 1 req / 20s
const norm = (s: string) => s.toLowerCase().trim();

let r6 = 0, r20 = 0, mrr = 0;
for (let i = 0; i < golden.length; i++) {
  const g = golden[i];
  const exp = new Set(g.expected.map(norm));
  let hits: string[] = [];
  try {
    hits = (await retrieve(HOME, g.query, 20)).map((h) => norm(h.slug));
  } catch (e) {
    console.error(`✗ [${i + 1}/${golden.length}] ${(e as Error).message}`);
  }
  const top6 = hits.slice(0, 6);
  const hit6 = top6.some((h) => exp.has(h));
  const hit20 = hits.some((h) => exp.has(h));
  let rr = 0;
  for (let j = 0; j < hits.length; j++) if (exp.has(hits[j])) { rr = 1 / (j + 1); break; }
  if (hit6) r6++; if (hit20) r20++; mrr += rr;
  const pos = hits.findIndex((h) => exp.has(h));
  console.error(`[${i + 1}/${golden.length}] ${hit6 ? "✓6" : hit20 ? "·20" : "✗ "} rank=${pos < 0 ? "—" : pos + 1}  ${g.query.slice(0, 48)}`);
  if (i < golden.length - 1) await new Promise((r) => setTimeout(r, THROTTLE_MS));
}
const n = golden.length;
console.log(`\nRERANKER ON  →  Recall@6 ${(r6 / n).toFixed(2)} · Recall@20 ${(r20 / n).toFixed(2)} · MRR ${(mrr / n).toFixed(2)}  (n=${n})`);
console.log(`BASELINE     →  Recall@6 0.27 · Recall@20 0.73 · MRR 0.38`);
await closeEngines();
process.exit(0);
