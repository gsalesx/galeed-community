/** Gate de extração (M9/S5) — espelha o gate do M6. Lê fixtures JSONL, roda a extração, compara
 *  expected vs actual, aplica piso de recall, grava receipt versionado, e regress contra baseline.
 *
 *  Espelha o molde do gate do M6 do Galeed (`eval/golden-a360.json` + `galeed eval run`: golden de
 *  verdade-de-ouro + recall floor + número confiável) aplicado à EXTRAÇÃO. A noção de
 *  `benchmark_min_recall` (default 0.8) e exit 0 PASS / 1 FAIL vem do gbrain
 *  `src/commands/extract-benchmark.ts` (recall-floor por fixture). O regress `--against baseline
 *  --threshold` segue o padrão do gbrain `eval-takes-quality`/`regress`. */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { config } from "../platform/config.ts";
import { type Tool } from "../../lib/anthropic.ts";
import { resolveProvider, structured } from "../../lib/llm.ts";
import { UNTRUSTED_SYS, wrapUntrusted } from "../../lib/prompt-safety.ts";
import { normalizeMetricLabel } from "../../lib/metric-label.ts";
import { getExtractSchema } from "./extractable.ts"; // S4 (com fallback default geral)
import { ensureSchemaPack } from "./schema-pack.ts"; // M13 — warm-up DB-first do pack antes do gate
import { PROMPT_VERSION } from "./extract.ts"; // S1, já exportado
import { anchorRoles } from "./role-anchor.ts"; // M11/S2 — gate roda pela MESMA via context-aware do motor
import type { BrainContext, Role } from "./brain-context.ts";
import { GATE_SCHEMA_VERSION, DEFAULT_MIN_RECALL, estimateTokens, estimateCostUsd, writeReceipt } from "./extract-receipt.ts";

export interface ExpectedClaim {
  entity?: string;
  predicate?: string;
  value_num?: number | null;
  unit?: string;
  period?: string;
  tier?: string;
  valid_from?: string;
}
export interface ExtractFixture {
  fixture_id: string;
  page_body: string;
  expected_claims: ExpectedClaim[];
  notes?: string;
  /** M11: contexto do brain pra ESTA fixture (self/papéis). Ausente → roda SEM contexto (legado). */
  context?: { self?: { slug: string; label?: string; aliases?: string[] }; roles?: { role: string; speakers: string[]; label?: string }[]; purpose?: string };
  /** M11: tipo da fonte p/ resolver otherRole (default = o `type` do CLI). */
  source_type?: string;
}

export interface BenchmarkResult {
  status: "PASS" | "FAIL";
  recall: number; // recall agregado (claims esperados cobertos / total esperado)
  perDim: Record<string, number>; // recall por dimensão/tipo de claim
  perFixture: { fixture_id: string; expected: number; matched: number }[];
  cost_usd: number;
  tokensIn: number;
  tokensOut: number;
  corpus_sha8: string;
  minRecall: number;
}

/** Constrói o tool de extração a partir das dims (espelha `buildTool` de extract.ts — campos tipados
 *  entity/predicate/value_num/unit/period/tier/valid_from). Não importável do extract.ts (privado),
 *  então replicado aqui read-only sobre `getExtractSchema(home, type)`. */
function buildTool(dims: string[], desc: string, guidance = ""): Tool {
  const item = {
    type: "object",
    properties: {
      text: { type: "string", description: "o fato em linguagem natural" },
      context_quote: { type: "string", description: "trecho literal de onde tirou" },
      entity: { type: "string", description: "sujeito canônico do fato em UMA palavra/slug curto e estável (ex.: 'accelera', 'kelvin', 'medicamento-x'). NÃO use a razão social completa nem sufixos ('Accelera 360' → 'accelera'). Vazio se não for afirmação sobre entidade." },
      predicate: { type: "string", description: "a relação/atributo, snake_case estável e GENÉRICO (ex.: 'preco', 'dose', 'status', 'mrr'). NÃO embuta a faixa/tier no predicado ('preço do plano Enterprise' → predicate='preco' + tier='enterprise'). Vazio se não se aplica." },
      value: { type: "string", description: "o valor atual da relação (ex.: 'R$ 2500', 'fechado', 'Joinville')." },
      value_num: { type: "number", description: "o valor NUMÉRICO CRU do claim quando houver número (30000 para 'R$ 30 mil', 0.05 para '5%', 500 para '500 mg'). Omita se não há número." },
      unit: { type: "string", description: "unidade do value_num: 'BRL','USD','pct','people','un','months','days','mg'… Omita se não se aplica." },
      period: { type: "string", description: "periodicidade quando o valor é por período: 'monthly','annual','quarterly','one_time'. Omita se não se aplica." },
      tier: { type: "string", description: "segmento/faixa a que o claim se refere, quando o texto distinguir (ex.: 'enterprise','pro','starter','adulto','pediatrico'). Omita se o claim é único/sem faixa." },
      valid_from: { type: "string", description: "data (YYYY-MM-DD) em que esse valor passou a valer, se o texto disser; senão vazio (usa a data da fonte)." },
    },
    required: ["text"],
    additionalProperties: true,
  };
  const properties: Record<string, unknown> = {};
  for (const d of dims) properties[d] = { type: "array", items: item };
  return {
    name: "registrar_extracao",
    description:
      `Extrai dimensões semânticas de uma ${desc}. Em context_quote cole o trecho literal de onde tirou. ` +
      `Quando um item for uma AFIRMAÇÃO ESTÁVEL sobre uma entidade (um preço, uma dose, um status, uma decisão, um atributo), ` +
      `preencha entity+predicate+value (e valid_from se houver data) para permitir rastrear mudanças ao longo do tempo — ` +
      `use a MESMA grafia de entity/predicate quando for o mesmo assunto, pra o sistema detectar que a pessoa mudou de ideia. ` +
      `Se o item NÃO for uma afirmação sobre entidade (ex.: uma citação solta, uma pergunta em aberto), deixe esses campos vazios. ` +
      `Não invente nada que não esteja no texto.` +
      ` Quando o value for NUMÉRICO, preencha value_num com o número CRU normalizado (30000, não "R$ 30K"; 0.05, não "5%") e unit (BRL/USD/pct/mg/people/…); use period se for por período (monthly/annual). SEPARE a faixa no campo tier (NUNCA no predicado). Exemplos: "Plano Enterprise custa R$ 30 mil/mês" → entity=<empresa-slug>, predicate=preco, value_num=30000, unit=BRL, period=monthly, tier=enterprise. "Pro a R$ 990/mês" → predicate=preco, value_num=990, unit=BRL, period=monthly, tier=pro. "dose adulto 500 mg" → predicate=dose, value_num=500, unit=mg, tier=adulto. "MRR: R$ 50 mil/mês (jan 2026)" → predicate=mrr, value_num=50000, unit=BRL, period=monthly, valid_from=2026-01-01.` +
      ` Regras de qualidade: (1) ATÔMICO — um claim por afirmação. (2) NÃO infle precisão — só ponha value_num/unit se o número estiver no texto. (3) entity em slug curto, predicate genérico, faixa em tier. (4) context_quote = trecho LITERAL.` +
      (guidance ? `\n\nORIENTAÇÃO DO DOMÍNIO (pack do tenant, prioritária p/ ancoragem):\n${guidance}` : ""),
    input_schema: { type: "object", properties, required: dims },
  };
}

/** Lê um corpus JSONL de fixtures. */
function readFixtures(fixturePath: string): { fixtures: ExtractFixture[]; raw: string } {
  const raw = readFileSync(fixturePath, "utf8");
  const fixtures = raw
    .trim()
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as ExtractFixture);
  return { fixtures, raw };
}

/** Achata os arrays de dims de uma saída de extração num único array de claims. */
function flattenActual(out: any, dims: string[]): any[] {
  const all: any[] = [];
  for (const d of dims) if (Array.isArray(out?.[d])) all.push(...out[d]);
  return all;
}

/** Match determinístico: um expected_claim está COBERTO por algum actual? (regra do DESIGN-SPEC §3.1) */
export function claimCovered(expected: ExpectedClaim, actuals: any[]): boolean {
  const eEntity = (expected.entity ?? "").toLowerCase().trim();
  const ePred = normalizeMetricLabel(expected.predicate);
  const eTier = (expected.tier ?? "").toLowerCase().trim();
  const hasValue = expected.value_num != null;
  const eMonth = expected.valid_from ? expected.valid_from.slice(0, 7) : "";
  return actuals.some((a) => {
    const aEntity = (a?.entity ?? "").toLowerCase().trim();
    const aPred = normalizeMetricLabel(a?.predicate);
    if (aEntity !== eEntity) return false;
    if (aPred !== ePred) return false;
    if (hasValue) {
      if (typeof a?.value_num !== "number") return false;
      const tol = Math.max(1, Math.abs(expected.value_num as number) * 0.001);
      if (Math.abs((a.value_num as number) - (expected.value_num as number)) > tol) return false;
      const aTier = (a?.tier ?? "").toLowerCase().trim();
      if (aTier !== eTier) return false;
    }
    if (eMonth) {
      const aFrom = (a?.valid_from ?? "").slice(0, 7);
      if (aFrom !== eMonth) return false;
    }
    return true;
  });
}

/** Roda o gate sobre um corpus de fixtures de UM tipo de página. */
export async function runExtractBenchmark(opts: {
  home: string;
  type: string;
  fixturePath: string;
  minRecall?: number;
}): Promise<BenchmarkResult> {
  const { home, type, fixturePath } = opts;
  await ensureSchemaPack(home); // M13: gate roda contra o pack DB (cobre extractBenchmarkCli + runRegress, que delegam aqui)
  const minRecall = opts.minRecall ?? DEFAULT_MIN_RECALL;
  const { fixtures, raw } = readFixtures(fixturePath);
  const corpus_sha8 = createHash("sha256").update(raw).digest("hex").slice(0, 8);

  const cfg = config(home);
  const provider = resolveProvider(cfg.provider);
  const model = provider === "cli" ? cfg.cliModel : cfg.apiModel;
  const schema = getExtractSchema(home, type);
  const tool = buildTool(schema.dims, schema.desc, schema.guidance);

  let tokensIn = 0;
  let tokensOut = 0;
  let totalExpected = 0;
  let totalMatched = 0;
  const perFixture: { fixture_id: string; expected: number; matched: number }[] = [];
  // perDim: agrupa por predicate canônico do expected; "_nopred" p/ expected sem predicate.
  const dimExpected: Record<string, number> = {};
  const dimMatched: Record<string, number> = {};

  for (const fx of fixtures) {
    // M11/S2: o gate monta o prompt pela MESMA via context-aware do motor (extractOne). Fixture COM
    // `context` → injeta o bloco de papéis (anchorRoles); SEM `context` → ctxBlock="" → prompt
    // byte-idêntico ao legado (wrapUntrusted(page_body)) → o golden M9 roda exatamente como antes.
    let ctxBlock = "";
    if (fx.context && fx.context.self?.slug) {
      const ctx: BrainContext = {
        self: { slug: fx.context.self.slug, label: fx.context.self.label ?? "", aliases: fx.context.self.aliases ?? [] },
        purpose: fx.context.purpose ?? "",
        roles: (fx.context.roles ?? []).map((r) => ({ role: r.role as Role, speakers: r.speakers ?? [], label: r.label ?? "" })),
        sourceTypes: [],
        version: 0,
      };
      ctxBlock = anchorRoles(ctx, fx.page_body, fx.source_type || type, "").block;
    }
    const prompt = `${ctxBlock}${ctxBlock ? "\n\n" : ""}${wrapUntrusted(fx.page_body)}`;
    let out: any = {};
    try {
      out = await structured({
        provider,
        model,
        system: "Você extrai conhecimento estruturado de negócios. Seja fiel ao texto; não invente. " + UNTRUSTED_SYS,
        prompt,
        tool,
        dims: schema.dims,
      });
    } catch {
      out = {};
    }
    const actuals = flattenActual(out, schema.dims);
    tokensIn += estimateTokens(prompt);
    tokensOut += estimateTokens(JSON.stringify(out));

    let matched = 0;
    for (const exp of fx.expected_claims) {
      const dim = normalizeMetricLabel(exp.predicate) || "_nopred";
      dimExpected[dim] = (dimExpected[dim] ?? 0) + 1;
      totalExpected += 1;
      if (claimCovered(exp, actuals)) {
        matched += 1;
        totalMatched += 1;
        dimMatched[dim] = (dimMatched[dim] ?? 0) + 1;
      } else {
        dimMatched[dim] = dimMatched[dim] ?? 0;
      }
    }
    perFixture.push({ fixture_id: fx.fixture_id, expected: fx.expected_claims.length, matched });
  }

  // recall: fixtures com 0 expected (no-claim) não diluem; recall = matched/expected sobre os que têm claim.
  const recall = totalExpected === 0 ? 1 : totalMatched / totalExpected;
  const perDim: Record<string, number> = {};
  for (const d of Object.keys(dimExpected)) {
    perDim[d] = dimExpected[d] === 0 ? 1 : (dimMatched[d] ?? 0) / dimExpected[d];
  }
  const cost_usd = estimateCostUsd({ tokensIn, tokensOut, model });
  const status: "PASS" | "FAIL" = recall >= minRecall ? "PASS" : "FAIL";

  // receipt versionado (idempotente por corpus+schema). Só observável — sem teto.
  await writeReceipt(home, {
    run_id: `${type}-${corpus_sha8}-${GATE_SCHEMA_VERSION}`,
    fixture_corpus: fixturePath,
    model,
    prompt_version: PROMPT_VERSION,
    schema_version: GATE_SCHEMA_VERSION,
    corpus_sha8,
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    cost_usd,
    recall,
    per_dim: perDim,
  });

  return { status, recall, perDim, perFixture, cost_usd, tokensIn, tokensOut, corpus_sha8, minRecall };
}

function renderResult(type: string, fixturePath: string, r: BenchmarkResult): string {
  const lines: string[] = [];
  lines.push(`# extract benchmark — type '${type}' | corpus ${fixturePath} (sha ${r.corpus_sha8})`);
  lines.push(`status: ${r.status} | recall ${r.recall.toFixed(3)} (piso ${r.minRecall.toFixed(2)})`);
  lines.push(`custo: $${r.cost_usd.toFixed(6)} | tokens in ${r.tokensIn} / out ${r.tokensOut}`);
  lines.push("recall por dim:");
  for (const [d, v] of Object.entries(r.perDim)) lines.push(`  - ${d}: ${v.toFixed(3)}`);
  lines.push("por fixture:");
  for (const f of r.perFixture) lines.push(`  - ${f.fixture_id}: ${f.matched}/${f.expected}`);
  return lines.join("\n");
}

/** Handler CLI puro `extract benchmark` (Integrador pluga). Exit: 0 PASS / 1 FAIL / 2 USAGE. */
export async function extractBenchmarkCli(args: {
  brain?: string;
  type?: string;
  corpus?: string;
  minRecall?: number;
  baseline?: string;
}): Promise<{ text: string; code: number }> {
  if (!args.brain || !args.type || !args.corpus) {
    return {
      text: "uso: extract benchmark --brain <home> --type <type> --corpus <fixtures.jsonl> [--min-recall N] [--against baseline.json]",
      code: 2,
    };
  }
  // --against vira regress (compara perDim com baseline salvo).
  if (args.baseline) {
    const reg = await runRegress({
      home: args.brain,
      type: args.type,
      fixturePath: args.corpus,
      baselinePath: args.baseline,
    });
    return { text: reg.text, code: reg.ok ? 0 : 1 };
  }
  const r = await runExtractBenchmark({ home: args.brain, type: args.type, fixturePath: args.corpus, minRecall: args.minRecall });
  return { text: renderResult(args.type, args.corpus, r), code: r.status === "PASS" ? 0 : 1 };
}

/** Salva um baseline `{recall, perDim}` de um run (helper p/ alimentar o regress). */
export function saveBaseline(path: string, r: BenchmarkResult): void {
  writeFileSync(path, JSON.stringify({ recall: r.recall, perDim: r.perDim }, null, 2));
}

/** Regress: roda o gate e compara o recall por dim com um baseline salvo; falha (ok=false) se cair
 *  > threshold em alguma dim. Espelha `regress --against baseline --threshold` do M6. */
export async function runRegress(opts: {
  home: string;
  type: string;
  fixturePath: string;
  baselinePath: string;
  threshold?: number;
}): Promise<{ ok: boolean; drops: { dim: string; before: number; after: number; delta: number }[]; text: string }> {
  const threshold = opts.threshold ?? 0.5; // default igual M6
  const baseline = JSON.parse(readFileSync(opts.baselinePath, "utf8")) as { recall: number; perDim: Record<string, number> };
  const r = await runExtractBenchmark({ home: opts.home, type: opts.type, fixturePath: opts.fixturePath, minRecall: 0 });
  const drops: { dim: string; before: number; after: number; delta: number }[] = [];
  for (const [dim, before] of Object.entries(baseline.perDim ?? {})) {
    const after = r.perDim[dim] ?? 0;
    const delta = after - before;
    if (delta < 0 && Math.abs(delta) > threshold) drops.push({ dim, before, after, delta });
  }
  // queda no recall agregado também conta.
  const aggDelta = r.recall - (baseline.recall ?? 0);
  if (aggDelta < 0 && Math.abs(aggDelta) > threshold) {
    drops.push({ dim: "_aggregate", before: baseline.recall ?? 0, after: r.recall, delta: aggDelta });
  }
  const ok = drops.length === 0;
  const lines: string[] = [];
  lines.push(`# extract regress — type '${opts.type}' vs baseline ${opts.baselinePath} (threshold ${threshold})`);
  lines.push(`recall agora ${r.recall.toFixed(3)} | baseline ${(baseline.recall ?? 0).toFixed(3)}`);
  if (ok) {
    lines.push("OK: nenhuma dim caiu além do threshold.");
  } else {
    lines.push("REGRESSÃO detectada:");
    for (const d of drops) lines.push(`  - ${d.dim}: ${d.before.toFixed(3)} → ${d.after.toFixed(3)} (Δ ${d.delta.toFixed(3)})`);
  }
  return { ok, drops, text: lines.join("\n") };
}

export { GATE_SCHEMA_VERSION, DEFAULT_MIN_RECALL };
