/** SAÚDE REAL do cérebro — a saída que faltava: sono, armazenamento e fila num só GET.
 *
 *  Achado "Estado real do sono/lixeira é invisível" (consulta-e-saida): o sono grava um rastro
 *  auditável em galeed_sono_state.last_trace (sono-step.ts), mas NENHUMA rota lia essa tabela —
 *  o dono via "Sistema no ar" verde mesmo com o sono falhando todo dia. Este handler expõe:
 *   - sono:    quando dormiu, o que fez (fases + falhas), candidatas à poda (last_trace cru);
 *   - storage: contadores de peso (páginas ativas/frias/arquivadas, vetores, fatos) — antes
 *              só saíam pelo CLI `galeed sustainability`;
 *   - jobs:    a fila de ingestão POR STATUS (inclui batch, error e dead que o painel não via).
 *
 *  Handler PURO no padrão bff-percepcoes.ts (recebe home, devolve objeto serializável). ZERO LLM.
 *  RBAC: o web-server valida sessão+membership via requireBrain ANTES (mesmo nível das leituras
 *  do dono). Leitura de galeed_sono_state é feita AQUI via getSharedSql (ADR-013) — o reader do
 *  sono-step (getSonoState) não devolve last_trace e o módulo é território do worker; a rota de
 *  leitura não precisa acoplar nele. FAIL-SOFT total: cada bloco degrada pra null/{} sozinho
 *  (uma tabela ausente não derruba a tela Saúde). */
import { getEngine } from "../../core/platform/engine.ts";
import { getSharedSql } from "../../core/platform/db-conn.ts";

/** Uma fase do último sono, como o sono-step grava (status ok|falhou + contadores livres). */
export interface SonoFaseView {
  status: string;
  erro?: string;
  [k: string]: unknown;
}

/** last_trace do sono (espelha SonoTrace do sono-step.ts — shape aditivo, campos opcionais). */
export interface SonoTraceView {
  status?: string; // dormiu | noop | parcial | falhou | desligado | aguardando_acumulo | cooldown | fila_ocupada
  fontes_novas?: number;
  fatos_novos?: number;
  budget_k?: number;
  chamadas_llm?: number;
  inicio?: string;
  fim?: string;
  fases?: Record<string, SonoFaseView>;
  erro?: string;
}

export interface SaudeStorageView {
  pagesTotal: number;
  pagesHot: number;
  pagesCold: number;
  pagesArchived: number;
  vectors: number;
  facts: number;
  edges: number;
}

export interface SaudeView {
  /** null = nunca dormiu (ou estado ilegível — fail-soft). */
  sono: { lastSleepAt: string | null; updatedAt: string | null; trace: SonoTraceView | null } | null;
  /** null = engine indisponível (fail-soft). */
  storage: SaudeStorageView | null;
  /** contagem de jobs de ingestão por status cru (queued, …, batch_submitted, error, dead). {} = sem fila. */
  jobs: Record<string, number>;
}

/** Último sono do brain direto de galeed_sono_state (a tabela é write-only em produção até aqui). */
async function lerSono(home: string): Promise<SaudeView["sono"]> {
  try {
    const sql = await getSharedSql();
    const rows = (await sql`
      select last_sleep_at, last_trace, updated_at
      from galeed_sono_state
      where brain = ${home}
      limit 1`) as any[];
    if (!rows.length) return null; // nunca dormiu
    const r = rows[0];
    const traceRaw = typeof r.last_trace === "string" ? JSON.parse(r.last_trace) : r.last_trace;
    const trace =
      traceRaw && typeof traceRaw === "object" && Object.keys(traceRaw).length
        ? (traceRaw as SonoTraceView)
        : null;
    return {
      lastSleepAt: r.last_sleep_at ? new Date(r.last_sleep_at).toISOString() : null,
      updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
      trace,
    };
  } catch {
    return null; // fail-soft: sem DATABASE_URL / tabela ainda não criada → a tela mostra "nunca dormiu"
  }
}

/** Fila de ingestão por status — 1 SELECT agregado (sem varrer linhas). */
async function contarJobs(home: string): Promise<Record<string, number>> {
  try {
    const sql = await getSharedSql();
    const rows = (await sql`
      select status, count(*)::int as n
      from galeed_ingest_jobs
      where brain = ${home}
      group by status`) as any[];
    const out: Record<string, number> = {};
    for (const r of rows) out[String(r.status)] = Number(r.n) || 0;
    return out;
  } catch {
    return {}; // fail-soft: fila ainda sem tabela → sem contadores
  }
}

/** GET /api/saude → SaudeView. Leitura pura; cada bloco degrada sozinho. */
export async function saudeHandler(home: string): Promise<SaudeView> {
  const [sono, jobs] = await Promise.all([lerSono(home), contarJobs(home)]);
  let storage: SaudeStorageView | null = null;
  try {
    const s = await (await getEngine(home)).storageStats();
    storage = {
      pagesTotal: s.pagesTotal,
      pagesHot: s.pagesHot,
      pagesCold: s.pagesCold,
      pagesArchived: s.pagesArchived,
      vectors: s.vectors,
      facts: s.facts,
      edges: s.edges,
    };
  } catch {
    storage = null; // fail-soft
  }
  return { sono, storage, jobs };
}
