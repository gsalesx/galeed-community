/** M24-D — O SONO no worker (orquestração, gatilho, budget, rastro). BRIEF M24 §5-S4 + gate §6.7.
 *  Acorda a feature dormente: o sono do Galeed (hoje só `galeed sleep` manual) passa a rodar SOZINHO
 *  no worker de ingestão, no idle pós-job, com gatilho por ACÚMULO + teto 1×/24h por brain, budget K
 *  de ponta a ponta e rastro auditável. Manual e automático = O MESMO código (`runSonoCycle`).
 *
 *  A LEI do pacote (derivada do BRIEF §2):
 *   I.   Detector acha, LLM explica — este slot NÃO chama LLM. As ÚNICAS chamadas LLM do ciclo
 *        vivem no M24-C (`sonoReflexao`, Haiku tool_use, op `reflect:*` metrado). O orquestrador
 *        só passa o budget K adiante.
 *   V.   Custo com teto e rastro — sono ≤ 1 tentativa/24h/brain (estado durável em
 *        galeed_sono_state, migração 31); budget K de ponta a ponta (detectSignals(config:{k})
 *        → sonoReflexao(topK:k)); rastro em log + result_json.sono + galeed_sono_state.last_trace.
 *   VI.  NOOP é saída válida — sono que não acha sinal/escreve nada ⇒ status:'noop' (sem insight
 *        forçado), MAS o estado é atualizado (dormiu, não achou — o teto/baseline contam).
 *   M3a. Fail-soft TOTAL — `maybeSono`/`runSonoCycle` NUNCA lançam; cada FASE é fail-soft
 *        individual (uma falha → trace registra, ciclo segue). Roda DEPOIS do terminal do job.
 *   5.   Serializado por brain (promise-chain in-process, padrão consolidate-step.ts:76-89).
 *   III. Tenant-neutro — zero literal de domínio; limiares/K/cooldown são config com default.
 *   IV.  Reflexão não reflete sobre reflexão — só alimenta A/B/C com fatos/fontes primários.
 *
 *  Consome (sem editar): detectSignals (../memory/signals/index.ts, M24-A), dreamV2
 *  (../memory/dream-v2.ts, M24-B — PODE lançar; fase() segura), sonoReflexao (../memory/reflect.ts,
 *  M24-C), reconcile/recomputeSalience/prune (legados úteis, 0 LLM), shedCold (../memory/tiering.ts —
 *  fase 'shed' do decaimento, achado decaimento-lixeira#1), runConsolidationStep (M23-D),
 *  getEngine (../platform/engine.ts), getSharedSql (../platform/db-conn.ts, estado durável). */
import { reconcile } from "../memory/reconcile.ts";
import { recomputeSalience, prune } from "../memory/sleep.ts";
import { shedCold } from "../memory/tiering.ts";
import { runConsolidationStep, type ConsolidacaoTrace } from "./consolidate-step.ts";
import { detectSignals } from "../memory/signals/index.ts";
import { dreamV2, type DreamV2Result } from "../memory/dream-v2.ts";
import { sonoReflexao, type ReflexaoResult } from "../memory/reflect.ts";
import type { RankedSignal } from "../memory/signals/types.ts";
import { getEngine } from "../platform/engine.ts";
import { closeSharedSql, getSharedSql, sharedSqlGeneration } from "../platform/db-conn.ts";

// ============================================================================
// §2.1 — Config (envs com default — invariante III; mesma família do GALEED_CONSOLIDATE)
// ============================================================================

export interface SonoConfig {
  ligado: boolean; // GALEED_SONO        default "1"  ("0" desliga o AUTOMÁTICO; CLI manual sempre roda)
  minFontes: number; // GALEED_SONO_MIN_FONTES   default 12  (= threshold do reflect legado, reflect.ts:25)
  minFatos: number; // GALEED_SONO_MIN_FATOS    default 50
  cooldownMs: number; // GALEED_SONO_COOLDOWN_MS  default 86_400_000  (teto 1×/24h — decisão (c) do fundador)
  budgetK: number; // GALEED_SONO_K            default 10  (BRIEF §3-priorizador: top-K global)
  pruneApply: boolean; // GALEED_SONO_PRUNE_APPLY  default "1" ("0" volta ao dry-run). Achado decaimento-lixeira#1:
  //                       decisão de produto — apply LIGADO por default, MAS sob critério AUTO ultra-conservador
  //                       (prune conservador: só página órfã E sem fatos E anterior ao cutoff = lixo genuíno).
  pruneOlderDias: number; // GALEED_SONO_PRUNE_OLDER_DIAS default 180 — idade mínima (dias) pro cutoff do prune AUTO
}

/** Pura: lê env ?? defaults. Sem IO/clock. */
export function sonoConfig(env: NodeJS.ProcessEnv = process.env): SonoConfig {
  const num = (v: string | undefined, def: number): number => {
    const n = Number(v);
    return v !== undefined && v !== "" && Number.isFinite(n) ? n : def;
  };
  return {
    ligado: (env.GALEED_SONO ?? "1") !== "0",
    minFontes: num(env.GALEED_SONO_MIN_FONTES, 12),
    minFatos: num(env.GALEED_SONO_MIN_FATOS, 50),
    cooldownMs: num(env.GALEED_SONO_COOLDOWN_MS, 86_400_000),
    budgetK: num(env.GALEED_SONO_K, 10),
    pruneApply: (env.GALEED_SONO_PRUNE_APPLY ?? "1") !== "0",
    pruneOlderDias: num(env.GALEED_SONO_PRUNE_OLDER_DIAS, 180),
  };
}

/** Pura: cutoff ISO (YYYY-MM-DD) do prune AUTO = agora − dias. Compatível com a comparação
 *  lexicográfica de datas do prune/consolidateCold (sleep.ts). Exportada p/ teste com relógio fixo. */
export function pruneCutoff(agora: Date, dias: number): string {
  return new Date(agora.getTime() - dias * 86_400_000).toISOString().slice(0, 10);
}

// ============================================================================
// §2.2 — Estado durável + shape do rastro
// ============================================================================

/** Estado do último sono por brain — tabela própria deste módulo (migração 31; DDL lazy
 *  espelhado, padrão ADR-013 do brain-context). */
export interface SonoState {
  lastSleepAt: string | null; // ISO; null = nunca dormiu
  baseline: { pages: number; facts: number }; // contagens no fim da última TENTATIVA de sono
}

export interface SonoFaseTrace {
  status: "ok" | "falhou";
  erro?: string;
  [k: string]: unknown;
}

/** Rastro do sono — vai pro result_json.sono do job (aditivo, retrocompat: jobs antigos não têm
 *  a chave — mesmo padrão do rastro consolidacao do M23-D) e pro galeed_sono_state.last_trace. */
export interface SonoTrace {
  // gate (maybeSono):           desligado | aguardando_acumulo | cooldown | fila_ocupada
  // ciclo (runSonoCycle):       dormiu | noop | parcial | falhou
  status:
    | "desligado"
    | "aguardando_acumulo"
    | "cooldown"
    | "fila_ocupada"
    | "dormiu"
    | "noop"
    | "parcial"
    | "falhou";
  fontes_novas: number; // pages_agora − baseline.pages (0 nos estados de gate sem leitura)
  fatos_novos: number; // facts_agora − baseline.facts
  budget_k: number;
  chamadas_llm: number; // ecoado de ReflexaoResult.chamadas_llm (0 fora do ciclo)
  inicio?: string; // ISO — só quando o ciclo rodou
  fim?: string;
  fases?: {
    // só quando o ciclo rodou; cada fase fail-soft individual
    reconcile?: SonoFaseTrace; // + merges: number
    consolidacao?: SonoFaseTrace; // ecoa ConsolidacaoTrace
    salience?: SonoFaseTrace; // + paginas: number
    detectores?: SonoFaseTrace; // + sinais: number (≤ K)
    sonho?: SonoFaseTrace; // ecoa DreamV2Result (resumido)
    reflexao?: SonoFaseTrace; // ecoa ReflexaoResult (varre→revalida→combina→verbaliza)
    prune?: SonoFaseTrace; // + podaveis + arquivadas (apply liga por GALEED_SONO_PRUNE_APPLY, critério conservador)
    shed?: SonoFaseTrace; // + cooled + vetores — completa archived→cold; só roda quando pruneApply
  };
  erro?: string; // só status='falhou' (mensagem legível, sem stack)
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------- schema lazy sobre a conexão compartilhada (espelho de brain-context.ts:53-74) ----------

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
    // idempotente — espelha a migração id 31 (migrations.ts). Boot lazy não depende da ordem do engine.
    await sql.unsafe(`
      create table if not exists galeed_sono_state (
        brain text primary key,
        last_sleep_at timestamptz,
        baseline jsonb not null default '{}'::jsonb,
        last_trace jsonb not null default '{}'::jsonb,
        updated_at timestamptz default now()
      )
    `);
  })();
  await _ready;
  return sql;
}

/** Fecha a conexão (testes / shutdown). No-op se nunca abriu. Espelha closeBrainContext. */
export async function closeSonoState(): Promise<void> {
  _ready = null;
  _readyGeneration = -1;
  await closeSharedSql();
}

/** Estado do último sono do brain. Linha ausente ⇒ { lastSleepAt:null, baseline:{pages:0,facts:0} }.
 *  Leitura DB-first SEM cache em memória — o teto 24h sobrevive a restart do worker (estado durável). */
export async function getSonoState(brain: string): Promise<SonoState> {
  const sql = await db();
  const rows = (await sql`
    select last_sleep_at, baseline
    from galeed_sono_state
    where brain = ${brain}
    limit 1`) as any[];
  if (!rows.length) return { lastSleepAt: null, baseline: { pages: 0, facts: 0 } };
  const r = rows[0];
  const bRaw = typeof r.baseline === "string" ? JSON.parse(r.baseline) : r.baseline ?? {};
  const pages = Number(bRaw?.pages);
  const facts = Number(bRaw?.facts);
  return {
    lastSleepAt: r.last_sleep_at ? new Date(r.last_sleep_at).toISOString() : null,
    baseline: { pages: Number.isFinite(pages) ? pages : 0, facts: Number.isFinite(facts) ? facts : 0 },
  };
}

/** Upsert do estado (grava last_trace junto — auditoria). */
export async function putSonoState(brain: string, s: SonoState, trace: SonoTrace): Promise<void> {
  const sql = await db();
  const baseline = JSON.stringify(s.baseline);
  const last = JSON.stringify(trace);
  await sql`
    insert into galeed_sono_state (brain, last_sleep_at, baseline, last_trace, updated_at)
    values (${brain}, ${s.lastSleepAt}, ${baseline}::jsonb, ${last}::jsonb, now())
    on conflict (brain) do update set
      last_sleep_at = excluded.last_sleep_at,
      baseline = excluded.baseline,
      last_trace = excluded.last_trace,
      updated_at = now()`;
}

// ============================================================================
// §2.3 — Gatilho (função PURA, testável com relógio mockado, sem DB)
// ============================================================================

export interface GatilhoInput {
  agora: Date;
  state: SonoState;
  atual: { pages: number; facts: number }; // engine.stats() do brain
  cfg: SonoConfig;
}

/** Decide se o sono automático dispara. Ordem CRAVADA dos vetos (mais barato/definitivo primeiro):
 *  1. !cfg.ligado                                     → 'desligado'
 *  2. acúmulo: (pages−baseline.pages) < minFontes
 *     E (facts−baseline.facts) < minFatos             → 'aguardando_acumulo'
 *     (basta UM dos dois eixos atingir o limiar — "≥N fontes OU fatos novos")
 *  3. teto: agora − lastSleepAt < cooldownMs          → 'cooldown'   (lastSleepAt null nunca veta)
 *  Passou os 3 → 'dorme'. PURA: sem IO/env/clock interno (o clock entra por `agora`). */
export function decideGatilho(
  g: GatilhoInput,
):
  | { dorme: true }
  | { dorme: false; motivo: "desligado" | "aguardando_acumulo" | "cooldown" } {
  if (!g.cfg.ligado) return { dorme: false, motivo: "desligado" };
  const fontesNovas = g.atual.pages - g.state.baseline.pages;
  const fatosNovos = g.atual.facts - g.state.baseline.facts;
  if (fontesNovas < g.cfg.minFontes && fatosNovos < g.cfg.minFatos) {
    return { dorme: false, motivo: "aguardando_acumulo" };
  }
  if (g.state.lastSleepAt !== null) {
    const delta = g.agora.getTime() - new Date(g.state.lastSleepAt).getTime();
    if (delta < g.cfg.cooldownMs) return { dorme: false, motivo: "cooldown" };
  }
  return { dorme: true };
}

// ============================================================================
// §2.4 — Orquestrador (runSonoCycle) — manual e automático = MESMO código
// ============================================================================

export interface SonoOpts {
  now?: () => Date; // injeção de relógio (default: () => new Date()) — gate §7.3
  filaVazia?: () => Promise<boolean>; // injeção do check de idle (default: §2.6)
}

// serialização in-process por brain (cópia do padrão consolidate-step.ts:76-89): os dois loops do
// worker (jobs + poller) e o CLI manual nunca dormem o MESMO brain em paralelo. maybeSono e
// runSonoCycle COMPARTILHAM a chain (manual e automático não interfoliam).
const chains = new Map<string, Promise<SonoTrace>>();

/** O CICLO (manual e automático — o MESMO código). NUNCA lança (fail-soft total). NÃO checa
 *  gatilho/teto/fila (isso é do maybeSono): o `galeed sleep` manual é soberano. SEMPRE atualiza
 *  o estado no fim (lastSleepAt=inicio, baseline=contagens PÓS-ciclo, last_trace). Serializado
 *  por brain (promise-chain). */
export function runSonoCycle(brain: string, opts: SonoOpts = {}): Promise<SonoTrace> {
  const prev = chains.get(brain) ?? Promise.resolve(undefined as unknown as SonoTrace);
  const next = prev.then(() => doCycle(brain, opts), () => doCycle(brain, opts)); // falha do anterior não propaga
  chains.set(brain, next);
  return next;
}

async function doCycle(brain: string, opts: SonoOpts): Promise<SonoTrace> {
  const cfg = sonoConfig();
  const now = opts.now ?? (() => new Date());
  const inicio = now().toISOString();
  const fases: NonNullable<SonoTrace["fases"]> = {};
  let falhas = 0;

  const fase = async <T>(
    nome: keyof NonNullable<SonoTrace["fases"]>,
    fn: () => Promise<T>,
    eco: (r: T) => Record<string, unknown>,
  ): Promise<T | null> => {
    try {
      const r = await fn();
      fases[nome] = { status: "ok", ...eco(r) };
      return r;
    } catch (err) {
      falhas++;
      fases[nome] = { status: "falhou", erro: msg(err) };
      return null;
    }
  };

  // NREM — consolidar (fases legadas que seguem úteis; TODAS 0 LLM):
  await fase("reconcile", () => reconcile(brain, { useLlm: false }), (r) => ({ merges: r.merges.length }));
  await fase("consolidacao", () => runConsolidationStep(brain), (c: ConsolidacaoTrace) => ({ ...c })); // ER incremental M23-D (já fail-soft)
  await fase("salience", () => recomputeSalience(brain), (r) => ({ paginas: r.updated }));

  // O CICLO NOVO (A → B → C): detectores → sonho → reflexão (varre→revalida→combina→verbaliza).
  const sinais: RankedSignal[] =
    (await fase("detectores", () => detectSignals(brain, { config: { k: cfg.budgetK } }), (s) => ({ sinais: s.length }))) ?? [];
  await fase("sonho", () => dreamV2(brain, { topK: cfg.budgetK }), (t: DreamV2Result) => ({
    hipoteses: t.hypotheses.length,
    comunidades: t.clusters.length,
    enfileiradas: t.enqueued,
    noop: t.noop,
  }));
  const reflexao = await fase(
    "reflexao",
    () => sonoReflexao(brain, sinais, { topK: cfg.budgetK }),
    (t: ReflexaoResult) => ({ ...t }),
  );

  // Poda (achado decaimento-lixeira#1 — o decaimento deixa de ser feature morta): apply LIGADO por
  // default (GALEED_SONO_PRUNE_APPLY=0 desliga), mas o critério AUTO é ultra-conservador (conservador:
  // true → só página órfã E com 0 fatos E anterior ao cutoff de GALEED_SONO_PRUNE_OLDER_DIAS vira
  // candidata — lixo genuíno). O CLI `galeed prune --apply` mantém o critério amplo. Arquivar é flag
  // reversível: fatos NÃO são apagados (galeed_facts intacto) e o restore (tiering.ts) desarquiva e
  // re-embeda. Cutoff usa o relógio injetável do ciclo (opts.now) — testável.
  await fase(
    "prune",
    () => prune(brain, { apply: cfg.pruneApply, olderThan: pruneCutoff(now(), cfg.pruneOlderDias), conservador: true }),
    (r) => ({ podaveis: r.candidates.length, arquivadas: r.archived }),
  );
  // Shed (fase nova, mesmo achado): completa archived→cold descartando o peso regenerável (vetores)
  // das arquivadas — cada fase é fail-soft individual (M3a), falha aqui não derruba o ciclo.
  if (cfg.pruneApply) {
    await fase("shed", () => shedCold(brain, { dryRun: false }), (r) => ({ cooled: r.cooled, vetores: r.vectorsShed }));
  }

  // Estado + status honesto:
  const escreveu =
    ((reflexao?.nascidas ?? 0) +
      (reflexao?.reverbalizadas ?? 0) +
      (reflexao?.revalidadas ?? 0) +
      (reflexao?.stales_novas ?? 0) +
      (reflexao?.arquivadas ?? 0) >
      0) ||
    ((fases.sonho?.enfileiradas as number) ?? 0) > 0;
  const status: SonoTrace["status"] = falhas > 0 ? "parcial" : escreveu ? "dormiu" : "noop";

  const trace: SonoTrace = {
    status,
    fontes_novas: 0,
    fatos_novos: 0,
    budget_k: cfg.budgetK,
    chamadas_llm: reflexao?.chamadas_llm ?? 0,
    inicio,
    fim: now().toISOString(),
    fases,
  };

  // Estado durável: lastSleepAt=inicio (a TENTATIVA conta pro teto), baseline=contagens PÓS-ciclo.
  // Engolir falha de putSonoState (DB fora ao gravar): o gatilho re-tenta no próximo idle e o rastro
  // fica no log + result_json.sono.
  try {
    const e = await getEngine(brain);
    const s = await e.stats();
    await putSonoState(brain, { lastSleepAt: inicio, baseline: { pages: s.pages, facts: s.facts } }, trace);
  } catch {
    /* estado não gravou — fail-soft; o ciclo já produziu o trace */
  }
  return trace;
}

// ============================================================================
// §2.5 — maybeSono (o gatilho do automático no worker)
// ============================================================================

/** O GATILHO do automático (worker): desligado → acúmulo → cooldown → fila vazia → runSonoCycle.
 *  NUNCA lança. Estados de veto NÃO atualizam o estado durável (não foi tentativa de sono) — só o
 *  ciclo grava estado. Serializado pela MESMA chain do runSonoCycle (via runSonoCycle). */
export function maybeSono(brain: string, opts: SonoOpts = {}): Promise<SonoTrace> {
  return doMaybe(brain, opts);
}

async function doMaybe(brain: string, opts: SonoOpts): Promise<SonoTrace> {
  try {
    const cfg = sonoConfig();
    const zero = { budget_k: cfg.budgetK, chamadas_llm: 0 };
    if (!cfg.ligado) return { status: "desligado", fontes_novas: 0, fatos_novos: 0, ...zero };
    const state = await getSonoState(brain);
    const e = await getEngine(brain);
    const s = await e.stats();
    const fontesNovas = Math.max(0, s.pages - state.baseline.pages);
    const fatosNovos = Math.max(0, s.facts - state.baseline.facts);
    const d = decideGatilho({
      agora: (opts.now ?? (() => new Date()))(),
      state,
      atual: { pages: s.pages, facts: s.facts },
      cfg,
    });
    if (!d.dorme) return { status: d.motivo, fontes_novas: fontesNovas, fatos_novos: fatosNovos, ...zero };
    const vazia = await (opts.filaVazia ?? filaVaziaDefault)();
    if (!vazia) return { status: "fila_ocupada", fontes_novas: fontesNovas, fatos_novos: fatosNovos, ...zero };
    const t = await runSonoCycle(brain, opts);
    return { ...t, fontes_novas: fontesNovas, fatos_novos: fatosNovos };
  } catch (err) {
    return { status: "falhou", fontes_novas: 0, fatos_novos: 0, budget_k: 0, chamadas_llm: 0, erro: msg(err) };
  }
}

// ============================================================================
// §2.6 — Check de idle (filaVaziaDefault) — leitura própria, read-only
// ============================================================================

/** O worker só dorme quando NÃO há trabalho pendente. Query read-only sobre a pool compartilhada
 *  (NÃO edita ingest-queue.ts), MESMO conjunto de status pendentes de listRepairableBrains
 *  (ingest-queue.ts:524). GLOBAL de propósito (1 worker atende todos os brains — ADR-006). Em
 *  teste num banco compartilhado o check global é flaky → os testes SEMPRE injetam opts.filaVazia. */
export async function filaVaziaDefault(): Promise<boolean> {
  const sql = await db();
  const rows = (await sql`
    select 1 from galeed_ingest_jobs
     where status in ('queued','processing','findable','digesting','batch_submitted','batch_harvesting')
     limit 1`) as any[];
  return rows.length === 0;
}
