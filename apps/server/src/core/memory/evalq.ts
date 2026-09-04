/** Eval de QUALIDADE de retrieval (M3/S1) — golden-set + P@k/recall/MRR + regressão entre runs.
 *  Determinístico: roda o `retrieve` real e compara o top-k com os slugs esperados. Sem LLM generativo. */
import { retrieve } from "../retrieval/query.ts";
import { getEngine, type GoldenRow, type EvalRunRow } from "../platform/engine.ts";
import { slugify } from "../../lib/slug.ts";
import { hasOpenAIKey } from "../../lib/openai.ts";

export interface EvalReport {
  run: EvalRunRow;
  previous?: EvalRunRow;
  delta?: { p_at_k: number; recall_at_k: number; mrr: number };
}

const qidOf = (query: string) => slugify(query).slice(0, 80);
const norm = (s: string) => s.toLowerCase().trim();

export async function addGolden(home: string, g: { query: string; expected: string[]; note?: string }): Promise<GoldenRow> {
  const row: GoldenRow = { qid: qidOf(g.query), query: g.query, expected: g.expected.map(norm), note: g.note || "" };
  await (await getEngine(home)).putGolden(row);
  return row;
}

export async function seedGolden(home: string, items: { query: string; expected: string[]; note?: string }[]): Promise<number> {
  const e = await getEngine(home);
  for (const it of items) await e.putGolden({ qid: qidOf(it.query), query: it.query, expected: it.expected.map(norm), note: it.note || "" });
  return items.length;
}

export async function runEval(home: string, opts: { k?: number } = {}): Promise<EvalReport> {
  const k = opts.k ?? 6;
  const e = await getEngine(home);
  const golden = await e.allGolden();
  if (!golden.length) throw new Error("golden-set vazio — registre queries com `eval add` antes de `eval run`.");

  const per_query: EvalRunRow["per_query"] = [];
  for (const g of golden) {
    const hits = (await retrieve(home, g.query, k)).map((h) => norm(h.slug));
    const expected = new Set(g.expected);
    const inter = hits.filter((h) => expected.has(h));
    const p = k ? inter.length / k : 0;
    const recall = g.expected.length ? inter.length / g.expected.length : 0;
    let rr = 0;
    for (let i = 0; i < hits.length; i++) if (expected.has(hits[i])) { rr = 1 / (i + 1); break; }
    per_query.push({ qid: g.qid, query: g.query, p, recall, rr, hits });
  }

  const avg = (f: (q: (typeof per_query)[number]) => number) => per_query.reduce((s, q) => s + f(q), 0) / per_query.length;
  const runData = {
    k,
    p_at_k: avg((q) => q.p),
    recall_at_k: avg((q) => q.recall),
    mrr: avg((q) => q.rr),
    n_queries: per_query.length,
    per_query,
    params: { semantic: hasOpenAIKey() ? "on" : "off" },
  };
  const run_id = await e.putEvalRun(runData);
  const runs = await e.lastEvalRuns(2);
  const run = runs.find((r) => r.run_id === run_id) ?? { ...runData, run_id };
  const previous = runs.find((r) => r.run_id !== run_id);
  return buildReport(run, previous);
}

export async function evalReport(home: string): Promise<EvalReport | null> {
  const runs = await (await getEngine(home)).lastEvalRuns(2);
  if (!runs.length) return null;
  return buildReport(runs[0], runs[1]);
}

function buildReport(run: EvalRunRow, previous?: EvalRunRow): EvalReport {
  const delta = previous
    ? { p_at_k: run.p_at_k - previous.p_at_k, recall_at_k: run.recall_at_k - previous.recall_at_k, mrr: run.mrr - previous.mrr }
    : undefined;
  return { run, previous, delta };
}
