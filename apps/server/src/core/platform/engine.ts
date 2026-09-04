/** Camada de STORAGE (DB-native): Postgres + pgvector é a FONTE DE VERDADE única.
 *  Não há mais arquivos nem SQLite — capture/extract/organize escrevem direto aqui.
 *
 *  Conexão via env DATABASE_URL. Multi-tenant: toda linha carrega `brain` (= GALEED_BRAIN
 *  ou o flag --brain), isolando empresas no mesmo Postgres.
 *
 *  Camadas dentro do banco:
 *   - galeed_pages        = as fontes cruas (texto + metadados). Escritas por `capture`.
 *   - galeed_extractions  = saída crua do LLM por fonte (JSON). Escrita por `extract`.
 *   - galeed_facts/edges  = DERIVADOS por `organize` (supersessão bitemporal + grafo). Descartáveis.
 *   - galeed_vectors      = embeddings (busca semântica). */

export interface PageRow {
  slug: string;
  type: string;
  title: string;
  date: string;
  path: string; // legado/compat: sempre "" no mundo DB-native
  body: string;
  // --- metadados (DB-native) — opcionais p/ compat de chamadas antigas ---
  content_hash?: string; // dedup de captura + freshness de extração
  external_id?: string; // idempotência de ingestão (webhook re-postado não duplica)
  people?: string[]; // pessoas detectadas/declaradas
  tags?: string[]; // tags livres (#)
  extract_version?: string; // versão do prompt com que a fonte foi extraída ("" = não extraída)
  synopsis?: string; // sinopse contextual (S3) — situa os chunks no contexto da página
  salience?: number; // [0..1] — "quanto isso importa" (M3/S3), recomputado no sleep
  tier?: string; // 'hot' = vetores presentes | 'cold' = vetores descartados (regeneráveis do body)
  sensitivity?: string; // 'publico'|'interno'|'sensivel'|'restrito' — default 'restrito' (falha fechado)
  archived?: boolean; // lixeira reversível (prune/consolidate). Presente em getPage/pagesBySlug; allPages já EXCLUI arquivadas
}

/** Níveis de sensibilidade, do MAIS aberto ao MAIS restrito. A ordem É o significado:
 *  acesso passa quando rank(sensibilidade-do-item) ≤ rank(sensitivity_max-do-grant). */
export const SENSITIVITY_LEVELS = ["publico", "interno", "sensivel", "restrito"] as const;
export type SensitivityLevel = (typeof SENSITIVITY_LEVELS)[number];

/** rank ordinal de um nível (0=publico … 3=restrito). Nível desconhecido/ausente → 3 (restrito),
 *  falha fechado. */
export function sensitivityRank(level: string | undefined | null): number {
  const i = SENSITIVITY_LEVELS.indexOf((level ?? "") as SensitivityLevel);
  return i === -1 ? SENSITIVITY_LEVELS.length - 1 : i; // ausente/inválido = restrito
}

// ---- RBAC (M7/R16) — tipos de storage; a lógica de escopo é do S2 ----
export type PrincipalKind = "human" | "agent";

export interface PrincipalRow {
  id: string;            // id estável do principal dentro do brain (slug/uuid escolhido pelo chamador)
  kind: PrincipalKind;   // 'human' = login/sessão | 'agent' = token
  label: string;         // nome legível
  email: string;         // "" se agente
  status: string;        // 'active' | 'disabled'
  created_at?: string;
}

export interface GrantRow {
  principal_id: string;
  areas: string[];          // slugs de área permitidos (N:N). [] = nenhuma área (vê só sem-área? NÃO — ver S2)
  sensitivity_max: string;  // teto de sensibilidade (um SensitivityLevel). Default 'publico'
  deny_types: string[];     // tipos negados (override fino, opcional). [] = nada negado
  scope: string;            // 'read' (v1 é só-leitura)
  can_ingest?: boolean;     // capacidade de ESCRITA (gateway /v1/ingest). FAIL-CLOSED: ausente/false = só lê
}

export interface TokenRow {
  principal_id: string;
  token_hash: string;       // sha256 hex do token cru (o cru NUNCA é persistido)
  label: string;
  last_used_at?: string;
  revoked: boolean;
}

export interface AccessLogRow {
  principal_id: string;
  ts?: string;
  query: string;
  areas_touched: string[];
  n_returned: number;
  event?: string;   // null = leitura; senão token.issued|token.revoked|token.rotated|principal.invited|grant.changed|principal.removed
  actor?: string;   // quem fez a ação de governança (id/email do dono). null em leituras.
}

/** Saída crua da extração por fonte (espelha o antigo fatos/<slug>.json). */
export interface ExtractionRow {
  source_slug: string;
  type: string;
  date: string;
  content_hash: string;
  prompt_version: string;
  extractions: any; // { dimension: item[] }
}

/** Um campo da receita: a dimensão de extração reconhecida + área destino. `dimension` referencia
 *  `extractable[type].eval_dimensions` (M13) ou as DEFAULT_EXTRACT_DIMS — a receita ESPECIALIZA o
 *  extractable, nunca o substitui (ADR-016). */
export interface SourceRecipeField {
  dimension: string; // chave da dimensão (ex.: "decisoes") — ⊆ dims do extractable do tipo
  label: string;     // rótulo legível pro front ("decisão tomada"). Cosmético.
  area: string;      // slug da área destino ("produto"). "" = sem área.
}

/** Receita de uma fonte — 100% DADO (jsonb). O core nunca ramifica por formato/canal. */
export interface SourceRecipe {
  fields: SourceRecipeField[];
  /** orientação extra pro prompt de extração (entra via seam do S2). "" / ausente = sem extra. */
  guidance?: string;
  /** chave do perfil de triagem M15 ("default" | "<canal>:<tipo>"). ""/ausente = resolução padrão. */
  triage_profile?: string;
}

/** Uma fonte ligada ao brain (M21). Estatísticas (`pages_count`/`facts_count`) são COMPUTADAS na
 *  leitura por listSources — não são colunas (evita drift). */
export interface SourceRow {
  id: string;                  // uuid (randomUUID na borda que cria — S3/S4)
  name: string;                // nome legível da fonte (dado do tenant)
  channel: string;             // canal de ingestão v1: "upload" | "paste"
  type: string;                // tipo de página (casa com page.type / extractable[type])
  recipe: SourceRecipe;
  default_sensitivity: string; // SensitivityLevel; default 'restrito' (falha-fechado)
  status: string;              // 'ativa' | 'pausada'
  last_read_at: string | null; // ISO; atualizado por touchSourceRead
  created_at?: string;
  pages_count?: number;        // só na LEITURA (listSources) — páginas com tag `src:<id>`
  facts_count?: number;        // só na LEITURA — galeed_facts.source_id = id
}

export type ReviewReason = "fora_da_receita" | "nao_ancorado" | "entidade_vaga" | "conexao_sugerida";
export type ReviewStatus = "pendente" | "aprovada" | "descartada";

/** Item da fila de revisão: um claim extraído que NÃO casou com a receita (regra de ouro, M21).
 *  Nunca deletado — descartar muda status (invariante #5). */
export interface ReviewItemRow {
  id: string;          // uuid (gerado por quem cria — S2)
  source_id: string;   // fonte que originou ('' se job sem fonte — não acontece no v1)
  source_slug: string; // página (galeed_pages.slug) de onde o claim saiu
  dimension: string;   // dimensão de extração do claim
  text: string;        // o claim em linguagem natural (it.text)
  quote: string;       // trecho literal (it.context_quote)
  claim: any;          // o item CRU da extração (jsonb) — base do aprovar→fato
  reason: ReviewReason;
  status: ReviewStatus;
  decided_by: string;  // '' até decisão; depois o account id/email de quem decidiu
  created_at?: string;
  decided_at?: string | null;
}

/** Uma chamada de IA registrada (custo observável end-to-end, M20). 1 linha por chamada (extração,
 *  síntese do ask, embeddings, rerank). `usage` REAL do provider; `cost_usd` calculado em pricing.ts. */
export interface LlmUsageRow {
  brain: string;
  op: string;        // extract | extract:batch | synthesis | ask:stream | embed | embed:query | rerank | hyde
  provider: string;  // "api" | "cli" | "openai" | "voyage"
  model: string;
  tokens_in: number;
  tokens_out: number;
  cache_read?: number;
  cache_write?: number;
  cost_usd: number;
  meta?: Record<string, unknown> | null;
  ts?: string;       // preenchido pelo banco (default now()); presente na leitura
}

/** Rollup de custo de IA por brain (M20). Totais + quebra por operação e por modelo. */
export interface LlmUsageRollup {
  calls: number;
  cost_usd_total: number;
  tokens_in_total: number;
  tokens_out_total: number;
  by_op: { op: string; calls: number; cost_usd: number; tokens_in: number; tokens_out: number }[];
  by_model: { model: string; calls: number; cost_usd: number; tokens_in: number; tokens_out: number }[];
}

/** Receipt de um run de extração (custo observável por brain, M9/S1). Declarado aqui; o S5
 *  ESCREVE/LÊ via os métodos de Engine abaixo (putExtractReceipt/extractReceipts/extractReceiptRollup). */
export interface ExtractReceiptRow {
  run_id: string;          // id único do run (ex.: `${type}-${corpus_sha8}-${Date.now()}` ou sha das chaves)
  fixture_corpus: string;  // caminho/nome do corpus avaliado ("" se run de produção)
  model: string;           // modelo usado (ex.: "claude-haiku-4-5")
  prompt_version: string;  // PROMPT_VERSION da extração
  schema_version: string;  // versão do schema do gate (S5 define, ex.: "v1")
  corpus_sha8: string;     // sha8 do corpus de fixtures (idempotência do gate)
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  recall: number | null;   // recall agregado do run (null em run de produção sem golden)
  per_dim: Record<string, number>; // recall por dimensão
}

/** Mapa de canonicalização de predicado: { entity: { aliasPredicate: canonical } }. */
export type ReconcileMap = Record<string, Record<string, string>>;

/** Mapa de canonicalização de ENTIDADE: { aliasLowercase: canonical }. */
export type EntityResolveMap = Record<string, string>;

/** Query-ouro do eval de retrieval (M3/S1). */
export interface GoldenRow {
  qid: string;
  query: string;
  expected: string[];
  note: string;
}
/** Resultado de um run de eval (P@k/recall/MRR agregados + por-query). */
export interface EvalRunRow {
  run_id: number;
  k: number;
  p_at_k: number;
  recall_at_k: number;
  mrr: number;
  n_queries: number;
  per_query: { qid: string; query: string; p: number; recall: number; rr: number; hits: string[] }[];
  params: Record<string, unknown>;
  created_at?: string;
}

/** Conexão tipada no grafo de entidades (S2): saída (entidade=sujeito) ou entrada (entidade=valor). */
export interface GraphQueryHit {
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

/** Hipótese gerada pelo SONHO (dream) — substitui hipoteses/<slug>.md. */
export interface HypothesisRow {
  slug: string;
  a: string;
  b: string;
  shared: string[];
  surprise: number;
  status: string; // "nao-verificada" | "confirmada" | "corroborada" | "estavel" | "enfraquecida" | "arquivada"
  confidence: string; // "baixa" | "media" | "alta" | ...
  text: string;
}

/** Contradição detectada (S4) — par de fatos conflitantes. NUNCA muta a verdade, só registra. */
export interface ContradictionRow {
  hash: string;
  entity: string;
  a_slug: string;
  a_text: string;
  a_value: string;
  a_valid_from: string;
  b_slug: string;
  b_text: string;
  b_value: string;
  b_valid_from: string;
  rule: "concorrente" | "cross_predicado";
  verdict: "contradiz" | "evolucao" | "independente" | "suspeita";
  severity: "alta" | "media" | "baixa" | "info";
  confidence: number;
}

/** Aprendizado gerado pela REFLEXÃO — substitui reflexoes/<slug>.md. */
export interface ReflectionRow {
  question: string;
  text: string;
  sources: string[];
}
export interface FactRow {
  source_slug: string;
  type: string;
  dimension: string;
  idx: number;
  text: string;
  quote: string;
  meta: any; // item original cru (gravado como jsonb)
  // --- camada bitemporal (v0.3). Vazios/zero = fato standalone (sem supersessão). ---
  entity: string; // sujeito canônico (lowercase). "" = standalone
  predicate: string; // chave estável snake_case. "" = standalone
  value: string; // valor/objeto do fato (grafia original, p/ exibição — PRESERVADO)
  // --- claim tipado (M9/S1). Vazios/null = claim só-textual (legado ou não-numérico). ---
  value_num?: number | null; // valor numérico CRU normalizado (30000, não "R$ 30K"). null = não-numérico
  unit?: string;             // unidade ("BRL"|"USD"|"pct"|"people"|"un"|…). "" = sem unidade
  period?: string;           // periodicidade ("monthly"|"annual"|"quarterly"|"one_time"|…). "" = n/a
  tier?: string;             // segmento/faixa do claim ("enterprise"|"pro"|…). "" = sem tier
  valid_from: string; // valid-time início (ISO date). Default = data da fonte
  valid_to: string; // valid-time fim ("" = vigente / verdade atual)
  confidence: number; // 0..1, sobe com corroboração de fontes distintas
  status: string; // "fato" | "hipotese" | "arquivado" | "registrado"
  source_id?: string; // M21: carimbo da fonte. ''/ausente = fato sem fonte (legado).
}
export interface EdgeRow {
  src: string;
  dst: string;
  kind?: string; // "wikilink" (default) | "speaker" | "semantic" — tipo da aresta
  weight?: number; // score (ex.: similaridade da aresta semântica). 0/undefined = factual
}
/** Chave de um grupo bitemporal — a unidade INDEPENDENTE de derivação (ver applyBitemporal em
 *  indexer.ts: agrupa por `${entity} ${predicate} ${tier}`). É a granularidade da leitura/escrita
 *  dirigida do write-path incremental (M14). Strings vazias são chaves válidas (fato standalone). */
export interface FactGroupKey {
  entity: string;
  predicate: string;
  tier: string;
}
export interface VecRow {
  hash: string;
  slug: string;
  chunk_idx: number;
  text: string;
  vec: Float32Array; // normalizado (cosine = dot product)
}
export interface Hit {
  slug: string;
  type: string;
  title: string;
  date: string;
  excerpt: string;
  score: number;
}
export interface SemHit {
  slug: string;
  chunk_idx: number;
  text: string;
  score: number;
  type?: string;
  title?: string;
  date?: string;
}
export interface FactHit {
  source_slug: string;
  type: string;
  dimension: string;
  text: string;
  quote: string;
  // --- camada bitemporal (v0.3) — presentes quando o fato é afirmação sobre entidade ---
  entity?: string;
  predicate?: string;
  value?: string;
  value_num?: number | null;
  unit?: string;
  period?: string;
  tier?: string;
  valid_from?: string;
  valid_to?: string; // "" = vigente (verdade atual)
  confidence?: number;
  status?: string;
  source_id?: string; // M21
}

export interface FactsOpts {
  type?: string;
  limit?: number;
  /** filtro bitemporal: só fatos vigentes em DATA (valid_from ≤ DATA < valid_to). */
  asOf?: string;
  /** só fatos vigentes hoje (valid_to == ""). */
  currentOnly?: boolean;
}
export interface Stats {
  pages: number;
  facts: number;
  edges: number;
  vectors: number;
}

/** Contadores de peso do brain (S3/M5) — prova que o corpus parou de crescer pra sempre. */
export interface StorageStats {
  pagesTotal: number; // todas as páginas do brain (inclui arquivadas)
  pagesHot: number; // tier='hot'
  pagesCold: number; // tier='cold'
  pagesArchived: number; // archived=true
  vectors: number; // linhas em galeed_vectors
  facts: number; // linhas em galeed_facts
  edges: number; // linhas em galeed_edges
  bodyBytes: number; // sum(octet_length(body)) em galeed_pages
}

/** Grafo inteiro para visualização (estilo Obsidian, enriquecido). */
export interface GraphNode {
  id: string; // slug (ou alvo de wikilink ainda sem página)
  label: string; // título legível
  type: string; // tipo da fonte (cor por tipo)
  date: string;
  exists: boolean; // false = alvo de [[wikilink]] sem página própria (nó fantasma)
  factCount: number; // quantos fatos essa página gerou (peso/tamanho do nó)
  salience?: number; // [0..1] — importância (M3/S3)
  tier?: string; // 'hot' | 'cold' (M5) — nós fantasma não têm
  role?: string; // grafo de ENTIDADES (entityGraph): "org" | "pessoa" | "assunto"
}
export interface GraphEdge {
  src: string;
  dst: string;
  kind: string; // "wikilink" | "speaker" | "semantic" (futuramente: "supersede")
  weight?: number; // similaridade, p/ arestas semânticas
}
export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export type EngineName = "postgres";

/** Store de fontes cruas (`galeed_pages`) — captura, metadados e leitura de páginas. */
export interface PageStore {
  /** Grava/atualiza UMA fonte. */
  upsertPage(row: PageRow): Promise<void>;
  /** Todas as fontes do brain (p/ extract --all, organize, embeddings). */
  allPages(): Promise<PageRow[]>;
  /** slug da fonte com esse external_id (idempotência de ingestão), se existir. */
  pageByExternalId(externalId: string): Promise<string | undefined>;
  /** P1-D — INSERT atômico condicionado ao external_id (índice UNIQUE parcial, migração 28).
   *  true = inseriu (página NOVA); false = já existe página com esse (brain, external_id) —
   *  re-post ou corrida perdida (o UNIQUE arbitra; o DO NOTHING não atualiza nada).
   *  REQUER row.external_id não-vazio. Diferente de upsertPage: NUNCA sobrescreve linha existente. */
  insertPageIfNew(row: PageRow): Promise<boolean>;
  /** marca a versão de prompt com que a fonte foi extraída. */
  markExtracted(slug: string, version: string): Promise<void>;
  /** grava a sinopse contextual de uma página + o hash do conteúdo de origem (cache S3). */
  setSynopsis(slug: string, synopsis: string, synopsisHash: string): Promise<void>;
  /** lê {synopsis, synopsis_hash} de uma página (vazios se não houver). */
  getSynopsis(slug: string): Promise<{ synopsis: string; synopsis_hash: string }>;
  /** grava a salience [0..1] de uma página (M3/S3). */
  setSalience(slug: string, salience: number): Promise<void>;
  getPage(slug: string): Promise<PageRow | undefined>;
  /** Páginas por slug, em batch — p/ enriquecer hits expandidos com type/title/date. */
  pagesBySlug(slugs: string[]): Promise<Map<string, PageRow>>;
  /** define a sensibilidade de UMA página. */
  setSensitivity(slug: string, sensitivity: string): Promise<void>;
  /** adiciona a tag `area:<slug>` em galeed_pages.tags (idempotente, sem duplicar). Retorna true se mudou. */
  setArea(slug: string, area: string): Promise<boolean>;
  /** remove a tag `area:<slug>` de galeed_pages.tags. Retorna true se mudou. */
  removeArea(slug: string, area: string): Promise<boolean>;
  /** esquece sem deletar (flag archived). */
  setArchived(slug: string, archived: boolean): Promise<void>;
  /** muda a camada de UMA página. */
  setTier(slug: string, tier: string): Promise<void>;
  /** páginas tier='cold' (independente de archived) — p/ inspeção/restore. */
  coldPages(): Promise<PageRow[]>;
  /** candidatas a resfriar: archived=true E tier='hot' (arquivadas mas ainda pesando). */
  shedCandidates(): Promise<PageRow[]>;
}

/** Store de extrações cruas (`galeed_extractions`) — saída do LLM antes dos derivados. */
export interface ExtractionStore {
  putExtraction(row: ExtractionRow): Promise<void>;
  allExtractions(): Promise<ExtractionRow[]>;
  /** {content_hash, prompt_version} da extração existente — p/ checar freshness. */
  extractionMeta(slug: string): Promise<{ content_hash: string; prompt_version: string } | undefined>;
  /** a ExtractionRow completa de uma fonte-página (undefined se nunca extraída). Base do
   *  aprovar→fato do S2 (append do claim aprovado + deriveIncremental). */
  getExtraction(slug: string): Promise<ExtractionRow | undefined>;
}

/** Store de fatos/arestas derivados — verdade bitemporal, grafo e leituras estruturadas. */
export interface FactStore {
  /** Limpa os DERIVADOS (facts/edges) PRESERVANDO pages/extractions/vetores. */
  resetIndex(): Promise<void>;
  putFacts(rows: FactRow[]): Promise<void>;
  putEdges(rows: EdgeRow[]): Promise<void>;
  /** Substitui TODAS as arestas de um `kind` numa transação (delete escopado por kind + insert).
   *  É o dual do replaceDerived (que é dono das factuais e agora poupa kind='semantic' — achado
   *  tags-e-organizacao#4): cada produtor substitui SÓ as arestas de que é dono. Usado pelo
   *  buildSemanticLinks (link.ts) — mantém `galeed link` idempotente (sem acumular duplicata)
   *  e limpa arestas semânticas órfãs de páginas apagadas. */
  replaceEdgesOfKind(kind: string, edges: EdgeRow[]): Promise<void>;
  /** Substitui os DERIVADOS (facts+edges) do brain numa ÚNICA transação (leitor nunca vê parcial). */
  replaceDerived(facts: FactRow[], edges: EdgeRow[]): Promise<void>;
  /** Leitura DIRIGIDA: fatos do brain cujo (entity,predicate,tier) ∈ `keys` (chaves de grupo
   *  bitemporal). Carrega SÓ as cadeias afetadas — NÃO o corpus. `keys=[]` → []. Base da
   *  re-supersessão incremental do write-path (M14). */
  factsInGroups(keys: FactGroupKey[]): Promise<FactRow[]>;
  /** Escrita DIRIGIDA atômica (M14): numa ÚNICA transação, substitui só os fatos/arestas afetados pelo
   *  lote — SEM DELETE do brain inteiro. DELETA fatos onde source_slug ∈ `slugs` OU (entity,predicate,
   *  tier) ∈ `groupKeys`; deleta arestas onde src ∈ {entidades de groupKeys}; INSERE `facts`+`edges`.
   *  Espelha replaceDerived (transação+batches), mas escopado. Leitor nunca vê parcial. */
  replaceFactsForSourcesAndGroups(
    slugs: string[],
    groupKeys: FactGroupKey[],
    facts: FactRow[],
    edges: EdgeRow[],
  ): Promise<void>;
  search(q: string, k: number, type?: string): Promise<Hit[]>;
  facts(dimension: string, opts: FactsOpts): Promise<FactHit[]>;
  /** Linha do tempo bitemporal de uma entidade: todas as versões de crença, ordenadas
   *  por predicado e valid_from. É como o cérebro mostra "mudou de ideia". */
  timeline(entity: string, opts: { predicate?: string; limit?: number }): Promise<FactHit[]>;
  graph(slug: string): Promise<{ slug: string; aponta_para: string[]; apontado_por: string[] }>;
  /** Vizinhos (1 salto, ida+volta) de um CONJUNTO de slugs, em batch — p/ graph-expansion no retrieve. */
  neighbors(slugs: string[]): Promise<Map<string, string[]>>;
  /** Grafo INTEIRO p/ visualização: todos os nós (páginas) + arestas (wikilinks). */
  graphAll(): Promise<GraphData>;
  /** Grafo de ENTIDADES (o "mapa do cérebro"): nós = entidades com fatos (tamanho ∝ nº de fatos,
   *  role org/pessoa/assunto), arestas = co-ocorrência na mesma fonte + relações (aluno_de etc).
   *  É a fonte do Mapa — substitui o grafo de páginas+wikilinks, que é vazio sem [[links]]. */
  entityGraph(opts?: { minFacts?: number; minShared?: number; maxNodes?: number }): Promise<GraphData>;
  stats(): Promise<Stats>;

  // ---- reconcile (canonicalização de predicado) ----
  getReconcile(): Promise<ReconcileMap>;
  putReconcile(map: ReconcileMap): Promise<void>;

  // ---- entity resolution (canonicalização de entidade) ----
  getEntityResolve(): Promise<EntityResolveMap>;
  putEntityResolve(map: EntityResolveMap): Promise<void>;
  /** cache do desempate de GRUPO AMBÍGUO (fix sobre-fusão #R3): partição decidida pela LLM,
   *  por assinatura (group_key). null = grupo nunca perguntado (pergunta 1×, cacheado e estável). */
  getEntityDisambig(groupKey: string): Promise<string[][] | null>;
  putEntityDisambig(groupKey: string, decision: string[][]): Promise<void>;
  /** canônico de um alias (lowercased/trim); se não houver, devolve o próprio alias normalizado. */
  resolveEntity(alias: string): Promise<string>;
  /** conexões tipadas de um nó no grafo de entidades (sobre galeed_facts). */
  graphQuery(node: string, opts: { predicate?: string; currentOnly?: boolean; limit?: number }): Promise<GraphQueryHit[]>;
  /** todos os fatos VIGENTES com entidade (valid_to == '' e entity != ''). */
  currentFacts(): Promise<FactHit[]>;
  getContradictionCache(): Promise<Set<string>>; // hashes já julgados
  putContradiction(row: ContradictionRow): Promise<void>;
  allContradictions(): Promise<ContradictionRow[]>;
}

/** Store de vetores (`galeed_vectors`) — índice semântico regenerável. */
export interface VectorStore {
  vectorHashes(): Promise<Set<string>>;
  putVectors(rows: VecRow[]): Promise<void>;
  pruneVectors(keep: Set<string>): Promise<void>;
  hasVectors(): Promise<boolean>;
  /** Busca por similaridade. `dedupe=true` → 1 hit por página; `false` → top-k CHUNKS. */
  vectorSearch(qvec: Float32Array, k: number, dedupe: boolean): Promise<SemHit[]>;
  /** Todos os vetores (hash/slug/chunk/vec) — p/ inferir arestas SEMÂNTICAS entre páginas. */
  allVectors(): Promise<VecRow[]>;
  /** descarta os vetores de UMA página (derivado regenerável). Retorna nº de linhas removidas. */
  shedVectors(slug: string): Promise<number>;
}

/** Store de avaliação/saúde/reflexão — observabilidade e manutenção da memória. */
export interface EvaluationStore {
  putGolden(row: GoldenRow): Promise<void>;
  allGolden(): Promise<GoldenRow[]>;
  putEvalRun(row: Omit<EvalRunRow, "run_id" | "created_at">): Promise<number>;
  lastEvalRuns(n: number): Promise<EvalRunRow[]>;
  replaceHypotheses(rows: HypothesisRow[]): Promise<void>;
  allHypotheses(): Promise<HypothesisRow[]>;
  updateHypothesis(slug: string, patch: Partial<HypothesisRow>): Promise<void>;
  archiveHypothesis(slug: string): Promise<void>;
  reflectedSlugs(): Promise<Set<string>>;
  markReflected(slugs: string[]): Promise<void>;
  putReflection(row: ReflectionRow): Promise<void>;
}

/** Store de estatísticas de peso/crescimento do brain. */
export interface StorageStatsStore {
  stats(): Promise<Stats>;
  /** contadores de peso do brain (p/ S3). */
  storageStats(): Promise<StorageStats>;
}

/** Store de RBAC — storage puro; a lógica de escopo é do access/scope.ts. */
export interface AccessStore {
  /** cria/atualiza um principal (humano ou agente). */
  upsertPrincipal(row: PrincipalRow): Promise<void>;
  /** principal por id (undefined se não existe). */
  getPrincipal(id: string): Promise<PrincipalRow | undefined>;
  /** todos os principais do brain. */
  allPrincipals(): Promise<PrincipalRow[]>;
  /** muda o status ('active'|'disabled') de um principal — revogação de acesso na hora. */
  setPrincipalStatus(id: string, status: string): Promise<void>;

  /** grava/substitui o grant de UM principal (1:1). */
  putGrant(row: GrantRow): Promise<void>;
  /** grant de um principal (undefined se não tem grant — falha fechado: S2 trata como sem acesso). */
  getGrant(principalId: string): Promise<GrantRow | undefined>;

  /** cria/atualiza um token escopado (token_hash = sha256 do cru; o cru não é persistido). */
  upsertToken(row: TokenRow): Promise<void>;
  /** token por hash (undefined se não existe). Inclui revoked — o S2/S4 decide. */
  tokenByHash(tokenHash: string): Promise<TokenRow | undefined>;
  /** GATEWAY /v1: resolve o TENANT a partir do token cru — busca GLOBAL (sem filtro de brain)
   *  por token_hash em galeed_tokens, só não-revogados. token_hash é sha256 de bytes aleatórios
   *  → colisão entre brains é nula, a busca global é segura. null se não achou/revogado.
   *  RLS (RESOLVIDO): sob GALEED_RLS=1 a antiga policy brain_iso restringia a leitura ao galeed.brain
   *  da conexão, quebrando este lookup global (o token vive no brain do cliente, não no de bootstrap).
   *  applyPostgresRls agora adiciona a policy PERMISSIVA de SELECT `token_hash_global_select` em
   *  galeed_tokens (using true) → leitura global liberada SÓ para SELECT; brain_iso ainda governa
   *  INSERT/UPDATE/DELETE. Seguro: token_hash = sha256 não reversível e a tabela só tem metadados; as
   *  tabelas de conteúdo seguem isoladas. O gateway pode abrir o engine no brain de bootstrap sem RLS off. */
  tokenByHashGlobal(tokenHash: string): Promise<{ brain: string; principal_id: string } | null>;
  /** revoga (revoked=true) um token pelo hash. */
  revokeToken(tokenHash: string): Promise<void>;
  /** atualiza last_used_at=now() de um token (auditoria leve). */
  touchToken(tokenHash: string): Promise<void>;
  /** todos os tokens de um principal (incl. revogados), mais novos primeiro. */
  tokensOf(principalId: string): Promise<TokenRow[]>;
  /** apaga de vez um principal: grant + tokens + a linha do principal (idempotente). */
  deletePrincipal(id: string): Promise<void>;

  /** grava uma linha de auditoria de leitura. */
  appendAccessLog(row: AccessLogRow): Promise<void>;
  /** últimas N linhas de auditoria (mais recentes primeiro) — p/ inspeção/CLI. */
  recentAccessLog(limit: number): Promise<AccessLogRow[]>;
}

/** Store de custo/usage de IA por brain. */
export interface UsageStore {
  /** grava um receipt de extração (idempotente por (brain, run_id) — on conflict do nothing). */
  putExtractReceipt(row: ExtractReceiptRow): Promise<void>;
  /** últimos N receipts do brain (mais recentes primeiro). */
  extractReceipts(limit?: number): Promise<ExtractReceiptRow[]>;
  /** rollup agregado por brain: {runs, cost_usd_total, tokens_in_total, tokens_out_total}. */
  extractReceiptRollup(): Promise<{ runs: number; cost_usd_total: number; tokens_in_total: number; tokens_out_total: number }>;
  /** grava UMA chamada de IA (extração/síntese/embed/rerank) com usage real + custo. Fail-soft no caller. */
  putLlmUsage(row: LlmUsageRow): Promise<void>;
  /** rollup de custo do brain: totais + quebra por op e por modelo (opcional: desde uma data ISO). */
  llmUsageRollup(sinceIso?: string): Promise<LlmUsageRollup>;
  /** soma ENXUTA do custo (USD) do brain desde `sinceIso` (uma única agregação, sem quebra por op/modelo).
   *  Usado pelo kill-switch de quota no /v1/ask — mais barato que `llmUsageRollup` (3 queries). */
  llmCostSince(sinceIso: string): Promise<number>;
  /** últimas N chamadas de IA do brain (mais recentes primeiro). */
  recentLlmUsage(limit?: number): Promise<LlmUsageRow[]>;
}

/** Store de FONTES (`galeed_sources`) — M21. Fonte é DADO; receita em jsonb. */
export interface SourceStore {
  upsertSource(row: SourceRow): Promise<void>;
  getSource(id: string): Promise<SourceRow | undefined>;
  /** todas as fontes do brain, mais recentes primeiro, com pages_count/facts_count computados. */
  listSources(): Promise<SourceRow[]>;
  /** 'ativa' | 'pausada'. Fonte pausada não aceita material novo (a borda S3 valida). */
  setSourceStatus(id: string, status: string): Promise<void>;
  /** marca leitura: last_read_at = now(). Chamado pelo pipeline (S2) ao fim de um job com fonte. */
  touchSourceRead(id: string): Promise<void>;
}

/** Store da FILA DE REVISÃO (`galeed_ingest_review`) — M21, regra de ouro. */
export interface ReviewStore {
  addReviewItems(rows: ReviewItemRow[]): Promise<void>; // rows=[] → no-op
  listReview(opts?: { status?: ReviewStatus; limit?: number }): Promise<ReviewItemRow[]>; // default pendente, 50
  getReviewItem(id: string): Promise<ReviewItemRow | undefined>;
  /** decide um item PENDENTE. Item já decidido → no-op silencioso (idempotente). */
  setReviewStatus(id: string, status: "aprovada" | "descartada", decidedBy: string): Promise<void>;
  reviewCounts(): Promise<{ pendente: number; aprovada: number; descartada: number }>;
}

// ---- M24-C: percepções (reflexão v2) ----
/** M24-C — referência ESTÁVEL de uma evidência-base da percepção (espelha o FactRef do M24-A;
 *  a identidade durável é a chave entity/predicate/tier/source_slug/valid_from — fact_id
 *  bigserial NÃO entra: muda no re-derive). quote = "" no v1 (FactRef não carrega quote). */
export interface PercepcaoCite {
  source_slug: string;
  entity: string;
  predicate: string;
  tier: string;
  valid_from: string;
  quote: string;
}

export type PercepcaoEstado = "viva" | "stale" | "arquivada";

/** Uma PERCEPÇÃO da reflexão v2 (M24-C): texto verbalizado VERIFICADO + proveniência + selo. */
export interface PercepcaoRow {
  id: string;                       // hash determinístico do sinal (percepcaoId/combinacaoId — §2.3)
  classe: string;                   // SignalClasse | "combinacao"
  entity: string;                   // "" quando não se aplica
  predicate: string;
  tier: string;
  texto: string;                    // 2-4 frases PT, aprovadas pelo verificador de âncora
  severidade: "alta" | "media" | "baixa" | "info";
  cites: PercepcaoCite[];           // jsonb — NUNCA vazio numa percepção de fato (nasce ancorada)
  numbers: Record<string, number | string>; // números do detector + magnitude (o selo)
  estado: PercepcaoEstado;
  created_at?: string;              // preenchido pelo banco
  validated_at?: string | null;     // última validação (nascimento/revalidação)
}

/** Store de PERCEPÇÕES (`galeed_percepcoes`) — M24-C, reflexão v2. Append-only, nunca DELETE. */
export interface PercepcaoStore {
  /** upsert por (brain,id): INSERT cria com created_at/validated_at=now(); ON CONFLICT atualiza
   *  TUDO menos created_at e, quando estado='viva', renova validated_at=now(). Re-sono não duplica. */
  upsertPercepcao(row: PercepcaoRow): Promise<void>;
  getPercepcao(id: string): Promise<PercepcaoRow | undefined>;
  /** default: TODOS os estados. Ordenação ESTÁVEL no SQL: created_at desc, id asc.
   *  limit default 100; offset default 0 (o offset existe pro M24-E paginar). */
  listPercepcoes(opts?: { estado?: PercepcaoEstado; limit?: number; offset?: number }): Promise<PercepcaoRow[]>;
  /** muda só o estado; estado='viva' também renova validated_at=now(). Id inexistente = no-op. */
  setPercepcaoEstado(id: string, estado: PercepcaoEstado): Promise<void>;
  percepcaoCounts(): Promise<{ viva: number; stale: number; arquivada: number }>;
}

// ---- C1: webhooks (registro + fila de entrega async, fail-soft) — por brain ----

/** Os 4 eventos v1. access.denied SÓ em negação TOTAL (request 100% barrado por escopo/403),
 *  NÃO em withheld parcial — a emissão (C2) decide; o tipo só enumera o domínio. */
export type WebhookEvent =
  | "ingest.organized"
  | "review.pending"
  | "fact.superseded"
  | "access.denied";

/** active = entregando | disabled = pausado pelo dono | failed = desligado pelo worker após falhas. */
export type WebhookStatus = "active" | "disabled" | "failed";

/** Um webhook registrado (galeed_webhooks). `secret` é o segredo CRU usado pelo worker p/ ASSINAR a
 *  saída (HMAC sha256, idioma de nango.ts). Mostrado UMA vez ao criar; listWebhooks NUNCA o devolve
 *  (secret = "" nas leituras de listagem — só getWebhook o expõe, p/ o worker assinar). */
export interface WebhookRow {
  id: string;                 // uuid (gerado na borda que cria — endpoint /v1/webhooks, C1)
  url: string;                // destino https (SSRF-guard valida na borda, não aqui)
  events: WebhookEvent[];     // eventos assinados (subconjunto não-vazio dos 4)
  secret: string;             // segredo CRU de assinatura (HMAC). "" nas leituras de LISTAGEM.
  label: string;              // rótulo legível (cosmético). "" = sem rótulo.
  status: WebhookStatus;      // active|disabled|failed
  created_by: string;         // principal/email de quem criou ('' = desconhecido)
  created_at?: string;        // preenchido pelo banco
  last_delivery_at?: string | null; // última tentativa de entrega (sucesso ou falha)
  last_error?: string;        // última mensagem de erro de entrega ('' = sem erro)
  failure_count?: number;     // falhas consecutivas (o worker desliga em status='failed' no teto)
}

export type WebhookDeliveryStatus = "queued" | "delivering" | "done" | "dead";

/** Uma entrega na fila (galeed_webhook_deliveries). 1 linha por (webhook, evento) a entregar.
 *  claimNextWebhookDelivery marca 'delivering' com lease (next_attempt_at empurrado p/ o futuro);
 *  markWebhookDelivery fecha em done|dead ou re-agenda (status='queued', next_attempt_at=backoff). */
export interface WebhookDeliveryRow {
  id: string;                 // uuid (gerado por enqueueWebhookDelivery se ausente)
  webhook_id: string;         // galeed_webhooks.id de destino
  event: WebhookEvent;        // o evento sendo entregue
  payload: any;               // corpo assinado/enviado (jsonb)
  status: WebhookDeliveryStatus;
  attempt: number;            // nº de tentativas já feitas (incrementa no claim)
  next_attempt_at?: string;   // ISO; quando fica elegível p/ claim (default now())
  response_status?: number | null; // status HTTP da última tentativa (null = nunca tentou/erro de rede)
  error_message?: string;     // última mensagem de erro ('' = sem erro)
  created_at?: string;
  delivered_at?: string | null; // quando entrou em terminal (done|dead)
}

/** Entrada do enqueue (id/status/attempt/next_attempt_at são preenchidos com default se ausentes). */
export interface WebhookDeliveryInput {
  id?: string;                // uuid; gerado se ausente
  webhook_id: string;
  event: WebhookEvent;
  payload: any;
  nextAttemptAt?: string;     // ISO; default now() (entregável já)
}

/** Patch do markWebhookDelivery — todos opcionais; só os presentes são gravados. */
export interface WebhookDeliveryPatch {
  status: WebhookDeliveryStatus;
  response_status?: number | null;
  error?: string;
  attempt?: number;
  next_attempt_at?: string;   // ISO; re-agenda (backoff) quando volta p/ 'queued'
}

/** Store de WEBHOOKS (`galeed_webhooks` + `galeed_webhook_deliveries`) — C1. Tudo por brain.
 *  Registro é storage puro; a validação (SSRF/escopo) e a entrega (worker) são da borda/worker. */
export interface WebhookStore {
  /** cria/atualiza um webhook (upsert por (brain,id)). unique(brain,url) é arbitrado no banco. */
  putWebhook(row: WebhookRow): Promise<void>;
  /** webhooks do brain. opts.event → só os que assinam o evento (gin sobre events); opts.status filtra.
   *  NÃO devolve o secret (secret = "" em cada linha) — listagem nunca vaza o segredo. */
  listWebhooks(opts?: { event?: WebhookEvent; status?: WebhookStatus }): Promise<WebhookRow[]>;
  /** 1 webhook do brain por id — COM o secret (é a leitura do worker p/ assinar). undefined se não há. */
  getWebhook(id: string): Promise<WebhookRow | undefined>;
  /** remove um webhook do brain. (deliveries pendentes ficam órfãs e morrem no worker — fail-soft.) */
  deleteWebhook(id: string): Promise<void>;
  /** muda status; opcionalmente zera/seta failure_count e last_error (o worker desliga em 'failed'). */
  setWebhookStatus(
    id: string,
    status: WebhookStatus,
    opts?: { failure_count?: number; last_error?: string },
  ): Promise<void>;

  /** enfileira UMA entrega (status='queued'). Devolve o id (gerado se ausente). */
  enqueueWebhookDelivery(delivery: WebhookDeliveryInput): Promise<string>;
  /** claim ATÔMICO da próxima entrega elegível (status='queued' E next_attempt_at<=now()), mais antiga
   *  primeiro. Marca 'delivering', attempt+1 e empurra next_attempt_at por um lease (for update skip
   *  locked → dois workers nunca pegam a mesma). null se nada elegível. */
  claimNextWebhookDelivery(leaseMs?: number): Promise<WebhookDeliveryRow | null>;
  /** fecha/atualiza uma entrega: status + (opcional) response_status/error/attempt/next_attempt_at.
   *  done|dead setam delivered_at=now(); 'queued' (re-agendamento) limpa delivered_at. */
  markWebhookDelivery(id: string, patch: WebhookDeliveryPatch): Promise<void>;
}

export interface Engine
  extends PageStore,
    ExtractionStore,
    FactStore,
    VectorStore,
    EvaluationStore,
    StorageStatsStore,
    AccessStore,
    UsageStore,
    SourceStore,
    ReviewStore,
    PercepcaoStore,
    WebhookStore {
  readonly name: EngineName;

  close(): Promise<void>;
}

// Cache por brain: num CLI o processo morre e fecha tudo; em `serve`/MCP o engine é
// longevo (reusa a conexão Postgres entre chamadas). `brain` é o id do tenant (--brain/env).
const cache = new Map<string, Engine>();

export async function getEngine(brain: string): Promise<Engine> {
  const hit = cache.get(brain);
  if (hit) return hit;
  const { PostgresEngine } = await import("../engines/postgres.ts");
  const engine = await PostgresEngine.open(brain);
  cache.set(brain, engine);
  return engine;
}

/** Fecha tudo (chamado no fim de um comando CLI; NÃO em `serve`/MCP, que são longevos). */
export async function closeEngines(): Promise<void> {
  for (const e of cache.values()) await e.close().catch(() => {});
  cache.clear();
}
