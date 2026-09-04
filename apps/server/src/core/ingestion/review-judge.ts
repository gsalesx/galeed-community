/** M25-B — JUIZ TRIADOR da fila de revisão. Para cada item PENDENTE, o Haiku (tool_use forçado,
 *  batch quando > threshold — M16) produz {recomendacao, motivo, confianca} PERSISTIDO nas colunas
 *  judge_* de galeed_ingest_review (migração 32). O juiz fica esperto por MEMÓRIA DE DECISÕES
 *  (few-shot das decisões humanas passadas, recuperadas por match estrutural + trigram) e HONESTO por
 *  CALIBRAÇÃO medida (acerto recomendado-vs-decidido por segmento).
 *
 *  A LEI do pacote (DESIGN-SPEC §0): o juiz RECOMENDA, NUNCA decide (invariante #5). Este módulo JAMAIS
 *  escreve na coluna `status` da fila de revisão e jamais chama os fluxos de decisão humana (aprovar/
 *  descartar do golden-rule). O único UPDATE que faz na fila seta SÓ as colunas judge_* (§3.7). A
 *  recomendação é ADITIVA e idempotente (judged_at null → não recomendado). Auto-aprovação = v2, fora
 *  desta onda. (O assert estrutural do gate, §8.2.6, prova byte-a-byte que estes nomes não aparecem.)
 *
 *  Conexão: usa a pool COMPARTILHADA (db-conn.ts, padrão ADR-013/brain-context.ts) — o módulo é DONO
 *  ÚNICO das colunas judge_* + da tabela galeed_judge_batches; engine.ts/postgres.ts intocados (precedente
 *  M22-A). Tenant-neutro (invariante III): zero literal de domínio; o prompt é composto de DADOS. */
import { config } from "../platform/config.ts";
import {
  hasKey,
  buildMessagesBody,
  parseToolUse,
  toolCall,
  type Tool,
  type AnthropicUsage,
} from "../../lib/anthropic.ts";
import { costUsd } from "../../lib/pricing.ts";
import { recordUsage } from "../platform/usage.ts";
import { UNTRUSTED_SYS, wrapUntrusted } from "../../lib/prompt-safety.ts";
import { recipeGuidance } from "./golden-rule.ts";
import { getEngine, type ReviewItemRow, type SourceRow } from "../platform/engine.ts";
import { getSharedSql, sharedSqlGeneration, closeSharedSql } from "../platform/db-conn.ts";
import {
  submitBatch,
  getBatch,
  getBatchResults,
  type BatchRequest,
} from "../../lib/batch-client.ts";

// =====================================================================================================
// §3.1 Config
// =====================================================================================================

export interface JudgeConfig {
  model: string;
  batchThreshold: number;
  kMemoria: number;
  janelaCorpo: number;
}

/** parsing defensivo: NaN/≤0 → default. PURA. */
function posInt(raw: string | undefined, def: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : def;
}

export function judgeConfig(env: NodeJS.ProcessEnv = process.env): JudgeConfig {
  const model =
    env.GALEED_JUDGE_MODEL || env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";
  return {
    model,
    batchThreshold: posInt(env.GALEED_JUDGE_BATCH_THRESHOLD, 50),
    kMemoria: posInt(env.GALEED_JUDGE_K_MEMORIA, 6),
    janelaCorpo: posInt(env.GALEED_JUDGE_JANELA_CORPO, 800),
  };
}

// =====================================================================================================
// §3.2 Tipos
// =====================================================================================================

export type JudgeRecomendacao = "aprovar" | "descartar" | "humano";

/** O que fica persistido no item (colunas judge_* — migração 32). */
export interface JudgeRecommendation {
  review_id: string;
  recomendacao: JudgeRecomendacao;
  motivo: string;
  confianca: number;
  memoria_n: number;
}

/** Uma decisão humana passada usada como few-shot. */
export interface DecisaoMemoria {
  id: string;
  dimension: string;
  source_id: string;
  reason: string;
  text: string;
  quote: string;
  decisao: "aprovada" | "descartada";
  decided_by: string;
}

export interface JudgeRunResult {
  status: "concluido" | "batch_submetido" | "batch_em_andamento" | "nada_a_julgar";
  julgados: number;
  distribuicao: { aprovar: number; descartar: number; humano: number };
  pendentes_sem_recomendacao: number;
  erros: number;
  pulados: number;
  batch_id?: string;
  request_counts?: { processing: number; succeeded: number; errored: number; canceled: number; expired: number };
  custo_usd: number; // adendo §12 do árbitro
  mensagem: string;
}

// =====================================================================================================
// §3.9 Schema lazy (espelho da migração 32) sobre a pool compartilhada
// =====================================================================================================

let _ready: Promise<void> | null = null;
let _readyGeneration = -1;

async function db(): Promise<any> {
  const sql = await getSharedSql();
  const gen = sharedSqlGeneration();
  if (_ready && _readyGeneration === gen) {
    await _ready;
    return sql;
  }
  _readyGeneration = gen;
  _ready = (async () => {
    // idempotente — MESMO SQL da migração 32 (§5), com `alter table if exists` (a tabela pode não
    // existir num banco virgem antes do engine bootar). Boot lazy não depende da ordem do engine.
    await sql.unsafe(`create extension if not exists pg_trgm`).catch((err: any) => {
      // §11/risco: create extension pg_trgm exige privilégio; sem ele o juiz degrada pra rank
      // estrutural puro (fail-soft §3.3). Anota e segue — o alter/índices abaixo ainda valem.
      console.log(`[judge-schema] pg_trgm indisponível (degrada pra rank estrutural): ${err?.message ?? err}`);
    });
    await sql.unsafe(`
      alter table if exists galeed_ingest_review add column if not exists judge_recommendation text not null default '';
      alter table if exists galeed_ingest_review add column if not exists judge_reason text not null default '';
      alter table if exists galeed_ingest_review add column if not exists judge_confidence real;
      alter table if exists galeed_ingest_review add column if not exists judge_model text not null default '';
      alter table if exists galeed_ingest_review add column if not exists judge_memory_n integer not null default 0;
      alter table if exists galeed_ingest_review add column if not exists judged_at timestamptz;
      create index if not exists galeed_ingest_review_sem_juiz
        on galeed_ingest_review(brain, created_at) where status = 'pendente' and judged_at is null;
      create index if not exists galeed_ingest_review_calibracao
        on galeed_ingest_review(brain, dimension, source_id, reason)
        where status in ('aprovada','descartada') and judged_at is not null;
      create table if not exists galeed_judge_batches (
        brain text not null,
        batch_id text not null,
        status text not null default 'submetido',
        total integer not null default 0,
        submitted_at timestamptz default now(),
        harvested_at timestamptz,
        meta jsonb not null default '{}'::jsonb,
        primary key (brain, batch_id)
      );
      create index if not exists galeed_judge_batches_abertos
        on galeed_judge_batches(brain, status) where status = 'submetido';
    `);
  })();
  await _ready;
  return sql;
}

/** Fecha a pool/cache do módulo (testes/shutdown — espelho closeBrainContext). */
export async function closeReviewJudge(): Promise<void> {
  _ready = null;
  _readyGeneration = -1;
  await closeSharedSql();
}

// =====================================================================================================
// §3.3 Memória de decisões — estrutural + trigram (sem embeddings no v1, decisão §2.3 ANOTADA)
// =====================================================================================================

let _trgmWarned = false;

export async function recallDecisions(brain: string, item: ReviewItemRow, k: number): Promise<DecisaoMemoria[]> {
  if (k <= 0) return [];
  const sql = await db();
  const text = String(item.text ?? "");
  const run = (useTrgm: boolean) =>
    sql.unsafe(
      `select id, dimension, source_id, reason, text, quote, status as decisao, decided_by
         from galeed_ingest_review
        where brain = $1 and status in ('aprovada','descartada') and id <> $2
        order by ((dimension = $3)::int + (source_id = $4)::int + (reason = $5)::int) desc,
                 ${useTrgm ? "similarity(text, $6) desc nulls last," : ""}
                 decided_at desc
        limit ${useTrgm ? "$7" : "$6"}`,
      useTrgm
        ? [brain, item.id, item.dimension, item.source_id, item.reason, text, k]
        : [brain, item.id, item.dimension, item.source_id, item.reason, k],
    );
  try {
    return (await run(true)) as DecisaoMemoria[];
  } catch (err) {
    // §3.3: pg_trgm ausente (defensivo) → refaz SEM o termo trigram e loga 1×.
    if (!_trgmWarned) {
      console.log(`[judge-recall] similarity() falhou (rank estrutural puro): ${(err as Error)?.message ?? err}`);
      _trgmWarned = true;
    }
    return (await run(false)) as DecisaoMemoria[];
  }
}

// =====================================================================================================
// §3.4 Composição do prompt (PURAS — testáveis sem DB/LLM)
// =====================================================================================================

/** Janela do body em volta da quote: quote encontrada (indexOf) → ±janela/2 chars com reticências;
 *  quote vazia/não encontrada → primeiros `janela` chars. PURA. */
export function excerptAround(body: string, quote: string, janela: number): string {
  const b = String(body ?? "");
  const j = Math.max(1, Math.floor(janela));
  if (b.length <= j) return b;
  const q = String(quote ?? "");
  const at = q ? b.indexOf(q) : -1;
  if (at < 0) return b.slice(0, j);
  const meio = at + Math.floor(q.length / 2);
  const half = Math.floor(j / 2);
  let start = Math.max(0, meio - half);
  let end = Math.min(b.length, start + j);
  start = Math.max(0, end - j);
  const head = start > 0 ? "…" : "";
  const tail = end < b.length ? "…" : "";
  return `${head}${b.slice(start, end)}${tail}`;
}

/** 1ª linha (não-vazia) de um texto — pro resumo curto de cada decisão no few-shot. PURA. */
function firstLine(s: string): string {
  const t = String(s ?? "").trim();
  const nl = t.indexOf("\n");
  return nl >= 0 ? t.slice(0, nl).trim() : t;
}

/** Monta prompt+system+tool de UM item. PURA (sem DB/LLM). Ordem CRAVADA (§3.4). */
export function buildJudgePrompt(
  item: ReviewItemRow,
  source: SourceRow | undefined,
  pageExcerpt: string,
  memoria: DecisaoMemoria[],
): { prompt: string; system: string } {
  // 1. PAPEL.
  const papel =
    "Você é o juiz triador da fila de revisão de um cérebro de conhecimento. Para cada hipótese, " +
    "você RECOMENDA uma triagem — mas você NUNCA decide: só recomenda; o dono decide. Use a tool.";

  // 2. RECEITA da fonte (determinístico) + nome/tipo da fonte.
  let blocoFonte: string;
  if (source) {
    const guia = recipeGuidance(source.recipe ?? null);
    blocoFonte =
      `FONTE: "${source.name}" (tipo: ${source.type})` +
      (guia ? guia : "\n\n(esta fonte não tem receita declarada.)");
  } else {
    blocoFonte = "FONTE: item sem fonte (hipótese do sonho).";
  }

  // 3. MEMÓRIA DE DECISÕES.
  let blocoMemoria: string;
  if (!memoria.length) {
    // LEI 3: sem decisões → o juiz roda SEM memória, o prompt diz isso.
    blocoMemoria =
      "MEMÓRIA: você ainda NÃO tem decisões passadas deste dono. Seja conservador: na dúvida, " +
      "recomende 'humano' e reflita essa ausência na confiança.";
  } else {
    const aprovadas = memoria.filter((m) => m.decisao === "aprovada");
    const descartadas = memoria.filter((m) => m.decisao === "descartada");
    const linha = (m: DecisaoMemoria) =>
      `  - ${m.text || "(sem texto)"} [motivo: ${m.reason}]${m.quote ? ` — "${firstLine(m.quote)}"` : ""}`;
    const partes: string[] = ["MEMÓRIA DE DECISÕES DO DONO (precedentes — siga o padrão dele):"];
    if (aprovadas.length) partes.push("O dono APROVOU no passado:\n" + aprovadas.map(linha).join("\n"));
    if (descartadas.length) partes.push("O dono DESCARTOU:\n" + descartadas.map(linha).join("\n"));
    blocoMemoria = partes.join("\n");
  }

  // 4. O ITEM (claim/quote/excerpt embrulhados em wrapUntrusted).
  const claimJson = (() => {
    try {
      return JSON.stringify(item.claim ?? {});
    } catch {
      return "{}";
    }
  })();
  const corpoItem =
    `motivo da fila: ${item.reason}\n` +
    `dimensão: ${item.dimension}\n` +
    `claim (JSON):\n${wrapUntrusted(claimJson)}\n` +
    `citação:\n${wrapUntrusted(String(item.quote ?? ""))}\n` +
    `trecho da fonte em volta da citação:\n${wrapUntrusted(pageExcerpt)}`;
  const blocoItem = "A HIPÓTESE A TRIAR:\n" + corpoItem;

  // 5. CRITÉRIO.
  const criterio =
    "CRITÉRIO:\n" +
    "- aprovar = o claim é fiel à fonte e útil sob a receita;\n" +
    "- descartar = ruído, duplicado ou sem valor;\n" +
    "- humano = ambíguo, sensível ou sem precedente claro.\n" +
    "Dê um 'motivo' de UMA frase em português e uma 'confianca' entre 0 e 1.";

  const prompt = [papel, blocoFonte, blocoMemoria, blocoItem, criterio].join("\n\n");
  const system = papel + " " + UNTRUSTED_SYS;
  return { prompt, system };
}

/** Tool ÚNICA, forçada. */
export const JUDGE_TOOL: Tool = {
  name: "recomendar_triagem",
  description: "Recomenda a triagem de UMA hipótese da fila de revisão. Você nunca decide — só recomenda.",
  input_schema: {
    type: "object",
    required: ["recomendacao", "motivo", "confianca"],
    properties: {
      recomendacao: { type: "string", enum: ["aprovar", "descartar", "humano"] },
      motivo: { type: "string", description: "uma frase em português explicando a recomendação" },
      confianca: { type: "number", minimum: 0, maximum: 1 },
    },
  },
};

// =====================================================================================================
// Validação defensiva da resposta do LLM (fail-soft no item — §0 LEI 7)
// =====================================================================================================

const RECS: ReadonlySet<string> = new Set<JudgeRecomendacao>(["aprovar", "descartar", "humano"]);

/** Valida/normaliza a saída do tool. Retorna null se inválida (não persiste, conta erro). PURA. */
export function validateJudgeOutput(raw: any): { recomendacao: JudgeRecomendacao; motivo: string; confianca: number } | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw.recomendacao;
  if (typeof rec !== "string" || !RECS.has(rec)) return null;
  let motivo = typeof raw.motivo === "string" ? raw.motivo : "";
  if (motivo.length > 280) motivo = motivo.slice(0, 280); // truncar defensivo
  let conf = typeof raw.confianca === "number" && Number.isFinite(raw.confianca) ? raw.confianca : 0;
  conf = Math.max(0, Math.min(1, conf)); // clamp defensivo
  return { recomendacao: rec as JudgeRecomendacao, motivo, confianca: conf };
}

// =====================================================================================================
// §3.7 Persistência (o ÚNICO write em galeed_ingest_review deste módulo — SÓ colunas judge_*)
// =====================================================================================================

/** Persiste a recomendação no item PENDENTE. NUNCA toca status/decided_by/decided_at (LEI 1).
 *  Sem `force`: acrescenta `and judged_at is null` (idempotência). Retorna nº de linhas afetadas
 *  (0 ⇒ item decidido em voo / já recomendado — §3.6). */
async function persistRecommendation(
  brain: string,
  rec: { review_id: string; recomendacao: JudgeRecomendacao; motivo: string; confianca: number; memoria_n: number; model: string },
  force: boolean,
): Promise<number> {
  const sql = await db();
  const where = force ? "" : " and judged_at is null";
  const r = await sql.unsafe(
    `update galeed_ingest_review
        set judge_recommendation = $3, judge_reason = $4, judge_confidence = $5,
            judge_model = $6, judge_memory_n = $7, judged_at = now()
      where brain = $1 and id = $2 and status = 'pendente'${where}`,
    [brain, rec.review_id, rec.recomendacao, rec.motivo, rec.confianca, rec.model, rec.memoria_n],
  );
  return r?.count ?? 0;
}

// =====================================================================================================
// §3.5 / §3.6 — o juiz: UMA fase por chamada, serializado por brain (promise-chain)
// =====================================================================================================

interface PendingRow {
  id: string;
  source_id: string;
  source_slug: string;
  dimension: string;
  text: string;
  quote: string;
  claim: any;
  reason: ReviewItemRow["reason"];
  status: ReviewItemRow["status"];
}

/** Linhas pendentes alvo da seleção (§3.5.2): pendente E (judged_at null OU force), created_at asc, sem limit. */
async function selectPending(brain: string, force: boolean): Promise<PendingRow[]> {
  const sql = await db();
  const cond = force ? "" : " and judged_at is null";
  return (await sql.unsafe(
    `select id, source_id, source_slug, dimension, text, quote, claim, reason, status
       from galeed_ingest_review
      where brain = $1 and status = 'pendente'${cond}
      order by created_at asc`,
    [brain],
  )) as PendingRow[];
}

function toReviewItem(r: PendingRow): ReviewItemRow {
  return {
    id: r.id,
    source_id: r.source_id,
    source_slug: r.source_slug,
    dimension: r.dimension,
    text: r.text,
    quote: r.quote,
    claim: r.claim,
    reason: r.reason,
    status: r.status,
    decided_by: "",
    decided_at: null,
  };
}

async function pendentesSemRecomendacao(brain: string): Promise<number> {
  const sql = await db();
  const r = await sql.unsafe(
    `select count(*)::int as n from galeed_ingest_review
      where brain = $1 and status = 'pendente' and judged_at is null`,
    [brain],
  );
  return r?.[0]?.n ?? 0;
}

const chains = new Map<string, Promise<JudgeRunResult>>();

/** UMA fase por chamada (§2.4). Serializado por brain (promise-chain — duas chamadas concorrentes não
 *  submetem 2 lotes). */
export async function judgePending(brain: string, opts?: { force?: boolean }): Promise<JudgeRunResult> {
  if (!hasKey()) throw new Error("o juiz precisa de ANTHROPIC_API_KEY no servidor (sem fallback CLI).");
  const prev = chains.get(brain) ?? Promise.resolve(undefined as unknown as JudgeRunResult);
  const next = prev.then(
    () => doJudge(brain, !!opts?.force),
    () => doJudge(brain, !!opts?.force),
  );
  chains.set(brain, next);
  return next;
}

async function doJudge(brain: string, force: boolean): Promise<JudgeRunResult> {
  const cfg = judgeConfig();
  const sql = await db();

  // ── PASSO 1: lote aberto? ────────────────────────────────────────────────────────────────────
  const abertos = await sql.unsafe(
    `select batch_id, meta from galeed_judge_batches where brain = $1 and status = 'submetido' limit 1`,
    [brain],
  );
  if (abertos.length) {
    const batchId: string = abertos[0].batch_id;
    let handle: Awaited<ReturnType<typeof getBatch>> | null = null;
    try {
      handle = await getBatch(batchId);
    } catch (err) {
      // getBatch falhou/expirou → marca erro, loga, SEGUE pro passo 2 (fail-soft).
      const msg = (err as Error)?.message ?? String(err);
      console.log(`[judge-batch] getBatch ${batchId} falhou: ${msg}`);
      await sql.unsafe(
        `update galeed_judge_batches set status = 'erro', meta = meta || $3::jsonb
          where brain = $1 and batch_id = $2`,
        [brain, batchId, JSON.stringify({ erro: msg })],
      );
    }
    if (handle) {
      const rc = handle.request_counts;
      if (handle.processing_status === "in_progress" || handle.processing_status === "canceling") {
        return {
          status: "batch_em_andamento",
          julgados: 0,
          distribuicao: { aprovar: 0, descartar: 0, humano: 0 },
          pendentes_sem_recomendacao: await pendentesSemRecomendacao(brain),
          erros: 0,
          pulados: 0,
          batch_id: batchId,
          request_counts: rc,
          custo_usd: 0,
          mensagem: "lote em processamento — chame de novo em instantes.",
        };
      }
      if (handle.processing_status === "ended") {
        const colheita = await harvestBatch(brain, batchId, handle, cfg.model);
        await sql.unsafe(
          `update galeed_judge_batches set status = 'colhido', harvested_at = now()
            where brain = $1 and batch_id = $2`,
          [brain, batchId],
        );
        return {
          status: "concluido",
          julgados: colheita.julgados,
          distribuicao: colheita.distribuicao,
          pendentes_sem_recomendacao: await pendentesSemRecomendacao(brain),
          erros: colheita.erros,
          pulados: colheita.pulados,
          batch_id: batchId,
          request_counts: rc,
          custo_usd: colheita.custo_usd,
          mensagem: `lote colhido: ${colheita.julgados} recomendações.`,
        };
      }
    }
    // handle null (erro) → cai pro passo 2.
  }

  // ── PASSO 2: seleção ───────────────────────────────────────────────────────────────────────────
  const pend = await selectPending(brain, force);
  if (!pend.length) {
    return {
      status: "nada_a_julgar",
      julgados: 0,
      distribuicao: { aprovar: 0, descartar: 0, humano: 0 },
      pendentes_sem_recomendacao: 0,
      erros: 0,
      pulados: 0,
      custo_usd: 0,
      mensagem: "nada a julgar — a fila não tem itens pendentes sem recomendação.",
    };
  }

  // ── PASSO 3 ou 4: sync vs batch ────────────────────────────────────────────────────────────────
  if (pend.length <= cfg.batchThreshold) {
    return await judgeSync(brain, pend, force, cfg);
  }
  return await judgeSubmitBatch(brain, pend, force, cfg);
}

// ── helpers de leitura cacheada por chamada (source/page) ─────────────────────────────────────────

async function makeLoaders(brain: string) {
  const e = await getEngine(brain);
  const cfg = judgeConfig();
  const srcCache = new Map<string, SourceRow | undefined>();
  const pageCache = new Map<string, string>(); // slug → excerpt body
  const getSrc = async (id: string): Promise<SourceRow | undefined> => {
    if (!id) return undefined;
    if (srcCache.has(id)) return srcCache.get(id);
    const s = await e.getSource(id).catch(() => undefined);
    srcCache.set(id, s);
    return s;
  };
  const getBody = async (slug: string): Promise<string> => {
    if (!slug) return "";
    if (pageCache.has(slug)) return pageCache.get(slug)!;
    const p = await e.getPage(slug).catch(() => undefined);
    const body = p?.body ?? "";
    pageCache.set(slug, body);
    return body;
  };
  return { getSrc, getBody, janela: cfg.janelaCorpo, kMemoria: cfg.kMemoria };
}

// ── §3.5 passo 3: SYNC ────────────────────────────────────────────────────────────────────────────

async function judgeSync(
  brain: string,
  pend: PendingRow[],
  force: boolean,
  cfg: JudgeConfig,
): Promise<JudgeRunResult> {
  const { getSrc, getBody, janela, kMemoria } = await makeLoaders(brain);
  const dist = { aprovar: 0, descartar: 0, humano: 0 };
  let julgados = 0;
  let erros = 0;
  let pulados = 0;
  let custo = 0;

  for (const row of pend) {
    const item = toReviewItem(row);
    const source = await getSrc(row.source_id);
    const body = await getBody(row.source_slug);
    const excerpt = excerptAround(body, row.quote, janela);
    const memoria = await recallDecisions(brain, item, kMemoria);
    const { prompt, system } = buildJudgePrompt(item, source, excerpt, memoria);

    let raw: any;
    try {
      raw = await toolCall(cfg.model, prompt, JUDGE_TOOL, system, (u: AnthropicUsage) => {
        const tIn = u.input_tokens ?? 0, tOut = u.output_tokens ?? 0;
        const cR = u.cache_read_input_tokens ?? 0, cW = u.cache_creation_input_tokens ?? 0;
        custo += costUsd(cfg.model, { tokensIn: tIn, tokensOut: tOut, cacheRead: cR, cacheWrite: cW });
        void recordUsage(brain, {
          op: "judge:recommend",
          provider: "api",
          model: cfg.model,
          tokensIn: tIn,
          tokensOut: tOut,
          cacheRead: cR,
          cacheWrite: cW,
          meta: { review_id: row.id },
        });
      });
    } catch (err) {
      erros++;
      console.log(`[judge-sync-error] brain=${brain} id=${row.id}: ${(err as Error)?.message ?? err}`);
      continue;
    }

    const out = validateJudgeOutput(raw);
    if (!out) {
      erros++;
      console.log(`[judge-sync-invalid] brain=${brain} id=${row.id}`);
      continue;
    }
    const n = await persistRecommendation(
      brain,
      { review_id: row.id, recomendacao: out.recomendacao, motivo: out.motivo, confianca: out.confianca, memoria_n: memoria.length, model: cfg.model },
      force,
    );
    if (n === 0) {
      pulados++; // decidido em voo / já recomendado sem force
      continue;
    }
    julgados++;
    dist[out.recomendacao]++;
  }

  return {
    status: "concluido",
    julgados,
    distribuicao: dist,
    pendentes_sem_recomendacao: await pendentesSemRecomendacao(brain),
    erros,
    pulados,
    custo_usd: custo,
    mensagem: `triagem concluída: ${julgados} recomendações (${erros} erros).`,
  };
}

// ── §3.5 passo 4: SUBMETE o lote ──────────────────────────────────────────────────────────────────

async function judgeSubmitBatch(
  brain: string,
  pend: PendingRow[],
  force: boolean,
  cfg: JudgeConfig,
): Promise<JudgeRunResult> {
  const { getSrc, getBody, janela, kMemoria } = await makeLoaders(brain);
  const requests: BatchRequest[] = [];
  for (const row of pend) {
    const item = toReviewItem(row);
    const source = await getSrc(row.source_id);
    const body = await getBody(row.source_slug);
    const excerpt = excerptAround(body, row.quote, janela);
    const memoria = await recallDecisions(brain, item, kMemoria);
    const { prompt, system } = buildJudgePrompt(item, source, excerpt, memoria);
    // LEI 5: MESMO corpo do sync (buildMessagesBody). custom_id = o próprio id do item (hex32 §1.1).
    // memoria_n não viaja no lote (a Batch API não devolve o custom params); o harvest re-computa a
    // memória por item colhido (1 recall barato/linha) e grava judge_memory_n — §3.6.
    const params = buildMessagesBody(cfg.model, prompt, JUDGE_TOOL, system);
    requests.push({ custom_id: row.id, params });
  }

  const sql = await db();
  const handle = await submitBatch(requests);
  await sql.unsafe(
    `insert into galeed_judge_batches (brain, batch_id, status, total, meta)
     values ($1, $2, 'submetido', $3, $4::jsonb)
     on conflict (brain, batch_id) do nothing`,
    [brain, handle.id, requests.length, JSON.stringify({ force })],
  );

  return {
    status: "batch_submetido",
    julgados: 0,
    distribuicao: { aprovar: 0, descartar: 0, humano: 0 },
    pendentes_sem_recomendacao: await pendentesSemRecomendacao(brain),
    erros: 0,
    pulados: 0,
    batch_id: handle.id,
    request_counts: handle.request_counts,
    custo_usd: 0,
    mensagem: `lote submetido (${requests.length} itens) — chame de novo pra colher.`,
  };
}

// ── §3.6 harvest do lote ──────────────────────────────────────────────────────────────────────────

async function harvestBatch(
  brain: string,
  batchId: string,
  handle: Awaited<ReturnType<typeof getBatch>>,
  model: string,
): Promise<{ julgados: number; distribuicao: { aprovar: number; descartar: number; humano: number }; erros: number; pulados: number; custo_usd: number }> {
  const sql = await db();
  // o force do lote viaja no meta (pro harvest respeitar — §3.5.4).
  const metaRow = await sql.unsafe(
    `select meta from galeed_judge_batches where brain = $1 and batch_id = $2`,
    [brain, batchId],
  );
  const force = !!metaRow?.[0]?.meta?.force;

  const dist = { aprovar: 0, descartar: 0, humano: 0 };
  let julgados = 0;
  let erros = 0;
  let pulados = 0;
  let custo = 0;

  let lines: Awaited<ReturnType<typeof getBatchResults>>;
  try {
    lines = await getBatchResults(handle);
  } catch (err) {
    console.log(`[judge-harvest] getBatchResults falhou: ${(err as Error)?.message ?? err}`);
    return { julgados: 0, distribuicao: dist, erros: 0, pulados: 0, custo_usd: 0 };
  }

  for (const line of lines) {
    const reviewId = line.custom_id; // casar SEMPRE por custom_id = review id
    if (line.result.type !== "succeeded") {
      erros++;
      console.log(`[judge-harvest-error] custom_id=${reviewId} type=${line.result.type}`);
      continue;
    }
    // recordUsage SEMPRE (a chamada foi cobrada mesmo se o parse falhar — espelho batch-extract.ts:231).
    const msg: any = line.result.message;
    const u = msg?.usage || {};
    const bModel = msg?.model || model;
    const tIn = u.input_tokens ?? 0, tOut = u.output_tokens ?? 0;
    const cR = u.cache_read_input_tokens ?? 0, cW = u.cache_creation_input_tokens ?? 0;
    const reported = costUsd(bModel, { tokensIn: tIn, tokensOut: tOut, cacheRead: cR, cacheWrite: cW }) * 0.5;
    custo += reported;
    void recordUsage(brain, {
      op: "judge:recommend:batch",
      provider: "api",
      model: bModel,
      tokensIn: tIn,
      tokensOut: tOut,
      cacheRead: cR,
      cacheWrite: cW,
      costUsdReported: reported,
      meta: { review_id: reviewId, batch: true },
    });

    let raw: any;
    try {
      raw = parseToolUse(line.result.message);
    } catch {
      erros++;
      console.log(`[judge-harvest-parse] custom_id=${reviewId} (tool_use ausente/truncado)`);
      continue;
    }
    const out = validateJudgeOutput(raw);
    if (!out) {
      erros++;
      console.log(`[judge-harvest-invalid] custom_id=${reviewId}`);
      continue;
    }
    // memoria_n do lote não foi transportado por linha; o harvest re-computa via recall barato? O
    // contrato pede judge_memory_n gravado. Recomputa a memória do item NO harvest (a fila pode ter
    // mudado, mas é o melhor sinal disponível) — barato (1 query/item colhido).
    const itemRow = await sql.unsafe(
      `select id, source_id, source_slug, dimension, text, quote, claim, reason, status
         from galeed_ingest_review where brain = $1 and id = $2`,
      [brain, reviewId],
    );
    let memoriaN = 0;
    if (itemRow.length) {
      const mem = await recallDecisions(brain, toReviewItem(itemRow[0] as PendingRow), judgeConfig().kMemoria);
      memoriaN = mem.length;
    }
    const n = await persistRecommendation(
      brain,
      { review_id: reviewId, recomendacao: out.recomendacao, motivo: out.motivo, confianca: out.confianca, memoria_n: memoriaN, model: bModel },
      force,
    );
    if (n === 0) {
      // decidido em voo entre submit e harvest → NÃO recebe recomendação retroativa (§3.6).
      pulados++;
      console.log(`[judge-harvest-pulado] custom_id=${reviewId} (decidido em voo)`);
      continue;
    }
    julgados++;
    dist[out.recomendacao]++;
  }

  return { julgados, distribuicao: dist, erros, pulados, custo_usd: custo };
}

// =====================================================================================================
// §3.5 getRecommendations — seam ÚNICO de leitura das colunas judge_* fora do módulo (pro M25-C)
// =====================================================================================================

export async function getRecommendations(
  brain: string,
  ids: string[],
): Promise<Record<string, { recomendacao: JudgeRecomendacao; motivo: string; confianca: number; memoria_n: number; judged_at: string }>> {
  if (!ids.length) return {};
  const sql = await db();
  const rows = await sql.unsafe(
    `select id, judge_recommendation, judge_reason, judge_confidence, judge_memory_n, judged_at
       from galeed_ingest_review
      where brain = $1 and judged_at is not null and id = any($2::text[])`,
    [brain, ids],
  );
  const out: Record<string, any> = {};
  for (const r of rows) {
    out[r.id] = {
      recomendacao: r.judge_recommendation as JudgeRecomendacao,
      motivo: r.judge_reason ?? "",
      confianca: r.judge_confidence ?? 0,
      memoria_n: r.judge_memory_n ?? 0,
      judged_at: r.judged_at instanceof Date ? r.judged_at.toISOString() : String(r.judged_at ?? ""),
    };
  }
  return out;
}

// =====================================================================================================
// §3.8 Calibração — LEITURA (GROUP BY sobre as colunas; sem tabela de pares)
// =====================================================================================================

export interface CalibrationSegment {
  dimension: string;
  source_id: string;
  reason: string;
  decididos: number;
  acertos: number;
  acerto: number;
  abstencoes: number;
}

export interface JudgeCalibration {
  total: { decididos: number; acertos: number; acerto: number; abstencoes: number; sem_recomendacao: number };
  segmentos: CalibrationSegment[];
}

function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

export async function judgeCalibration(brain: string): Promise<JudgeCalibration> {
  const sql = await db();
  const rows = await sql.unsafe(
    `select dimension, source_id, reason,
            count(*) filter (where judge_recommendation <> 'humano') as decididos,
            count(*) filter (where (judge_recommendation = 'aprovar' and status = 'aprovada')
                                or (judge_recommendation = 'descartar' and status = 'descartada')) as acertos,
            count(*) filter (where judge_recommendation = 'humano') as abstencoes
       from galeed_ingest_review
      where brain = $1 and status in ('aprovada','descartada') and judged_at is not null
      group by dimension, source_id, reason`,
    [brain],
  );

  const segmentos: CalibrationSegment[] = rows.map((r: any) => {
    const decididos = Number(r.decididos) || 0;
    const acertos = Number(r.acertos) || 0;
    return {
      dimension: r.dimension,
      source_id: r.source_id,
      reason: r.reason,
      decididos,
      acertos,
      acerto: decididos ? round4(acertos / decididos) : 0,
      abstencoes: Number(r.abstencoes) || 0,
    };
  });
  // ordenados por decididos desc, depois dimension asc (estável).
  segmentos.sort((a, b) => b.decididos - a.decididos || a.dimension.localeCompare(b.dimension));

  let tDecididos = 0, tAcertos = 0, tAbst = 0;
  for (const s of segmentos) {
    tDecididos += s.decididos;
    tAcertos += s.acertos;
    tAbst += s.abstencoes;
  }
  // sem_recomendacao = decididos com judged_at null (query irmã, só no total).
  const semRec = await sql.unsafe(
    `select count(*)::int as n from galeed_ingest_review
      where brain = $1 and status in ('aprovada','descartada') and judged_at is null`,
    [brain],
  );

  return {
    total: {
      decididos: tDecididos,
      acertos: tAcertos,
      acerto: tDecididos ? round4(tAcertos / tDecididos) : 0,
      abstencoes: tAbst,
      sem_recomendacao: semRec?.[0]?.n ?? 0,
    },
    segmentos,
  };
}

// =====================================================================================================
// §12 (adendo árbitro) — estimativa read-only (zero LLM) da fila pendente sem recomendação
// =====================================================================================================

export interface JudgeEstimate {
  itens: number;
  custo_usd_estimado: number;
  batch: boolean;
}

/** Estima custo de julgar a fila pendente sem recomendação. Read-only, ZERO LLM. Usa ~1.100 tokens in
 *  + ~70 out por item (§1.4) e o pricing do modelo; aplica ×0.5 se for caminho batch. */
export async function judgeEstimate(brain: string): Promise<JudgeEstimate> {
  const cfg = judgeConfig();
  const itens = await pendentesSemRecomendacao(brain);
  const perItem = costUsd(cfg.model, { tokensIn: 1100, tokensOut: 70 });
  const batch = itens > cfg.batchThreshold;
  const custo = perItem * itens * (batch ? 0.5 : 1);
  return { itens, custo_usd_estimado: round4(custo), batch };
}
