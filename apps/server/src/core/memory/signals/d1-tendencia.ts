/** M24-A · D1 — tendência (OLS) e ruptura (CUSUM nos resíduos) por grupo (entity, predicate,
 *  tier) com ≥ minPontos pontos numéricos datados (valid_from ISO, pós-P1-A). BRIEF §3-D1:
 *  OLS é trivial e suficiente; CUSUM detecta mudança de regime em ~20 linhas, online,
 *  explicável; PELT/Prophet = overkill p/ séries < 100 pontos. Zero LLM. */
import {
  type Signal,
  type SignalConfig,
  type SignalFact,
  type SignalInputs,
  severidade,
} from "./types.ts";

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/** dias desde a época de um ISO date (UTC, determinístico). NaN se inválido. */
export function diaUtc(iso: string): number {
  return Math.round(Date.parse(iso.slice(0, 10) + "T00:00:00Z") / 86400000);
}

/** regressão linear simples. xs/ys mesmo tamanho ≥2. sxx===0 → slope 0 + residuos []. */
export function olsFit(xs: number[], ys: number[]): { slope: number; intercept: number; residuos: number[] } {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; }
  if (sxx === 0) return { slope: 0, intercept: my, residuos: [] };
  const slope = sxy / sxx, intercept = my - slope * mx;
  return { slope, intercept, residuos: xs.map((x, i) => ys[i] - (intercept + slope * x)) };
}

/** CUSUM two-sided sobre os resíduos: slack k=cusumSlack·σ, limiar h=cusumLimiar·σ
 *  (σ = desvio-padrão POPULACIONAL dos resíduos, ÷n). Devolve o índice do 1º ponto que
 *  estoura, ou -1 (sem ruptura; σ===0 → -1). */
export function cusumTripIndex(residuos: number[], cusumSlack: number, cusumLimiar: number): number {
  const n = residuos.length;
  if (!n) return -1;
  const mr = residuos.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(residuos.reduce((a, r) => a + (r - mr) ** 2, 0) / n);
  if (sd === 0) return -1;
  let cp = 0, cn = 0;
  for (let i = 0; i < n; i++) {
    const r = residuos[i];
    cp = Math.max(0, cp + (r - mr) - cusumSlack * sd);
    cn = Math.max(0, cn + (mr - r) - cusumSlack * sd);
    if (cp > cusumLimiar * sd || cn > cusumLimiar * sd) return i;
  }
  return -1;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}/;

/** roda o D1 sobre todos os grupos. Sinais na ordem dos grupos (já determinística do load). */
export function detectTendencia(inputs: SignalInputs, cfg: SignalConfig): Signal[] {
  const out: Signal[] = [];
  for (const g of inputs.grupos) {
    // 1) pontos numéricos datados, dedupe por data (fica o ÚLTIMO na ordem do load).
    const byDate = new Map<string, SignalFact>();
    for (const f of g.facts) {
      if (typeof f.value_num !== "number") continue;
      if (!ISO_DATE.test(f.valid_from)) continue;
      byDate.set(f.valid_from.slice(0, 10), f);
    }
    const pontosFacts = [...byDate.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([, f]) => f);
    const n = pontosFacts.length;

    // 2) guards (qualquer um falha → grupo silencioso).
    if (n < cfg.d1.minPontos) continue;
    const datas = pontosFacts.map((f) => f.valid_from.slice(0, 10));
    const spanDias = diaUtc(datas[n - 1]) - diaUtc(datas[0]);
    if (spanDias < cfg.d1.minSpanDias) continue;
    const first = pontosFacts[0].value_num as number;
    const last = pontosFacts[n - 1].value_num as number;
    if (first === 0) continue;

    // 3) OLS + variação + CUSUM.
    const baseDia = diaUtc(datas[0]);
    const xs = datas.map((d) => diaUtc(d) - baseDia);
    const ys = pontosFacts.map((f) => f.value_num as number);
    const { slope, residuos } = olsFit(xs, ys);
    if (residuos.length === 0) continue; // sxx === 0
    const pctTotal = (last - first) / Math.abs(first) * 100;
    const pctAnualizada = pctTotal * 365 / spanDias;
    const cusumIdx = cusumTripIndex(residuos, cfg.d1.cusumSlack, cfg.d1.cusumLimiar);
    const sigmaResiduos = sigmaPop(residuos);

    // 4) classe + gate de emissão.
    const classe = cusumIdx >= 0 ? "ruptura" : "tendencia";
    if (classe === "tendencia" && Math.abs(pctTotal) < cfg.d1.minPctTotal) continue;

    // 5) efeito.
    const efeitoBase = clamp01(Math.abs(pctTotal) / 100 / cfg.d1.refMudanca);
    const efeito = classe === "ruptura" ? Math.max(efeitoBase, cfg.d1.efeitoRupturaMin) : efeitoBase;

    // 6) numeros.
    const numeros: Record<string, number> = {
      pontos: n,
      spanDias,
      slopePorDia: slope,
      pctTotal,
      pctAnualizada,
      cusumIdx,
      sigmaResiduos,
    };

    // 7) baseFacts (os maxBaseFacts MAIS RECENTES), minConfidence.
    const usados = pontosFacts.slice(Math.max(0, n - cfg.maxBaseFacts));
    const baseFacts = usados.map((f) => ({
      entity: f.entity, predicate: f.predicate, tier: f.tier, valid_from: f.valid_from, source_slug: f.source_slug,
    }));
    const minConfidence = Math.min(...pontosFacts.map((f) => f.confidence));

    // 8) resumo.
    const tierTag = g.tier ? ` [${g.tier}]` : "";
    let resumo = `${g.predicate} de ${g.entity}${tierTag}: ${first} → ${last} (${pctTotal >= 0 ? "+" : ""}${pctTotal.toFixed(1)}% em ${spanDias} dias; slope ${slope.toFixed(2)}/dia)`;
    if (classe === "ruptura") {
      const dataDoPontoCusum = datas[cusumIdx];
      resumo += `; ruptura no ponto ${cusumIdx + 1} de ${n} (~${dataDoPontoCusum})`;
    }

    out.push({
      detector: "d1_tendencia",
      classe,
      efeito,
      severidade: severidade(efeito, cfg),
      entities: [g.entity],
      baseFacts,
      minConfidence,
      numeros,
      janela: { de: datas[0], ate: datas[n - 1] },
      resumo,
    });
  }
  return out;
}

function sigmaPop(residuos: number[]): number {
  const n = residuos.length;
  if (!n) return 0;
  const mr = residuos.reduce((a, b) => a + b, 0) / n;
  return Math.sqrt(residuos.reduce((a, r) => a + (r - mr) ** 2, 0) / n);
}
