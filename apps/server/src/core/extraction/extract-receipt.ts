/** Custo + receipt de extração (M9/S5). Observável, sem teto (decisão 3 do fundador). Persiste via os
 *  métodos de Engine do S1 (putExtractReceipt) — este módulo NÃO toca postgres.ts/migrations.ts.
 *
 *  Adaptado do gbrain `src/core/anthropic-pricing.ts` (ANTHROPIC_PRICING / estimateMaxCostUsd): mesma
 *  fórmula `(tokens / 1M) × rate` por (input,output). A linha haiku do gbrain
 *  (`claude-3-5-haiku-20241022: { input: 0.80, output: 4.00 }`) é a fonte do HAIKU_PRICING_USD_PER_MTOK.
 *  O gate de recall (extract-benchmark.ts) espelha o gate do M6 do Galeed (`eval/golden-a360.json`). */
import { getEngine, type ExtractReceiptRow } from "../platform/engine.ts";

/** Pricing do haiku, USD por 1M tokens. Versionado — atualizar quando a tabela de preço mudar.
 *  (input, output). Referência da pesquisa gbrain: ~$0.013/página. */
export const HAIKU_PRICING_USD_PER_MTOK = { input: 0.8, output: 4.0 } as const;

/** Piso de recall default do gate de extração (gbrain extract-benchmark usa 0.8). Pode ser sobreposto
 *  por `benchmark_min_recall` do pack do tenant ou pela flag `--min-recall`. */
export const DEFAULT_MIN_RECALL = 0.8;

/** Versão do schema do receipt do gate — entra no run_id pra invalidar baseline quando a rubrica muda. */
export const GATE_SCHEMA_VERSION = "v1";

/** Estimativa char-based de tokens (~4 chars/token). Fallback quando o provider não devolve usage.
 *  NOTA (follow-up M10): o toolCall (api) hoje devolve só tu.input, sem usage — por isso a estimativa.
 *  Quando o provider expuser usage real, trocar estimateTokens pela contagem do provider. */
export function estimateTokens(text: string): number {
  return Math.ceil((text || "").length / 4);
}

export function estimateCostUsd(o: { tokensIn: number; tokensOut: number; model?: string }): number {
  const p = HAIKU_PRICING_USD_PER_MTOK; // M9 só mede haiku; model fica registrado no receipt
  return (o.tokensIn * p.input + o.tokensOut * p.output) / 1_000_000;
}

/** Grava o receipt do run (idempotente por run_id no engine do S1). */
export async function writeReceipt(home: string, receipt: ExtractReceiptRow): Promise<void> {
  const e = await getEngine(home);
  await e.putExtractReceipt(receipt);
}

/** Rollup de custo por brain (p/ `extract receipts`). */
export async function receiptsRollup(
  home: string,
): Promise<{ runs: number; cost_usd_total: number; tokens_in_total: number; tokens_out_total: number }> {
  const e = await getEngine(home);
  return e.extractReceiptRollup();
}

/** Handler CLI puro de `extract receipts` (Integrador pluga). Lista os receipts do brain + o rollup. */
export async function extractReceiptsCli(args: { brain: string; limit?: number }): Promise<{ text: string; code: number }> {
  if (!args.brain) {
    return { text: "uso: extract receipts --brain <home> [--limit N]", code: 2 };
  }
  const e = await getEngine(args.brain);
  const rows = await e.extractReceipts(args.limit);
  const roll = await e.extractReceiptRollup();
  const lines: string[] = [];
  lines.push(`# receipts de extração — brain ${args.brain}`);
  lines.push(
    `rollup: ${roll.runs} run(s) | custo total $${roll.cost_usd_total.toFixed(6)} | ` +
      `tokens in ${roll.tokens_in_total} / out ${roll.tokens_out_total}`,
  );
  if (rows.length === 0) {
    lines.push("(sem receipts)");
  } else {
    for (const r of rows) {
      const recall = r.recall == null ? "—" : r.recall.toFixed(3);
      lines.push(
        `- ${r.run_id} | ${r.model} (${r.prompt_version}/${r.schema_version}) | ` +
          `corpus ${r.fixture_corpus || "(prod)"} sha ${r.corpus_sha8} | ` +
          `tokens ${r.tokens_in}/${r.tokens_out} | $${r.cost_usd.toFixed(6)} | recall ${recall}`,
      );
    }
  }
  return { text: lines.join("\n"), code: 0 };
}
