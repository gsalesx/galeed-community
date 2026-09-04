/** REFLEXÃO — o 3º andar da memória (sabedoria), estilo "Reflection" dos Generative Agents
 *  (Park et al. 2023). DIFERENTE do sonho:
 *   - SONHO = divergente, lateral: "que conexão ninguém viu?" (hipótese especulativa).
 *   - REFLEXÃO = convergente, vertical: "o que eu APRENDI com o que entrou?" (conclusão ancorada).
 *
 *  Sobe de fatos → sabedoria: episódico (fontes/) + semântico (fatos/) → APRENDIZADO (reflexoes/).
 *
 *  Processo (3 passos do paper):
 *   1. GATILHO POR ACÚMULO: só reflete quando ≥N fontes NOVAS entraram desde a última reflexão
 *      (rastreado em .index/reflect-state.json). Reage ao volume de ingestão, não ao relógio.
 *   2. PERGUNTAS SALIENTES: o LLM olha SÓ o lote novo e levanta as questões mais importantes.
 *   3. SÍNTESE ANCORADA: pra cada pergunta, sintetiza um aprendizado CITADO ([n]+data) das fontes.
 *
 *  Decisões de custo (pedido do Kelvin): modelo BARATO (Haiku) + JANELA PEQUENA (só o lote novo,
 *  nunca "tudo"). Pool menor = mais barato E mais focado E menos ruído (lição do dreaming OpenClaw).
 *
 *  Salvaguardas anti-ruído/anti-drift:
 *   - reflete só sobre o NOVO (marca como refletido; nunca re-paga o que já processou);
 *   - ancora em FONTES primárias, não em outras reflexões (sem auto-reforço);
 *   - dedup por vetor: aprendizado novo ~igual a um antigo → não duplica (precisa embeddings). */
import { config } from "../platform/config.ts";
import { resolveProvider, prose, structured, type UsageMeter } from "../../lib/llm.ts";
import { withCodexBrain, getCodexBrain } from "../../lib/chatgpt-codex.ts";
import { getEngine, type FactGroupKey, type PercepcaoCite, type PercepcaoRow } from "../platform/engine.ts";
import { verifyAnswer, type Claim, type VerifySource } from "../retrieval/answer-verify.ts";
import { recordUsage } from "../platform/usage.ts";
import type { Tool } from "../../lib/anthropic.ts";
import type { FactRef, RankedSignal, Severidade, Signal, SignalClasse } from "./signals/index.ts";
import { createHash } from "node:crypto";

const DEFAULT_THRESHOLD = 12; // nº de fontes novas que dispara uma reflexão

/** LEGADO (pré-M24) — aposentar quando o CLI migrar; NÃO usar em código novo. */
export interface Learning {
  question: string;
  text: string;
  sources: string[];
}
export interface ReflectResult {
  triggered: boolean;
  windowSize: number;
  threshold: number;
  learnings: Learning[];
  provider?: string;
  reason?: string;
}

const Q_SYSTEM =
  "Você é a mente reflexiva da memória de uma empresa. Olhe o material recente e levante as 3 a 5 " +
  "QUESTÕES MAIS IMPORTANTES que esse período revela (padrões, mudanças, riscos, oportunidades). " +
  "Responda APENAS com as perguntas, uma por linha, sem numeração nem texto extra.";

const A_SYSTEM =
  "Você é a mente reflexiva da memória de uma empresa. Com base SOMENTE no contexto, escreva UM aprendizado " +
  "conciso (2-4 frases) que responda à pergunta — um insight acionável, não um resumo. Cite as fontes como [n]. " +
  "Se o contexto não sustenta uma conclusão, diga 'sem evidência suficiente'. Nunca invente.";

/** Reflete sobre o lote de fontes NÃO refletidas. Por padrão só dispara se o lote ≥ threshold;
 *  `force` reflete sobre o que houver. `apply` grava as reflexões em reflexoes/ e marca o estado. */
export async function reflect(
  home: string,
  opts: { threshold?: number; force?: boolean; apply?: boolean; maxWindow?: number } = {},
): Promise<ReflectResult> {
  if (getCodexBrain() !== home) return withCodexBrain(home, () => reflect(home, opts));
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const maxWindow = opts.maxWindow ?? 20; // teto de fontes por reflexão (custo + foco)
  const e = await getEngine(home);
  const done = await e.reflectedSlugs();

  const all = await e.allPages();
  // janela = só o NOVO, e ordenado por data (mais recente por último) — pool pequeno de propósito
  const fresh = all.filter((s) => !done.has(s.slug)).sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  const windowSize = fresh.length;

  if (!opts.force && windowSize < threshold) {
    return { triggered: false, windowSize, threshold, learnings: [], reason: `só ${windowSize}/${threshold} fontes novas — aguardando acúmulo` };
  }
  if (windowSize === 0) return { triggered: false, windowSize, threshold, learnings: [], reason: "nada novo pra refletir" };

  const window = fresh.slice(-maxWindow); // pega as mais recentes até o teto
  const cfg = config(home);
  const provider = resolveProvider(cfg.provider);
  const model = provider === "cli" ? cfg.cliModel : cfg.apiModel;

  // material compacto: título + data + recorte de cada fonte da janela (janela pequena = barato)
  const digest = window.map((s, i) => `[${i + 1}] (${s.slug}, ${s.date || "s/data"}) ${s.title}\n${s.body.slice(0, 1200)}`).join("\n\n---\n\n");

  // passo 2: perguntas salientes
  const qRaw = await prose({ provider, model, system: Q_SYSTEM, prompt: `Material recente (${window.length} fontes):\n\n${digest}` });
  const questions = qRaw.split("\n").map((l) => l.replace(/^[-*\d.)\s]+/, "").trim()).filter((l) => l.length > 8).slice(0, 5);

  // passo 3: síntese ancorada por pergunta (mesmo digest como contexto — janela já é pequena)
  const learnings: Learning[] = [];
  for (const question of questions) {
    const text = await prose({ provider, model, system: A_SYSTEM, prompt: `Pergunta: ${question}\n\nContexto:\n${digest}` });
    if (/sem evid[êe]ncia/i.test(text)) continue;
    const cited = [...text.matchAll(/\[(\d+)\]/g)].map((m) => window[Number(m[1]) - 1]?.slug).filter(Boolean) as string[];
    learnings.push({ question, text: text.trim(), sources: [...new Set(cited)] });
  }

  if (opts.apply) {
    for (const l of learnings) await e.putReflection({ question: l.question, text: l.text, sources: l.sources });
    // marca a janela como refletida (nunca re-paga)
    await e.markReflected(window.map((s) => s.slug));
  }

  return { triggered: true, windowSize, threshold, learnings, provider };
}

// ============================================================================
// REFLEXÃO v2 (M24-C) — o LLM SÓ EXPLICA o que o detector (M24-A) já achou.
// Entrada: RankedSignal[] determinísticos. Saída: percepções em galeed_percepcoes,
// cada uma verificada por âncora (M17), ancorada por proveniência (FactRef) e com
// ciclo de vida viva → stale → revalidada | arquivada (LEI II do BRIEF). Zero LLM no
// caminho determinístico (varredura/revalidação). Teto duro de chamadas: K + 1 (LEI V).
// ============================================================================

/** M24-C — knobs da reflexão v2 (env com default; zero literal de domínio — ADR-002). */
const REFLECT_K = () => Math.max(1, Number(process.env.GALEED_REFLECT_K ?? 10));          // top-K por ciclo
const REFLECT_DELTA = () => Number(process.env.GALEED_REFLECT_DELTA ?? 0.25);             // |Δmag|/max(|antiga|,ε) ≤ delta → sustentado
const REFLECT_MODEL = (apiModel: string) => process.env.GALEED_REFLECT_MODEL || apiModel; // default = cfg.apiModel (Haiku)
/** classes EFÊMERAS: percepção viva cujo sinal SUMIU do ciclo é arquivada (evento que cessou).
 *  Classes de série (tendencia/ruptura/combinacao) confiam na proveniência (LEI II). */
const CLASSES_EFEMERAS = () =>
  new Set((process.env.GALEED_REFLECT_EFEMERAS ?? "silencio,compromisso_vencido").split(",").map((s) => s.trim()).filter(Boolean));

export type DropMotivo = "numero_nao_ancorado" | "quote_nao_ancorado" | "texto_vazio" | "resposta_invalida";

export interface ReflexaoOpts {
  topK?: number;          // default REFLECT_K()
  model?: string;         // default REFLECT_MODEL(cfg.apiModel)
  deltaRevalida?: number; // default REFLECT_DELTA()
}

/** Rastro do ciclo (M24-D grava em result_json.sono — mesmo padrão do ConsolidacaoTrace M23-D). */
export interface ReflexaoResult {
  noop: boolean;
  motivo?: string;
  top_k: number;
  combinacoes: number;
  nascidas: number;
  dropadas: { signal_id: string; motivo: DropMotivo }[];
  reaproveitadas: number;
  stales_novas: number;
  revalidadas: number;
  reverbalizadas: number;
  arquivadas: number;
  chamadas_llm: number;   // SEMPRE ≤ top_k + 1 (teto duro — LEI V)
  provider: string;       // "api" | "none"
}

/** Sinal NORMALIZADO do ciclo — tipo INTERNO do C (sinais do A + sintéticos 'combinacao'). */
export interface SinalCiclo {
  id: string;
  classe: SignalClasse | "combinacao";
  severidade: Severidade;
  entities: string[];
  baseFacts: FactRef[];
  numeros: Record<string, number | string>;
  magnitude: number;
  resumo: string;
  score: number;
}

const SEV_RANK: Record<Severidade, number> = { alta: 3, media: 2, baixa: 1 };

/** id determinístico do sinal de detector (§1.2 — SEM magnitude/números no hash; 32 hex). */
export function percepcaoId(s: Signal): string {
  const chave =
    s.detector === "d2_silencio"
      ? s.entities.join(",")
      : `${s.entities.join(",")}|${s.baseFacts[0]?.predicate ?? ""}|${s.baseFacts[0]?.tier ?? ""}`;
  return createHash("sha256").update(`${s.detector}|${chave}`).digest("hex").slice(0, 32);
}

/** id determinístico de 'combinacao': sha256(`combinacao|${ids ordenados join "|"}`).slice(0,32). */
export function combinacaoId(memberIds: string[]): string {
  const ordered = [...memberIds].sort();
  return createHash("sha256").update(`combinacao|${ordered.join("|")}`).digest("hex").slice(0, 32);
}

/** magnitude comparável entre sonos (§1.2 — chave por detector em numeros; fallback efeito). */
export function magnitudeDe(s: Signal): number {
  if (s.detector === "d1_tendencia") return Math.abs(Number(s.numeros.pctTotal ?? s.efeito));
  if (s.detector === "d2_silencio") return Number(s.numeros.ratio ?? s.efeito);
  if (s.detector === "d3_compromisso_vencido") return Number(s.numeros.diasVencidos ?? s.efeito);
  return s.efeito;
}

/** normalização determinística RankedSignal → SinalCiclo (id + magnitude + cópia dos campos). */
export function toSinalCiclo(s: RankedSignal): SinalCiclo {
  return {
    id: percepcaoId(s),
    classe: s.classe,
    severidade: s.severidade,
    entities: s.entities,
    baseFacts: s.baseFacts,
    numeros: s.numeros,
    magnitude: magnitudeDe(s),
    resumo: s.resumo,
    score: s.score,
  };
}

/** união dos baseFacts dos membros, deduplicada pela chave estável (profundidade 1 — LEI IV). */
export function uniaoBaseFacts(members: SinalCiclo[]): FactRef[] {
  const seen = new Map<string, FactRef>();
  for (const m of members)
    for (const f of m.baseFacts) {
      const k = `${f.source_slug}|${f.entity}|${f.predicate}|${f.tier}|${f.valid_from}`;
      if (!seen.has(k)) seen.set(k, f);
    }
  return [...seen.values()];
}

/** corpo VERIFICÁVEL de um sinal: resumo + numeros + magnitude + janela + 1 linha por FactRef.
 *  Os números do detector são determinísticos = evidência legítima pra âncora. */
export function evidenceBody(s: SinalCiclo): string {
  const linhasNum = Object.entries(s.numeros).map(([k, v]) => `${k}=${v}`).join(" ");
  const fatos = s.baseFacts
    .map((f) => `${f.entity} · ${f.predicate} · ${f.tier} · ${f.valid_from} · ${f.source_slug}`)
    .join("\n");
  return `${s.resumo}\n${linhasNum} magnitude=${s.magnitude}\n${fatos}`;
}

/** FactRef[] → PercepcaoCite[] (1:1, quote "" no v1; cites NUNCA vêm do LLM — vêm do detector). */
export function citesFromBaseFacts(baseFacts: FactRef[]): PercepcaoCite[] {
  return baseFacts.map((f) => ({
    source_slug: f.source_slug,
    entity: f.entity,
    predicate: f.predicate,
    tier: f.tier,
    valid_from: f.valid_from,
    quote: "",
  }));
}

/** |nova−antiga| / max(|antiga|, 1e-9) ≤ delta → sustentada (revalidação determinística). */
export function magnitudeSustentada(antiga: number, nova: number, delta: number): boolean {
  return Math.abs(nova - antiga) / Math.max(Math.abs(antiga), 1e-9) <= delta;
}

/** o VERIFICADOR DE ÂNCORA: delega a verifyAnswer (M17) e mapeia reason → DropMotivo. */
export function verificarPercepcao(s: SinalCiclo, texto: string, quote: string): { ok: boolean; motivo?: DropMotivo } {
  if (!texto || !texto.trim()) return { ok: false, motivo: "texto_vazio" };
  const claim: Claim = { text: texto, cite_slug: s.id, quote };
  const source: VerifySource = { slug: s.id, body: evidenceBody(s) };
  const res = verifyAnswer([claim], [source], []);
  if (res.verified.length) return { ok: true };
  const reason = res.dropped[0]?.reason;
  if (reason === "no-cite") return { ok: false, motivo: "texto_vazio" };
  if (reason === "quote-not-grounded") return { ok: false, motivo: "quote_nao_ancorado" };
  if (reason === "number-not-anchored") return { ok: false, motivo: "numero_nao_ancorado" };
  return { ok: false, motivo: "resposta_invalida" };
}

const JOINT_TOOL: Tool = {
  name: "combinar_sinais",
  description:
    "Aponte combinações de sinais que juntos contam uma história maior. Combine SÓ quando a conexão é específica e plausível; lista vazia é resposta válida.",
  input_schema: {
    type: "object",
    properties: {
      combinacoes: {
        type: "array",
        items: {
          type: "object",
          properties: {
            ids: { type: "array", items: { type: "string" }, description: "ids dos sinais combinados (2 ou mais, copiados da lista)" },
            por_que: { type: "string", description: "1 frase em português: por que esses sinais contam uma história juntos" },
          },
          required: ["ids", "por_que"],
        },
      },
    },
    required: ["combinacoes"],
  },
};

const VERBALIZE_TOOL: Tool = {
  name: "verbalizar_percepcao",
  description: "Verbaliza um sinal detectado: 2-4 frases em português, ancoradas SOMENTE na evidência anexada.",
  input_schema: {
    type: "object",
    properties: {
      texto: { type: "string", description: "2 a 4 frases em português. Nenhum número/nome fora da evidência." },
      quote: { type: "string", description: "trecho copiado VERBATIM de uma linha da evidência que sustenta o texto" },
    },
    required: ["texto", "quote"],
  },
};

const VERBALIZE_SYSTEM =
  "Você explica em português um sinal estatístico JÁ detectado na memória de uma empresa. " +
  "Use SOMENTE a evidência anexada; não introduza nenhum número ou nome que não esteja nela. Seja específico e acionável.";

const meter = (home: string, op: "reflect:joint" | "reflect:verbalize"): UsageMeter => (ev) =>
  void recordUsage(home, {
    op,
    provider: ev.provider,
    model: ev.model,
    tokensIn: ev.tokensIn,
    tokensOut: ev.tokensOut,
    cacheRead: ev.cacheRead,
    cacheWrite: ev.cacheWrite,
    costUsdReported: ev.costUsdReported,
  });

function sinalCicloToRow(s: SinalCiclo, texto: string): PercepcaoRow {
  const firstFact = s.baseFacts[0];
  return {
    id: s.id,
    classe: s.classe,
    entity: s.classe === "combinacao" ? "" : (firstFact?.entity ?? s.entities[0] ?? ""),
    predicate: s.classe === "combinacao" ? "" : (firstFact?.predicate ?? ""),
    tier: s.classe === "combinacao" ? "" : (firstFact?.tier ?? ""),
    texto,
    severidade: s.severidade,
    cites: citesFromBaseFacts(s.baseFacts),
    numbers: { ...s.numeros, magnitude: s.magnitude },
    estado: "viva",
    validated_at: null,
  };
}

/** M24-C — o ciclo de reflexão do sono. ORDEM INTERNA (cravada, §2.5):
 *  (1) varredura de proveniência → stale; (2) revalidação determinística contra `signals`
 *  (re-verbaliza SÓ se magnitude mudou); (3) passe conjunto; (4) verbalização ancorada.
 *  NUNCA lança por falha de LLM (fail-soft); erros de DB propagam (o M24-D faz o fail-soft dele). */
export async function sonoReflexao(home: string, signals: RankedSignal[], opts: ReflexaoOpts = {}): Promise<ReflexaoResult> {
  if (getCodexBrain() !== home) return withCodexBrain(home, () => sonoReflexao(home, signals, opts));
  const cfg = config(home);
  const topK = Math.max(1, opts.topK ?? REFLECT_K());
  const model = opts.model ?? REFLECT_MODEL(cfg.apiModel);
  const delta = opts.deltaRevalida ?? REFLECT_DELTA();
  const provider = resolveProvider(cfg.provider);
  const llmOk = provider === "api";
  const efemeras = CLASSES_EFEMERAS();
  const e = await getEngine(home);

  const res: ReflexaoResult = {
    noop: true,
    top_k: topK,
    combinacoes: 0,
    nascidas: 0,
    dropadas: [],
    reaproveitadas: 0,
    stales_novas: 0,
    revalidadas: 0,
    reverbalizadas: 0,
    arquivadas: 0,
    chamadas_llm: 0,
    provider: llmOk ? "api" : "none",
  };

  // sinais malformados (sem evidência) NÃO entram no ciclo (contrato do A — log + ignora).
  const validos = signals.filter((s) => {
    if (!s.baseFacts?.length) {
      console.warn("[reflect] sinal sem evidência — ignorado");
      return false;
    }
    return true;
  });
  const ciclo = validos.slice(0, topK).map(toSinalCiclo);
  const porId = new Map(ciclo.map((s) => [s.id, s]));

  // (0) NOOP cedo: sem sinais E sem percepção existente → nada a fazer.
  const vivasOuStale = await e.listPercepcoes({ limit: 100_000 });
  if (ciclo.length === 0 && vivasOuStale.length === 0) {
    res.motivo = "sem sinais";
    return res;
  }

  // (1) VARREDURA DE PROVENIÊNCIA (determinística, LEI II — roda SEMPRE):
  const vivas = vivasOuStale.filter((p) => p.estado === "viva");
  const factCites = vivas.flatMap((p) => p.cites.filter((c) => c.entity !== ""));
  const keys: FactGroupKey[] = [];
  const keySeen = new Set<string>();
  for (const c of factCites) {
    const k = `${c.entity}|${c.predicate}|${c.tier}`;
    if (!keySeen.has(k)) {
      keySeen.add(k);
      keys.push({ entity: c.entity, predicate: c.predicate, tier: c.tier });
    }
  }
  const atuais = keys.length ? await e.factsInGroups(keys) : [];
  const sustentaCite = (c: PercepcaoCite): boolean =>
    atuais.some(
      (f) =>
        f.entity === c.entity &&
        f.predicate === c.predicate &&
        (f.tier ?? "") === c.tier &&
        f.source_slug === c.source_slug &&
        f.valid_from === c.valid_from &&
        f.status === "fato" &&
        (f.valid_to === "" || f.valid_to == null),
    );
  for (const p of vivas) {
    const fatosDoCite = p.cites.filter((c) => c.entity !== "");
    // cite de página (entity==='') NUNCA invalida (não-verificável por fato).
    const quebrou = fatosDoCite.length > 0 && fatosDoCite.some((c) => !sustentaCite(c));
    if (quebrou) {
      await e.setPercepcaoEstado(p.id, "stale");
      p.estado = "stale";
      res.stales_novas++;
    }
  }

  // (2) REVALIDAÇÃO contra o ciclo atual (determinística; LLM SÓ no ramo "mudou").
  const atualizadas = await e.listPercepcoes({ limit: 100_000 });
  const reverbalizar: SinalCiclo[] = []; // sinais cuja magnitude mudou → re-verbaliza na etapa 4-bis
  for (const p of atualizadas) {
    if (p.estado === "arquivada") continue;
    const s = porId.get(p.id);
    const magAntiga = Number(p.numbers.magnitude ?? 0);
    if (s) {
      if (magnitudeSustentada(magAntiga, s.magnitude, delta)) {
        // sustentada → viva + numbers atualizados (texto INTACTO).
        const row = sinalCicloToRow(s, p.texto);
        row.estado = "viva";
        await e.upsertPercepcao(row);
        if (p.estado === "stale") res.revalidadas++;
        else res.reaproveitadas++;
      } else {
        reverbalizar.push(s); // magnitude mudou → re-verbaliza (1 chamada) na etapa abaixo.
      }
    } else {
      // sinal NÃO existe no ciclo atual.
      if (p.estado === "stale") {
        await e.setPercepcaoEstado(p.id, "arquivada");
        res.arquivadas++;
      } else if (efemeras.has(p.classe)) {
        await e.setPercepcaoEstado(p.id, "arquivada");
        res.arquivadas++;
      }
      // classe de série viva sem sinal: permanece viva (conservador — base intacta).
    }
  }

  // mapa de percepções NÃO-arquivadas que já existem (pra etapa 4 saber o que pular).
  const existentes = new Map(atualizadas.map((p) => [p.id, p]));

  // (3) PASSE CONJUNTO (≤1 chamada). Pulado se nada novo (todo sinal do ciclo já tem viva sustentada).
  const semPercepcao = ciclo.filter((s) => {
    const ex = existentes.get(s.id);
    return !ex || ex.estado === "arquivada" || reverbalizar.some((r) => r.id === s.id);
  });
  const combos: SinalCiclo[] = [];
  if (llmOk && semPercepcao.length > 0 && ciclo.length >= 2) {
    const lista = ciclo
      .map((s) => `- id=${s.id} classe=${s.classe} resumo="${s.resumo}" numeros=${JSON.stringify(s.numeros)}`)
      .join("\n");
    try {
      res.chamadas_llm++;
      const out = await structured({
        provider,
        model,
        system: "Você analisa sinais estatísticos de uma empresa e aponta combinações que contam uma história maior.",
        prompt: `Sinais detectados neste ciclo:\n${lista}\n\nAponte combinações (2+ ids) que juntas contam uma história. Lista vazia é válida.`,
        tool: JOINT_TOOL,
        dims: ["combinacoes"],
        meter: meter(home, "reflect:joint"),
      });
      const raw = Array.isArray(out?.combinacoes) ? out.combinacoes : [];
      const validIds = new Set(ciclo.map((s) => s.id));
      const seenCombo = new Set<string>();
      for (const c of raw) {
        const ids: string[] = Array.isArray(c?.ids) ? [...new Set(c.ids.filter((x: any) => validIds.has(x)))] : [];
        if (ids.length < 2) continue;
        const cid = combinacaoId(ids);
        if (seenCombo.has(cid)) continue;
        seenCombo.add(cid);
        const membros = ids.map((id) => porId.get(id)!).filter(Boolean);
        const sevMax = membros.reduce<Severidade>((acc, m) => (SEV_RANK[m.severidade] > SEV_RANK[acc] ? m.severidade : acc), "baixa");
        const porQue = String(c.por_que ?? "").trim();
        combos.push({
          id: cid,
          classe: "combinacao",
          severidade: sevMax,
          entities: [...new Set(membros.flatMap((m) => m.entities))].sort(),
          baseFacts: uniaoBaseFacts(membros),
          numeros: { membros: ids.slice().sort().join(","), por_que: porQue },
          magnitude: Math.max(...membros.map((m) => m.magnitude)),
          resumo: porQue,
          score: Math.max(...membros.map((m) => m.score)),
        });
      }
      res.combinacoes = combos.length;
    } catch (err) {
      console.warn("[reflect] passe conjunto falhou:", err instanceof Error ? err.message : err);
    }
  } else if (!llmOk) {
    res.motivo = "sem ANTHROPIC_API_KEY — verbalização adiada";
  }

  // (4) VERBALIZAÇÃO — re-verbalizações (etapa 2) + sinais/combos sem percepção viva.
  // teto: no máximo `topK` chamadas de verbalize (somadas ao 1 do joint = K+1 total).
  const aVerbalizar: SinalCiclo[] = [
    ...reverbalizar,
    ...semPercepcao,
    ...combos,
  ];
  // dedupe por id (um sinal pode estar em reverbalizar E semPercepcao).
  const vistoVerb = new Set<string>();
  const fila = aVerbalizar.filter((s) => {
    if (vistoVerb.has(s.id)) return false;
    vistoVerb.add(s.id);
    return true;
  });

  if (llmOk) {
    let usadas = 0;
    for (const s of fila) {
      if (usadas >= topK) break; // teto duro de verbalizações (LEI V).
      const ehReverb = reverbalizar.some((r) => r.id === s.id);
      usadas++;
      res.chamadas_llm++;
      let out: any;
      try {
        out = await structured({
          provider,
          model,
          system: VERBALIZE_SYSTEM,
          prompt: `Classe: ${s.classe}\nResumo: ${s.resumo}\nNúmeros: ${JSON.stringify(s.numeros)}\n\nEvidência (use SOMENTE isto):\n${evidenceBody(s)}`,
          tool: VERBALIZE_TOOL,
          dims: ["texto", "quote"],
          meter: meter(home, "reflect:verbalize"),
        });
      } catch (err) {
        console.warn("[reflect] verbalização falhou:", err instanceof Error ? err.message : err);
        res.dropadas.push({ signal_id: s.id, motivo: "resposta_invalida" });
        continue;
      }
      if (!out || typeof out !== "object" || typeof out.texto !== "string") {
        res.dropadas.push({ signal_id: s.id, motivo: out?.texto ? "resposta_invalida" : "texto_vazio" });
        continue;
      }
      const check = verificarPercepcao(s, out.texto, String(out.quote ?? ""));
      if (!check.ok) {
        res.dropadas.push({ signal_id: s.id, motivo: check.motivo! });
        continue; // percepção NÃO nasce.
      }
      await e.upsertPercepcao(sinalCicloToRow(s, out.texto.trim()));
      if (ehReverb) res.reverbalizadas++;
      else res.nascidas++;
    }
  }

  res.noop =
    res.nascidas + res.reverbalizadas + res.revalidadas + res.arquivadas + res.stales_novas + res.combinacoes === 0;
  if (res.noop && !res.motivo) res.motivo = ciclo.length === 0 ? "sem sinais" : "nada acima do corte";
  return res;
}
