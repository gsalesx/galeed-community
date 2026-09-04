/** M12/S3 — o PIPELINE. Dado um IngestJob, lê o conteúdo (blob ou textBody),
 *  FATIA (sliceForIngest), CAPTURA (capture) e EXTRAI FATOS (extractOne — decisão #2 do fundador: a extração
 *  roda AUTOMÁTICA dentro do job) e INDEXA (deriveIncremental — write-path O(1), M14/ADR-008). Reusa o motor — NÃO reimplementa fatiamento nem
 *  extração. Idempotente por (brain, content_hash) via o dedup de capture/externalId. Lança Error com mensagem
 *  legível em falha (o worker S4 captura → markJobError; o pipeline NÃO conhece a fila). Tenant-neutro. */
import { createHash } from "node:crypto";
import type { IngestJob, IngestJobResult } from "./ingest-queue.ts";
// M16/S3 — estado de lote na fila (S2): grava batch_id + custom_map e transiciona pra batch_submitted.
import { markJobBatchSubmitted } from "./ingest-queue.ts";
import { getBlobStore } from "./blob-store.ts";
import { sliceForIngest } from "./ingest-doc.ts";
import { extractDocText } from "../../lib/extract-doc.ts";
import { capture } from "./capture.ts";
import { extractOne } from "../extraction/extract.ts";
// M15/S3 — porteiro (Stage 0/2): scoreSegment decide o que vale a chamada LLM; resolveTriageProfile
// resolve o perfil (canal,tipo) DB>seed>default-genérico (fail-open). Importados de S1 — NÃO editados aqui.
import { scoreSegment, resolveTriageProfile } from "./triage.ts";
import { classify } from "./classify.ts";
// M15/S3 — superfície de extração por unit (S1): buildExtractionContext (1×/página), extractUnit (LLM por
// unit worthy), buildExtractionUnits (fatia a página), entityHints (sinal "entity"), freshVersion. S3 só CONSOME.
import {
  buildExtractionContext,
  extractUnit,
  buildExtractionUnits,
  entityHints,
  freshVersion,
} from "../extraction/extract.ts";
import { ensureSchemaPack } from "../extraction/schema-pack.ts";
import { deriveIncremental } from "../retrieval/indexer.ts";
// M16/S3 (ADR-010) — roteamento sync↔batch + montagem/submit do lote. extractWorthyUnits roteia AQUI.
import {
  shouldUseBatch,
  buildBatchRequests,
  submitExtractionBatch,
} from "./batch-extract.ts";
import type { ExtractionContext, ExtractionUnit } from "../extraction/extract.ts";
import { buildEmbeddings } from "../retrieval/embeddings.ts";
import { getEngine } from "../platform/engine.ts";
import type { PageRow, SourceRow } from "../platform/engine.ts";
// M21/S2 — a REGRA DE OURO (ADR-016): gate puro PÓS-extração (receita reconhece+ancora → fato carimbado;
// resto → fila de revisão) + guidance da receita no prompt. Job SEM sourceId ⇒ pass-through byte-idêntico.
import { applyRecipeGate, recipeGuidance, addReviewItemsAndNotify } from "./golden-rule.ts";
import { slugify } from "../../lib/slug.ts";

/** Callback de progresso PURO (0..1 + mensagem). O worker (S4) o liga a updateJobProgress.
 *  O pipeline NÃO conhece a fila — só reporta. */
export type ProgressFn = (fraction: number, message: string) => void | Promise<void>;

/** M15/S2 — as DUAS FASES do pipeline (ADR-009, invariante I). `findable` = a Fase A terminou (capture +
 *  FTS + embeddings) → o cérebro está BUSCÁVEL; `digesting` = entrando na Fase B (extração LLM). */
export type IngestPhase = "findable" | "digesting";

/** M15/S2 — callback de transição de FASE. O worker o liga a markJobFindable/markJobDigesting. Opcional:
 *  sem ele o pipeline roda igual (só na nova ORDEM). O pipeline NÃO conhece a fila — só reporta a fase. */
export type PhaseFn = (phase: IngestPhase) => void | Promise<void>;

/** Resultado interno do pipeline = o IngestJobResult que o worker grava em markJobDone. */
export type ProcessJobResult = IngestJobResult;

/** M12/S3 — processa UM job: lê o conteúdo, fatia, captura, EXTRAI FATOS (extractOne, decisão #2 do
 *  fundador), indexa. Idempotente por (brain, content_hash) via o dedup de capture/externalId. Lança
 *  Error com mensagem legível em falha (o worker captura → markJobError).
 *
 *  M15/S2 (ADR-009, invariante I) — REORDENADO em DUAS FASES para deixar o cérebro ENCONTRÁVEL antes de
 *  DIGERIDO:
 *    Fase A (encontrável): fatia → loop de CAPTURE (paralelo) + FTS → buildEmbeddings → onPhase("findable").
 *    Fase B (digestão):    onPhase("digesting") → extractWorthyUnits (extração LLM) → deriveIncremental (M14).
 *  Antes, os embeddings vinham por ÚLTIMO (atrás de toda a extração); agora vêm na Fase A. `deriveIncremental`
 *  (M14/ADR-008) permanece INTACTO, só reordenado pra Fase B. `onPhase` é OPCIONAL (sem ele, mesma ordem). */
export async function processBlobJob(
  job: IngestJob,
  onProgress?: ProgressFn,
  onPhase?: PhaseFn,
): Promise<ProcessJobResult> {
  const report = async (f: number, m: string) => {
    if (onProgress) await onProgress(Math.max(0, Math.min(1, f)), m);
  };
  await report(0.02, "começando…");

  // 1) Resolve o TEXTO + a base de idempotência (externalId base = content_hash).
  let text: string;
  let base: string; // prefixo do externalId — o mesmo (brain, base) é idempotente
  let kindLabel: string; // p/ a message ("documento" | "conversa" | "texto")
  let title: string | undefined;

  if (job.kind === "file") {
    if (!job.contentHash) throw new Error("job sem content_hash — nada pra processar.");
    const buffer = await getBlobStore().get(job.brain, job.contentHash);
    if (!buffer) throw new Error("original não encontrado no armazenamento (blob ausente).");
    const ex = await extractDocText(buffer, job.mime ?? undefined, job.filename ?? undefined);
    text = ex.text;
    kindLabel = "documento";
    base = job.contentHash;
    title = job.title ?? job.filename ?? undefined;
  } else {
    // kind === "text"
    text = (job.textBody ?? "").trim();
    if (!text) throw new Error("texto vazio.");
    // base determinística do texto (mesma ideia do paste do M11/S5)
    base = job.contentHash ?? sha16(text);
    kindLabel = "texto";
    title = job.title ?? undefined;
  }

  // 2) Fatia + captura + extrai cada página (extractOne — a extração roda AQUI, no job).
  const slices = sliceForIngest(text);
  const e = await getEngine(job.brain);
  // M21/S2 — resolve a FONTE do job (S1). Sem sourceId ⇒ source=undefined ⇒ pipeline byte-idêntico ao
  // M20 (a LEI do slot). Fonte pausada FALHA com mensagem legível (defesa em profundidade — a borda S3
  // já bloqueia antes).
  const source = job.sourceId ? await e.getSource(job.sourceId) : undefined;
  if (job.sourceId && !source) throw new Error("fonte do job não existe mais.");
  if (source && source.status === "pausada")
    throw new Error(`a fonte "${source.name}" está pausada — retome a leitura pra ingerir.`);
  // tags do CONTRATO: src:<id> + canal:<channel da fonte> (B10 — a proveniência de canal chega à
  // página; `fonte:paste|upload` segue sendo o MECANISMO de entrada, intocado: repair/triagem
  // dependem dele) + áreas DISTINTAS da receita como area:<slug>.
  const sourceTags = source
    ? [
        `src:${source.id}`,
        ...(source.channel?.trim() ? [`canal:${slugify(source.channel)}`] : []),
        ...[...new Set(source.recipe.fields.map((f) => (f.area || "").trim()).filter(Boolean))].map(
          (a) => `area:${slugify(a)}`,
        ),
      ]
    : [];
  // Pré-aquece o schema-pack UMA vez (M13): com concorrência, evita os N workers correrem pra popular o
  // cache do pack ao mesmo tempo (thundering herd). extractOne ainda chama ensureSchemaPack (idempotente).
  await ensureSchemaPack(job.brain);

  // Concorrência LIMITADA: processa até GALEED_INGEST_CONCURRENCY páginas em paralelo (default 10). Pool
  // pequeno (não Promise.all em TUDO) pra não estourar o rate-limit da Anthropic (429). Seguro paralelizar:
  // cada página é independente (externalId por FATIA (hash do conteúdo) = idempotente; extractOne por página; derivação no fim).
  const CONCURRENCY = Math.max(1, Number(process.env.GALEED_INGEST_CONCURRENCY) || 10);
  const slugs: string[] = new Array(slices.length);
  // M14 (S3): índices das fatias EFETIVAMENTE novas (não-skipadas). Só esses slugs entram no lote do
  // deriveIncremental — re-supersede SÓ os grupos do lote (write-path O(1), ADR-008). Set.add é seguro no
  // event-loop single-thread mesmo com CONCURRENCY (sem race real).
  const novosIdx = new Set<number>();
  let skipped = 0;
  let done = 0;
  let next = 0; // índice da próxima fatia a reivindicar (incremento síncrono — sem race no event loop)

  // ===== FASE A — ENCONTRÁVEL (Stage 1, ADR-009/invariante I) =====
  // Loop de CAPTURE (paralelo, pool CONCURRENCY) SEM extração. O FTS já vem do capture (galeed_pages);
  // a extração LLM (lenta) foi adiada pra Fase B. Assim o cérebro fica buscável antes de digerido.
  const processOne = async (i: number) => {
    const sl = slices[i];
    // M21/S2 — com fonte: type/sensitivity declarados na fonte e tags do contrato (src:<id> + area:<slug>).
    // Sem fonte: campos IDÊNTICOS aos de antes (sensitivity ausente → capture resolve como hoje).
    const baseTags = job.kind === "file" ? [`doc:${base}`] : [];
    const allTags = [...baseTags, ...sourceTags];
    const cap = await capture({
      home: job.brain,
      text: sl.text,
      type: source ? job.type || source.type : job.type,
      // P1-D/A6 — título SEM o total "/Y": Y muda quando o arquivo cresce e mudava TODO slug
      // (páginas 95% duplicadas). "parte X" é estável: sliceForIngest é greedy por parágrafo —
      // prefixo idêntico ⇒ mesmas partes (provado no export real: 106/107 fatias estáveis, spec §1.3).
      title:
        slices.length > 1
          ? `${title ?? "documento"} (parte ${sl.part})`
          : title ?? undefined,
      date: job.jobDate ?? undefined,
      source: job.kind === "text" ? "paste" : "upload",
      // P1-D/A6 — dedup por FATIA: o id É o conteúdo da fatia (não hash-do-arquivo#parte).
      // Formato `sl:<sha16>` casa com a migração 28 ('sl:' || content_hash) — transição sem duplicata.
      externalId: `sl:${sha16(sl.text)}`,
      tags: allTags.length ? allTags : undefined,
      sensitivity: source?.default_sensitivity,
    });
    slugs[i] = cap.slug;
    if (cap.skipped) {
      skipped++;
    } else {
      novosIdx.add(i); // M14 (S3): marca a fatia nova → seu slug entra no lote do deriveIncremental
    }
    done++;
    await report(0.05 + 0.4 * (done / slices.length), `indexando ${done}/${slices.length}…`);
  };

  const worker = async () => {
    for (let i = next++; i < slices.length; i = next++) await processOne(i);
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, slices.length) }, () => worker()));

  const novos = slices.length - skipped;
  // P0-C/C3b — PENDENTES: fatias SKIPADAS pelo capture (já capturadas por este ou outro upload do MESMO
  // arquivo) que NUNCA chegaram à extração (extract_version=''). Sem isto, um re-claim pós-crash dá
  // skipped=total, novos=0 e a Fase B é PULADA pra sempre — a idempotência deixa de impedir o reparo.
  // DESVIO DA SPEC (LEARNINGS M17/S4 — código real é a verdade): a spec sugeriu ler
  // `e.getPage(slug).extract_version`, mas o getPage REAL do engine NÃO seleciona `extract_version`
  // (só allPages o expõe). Uso allPages() 1× → mapa slug→extract_version (confiável, dentro da API
  // pública, sem tocar o engine). Há só fatias-skipadas a checar e a chamada é única por job.
  const pendentesIdx = new Set<number>();
  const haSkipadas = slices.some((_, i) => !novosIdx.has(i));
  if (haSkipadas) {
    const allPages = await e.allPages();
    const versionBySlug = new Map(allPages.map((p) => [p.slug, p.extract_version ?? ""]));
    for (let i = 0; i < slices.length; i++) {
      if (novosIdx.has(i)) continue;
      const slug = slugs[i];
      if (!slug) continue;
      if (versionBySlug.has(slug) && (versionBySlug.get(slug) || "") === "") pendentesIdx.add(i);
    }
  }
  const pendentes = [...pendentesIdx];

  // EMBEDDINGS (busca semântica) AGORA — ANTES da extração (M15/S2): incrementais por hash, dependem só do
  // TEXTO capturado (não dos fatos), então é seguro embedar já. Sem isto fica 0 vetores e a busca cai pra FTS
  // (AND-restritivo). Degrada sem OPENAI_API_KEY (FTS segue). É a mudança que satisfaz o invariante I.
  let embeddingsFlag: "ok" | "failed" | undefined;
  let embeddingsError: string | undefined;
  if (novos > 0 || pendentes.length > 0) {
    await report(0.45, "deixando buscável (semântica)…");
    try {
      await buildEmbeddings(job.brain);
      embeddingsFlag = "ok";
    } catch (err) {
      // P0-C/M3a — NUNCA mais silencioso: FTS segue, semântica off PARA ESTE LOTE, mas o job carrega o
      // rastro (result_json.embeddings='failed') e a varredura re-tenta (§6).
      embeddingsFlag = "failed";
      embeddingsError = err instanceof Error ? err.message : String(err);
      console.error(
        `[pipeline] embeddings falharam — busca semântica off pra este lote (a varredura re-tenta): ${embeddingsError}`,
      );
    }
  }
  // helper local: monta o result com o rastro de embeddings quando definido (retrocompat: ausente = nunca falhou).
  const withEmbeddings = (r: IngestJobResult): IngestJobResult => ({
    ...r,
    ...(embeddingsFlag ? { embeddings: embeddingsFlag } : {}),
    ...(embeddingsError ? { embeddings_error: embeddingsError } : {}),
  });

  await onPhase?.("findable"); // ← o cérebro está BUSCÁVEL. worker → markJobFindable
  await report(0.5, "buscável — digerindo fatos…");

  // ===== FASE B — DIGESTÃO (Stage 2 + Stage 3, ADR-009) =====
  await onPhase?.("digesting"); // worker → markJobDigesting
  if (novos > 0 || pendentes.length > 0) {
    // P0-C/C3b — o lote da Fase B = NOVAS ∪ PENDENTES (capturadas-mas-nunca-extraídas). A extração só toca
    // o que entrou neste lote (idempotência preservada — putExtraction é upsert por (brain, source_slug)).
    const faseBIdx = new Set<number>([...novosIdx, ...pendentesIdx]);
    const pages = await loadNovasPages(e, faseBIdx, slugs);
    // M16/S3 (ADR-010): extractWorthyUnits ROTEIA sync↔batch. "batch_submitted" ⇒ o lote foi submetido e o
    // job ficou batch_submitted (markJobBatchSubmitted já gravou) — o harvest+deriveIncremental rodam no
    // poller (S4), NÃO aqui. "sync_done" ⇒ caminho M15 intacto (já extraiu) → segue p/ o derive abaixo.
    const outcome = await extractWorthyUnits(job, pages, report, source);
    if (outcome === "batch_submitted") {
      // CAMINHO BATCH: NÃO deriva no processBlobJob (derive é no harvest/S4) e o worker NÃO chama
      // markJobDone p/ este job (status já é batch_submitted; o poller fecha). Retorna o result parcial —
      // o cérebro já está ENCONTRÁVEL (Fase A); os fatos entram em minutos pelo lote.
      if (source) await e.touchSourceRead(source.id); // M21 — leitura da fonte registrada (last_read_at)
      return withEmbeddings({ total: slices.length, slugs, skipped, message: resumoBatch(novos, pendentes.length, slices.length, kindLabel) });
    }

    // CAMINHO SÍNCRONO (M15 intacto): faseBSlugs = NOVAS ∪ PENDENTES. Só eles entram no lote do
    // deriveIncremental → re-supersede SÓ os grupos (entity,predicate,tier) que o lote toca.
    const faseBSlugs = [...faseBIdx].map((i) => slugs[i]).filter(Boolean);
    await report(0.95, "consolidando…");
    // M14 (S3 · ADR-008): write-path INCREMENTAL — derivação dirigida ao lote do job (não re-deriva o brain
    // inteiro). INTACTO no M15; só reordenado pra Fase B (depende dos fatos extraídos acima).
    await deriveIncremental(job.brain, faseBSlugs);
  }

  if (source) await e.touchSourceRead(source.id); // M21 — leitura da fonte registrada (last_read_at)
  await report(1, "pronto");
  return withEmbeddings({ total: slices.length, slugs, skipped, message: resumo(novos, pendentes.length, slices.length, kindLabel) });
}

/** M15/S2 — carrega as PageRow das fatias efetivamente NOVAS deste lote (na ordem dos índices), pra Fase B
 *  digerir só o que entrou. Pula slug ausente (defensivo — capture não devolveu página). */
async function loadNovasPages(
  e: Awaited<ReturnType<typeof getEngine>>,
  novosIdx: Set<number>,
  slugs: string[],
): Promise<PageRow[]> {
  const pages: PageRow[] = [];
  for (const i of novosIdx) {
    const slug = slugs[i];
    if (!slug) continue;
    const page = await e.getPage(slug);
    if (page) pages.push(page);
  }
  return pages;
}

/** M16/S3 — uma página com seu ctx (1×/página) + as units que o porteiro julgou `worthy`. É a unidade de
 *  trabalho COMPARTILHADA entre o caminho síncrono e o caminho batch: o conjunto worthy é o MESMO nos dois
 *  (pré-condição da equivalência, LEI II). Páginas com 0 units worthy NÃO entram (não há ctx nem chamada). */
interface WorthyPage {
  page: PageRow;
  ctx: ExtractionContext; // computado 1×/página (tool/dims/provider/blocos) — reusado pelos dois caminhos
  units: ExtractionUnit[]; // só as units `worthy` (na ordem de buildExtractionUnits — determinística)
}

/** M16/S3 — GATING compartilhado (a triagem M15, fatorada). Resolve o perfil 1×/página, roda scoreSegment
 *  por unit, separa worthy×skipped, registra a AUDITORIA das puladas (log estruturado — idêntico ao M15) e
 *  monta o ctx 1×/página SÓ pras páginas com ≥1 worthy. É a ÚNICA fonte da decisão "o que é worthy" — usada
 *  por AMBOS os caminhos (sync e batch) → o conjunto worthy é garantidamente IDÊNTICO (LEI II). NÃO chama o
 *  LLM (isso é do extractWorthyUnitsSync) nem submete lote (isso é do roteamento). Tenant-neutro: channel/
 *  confident SÓ resolvem o perfil — zero `if (channel === ...)`. */
async function selectWorthy(
  job: IngestJob,
  pages: PageRow[],
  source?: SourceRow,
): Promise<{ worthyByPage: WorthyPage[]; unitsWorthy: number; unitsTotal: number; unitsSkipped: number }> {
  // Escape-hatch de reversibilidade (DESIGN-SPEC §4 do M15): GALEED_TRIAGE_BYPASS=1 → extrai TUDO.
  const bypass = process.env.GALEED_TRIAGE_BYPASS === "1";

  // canal de roteamento = a MESMA tag de fonte que o pipeline já passa ao capture (job.kind text→paste,
  // senão upload). Só entra em resolveTriageProfile/scoreSegment p/ RESOLVER perfil — nunca ramifica.
  const channel = job.kind === "text" ? "paste" : "upload";
  const hints = await entityHints(job.brain); // 1× por brain (não por unit/página) — M9 já cacheia

  const worthyByPage: WorthyPage[] = [];
  let unitsTotal = 0;
  let unitsWorthy = 0;
  let unitsSkipped = 0;

  for (const page of pages) {
    // `confident` = a flag de classify. PageRow não a expõe → reclassificamos DETERMINISTICAMENTE (custo zero,
    // sem LLM) via classify (DESIGN-SPEC §2, caminho (a)): perfil específico SÓ quando classify.confident.
    const confident = classify(page.body, { source: channel, type: page.type }).confident;
    // perfil resolvido UMA vez por página (canal + tipo + confiança) — não por unit (evita N leituras de config).
    // M21/S2 — fonte com `recipe.triage_profile` não-vazio: o perfil resolve pela CHAVE da fonte
    // (`<canal-da-fonte>:<tipo-da-fonte>`, mecanismo M15 existente — confident=true porque o tenant
    // DECLAROU; nada de mecanismo novo). Sem fonte/sem triage_profile ⇒ resolução idêntica à de hoje.
    const profile = source?.recipe?.triage_profile
      ? await resolveTriageProfile(job.brain, source.channel, source.type, true)
      : await resolveTriageProfile(job.brain, channel, page.type, confident);

    const units = buildExtractionUnits(page); // M9/S2 — segmentos da página (com triageText do S5)
    // scoreSegment é PURO/SÍNCRONO (S1): roda por unit; o perfil já está resolvido. Bypass força worthy=true.
    // REVISÃO gap-S3-cut §4: o porteiro pontua u.triageText (texto SEMÂNTICO sem scaffold Speaker/ISO, do S5),
    // NÃO u.body — o body carrega timestamps que disparavam hasNumber e cegavam o corte (causa-raiz do blocker).
    const verdicts = units.map((u) => {
      const v = scoreSegment(
        { text: u.triageText, entityHints: hints, channel, type: page.type, confident },
        profile,
      );
      return { unit: u, v: bypass ? { ...v, worthy: true } : v };
    });
    const worthy = verdicts.filter((x) => x.v.worthy);
    const skipped = verdicts.filter((x) => !x.v.worthy);
    unitsTotal += verdicts.length;
    unitsWorthy += worthy.length;
    unitsSkipped += skipped.length;

    // Página com ≥1 unit worthy: monta o ctx 1×/página (S1) e entra no worthyByPage (consumido pelo caminho
    // sync OU batch). Página com 0 worthy → NÃO entra (sem ctx, sem chamada; segue encontrável da Fase A).
    if (worthy.length > 0) {
      // M21/S2 — com fonte, a RECEITA orienta o prompt (seam aditivo do extract.ts §4); sem fonte,
      // overrides ausentes ⇒ ctx byte-idêntico ao M20. As dims NÃO mudam (a receita não amputa).
      const ctx = await buildExtractionContext(
        job.brain,
        page,
        source ? { guidance: recipeGuidance(source.recipe) } : undefined,
      ); // 1×/página (tool/dims/provider/blocos)
      worthyByPage.push({ page, ctx, units: worthy.map((x) => x.unit) });
    }

    // AUDITORIA das puladas (triagem ≠ deleção): o porquê do skip é recuperável. Log estruturado do worker
    // (DESIGN-SPEC §3 / gap-S3-audit opção C). A unit pulada já está CAPTURADA+ENCONTRÁVEL (Fase A) e
    // re-extraível por comando (GALEED_TRIAGE_BYPASS=1 ou re-extração M11/S6). Ver ARTIFACTS.
    if (skipped.length > 0) {
      console.log(
        `[triage-skip] brain=${job.brain} page=${page.slug} skipped=${skipped.length}/${units.length} ` +
          JSON.stringify(
            skipped.map((x) => ({
              quote: x.unit.triageText.slice(0, 120),
              score: x.v.score,
              signals: x.v.signals,
              profile: x.v.profile,
            })),
          ),
      );
    }
  }

  // contadores observáveis pro gate medir o corte ≥50% (DESIGN-SPEC §5 do M15). Log do worker basta.
  console.log(
    `[triage] brain=${job.brain} unitsTotal=${unitsTotal} unitsWorthy=${unitsWorthy} ` +
      `unitsSkipped=${unitsSkipped} bypass=${bypass}`,
  );

  return { worthyByPage, unitsWorthy, unitsTotal, unitsSkipped };
}

/** M16/S3 — Fase B / digestão SÍNCRONA (o caminho M15, INTACTO byte-a-byte). Recebe o gating já feito
 *  (worthyByPage de selectWorthy) e chama o LLM (extractUnit) SÓ nas units worthy, mergeia por dim IDÊNTICO
 *  a extractOne, e persiste (putExtraction+markExtracted) pra deriveIncremental (M14) funcionar igual. É o
 *  caminho dos jobs pequenos + o fallback (fail-safe). NÃO faz a triagem (já veio pronta). */
async function extractWorthyUnitsSync(
  job: IngestJob,
  worthyByPage: WorthyPage[],
  report: (f: number, m: string) => Promise<void>,
  source?: SourceRow,
): Promise<void> {
  const e = await getEngine(job.brain);
  const versionTag = await freshVersion(job.brain); // mesma versão composta que extractOne grava (prompt+ctx)

  let done = 0;
  for (const { page, ctx, units } of worthyByPage) {
    // ===== Stage 2 — DIGESTÃO SÓ NO QUE PASSOU (invariante II, ADR-009) =====
    // O LLM (extractUnit) só toca as units `worthy`. Agrega os claims por dimensão IDÊNTICO a extractOne
    // (merge por dim) e persiste com o MESMO shape pra deriveIncremental (M14, Fase B) funcionar igual.
    const merged: Record<string, any[]> = {};
    for (const d of ctx.dims) merged[d] = [];
    let lastDate = page.date || "";
    let u = 0; // índice da unit na página (heartbeat abaixo)
    for (const unit of units) {
      // HEARTBEAT por UNIT (antes o report era só por PÁGINA, no fim do loop de páginas): o report
      // renova o lease (updateJobProgress) e uma página de conversa pode ter ~50 units — no provider
      // cli (latência de minutos) ou sob backoff 429 (~60s/chamada), a página estourava os 15 min do
      // lease e o reaper re-enfileirava/matava um job VIVO (extração duplicada, dead falso, dead→done).
      // Report ANTES de cada chamada LLM: renova o lease antes de entrar na parte potencialmente longa.
      // Progresso monotônico (converge pro report por página); custo = 1 UPDATE por chamada LLM
      // (desprezível vs. a latência dela). No digestPendingPages o report é noop — inócuo (sem lease).
      await report(
        0.5 + 0.45 * ((done + u / units.length) / Math.max(1, worthyByPage.length)),
        `digerindo ${done + 1}/${worthyByPage.length} (unit ${u + 1}/${units.length})…`,
      );
      u++;
      const out = await extractUnit(job.brain, page, unit, ctx); // ← LLM SÓ aqui (worthy)
      for (const d of ctx.dims) if (Array.isArray(out[d])) merged[d].push(...out[d]);
      if (unit.date) lastDate = unit.date;
    }
    // M21/S2 — REGRA DE OURO (ADR-016): gate PURO pós-extração ANTES do putExtraction. Sem fonte ⇒
    // recipe=null ⇒ pass-through byte-idêntico (approved = merged, zero itens na fila). Rejeitados NUNCA
    // somem em silêncio: viram linha em galeed_ingest_review + log estruturado (espelho do [triage-skip]).
    const gate = applyRecipeGate(merged, source?.recipe ?? null, source?.id ?? "", page.slug, page.body);
    // C2 — review.pending: addReviewItemsAndNotify substitui o addReviewItems cru (storage + webhook
    // agregado por reason). Fail-soft: a emissão nunca derruba a ingestão (a regra de ouro garante).
    if (gate.rejected.length) await addReviewItemsAndNotify(job.brain, gate.rejected);
    console.log(
      `[recipe-gate] brain=${job.brain} page=${page.slug} approved=${gate.counts.approved} ` +
        `rejected=${gate.counts.rejected} source=${source?.id ?? "-"}`,
    );
    await e.putExtraction({
      source_slug: page.slug,
      type: page.type,
      date: lastDate,
      content_hash: page.content_hash || "",
      prompt_version: versionTag,
      extractions: gate.approved,
    });
    await e.markExtracted(page.slug, versionTag);

    done++;
    await report(0.5 + 0.45 * (done / Math.max(1, worthyByPage.length)), `digerindo ${done}/${worthyByPage.length}…`);
  }
}

/** M16/S3 (ADR-010) — Fase B / digestão com ROTEAMENTO sync↔batch. Gating compartilhado (selectWorthy) +
 *  decisão: > limiar de units worthy E provider api E chave ⇒ BATCH (monta requests reusando o MESMO corpo
 *  de extractUnit, submete, grava batch_id via markJobBatchSubmitted, RETORNA "batch_submitted" — o
 *  harvest+derive é do poller S4). Senão ⇒ SÍNCRONO (extractWorthyUnitsSync, M15 intacto), "sync_done".
 *  Fail-safe síncrono (ADR-010): na dúvida, NÃO regride. O conjunto worthy é IDÊNTICO nos dois (selectWorthy). */
async function extractWorthyUnits(
  job: IngestJob,
  pages: PageRow[],
  report: (f: number, m: string) => Promise<void>,
  source?: SourceRow, // M21 — fonte do job (já resolvida 1× em processBlobJob); ausente ⇒ sem contrato
): Promise<"sync_done" | "batch_submitted"> {
  // 1) GATING compartilhado (triagem M15 fatorada) — a DECISÃO do que é worthy é a MESMA no sync e no batch.
  const { worthyByPage, unitsWorthy } = await selectWorthy(job, pages, source);

  // 2) ROTEAMENTO (ADR-010): batch só se worthy>limiar E provider api E chave (shouldUseBatch é fail-safe).
  if (await shouldUseBatch(job.brain, unitsWorthy)) {
    const { requests, customMap } = await buildBatchRequests(job.brain, worthyByPage);
    // borda defensiva: 0 requests (nenhuma worthy sobreviveu) → cai pro síncrono (no-op rápido).
    if (requests.length === 0) {
      await extractWorthyUnitsSync(job, worthyByPage, report, source);
      return "sync_done";
    }
    const handle = await submitExtractionBatch(requests);
    await markJobBatchSubmitted(job.id, handle.id, customMap); // S2 — RESUMÍVEL via batch_id persistido
    await report(0.55, `digestão em lote enviada (${requests.length} chamadas)…`);
    return "batch_submitted"; // ← processBlobJob RETORNA sem derivar (harvest do S4 re-resolve a fonte
    // pelo batch_id e aplica o MESMO applyRecipeGate antes do putExtraction — LEI II preservada)
  }

  // 3) FALLBACK SÍNCRONO (M15 intacto).
  await extractWorthyUnitsSync(job, worthyByPage, report, source);
  return "sync_done";
}

function sha16(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

function resumo(novos: number, pendentes: number, total: number, noun: string): string {
  // P0-C/C3b — re-claim pós-crash: nada novo, mas havia digestão pendente (capturado-mas-nunca-extraído).
  if (novos <= 0 && pendentes > 0) {
    return `Esse ${noun} já estava no cérebro — retomei a digestão pendente (${pendentes} ${pendentes === 1 ? "parte" : "partes"}).`;
  }
  if (novos <= 0) return `Esse ${noun} já estava no cérebro — não dupliquei.`;
  const partes = total > 1 ? ` (${total} partes)` : "";
  return `Entrou ${noun}${partes} no cérebro. Já dá pra perguntar sobre ${
    noun === "conversa" ? "ela" : "ele"
  }.`;
}

/** M16/S3 — mensagem do CAMINHO BATCH (ADR-010): o cérebro já está ENCONTRÁVEL (Fase A), mas os FATOS
 *  estruturados entram em minutos (o lote é assíncrono). O job fica `batch_submitted`; o poller (S4) fecha. */
function resumoBatch(novos: number, pendentes: number, total: number, noun: string): string {
  // P0-C/C3b — re-claim pós-crash: retomada da digestão pendente (mesmo espírito do síncrono).
  if (novos <= 0 && pendentes > 0) {
    return `Esse ${noun} já estava no cérebro — retomei a digestão pendente (${pendentes} ${pendentes === 1 ? "parte" : "partes"}).`;
  }
  if (novos <= 0) return `Esse ${noun} já estava no cérebro — não dupliquei.`;
  const partes = total > 1 ? ` (${total} partes)` : "";
  return `Entrou ${noun}${partes} no cérebro e já dá pra buscar. A digestão dos fatos foi pra um lote — eles entram em minutos.`;
}

/** P0-C — re-digere (Fase B) páginas capturadas que nunca foram extraídas (extract_version='').
 *  SEMPRE síncrona (nunca submete lote: o reparo não tem job pra carregar batch_id — decisão §1).
 *  Agrupa por fonte (tag `src:<id>`): fonte inexistente ou pausada → PULA o grupo com log (fail-
 *  closed, espelho do processBlobJob); sem tag src: → sem contrato (pass-through, igual hoje).
 *  Páginas com 0 units worthy são marcadas extraídas (markExtracted) pra varredura não re-visitar
 *  eternamente — a verdade pós-triagem é "lida, nada digno de LLM". Tenant-neutro, zero ramo de
 *  formato (reusa selectWorthy/extractWorthyUnitsSync — a decisão worthy é a MESMA do pipeline). */
export async function digestPendingPages(
  brain: string,
  slugs: string[],
): Promise<{ digested: number; skipped: number }> {
  const e = await getEngine(brain);
  const reportNoop = async () => {};

  // 1) carrega as PageRow (pula slug inexistente; a query de detecção do §6 já filtra archived).
  const pages: PageRow[] = [];
  for (const slug of slugs) {
    const p = await e.getPage(slug);
    if (p) pages.push(p);
  }
  if (!pages.length) return { digested: 0, skipped: 0 };

  // 2) agrupa por sourceId = tag `src:<id>` (primeira que casar; ausente = undefined).
  const groups = new Map<string | undefined, PageRow[]>();
  for (const page of pages) {
    const srcTag = (page.tags ?? []).find((t) => t.startsWith("src:"));
    const sourceId = srcTag ? srcTag.slice("src:".length) : undefined;
    const arr = groups.get(sourceId) ?? [];
    arr.push(page);
    groups.set(sourceId, arr);
  }

  let digested = 0;
  let skipped = 0;

  for (const [sourceId, groupPages] of groups) {
    try {
      // 3) resolve a fonte (fail-closed: inexistente/pausada → pula o grupo, espelho do processBlobJob).
      const source = sourceId ? await e.getSource(sourceId) : undefined;
      if (sourceId && !source) {
        console.log(`[repair] fonte da página não existe mais — pulando ${groupPages.length} página(s)`);
        skipped += groupPages.length;
        continue;
      }
      if (source && source.status === "pausada") {
        console.log(`[repair] fonte "${source.name}" pausada — pulando ${groupPages.length} página(s)`);
        skipped += groupPages.length;
        continue;
      }

      // 4) job SINTÉTICO (literal IngestJob completo — campos não usados com defaults neutros). kind por
      //    tag `fonte:paste` (texto colado) vs upload (arquivo). Status digesting (Fase B).
      const isPaste = groupPages.some((p) => (p.tags ?? []).includes("fonte:paste"));
      const jobSintetico: IngestJob = {
        id: `repair:${brain}`,
        brain,
        kind: isPaste ? "text" : "file",
        status: "digesting",
        type: groupPages[0]?.type ?? "",
        contentHash: null,
        filename: null,
        mime: null,
        title: null,
        jobDate: null,
        textBody: null,
        progress: 0,
        message: null,
        resultJson: {},
        errorMessage: null,
        createdAt: "",
        startedAt: null,
        finishedAt: null,
        batchId: null,
        batchStatus: null,
        batchCustomMap: null,
        sourceId: sourceId ?? null,
        leaseUntil: null,
        attempts: 0,
      };

      // 5) GATING compartilhado (a MESMA decisão worthy do pipeline) → digestão SÍNCRONA SÓ no worthy.
      const { worthyByPage } = await selectWorthy(jobSintetico, groupPages, source);
      await extractWorthyUnitsSync(jobSintetico, worthyByPage, reportNoop, source);

      // 6) páginas SEM worthy: marca extraídas (verdade pós-triagem) pra varredura não re-visitar eternamente.
      const worthySlugs = new Set(worthyByPage.map((w) => w.page.slug));
      const semWorthy = groupPages.filter((p) => !worthySlugs.has(p.slug));
      if (semWorthy.length) {
        const v = await freshVersion(brain);
        for (const p of semWorthy) await e.markExtracted(p.slug, v);
      }

      // 7) deriveIncremental só dos slugs que entraram em worthyByPage (têm extração).
      const derivados = [...worthySlugs];
      if (derivados.length) await deriveIncremental(brain, derivados);

      digested += groupPages.length;
    } catch (err) {
      // 8) erro num grupo NÃO derruba o worker: loga e segue (o que falhou fica pendente pra próxima varredura).
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[repair] grupo falhou (fonte ${sourceId ?? "-"}): ${msg}`);
      skipped += groupPages.length;
    }
  }

  return { digested, skipped };
}
