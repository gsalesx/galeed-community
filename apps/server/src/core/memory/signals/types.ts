/** M24-A — tipos do signal-engine (BRIEF M24 §3, D1–D3 + priorizador). PURO: zero imports do
 *  projeto, zero IO, zero LLM. Todo limiar é SignalConfig com default (invariante III/ADR-002
 *  — nada de número mágico espalhado; os defaults "compromisso"/"prazo" são a convenção M23-C,
 *  que é DADO de receita, por isso configuráveis). */

/** Referência ESTÁVEL a um fato-base. galeed_facts.id (bigserial) NÃO é estável — a
 *  re-derivação (write-path incremental do M14) faz DELETE+INSERT e troca
 *  os ids (postgres.ts:206-238). A tupla abaixo sobrevive à re-derivação: é a chave de grupo
 *  bitemporal (FactGroupKey) + valid_from (a versão) + source_slug (a fonte). O M24-C
 *  revalida percepções re-buscando estas tuplas via factsInGroups (LEI II do BRIEF). */
export interface FactRef {
  entity: string;
  predicate: string;
  tier: string;        // "" = sem tier (string vazia é chave válida — engine.ts:296)
  valid_from: string;  // ISO YYYY-MM-DD (P1-A)
  source_slug: string;
}

export type DetectorId = "d1_tendencia" | "d2_silencio" | "d3_compromisso_vencido";
export type SignalClasse = "tendencia" | "ruptura" | "silencio" | "compromisso_vencido";
export type Severidade = "alta" | "media" | "baixa";

/** Janela temporal do sinal (ISO YYYY-MM-DD, inclusiva). */
export interface SignalWindow {
  de: string;
  ate: string;
}

/** UM sinal determinístico. Nasce com o PORQUÊ imprimível: números do detector + janela +
 *  fatos-base + resumo PT. O LLM (M24-C) só EXPLICA isto — nunca acha nada sozinho. */
export interface Signal {
  detector: DetectorId;
  classe: SignalClasse;
  /** efeito normalizado [0..1] — tamanho da mudança/surpresa (fórmula por detector, §2.3-§2.5). */
  efeito: number;
  /** derivada do efeito pelos limiares da config (severidade(), abaixo). */
  severidade: Severidade;
  /** entidades envolvidas (lowercase, ≥1). */
  entities: string[];
  /** fatos-base (proveniência — ver FactRef). ≥1, ≤ cfg.maxBaseFacts. */
  baseFacts: FactRef[];
  /** min(confidence) dos fatos-base — fator do priorizador (decisão do CTO; NOTA: confidence
   *  segue não-calibrada ~0.6 uniforme, M23-C convenção — o fator é quase-constante hoje). */
  minConfidence: number;
  /** os números do detector (o porquê): slope/pct/gap/mediana/mad/dias... chaves por detector. */
  numeros: Record<string, number>;
  janela: SignalWindow;
  /** 1 linha PT determinística com os números (templates exatos em §2.3-§2.5). NÃO é a
   *  verbalização LLM do M24-C — é o fallback/selo imprimível do detector. */
  resumo: string;
}

/** Sinal ranqueado pelo priorizador (§2.6). É O TIPO que o M24-C verbaliza e o M24-D agenda. */
export interface RankedSignal extends Signal {
  /** efeito × recência × salience × minConfidence, em [0..1]. */
  score: number;
  /** 1-based, após ordenação estável. */
  rank: number;
}

/** Config completa — TODO limiar mora aqui (invariante III). */
export interface SignalConfig {
  /** top-K global do priorizador (decisão do CTO: default 10). */
  k: number;
  /** teto de fatos-base anexados por sinal. */
  maxBaseFacts: number;
  /** meia-vida (dias) da recência do score. */
  recenciaMeiaVidaDias: number;
  /** salience usada quando a entidade não tem dados (fallback neutro). */
  salienceDefault: number;
  /** efeito ≥ alta → "alta"; ≥ media → "media"; senão "baixa". */
  severidadeAlta: number;
  severidadeMedia: number;
  d1: {
    minPontos: number;        // ≥3 pontos datados (BRIEF §3-D1)
    minSpanDias: number;      // série toda no mesmo dia/quase = sem tendência confiável
    minPctTotal: number;      // |variação %| mínima pra emitir sinal de tendência
    cusumSlack: number;       // k do CUSUM, em múltiplos de σ dos resíduos
    cusumLimiar: number;      // h do CUSUM, em múltiplos de σ dos resíduos
    refMudanca: number;       // |pctTotal|/100 ÷ refMudanca = efeito (clamp 0..1)
    efeitoRupturaMin: number; // ruptura nunca sai com efeito abaixo disto
  };
  d2: {
    minEventos: number;       // < minEventos eventos datados → silêncio DO DETECTOR (anti-FP)
    kMad: number;             // flag se gap > mediana + kMad·MAD ...
    ratioMin: number;         // ... E gap > ratioMin·mediana (piso anti-FP quando MAD=0)
    refRatio: number;         // (gap/mediana − 1) ÷ refRatio = efeito (clamp 0..1)
  };
  d3: {
    predicado: string;        // predicado FIXO da classe compromisso (M23-C — DADO de receita)
    metaPrazo: string;        // chave do prazo em meta (M23-C: "prazo")
    metaConcluido: string;    // seam forward-compat: meta[chave] truthy → compromisso fechado
    refDias: number;          // diasVencidos ÷ refDias = efeito (clamp 0..1)
  };
}

export const DEFAULT_SIGNAL_CONFIG: SignalConfig = {
  k: 10,
  maxBaseFacts: 12,
  recenciaMeiaVidaDias: 90,
  salienceDefault: 0.3,
  severidadeAlta: 0.8,
  severidadeMedia: 0.4,
  d1: { minPontos: 3, minSpanDias: 30, minPctTotal: 30, cusumSlack: 0.5, cusumLimiar: 2, refMudanca: 2, efeitoRupturaMin: 0.8 },
  d2: { minEventos: 5, kMad: 3, ratioMin: 2, refRatio: 3 },
  d3: { predicado: "compromisso", metaPrazo: "prazo", metaConcluido: "concluido", refDias: 30 },
};

/** override raso POR SEÇÃO (spread por chave de topo + spread dentro de d1/d2/d3). */
export type SignalConfigPatch = Partial<Omit<SignalConfig, "d1" | "d2" | "d3">> & {
  d1?: Partial<SignalConfig["d1"]>;
  d2?: Partial<SignalConfig["d2"]>;
  d3?: Partial<SignalConfig["d3"]>;
};

export function resolveSignalConfig(patch?: SignalConfigPatch): SignalConfig {
  const d = DEFAULT_SIGNAL_CONFIG;
  return {
    ...d,
    ...patch,
    d1: { ...d.d1, ...patch?.d1 },
    d2: { ...d.d2, ...patch?.d2 },
    d3: { ...d.d3, ...patch?.d3 },
  };
}

/** severidade derivada do efeito pelos limiares da config. */
export function severidade(efeito: number, cfg: SignalConfig): Severidade {
  return efeito >= cfg.severidadeAlta ? "alta" : efeito >= cfg.severidadeMedia ? "media" : "baixa";
}

// ---- inputs preparados (o que load.ts entrega e os detectores consomem — puros) ----

/** subconjunto de FactRow que os detectores leem (espelho estrutural — NÃO importar engine.ts
 *  aqui; o load.ts converte FactRow → SignalFact). */
export interface SignalFact {
  entity: string;
  predicate: string;
  tier: string;
  value: string;
  value_num: number | null;
  valid_from: string;
  valid_to: string;   // "" = vigente
  confidence: number;
  status: string;     // "fato" | "registrado" | ...
  source_slug: string;
  meta: any;          // item cru da extração (jsonb) — M23-C: prazo/com_quem viajam aqui
}

/** uma cadeia bitemporal completa de um grupo (entity, predicate, tier), ordenada por
 *  (valid_from asc, source_slug asc). */
export interface SeriesGroup {
  entity: string;
  predicate: string;
  tier: string;
  facts: SignalFact[];
}

/** dados de salience por entidade (alimenta salienceScore do M3 — health.ts). */
export interface EntitySalienceInfo {
  factCount: number;
  degree: number;
  role: string;      // "org" | "pessoa" | "assunto" (entityGraph M19)
  firstSeen: string; // ISO ou ""
}

/** snapshot que o load.ts monta UMA vez por ciclo; detectores e priorizador são funções puras dele. */
export interface SignalInputs {
  grupos: SeriesGroup[];
  /** source_slug → date da página ("" se sem data) — eventos do D2. */
  pageDates: Map<string, string>;
  /** entity → dados de salience (entityGraph + fallback das cadeias). */
  saliences: Map<string, EntitySalienceInfo>;
  /** YYYY-MM-DD derivado do now injetado. */
  hoje: string;
}
