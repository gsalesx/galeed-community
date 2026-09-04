/** R14 (parcial) — migração de schema versionada e idempotente. NÃO substitui o DDL base do
 *  `ensureSchema` (esse fica como baseline); toda mudança de schema NOVA entra aqui, append-only. */

export interface Migration {
  id: number; // sequencial, único, IMUTÁVEL (nunca reordene/reedite uma já lançada)
  name: string; // descrição curta (ex.: "tier em galeed_pages")
  sql: string; // DDL idempotente; pode usar "add column if not exists" / "create ... if not exists"
}

/** Lista ORDENADA de migrações. Append-only. */
export const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: "tier em galeed_pages",
    sql: "alter table galeed_pages add column if not exists tier text default 'hot'",
  },
  {
    id: 2,
    name: "galeed_principals — humano|agente (R16)",
    sql: `create table if not exists galeed_principals (
      brain text, id text, kind text, label text, email text,
      status text default 'active', created_at timestamptz default now(),
      primary key (brain, id))`,
  },
  {
    id: 3,
    name: "galeed_grants — escopo de acesso por principal (R16)",
    sql: `create table if not exists galeed_grants (
      brain text, principal_id text, areas jsonb default '[]'::jsonb,
      sensitivity_max text default 'publico', deny_types jsonb default '[]'::jsonb,
      scope text default 'read',
      primary key (brain, principal_id))`,
  },
  {
    id: 4,
    name: "galeed_tokens — token escopado de agente (R16)",
    sql: `create table if not exists galeed_tokens (
      brain text, principal_id text, token_hash text, label text,
      last_used_at timestamptz, revoked boolean default false,
      created_at timestamptz default now(),
      primary key (brain, token_hash))`,
  },
  {
    id: 5,
    name: "galeed_access_log — trilha de auditoria (lado leitura, R12 fundação)",
    sql: `create table if not exists galeed_access_log (
      brain text, principal_id text, ts timestamptz default now(),
      query text, areas_touched jsonb default '[]'::jsonb, n_returned int default 0)`,
  },
  {
    id: 6,
    name: "sensitivity em galeed_pages — falha-fechado (D2)",
    sql: "alter table galeed_pages add column if not exists sensitivity text default 'restrito'",
  },
  {
    id: 7,
    name: "índices de acesso",
    sql: `create index if not exists galeed_tokens_hash on galeed_tokens(brain, token_hash);
          create index if not exists galeed_access_log_pid on galeed_access_log(brain, principal_id, ts);
          create index if not exists galeed_pages_sensitivity on galeed_pages(brain, sensitivity)`,
  },
  {
    id: 8,
    name: "funções RLS de escopo (área + sensibilidade)",
    sql: `
      -- rank de sensibilidade: publico=0..restrito=3; desconhecido/null = 3 (fail-closed)
      create or replace function galeed_sensitivity_rank(level text) returns int language sql immutable as $$
        select case lower(coalesce(level,''))
          when 'publico' then 0 when 'interno' then 1 when 'sensivel' then 2 when 'restrito' then 3
          else 3 end $$;
      -- item passa se rank(item) <= rank(max)
      create or replace function galeed_sensitivity_ok(item text, max text) returns boolean language sql immutable as $$
        select galeed_sensitivity_rank(item) <= galeed_sensitivity_rank(max) $$;
      -- area_scope é csv de slugs ("produto,suporte"); item passa se QUALQUER tag area:<slug> dele ∈ scope.
      -- scope vazio ('') = nenhuma área permitida (fail-closed).
      create or replace function galeed_in_area_scope(tags jsonb, scope text) returns boolean language sql immutable as $$
        select exists (
          select 1 from jsonb_array_elements_text(coalesce(tags,'[]'::jsonb)) t(tag)
          where left(t.tag, 5) = 'area:'
            and substring(t.tag from 6) = any (string_to_array(coalesce(scope,''), ','))
        ) $$;
    `,
  },
  // --- M8/S2: contas + sessão + membership (camada de auth do front, ACIMA dos principals do M7).
  // Tabelas BRAIN-INDEPENDENTES (login é cross-brain) — sem coluna `brain`. Append-only; IDs 20+. ---
  {
    id: 20,
    name: "galeed_accounts (conta cross-brain)",
    sql: `create table if not exists galeed_accounts (
      id text primary key,
      name text,
      email text unique,
      pass_hash text,
      created_at timestamptz default now()
    )`,
  },
  {
    id: 21,
    name: "galeed_sessions (cookie httpOnly → conta)",
    sql: `create table if not exists galeed_sessions (
      token_hash text primary key,
      account_id text,
      created_at timestamptz default now(),
      expires_at timestamptz
    )`,
  },
  {
    id: 22,
    name: "galeed_account_brains (membership conta↔brain)",
    sql: `create table if not exists galeed_account_brains (
      account_id text,
      brain text,
      role text default 'owner',
      primary key (account_id, brain)
    )`,
  },
  // --- M9/S1: claim TIPADO de 1ª classe (value_num/unit/period/tier). ADITIVO, sem backfill.
  // `value text` PRESERVADO (retrocompat — fatos legados respondem por string). ---
  {
    id: 9,
    name: "value_num/unit/period em galeed_facts — claim tipado (M9)",
    sql: `alter table galeed_facts add column if not exists value_num numeric;
          alter table galeed_facts add column if not exists unit text;
          alter table galeed_facts add column if not exists period text`,
  },
  {
    id: 10,
    name: "tier opcional em galeed_facts — série por tier (M9, D4)",
    sql: `alter table galeed_facts add column if not exists tier text`,
  },
  {
    id: 11,
    name: "índice de série por (entity, predicate, tier) (M9)",
    sql: `create index if not exists galeed_facts_entity_pred_tier
            on galeed_facts(brain, entity, predicate, tier)`,
  },
  // --- M9: tabela de receipts de extração (custo observável por brain). O S5 ESCREVE/LÊ via os
  // métodos de Engine declarados em engine.ts/postgres.ts (§2.5). A tabela e os métodos vivem AQUI
  // porque engine.ts/postgres.ts/migrations.ts têm dono ÚNICO = S1 (zoning). ---
  {
    id: 12,
    name: "galeed_extract_receipts — custo de extração por run (M9, observável)",
    sql: `create table if not exists galeed_extract_receipts (
      brain text, run_id text, fixture_corpus text, model text, prompt_version text,
      schema_version text, corpus_sha8 text,
      tokens_in bigint default 0, tokens_out bigint default 0, cost_usd numeric default 0,
      recall real, per_dim jsonb default '{}'::jsonb,
      created_at timestamptz default now(),
      primary key (brain, run_id))`,
  },
  // --- M11/S1: contexto da ingestão por brain (self/propósito/papéis/tipos), versionado. Guarda a
  // versão editada pelo front (S4/S6) + o espelho do contexto quando vem do banco (não de env).
  // Tenant-neutro: linha ausente = brain sem contexto. `brain` é a granularidade (1 contexto/brain). ---
  {
    id: 13,
    name: "galeed_brain_context — contexto da ingestão por brain (M11), versionado",
    sql: `create table if not exists galeed_brain_context (
      brain text primary key,
      context_version int default 0,
      context_json jsonb default '{}'::jsonb,
      updated_at timestamptz default now()
    )`,
  },
  // --- M11/S3: ponteiro p/ o ORIGINAL VERBATIM em object storage (ADR-005). O binário VIVE no
  // BlobStore (fs no dev / supabase no prod); aqui só o ponteiro + proveniência. Chave = (brain,
  // content_hash) → 1 linha por documento, idempotente (on conflict do nothing na ingestão). ---
  {
    id: 14,
    name: "galeed_blobs — ponteiro p/ original verbatim em object storage (M11)",
    sql: `create table if not exists galeed_blobs (
      brain text, content_hash text, key text, mime text, filename text, source text,
      ingested_at timestamptz default now(),
      primary key (brain, content_hash)
    )`,
  },
  // --- M12/S1: fila de jobs de ingestão assíncrona. upload → job (queued) → worker (processing) →
  // done|error. payload = o que ingerir (blob por content_hash OU texto colado); result = resumo legível.
  // Tenant-neutro: `brain` é a granularidade de escopo. Status-machine: queued→processing→done|error. ---
  {
    id: 15,
    name: "galeed_ingest_jobs — fila de ingestão assíncrona (M12)",
    sql: `create table if not exists galeed_ingest_jobs (
      id text primary key,
      brain text not null,
      kind text not null,              -- 'file' | 'text'
      status text not null default 'queued',  -- queued|processing|done|error
      type text,                       -- tipo DECLARADO pelo usuário (D4 do M11)
      content_hash text,               -- file: hash do blob (FK lógica p/ galeed_blobs); text: hash do texto
      filename text,
      mime text,
      title text,
      job_date text,                   -- data declarada (YYYY-MM-DD), opcional
      text_body text,                  -- kind='text': o texto colado (kind='file' é null — o conteúdo vive no blob)
      progress real not null default 0,        -- 0..1
      message text,                    -- mensagem legível do estado atual / progresso
      result_json jsonb default '{}'::jsonb,   -- resumo do done (slugs, total, skipped)
      error_message text,
      created_at timestamptz default now(),
      started_at timestamptz,
      finished_at timestamptz
    );
    create index if not exists galeed_ingest_jobs_queue on galeed_ingest_jobs(status, created_at);
    create index if not exists galeed_ingest_jobs_brain on galeed_ingest_jobs(brain, created_at desc)`,
  },
  // --- M13/S1: config de EXTRAÇÃO por brain (synonymClasses/roleTokens/extractable) no banco. Fecha a
  // migração da config pro DB (invariante #1): o M11 moveu o CONTEXTO (galeed_brain_context); aqui vai a
  // config de extração. Precedência de leitura = banco > pack-env > vazio (espelha o contexto). O pack
  // de env vira fallback de dev/seed. Tenant-neutro: linha ausente = pack vazio (core neutro). ADR-007. ---
  {
    id: 16,
    name: "galeed_schema_packs — config de extração por brain (M13), versionada",
    sql: `create table if not exists galeed_schema_packs (
      brain text primary key,
      pack_version int default 0,
      pack_json jsonb default '{}'::jsonb,
      updated_at timestamptz default now()
    )`,
  },
  // --- M14/S1: índice de DELETE dirigido por fonte. O write-path incremental (deriveIncremental) deleta
  // fatos por `source_slug in (...)` (re-ingestão idempotente) — sem este índice vira seq-scan e mata o
  // ganho O(1). Os índices (brain,entity,predicate,tier) [id 11] e galeed_edges(brain,src) [ensureSchema]
  // JÁ existem e cobrem o resto do acesso dirigido. ADR-008. ---
  {
    id: 17,
    name: "índice galeed_facts(brain, source_slug) — DELETE dirigido por fonte (M14)",
    sql: `create index if not exists galeed_facts_source on galeed_facts(brain, source_slug)`,
  },
  // --- M15/S2: a fila ganha as DUAS FASES (findable/digesting/digested) além de processing/done. O `status`
  // é TEXTO LIVRE (sem CHECK — migração 15) → ampliar o domínio NÃO exige ALTER de coluna; jobs antigos
  // (processing/done) seguem válidos (retrocompat, EMPRESA.md #9). O índice de fila por status já existe
  // (galeed_ingest_jobs_queue, id 15). Esta migração é um NO-OP estrutural que documenta a ampliação e
  // garante um índice (brain, status) p/ o front filtrar por fase sem seq-scan. Idempotente. ADR-009. ---
  {
    id: 18,
    name: "galeed_ingest_jobs — fases findable/digesting/digested (M15, status texto-livre, retrocompat)",
    sql: `create index if not exists galeed_ingest_jobs_status on galeed_ingest_jobs(brain, status)`,
  },
  // --- M16/S2: estado de lote (Batch API) no job, p/ RESUMIBILIDADE (LEI I, ADR-010). ADITIVO — jobs
  // M12–M15 (batch_id null) seguem síncronos/válidos. ADD COLUMN IF NOT EXISTS + índice parcial de poll. ---
  {
    id: 19,
    name: "galeed_ingest_jobs — estado de lote batch_id/batch_status/batch_custom_map (M16)",
    sql: `alter table galeed_ingest_jobs add column if not exists batch_id text;
          alter table galeed_ingest_jobs add column if not exists batch_status text;
          alter table galeed_ingest_jobs add column if not exists batch_custom_map jsonb;
          create index if not exists galeed_ingest_jobs_batch
            on galeed_ingest_jobs(batch_id) where batch_id is not null`,
  },
  // --- M20: observabilidade de CUSTO de IA. 1 linha por chamada de IA (extração, síntese do ask,
  // embeddings, rerank), com a usage REAL do provider + custo em USD. Fonte do /api/cost (rollup por
  // brain/op/modelo). Multi-tenant por `brain`. `op` = extract | extract:batch | synthesis | ask:stream |
  // embed | embed:query | rerank | hyde. Aditivo, tenant-neutro.
  // ATENÇÃO: ids 20/21/22 já são as migrações de CONTAS do M8 (galeed_accounts/sessions/account_brains,
  // registradas por accounts.ts no MESMO galeed_migrations). Por isso esta é a 23, não a 20. ---
  {
    id: 23,
    name: "galeed_llm_usage — custo de IA por chamada (M20, observável end-to-end)",
    sql: `create table if not exists galeed_llm_usage (
            id bigserial primary key,
            brain text not null,
            ts timestamptz not null default now(),
            op text not null,
            provider text not null,
            model text not null,
            tokens_in integer not null default 0,
            tokens_out integer not null default 0,
            cache_read integer not null default 0,
            cache_write integer not null default 0,
            cost_usd double precision not null default 0,
            meta jsonb
          );
          create index if not exists galeed_llm_usage_brain_ts on galeed_llm_usage(brain, ts desc);
          create index if not exists galeed_llm_usage_brain_op on galeed_llm_usage(brain, op)`,
  },
  // --- M21/S1: FONTES como conceito de 1ª classe + FILA DE REVISÃO (regra de ouro). A receita é DADO
  // (jsonb) — zero ramo de formato no core (invariante III). `galeed_facts.source_id` é o carimbo da
  // fonte no fato (ADITIVO: '' = fato sem fonte, retrocompat M1–M20). `galeed_ingest_jobs.source_id`
  // liga o job à fonte (null = caminho sem fonte, byte-idêntico a hoje). Fila de revisão é tabela
  // PRÓPRIA (NÃO galeed_hypotheses — replaceHypotheses faz DELETE ALL no write-path do dream). ADR-016. ---
  {
    id: 24,
    name: "galeed_sources + galeed_ingest_review + carimbo source_id (M21, ingestão com contrato)",
    sql: `create table if not exists galeed_sources (
            brain text not null,
            id text not null,
            name text not null,
            channel text not null default 'upload',
            type text not null default '',
            recipe jsonb not null default '{"fields":[]}'::jsonb,
            default_sensitivity text not null default 'restrito',
            status text not null default 'ativa',
            last_read_at timestamptz,
            created_at timestamptz default now(),
            primary key (brain, id)
          );
          create table if not exists galeed_ingest_review (
            brain text not null,
            id text not null,
            source_id text not null default '',
            source_slug text not null,
            dimension text not null default '',
            text text not null default '',
            quote text not null default '',
            claim jsonb not null default '{}'::jsonb,
            reason text not null,
            status text not null default 'pendente',
            decided_by text not null default '',
            created_at timestamptz default now(),
            decided_at timestamptz,
            primary key (brain, id)
          );
          create index if not exists galeed_ingest_review_status
            on galeed_ingest_review(brain, status, created_at desc);
          alter table galeed_facts add column if not exists source_id text not null default '';
          create index if not exists galeed_facts_source_id on galeed_facts(brain, source_id);
          alter table galeed_ingest_jobs add column if not exists source_id text`,
  },
  // --- P0-C: a fila SOBREVIVE a crash (auditoria 2026-06-11, C3). lease_until = validade do claim
  // (processing/findable/digesting) OU "inelegível até" (queued em backoff). attempts = nº de claims.
  // Reaper re-enfileira lease expirado; attempts ≥ N → 'dead' (status é texto livre — migração 15 —
  // ampliar o domínio é retrocompatível). Índice parcial p/ o reaper não fazer seq-scan. ---
  {
    id: 25,
    name: "galeed_ingest_jobs — lease_until + attempts (P0-C, fila sobrevive a crash)",
    sql: `alter table galeed_ingest_jobs add column if not exists lease_until timestamptz;
          alter table galeed_ingest_jobs add column if not exists attempts integer not null default 0;
          create index if not exists galeed_ingest_jobs_lease
            on galeed_ingest_jobs(lease_until) where lease_until is not null`,
  },
  // --- P1-A: índice PARCIAL de fatos vigentes (auditoria 2026-06-11, M5b). Serve EXATAMENTE o
  // WHERE do currentFacts (brain + entity<>'' + status='fato' + valid_to vazio) — que é chamado
  // 2×+ por pergunta e hoje é full scan. Predicado parcial = (valid_to vazio AND status='fato');
  // entity<>'' fica como filtro residual (barato sobre o subconjunto). Idempotente.
  // Numeração FINAL (adjudicada pelo árbitro) — não renumerar no slot: 26=P1-A, 27=P1-C, 28=P1-D. ---
  {
    id: 26,
    name: "índice parcial de fatos vigentes em galeed_facts (P1-A, currentFacts dirigido)",
    sql: `create index if not exists galeed_facts_vigentes
            on galeed_facts(brain, entity, predicate, tier)
            where (valid_to is null or valid_to = '') and status = 'fato'`,
  },
  // P1-C — numeração FINAL (NOTA DO ÁRBITRO): a entrada do trigger keep_approved é o id 27
  // (renumerada de 28; 26 = P1-A índice parcial vigentes, 28 = P1-D UNIQUE external_id). NÃO
  // renumerar no slot. Decisão humana é DURÁVEL: sobrevive a putExtraction/re-extração. ---
  {
    id: 27,
    name: "galeed_extractions — trigger keep_approved (P1-C: decisão humana sobrevive a putExtraction/re-extração)",
    sql: `create or replace function galeed_keep_approved_claims() returns trigger
          language plpgsql as $fn$
          declare
            d text;
            approved jsonb;
            cur jsonb;
          begin
            -- P1-C (mata A8b): decisão humana é DURÁVEL. Em qualquer UPDATE de galeed_extractions
            -- (putExtraction substitui a linha inteira), os claims com review='aprovada' da linha
            -- ANTIGA ausentes da NOVA são re-anexados à dimensão de origem. Dedupe por review_id
            -- (fallback: igualdade do objeto). 'review'/'review_id' são marcadores do sistema.
            if old.extractions is null then return new; end if;
            for d in select jsonb_object_keys(old.extractions) loop
              if jsonb_typeof(old.extractions->d) <> 'array' then continue; end if;
              select coalesce(jsonb_agg(e.claim), '[]'::jsonb) into approved
                from jsonb_array_elements(old.extractions->d) as e(claim)
                where e.claim->>'review' = 'aprovada';
              if jsonb_array_length(approved) = 0 then continue; end if;
              cur := coalesce(new.extractions->d, '[]'::jsonb);
              if jsonb_typeof(cur) <> 'array' then cur := '[]'::jsonb; end if;
              select cur || coalesce(jsonb_agg(a.claim), '[]'::jsonb) into cur
                from jsonb_array_elements(approved) as a(claim)
                where not exists (
                  select 1 from jsonb_array_elements(cur) as c(claim)
                  where (a.claim ? 'review_id' and c.claim->>'review_id' = a.claim->>'review_id')
                     or c.claim = a.claim
                );
              new.extractions := jsonb_set(coalesce(new.extractions, '{}'::jsonb), array[d], cur);
            end loop;
            return new;
          end
          $fn$;
          drop trigger if exists galeed_extractions_keep_approved on galeed_extractions;
          create trigger galeed_extractions_keep_approved
            before update on galeed_extractions
            for each row execute function galeed_keep_approved_claims()`,
  },
  // --- P1-D: re-ingestão IDEMPOTENTE de verdade (auditoria 2026-06-11, A6/A10/M9b).
  // numeração FINAL — não renumerar no slot (árbitro: 26=P1-A, 27=P1-C, 28=P1-D).
  // (1) TRANSIÇÃO: external_id velho do pipeline (`hash16-do-ARQUIVO#parte`) vira o formato novo
  //     por FATIA (`sl:` + content_hash) — content_hash JÁ É sha256(texto-da-fatia).slice(0,16)
  //     (capture.ts grava os dois da MESMA string; provado no banco real, DESIGN-SPEC P1-D §1.2).
  //     Regex ESTRITA: não toca external_id de webhook (id declarado pelo cliente).
  // (2) DEDUPE defensivo pré-UNIQUE: (brain, external_id) repetido mantém a página "mais digerida"
  //     (extract_version != '' primeiro; desempate por created_at, depois slug) e ESVAZIA o
  //     external_id das demais — a migração NUNCA apaga página. (Banco real: 0 casos — §1.1.)
  // (3) UNIQUE parcial com o MESMO NOME do índice do baseline (postgres-schema.ts:143 vira no-op):
  //     o TOCTOU check-then-insert do capture morre NO BANCO. ---
  {
    id: 28,
    name: "galeed_pages — external_id por fatia + UNIQUE (brain, external_id) (P1-D, re-ingestão idempotente)",
    // DESVIO ANOTADO (P1-D): o `drop index` vem PRIMEIRO (não por último como na spec §2). Sem isso
    // o corpo NÃO é re-executável (a spec exige idempotência em §2/§7.2-5/§7.5): o 1º UPDATE pode
    // criar 2 linhas com o MESMO `sl:<hash>` ANTES do dedupe; com o UNIQUE já vivo (re-run/2º boot)
    // o UPDATE estoura 23505. Dropando o índice antes, a coexistência temporária é livre e o dedupe
    // arbitra; o índice é recriado UNIQUE no fim. Em DB virgem converge igual (baseline não-unique →
    // drop → rename → dedupe → create unique).
    sql: `drop index if exists galeed_pages_extid;
          update galeed_pages
             set external_id = 'sl:' || content_hash
           where external_id ~ '^[0-9a-f]{16}#[0-9]+$'
             and coalesce(content_hash, '') <> '';
          with ranked as (
            select brain, slug, row_number() over (
              partition by brain, external_id
              order by (coalesce(extract_version, '') <> '') desc, created_at asc nulls last, slug asc
            ) as rn
            from galeed_pages
            where coalesce(external_id, '') <> ''
          )
          update galeed_pages p
             set external_id = ''
            from ranked r
           where r.rn > 1 and p.brain = r.brain and p.slug = r.slug;
          create unique index if not exists galeed_pages_extid
            on galeed_pages(brain, external_id)
            where external_id is not null and external_id <> ''`,
  },
  // --- M22-A: estado de conexão por fonte (conectores via Nango). Tokens OAuth NUNCA aqui
  // (LEI IV — ficam no Nango): só connection_id + provider_config_key + connector_state
  // (cursor/last_sync_at/last_error em jsonb). Dono único das colunas = connector-ingest.ts
  // (engine.ts intocado — zoning). Índice parcial p/ o lookup do webhook. ---
  {
    id: 29,
    name: "galeed_sources — connection_id + provider_config_key + connector_state (M22-A, conectores Nango)",
    sql: `alter table galeed_sources add column if not exists connection_id text not null default '';
          alter table galeed_sources add column if not exists provider_config_key text not null default '';
          alter table galeed_sources add column if not exists connector_state jsonb not null default '{}'::jsonb;
          create index if not exists galeed_sources_connection
            on galeed_sources(connection_id, provider_config_key) where connection_id <> ''`,
  },
  // --- M24-C: PERCEPÇÕES da reflexão v2 (BRIEF M24 §3) — registro de 1ª classe com proveniência.
  // id = hash determinístico do sinal (re-sono não duplica; upsert por (brain,id)). cites = jsonb
  // com as referências ESTÁVEIS de fato (a identidade é a chave
  // entity/predicate/tier/source_slug/valid_from — FactRef do M24-A). numbers = os números do
  // detector (o selo imprime o porquê). estado: viva|stale|arquivada (LEI II — invalidação por
  // proveniência; nunca DELETE). NÃO mexe em galeed_reflections (legada). ---
  {
    id: 30,
    name: "galeed_percepcoes — reflexão v2 com proveniência e ciclo de vida (M24-C)",
    sql: `create table if not exists galeed_percepcoes (
            brain text not null,
            id text not null,
            classe text not null,
            entity text not null default '',
            predicate text not null default '',
            tier text not null default '',
            texto text not null,
            severidade text not null default 'info',
            cites jsonb not null default '[]'::jsonb,
            numbers jsonb not null default '{}'::jsonb,
            estado text not null default 'viva',
            created_at timestamptz default now(),
            validated_at timestamptz,
            primary key (brain, id)
          );
          create index if not exists galeed_percepcoes_estado
            on galeed_percepcoes(brain, estado, created_at desc)`,
  },
  // --- M24-D: estado do sono por brain (gatilho por acúmulo + teto 1×/24h + rastro). Tabela
  // PRÓPRIA do sono-step.ts (padrão ADR-013, como galeed_brain_context): context_json do M11 é
  // sobrescrito inteiro pelo front e galeed_percepcoes (30, M24-C) é domínio do M24-C — nenhum
  // lugar natural existente. baseline = contagens {pages,facts} no fim da última tentativa.
  // O runner aplica por id (gaps são ok). ---
  {
    id: 31,
    name: "galeed_sono_state — estado do sono por brain (M24-D, gatilho+teto+rastro)",
    sql: `create table if not exists galeed_sono_state (
            brain text primary key,
            last_sleep_at timestamptz,
            baseline jsonb not null default '{}'::jsonb,
            last_trace jsonb not null default '{}'::jsonb,
            updated_at timestamptz default now()
          )`,
  },
  // --- M25-B: juiz triador. (1) pg_trgm pro desempate textual da memória de decisões (disponível
  // no pgvector image e no Supabase; precedente: extension vector no postgres-schema.ts:29).
  // (2) Colunas judge_* em galeed_ingest_review — recomendação 1:1 com o item, ADITIVA (itens
  // M21..M24 seguem com judged_at null); dono ÚNICO das colunas = review-judge.ts via pool
  // compartilhada (precedente M22-A: colunas de conector em galeed_sources, engine.ts intocado).
  // O par de calibração (judge_recommendation congelada × status/decided_at do M21) vive NA LINHA —
  // calibração é GROUP BY, sem tabela de pares. O juiz NUNCA escreve em status (invariante #5).
  // (3) galeed_judge_batches — estado DURÁVEL do lote (crash entre submit e harvest não perde o
  // lote, lição P0-C); custom_id do lote = o próprio id do item (hex32, casa a regex da Batch API). ---
  {
    id: 32,
    name: "juiz triador — judge_* em galeed_ingest_review + pg_trgm + galeed_judge_batches (M25-B)",
    sql: `create extension if not exists pg_trgm;
          alter table galeed_ingest_review add column if not exists judge_recommendation text not null default '';
          alter table galeed_ingest_review add column if not exists judge_reason text not null default '';
          alter table galeed_ingest_review add column if not exists judge_confidence real;
          alter table galeed_ingest_review add column if not exists judge_model text not null default '';
          alter table galeed_ingest_review add column if not exists judge_memory_n integer not null default 0;
          alter table galeed_ingest_review add column if not exists judged_at timestamptz;
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
            on galeed_judge_batches(brain, status) where status = 'submetido'`,
  },
  // --- can_ingest: capacidade de ESCRITA no grant (gateway /v1/ingest gateia por scope.canIngest).
  // ADITIVO + FAIL-CLOSED: default false → todo token nasce SÓ-LEITURA; escrita só por grant explícito.
  // Grants M7..M25 (sem a coluna) lêem false na getGrant → comportamento byte-idêntico (token só lê).
  // A doc pública (autenticacao.astro/ingestao.astro) já promete can_ingest:boolean na chave. ---
  {
    id: 33,
    name: "galeed_grants — can_ingest (capacidade de escrita, fail-closed default false)",
    sql: `alter table galeed_grants add column if not exists can_ingest boolean default false`,
  },
  // --- C1: infra de WEBHOOKS por brain (registro + fila de entrega async, fail-soft). Registro SELF-SERVE
  // no gateway (/v1/webhooks, Bearer gld_, gateado por scope.canIngest). Eventos v1 = ingest.organized,
  // review.pending, fact.superseded, access.denied. Entrega por worker isolado (claim com lease, espelha
  // a fila de ingestão P0-C). `secret` é o segredo CRU usado pelo worker p/ ASSINAR a saída (HMAC sha256,
  // idioma de nango.ts) — guardado aqui, mostrado UMA vez ao criar, listagem NUNCA o devolve. ---
  {
    id: 34,
    name: "galeed_webhooks + galeed_webhook_deliveries — registro + fila de entrega (C1, webhooks por brain)",
    sql: `create table if not exists galeed_webhooks (
            brain text not null,
            id text not null,
            url text not null,
            events text[] not null default '{}',
            secret text not null,
            label text not null default '',
            status text not null default 'active',   -- active|disabled|failed
            created_by text not null default '',
            created_at timestamptz default now(),
            last_delivery_at timestamptz,
            last_error text not null default '',
            failure_count integer not null default 0,
            primary key (brain, id),
            unique (brain, url)
          );
          create index if not exists galeed_webhooks_brain_status
            on galeed_webhooks(brain, status);
          create index if not exists galeed_webhooks_events
            on galeed_webhooks using gin (events);
          create table if not exists galeed_webhook_deliveries (
            brain text not null,
            id text not null,
            webhook_id text not null,
            event text not null,
            payload jsonb not null default '{}'::jsonb,
            status text not null default 'queued',    -- queued|delivering|done|dead
            attempt integer not null default 0,
            next_attempt_at timestamptz not null default now(),
            response_status integer,
            error_message text not null default '',
            created_at timestamptz default now(),
            delivered_at timestamptz,
            primary key (brain, id)
          );
          create index if not exists galeed_webhook_deliveries_queue
            on galeed_webhook_deliveries(brain, status, next_attempt_at)`,
  },
  // --- C1: marca p/ o scan de fact.superseded (C2) não re-emitir o mesmo evento de supersessão.
  // ADITIVO + fail-soft: fatos M1..M25 (sem a coluna) lêem false → o scan do C2 os considera "ainda não
  // notificados" UMA vez (idempotente daí em diante). Só a coluna; o scan que a marca é o C2. ---
  {
    id: 35,
    name: "galeed_facts — webhook_notified_superseded (C1, anti-reemissão do fact.superseded; scan é C2)",
    sql: `alter table galeed_facts add column if not exists webhook_notified_superseded boolean default false`,
  },
  // --- M-PAY-A: registro/auditoria de eventos do Stripe (idempotência de webhook). Tabela GLOBAL
  // (sem coluna brain → fora do RLS, como galeed_accounts). O índice pk em event_id é o gate
  // anti-reprocessamento (reentrega do Stripe vira no-op). processed_at fica p/ o M-PAY-B/C marcarem. ---
  {
    id: 36,
    name: "galeed_stripe_events — idempotência/auditoria de webhooks do Stripe (M-PAY-A)",
    sql: `create table if not exists galeed_stripe_events (
      event_id     text primary key,
      type         text not null,
      received_at  timestamptz not null default now(),
      processed_at timestamptz
    )`,
  },
  // --- M-PAY-B: assinaturas. galeed_billing_customers (conta↔Stripe Customer) + galeed_subscriptions
  // (projeção do estado da assinatura, alimentada por webhooks). Tabelas GLOBAIS (sem brain, fora do
  // RLS) e SEM FK p/ galeed_accounts (o bootstrap lazy via getSharedSql não garante ordem de criação). ---
  {
    id: 37,
    name: "galeed_billing_customers + galeed_subscriptions (M-PAY-B, assinaturas)",
    sql: `
      create table if not exists galeed_billing_customers (
        account_id         text primary key,
        stripe_customer_id text unique,
        created_at         timestamptz not null default now()
      );
      create table if not exists galeed_subscriptions (
        account_id             text primary key,
        stripe_customer_id     text,
        stripe_subscription_id text unique,
        tier                   text,
        cohort                 text default 'standard',
        status                 text,
        current_period_end     timestamptz,
        cancel_at_period_end   boolean default false,
        updated_at             timestamptz not null default now()
      );
    `,
  },
  // --- M-PAY-B (revisão): guarda de ORDENAÇÃO de webhook. Stripe não garante ordem de entrega;
  // last_event_at (= event.created) deixa o upsert rejeitar eventos mais VELHOS que o já aplicado,
  // evitando que um `updated` atrasado reverta um `canceled`. Append-only (não editar a 37). ---
  {
    id: 38,
    name: "galeed_subscriptions.last_event_at — guarda de ordenação de webhook (M-PAY-B)",
    sql: `alter table galeed_subscriptions add column if not exists last_event_at timestamptz`,
  },
  // --- M-PAY-C: ledger de créditos (fonte da verdade do SALDO). Carteira por conta + razão
  // append-only idempotente (idem por (account_id, idempotency_key); grants por stripe_event_id).
  // Espelhado em CREDIT_DDL (core/platform/credits.ts) p/ o bootstrap lazy do getSharedSql. ---
  {
    id: 39,
    name: "galeed_credit_wallet + galeed_credit_ledger (M-PAY-C, ledger de créditos)",
    sql: `
      create table if not exists galeed_credit_wallet (
        account_id text primary key,
        balance    bigint not null default 0,
        updated_at timestamptz not null default now()
      );
      create table if not exists galeed_credit_ledger (
        id              bigserial primary key,
        account_id      text not null,
        delta           bigint not null,
        bucket          text not null,
        reason          text not null,
        brain           text,
        op              text,
        stripe_event_id text,
        idempotency_key text not null,
        created_at      timestamptz not null default now()
      );
      create unique index if not exists galeed_credit_ledger_idem on galeed_credit_ledger (account_id, idempotency_key);
      create unique index if not exists galeed_credit_ledger_evt on galeed_credit_ledger (stripe_event_id) where stripe_event_id is not null;
      create index if not exists galeed_credit_ledger_acct on galeed_credit_ledger (account_id, created_at desc);
    `,
  },
  // --- M-PAY-C (revisão): invariante monetário no SCHEMA. A migration 39 criou a carteira sem o
  // check; adiciona aqui (idempotente, só se ainda não existe). Espelha CREDIT_DDL. ---
  {
    id: 40,
    name: "galeed_credit_wallet.check(balance>=0) — invariante de não-negatividade no schema (M-PAY-C)",
    sql: `do $$ begin
      if not exists (select 1 from pg_constraint where conname = 'galeed_credit_wallet_balance_nonneg') then
        alter table galeed_credit_wallet add constraint galeed_credit_wallet_balance_nonneg check (balance >= 0);
      end if;
    end $$;`,
  },
  // --- M-PAY-D (revisão): stripe_event_id no ledger é AUDITORIA, não chave de idempotência (essa é
  // (account_id, idempotency_key)). O índice ÚNICO virava armadilha: um event_id que gere >1 linha
  // (grant + clawback) abortaria a tx do webhook. Troca p/ índice NÃO-único. ---
  {
    id: 41,
    name: "galeed_credit_ledger_evt → índice NÃO-único (stripe_event_id é auditoria) (M-PAY-D)",
    sql: `drop index if exists galeed_credit_ledger_evt;
      create index if not exists galeed_credit_ledger_evt on galeed_credit_ledger (stripe_event_id) where stripe_event_id is not null;`,
  },
  // --- M-PAY-E: rastreio de emissão de NFS-e (Spedy). 1 emissão por invoice.paid (event_id).
  // Espelhado em NFSE_DDL (core/platform/nfse.ts). ---
  {
    id: 42,
    name: "galeed_nfse_emissions — rastreio de NFS-e via Spedy (M-PAY-E)",
    sql: `create table if not exists galeed_nfse_emissions (
      event_id     text primary key,
      account_id   text,
      status       text not null,
      provider_id  text,
      amount_cents bigint,
      error        text,
      created_at   timestamptz not null default now()
    )`,
  },
  // --- M-PAY-F: créditos de indicação. 1 indicação por conta indicada; ativa na 1ª ingestão.
  // Espelhado em REFERRAL_DDL (core/platform/referral.ts). ---
  {
    id: 43,
    name: "galeed_referrals — atribuição + ativação de indicação (M-PAY-F)",
    sql: `create table if not exists galeed_referrals (
      referred_account text primary key,
      referrer_account text not null,
      status           text not null default 'pending',
      created_at       timestamptz not null default now(),
      activated_at     timestamptz
    );
    create index if not exists galeed_referrals_referrer on galeed_referrals (referrer_account);`,
  },
  // --- M-PAY-F (revisão): reserva de vaga fundador no instante do checkout (fecha a janela
  // checkout→ativo + a corrida). Espelhado no bootstrap de bff-stripe.ts. ---
  {
    id: 44,
    name: "galeed_founder_reservations — reserva atômica de vaga fundador (M-PAY-F)",
    sql: `create table if not exists galeed_founder_reservations (
      account_id text primary key,
      created_at timestamptz not null default now()
    )`,
  },
  // --- M-PAY-H/1: galeed_spend_cap ganha número de migration (até aqui só nascia lazy no CREDIT_DDL
  // do core/platform/credits.ts). DDL IDÊNTICA à de credits.ts (teto de gasto por CONTA, em créditos;
  // kill_switch on = ao bater o teto no ciclo o gate pausa). Tabela GLOBAL (sem brain, fora do RLS). ---
  {
    id: 45,
    name: "galeed_spend_cap — teto de gasto por conta (M-PAY-H, numera a tabela lazy do CREDIT_DDL)",
    sql: `create table if not exists galeed_spend_cap (
      account_id    text primary key,
      enabled       boolean not null default false,
      kill_switch   boolean not null default true,
      limit_credits bigint not null default 0,
      updated_at    timestamptz not null default now()
    )`,
  },
  // --- M-PAY-H/1: expiração de trial. O trial (1000cr/14d) é o ÚNICO bucket que expira no MVP. A
  // carteira separa trial_remaining (expira em trial_expires_at) do restante de balance (não expira);
  // balance segue sendo o TOTAL (trial + pago). No ledger, expires_at é o rastro do grant que expira
  // (índice parcial p/ varredura barata). ADITIVO (carteiras M-PAY-C lêem trial_remaining=0). ---
  {
    id: 46,
    name: "galeed_credit_wallet.trial_remaining/trial_expires_at + galeed_credit_ledger.expires_at (M-PAY-H, expiry de trial)",
    sql: `alter table galeed_credit_wallet add column if not exists trial_remaining bigint not null default 0;
          alter table galeed_credit_wallet add column if not exists trial_expires_at timestamptz;
          alter table galeed_credit_ledger add column if not exists expires_at timestamptz;
          create index if not exists galeed_credit_ledger_expires
            on galeed_credit_ledger(expires_at) where expires_at is not null`,
  },
  // --- M-PAY-H/1: entitlement na assinatura. grace_until = janela de graça (7d) setada em
  // invoice.payment_failed e limpa quando volta a active (Onda 3). ADITIVO (assinaturas M-PAY-B lêem
  // grace_until null → sem graça pendente). ---
  {
    id: 47,
    name: "galeed_subscriptions.grace_until — janela de graça de inadimplência (M-PAY-H, entitlement)",
    sql: `alter table galeed_subscriptions add column if not exists grace_until timestamptz`,
  },
  // --- M-PAY-H/1: preferências de billing por CONTA (auto-recarga opt-in + dedup de alerta + método
  // salvo). Espelhado em BILLING_PREFS_DDL (core/platform/billing-prefs.ts) p/ o bootstrap lazy do
  // getSharedSql. Tabela GLOBAL (sem brain, fora do RLS). Lógica (auto-recarga/alertas) vem na Onda 4. ---
  {
    id: 48,
    name: "galeed_billing_prefs — preferências de billing por conta (M-PAY-H, auto-recarga + alertas)",
    sql: `create table if not exists galeed_billing_prefs (
      account_id                     text primary key,
      autorecharge_enabled           boolean not null default false,
      autorecharge_threshold_credits bigint not null default 0,
      autorecharge_package           text,
      last_alert_pct                 int not null default 0,
      default_payment_method         text,
      updated_at                     timestamptz not null default now()
    )`,
  },
  // --- M-PAY-H/3: flags de sinalização do dunning. needs_action = 3DS/SCA pendente
  // (invoice.payment_action_required); dispute_open = chargeback aberto (charge.dispute.created).
  // Só SINALIZAÇÃO (sem efeito de cobrança); a UI mostra e a auto-recarga (Onda 4) não reentra em loop
  // com needs_action. Espelhado em BILLING_PREFS_DDL (core/platform/billing-prefs.ts). ADITIVAS. ---
  {
    id: 49,
    name: "galeed_billing_prefs.needs_action/dispute_open — sinais de dunning (M-PAY-H, entitlement)",
    sql: `alter table galeed_billing_prefs add column if not exists needs_action boolean not null default false;
          alter table galeed_billing_prefs add column if not exists dispute_open boolean not null default false`,
  },
  // --- M-PAY-H/N (auditoria — drift): a trava de auto-recarga EM VOO (anti-cobrança-dupla no cartão)
  // só nascia no DDL lazy (BILLING_PREFS_DDL em core/platform/billing-prefs.ts). Numerada aqui p/
  // espelhar o DDL (padrão das 36–49). Setada ao DISPARAR a recarga (now()+TTL), limpa em
  // payment_intent.succeeded/failed. ADITIVA (contas sem a coluna = sem recarga em voo). ---
  {
    id: 50,
    name: "galeed_billing_prefs.autorecharge_pending_until — trava de auto-recarga em voo (M-PAY-H, numera o DDL lazy)",
    sql: `alter table galeed_billing_prefs add column if not exists autorecharge_pending_until timestamptz`,
  },
  // --- M-PAY-H/10 (DECISÃO DO FUNDADOR): crédito PRÉ-PAGO (top-up/auto-recarga) usável com a
  // assinatura LAPSED. topup_remaining = a parcela do balance que veio de compra avulsa (análogo a
  // trial_remaining). O gate de entitlement bloqueia o BOLO da assinatura, mas NÃO confisca o que o
  // cliente comprou: sob lapsed, a ação passa SE topup_remaining >= custo e o débito sai do topup.
  // Ordem de gasto normal: trial → bolo/monthly → topup por ÚLTIMO (preserva o pré-pago). ADITIVA
  // (carteiras anteriores lêem topup_remaining=0). Espelhada no CREDIT_DDL de credits.ts. ---
  {
    id: 51,
    name: "galeed_credit_wallet.topup_remaining — crédito pré-pago usável sob lapsed (M-PAY-H/10)",
    sql: `alter table galeed_credit_wallet add column if not exists topup_remaining bigint not null default 0`,
  },
  {
    id: 52,
    name: "event/actor em galeed_access_log — feed de governança (timeline único)",
    sql: `alter table galeed_access_log add column if not exists event text;
          alter table galeed_access_log add column if not exists actor text`,
  },
  {
    id: 53,
    name: "acesso total ('*') no galeed_in_area_scope — bots de integração leem modo livre",
    // O grant areas=['*'] (acesso total, explícito) pula o filtro de área — páginas de MODO
    // LIVRE (sem tag area:) ficavam invisíveis pra QUALQUER token escopado, mesmo com todas as
    // áreas concedidas (beco silencioso: /v1/facts=[] sem pista). Sigilo/denyTypes seguem valendo.
    sql: `create or replace function galeed_in_area_scope(tags jsonb, scope text) returns boolean language sql immutable as $$
        select coalesce(scope,'') = '*'
            or exists (
              select 1 from jsonb_array_elements_text(coalesce(tags,'[]'::jsonb)) t(tag)
              where left(t.tag, 5) = 'area:'
                and substring(t.tag from 6) = any (string_to_array(coalesce(scope,''), ','))
            ) $$`,
  },
  // --- Fix #2 (sobre-fusão de entidades): cache do DESEMPATE de grupo ambíguo. A resolução de
  // entidade separa sinal FORTE (funde sozinho) de FRACO (contenção, ambíguo). O grupo ambíguo é
  // desempatado pela LLM 1× e CACHEADO aqui (por group_key = sha256 da assinatura do grupo), pra
  // não re-perguntar toda ingestão. Sem LLM → conservador (não funde), nada é gravado. ---
  {
    id: 54,
    name: "galeed_entity_disambig — cache do desempate LLM de grupo ambíguo (fix sobre-fusão de entidades)",
    sql: `create table if not exists galeed_entity_disambig (
      brain text not null, group_key text not null,
      decision jsonb not null, updated_at timestamptz default now(),
      primary key (brain, group_key))`,
  },
];
