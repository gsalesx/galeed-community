/** M24-A · D2 — silêncio/ausência por entidade (BRIEF §3-D2): modela o intervalo entre
 *  eventos com MEDIANA + MAD (robusto; nada de média/σ em dados de PME) e flag quando o gap
 *  atual estoura. Eventos de uma entidade = datas (YYYY-MM-DD) distintas de TODAS as versões
 *  de fatos da entidade (valid_from) ∪ datas das páginas-fonte desses fatos (pageDates) —
 *  decisão de spec lendo o engine: valid_from é ancorado no timestamp da mensagem (P1-A) e
 *  page.date é a data da fonte; juntos são a cadência observável sem tabela nova.
 *  Anti-falso-positivo: < minEventos eventos → SILÊNCIO DO DETECTOR (sem sinal); e o limiar
 *  tem piso ratioMin·mediana (cadência perfeitamente regular tem MAD=0 — sem o piso, qualquer
 *  gap de mediana+1 dia viraria flag). Zero LLM. */
import {
  type Signal,
  type SignalConfig,
  type SignalFact,
  type SignalInputs,
  severidade,
} from "./types.ts";
import { diaUtc } from "./d1-tendencia.ts";

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const ISO_DATE = /^\d{4}-\d{2}-\d{2}/;

/** mediana-inferior determinística: sorted[floor((n-1)/2)]. */
export function medianaInferior(valores: number[]): number {
  if (!valores.length) return 0;
  const s = [...valores].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)];
}

/** { mediana, mad } dos gaps (MAD = mediana-inferior dos |g − mediana|). */
export function medianaMad(gaps: number[]): { mediana: number; mad: number } {
  const mediana = medianaInferior(gaps);
  const mad = medianaInferior(gaps.map((g) => Math.abs(g - mediana)));
  return { mediana, mad };
}

export function detectSilencio(inputs: SignalInputs, cfg: SignalConfig): Signal[] {
  const out: Signal[] = [];
  // entidades = Set dos entity dos grupos, ordenadas asc.
  const entidades = [...new Set(inputs.grupos.map((g) => g.entity))].sort((a, b) => a.localeCompare(b));
  const hojeDia = diaUtc(inputs.hoje);

  for (const entity of entidades) {
    const factsDaEnt: SignalFact[] = inputs.grupos.filter((g) => g.entity === entity).flatMap((g) => g.facts);

    // 1) eventos = datas únicas válidas de valid_from + pageDates.
    const datas = new Set<string>();
    for (const f of factsDaEnt) {
      if (ISO_DATE.test(f.valid_from)) datas.add(f.valid_from.slice(0, 10));
      const pd = inputs.pageDates.get(f.source_slug);
      if (pd && ISO_DATE.test(pd)) datas.add(pd.slice(0, 10));
    }
    const eventos = [...datas].sort((a, b) => a.localeCompare(b));

    // 2) guards.
    if (eventos.length < cfg.d2.minEventos) continue;
    const ultimo = eventos[eventos.length - 1];
    const gapAtual = hojeDia - diaUtc(ultimo);
    if (gapAtual < 0) continue;

    // 3) gaps + mediana/mad.
    const gaps: number[] = [];
    for (let i = 1; i < eventos.length; i++) gaps.push(diaUtc(eventos[i]) - diaUtc(eventos[i - 1]));
    const { mediana, mad } = medianaMad(gaps);
    if (mediana === 0) continue;

    // 4) limiar + flag.
    const limiar = Math.max(mediana + cfg.d2.kMad * mad, cfg.d2.ratioMin * mediana);
    if (!(gapAtual > limiar)) continue;

    // 5) efeito.
    const ratio = gapAtual / mediana;
    const efeito = clamp01((ratio - 1) / cfg.d2.refRatio);

    // 6) numeros, baseFacts, etc.
    const numeros: Record<string, number> = { eventos: eventos.length, mediana, mad, gapAtual, limiar, ratio };
    const ordenados = [...factsDaEnt].sort(
      (a, b) => b.valid_from.localeCompare(a.valid_from) || a.source_slug.localeCompare(b.source_slug),
    );
    const usados = ordenados.slice(0, cfg.maxBaseFacts);
    const baseFacts = usados.map((f) => ({
      entity: f.entity, predicate: f.predicate, tier: f.tier, valid_from: f.valid_from, source_slug: f.source_slug,
    }));
    const minConfidence = Math.min(...usados.map((f) => f.confidence));

    // 7) resumo.
    const resumo = `${entity}: ${gapAtual} dias sem evento novo (intervalo típico ~${mediana} dias; ${ratio.toFixed(1)}× o normal)`;

    out.push({
      detector: "d2_silencio",
      classe: "silencio",
      efeito,
      severidade: severidade(efeito, cfg),
      entities: [entity],
      baseFacts,
      minConfidence,
      numeros,
      janela: { de: ultimo, ate: inputs.hoje },
      resumo,
    });
  }
  return out;
}
