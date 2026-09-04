/** M8/S3 — Cliente tipado da API do Galeed (superfície da ARCHITECTURE §5).
 *
 *  O front NUNCA fala com o banco — só com o BFF (`src/connectors/web-server.ts`).
 *  - Base URL vazia: mesmo host. Em dev o Vite proxia /api e /auth → BFF :8789.
 *  - `credentials: "include"` em TODAS as chamadas (cookie de sessão httpOnly `galeed_sess`).
 *  - O brain atual é injetado automaticamente (`?brain=<id>`) em toda chamada de leitura/tenant.
 *    O auth context chama `setCurrentBrain(id)` quando o usuário troca de brain.
 *  - Erros viram `ApiError{status,message}` (throw). 401 dispara o evento global
 *    `galeed:unauthorized` para o AuthProvider tratar (limpar sessão / redirecionar).
 *
 *  Zero deps de dados (fetch nativo).
 */

// ---------------------------------------------------------------------------
// Tipos canônicos (§5) — leitura
// ---------------------------------------------------------------------------

export interface Selo {
  status: "fato" | "hipotese" | "arquivado" | "registrado";
  confidence: number;
  tipo: string;
  fonte: string;
  valid_from: string | null;
  valid_to: string | null;
  supersede?: { texto: string; valid: string } | null;
  tags: string[];
  via: "vec" | "fts" | "grafo" | string;
  cite: string;
  /** cadeado de sigilo (M7) */
  sensitivity?: "publico" | "interno" | "sensivel" | "restrito";
}

export interface RetrieveHit {
  slug: string;
  type: string;
  title: string;
  date: string;
  excerpt: string;
  via: string;
  selo: Selo;
}

/** Fato tipado do M9 (espelha FactItem do BFF src/connectors/bff-m9.ts). valid_to "" = vigente. */
export interface FactItem {
  source_slug: string;
  dimension?: string; // decisions | facts | action_items | quotes… (o /api/timeline devolve; o Dossiê agrupa por ela)
  quote?: string; // trecho literal da fonte (âncora), quando o endpoint devolver
  text?: string; // conteúdo do fato (dims textuais: decisions/entities/quotes…) — é o que importa quando não é claim numérico
  entity?: string;
  predicate?: string;
  value?: string; // grafia original p/ exibição ("R$ 30 mil")
  value_num?: number | null; // valor numérico CRU (30000) — null/ausente = não-numérico
  unit?: string; // "BRL" | "USD" | "pct" | …
  period?: string; // "monthly" | "annual" | …
  tier?: string; // "enterprise" | "pro" | "starter" | … ("" = sem tier)
  valid_from?: string;
  valid_to?: string; // "" = vigente
  status?: string; // "fato" | "arquivado" | "hipotese" | "registrado"
  confidence?: number;
}

export interface AskAnswer {
  answer: string;
  highlights?: string[];
  citations: RetrieveHit[];
  facts?: FactItem[]; // M10/S2: série por tier da entidade da pergunta (pode ser vazio)
  lowConfidence?: boolean;
  gaps?: string[];
}

/** Rollup de custo de extração por brain (M9/S2 — /api/cost, só owner). */
/** M18/S3 (seam) — handlers do streaming SSE. onToken por delta de prosa; onDone com a carga ANCORADA
 *  (citations/facts/gaps, MESMO shape do /api/ask) no evento `done`; onError no erro do servidor OU de
 *  transporte (o caller cai no fallback api.ask bloqueante). */
export interface AskStreamHandlers {
  onToken: (delta: string) => void;
  onDone: (payload: { citations?: RetrieveHit[]; facts?: FactItem[]; gaps?: string[] }) => void;
  onError: (err: Error) => void;
}

/** Quebra de custo por operação ou por modelo (M20). */
export interface CostBreakdown {
  op?: string;
  model?: string;
  calls: number;
  cost_usd: number;
  tokens_in: number;
  tokens_out: number;
}
/** Rollup de custo REAL de IA por brain (M20 — /api/cost, só owner). Soma extração, síntese, perguntas
 *  e embeddings (galeed_llm_usage), com quebra por operação e por modelo. */
export interface CostRollup {
  calls: number;
  cost_usd_total: number;
  tokens_in_total: number;
  tokens_out_total: number;
  by_op: CostBreakdown[];
  by_model: CostBreakdown[];
}

export interface Stats {
  pages: number;
  facts: number;
  edges: number;
  vectors: number;
}

export interface GraphNode {
  id: string;
  label: string;
  type: string;
  date: string;
  exists: boolean;
  factCount: number;
  /** grafo de entidades (Mapa): "org" | "pessoa" | "assunto" */
  role?: string;
}
export interface GraphEdge {
  src: string;
  dst: string;
  kind: string;
  /** co-ocorrência: nº de fontes em comum (peso da ligação) */
  weight?: number;
}
export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** Um fato ligado a uma entidade (inspetor do Mapa). Espelha GraphQueryHit do core. */
export interface EntityFact {
  direction: "out" | "in";
  entity: string;
  predicate: string;
  value: string;
  value_num?: number | null;
  unit?: string;
  period?: string;
  tier?: string;
  text: string;
  confidence: number;
  source_slug: string;
  valid_from: string;
  valid_to: string; // "" = vigente
}

/** M24-E — percepção do cérebro (espelha PercepcaoView do BFF bff-percepcoes.ts). */
export type PercepcaoEstado = "viva" | "stale" | "arquivada";
export interface Percepcao {
  id: string;
  classe: string;
  severidade: "alta" | "media" | "baixa" | "info";
  entity: string;
  predicate: string;
  tier: string;
  texto: string;
  numbers: Record<string, number | string>;
  cites: { source_slugs: string[] };
  estado: PercepcaoEstado;
  created_at: string;
  validated_at: string;
}
export interface PercepcoesPage {
  items: Percepcao[];
  counts: { viva: number; stale: number; arquivada: number };
  limit: number;
  offset: number;
}

// --- Saúde interna (GET /api/saude — espelha SaudeView do BFF bff-saude.ts) ---
/** Uma fase do último sono (status ok|falhou + contadores livres do detector/poda). */
export interface SonoFaseView {
  status: string;
  erro?: string;
  [k: string]: unknown;
}
/** Rastro do último sono (galeed_sono_state.last_trace — shape aditivo, campos opcionais). */
export interface SonoTraceView {
  status?: string; // dormiu | noop | parcial | falhou | desligado | aguardando_acumulo | cooldown | fila_ocupada
  fontes_novas?: number;
  fatos_novos?: number;
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
  sono: { lastSleepAt: string | null; updatedAt: string | null; trace: SonoTraceView | null } | null;
  storage: SaudeStorageView | null;
  jobs: Record<string, number>; // fila de ingestão por status cru (queued/…/batch_*/error/dead)
}

// --- Lixeira de páginas (GET /api/lixeira + POST /api/lixeira/restaurar — bff-lixeira.ts) ---
export interface LixeiraItem {
  slug: string;
  type: string;
  title: string;
  date: string;
  tier: string; // 'hot' | 'cold' (cold re-embeda ao restaurar)
}
export interface LixeiraPage {
  items: LixeiraItem[];
  total: number;
}
export interface RestauroResult {
  slug: string;
  restored: boolean; // false = não existe ou já está ativa
  vectorsRebuilt: number;
}

// ---------------------------------------------------------------------------
// Tipos canônicos (§6) — auth & multi-tenant
// ---------------------------------------------------------------------------

export interface Brain {
  id: string;
  name: string;
  role: "owner" | "member";
}

export interface Session {
  account: { id: string; name: string; email: string };
  brains: Brain[];
  currentBrain: string;
}

// ---------------------------------------------------------------------------
// Tipos RBAC / Acesso (_design/acesso.md §6) — shapes idênticos no mock e no M7
// ---------------------------------------------------------------------------

export type Sensitivity = "publico" | "interno" | "sensivel" | "restrito";
export type PrincipalKind = "human" | "agent";

export interface Grant {
  areas: string[];
  sensitivity_max: Sensitivity;
  deny_types: string[];
  scope: "read" | string;
}

export interface Token {
  label: string;
  last4: string;
  revoked: boolean;
  last_used_at: string | null;
}

export interface UiLevel {
  code: "open" | "int" | "conf" | "secret";
  label: string;
  rank: number;
}

/** área REAL do cérebro (GET /api/rbac/areas): derivada das tags area: + grants. */
export interface AreaView {
  slug: string;
  label: string;
  count: number; // memórias etiquetadas com a área (0 = só citada em grant)
}

export interface Principal {
  id: string;
  kind: PrincipalKind;
  label: string;
  email: string;
  status: "active" | "disabled";
  subline: string;
  grant: Grant;
  tokens: Token[];
  ui_level: UiLevel;
  areas_labels: string[];
}

/** Corpo de Convidar/Editar (§6.2). Espelha `setGrant(home, {...})` do M7. */
export interface GrantReq {
  kind: PrincipalKind;
  label: string;
  email?: string;
  areas: string[];
  sensitivityMax: Sensitivity;
  denyTypes?: string[];
}

/** Convite = criar principal + grant inicial (passos 1–3 do modal). */
export interface InviteReq extends GrantReq {
  subline?: string;
}

export interface AccessPreviewResult {
  kind?: "fact" | string;
  level?: string;
  area?: string;
  quote?: string;
  blocked?: boolean;
  reason?: "area" | "sensitivity" | string;
  label?: string;
}

export interface AccessPreview {
  scope: { principalId: string; areas: string[]; sensitivityMax: Sensitivity };
  visiblePages: number;
  visibleFacts: number;
  blocked: number;
  sampleSlugs: string[];
  results: AccessPreviewResult[];
}

export interface AccessLogEntry {
  principal_id: string;
  ts: string;
  query: string;
  areas_touched: string[];
  n_returned: number;
  event?: string | null;   // null = consulta; senão evento de governança
  actor?: string | null;   // quem fez a ação (dono)
}

// ---------------------------------------------------------------------------
// Onboarding de contexto (M11/S4) — espelha bff-onboarding.ts. O usuário NUNCA vê JSON;
// a tela mostra `question` (balão) e `card` (cartão-resumo legível). O `draft`/`state` viaja opaco.
// ---------------------------------------------------------------------------

export type OnbStep = "self" | "purpose" | "roles" | "sourceTypes" | "review" | "done";
export interface OnbRoleSpec { role: "self" | "client" | "host" | "participant" | "other"; speakers: string[]; label: string; }
export interface OnbSourceTypeSpec { type: string; label: string; otherRole: OnbRoleSpec["role"]; }
export interface OnbSelf { slug: string; label: string; aliases: string[]; }
export interface OnbContext { self: OnbSelf; purpose: string; roles: OnbRoleSpec[]; sourceTypes: OnbSourceTypeSpec[]; }
export interface OnbState { step: OnbStep; draft: OnbContext; asked: string[]; }
export interface OnbTurn { state: OnbState; question: string; card: string; done: boolean; }

// Ajustes do contexto + re-extração (M11/S6) — fundem na MESMA chave api.context.
export interface ContextView { context: OnbContext; version: number; card: string; }
export interface PreviewResult { summary: string; }
export interface ReextractEstimate { staleDocs: number; totalDocs: number; costUsdEstimate: number; }
export interface ReextractResult { reextracted: number; message: string; }

// Import via front (M11/S5 → M12: assíncrono).
export interface IngestResult { kind: string; total: number; slugs: string[]; skipped: number; message: string; }
export type IngestJobStatus =
  | "queued"
  | "processing"
  | "findable"   // M15/S2 — Fase A concluída: o cérebro já é BUSCÁVEL (FTS+embeddings), digestão em background
  | "digesting"  // M15/S2 — Fase B: extraindo fatos (LLM nas units worthy)
  | "batch_submitted"  // M16 — lote enviado à Anthropic (digestão em lote; pode levar minutos/horas)
  | "batch_harvesting" // M16 — lote pronto, colhendo os resultados
  | "digested"   // M15/S2 — terminal de sucesso novo (sinônimo de "done" p/ a UI; retrocompat)
  | "done"
  | "error"
  | "dead";      // P0-C — interrompido N× sem completar (reaper desistiu); terminal, com motivo

/** Lista CANÔNICA dos status NÃO-terminais da fila (fonte única — Adicionar e Painel importam daqui).
 *  A raiz do bug "painel cego aos estados de lote" era esta lista duplicada à mão em duas telas:
 *  quando batch_submitted/batch_harvesting nasceram no servidor, o polling morria e o job sumia do
 *  contador. Novo status não-terminal? Adicione AQUI (e só aqui). */
export const INGEST_NAO_TERMINAIS: IngestJobStatus[] = [
  "queued",
  "processing",
  "findable",
  "digesting",
  "batch_submitted",
  "batch_harvesting",
];
/** Resposta do upload assíncrono (M12): o arquivo virou um job na fila. */
export interface EnqueueResult { jobId: string; status: IngestJobStatus; }
/** Job de ingestão (espelha src/core/ingest-queue.ts) — o front faz polling do status/progresso. */
export interface IngestJob {
  id: string;
  brain: string;
  kind: "file" | "text";
  status: IngestJobStatus;
  type: string;            // tipo declarado (call de venda, aula…)
  filename: string | null;
  progress: number;        // 0..1
  message: string | null;  // resumo legível ("Entrou 1 documento (3 partes).")
  errorMessage: string | null; // motivo quando status="error"
  resultJson?: Record<string, unknown>;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

// ---------------------------------------------------------------------------
// Fontes com receita + fila de revisão (M21/S3 — espelham SourceRow/HypothesisView do BFF)
// ---------------------------------------------------------------------------

export interface SourceRecipeField { dimension: string; label: string; area: string }
export interface SourceRecipe { fields: SourceRecipeField[]; guidance?: string; triage_profile?: string }
/** M22-D — estado da conexão do conector (espelha SourceConnectionView do M22-A §4.5, migração 29;
 *  nunca vem do /api/sources — é MESCLADO client-side via GET /api/connectors/status). */
export type ConnectorStatus = "desconectado" | "conectado" | "erro";
export interface ConnectorState {
  provider: string;
  connection_id: string | null;
  status: ConnectorStatus;
  last_sync_at: string | null;
  last_error: string | null;
}
/** M22-D — resposta de POST /api/sources/:id/connect (espelha data de POST /connect/sessions do
 *  Nango — https://nango.dev/docs/reference/api/connect/sessions/create ; expira em 30 min). */
export interface ConnectStart {
  provider: string;
  token: string;
  connect_link: string;
  expires_at: string;
}
/** M22-D — resposta de GET /api/connectors/status (espelha SourceConnectionView do A §4.5). */
export interface ConnectorStatusRow extends ConnectorState { source_id: string }
export interface ConnectorsStatus { sources: ConnectorStatusRow[] }
/** WhatsApp / Evolution — GET/POST /api/evolution/* */
export interface EvolutionStatus {
  configured: boolean;
  online: boolean;
  instanceName: string | null;
  state: string | null;
  connected: boolean;
  qrBase64: string | null;
  webhookHint: string | null;
  lastError: string | null;
  message?: string;
}
/** ChatGPT/Codex OAuth — GET/POST /api/llm/codex/* (tokens no banco; nunca na resposta). */
export interface CodexOauthStatus {
  connected: boolean;
  expiresAt?: string;
  pending?: boolean;
  userCode?: string;
  verificationUrl?: string;
}
export interface CodexOauthStart {
  verificationUrl: string;
  userCode: string;
  interval: number;
}
export interface Source {
  id: string; name: string;
  /** "upload" | "paste" para fontes manuais; fontes-conector chegam com o channel do SEED
   *  ("conta-azul"/"gmail" — M22-A §2.3); o union literal vira aberto sem perder autocomplete. */
  channel: "upload" | "paste" | (string & {});
  type: string;
  recipe: SourceRecipe; default_sensitivity: string; status: "ativa" | "pausada";
  last_read_at: string | null; created_at?: string;
  pages_count?: number; facts_count?: number;
  /** M22-D — populado pelo MERGE client-side; nunca vem do /api/sources. */
  connector?: ConnectorState | null;
}
export type ReviewReason = "fora_da_receita" | "nao_ancorado" | "entidade_vaga" | "conexao_sugerida";
export type ReviewStatus = "pendente" | "aprovada" | "descartada";
/** M25-B (migração 32) — recomendação do juiz persistida no item ("" = juiz não passou por aqui). */
export type JudgeRecomendacao = "" | "aprovar" | "descartar" | "humano";
export interface Hypothesis {
  id: string; source_id: string; source_name: string; source_slug: string;
  dimension: string; text: string; quote: string;
  reason: ReviewReason; status: ReviewStatus;
  decided_by: string; created_at?: string; decided_at?: string | null;
  /** M25-B (migração 32) — ausentes em BFF sem o juiz; na amostra dos grupos vêm do join do A,
   *  na lista um-a-um vêm do join adjudicado do Integrador (até lá ausentes → "" via logic.ts). */
  recomendacao?: JudgeRecomendacao;
  recomendacao_motivo?: string;
  recomendacao_confianca?: number | null;
  recomendado_em?: string | null;
}
export interface HypothesesCount { pendente: number; aprovada: number; descartada: number }

// ---------------------------------------------------------------------------
// M25-C — fila em escala (grupos + lote) e juiz triador.
// Shapes CONSUMIDOS de M25-A (groups/lote) e M25-B (juiz/calibração). Os nomes seguem o
// ADENDO DO ÁRBITRO (specs/slots/M25/M25-C-DESIGN-SPEC.md §9 — vale sobre §3.1/§3.2 onde diverge).
// ---------------------------------------------------------------------------

/** M25-A — um grupo-decisão da fila (reason × dimension × fonte). Array PURO no wire (§9.1.1). */
export interface HypothesisGroup {
  reason: ReviewReason;
  dimension: string;
  source_id: string;     // "" = sem fonte (conexões sugeridas pelo sonho)
  source_name: string;
  count: number;
  decisao: string;       // frase PT pronta da decisão que o grupo representa (dono: M25-A)
  paginas?: number;          // §9.1.2 — nº de páginas afetadas (opcional, uso informativo)
  dimensao_na_receita?: boolean; // §9.1.2 — a dim já está na receita da fonte (opcional)
  amostra: Hypothesis[]; // até 3 itens (§9.1.2 — campo chama `amostra`, não `sample`)
  recomendacoes?: { aprovar: number; descartar: number; humano: number; sem_recomendacao: number };
}
/** M25-A — resultado de ação de lote: números SEMPRE, retidos com porquê legível (§9.1.4). */
export interface BatchRetido { id: string; porque: string }
export interface BatchApproveResult {
  ok?: true; aprovados: number; retidos: BatchRetido[];
  ja_decididos?: number; paginas_derivadas?: number;  // §9.1.4 — extras opcionais
}
export interface BatchDiscardResult { ok?: true; descartados: number; ja_decididos?: number }
/** §9.1.3 — add-dimension devolve `receita_atualizada` + os números do re-gate. */
export interface RecipeBatchResult extends BatchApproveResult { receita_atualizada: boolean }

/** M25-B — estimativa do juiz (read-only, zero LLM; §9.2.1). */
export interface JudgeEstimate { itens: number; custo_usd_estimado: number; batch: boolean }
/** M25-B — espelha o JudgeRunResult REAL do B (§9.2.3). Polling = re-POST de /judge. */
export interface JudgeRun {
  status: "concluido" | "batch_submetido" | "batch_em_andamento" | "nada_a_julgar";
  julgados: number;
  distribuicao: { aprovar: number; descartar: number; humano: number };
  pendentes_sem_recomendacao: number;
  erros: number; pulados: number; custo_usd: number;
  batch_id?: string; mensagem: string;
}
/** M25-B — calibração por segmento (§9.2.4 — `decididos`/`acerto`, taxa/acerto 0..1). */
export interface JudgeCalibrationSegment {
  dimension: string; source_id: string; reason: ReviewReason; source_name?: string;
  decididos: number; acertos: number; acerto: number; abstencoes?: number;
}
export interface JudgeCalibration {
  segmentos: JudgeCalibrationSegment[];
  total: { decididos: number; acertos: number; acerto: number; abstencoes?: number; sem_recomendacao?: number };
}

// ---------------------------------------------------------------------------
// Wizard de criação de cérebro (M21/S4 — espelham bff-wizard.ts; draft viaja OPACO)
// ---------------------------------------------------------------------------

export type WizardStep = "purpose" | "areas" | "sources" | "sensitivity" | "review" | "done";
export interface WizardPanel {
  name: string; status: string; purpose: string; areas: string[];
  sources: { name: string; fields: string[]; areas: string[] }[];
  rules: string[];
}
export interface WizardState { step: WizardStep; draft: unknown; asked: string[] }
/** chip RICO do passo `sources` (M21/fix-2): toggle multi-seleção + chip `go` ("Pronto →"). */
export interface WizardChip { label: string; kind?: "toggle" | "go"; selected?: boolean }
export interface WizardTurn {
  state: WizardState; question: string; card: string;
  suggestions: string[]; chips: WizardChip[]; panel: WizardPanel; done: boolean;
}

// ---------------------------------------------------------------------------
// Núcleo: erro, brain atual, fetch helpers
// ---------------------------------------------------------------------------

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

const BASE = ""; // mesmo host (Vite proxia em dev; servido junto em prod)

/** Brain atual injetado nas chamadas de tenant. O AuthProvider chama setCurrentBrain. */
let currentBrain = "";
export function setCurrentBrain(id: string): void {
  currentBrain = id || "";
}
export function getCurrentBrain(): string {
  return currentBrain;
}

/** Evento global de não-autorizado (401). O AuthProvider escuta e limpa a sessão. */
const UNAUTHORIZED_EVENT = "galeed:unauthorized";
export { UNAUTHORIZED_EVENT };

function emitUnauthorized(): void {
  if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
    window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
  }
}

/** Evento global de pagamento requerido (402 — saldo de créditos insuficiente). O AppShell escuta e
 *  abre o modal de recarga/assinatura. */
export const PAYMENT_REQUIRED_EVENT = "galeed:payment-required";
export interface PaymentRequiredDetail {
  balance: number | null;
  needed: number | null;
  message: string;
  /** "cap" = teto de gasto atingido (ajustar teto), "balance" = saldo insuficiente (recarregar),
   *  "entitlement" = pagamento pendente da assinatura (atualizar método no portal). */
  reason: "cap" | "balance" | "entitlement" | null;
}
function emitPaymentRequired(detail: PaymentRequiredDetail): void {
  if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
    window.dispatchEvent(new CustomEvent(PAYMENT_REQUIRED_EVENT, { detail }));
  }
}
export function onPaymentRequired(cb: (d: PaymentRequiredDetail) => void): () => void {
  const h = (e: Event) => cb((e as CustomEvent<PaymentRequiredDetail>).detail);
  window.addEventListener(PAYMENT_REQUIRED_EVENT, h);
  return () => window.removeEventListener(PAYMENT_REQUIRED_EVENT, h);
}

type Query = Record<string, string | number | boolean | undefined | null>;

/** Monta querystring; anexa o brain atual quando `tenant` (default true). */
function qs(query: Query | undefined, tenant: boolean): string {
  const params = new URLSearchParams();
  if (tenant && currentBrain) params.set("brain", currentBrain);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === "") continue;
      params.set(k, String(v));
    }
  }
  const s = params.toString();
  return s ? `?${s}` : "";
}

/** Extrai uma mensagem de erro legível do corpo (JSON {error}/{message} ou texto). */
function errMessage(status: number, raw: string): string {
  try {
    const j = JSON.parse(raw);
    if (j && typeof j === "object") {
      const m = (j as Record<string, unknown>).error ?? (j as Record<string, unknown>).message;
      if (typeof m === "string" && m) return m;
    }
  } catch {
    /* não era JSON */
  }
  return raw.slice(0, 200) || `HTTP ${status}`;
}

async function request<T>(
  path: string,
  opts: { method?: string; body?: unknown; query?: Query; tenant?: boolean; timeoutMs?: number } = {},
): Promise<T> {
  const tenant = opts.tenant ?? true;
  const init: RequestInit = {
    method: opts.method || "GET",
    credentials: "include",
    headers: {},
  };
  if (opts.body !== undefined) {
    (init.headers as Record<string, string>)["content-type"] = "application/json";
    init.body = JSON.stringify(opts.body);
  }
  const ctrl = opts.timeoutMs ? new AbortController() : null;
  const timer = opts.timeoutMs ? setTimeout(() => ctrl!.abort(), opts.timeoutMs) : null;
  if (ctrl) init.signal = ctrl.signal;

  let res: Response;
  try {
    res = await fetch(BASE + path + qs(opts.query, tenant), init);
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      throw new ApiError(0, "A Evolution não respondeu a tempo. Tente de novo ou Renovar QR.");
    }
    throw new ApiError(0, `falha de rede: ${(e as Error).message}`);
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (res.status === 401) {
    emitUnauthorized();
    const raw = await res.text().catch(() => "");
    throw new ApiError(401, errMessage(401, raw) || "não autenticado");
  }
  if (res.status === 402) {
    // saldo de créditos insuficiente — avisa o AppShell (modal de recarga) E lança p/ o caller.
    const raw = await res.text().catch(() => "");
    let detail: PaymentRequiredDetail = { balance: null, needed: null, message: errMessage(402, raw), reason: null };
    try {
      const j = JSON.parse(raw) as Record<string, unknown>;
      detail = {
        balance: (j.balance as number) ?? null,
        needed: (j.needed as number) ?? null,
        message: (j.error as string) || detail.message,
        reason:
          j.reason === "cap"
            ? "cap"
            : j.reason === "balance"
              ? "balance"
              : j.reason === "entitlement"
                ? "entitlement"
                : null,
      };
    } catch {
      /* não era JSON */
    }
    emitPaymentRequired(detail);
    throw new ApiError(402, detail.message);
  }
  if (!res.ok) {
    const raw = await res.text().catch(() => "");
    throw new ApiError(res.status, errMessage(res.status, raw));
  }

  // 204 / corpo vazio
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

const get = <T>(path: string, query?: Query, tenant = true) => request<T>(path, { query, tenant });
const post = <T>(path: string, body?: unknown, query?: Query, tenant = true) =>
  request<T>(path, { method: "POST", body, query, tenant });
const del = <T>(path: string, query?: Query, tenant = true) =>
  request<T>(path, { method: "DELETE", query, tenant });
const put = <T>(path: string, body?: unknown, query?: Query, tenant = true) =>
  request<T>(path, { method: "PUT", body, query, tenant });

// ---------------------------------------------------------------------------
// Superfície pública (§5)
// ---------------------------------------------------------------------------

/** M-PAY — billing (assinatura, créditos, fundador). */
export interface Subscription {
  tier: string | null;
  cohort?: string | null;
  status: string | null;
  current_period_end?: string | null;
  cancel_at_period_end?: boolean;
  /** M-PAY-H — janela de graça (ISO) quando past_due; após vencer, as ações pagas bloqueiam. */
  grace_until?: string | null;
}
export interface CreditBalance {
  balance: number | null;
}
export interface FounderSeats {
  total: number | null;
  used: number | null;
  remaining: number | null;
}
/** M-PAY front — visão do ledger (saldo+split, consumo por dia, histórico). Números computados no
 *  servidor (fonte canônica); a tela só renderiza. */
export interface LedgerEntry {
  id: number;
  delta: number; // <0 gasto, >0 ganho
  bucket: string;
  reason: string;
  brain: string | null;
  op: string | null; // ask | ingest | capture | null
  created_at: string;
}
export interface LedgerSummary {
  grant: number; // denominador do anel (bolo do tier ou teste)
  balance: number | null;
  spentIngest: number; // gasto do ciclo (mês), por op
  spentAsk: number;
  spentTotal: number;
  trialExpiresAt?: string | null; // M-PAY-H — ISO da expiração do trial (null = sem trial pendente)
  readOnly?: boolean; // M-PAY-H — saldo 0 e sem assinatura ativa → conta em modo leitura
  consumptionPct?: number; // M-PAY-H (Onda 4) — % do bolo consumido no ciclo (0..100+)
  alertPct?: number; // M-PAY-H (Onda 4) — maior limiar de alerta já disparado (0/60/80/90)
  topupRemaining?: number; // M-PAY-H/10 — parcela PRÉ-PAGA do saldo (gastável mesmo sob lapsed)
}
export interface LedgerView {
  summary: LedgerSummary;
  daily: { date: string; ing: number; ask: number }[];
  entries: LedgerEntry[];
}
/** M-PAY front — teto de gasto (limite em créditos; UI mostra R$ = créditos × R$0,02). */
export interface SpendCap {
  enabled: boolean;
  killSwitch: boolean;
  limitCredits: number;
  cycleSpentCredits: number;
  trialExpiresAt?: string | null; // M-PAY-H — ISO da expiração do trial (null = sem trial pendente)
  readOnly?: boolean; // M-PAY-H — saldo 0 e sem assinatura ativa → conta em modo leitura
}

/** M-PAY-H (Onda 4) — preferências de billing: auto-recarga opt-in + sinais de dunning. O id do método
 *  salvo NUNCA volta ao cliente (só `hasPaymentMethod`). */
export interface BillingPrefs {
  autorechargeEnabled: boolean;
  autorechargeThresholdCredits: number;
  autorechargePackage: string | null;
  hasPaymentMethod: boolean;
  needsAction: boolean;
  disputeOpen: boolean;
}

export const api = {
  // --- leitura (read API; brain injetado pelo cliente) ---
  stats: () => get<Stats>("/api/stats"),

  graph: (opts?: { asOf?: string }) => get<GraphData>("/api/graph", { asOf: opts?.asOf }),

  /** Fatos ligados a uma entidade (inspetor do Mapa ao clicar num nó). */
  entity: (name: string) => get<EntityFact[]>("/api/entity", { entity: name }),

  retrieve: (q: string, k = 6, opts?: { asOf?: string }) =>
    get<RetrieveHit[]>("/api/retrieve", { q, k, asOf: opts?.asOf }),

  search: (q: string, opts?: { type?: string; k?: number }) =>
    get<RetrieveHit[]>("/api/search", { q, type: opts?.type, k: opts?.k }),

  facts: (dim: string, opts?: { type?: string; asOf?: string; current?: boolean; limit?: number }) =>
    get<FactItem[]>("/api/facts", {
      dim,
      type: opts?.type,
      asOf: opts?.asOf,
      current: opts?.current ? 1 : undefined,
      k: opts?.limit,
    }),

  // `limit` viaja como `k` (o nome que o servidor lê). Padrão N+1 pros consumidores detectarem
  // truncamento: peça limit = N+1 e, se vierem mais que N, mostre "mostrando os N primeiros".
  timeline: (entity: string, opts?: { pred?: string; limit?: number }) =>
    get<FactItem[]>("/api/timeline", { entity, pred: opts?.pred, k: opts?.limit }),

  ask: (q: string) => get<AskAnswer>("/api/ask", { q }),

  /** M18/S3 (seam) — síntese STREAMADA via SSE. Abre EventSource GET /api/ask/stream?q=…&brain=…
   *  (cookie same-origin vai junto). Acumula `data:{t}` via onToken; no evento `done` parseia a carga
   *  ancorada e chama onDone+fecha; em event `error` (servidor) OU onerror de transporte → onError+fecha.
   *  Devolve `close()` p/ o caller abortar (desmonta/nova pergunta) — não vaza a conexão. */
  askStream(q: string, h: AskStreamHandlers): { close: () => void } {
    const es = new EventSource(BASE + "/api/ask/stream" + qs({ q }, true), { withCredentials: true });
    let closed = false;
    const close = (): void => { if (!closed) { closed = true; es.close(); } };

    es.onmessage = (ev: MessageEvent) => { // eventos `data:` SEM `event:` = tokens de prosa
      try {
        const d = JSON.parse(ev.data);
        if (typeof d?.t === "string") h.onToken(d.t);
      } catch { /* delta malformado: ignora */ }
    };
    es.addEventListener("done", (ev: MessageEvent) => {
      try { h.onDone(JSON.parse(ev.data)); } catch { h.onDone({}); }
      close();
    });
    es.addEventListener("error", (ev: MessageEvent) => { // erro EMITIDO pelo servidor (event:error, com .data)
      let msg = "stream falhou";
      try { const d = JSON.parse(ev.data); if (d?.error) msg = d.error; } catch { /* sem data */ }
      h.onError(new Error(msg));
      close();
    });
    es.onerror = () => { // erro de TRANSPORTE (rede/sem suporte/queda) — sem .data
      if (closed) return; // já fechado por done/error → ignora (gotcha: EventSource dispara onerror ao fechar)
      h.onError(new Error("conexão de streaming caiu"));
      close();
    };
    return { close };
  },

  /** Rollup de custo de extração (M9/S2 — só owner; 403 se não for dono). */
  cost: () => get<CostRollup>("/api/cost"),

  // --- auth / contas (BFF /auth/*) — sem brain na query ---
  auth: {
    signup: (p: { name: string; email: string; password: string; brainName?: string }) =>
      post<Session>("/auth/signup", p, undefined, false),
    login: (p: { email: string; password: string }) =>
      post<Session>("/auth/login", p, undefined, false),
    logout: () => post<void>("/auth/logout", undefined, undefined, false),
    /** me() devolve null se não houver sessão (BFF responde 200 + null). */
    me: () => get<Session | null>("/auth/me", undefined, false),
  },

  // --- billing (M-PAY: assinatura, créditos, top-up, portal, fundador) — account-scoped (sem brain) ---
  billing: {
    subscription: () => get<Subscription>("/api/billing/subscription", undefined, false),
    credits: () => get<CreditBalance>("/api/billing/credits", undefined, false),
    founder: () => get<FounderSeats>("/api/billing/founder", undefined, false),
    checkout: (tier: string, cohort?: string) =>
      post<{ url: string }>("/api/billing/checkout", { tier, cohort }, undefined, false),
    topup: (pkg: string) => post<{ url: string }>("/api/billing/topup", { package: pkg }, undefined, false),
    portal: () => post<{ url: string }>("/api/billing/portal", undefined, undefined, false),
    /** Ledger p/ saldo+split, gráfico de consumo e histórico (account-scoped). */
    ledger: (opts?: { limit?: number; days?: number }) =>
      get<LedgerView>("/api/billing/ledger", { limit: opts?.limit, days: opts?.days }, false),
    cap: () => get<SpendCap>("/api/billing/cap", undefined, false),
    setCap: (b: { enabled: boolean; killSwitch: boolean; limitCredits: number }) =>
      put<SpendCap>("/api/billing/cap", b, undefined, false),
    /** M-PAY-H (Onda 4) — preferências de auto-recarga + sinais de dunning. */
    prefs: () => get<BillingPrefs>("/api/billing/prefs", undefined, false),
    setPrefs: (b: { enabled: boolean; thresholdCredits: number; package: string | null }) =>
      put<BillingPrefs>("/api/billing/prefs", b, undefined, false),
  },

  brains: {
    list: () => get<Brain[]>("/api/brains", undefined, false),
    create: (p: { name: string }) => post<Brain>("/api/brains", p, undefined, false),
  },

  // --- RBAC / Acesso (BFF /api/rbac/* — proxia M7 quando existir; MOCK até lá) ---
  rbac: {
    principals: () => get<Principal[]>("/api/rbac/principals"),
    // áreas REAIS do cérebro (tags area: das páginas + áreas citadas em grants, count 0)
    areas: () => get<AreaView[]>("/api/rbac/areas"),
    invite: (p: InviteReq) => post<Principal>("/api/rbac/invite", p),
    setGrant: (principalId: string, g: GrantReq) =>
      post<Principal>("/api/rbac/grant", { principalId, ...g }),
    issueToken: (principalId: string) =>
      post<{ token: string; principal: Principal }>("/api/rbac/token", { principalId }),
    revokeToken: (principalId: string) =>
      del<void>("/api/rbac/token", { principal: principalId }),
    rotateToken: (principalId: string) =>
      post<{ token: string; principal: Principal }>("/api/rbac/token/rotate", { principalId }),
    removePrincipal: (principalId: string) =>
      del<{ ok: boolean; removed: string }>("/api/rbac/principal", { id: principalId }),
    preview: (principalId: string, q: string) =>
      get<AccessPreview>("/api/rbac/preview", { principal: principalId, q }),
    log: (opts?: { principalId?: string }) =>
      get<AccessLogEntry[]>("/api/rbac/log", { principal: opts?.principalId }),
  },

  // --- Contexto do brain (M11) — S4 onboarding + S6 edição/preview/re-extração (mesma chave). ---
  context: {
    onboardingStart: () => post<OnbTurn>("/api/onboarding/start", {}),
    onboardingReply: (state: OnbState, message: string) =>
      post<OnbTurn>("/api/onboarding/reply", { state, message }),
    onboardingConfirm: (context: OnbContext) =>
      post<{ card: string; version: number }>("/api/onboarding/confirm", { context }),
    // S6 — Ajustes visuais + preview em linguagem natural + re-extração sob comando.
    get: () => get<ContextView>("/api/context"),
    save: (context: OnbContext) => post<ContextView>("/api/context", { context }),
    preview: (sampleText: string, type: string) => post<PreviewResult>("/api/context/preview", { sampleText, type }),
    reextractEstimate: () => get<ReextractEstimate>("/api/context/reextract"),
    reextractRun: () => post<ReextractResult>("/api/context/reextract", {}),
  },

  // --- Import via front (M12: assíncrono) — upload/colar vira JOB na fila; o front faz polling. ---
  // M21: `sourceId?` opcional — entra sob o contrato da fonte (404 fonte removida / 409 pausada no BFF).
  ingest: {
    upload: (p: { type: string; base64: string; filename: string; contentType: string; title?: string; date?: string; sourceId?: string }) =>
      post<EnqueueResult>("/api/ingest", { kind: "file", ...p }),
    text: (p: { type: string; text: string; title?: string; date?: string; sourceId?: string }) =>
      post<EnqueueResult>("/api/ingest", { kind: "text", ...p }),
    jobs: () => get<IngestJob[]>("/api/ingest/jobs"),
    job: (id: string) => get<IngestJob>(`/api/ingest/jobs/${encodeURIComponent(id)}`),
  },

  // --- M21: Fontes com receita + fila de revisão (regra de ouro). ---
  sources: {
    list: () => get<Source[]>("/api/sources"),
    create: (p: { name: string; channel: string; type: string; recipe?: SourceRecipe; defaultSensitivity?: string }) =>
      post<Source>("/api/sources", p),
    update: (id: string, p: { name?: string; type?: string; recipe?: SourceRecipe; defaultSensitivity?: string }) =>
      post<Source>(`/api/sources/${encodeURIComponent(id)}`, p),
    setStatus: (id: string, status: "ativa" | "pausada") =>
      post<Source>(`/api/sources/${encodeURIComponent(id)}/status`, { status }),
    /** M22-D — cria/obtém a fonte-conector do provider (idempotente; 503 = ambiente sem Nango). */
    connectorCreate: (p: { provider: string }) => post<Source>("/api/sources/connector", p),
    /** M22-D — abre a connect session do Nango pra fonte (404/400/503/502 → ApiError com PT). */
    connectStart: (id: string) => post<ConnectStart>(`/api/sources/${encodeURIComponent(id)}/connect`),
    /** M22-D — estado de conexão das fontes-conector (A §4.7; o front mescla em Source.connector). */
    connectorsStatus: () => get<ConnectorsStatus>("/api/connectors/status"),
  },
  /** WhatsApp via Evolution (local/Docker) — QR no painel. */
  evolution: {
    status: () => request<EvolutionStatus>("/api/evolution/status", { timeoutMs: 15_000 }),
    connect: () => request<EvolutionStatus>("/api/evolution/connect", { method: "POST", body: {}, timeoutMs: 28_000 }),
    refreshQr: () => request<EvolutionStatus>("/api/evolution/qr", { method: "POST", body: {}, timeoutMs: 28_000 }),
  },
  llmCodex: {
    status: () => get<CodexOauthStatus>("/api/llm/codex/status"),
    start: () => post<CodexOauthStart>("/api/llm/codex/start", {}),
    poll: () => post<CodexOauthStatus>("/api/llm/codex/poll", {}),
    disconnect: () => post<{ connected: false }>("/api/llm/codex/disconnect", {}),
  },
  hypotheses: {
    // `list` GANHA filtros ADITIVOS (reason/dimension/source_id) — defesa em profundidade do
    // filtro client-side; o BFF ignora params desconhecidos (filtros server-side fora do v1, §9.3).
    list: (opts?: { status?: string; k?: number; reason?: string; dimension?: string; sourceId?: string }) =>
      get<Hypothesis[]>("/api/hypotheses", {
        status: opts?.status, k: opts?.k,
        reason: opts?.reason, dimension: opts?.dimension, source_id: opts?.sourceId,
      }),
    count: () => get<HypothesesCount>("/api/hypotheses/count"),
    approve: (id: string) => post<{ ok: true }>(`/api/hypotheses/${encodeURIComponent(id)}/approve`),
    discard: (id: string) => post<{ ok: true }>(`/api/hypotheses/${encodeURIComponent(id)}/discard`),
    // --- M25-A: grupos + ações de lote (transacionais, GATEADAS, zero LLM no caminho) ---
    groups: () => get<HypothesisGroup[]>("/api/hypotheses/groups"),
    approveGroup: (p: { reason: ReviewReason; dimension: string; source_id: string; apenas_recomendados?: boolean }) =>
      post<BatchApproveResult>("/api/hypotheses/groups/approve", p),
    discardGroup: (p: { reason: ReviewReason; dimension: string; source_id: string }) =>
      post<BatchDiscardResult>("/api/hypotheses/groups/discard", p),
    addDimToRecipe: (p: { source_id: string; dimension: string }) =>
      post<RecipeBatchResult>("/api/hypotheses/groups/add-dimension", p),
    // --- M25-B: juiz triador (recomenda, NUNCA aprova — invariante #5) ---
    // Polling = re-POST de `run()` (NÃO existe GET /judge/status — §9.2.2).
    judge: {
      estimate: () => get<JudgeEstimate>("/api/hypotheses/judge/estimate"),
      run: () => post<JudgeRun>("/api/hypotheses/judge", {}),
      calibration: () => get<JudgeCalibration>("/api/hypotheses/judge/calibration"),
    },
  },

  // --- M24-E: percepções do cérebro (saída do sono) — tela Saúde. ---
  percepcoes: {
    list: (opts?: { estado?: PercepcaoEstado | "todas"; k?: number; offset?: number }) =>
      get<PercepcoesPage>("/api/percepcoes", { estado: opts?.estado, k: opts?.k, offset: opts?.offset }),
  },

  // --- Saúde interna (sono + armazenamento + fila por status) — tela Saúde. Leitura pura. ---
  saude: () => get<SaudeView>("/api/saude"),

  // --- Lixeira de páginas: ver o que foi arquivado e trazer de volta (nada é apagado). ---
  lixeira: {
    list: () => get<LixeiraPage>("/api/lixeira"),
    restore: (slug: string) => post<RestauroResult>("/api/lixeira/restaurar", { slug }),
  },

  // --- M21: wizard de criação de cérebro (4 passos, bounded). Sessão obrigatória; SEM brain na query. ---
  wizard: {
    start: () => post<WizardTurn>("/api/wizard/start", {}, undefined, false),
    // `action` (M21/fix-2): 'toggle'/'go' nos chips ricos do passo `sources`; ausente = texto livre.
    reply: (state: WizardState, message: string, action?: "toggle" | "go") =>
      post<WizardTurn>("/api/wizard/reply", { state, message, action }, undefined, false),
    confirm: (state: WizardState) =>
      post<{ card: string; brain: Brain }>("/api/wizard/confirm", { state }, undefined, false),
  },
};

export type Api = typeof api;
