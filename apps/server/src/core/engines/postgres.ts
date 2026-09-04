/** Engine Postgres + pgvector — a FONTE DE VERDADE única do Galeed (DB-native).
 *  Dev local: Postgres+pgvector no Docker (docker compose up -d). Prod: Supabase.
 *
 *  Conexão: env DATABASE_URL (ou GALEED_DB_URL / SUPABASE_DB_URL). Use o POOLER do Supabase
 *  (porta 6543, transaction mode) em prod; o engine desliga prepared statements (pgbouncer).
 *
 *  Multi-tenant: TODAS as linhas têm `brain` (= GALEED_BRAIN ou o flag --brain). Um único
 *  Postgres serve N empresas, isoladas por esse filtro. */
import { config } from "../platform/config.ts";
import { ensurePostgresSchema } from "./postgres-schema.ts";
import type { Engine, PageRow, FactRow, FactGroupKey, EdgeRow, VecRow, ExtractionRow, Hit, SemHit, FactHit, FactsOpts, Stats, StorageStats, GraphData, GraphNode, GraphEdge, GraphQueryHit, ContradictionRow, GoldenRow, EvalRunRow, PrincipalRow, GrantRow, TokenRow, AccessLogRow, ExtractReceiptRow, LlmUsageRow, LlmUsageRollup, SourceRow, SourceRecipe, ReviewItemRow, ReviewStatus, PercepcaoRow, PercepcaoCite, PercepcaoEstado, WebhookRow, WebhookEvent, WebhookStatus, WebhookDeliveryRow, WebhookDeliveryInput, WebhookDeliveryPatch } from "../platform/engine.ts";
import { randomUUID } from "node:crypto";

/** slug de entidade → rótulo legível: "kelvin-cleto" → "Kelvin Cleto", "accelera" → "Accelera". */
function prettyEntity(slug: string): string {
  return slug
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => (w.length <= 3 && w === w.toUpperCase() ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

function dbUrl(): string {
  const u = process.env.DATABASE_URL || process.env.GALEED_DB_URL || process.env.SUPABASE_DB_URL;
  if (!u) {
    throw new Error(
      "defina DATABASE_URL com a connection string Postgres. Dev local: `docker compose up -d` " +
        "e DATABASE_URL=postgresql://galeed:galeed@localhost:5434/galeed. Prod: a string do Supabase (Pooler, porta 6543).",
    );
  }
  return u;
}

function vecLiteral(v: Float32Array): string {
  return "[" + Array.from(v).join(",") + "]"; // formato textual do pgvector
}

export class PostgresEngine implements Engine {
  readonly name = "postgres" as const;
  private sql: any;
  private brain: string;
  private dims: number;

  private constructor(sql: any, brain: string, dims: number) {
    this.sql = sql;
    this.brain = brain;
    this.dims = dims;
  }

  static async open(brain: string): Promise<PostgresEngine> {
    let postgres: any;
    try {
      postgres = (await import("postgres")).default;
    } catch {
      throw new Error("engine postgres requer a lib 'postgres'. Rode: npm i postgres");
    }
    const cfg = config(brain);
    const url = dbUrl();
    const isLocal = url.includes("localhost") || url.includes("127.0.0.1");
    // sslmode=disable na URL desliga o TLS explicitamente. Necessário p/ Postgres em rede privada
    // (Docker/k8s/IP interno) SEM TLS: ali o host não é "localhost", então o "não-local ⇒ require"
    // abaixo tentaria SSL contra um servidor sem TLS e o handshake seria resetado (ECONNRESET).
    const noSsl = isLocal || /[?&]sslmode=disable(\b|$)/.test(url);
    // R11: seta o GUC galeed.brain por conexão (sempre — inócuo se RLS off; as políticas o usam).
    const gucBrain = cfg.brain.replace(/[^a-zA-Z0-9_-]/g, "");
    // M7: GUCs de escopo. Default da CONEXÃO do engine = ADMIN (sem restrição de área/sensibilidade) —
    // o caminho CLI/organize é confiável (dono). A política RLS de escopo (galeed.area_scope/
    // galeed.sensitivity_max) só aperta quando esses GUCs são setados por sessão via applyScopeToSession
    // (core/access/scope.ts) — que HOJE só roda em scripts/htc-m7-rls.ts (prova manual). Nenhuma rota de
    // produção (gateway/BFF/MCP) os seta: o enforcement REAL de escopo em produção é o filtro espelho da
    // app (inScope/filterByScope), camada única. Ver o cabeçalho de scope.ts. Conexão sem GUC = admin.
    const sql = postgres(url, {
      prepare: false, // compatível com o pooler do Supabase (pgbouncer transaction mode)
      max: 4,
      idle_timeout: 20,
      ssl: noSsl ? false : "require",
      onnotice: () => {},
      connection: { options: `-c galeed.brain=${gucBrain}` },
    });
    const engine = new PostgresEngine(sql, cfg.brain, cfg.embeddings.dims);
    await engine.ensureSchema();
    return engine;
  }

  private async ensureSchema(): Promise<void> {
    await ensurePostgresSchema(this.sql, this.dims);
  }

  // ---------- fontes (galeed_pages) ----------

  async upsertPage(r: PageRow): Promise<void> {
    await this.sql`
      insert into galeed_pages (brain, slug, type, title, date, path, body, content_hash, external_id, people, tags, extract_version)
      values (${this.brain}, ${r.slug}, ${r.type}, ${r.title}, ${r.date}, ${r.path || ""}, ${r.body},
        ${r.content_hash ?? ""}, ${r.external_id ?? null},
        ${this.sql.json(r.people ?? [])}, ${this.sql.json(r.tags ?? [])}, ${r.extract_version ?? ""})
      on conflict (brain, slug) do update set
        type = excluded.type, title = excluded.title, date = excluded.date, path = excluded.path,
        body = excluded.body, content_hash = excluded.content_hash, external_id = excluded.external_id,
        people = excluded.people, tags = excluded.tags, extract_version = excluded.extract_version`;
  }

  async allPages(): Promise<PageRow[]> {
    const rows = (await this.sql`
      select slug, type, title, date, path, body, content_hash, external_id, people, tags, extract_version, synopsis, salience, tier, coalesce(sensitivity, 'restrito') as sensitivity
      from galeed_pages where brain = ${this.brain} and coalesce(archived, false) = false`) as any[];
    return rows.map((r) => ({
      slug: r.slug,
      type: r.type,
      title: r.title,
      date: r.date,
      path: r.path || "",
      body: r.body,
      content_hash: r.content_hash || "",
      external_id: r.external_id || undefined,
      people: r.people ?? [],
      tags: r.tags ?? [],
      extract_version: r.extract_version || "",
      synopsis: r.synopsis || "",
      salience: Number(r.salience ?? 0),
      tier: r.tier ?? "hot",
      sensitivity: r.sensitivity ?? "restrito",
    }));
  }

  async setSynopsis(slug: string, synopsis: string, synopsisHash: string): Promise<void> {
    await this.sql`update galeed_pages set synopsis = ${synopsis}, synopsis_hash = ${synopsisHash} where brain = ${this.brain} and slug = ${slug}`;
  }

  async getSynopsis(slug: string): Promise<{ synopsis: string; synopsis_hash: string }> {
    const rows = (await this.sql`select synopsis, synopsis_hash from galeed_pages where brain = ${this.brain} and slug = ${slug} limit 1`) as any[];
    return { synopsis: rows[0]?.synopsis || "", synopsis_hash: rows[0]?.synopsis_hash || "" };
  }

  async setSalience(slug: string, salience: number): Promise<void> {
    await this.sql`update galeed_pages set salience = ${salience} where brain = ${this.brain} and slug = ${slug}`;
  }

  async pageByExternalId(externalId: string): Promise<string | undefined> {
    const rows = (await this.sql`
      select slug from galeed_pages where brain = ${this.brain} and external_id = ${externalId} limit 1`) as any[];
    return rows[0]?.slug;
  }

  async insertPageIfNew(r: PageRow): Promise<boolean> {
    if (!r.external_id) throw new Error("insertPageIfNew exige external_id não-vazio — use upsertPage.");
    const rows = (await this.sql`
      insert into galeed_pages (brain, slug, type, title, date, path, body, content_hash, external_id, people, tags, extract_version)
      values (${this.brain}, ${r.slug}, ${r.type}, ${r.title}, ${r.date}, ${r.path || ""}, ${r.body},
        ${r.content_hash ?? ""}, ${r.external_id},
        ${this.sql.json(r.people ?? [])}, ${this.sql.json(r.tags ?? [])}, ${r.extract_version ?? ""})
      on conflict (brain, external_id) where external_id is not null and external_id <> '' do nothing
      returning slug`) as any[];
    return rows.length > 0;
  }

  async markExtracted(slug: string, version: string): Promise<void> {
    await this.sql`update galeed_pages set extract_version = ${version} where brain = ${this.brain} and slug = ${slug}`;
  }

  // ---------- extrações cruas (galeed_extractions) ----------

  async putExtraction(r: ExtractionRow): Promise<void> {
    await this.sql`
      insert into galeed_extractions (brain, source_slug, type, date, content_hash, prompt_version, extractions)
      values (${this.brain}, ${r.source_slug}, ${r.type}, ${r.date}, ${r.content_hash}, ${r.prompt_version}, ${this.sql.json(r.extractions)})
      on conflict (brain, source_slug) do update set
        type = excluded.type, date = excluded.date, content_hash = excluded.content_hash,
        prompt_version = excluded.prompt_version, extractions = excluded.extractions`;
  }

  async allExtractions(): Promise<ExtractionRow[]> {
    const rows = (await this.sql`
      select source_slug, type, date, content_hash, prompt_version, extractions
      from galeed_extractions where brain = ${this.brain}`) as any[];
    return rows.map((r) => ({
      source_slug: r.source_slug,
      type: r.type,
      date: r.date,
      content_hash: r.content_hash || "",
      prompt_version: r.prompt_version || "",
      extractions: r.extractions ?? {},
    }));
  }

  async extractionMeta(slug: string): Promise<{ content_hash: string; prompt_version: string } | undefined> {
    const rows = (await this.sql`
      select content_hash, prompt_version from galeed_extractions
      where brain = ${this.brain} and source_slug = ${slug} limit 1`) as any[];
    if (!rows[0]) return undefined;
    return { content_hash: rows[0].content_hash || "", prompt_version: rows[0].prompt_version || "" };
  }

  async getExtraction(slug: string): Promise<ExtractionRow | undefined> {
    const rows = (await this.sql`
      select source_slug, type, date, content_hash, prompt_version, extractions
      from galeed_extractions where brain = ${this.brain} and source_slug = ${slug} limit 1`) as any[];
    const r = rows[0];
    if (!r) return undefined;
    return {
      source_slug: r.source_slug,
      type: r.type,
      date: r.date,
      content_hash: r.content_hash || "",
      prompt_version: r.prompt_version || "",
      extractions: r.extractions ?? {},
    };
  }

  // ---------- derivados (galeed_facts/edges) ----------

  async resetIndex(): Promise<void> {
    await this.sql`delete from galeed_facts where brain = ${this.brain}`;
    await this.sql`delete from galeed_edges where brain = ${this.brain}`;
  }

  async replaceDerived(facts: FactRow[], edges: EdgeRow[]): Promise<void> {
    await this.sql.begin(async (sql: any) => {
      await sql`delete from galeed_facts where brain = ${this.brain}`;
      // kind <> 'semantic' (achado tags-e-organizacao#4): arestas semânticas pertencem a OUTRO
      // produtor (buildSemanticLinks → replaceEdgesOfKind). O buildIndex nunca as regenera, então
      // o delete total as matava a cada captura do webhook ('galeed link' era feature morta).
      // replaceDerived é dono SÓ das factuais/tipadas (wikilink, speaker, predicado).
      await sql`delete from galeed_edges where brain = ${this.brain} and kind <> 'semantic'`;
      for (let i = 0; i < facts.length; i += 500) {
        const batch = facts.slice(i, i + 500).map((f) => ({
          brain: this.brain,
          source_slug: f.source_slug,
          type: f.type,
          dimension: f.dimension,
          idx: f.idx,
          text: f.text,
          quote: f.quote,
          meta: this.sql.json(f.meta ?? null),
          entity: f.entity,
          predicate: f.predicate,
          value: f.value,
          value_num: f.value_num ?? null,
          unit: f.unit ?? "",
          period: f.period ?? "",
          tier: f.tier ?? "",
          valid_from: f.valid_from,
          valid_to: f.valid_to,
          confidence: f.confidence,
          status: f.status,
          source_id: f.source_id ?? "",
        }));
        if (batch.length)
          await sql`insert into galeed_facts ${sql(batch, "brain", "source_slug", "type", "dimension", "idx", "text", "quote", "meta", "entity", "predicate", "value", "value_num", "unit", "period", "tier", "valid_from", "valid_to", "confidence", "status", "source_id")}`;
      }
      for (let i = 0; i < edges.length; i += 1000) {
        const batch = edges.slice(i, i + 1000).map((e) => ({ brain: this.brain, src: e.src, dst: e.dst, kind: e.kind ?? "wikilink", weight: e.weight ?? 0 }));
        if (batch.length) await sql`insert into galeed_edges ${sql(batch, "brain", "src", "dst", "kind", "weight")}`;
      }
    });
  }

  /** Mapeia uma linha de galeed_facts → FactRow COMPLETO (inclui idx/meta — os SELECTs de leitura
   *  pública (facts()/currentFacts) projetam menos colunas; a leitura dirigida precisa do shape inteiro
   *  pra alimentar a re-derivação). value_num: number|null, demais colunas opcionais normalizadas. */
  private rowToFact(r: any): FactRow {
    return {
      source_slug: r.source_slug,
      type: r.type,
      dimension: r.dimension,
      idx: r.idx,
      text: r.text,
      quote: r.quote,
      meta: r.meta ?? null,
      entity: r.entity ?? "",
      predicate: r.predicate ?? "",
      value: r.value,
      value_num: r.value_num == null ? null : Number(r.value_num),
      unit: r.unit ?? "",
      period: r.period ?? "",
      tier: r.tier ?? "",
      valid_from: r.valid_from,
      valid_to: r.valid_to,
      confidence: Number(r.confidence ?? 0),
      status: r.status,
      source_id: r.source_id ?? "",
    };
  }

  /** Predicado SQL "(entity,predicate,tier) ∈ keys" como UM ÚNICO `= any($array)` sobre a chave
   *  COMPOSTA concatenada (mesma normalização `coalesce('')` de applyBitemporal — strings vazias casam
   *  standalone). NÃO aninha fragmentos: o OR-reduce anterior (`sql\`${acc} or ${t}\``) montava uma
   *  árvore de N níveis que o driver `postgres` serializava RECURSIVAMENTE (fragment/stringify em
   *  types.js) → com centenas de grupos estourava a pilha (`Maximum call stack size exceeded`; ver
   *  LEARNINGS M16/S8). Aqui é UM fragmento, UM parâmetro text[] → zero recursão, escala pra qualquer N.
   *  Seguro sob `prepare:false` (é `= any($1)`, não o record-literal de tupla composta que dava 0A000 —
   *  ver LEARNINGS M14). SEP = US (0x1F), char de controle que NÃO ocorre em entity/predicate/tier reais
   *  → a concatenação é bijetiva com a tripla (sem colisão). Nota perf: `= any` sobre expressão
   *  concatenada NÃO usa o índice btree (brain,entity,predicate,tier) → scan escopado por brain
   *  (aceitável; correção > perf — índice funcional é dívida futura). `keys` deve ser não-vazio. */
  private groupKeyMatch(sql: any, keys: FactGroupKey[]): any {
    const SEP = ""; // unit separator — não ocorre em entity/predicate/tier reais
    const composite = keys.map((k) => `${k.entity ?? ""}${SEP}${k.predicate ?? ""}${SEP}${k.tier ?? ""}`);
    return sql`(coalesce(entity,'') || ${SEP} || coalesce(predicate,'') || ${SEP} || coalesce(tier,'')) = any(${composite})`;
  }

  /** Leitura DIRIGIDA (M14): SÓ os fatos cujo (entity,predicate,tier) normalizado ∈ `keys`. NÃO
   *  carrega o corpus. `keys=[]` → [] (curto-circuito, sem query). A normalização por coalesce('')
   *  espelha a chave de grupo de applyBitemporal (strings vazias casam fatos standalone). */
  async factsInGroups(keys: FactGroupKey[]): Promise<FactRow[]> {
    if (!keys.length) return [];
    const match = this.groupKeyMatch(this.sql, keys);
    const rows = (await this.sql`
      select source_slug, type, dimension, idx, text, quote, meta,
             entity, predicate, value, value_num, unit, period, tier,
             valid_from, valid_to, confidence, status, source_id
      from galeed_facts
      where brain = ${this.brain}
        and (${match})
    `) as any[];
    return rows.map((r) => this.rowToFact(r));
  }

  /** Escrita DIRIGIDA atômica (M14): UMA transação (sql.begin) que substitui só os fatos/arestas
   *  afetados pelo lote — SEM DELETE do brain inteiro. Espelha replaceDerived (transação + batches +
   *  mapeamento de colunas), só o escopo dos dois DELETE muda. `slugs=[]`+`groupKeys=[]` → não deleta
   *  nada, só insere o que vier (no-op se tudo vazio). Leitor concorrente nunca vê estado parcial. */
  async replaceFactsForSourcesAndGroups(
    slugs: string[],
    groupKeys: FactGroupKey[],
    facts: FactRow[],
    edges: EdgeRow[],
  ): Promise<void> {
    const entities = [...new Set(groupKeys.map((k) => k.entity).filter(Boolean))];
    await this.sql.begin(async (sql: any) => {
      // DELETE escopado — fatos das fontes do lote OU dos grupos afetados. NUNCA o brain inteiro.
      if (slugs.length || groupKeys.length) {
        await sql`
          delete from galeed_facts
          where brain = ${this.brain}
            and ( ${slugs.length ? sql`source_slug = any(${slugs})` : sql`false`}
               or ${groupKeys.length ? sql`(${this.groupKeyMatch(sql, groupKeys)})` : sql`false`} )`;
      }
      // DELETE arestas das entidades afetadas (src) — recompostas pelos `edges` do lote.
      // kind <> 'semantic' (achado tags-e-organizacao#4, defensivo): src de aresta semântica é slug
      // de PÁGINA, que pode colidir com slug de entidade — semânticas têm outro dono, não se apagam aqui.
      if (entities.length) {
        await sql`delete from galeed_edges where brain = ${this.brain} and src = any(${entities}) and kind <> 'semantic'`;
      }
      // INSERT batched — mapeamento de colunas IDÊNTICO ao replaceDerived.
      for (let i = 0; i < facts.length; i += 500) {
        const batch = facts.slice(i, i + 500).map((f) => ({
          brain: this.brain,
          source_slug: f.source_slug,
          type: f.type,
          dimension: f.dimension,
          idx: f.idx,
          text: f.text,
          quote: f.quote,
          meta: this.sql.json(f.meta ?? null),
          entity: f.entity,
          predicate: f.predicate,
          value: f.value,
          value_num: f.value_num ?? null,
          unit: f.unit ?? "",
          period: f.period ?? "",
          tier: f.tier ?? "",
          valid_from: f.valid_from,
          valid_to: f.valid_to,
          confidence: f.confidence,
          status: f.status,
          source_id: f.source_id ?? "",
        }));
        if (batch.length)
          await sql`insert into galeed_facts ${sql(batch, "brain", "source_slug", "type", "dimension", "idx", "text", "quote", "meta", "entity", "predicate", "value", "value_num", "unit", "period", "tier", "valid_from", "valid_to", "confidence", "status", "source_id")}`;
      }
      for (let i = 0; i < edges.length; i += 1000) {
        const batch = edges.slice(i, i + 1000).map((e) => ({ brain: this.brain, src: e.src, dst: e.dst, kind: e.kind ?? "wikilink", weight: e.weight ?? 0 }));
        if (batch.length) await sql`insert into galeed_edges ${sql(batch, "brain", "src", "dst", "kind", "weight")}`;
      }
    });
  }

  async putFacts(rows: FactRow[]): Promise<void> {
    if (!rows.length) return;
    for (let i = 0; i < rows.length; i += 500) {
      const batch = rows.slice(i, i + 500).map((f) => ({
        brain: this.brain,
        source_slug: f.source_slug,
        type: f.type,
        dimension: f.dimension,
        idx: f.idx,
        text: f.text,
        quote: f.quote,
        meta: this.sql.json(f.meta ?? null),
        entity: f.entity,
        predicate: f.predicate,
        value: f.value,
        value_num: f.value_num ?? null,
        unit: f.unit ?? "",
        period: f.period ?? "",
        tier: f.tier ?? "",
        valid_from: f.valid_from,
        valid_to: f.valid_to,
        confidence: f.confidence,
        status: f.status,
        source_id: f.source_id ?? "",
      }));
      await this.sql`insert into galeed_facts ${this.sql(
        batch,
        "brain",
        "source_slug",
        "type",
        "dimension",
        "idx",
        "text",
        "quote",
        "meta",
        "entity",
        "predicate",
        "value",
        "value_num",
        "unit",
        "period",
        "tier",
        "valid_from",
        "valid_to",
        "confidence",
        "status",
        "source_id",
      )}`;
    }
  }

  async putEdges(rows: EdgeRow[]): Promise<void> {
    if (!rows.length) return;
    for (let i = 0; i < rows.length; i += 1000) {
      const batch = rows.slice(i, i + 1000).map((e) => ({ brain: this.brain, src: e.src, dst: e.dst, kind: e.kind ?? "wikilink", weight: e.weight ?? 0 }));
      await this.sql`insert into galeed_edges ${this.sql(batch, "brain", "src", "dst", "kind", "weight")}`;
    }
  }

  /** Substitui TODAS as arestas de um `kind` numa transação (achado tags-e-organizacao#4).
   *  putEdges é insert-only sem dedup — com o delete do replaceDerived agora escopado
   *  (kind <> 'semantic'), o `galeed link` acumularia duplicata a cada rodada; aqui o produtor
   *  das semânticas substitui só o que é dele (idempotente + limpa órfãs). Leitor nunca vê parcial. */
  async replaceEdgesOfKind(kind: string, edges: EdgeRow[]): Promise<void> {
    await this.sql.begin(async (sql: any) => {
      await sql`delete from galeed_edges where brain = ${this.brain} and kind = ${kind}`;
      for (let i = 0; i < edges.length; i += 1000) {
        const batch = edges.slice(i, i + 1000).map((e) => ({ brain: this.brain, src: e.src, dst: e.dst, kind: e.kind ?? kind, weight: e.weight ?? 0 }));
        if (batch.length) await sql`insert into galeed_edges ${sql(batch, "brain", "src", "dst", "kind", "weight")}`;
      }
    });
  }

  // ---------- vetores ----------

  async allVectors(): Promise<VecRow[]> {
    const rows = (await this.sql`select hash, slug, chunk_idx, text, vec::text as vec from galeed_vectors where brain = ${this.brain}`) as any[];
    return rows.map((r) => {
      const arr = String(r.vec).replace(/^\[|\]$/g, "").split(",").map(Number);
      return { hash: r.hash, slug: r.slug, chunk_idx: r.chunk_idx, text: r.text, vec: Float32Array.from(arr) };
    });
  }

  async vectorHashes(): Promise<Set<string>> {
    const rows = await this.sql`select hash from galeed_vectors where brain = ${this.brain}`;
    return new Set((rows as any[]).map((r) => r.hash));
  }

  async putVectors(rows: VecRow[]): Promise<void> {
    if (!rows.length) return;
    for (let i = 0; i < rows.length; i += 200) {
      const batch = rows.slice(i, i + 200);
      await this.sql.begin(async (sql: any) => {
        for (const v of batch) {
          await sql`
            insert into galeed_vectors (brain, hash, slug, chunk_idx, text, vec)
            values (${this.brain}, ${v.hash}, ${v.slug}, ${v.chunk_idx}, ${v.text}, ${vecLiteral(v.vec)}::vector)
            on conflict (brain, hash) do update set
              slug = excluded.slug, chunk_idx = excluded.chunk_idx, text = excluded.text, vec = excluded.vec`;
        }
      });
    }
  }

  async pruneVectors(keep: Set<string>): Promise<void> {
    const have = await this.vectorHashes();
    const dead = [...have].filter((h) => !keep.has(h));
    for (let i = 0; i < dead.length; i += 1000) {
      const chunk = dead.slice(i, i + 1000);
      // NUNCA deleta vetor de página ARQUIVADA (achado decaimento-lixeira#4): o keep-set vem de
      // allPages (que exclui arquivadas), então sem este guard toda ingestão descartava os vetores
      // de arquivada-hot como efeito colateral não-medido — quebrando o contrato do tier ('hot' =
      // vetores presentes) e desarmando o shedCold (a decisão MEDIDA de descartar é dele, via
      // shedVectors por slug). Órfãos de página deletada seguem sendo limpos (not exists → deleta).
      await this.sql`delete from galeed_vectors where brain = ${this.brain} and hash in ${this.sql(chunk)}
        and not exists (
          select 1 from galeed_pages p
          where p.brain = galeed_vectors.brain and p.slug = galeed_vectors.slug
            and coalesce(p.archived, false) = true
        )`;
    }
  }

  async hasVectors(): Promise<boolean> {
    const rows = await this.sql`select exists(select 1 from galeed_vectors where brain = ${this.brain}) as e`;
    return !!(rows as any[])[0]?.e;
  }

  async vectorSearch(qvec: Float32Array, k: number, dedupe: boolean): Promise<SemHit[]> {
    const qs = vecLiteral(qvec);
    if (dedupe) {
      // M6: a busca ANN (inner) ordena SÓ por distância → usa o índice HNSW (rápido). O `distinct on`
      // antigo ordenava por slug primeiro, o que DESLIGAVA o HNSW e fazia varredura full (2.7s→~50ms).
      // Dedup por página é feito no app, preservando a ordem de relevância do ANN.
      const candN = Math.max(k * 20, 150);
      // coalesce(p.archived,false)=false (achado decaimento-lixeira#2): página arquivada FORA da
      // recuperação semântica — alinhado com FTS (search) e graphAll, senão arquivada volta via
      // 'vec' com selo 'registrado'. Filtro PÓS-ANN (não afeta o índice HNSW; candN é generoso).
      // LEFT JOIN preservado: vetor órfão sem página tem p.archived NULL → coalesce false → passa.
      const rows = await this.sql`
        select v.slug, v.chunk_idx, v.text, v.score, p.type, p.title, p.date
        from (
          select slug, chunk_idx, text, (1 - (vec <=> ${qs}::vector)) as score
          from galeed_vectors
          where brain = ${this.brain}
          order by vec <=> ${qs}::vector
          limit ${candN}
        ) v
        left join galeed_pages p on p.brain = ${this.brain} and p.slug = v.slug
        where coalesce(p.archived, false) = false
        order by v.score desc`;
      const seen = new Set<string>();
      const out: SemHit[] = [];
      for (const r of rows as any[]) {
        if (seen.has(r.slug)) continue;
        seen.add(r.slug);
        out.push({ slug: r.slug, chunk_idx: r.chunk_idx, text: r.text, score: Number(r.score), type: r.type, title: r.title, date: r.date });
        if (out.length >= k) break;
      }
      return out;
    }
    // mesmo filtro de archived do ramo dedupe (achado decaimento-lixeira#2).
    const rows = await this.sql`
      select
        v.slug, v.chunk_idx, v.text,
        (1 - (v.vec <=> ${qs}::vector)) as score,
        p.type, p.title, p.date
      from galeed_vectors v
      left join galeed_pages p on p.brain = v.brain and p.slug = v.slug
      where v.brain = ${this.brain} and coalesce(p.archived, false) = false
      order by v.vec <=> ${qs}::vector
      limit ${k}`;
    return (rows as any[]).map((r) => ({
      slug: r.slug,
      chunk_idx: r.chunk_idx,
      text: r.text,
      score: Number(r.score),
      type: r.type,
      title: r.title,
      date: r.date,
    }));
  }

  // ---------- leitura ----------

  async search(q: string, k: number, type?: string): Promise<Hit[]> {
    const typeF = type ? this.sql`and type = ${type}` : this.sql``;
    const run = async (tq: any) =>
      (await this.sql`
        select slug, type, title, date,
          ts_headline('portuguese', body, ${tq}, 'StartSel=[,StopSel=],MaxFragments=1,MaxWords=14,MinWords=5') as excerpt,
          ts_rank(fts, ${tq}) as score
        from galeed_pages
        where brain = ${this.brain} and coalesce(archived, false) = false and fts @@ ${tq} ${typeF}
        order by score desc
        limit ${k}`) as any[];

    // AND primeiro (precisão quando todos os termos batem)…
    const andRows = await run(this.sql`websearch_to_tsquery('portuguese', ${q})`);
    let rows = andRows;
    // …e OR-FALLBACK pra RECALL (M6/D7): query verbosa de agente AND-zera; OR traz o doc certo pro
    // pool (medido: recall do pool 0.82→0.97). O reranker a jusante é quem faz a precisão final.
    if (andRows.length < k) {
      const terms = [...new Set(q.toLowerCase().normalize("NFD").replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 2))];
      if (terms.length) {
        const orRows = await run(this.sql`to_tsquery('portuguese', ${terms.join(" | ")})`);
        const seen = new Set(andRows.map((r) => r.slug));
        rows = andRows.concat(orRows.filter((r) => !seen.has(r.slug))).slice(0, k);
      }
    }
    return rows.map((r) => ({ slug: r.slug, type: r.type, title: r.title, date: r.date, excerpt: r.excerpt, score: Number(r.score) }));
  }

  async getPage(slug: string): Promise<PageRow | undefined> {
    // P1-A (fix do engine, follow-up P0): SELECT completo espelhando allPages — antes não
    // projetava content_hash/external_id/extract_version/salience (voltavam undefined).
    // `archived` projetado (achado decaimento-lixeira#3): getPage NÃO filtra arquivada de propósito
    // (é a leitura pontual do dono — restore/consolidate precisam enxergar a lixeira), mas expõe o
    // flag pro chamador decidir (restoreCold desarquiva; graph-expansion pula).
    const rows = await this.sql`
      select slug, type, title, date, path, body, content_hash, external_id, extract_version, salience,
             people, tags, coalesce(tier, 'hot') as tier, coalesce(sensitivity, 'restrito') as sensitivity,
             coalesce(archived, false) as archived
      from galeed_pages where brain = ${this.brain} and slug = ${slug} limit 1`;
    const r = (rows as any[])[0];
    if (!r) return undefined;
    return {
      ...r,
      content_hash: r.content_hash || "",
      external_id: r.external_id || undefined,
      extract_version: r.extract_version || "",
      salience: Number(r.salience ?? 0),
      people: r.people ?? [], tags: r.tags ?? [], tier: r.tier ?? "hot", sensitivity: r.sensitivity ?? "restrito",
      archived: !!r.archived,
    };
  }

  /** Fragmento: exclui fato cuja PÁGINA-FONTE está arquivada (lixeira — achado vazamento-de-fatos).
   *  Arquivar uma página some com ela da busca/grafo, mas as LEITURAS DE VERDADE (facts/timeline/
   *  currentFacts) precisam parar de servir os fatos dela também, senão o "esquecido" volta a falar.
   *  Reversível de graça: restoreCold faz archived=false e o fato reaparece — zero escrita em
   *  galeed_facts. Correlato ao galeed_facts.source_slug do outer (alias `ap` evita ambiguidade de
   *  coluna com o select sem alias — os dois têm type/tier). Fato ÓRFÃO (source_slug sem página) PASSA,
   *  mesma semântica do LEFT JOIN do vectorSearch. NÃO se aplica a factsInGroups (write-path M14: a
   *  supersessão bitemporal precisa enxergar TODOS os fatos do grupo, arquivados inclusive). */
  private notArchivedSource(sql: any): any {
    return sql`and not exists (
      select 1 from galeed_pages ap
      where ap.brain = ${this.brain} and ap.slug = galeed_facts.source_slug and coalesce(ap.archived, false) = true)`;
  }

  async facts(dimension: string, opts: FactsOpts): Promise<FactHit[]> {
    const lim = opts.limit ?? 200;
    const sql = this.sql;
    const cols = sql`source_slug, type, dimension, text, quote, entity, predicate, value, value_num, unit, period, tier, valid_from, valid_to, confidence, status, source_id`;
    const typeF = opts.type ? sql`and type = ${opts.type}` : sql``;
    const curF = opts.currentOnly ? sql`and (valid_to is null or valid_to = '')` : sql``;
    const asOfF = opts.asOf
      ? sql`and (valid_from = '' or valid_from <= ${opts.asOf}) and (valid_to is null or valid_to = '' or ${opts.asOf} < valid_to)`
      : sql``;
    const rows = (await sql`
      select ${cols} from galeed_facts
      where brain = ${this.brain} and dimension = ${dimension} ${typeF} ${curF} ${asOfF} ${this.notArchivedSource(sql)}
      order by valid_from desc, source_slug asc, idx asc
      limit ${lim}`) as any[];
    return rows.map((r) => ({ ...r, value_num: r.value_num == null ? null : Number(r.value_num) }));
  }

  async timeline(entity: string, opts: { predicate?: string; limit?: number }): Promise<FactHit[]> {
    const lim = opts.limit ?? 200;
    const sql = this.sql;
    const cols = sql`source_slug, type, dimension, text, quote, entity, predicate, value, value_num, unit, period, tier, valid_from, valid_to, confidence, status, source_id`;
    const predF = opts.predicate ? sql`and predicate = ${opts.predicate}` : sql``;
    const rows = (await sql`
      select ${cols} from galeed_facts
      where brain = ${this.brain} and entity = ${entity.toLowerCase()} ${predF} ${this.notArchivedSource(sql)}
      order by predicate, valid_from
      limit ${lim}`) as any[];
    return rows.map((r) => ({ ...r, value_num: r.value_num == null ? null : Number(r.value_num) }));
  }

  async graph(slug: string): Promise<{ slug: string; aponta_para: string[]; apontado_por: string[] }> {
    const out = await this.sql`select dst from galeed_edges where brain = ${this.brain} and src = ${slug}`;
    const inb = await this.sql`select src from galeed_edges where brain = ${this.brain} and dst = ${slug}`;
    return { slug, aponta_para: (out as any[]).map((r) => r.dst), apontado_por: (inb as any[]).map((r) => r.src) };
  }

  async neighbors(slugs: string[]): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    if (!slugs.length) return out;
    const add = (k: string, v: string) => out.set(k, [...(out.get(k) ?? []), v]);
    const fwd = (await this.sql`select src, dst from galeed_edges where brain = ${this.brain} and src in ${this.sql(slugs)}`) as any[];
    const bwd = (await this.sql`select src, dst from galeed_edges where brain = ${this.brain} and dst in ${this.sql(slugs)}`) as any[];
    for (const e of fwd) add(e.src, e.dst);
    for (const e of bwd) add(e.dst, e.src);
    return out;
  }

  async pagesBySlug(slugs: string[]): Promise<Map<string, PageRow>> {
    const out = new Map<string, PageRow>();
    if (!slugs.length) return out;
    // P1-A (fix do engine): SELECT completo espelhando allPages/getPage.
    // `archived` exposto e NÃO filtrado aqui (achado decaimento-lixeira#2): pagesBySlug tem ~10
    // callers com semânticas distintas (gate de ingestão, escopo, ask) que podem precisar enxergar
    // arquivadas — quem exclui é o consumidor (ex.: graph-expansion do retrieve pula p.archived).
    const rows = (await this.sql`
      select slug, type, title, date, path, body, content_hash, external_id, extract_version, salience,
             people, tags, coalesce(tier, 'hot') as tier, coalesce(sensitivity, 'restrito') as sensitivity,
             coalesce(archived, false) as archived from galeed_pages
      where brain = ${this.brain} and slug in ${this.sql(slugs)}`) as any[];
    for (const r of rows)
      out.set(r.slug, {
        ...r,
        content_hash: r.content_hash || "",
        external_id: r.external_id || undefined,
        extract_version: r.extract_version || "",
        salience: Number(r.salience ?? 0),
        people: r.people ?? [], tags: r.tags ?? [], tier: r.tier ?? "hot", sensitivity: r.sensitivity ?? "restrito",
        archived: !!r.archived,
      });
    return out;
  }

  async graphAll(): Promise<GraphData> {
    const sql = this.sql;
    const pages = (await sql`select slug, type, title, date, salience, tier from galeed_pages where brain = ${this.brain} and coalesce(archived, false) = false`) as any[];
    const fcounts = (await sql`select source_slug, count(*)::int c from galeed_facts where brain = ${this.brain} group by source_slug`) as any[];
    const edgeRows = (await sql`select distinct src, dst, kind, weight from galeed_edges where brain = ${this.brain}`) as any[];
    const factBy = new Map(fcounts.map((r) => [r.source_slug, Number(r.c)]));
    const known = new Set(pages.map((p) => p.slug));
    const nodes = pages.map((p) => ({
      id: p.slug,
      label: p.title || p.slug,
      type: p.type || "nota",
      date: p.date || "",
      exists: true,
      factCount: factBy.get(p.slug) ?? 0,
      salience: Number(p.salience ?? 0),
      tier: p.tier ?? "hot",
    }));
    const ghosts = new Set<string>();
    for (const e of edgeRows) if (!known.has(e.dst)) ghosts.add(e.dst);
    for (const g of ghosts) nodes.push({ id: g, label: g, type: "ausente", date: "", exists: false, factCount: 0 });
    const edges = edgeRows.map((e) => ({ src: e.src, dst: e.dst, kind: e.kind || "wikilink", weight: e.weight || undefined }));
    return { nodes, edges };
  }

  async entityGraph(opts: { minFacts?: number; minShared?: number; maxNodes?: number } = {}): Promise<GraphData> {
    const sql = this.sql;
    const minFacts = opts.minFacts ?? 3; // entidade só vira nó com >= N fatos (corta ruído)
    const minShared = opts.minShared ?? 2; // co-ocorrência só vira aresta com >= N fontes em comum
    const maxNodes = opts.maxNodes ?? 240;
    const REL_PREDS = ["aluno_de", "afiliacao", "membro_de", "trabalha_em", "mentor_de"]; // relação entidade→entidade

    // 1) NÓS = entidades com fatos estruturados; tamanho ∝ nº de fatos, data = 1º fato visto.
    const ents = (await sql`
      select entity,
             count(*)::int c,
             min(nullif(valid_from, '')) first_seen,
             array_agg(distinct predicate) preds
      from galeed_facts
      where brain = ${this.brain} and entity <> ''
      group by entity
      having count(*) >= ${minFacts}
      order by count(*) desc
      limit ${maxNodes}
    `) as any[];
    const keep = new Set<string>(ents.map((e) => e.entity));

    // entidades que são ALVO de relações (X aluno_de ACCELERA) → hub = "org"
    const hubRows = (await sql`
      select lower(value) v, count(*)::int c
      from galeed_facts
      where brain = ${this.brain} and predicate = any(${REL_PREDS}) and value <> ''
      group by lower(value)
    `) as any[];
    const hubs = new Set<string>(hubRows.filter((r) => Number(r.c) >= 2).map((r) => r.v));
    const PESSOA_PREDS = new Set(["cargo", "funcao", "papel", "profissao", "aluno_de"]);

    const nodes: GraphNode[] = ents.map((e) => {
      const preds: string[] = e.preds ?? [];
      const role = hubs.has(e.entity) ? "org" : preds.some((p) => PESSOA_PREDS.has(p)) ? "pessoa" : "assunto";
      return {
        id: e.entity,
        label: prettyEntity(e.entity),
        type: role,
        role,
        date: e.first_seen || "",
        exists: true,
        factCount: Number(e.c),
      };
    });

    const edges: GraphEdge[] = [];
    const seen = new Set<string>(); // par não-direcionado já ligado (evita duplicar)
    const pairKey = (a: string, b: string) => (a < b ? `${a}>${b}` : `${b}>${a}`);

    // 2) ARESTAS de co-ocorrência: entidades que aparecem na MESMA fonte (peso = nº de fontes).
    const coocRows = (await sql`
      select a.entity src, b.entity dst, count(distinct a.source_slug)::int w
      from galeed_facts a
      join galeed_facts b
        on a.brain = b.brain and a.source_slug = b.source_slug and a.entity < b.entity
      where a.brain = ${this.brain} and a.entity <> '' and b.entity <> ''
      group by a.entity, b.entity
      having count(distinct a.source_slug) >= ${minShared}
    `) as any[];
    for (const r of coocRows) {
      if (!keep.has(r.src) || !keep.has(r.dst)) continue;
      seen.add(pairKey(r.src, r.dst));
      edges.push({ src: r.src, dst: r.dst, kind: "cooc", weight: Number(r.w) });
    }

    // 3) ARESTAS relacionais (X aluno_de ENT) — só quando o alvo também é um nó; não duplica co-oc.
    const relRows = (await sql`
      select entity src, lower(value) dst, predicate
      from galeed_facts
      where brain = ${this.brain} and predicate = any(${REL_PREDS}) and entity <> '' and value <> ''
    `) as any[];
    for (const r of relRows) {
      if (!keep.has(r.src) || !keep.has(r.dst) || r.src === r.dst) continue;
      const key = pairKey(r.src, r.dst);
      if (seen.has(key)) continue; // já ligados por co-ocorrência
      seen.add(key);
      edges.push({ src: r.src, dst: r.dst, kind: r.predicate, weight: 3 });
    }

    // 4) ARESTAS aprovadas do SONHO v2 (M24-B): pares 'conexao_sugerida' decididos na fila M21.
    //    A fila é a fonte DURÁVEL (linha nunca deletada — invariante #5; sobrevive a
    //    resetIndex/replaceDerived, que só varrem galeed_facts/galeed_edges) — a aresta é
    //    DERIVADA da decisão humana, não uma linha própria. kind tipado 'conexao'; weight 2
    //    (constante na escala das arestas existentes — cooc ≥2, relação 3; o score vive no
    //    claim). Par já ligado por co-ocorrência/relação não duplica (seen). Endpoint que
    //    saiu do corte de nós (minFacts/maxNodes) é omitido — consistente com os passos 2-3.
    const dreamRows = (await sql`
      select claim from galeed_ingest_review
      where brain = ${this.brain} and reason = 'conexao_sugerida' and status = 'aprovada'
    `) as any[];
    for (const r of dreamRows) {
      const a = String(r.claim?.a || "");
      const b = String(r.claim?.b || "");
      if (!a || !b || a === b || !keep.has(a) || !keep.has(b)) continue;
      const key = pairKey(a, b);
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ src: a, dst: b, kind: "conexao", weight: 2 });
    }

    return { nodes, edges };
  }

  async stats(): Promise<Stats> {
    const one = async (q: any) => Number((await q)[0]?.c ?? 0);
    return {
      pages: await one(this.sql`select count(*)::int c from galeed_pages where brain = ${this.brain}`),
      facts: await one(this.sql`select count(*)::int c from galeed_facts where brain = ${this.brain}`),
      edges: await one(this.sql`select count(*)::int c from galeed_edges where brain = ${this.brain}`),
      vectors: await one(this.sql`select count(*)::int c from galeed_vectors where brain = ${this.brain}`),
    };
  }

  // ---------- reconcile ----------

  async getReconcile(): Promise<Record<string, Record<string, string>>> {
    const rows = (await this.sql`select entity, predicate, canonical from galeed_reconcile where brain = ${this.brain}`) as any[];
    const map: Record<string, Record<string, string>> = {};
    for (const r of rows) (map[r.entity] ??= {})[r.predicate] = r.canonical;
    return map;
  }

  async putReconcile(map: Record<string, Record<string, string>>): Promise<void> {
    await this.sql`delete from galeed_reconcile where brain = ${this.brain}`;
    const batch: any[] = [];
    for (const [entity, preds] of Object.entries(map))
      for (const [predicate, canonical] of Object.entries(preds)) batch.push({ brain: this.brain, entity, predicate, canonical });
    if (batch.length) await this.sql`insert into galeed_reconcile ${this.sql(batch, "brain", "entity", "predicate", "canonical")}`;
  }

  async getEntityResolve(): Promise<Record<string, string>> {
    const rows = (await this.sql`select alias, canonical from galeed_entity_resolve where brain = ${this.brain}`) as any[];
    const map: Record<string, string> = {};
    for (const r of rows) map[r.alias] = r.canonical;
    return map;
  }

  async putEntityResolve(map: Record<string, string>): Promise<void> {
    await this.sql`delete from galeed_entity_resolve where brain = ${this.brain}`;
    const batch = Object.entries(map).map(([alias, canonical]) => ({ brain: this.brain, alias, canonical }));
    if (batch.length) await this.sql`insert into galeed_entity_resolve ${this.sql(batch, "brain", "alias", "canonical")}`;
  }

  async resolveEntity(alias: string): Promise<string> {
    const a = alias.toLowerCase().trim();
    const rows = (await this.sql`select canonical from galeed_entity_resolve where brain = ${this.brain} and alias = ${a} limit 1`) as any[];
    return rows[0]?.canonical || a;
  }

  // ---- desempate de entidade ambígua (cache do LLM — fix sobre-fusão #R3, migração 54) ----

  async getEntityDisambig(groupKey: string): Promise<string[][] | null> {
    const rows = (await this.sql`select decision from galeed_entity_disambig where brain = ${this.brain} and group_key = ${groupKey} limit 1`) as any[];
    return rows[0]?.decision ?? null; // jsonb já vem parseado pela lib postgres
  }

  async putEntityDisambig(groupKey: string, decision: string[][]): Promise<void> {
    // jsonb com a lib `postgres` EXIGE sql.json(...) — interpolar JSON.stringify com ::jsonb dupla-serializa.
    await this.sql`
      insert into galeed_entity_disambig (brain, group_key, decision, updated_at)
      values (${this.brain}, ${groupKey}, ${this.sql.json(decision)}, now())
      on conflict (brain, group_key) do update set decision = excluded.decision, updated_at = now()`;
  }

  async graphQuery(node: string, opts: { predicate?: string; currentOnly?: boolean; limit?: number }): Promise<GraphQueryHit[]> {
    const sql = this.sql;
    const n = node.toLowerCase().trim();
    const currentOnly = opts.currentOnly !== false; // default: só vigentes
    const predF = opts.predicate ? sql`and predicate = ${opts.predicate}` : sql``;
    const curF = currentOnly ? sql`and (valid_to is null or valid_to = '')` : sql``;
    const rows = (await sql`
      select entity, predicate, value, value_num, unit, period, tier, text, confidence, source_slug, valid_from, valid_to,
             case when entity = ${n} then 'out' else 'in' end as direction
      from galeed_facts
      where brain = ${this.brain} and entity != '' and predicate != ''
        and (entity = ${n} or lower(value) = ${n}) ${predF} ${curF}
      order by confidence desc nulls last
      limit ${opts.limit ?? 100}`) as any[];
    return rows.map((r) => ({
      direction: r.direction,
      entity: r.entity,
      predicate: r.predicate,
      value: r.value,
      value_num: r.value_num == null ? null : Number(r.value_num),
      unit: r.unit || "",
      period: r.period || "",
      tier: r.tier || "",
      text: r.text,
      confidence: Number(r.confidence ?? 0),
      source_slug: r.source_slug,
      valid_from: r.valid_from || "",
      valid_to: r.valid_to || "",
    }));
  }

  /** Fatos VIGENTES (verdade atual) do brain. Predicado de vigência (D3, P1-A): o PAR
   *  status='fato' AND valid_to vazio — `nao-verificado`/`corroborado`/`arquivado` NUNCA são
   *  verdade vigente. Com a supersessão v2 (L1), há no máximo 1 linha por grupo (entity,predicate,
   *  tier). ORDER BY determinístico (entity,predicate,tier,valid_from desc,source_slug). O índice
   *  parcial `galeed_facts_vigentes` (migração 26) serve EXATAMENTE este WHERE. */
  async currentFacts(): Promise<FactHit[]> {
    const rows = (await this.sql`
      select source_slug, type, dimension, text, quote, entity, predicate, value, value_num, unit, period, tier, valid_from, valid_to, confidence, status, source_id
      from galeed_facts
      where brain = ${this.brain} and entity <> '' and status = 'fato'
        and (valid_to is null or valid_to = '')
        ${this.notArchivedSource(this.sql)}
      order by entity asc, predicate asc, tier asc, valid_from desc, source_slug asc`) as any[];
    return rows.map((r) => ({ ...r, value_num: r.value_num == null ? null : Number(r.value_num) })) as FactHit[];
  }

  async getContradictionCache(): Promise<Set<string>> {
    // só os JÁ JULGADOS (verdict != 'suspeita'); 'suspeita' = ainda não julgado → revisita no próximo run
    const rows = (await this.sql`select hash from galeed_contradictions where brain = ${this.brain} and verdict <> 'suspeita'`) as any[];
    return new Set(rows.map((r) => r.hash));
  }

  async putContradiction(r: ContradictionRow): Promise<void> {
    await this.sql`
      insert into galeed_contradictions (brain, hash, entity, a_slug, a_text, a_value, a_valid_from, b_slug, b_text, b_value, b_valid_from, rule, verdict, severity, confidence)
      values (${this.brain}, ${r.hash}, ${r.entity}, ${r.a_slug}, ${r.a_text}, ${r.a_value}, ${r.a_valid_from}, ${r.b_slug}, ${r.b_text}, ${r.b_value}, ${r.b_valid_from}, ${r.rule}, ${r.verdict}, ${r.severity}, ${r.confidence})
      on conflict (brain, hash) do update set
        verdict = excluded.verdict, severity = excluded.severity, confidence = excluded.confidence`;
  }

  async allContradictions(): Promise<ContradictionRow[]> {
    const rows = (await this.sql`
      select hash, entity, a_slug, a_text, a_value, a_valid_from, b_slug, b_text, b_value, b_valid_from, rule, verdict, severity, confidence
      from galeed_contradictions where brain = ${this.brain} order by entity, severity`) as any[];
    return rows.map((r) => ({ ...r, confidence: Number(r.confidence ?? 0) }));
  }

  // ---------- eval de qualidade (M3/S1) ----------

  async putGolden(row: GoldenRow): Promise<void> {
    await this.sql`
      insert into galeed_eval_golden (brain, qid, query, expected, note)
      values (${this.brain}, ${row.qid}, ${row.query}, ${this.sql.json(row.expected)}, ${row.note || ""})
      on conflict (brain, qid) do update set query = excluded.query, expected = excluded.expected, note = excluded.note`;
  }

  async allGolden(): Promise<GoldenRow[]> {
    const rows = (await this.sql`select qid, query, expected, note from galeed_eval_golden where brain = ${this.brain}`) as any[];
    return rows.map((r) => ({ qid: r.qid, query: r.query, expected: r.expected ?? [], note: r.note || "" }));
  }

  async putEvalRun(row: Omit<EvalRunRow, "run_id" | "created_at">): Promise<number> {
    const rows = (await this.sql`
      insert into galeed_eval_runs (brain, k, p_at_k, recall_at_k, mrr, n_queries, per_query, params)
      values (${this.brain}, ${row.k}, ${row.p_at_k}, ${row.recall_at_k}, ${row.mrr}, ${row.n_queries}, ${this.sql.json(row.per_query)}, ${this.sql.json(row.params)})
      returning run_id`) as any[];
    return Number(rows[0].run_id);
  }

  async lastEvalRuns(n: number): Promise<EvalRunRow[]> {
    const rows = (await this.sql`
      select run_id, k, p_at_k, recall_at_k, mrr, n_queries, per_query, params, created_at
      from galeed_eval_runs where brain = ${this.brain} order by run_id desc limit ${n}`) as any[];
    return rows.map((r) => ({
      run_id: Number(r.run_id),
      k: r.k,
      p_at_k: Number(r.p_at_k),
      recall_at_k: Number(r.recall_at_k),
      mrr: Number(r.mrr),
      n_queries: r.n_queries,
      per_query: r.per_query ?? [],
      params: r.params ?? {},
      created_at: r.created_at,
    }));
  }

  // ---------- hipóteses ----------

  async replaceHypotheses(rows: { slug: string; a: string; b: string; shared: string[]; surprise: number; status: string; confidence: string; text: string }[]): Promise<void> {
    await this.sql`delete from galeed_hypotheses where brain = ${this.brain}`;
    if (!rows.length) return;
    const batch = rows.map((h) => ({
      brain: this.brain,
      slug: h.slug,
      a: h.a,
      b: h.b,
      shared: this.sql.json(h.shared),
      surprise: h.surprise,
      status: h.status,
      confidence: h.confidence,
      text: h.text,
    }));
    await this.sql`insert into galeed_hypotheses ${this.sql(batch, "brain", "slug", "a", "b", "shared", "surprise", "status", "confidence", "text")}`;
  }

  async allHypotheses(): Promise<any[]> {
    const rows = (await this.sql`select slug, a, b, shared, surprise, status, confidence, text from galeed_hypotheses where brain = ${this.brain}`) as any[];
    return rows.map((r) => ({ ...r, shared: r.shared ?? [] }));
  }

  async updateHypothesis(slug: string, patch: any): Promise<void> {
    const cur = (await this.sql`select status, confidence, surprise from galeed_hypotheses where brain = ${this.brain} and slug = ${slug} limit 1`) as any[];
    if (!cur[0]) return;
    const status = patch.status ?? cur[0].status;
    const confidence = patch.confidence ?? cur[0].confidence;
    const surprise = patch.surprise ?? cur[0].surprise;
    await this.sql`update galeed_hypotheses set status = ${status}, confidence = ${confidence}, surprise = ${surprise} where brain = ${this.brain} and slug = ${slug}`;
  }

  async archiveHypothesis(slug: string): Promise<void> {
    await this.sql`update galeed_hypotheses set status = 'arquivada' where brain = ${this.brain} and slug = ${slug}`;
  }

  // ---------- reflexão ----------

  async reflectedSlugs(): Promise<Set<string>> {
    const rows = (await this.sql`select slug from galeed_pages where brain = ${this.brain} and reflected = true`) as any[];
    return new Set(rows.map((r) => r.slug));
  }

  async markReflected(slugs: string[]): Promise<void> {
    if (!slugs.length) return;
    await this.sql`update galeed_pages set reflected = true where brain = ${this.brain} and slug in ${this.sql(slugs)}`;
  }

  async putReflection(row: { question: string; text: string; sources: string[] }): Promise<void> {
    await this.sql`
      insert into galeed_reflections (brain, question, text, sources)
      values (${this.brain}, ${row.question}, ${row.text}, ${this.sql.json(row.sources)})`;
  }

  // ---------- poda ----------

  async setArchived(slug: string, archived: boolean): Promise<void> {
    await this.sql`update galeed_pages set archived = ${archived} where brain = ${this.brain} and slug = ${slug}`;
  }

  // ---------- tiering (M5/R1) — esquecer de verdade, reversível e medido ----------

  private rowToPage(r: any): PageRow {
    return {
      slug: r.slug,
      type: r.type,
      title: r.title,
      date: r.date,
      path: r.path || "",
      body: r.body,
      content_hash: r.content_hash || "",
      external_id: r.external_id || undefined,
      people: r.people ?? [],
      tags: r.tags ?? [],
      extract_version: r.extract_version || "",
      synopsis: r.synopsis || "",
      salience: Number(r.salience ?? 0),
      tier: r.tier ?? "hot",
    };
  }

  async setTier(slug: string, tier: string): Promise<void> {
    await this.sql`update galeed_pages set tier = ${tier} where brain = ${this.brain} and slug = ${slug}`;
  }

  async shedVectors(slug: string): Promise<number> {
    const r = await this.sql`delete from galeed_vectors where brain = ${this.brain} and slug = ${slug}`;
    return (r as any).count ?? 0;
  }

  async coldPages(): Promise<PageRow[]> {
    const rows = (await this.sql`
      select slug, type, title, date, path, body, content_hash, external_id, people, tags, extract_version, synopsis, salience, tier
      from galeed_pages where brain = ${this.brain} and tier = 'cold'`) as any[];
    return rows.map((r) => this.rowToPage(r));
  }

  async shedCandidates(): Promise<PageRow[]> {
    const rows = (await this.sql`
      select slug, type, title, date, path, body, content_hash, external_id, people, tags, extract_version, synopsis, salience, tier
      from galeed_pages
      where brain = ${this.brain} and coalesce(archived, false) = true and coalesce(tier, 'hot') = 'hot'`) as any[];
    return rows.map((r) => this.rowToPage(r));
  }

  async storageStats(): Promise<StorageStats> {
    const rows = (await this.sql`
      select
        count(*)::int as pages_total,
        count(*) filter (where coalesce(tier, 'hot') = 'hot')::int as pages_hot,
        count(*) filter (where coalesce(tier, 'hot') = 'cold')::int as pages_cold,
        count(*) filter (where coalesce(archived, false) = true)::int as pages_archived,
        coalesce(sum(octet_length(body)), 0)::bigint as body_bytes
      from galeed_pages where brain = ${this.brain}`) as any[];
    const p = rows[0] ?? {};
    const one = async (q: any) => Number((await q)[0]?.c ?? 0);
    const vectors = await one(this.sql`select count(*)::int c from galeed_vectors where brain = ${this.brain}`);
    const facts = await one(this.sql`select count(*)::int c from galeed_facts where brain = ${this.brain}`);
    const edges = await one(this.sql`select count(*)::int c from galeed_edges where brain = ${this.brain}`);
    return {
      pagesTotal: Number(p.pages_total ?? 0),
      pagesHot: Number(p.pages_hot ?? 0),
      pagesCold: Number(p.pages_cold ?? 0),
      pagesArchived: Number(p.pages_archived ?? 0),
      vectors,
      facts,
      edges,
      bodyBytes: Number(p.body_bytes ?? 0),
    };
  }

  // ---------- RBAC (M7/R16) — storage puro; a lógica de escopo é do S2 ----------

  async upsertPrincipal(r: PrincipalRow): Promise<void> {
    await this.sql`insert into galeed_principals (brain, id, kind, label, email, status)
      values (${this.brain}, ${r.id}, ${r.kind}, ${r.label}, ${r.email ?? ""}, ${r.status ?? "active"})
      on conflict (brain, id) do update set
        kind = excluded.kind, label = excluded.label, email = excluded.email, status = excluded.status`;
  }

  async getPrincipal(id: string): Promise<PrincipalRow | undefined> {
    const rows = (await this.sql`select id, kind, label, email, status, created_at
      from galeed_principals where brain = ${this.brain} and id = ${id} limit 1`) as any[];
    if (!rows[0]) return undefined;
    return { ...rows[0], email: rows[0].email || "", created_at: String(rows[0].created_at ?? "") };
  }

  async allPrincipals(): Promise<PrincipalRow[]> {
    const rows = (await this.sql`select id, kind, label, email, status, created_at
      from galeed_principals where brain = ${this.brain} order by created_at`) as any[];
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      label: r.label || "",
      email: r.email || "",
      status: r.status || "active",
      created_at: String(r.created_at ?? ""),
    }));
  }

  async setPrincipalStatus(id: string, status: string): Promise<void> {
    await this.sql`update galeed_principals set status = ${status} where brain = ${this.brain} and id = ${id}`;
  }

  async putGrant(r: GrantRow): Promise<void> {
    await this.sql`insert into galeed_grants (brain, principal_id, areas, sensitivity_max, deny_types, scope, can_ingest)
      values (${this.brain}, ${r.principal_id}, ${this.sql.json(r.areas ?? [])},
        ${r.sensitivity_max ?? "publico"}, ${this.sql.json(r.deny_types ?? [])}, ${r.scope ?? "read"},
        ${r.can_ingest ?? false})
      on conflict (brain, principal_id) do update set
        areas = excluded.areas, sensitivity_max = excluded.sensitivity_max,
        deny_types = excluded.deny_types, scope = excluded.scope, can_ingest = excluded.can_ingest`;
  }

  async getGrant(principalId: string): Promise<GrantRow | undefined> {
    const rows = (await this.sql`select principal_id, areas, sensitivity_max, deny_types, scope, can_ingest
      from galeed_grants where brain = ${this.brain} and principal_id = ${principalId} limit 1`) as any[];
    if (!rows[0]) return undefined;
    return {
      principal_id: rows[0].principal_id,
      areas: rows[0].areas ?? [],
      sensitivity_max: rows[0].sensitivity_max || "publico",
      deny_types: rows[0].deny_types ?? [],
      scope: rows[0].scope || "read",
      can_ingest: rows[0].can_ingest ?? false, // fail-closed: coluna null/ausente = sem escrita
    };
  }

  async upsertToken(r: TokenRow): Promise<void> {
    await this.sql`insert into galeed_tokens (brain, principal_id, token_hash, label, revoked)
      values (${this.brain}, ${r.principal_id}, ${r.token_hash}, ${r.label ?? ""}, ${r.revoked ?? false})
      on conflict (brain, token_hash) do update set
        principal_id = excluded.principal_id, label = excluded.label, revoked = excluded.revoked`;
  }

  async tokenByHash(tokenHash: string): Promise<TokenRow | undefined> {
    const rows = (await this.sql`select principal_id, token_hash, label, last_used_at, revoked
      from galeed_tokens where brain = ${this.brain} and token_hash = ${tokenHash} limit 1`) as any[];
    if (!rows[0]) return undefined;
    return {
      principal_id: rows[0].principal_id,
      token_hash: rows[0].token_hash,
      label: rows[0].label || "",
      last_used_at: String(rows[0].last_used_at ?? "") || undefined,
      revoked: !!rows[0].revoked,
    };
  }

  /** GATEWAY /v1: busca GLOBAL (sem filtro de brain) — deriva o tenant do token cru. token_hash é
   *  sha256 de 32 bytes aleatórios → único de fato entre brains. Só não-revogados. null = não achou. */
  async tokenByHashGlobal(tokenHash: string): Promise<{ brain: string; principal_id: string } | null> {
    const rows = (await this.sql`select brain, principal_id from galeed_tokens
      where token_hash = ${tokenHash} and revoked = false limit 1`) as any[];
    if (!rows[0]) return null;
    return { brain: rows[0].brain, principal_id: rows[0].principal_id };
  }

  async revokeToken(tokenHash: string): Promise<void> {
    await this.sql`update galeed_tokens set revoked = true where brain = ${this.brain} and token_hash = ${tokenHash}`;
  }

  async touchToken(tokenHash: string): Promise<void> {
    await this.sql`update galeed_tokens set last_used_at = now() where brain = ${this.brain} and token_hash = ${tokenHash}`;
  }

  async tokensOf(principalId: string): Promise<TokenRow[]> {
    const rows = (await this.sql`select principal_id, token_hash, label, last_used_at, revoked
      from galeed_tokens where brain = ${this.brain} and principal_id = ${principalId}
      order by created_at desc`) as any[];
    return rows.map((r) => ({
      principal_id: r.principal_id,
      token_hash: r.token_hash,
      label: r.label || "",
      last_used_at: String(r.last_used_at ?? "") || undefined,
      revoked: !!r.revoked,
    }));
  }

  async deletePrincipal(id: string): Promise<void> {
    await this.sql`delete from galeed_grants where brain = ${this.brain} and principal_id = ${id}`;
    await this.sql`delete from galeed_tokens where brain = ${this.brain} and principal_id = ${id}`;
    await this.sql`delete from galeed_principals where brain = ${this.brain} and id = ${id}`;
  }

  async appendAccessLog(r: AccessLogRow): Promise<void> {
    await this.sql`insert into galeed_access_log (brain, principal_id, query, areas_touched, n_returned, event, actor)
      values (${this.brain}, ${r.principal_id}, ${r.query ?? ""},
        ${this.sql.json(r.areas_touched ?? [])}, ${r.n_returned ?? 0},
        ${r.event ?? null}, ${r.actor ?? null})`;
  }

  async recentAccessLog(limit: number): Promise<AccessLogRow[]> {
    const rows = (await this.sql`select principal_id, ts, query, areas_touched, n_returned, event, actor
      from galeed_access_log where brain = ${this.brain} order by ts desc limit ${limit}`) as any[];
    return rows.map((r) => ({
      principal_id: r.principal_id,
      ts: String(r.ts ?? ""),
      query: r.query || "",
      areas_touched: r.areas_touched ?? [],
      n_returned: Number(r.n_returned ?? 0),
      event: r.event ?? undefined,
      actor: r.actor ?? undefined,
    }));
  }

  // ---------- classificação + área (M7) — storage puro ----------

  async setSensitivity(slug: string, sensitivity: string): Promise<void> {
    await this.sql`update galeed_pages set sensitivity = ${sensitivity} where brain = ${this.brain} and slug = ${slug}`;
  }

  async setArea(slug: string, area: string): Promise<boolean> {
    const tag = `area:${area}`;
    const rows = (await this.sql`select tags from galeed_pages where brain = ${this.brain} and slug = ${slug} limit 1`) as any[];
    if (!rows[0]) return false;
    const tags: string[] = rows[0].tags ?? [];
    if (tags.includes(tag)) return false;
    await this.sql`update galeed_pages set tags = ${this.sql.json([...tags, tag])} where brain = ${this.brain} and slug = ${slug}`;
    return true;
  }

  async removeArea(slug: string, area: string): Promise<boolean> {
    const tag = `area:${area}`;
    const rows = (await this.sql`select tags from galeed_pages where brain = ${this.brain} and slug = ${slug} limit 1`) as any[];
    if (!rows[0]) return false;
    const tags: string[] = rows[0].tags ?? [];
    if (!tags.includes(tag)) return false;
    await this.sql`update galeed_pages set tags = ${this.sql.json(tags.filter((t) => t !== tag))} where brain = ${this.brain} and slug = ${slug}`;
    return true;
  }

  // ---------- receipts de extração (M9/S1 declara; S5 consome) ----------

  async putExtractReceipt(r: ExtractReceiptRow): Promise<void> {
    await this.sql`insert into galeed_extract_receipts
      (brain, run_id, fixture_corpus, model, prompt_version, schema_version, corpus_sha8,
       tokens_in, tokens_out, cost_usd, recall, per_dim)
      values (${this.brain}, ${r.run_id}, ${r.fixture_corpus ?? ""}, ${r.model ?? ""}, ${r.prompt_version ?? ""},
       ${r.schema_version ?? ""}, ${r.corpus_sha8 ?? ""}, ${r.tokens_in ?? 0}, ${r.tokens_out ?? 0},
       ${r.cost_usd ?? 0}, ${r.recall ?? null}, ${this.sql.json(r.per_dim ?? {})})
      on conflict (brain, run_id) do nothing`;
  }

  async extractReceipts(limit = 50): Promise<ExtractReceiptRow[]> {
    const rows = (await this.sql`select run_id, fixture_corpus, model, prompt_version, schema_version,
      corpus_sha8, tokens_in, tokens_out, cost_usd, recall, per_dim
      from galeed_extract_receipts where brain = ${this.brain} order by created_at desc limit ${limit}`) as any[];
    return rows.map((r) => ({ run_id: r.run_id, fixture_corpus: r.fixture_corpus || "", model: r.model || "",
      prompt_version: r.prompt_version || "", schema_version: r.schema_version || "", corpus_sha8: r.corpus_sha8 || "",
      tokens_in: Number(r.tokens_in ?? 0), tokens_out: Number(r.tokens_out ?? 0), cost_usd: Number(r.cost_usd ?? 0),
      recall: r.recall == null ? null : Number(r.recall), per_dim: r.per_dim ?? {} }));
  }

  async extractReceiptRollup(): Promise<{ runs: number; cost_usd_total: number; tokens_in_total: number; tokens_out_total: number }> {
    const rows = (await this.sql`select count(*)::int runs, coalesce(sum(cost_usd),0) cost, coalesce(sum(tokens_in),0) ti,
      coalesce(sum(tokens_out),0) to_ from galeed_extract_receipts where brain = ${this.brain}`) as any[];
    const r = rows[0] ?? {};
    return { runs: Number(r.runs ?? 0), cost_usd_total: Number(r.cost ?? 0), tokens_in_total: Number(r.ti ?? 0), tokens_out_total: Number(r.to_ ?? 0) };
  }

  // ---------- custo de IA por chamada (M20) ----------

  async putLlmUsage(r: LlmUsageRow): Promise<void> {
    await this.sql`insert into galeed_llm_usage
      (brain, op, provider, model, tokens_in, tokens_out, cache_read, cache_write, cost_usd, meta)
      values (${this.brain}, ${r.op}, ${r.provider}, ${r.model},
              ${Math.round(r.tokens_in || 0)}, ${Math.round(r.tokens_out || 0)},
              ${Math.round(r.cache_read || 0)}, ${Math.round(r.cache_write || 0)},
              ${r.cost_usd || 0}, ${this.sql.json(r.meta ?? null)})`;
  }

  async llmUsageRollup(sinceIso?: string): Promise<LlmUsageRollup> {
    const sinceF = sinceIso ? this.sql`and ts >= ${sinceIso}` : this.sql``;
    const totRows = (await this.sql`
      select count(*)::int calls, coalesce(sum(cost_usd),0) cost,
             coalesce(sum(tokens_in),0) ti, coalesce(sum(tokens_out),0) to_
      from galeed_llm_usage where brain = ${this.brain} ${sinceF}`) as any[];
    const opRows = (await this.sql`
      select op, count(*)::int calls, coalesce(sum(cost_usd),0) cost,
             coalesce(sum(tokens_in),0) ti, coalesce(sum(tokens_out),0) to_
      from galeed_llm_usage where brain = ${this.brain} ${sinceF}
      group by op order by sum(cost_usd) desc`) as any[];
    const modelRows = (await this.sql`
      select model, count(*)::int calls, coalesce(sum(cost_usd),0) cost,
             coalesce(sum(tokens_in),0) ti, coalesce(sum(tokens_out),0) to_
      from galeed_llm_usage where brain = ${this.brain} ${sinceF}
      group by model order by sum(cost_usd) desc`) as any[];
    const t = totRows[0] ?? {};
    return {
      calls: Number(t.calls ?? 0),
      cost_usd_total: Number(t.cost ?? 0),
      tokens_in_total: Number(t.ti ?? 0),
      tokens_out_total: Number(t.to_ ?? 0),
      by_op: opRows.map((r) => ({ op: r.op, calls: Number(r.calls), cost_usd: Number(r.cost), tokens_in: Number(r.ti), tokens_out: Number(r.to_) })),
      by_model: modelRows.map((r) => ({ model: r.model, calls: Number(r.calls), cost_usd: Number(r.cost), tokens_in: Number(r.ti), tokens_out: Number(r.to_) })),
    };
  }

  async llmCostSince(sinceIso: string): Promise<number> {
    // Gate barato do kill-switch de quota: UMA agregação no índice (brain, ts desc) já existente.
    const rows = (await this.sql`
      select coalesce(sum(cost_usd),0) cost
      from galeed_llm_usage where brain = ${this.brain} and ts >= ${sinceIso}`) as any[];
    return Number(rows[0]?.cost ?? 0);
  }

  async recentLlmUsage(limit = 50): Promise<LlmUsageRow[]> {
    const rows = (await this.sql`
      select brain, op, provider, model, tokens_in, tokens_out, cache_read, cache_write, cost_usd, meta, ts
      from galeed_llm_usage where brain = ${this.brain} order by ts desc limit ${limit}`) as any[];
    return rows.map((r) => ({
      brain: r.brain, op: r.op, provider: r.provider, model: r.model,
      tokens_in: Number(r.tokens_in ?? 0), tokens_out: Number(r.tokens_out ?? 0),
      cache_read: Number(r.cache_read ?? 0), cache_write: Number(r.cache_write ?? 0),
      cost_usd: Number(r.cost_usd ?? 0), meta: r.meta ?? null,
      ts: r.ts instanceof Date ? r.ts.toISOString() : String(r.ts ?? ""),
    }));
  }

  // ---------- fontes (M21) ----------

  /** Normaliza a `recipe` defensivamente: jsonb pode voltar como string; `fields` não-array → []. */
  private rowToSource(r: any): SourceRow {
    let recipe: any = r.recipe;
    if (typeof recipe === "string") {
      try {
        recipe = JSON.parse(recipe);
      } catch {
        recipe = {};
      }
    }
    if (!recipe || typeof recipe !== "object") recipe = {};
    if (!Array.isArray(recipe.fields)) recipe = { ...recipe, fields: [] };
    return {
      id: r.id,
      name: r.name || "",
      channel: r.channel || "upload",
      type: r.type || "",
      recipe: recipe as SourceRecipe,
      default_sensitivity: r.default_sensitivity || "restrito",
      status: r.status || "ativa",
      last_read_at: r.last_read_at ? (r.last_read_at instanceof Date ? r.last_read_at.toISOString() : String(r.last_read_at)) : null,
      created_at: r.created_at ? (r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at)) : undefined,
    };
  }

  async upsertSource(row: SourceRow): Promise<void> {
    await this.sql`
      insert into galeed_sources (brain, id, name, channel, type, recipe, default_sensitivity, status)
      values (${this.brain}, ${row.id}, ${row.name}, ${row.channel}, ${row.type},
        ${this.sql.json(row.recipe ?? { fields: [] })}, ${row.default_sensitivity}, ${row.status})
      on conflict (brain, id) do update set
        name = excluded.name, channel = excluded.channel, type = excluded.type,
        recipe = excluded.recipe, default_sensitivity = excluded.default_sensitivity,
        status = excluded.status`;
  }

  async getSource(id: string): Promise<SourceRow | undefined> {
    const rows = (await this.sql`
      select id, name, channel, type, recipe, default_sensitivity, status, last_read_at, created_at
      from galeed_sources where brain = ${this.brain} and id = ${id} limit 1`) as any[];
    if (!rows[0]) return undefined;
    return this.rowToSource(rows[0]);
  }

  async listSources(): Promise<SourceRow[]> {
    const rows = (await this.sql`
      select s.*,
        (select count(*) from galeed_pages p
          where p.brain = s.brain and p.tags @> to_jsonb(array['src:' || s.id])) as pages_count,
        (select count(*) from galeed_facts f
          where f.brain = s.brain and f.source_id = s.id) as facts_count
      from galeed_sources s where s.brain = ${this.brain} order by s.created_at desc`) as any[];
    return rows.map((r) => ({
      ...this.rowToSource(r),
      pages_count: Number(r.pages_count ?? 0),
      facts_count: Number(r.facts_count ?? 0),
    }));
  }

  async setSourceStatus(id: string, status: string): Promise<void> {
    await this.sql`update galeed_sources set status = ${status} where brain = ${this.brain} and id = ${id}`;
  }

  async touchSourceRead(id: string): Promise<void> {
    await this.sql`update galeed_sources set last_read_at = now() where brain = ${this.brain} and id = ${id}`;
  }

  // ---------- fila de revisão (M21) ----------

  private rowToReview(r: any): ReviewItemRow {
    let claim: any = r.claim;
    if (typeof claim === "string") {
      try {
        claim = JSON.parse(claim);
      } catch {
        claim = {};
      }
    }
    return {
      id: r.id,
      source_id: r.source_id || "",
      source_slug: r.source_slug,
      dimension: r.dimension || "",
      text: r.text || "",
      quote: r.quote || "",
      claim: claim ?? {},
      reason: r.reason,
      status: r.status,
      decided_by: r.decided_by || "",
      created_at: r.created_at ? (r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at)) : undefined,
      decided_at: r.decided_at ? (r.decided_at instanceof Date ? r.decided_at.toISOString() : String(r.decided_at)) : null,
    };
  }

  async addReviewItems(rows: ReviewItemRow[]): Promise<void> {
    if (!rows.length) return;
    for (let i = 0; i < rows.length; i += 500) {
      const batch = rows.slice(i, i + 500).map((it) => ({
        brain: this.brain,
        id: it.id,
        source_id: it.source_id ?? "",
        source_slug: it.source_slug,
        dimension: it.dimension ?? "",
        text: it.text ?? "",
        quote: it.quote ?? "",
        claim: this.sql.json(it.claim ?? {}),
        reason: it.reason,
        status: it.status ?? "pendente",
        decided_by: it.decided_by ?? "",
      }));
      // idempotência de re-harvest (M16): o mesmo id re-postado não duplica nem sobrescreve decisão.
      await this.sql`insert into galeed_ingest_review ${this.sql(batch, "brain", "id", "source_id", "source_slug", "dimension", "text", "quote", "claim", "reason", "status", "decided_by")}
        on conflict (brain, id) do nothing`;
    }
  }

  async listReview(opts?: { status?: ReviewStatus; limit?: number }): Promise<ReviewItemRow[]> {
    const rows = (await this.sql`
      select id, source_id, source_slug, dimension, text, quote, claim, reason, status, decided_by, created_at, decided_at
      from galeed_ingest_review
      where brain = ${this.brain} and status = ${opts?.status ?? "pendente"}
      order by created_at desc
      limit ${opts?.limit ?? 50}`) as any[];
    return rows.map((r) => this.rowToReview(r));
  }

  async getReviewItem(id: string): Promise<ReviewItemRow | undefined> {
    const rows = (await this.sql`
      select id, source_id, source_slug, dimension, text, quote, claim, reason, status, decided_by, created_at, decided_at
      from galeed_ingest_review where brain = ${this.brain} and id = ${id} limit 1`) as any[];
    if (!rows[0]) return undefined;
    return this.rowToReview(rows[0]);
  }

  async setReviewStatus(id: string, status: "aprovada" | "descartada", decidedBy: string): Promise<void> {
    // decisão é one-shot: só transiciona de 'pendente'; item já decidido → no-op silencioso.
    await this.sql`
      update galeed_ingest_review
      set status = ${status}, decided_by = ${decidedBy}, decided_at = now()
      where brain = ${this.brain} and id = ${id} and status = 'pendente'`;
  }

  async reviewCounts(): Promise<{ pendente: number; aprovada: number; descartada: number }> {
    const rows = (await this.sql`
      select status, count(*)::int c from galeed_ingest_review
      where brain = ${this.brain} group by status`) as any[];
    const out = { pendente: 0, aprovada: 0, descartada: 0 };
    for (const r of rows) if (r.status in out) out[r.status as keyof typeof out] = Number(r.c);
    return out;
  }

  // ---- M24-C: percepções (reflexão v2 — galeed_percepcoes, migração 30) ----
  private rowToPercepcao(r: any): PercepcaoRow {
    return {
      id: r.id,
      classe: r.classe,
      entity: r.entity ?? "",
      predicate: r.predicate ?? "",
      tier: r.tier ?? "",
      texto: r.texto,
      severidade: r.severidade,
      cites: (r.cites ?? []) as PercepcaoCite[],
      numbers: (r.numbers ?? {}) as Record<string, number | string>,
      estado: r.estado as PercepcaoEstado,
      created_at: r.created_at ? new Date(r.created_at).toISOString() : undefined,
      validated_at: r.validated_at ? new Date(r.validated_at).toISOString() : null,
    };
  }

  async upsertPercepcao(row: PercepcaoRow): Promise<void> {
    // upsert por (brain,id): created_at NUNCA muda; validated_at renova só quando estado='viva'.
    await this.sql`
      insert into galeed_percepcoes
        (brain, id, classe, entity, predicate, tier, texto, severidade, cites, numbers, estado, validated_at)
      values (${this.brain}, ${row.id}, ${row.classe}, ${row.entity ?? ""}, ${row.predicate ?? ""},
        ${row.tier ?? ""}, ${row.texto}, ${row.severidade}, ${this.sql.json(row.cites ?? [])},
        ${this.sql.json(row.numbers ?? {})}, ${row.estado}, now())
      on conflict (brain, id) do update set
        classe = excluded.classe, entity = excluded.entity, predicate = excluded.predicate,
        tier = excluded.tier, texto = excluded.texto, severidade = excluded.severidade,
        cites = excluded.cites, numbers = excluded.numbers, estado = excluded.estado,
        validated_at = case when excluded.estado = 'viva' then now() else galeed_percepcoes.validated_at end`;
  }

  async getPercepcao(id: string): Promise<PercepcaoRow | undefined> {
    const rows = (await this.sql`
      select id, classe, entity, predicate, tier, texto, severidade, cites, numbers, estado, created_at, validated_at
      from galeed_percepcoes where brain = ${this.brain} and id = ${id}`) as any[];
    return rows[0] ? this.rowToPercepcao(rows[0]) : undefined;
  }

  async listPercepcoes(opts?: { estado?: PercepcaoEstado; limit?: number; offset?: number }): Promise<PercepcaoRow[]> {
    const limit = opts?.limit ?? 100;
    const offset = opts?.offset ?? 0;
    const filtro = opts?.estado ? this.sql`and estado = ${opts.estado}` : this.sql``;
    // ordenação TOTAL (created_at desc, id asc) — paginação do M24-E não repete/pula item.
    const rows = (await this.sql`
      select id, classe, entity, predicate, tier, texto, severidade, cites, numbers, estado, created_at, validated_at
      from galeed_percepcoes
      where brain = ${this.brain} ${filtro}
      order by created_at desc, id asc
      limit ${limit} offset ${offset}`) as any[];
    return rows.map((r) => this.rowToPercepcao(r));
  }

  async setPercepcaoEstado(id: string, estado: PercepcaoEstado): Promise<void> {
    await this.sql`
      update galeed_percepcoes
      set estado = ${estado}, validated_at = case when ${estado} = 'viva' then now() else validated_at end
      where brain = ${this.brain} and id = ${id}`;
  }

  async percepcaoCounts(): Promise<{ viva: number; stale: number; arquivada: number }> {
    const rows = (await this.sql`
      select estado, count(*)::int c from galeed_percepcoes
      where brain = ${this.brain} group by estado`) as any[];
    const out = { viva: 0, stale: 0, arquivada: 0 };
    for (const r of rows) if (r.estado in out) out[r.estado as keyof typeof out] = Number(r.c);
    return out;
  }

  // ---- C1: webhooks (galeed_webhooks + galeed_webhook_deliveries, migração 34) ----

  private rowToWebhook(r: any, withSecret: boolean): WebhookRow {
    return {
      id: r.id,
      url: r.url,
      events: (r.events ?? []) as WebhookEvent[],
      secret: withSecret ? (r.secret ?? "") : "",
      label: r.label ?? "",
      status: (r.status ?? "active") as WebhookStatus,
      created_by: r.created_by ?? "",
      created_at: r.created_at ? (r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at)) : undefined,
      last_delivery_at: r.last_delivery_at ? (r.last_delivery_at instanceof Date ? r.last_delivery_at.toISOString() : String(r.last_delivery_at)) : null,
      last_error: r.last_error ?? "",
      failure_count: Number(r.failure_count ?? 0),
    };
  }

  async putWebhook(row: WebhookRow): Promise<void> {
    // INSERT PURO (on conflict do nothing) — NÃO é upsert. O REGISTRO (borda /v1/webhooks) gera o id
    // com randomUUID() a cada criação, então colisão de (brain,id) é praticamente impossível; um
    // do-update set url/secret seria uma arma carregada: um caller futuro que controlasse o id poderia
    // SEQUESTRAR o secret/url de um webhook existente do MESMO brain (sobrescrita silenciosa). Com "do
    // nothing", uma colisão deixa o registro intacto e a borda detecta o no-op pela unique(brain,url).
    // Mudança de status/contadores é feita por setWebhookStatus (update explícito), nunca por aqui.
    await this.sql`
      insert into galeed_webhooks
        (brain, id, url, events, secret, label, status, created_by)
      values (${this.brain}, ${row.id}, ${row.url}, ${row.events ?? []}, ${row.secret},
        ${row.label ?? ""}, ${row.status ?? "active"}, ${row.created_by ?? ""})
      on conflict (brain, id) do nothing`;
  }

  async listWebhooks(opts?: { event?: WebhookEvent; status?: WebhookStatus }): Promise<WebhookRow[]> {
    const eventF = opts?.event ? this.sql`and ${opts.event} = any(events)` : this.sql``;
    const statusF = opts?.status ? this.sql`and status = ${opts.status}` : this.sql``;
    const rows = (await this.sql`
      select id, url, events, label, status, created_by, created_at, last_delivery_at, last_error, failure_count
      from galeed_webhooks
      where brain = ${this.brain} ${eventF} ${statusF}
      order by created_at desc, id asc`) as any[];
    // listagem NUNCA devolve o secret (não selecionado acima; withSecret=false zera por garantia).
    return rows.map((r) => this.rowToWebhook(r, false));
  }

  async getWebhook(id: string): Promise<WebhookRow | undefined> {
    const rows = (await this.sql`
      select id, url, events, secret, label, status, created_by, created_at, last_delivery_at, last_error, failure_count
      from galeed_webhooks where brain = ${this.brain} and id = ${id} limit 1`) as any[];
    if (!rows[0]) return undefined;
    return this.rowToWebhook(rows[0], true); // COM secret — é a leitura do worker p/ assinar.
  }

  async deleteWebhook(id: string): Promise<void> {
    await this.sql`delete from galeed_webhooks where brain = ${this.brain} and id = ${id}`;
  }

  async setWebhookStatus(
    id: string,
    status: WebhookStatus,
    opts?: { failure_count?: number; last_error?: string },
  ): Promise<void> {
    // só os campos presentes mudam; coalesce mantém o valor atual quando o patch omite.
    await this.sql`
      update galeed_webhooks
      set status = ${status},
          failure_count = coalesce(${opts?.failure_count ?? null}, failure_count),
          last_error = coalesce(${opts?.last_error ?? null}, last_error)
      where brain = ${this.brain} and id = ${id}`;
  }

  private rowToDelivery(r: any): WebhookDeliveryRow {
    let payload: any = r.payload;
    if (typeof payload === "string") {
      try {
        payload = JSON.parse(payload);
      } catch {
        payload = {};
      }
    }
    return {
      id: r.id,
      webhook_id: r.webhook_id,
      event: r.event as WebhookEvent,
      payload: payload ?? {},
      status: (r.status ?? "queued") as WebhookDeliveryRow["status"],
      attempt: Number(r.attempt ?? 0),
      next_attempt_at: r.next_attempt_at ? (r.next_attempt_at instanceof Date ? r.next_attempt_at.toISOString() : String(r.next_attempt_at)) : undefined,
      response_status: r.response_status == null ? null : Number(r.response_status),
      error_message: r.error_message ?? "",
      created_at: r.created_at ? (r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at)) : undefined,
      delivered_at: r.delivered_at ? (r.delivered_at instanceof Date ? r.delivered_at.toISOString() : String(r.delivered_at)) : null,
    };
  }

  async enqueueWebhookDelivery(delivery: WebhookDeliveryInput): Promise<string> {
    const id = delivery.id ?? randomUUID();
    await this.sql`
      insert into galeed_webhook_deliveries
        (brain, id, webhook_id, event, payload, status, next_attempt_at)
      values (${this.brain}, ${id}, ${delivery.webhook_id}, ${delivery.event},
        ${this.sql.json(delivery.payload ?? {})}, 'queued',
        ${delivery.nextAttemptAt ?? this.sql`now()`})
      on conflict (brain, id) do nothing`;
    return id;
  }

  async claimNextWebhookDelivery(leaseMs = 60_000): Promise<WebhookDeliveryRow | null> {
    // claim ATÔMICO: a próxima 'queued' com next_attempt_at<=now(), mais antiga primeiro. Marca
    // 'delivering', attempt+1 e empurra next_attempt_at por um lease (re-claim só após o lease vencer
    // se o worker morrer). for update skip locked → dois workers nunca pegam a mesma entrega.
    const rows = (await this.sql.unsafe(
      `update galeed_webhook_deliveries
          set status = 'delivering',
              attempt = attempt + 1,
              next_attempt_at = now() + make_interval(secs => $2)
        where (brain, id) = (
          select brain, id from galeed_webhook_deliveries
           where brain = $1 and status = 'queued' and next_attempt_at <= now()
           order by next_attempt_at, created_at
           limit 1
           for update skip locked
        )
        returning *`,
      [this.brain, leaseMs / 1000],
    )) as any[];
    if (!rows.length) return null;
    return this.rowToDelivery(rows[0]);
  }

  async markWebhookDelivery(id: string, patch: WebhookDeliveryPatch): Promise<void> {
    const terminal = patch.status === "done" || patch.status === "dead";
    await this.sql`
      update galeed_webhook_deliveries
      set status = ${patch.status},
          response_status = coalesce(${patch.response_status ?? null}, response_status),
          error_message = coalesce(${patch.error ?? null}, error_message),
          attempt = coalesce(${patch.attempt ?? null}, attempt),
          next_attempt_at = coalesce(${patch.next_attempt_at ?? null}, next_attempt_at),
          delivered_at = ${terminal ? this.sql`now()` : this.sql`null`}
      where brain = ${this.brain} and id = ${id}`;
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }
}
