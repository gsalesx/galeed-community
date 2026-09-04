/** M16/S3 — BATCH-EXTRACT: roteamento sync↔batch + montagem do lote + harvest (ADR-010).
 *
 *  O cérebro do M16. Decide se um job grande vai pra Message Batches API (assíncrono, ~50% mais barato,
 *  fora do rate-limit síncrono) em vez da maratona síncrona de chamadas. NÃO muda a EXTRAÇÃO — só a
 *  ENTREGA das chamadas. A LEI II (equivalência) é garantida ESTRUTURALMENTE: o request do lote usa a
 *  MESMA `buildMessagesBody` que `toolCall`/`extractUnit` montam (params byte-idênticos), e o harvest
 *  parseia com a MESMA `parseToolUse` + o MESMO merge por dim de `extractOne`. Tenant-neutro, fail-safe
 *  síncrono (na dúvida, NÃO regride o comportamento M15).
 *
 *  Fluxo: shouldUseBatch? → buildBatchRequests → submitExtractionBatch → markJobBatchSubmitted (S2) → o
 *  job fica `batch_submitted` e o processBlobJob RETORNA (NÃO deriva). O poller (S4) recupera + persiste +
 *  deriva depois via harvestExtractionBatch. O `deriveIncremental` (M14) roda no HARVEST, não no submit. */
import { config } from "../platform/config.ts";
import { resolveProvider } from "../../lib/llm.ts";
import { hasKey, buildMessagesBody, parseToolUse } from "../../lib/anthropic.ts";
import { costUsd } from "../../lib/pricing.ts"; // M20 — custo do lote (50% do síncrono)
import { recordUsage } from "../platform/usage.ts"; // M20
import { UNTRUSTED_SYS, wrapUntrusted } from "../../lib/prompt-safety.ts";
import { loadSchemaPackAsync } from "../extraction/schema-pack.ts";
import {
  buildExtractionContext,
  freshVersion,
  stampUnitDate, // P0-A — MESMO carimbo do sync, aplicado no harvest do batch
  type ExtractionContext,
  type ExtractionUnit,
} from "../extraction/extract.ts";
import {
  submitBatch,
  getBatchResults,
  type BatchRequest,
  type BatchHandle,
} from "../../lib/batch-client.ts";
import { deriveIncremental } from "../retrieval/indexer.ts";
import { getEngine, type PageRow } from "../platform/engine.ts";
// M21/S2 — a REGRA DE OURO no harvest: o MESMO applyRecipeGate do caminho síncrono roda antes do
// putExtraction (sync↔batch equivalentes, LEI II). A fonte vem do JOB dono do lote, resolvido pelo
// batch_id (getJobByBatchId) — a assinatura pública de harvestExtractionBatch NÃO muda.
import { applyRecipeGate, addReviewItemsAndNotify } from "./golden-rule.ts";
import { getJobByBatchId, markJobError } from "./ingest-queue.ts";

// =====================================================================================================
// 1a. ROTEAMENTO (limiar + fail-safe) — ADR-010 §1
// =====================================================================================================

/** Default §9b do brief: > 50 units worthy ⇒ batch. */
export const DEFAULT_BATCH_THRESHOLD = 50;

/** Resolve o limiar de roteamento: config DB-native (pack.batch?.threshold, ADR-007) > env
 *  GALEED_BATCH_THRESHOLD > DEFAULT_BATCH_THRESHOLD. Parsing defensivo (NaN/≤0 → próximo nível). NUNCA
 *  lança (fail-open). Tenant-neutro: zero conhecimento de formato/canal. */
export async function resolveBatchThreshold(home: string): Promise<number> {
  // 1) DB-native (opcional, aditivo ao pack — SEM migração; vive no pack_json). Ausente ⇒ próximo nível.
  try {
    const pack = await loadSchemaPackAsync(home);
    const t = (pack as any)?.batch?.threshold;
    if (typeof t === "number" && Number.isFinite(t) && t > 0) return t;
  } catch {
    /* fail-open → env/default */
  }
  // 2) env GALEED_BATCH_THRESHOLD.
  const env = Number(process.env.GALEED_BATCH_THRESHOLD);
  if (Number.isFinite(env) && env > 0) return env;
  // 3) DEFAULT.
  return DEFAULT_BATCH_THRESHOLD;
}

/** Decide sync vs batch. true SÓ se: worthyCount > threshold E provider==="api" E hasKey() E não-disabled.
 *  Fail-safe SÍNCRONO em qualquer outro caso (provider cli, sem chave, sem config, GALEED_BATCH_DISABLE=1).
 *  Tenant-neutro: zero `if (canal === ...)`. A Batch API só existe no caminho HTTP/api (ADR-010 §1). */
export async function shouldUseBatch(home: string, worthyCount: number): Promise<boolean> {
  if (process.env.GALEED_BATCH_DISABLE === "1") return false; // escape-hatch explícito → síncrono
  if (!hasKey()) return false; // sem ANTHROPIC_API_KEY ⇒ síncrono
  const provider = resolveProvider(config(home).provider);
  if (provider !== "api") return false; // Batch API só na versão assíncrona do endpoint HTTP
  const threshold = await resolveBatchThreshold(home);
  return worthyCount > threshold;
}

// =====================================================================================================
// 1b. MONTAGEM DOS REQUESTS (reusa o MESMO corpo de extractUnit — LEI II) — ADR-010 §2
// =====================================================================================================

/** custom_id RESUMÍVEL e único: `${slug}__${unitIdx}`, saneado p/ ^[a-zA-Z0-9_-]{1,64}$. O slug já é
 *  estável/curto (capture); se exceder 64 com o sufixo, trunca o slug e anexa um hash curto (colisão
 *  improvável; o customMap é a fonte de verdade do mapeamento → slug). Helper interno exportado p/ teste. */
export function makeCustomId(slug: string, unitIdx: number): string {
  // sanea o slug pro alfabeto do custom_id (^[a-zA-Z0-9_-]{1,64}$); qualquer outro char → '-'.
  const safeSlug = slug.replace(/[^a-zA-Z0-9_-]/g, "-");
  const suffix = `__${unitIdx}`;
  const id = `${safeSlug}${suffix}`;
  if (id.length <= 64) return id;
  // excede 64: trunca o slug e anexa um hash curto determinístico do slug original (mantém unicidade +
  // mapeabilidade — o customMap é quem mapeia custom_id→slug, mas o id precisa CASAR a regex e ser único).
  const hash = djb2(slug).toString(36).slice(0, 6); // ≤6 chars [0-9a-z]
  const room = 64 - suffix.length - 1 - hash.length; // 1 = o '-' separador
  const head = safeSlug.slice(0, Math.max(0, room));
  return `${head}-${hash}${suffix}`;
}

/** hash determinístico simples (djb2) — sem dep, só p/ desambiguar slugs longos no custom_id. */
function djb2(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h;
}

/** Compõe o prompt+system de UMA unit EXATAMENTE como `extractUnit` (extract.ts:170-178) faz. ESTA é a
 *  costura da LEI II: a única fonte da composição do prompt do lote é a MESMA de extractUnit. Se a
 *  composição de extractUnit mudar, ESTA tem que acompanhar — o gate deep-equal do S5 pega divergência. */
function composeUnitCall(ctx: ExtractionContext, unit: ExtractionUnit): { prompt: string; system: string } {
  const prompt = `${unit.header}${ctx.ctxBlock}${ctx.hintBlock}\n\n${wrapUntrusted(unit.body)}`;
  const system =
    "Você extrai conhecimento estruturado de negócios. Seja fiel ao texto; não invente. " + UNTRUSTED_SYS;
  return { prompt, system };
}

/** Monta 1 BatchRequest por unit worthy de CADA página. Reusa o ctx já computado 1×/página (sem recomputar)
 *  + a composição literal de extractUnit + buildMessagesBody (S1) → params byte-idênticos ao síncrono.
 *  Recebe SÓ páginas+units já filtradas como worthy (o gating de scoreSegment é do caller — selectWorthy
 *  compartilhado em process-blob-job, garantindo o MESMO conjunto worthy no sync e no batch). Devolve
 *  {requests, customMap} (customMap: custom_id → page.slug) p/ markJobBatchSubmitted (S2).
 *
 *  P0-A: o customMap também carrega, sob a chave ADITIVA `d:<custom_id>`, a `unit.date` determinística
 *  (quando não-vazia). O harvest a lê e carimba o claim (stampUnitDate) — transporte da data da unit até
 *  o fato sem mudança de schema/fila. `custom_id` casa ^[a-zA-Z0-9_-]{1,64}$ (nunca contém ":") → as
 *  chaves `d:` jamais colidem com os mapeamentos custom_id→slug. */
export async function buildBatchRequests(
  home: string,
  worthyByPage: { page: PageRow; ctx: ExtractionContext; units: ExtractionUnit[] }[],
): Promise<{ requests: BatchRequest[]; customMap: Record<string, string> }> {
  const requests: BatchRequest[] = [];
  const customMap: Record<string, string> = {};
  for (const { page, ctx, units } of worthyByPage) {
    units.forEach((unit, i) => {
      const { prompt, system } = composeUnitCall(ctx, unit); // ← MESMA composição que extractUnit
      const params = buildMessagesBody(ctx.model, prompt, ctx.tool, system); // ← MESMA fonte que toolCall
      const custom_id = makeCustomId(page.slug, i);
      requests.push({ custom_id, params });
      customMap[custom_id] = page.slug;
      // P0-A — a data determinística da unit viaja no MESMO customMap, sob a chave aditiva `d:<custom_id>`
      // (custom_id casa ^[a-zA-Z0-9_-]{1,64}$ → nunca contém ":", sem colisão com os mapeamentos de slug).
      // O harvest a lê e carimba o claim com o MESMO stampUnitDate do sync (equivalência sync↔batch).
      if (unit.date) customMap[`d:${custom_id}`] = unit.date;
    });
  }
  return { requests, customMap };
}

// =====================================================================================================
// 1c. SUBMIT + HARVEST — ADR-010 §3/§4
// =====================================================================================================

/** Submete o lote (S1.submitBatch) e devolve o BatchHandle. NÃO faz poll (é do S4). O caller (process-blob-job)
 *  grava via markJobBatchSubmitted (S2) e transiciona pra batch_submitted. */
export async function submitExtractionBatch(requests: BatchRequest[]): Promise<BatchHandle> {
  return submitBatch(requests);
}

/** Extrai o `unitIdx` do custom_id (`${slug}__${idx}`). O idx é o sufixo após o ÚLTIMO `__`. Devolve um
 *  número grande se não casar (ordena no fim — defensivo). Necessário p/ ordenar os outs por unitIdx
 *  ANTES do merge (DESIGN-SPEC §1c: garante a MESMA ordem de claims que o síncrono → deep-equal S5). */
function unitIdxFromCustomId(customId: string): number {
  const m = customId.match(/__(\d+)$/);
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
}

/** Lote ended: recupera resultados (S1.getBatchResults), agrupa por slug via customMap (casar SEMPRE por
 *  custom_id — ordem do JSONL não garantida), parseia cada succeeded com parseToolUse (S1 — MESMA lógica
 *  do toolCall), ordena por unitIdx, faz o MESMO merge por dim que extractOne, putExtraction/markExtracted
 *  por página, e deriveIncremental (M14) nos slugs tocados. errored/expired/canceled: loga e segue (LEI —
 *  erro parcial não derruba). Idempotente por (brain, content_hash) via putExtraction/markExtracted.
 *
 *  P0-A: cada `out` parseado é carimbado com stampUnitDate(out, customMap["d:"+custom_id] ?? "") — o MESMO
 *  carimbo do sync (extractUnit), lendo a data da unit que viajou no customMap. Job em voo submetido ANTES
 *  do merge não tem chaves `d:` → "" → no-op (retrocompat, fail-soft).
 *
 *  P1-C (A7a, FAIL-CLOSED): job COM contrato (sourceId) cuja fonte sumiu/pausou entre submit e harvest →
 *  markJobError + throw ANTES de getBatchResults; NADA persistido (espelho do caminho síncrono). Lote sem
 *  job conhecido ou job sem sourceId ⇒ pass-through INALTERADO.
 *  P1-C (A7b, frescor parcial): página com unit errored/truncada é PARCIAL — persiste o que chegou mas o
 *  prompt_version ganha '+parcial' e markExtracted NÃO roda (extract_version segue '' ⇒ a retomada de
 *  Fase B do P0-C re-extrai a página inteira depois, sem duplicar). */
export async function harvestExtractionBatch(
  home: string,
  handle: BatchHandle,
  customMap: Record<string, string>,
): Promise<{ harvested: number; errored: number }> {
  const e = await getEngine(home);
  // M21/S2 — fonte do job dono do lote, resolvida 1× no início do harvest (DESIGN-SPEC §6). Lote sem
  // job conhecido (handle de teste/job limpo) ou job sem sourceId ⇒ source=undefined ⇒ gate pass-through
  // (byte-idêntico ao M16/M20).
  const job = await getJobByBatchId(handle.id);
  const source = job?.sourceId ? await e.getSource(job.sourceId) : undefined;
  // P1-C (mata A7a): job COM contrato (sourceId) cuja fonte sumiu/pausou entre o submit e o
  // harvest → FAIL-CLOSED, espelho do caminho síncrono (process-blob-job.ts: "fonte do job não
  // existe mais." / fonte pausada). NADA é persistido; o job vira 'error' legível (markJobError)
  // e sai do claim do poller (claimPollableBatches só pega batch_submitted/batch_harvesting) —
  // retentável pelo usuário (re-enviar após restaurar a fonte; idempotência por content_hash).
  // Lote SEM job conhecido (handle de teste/job limpo) ⇒ comportamento INALTERADO (pass-through).
  if (job?.sourceId && !source) {
    const msg = "fonte do job não existe mais — a digestão do lote foi bloqueada pelo contrato.";
    await markJobError(job.id, msg);
    throw new Error(msg);
  }
  if (job && source && source.status === "pausada") {
    const msg = `a fonte "${source.name}" está pausada — retome a leitura pra digerir o lote.`;
    await markJobError(job.id, msg);
    throw new Error(msg);
  }
  const lines = await getBatchResults(handle);

  // 1) agrupa as linhas succeeded por slug, guardando o unitIdx p/ ordenar depois (casar por custom_id).
  const bySlug = new Map<string, { idx: number; out: Record<string, any[]> }[]>();
  let errored = 0;
  const failedSlugs = new Set<string>(); // P1-C (A7b): páginas com unit perdida — frescor NÃO sela
  for (const line of lines) {
    const slug = customMap[line.custom_id];
    if (!slug) {
      // custom_id órfão (não está no mapa) — loga e segue (defensivo; não deveria acontecer).
      console.log(`[batch-harvest-orphan] brain=${home} custom_id=${line.custom_id}`);
      continue;
    }
    if (line.result.type === "succeeded") {
      // M20: custo do lote = 50% do síncrono (Batch API), com a usage REAL do message. Registra mesmo
      // que o parse do tool_use falhe abaixo — a chamada foi cobrada. Fail-soft.
      const msg: any = line.result.message;
      const u = msg?.usage || {};
      const bModel = msg?.model || "";
      const tIn = u.input_tokens ?? 0, tOut = u.output_tokens ?? 0;
      const cR = u.cache_read_input_tokens ?? 0, cW = u.cache_creation_input_tokens ?? 0;
      void recordUsage(home, {
        op: "extract:batch",
        provider: "api",
        model: bModel,
        tokensIn: tIn,
        tokensOut: tOut,
        cacheRead: cR,
        cacheWrite: cW,
        costUsdReported: costUsd(bModel, { tokensIn: tIn, tokensOut: tOut, cacheRead: cR, cacheWrite: cW }) * 0.5,
        meta: { slug, batch: true },
      });
      try {
        const out = parseToolUse<Record<string, any[]>>(line.result.message); // ← input do tool_use
        // P0-A — carimba a data da unit (mesmo stampUnitDate do sync). A data viaja no customMap sob
        // `d:<custom_id>`; ausente (job em voo pré-merge) → "" → no-op (retrocompat, sem erro).
        stampUnitDate(out, customMap[`d:${line.custom_id}`] ?? "");
        const arr = bySlug.get(slug) ?? [];
        arr.push({ idx: unitIdxFromCustomId(line.custom_id), out });
        bySlug.set(slug, arr);
      } catch {
        // tool_use ausente/truncado (max_tokens) → conta como erro parcial; não derruba o lote.
        errored++;
        failedSlugs.add(slug); // P1-C (A7b): unit perdida → a página é PARCIAL, frescor não sela
        console.log(`[batch-harvest-parse] brain=${home} custom_id=${line.custom_id} (tool_use ausente/truncado)`);
      }
    } else {
      errored++;
      failedSlugs.add(slug); // P1-C (A7b): unit errored/expired → página PARCIAL, frescor não sela
      console.log(`[batch-harvest-error] brain=${home} custom_id=${line.custom_id} type=${line.result.type}`);
    }
  }

  // 2) por página: merge por dim IDÊNTICO ao extractOne, putExtraction + markExtracted.
  const versionTag = await freshVersion(home);
  const touchedSlugs: string[] = [];
  for (const [slug, entries] of bySlug) {
    const page = await e.getPage(slug);
    if (!page) continue; // página sumiu (defensivo)
    const ctx = await buildExtractionContext(home, page); // só p/ saber as dims do merge
    // ordena por unitIdx ANTES do merge → MESMA ordem de claims do síncrono (buildExtractionUnits).
    entries.sort((a, b) => a.idx - b.idx);
    const merged: Record<string, any[]> = {};
    for (const d of ctx.dims) merged[d] = [];
    const lastDate = page.date || "";
    for (const { out } of entries)
      for (const d of ctx.dims) if (Array.isArray(out[d])) merged[d].push(...out[d]);
    // M21/S2 — o MESMO gate do caminho síncrono, antes do putExtraction (LEI II: sync↔batch equivalentes).
    // Ids de rejeitado são DETERMINÍSTICOS (sha256 por conteúdo) ⇒ re-harvest não duplica a fila
    // (addReviewItems é on-conflict-do-nothing por id).
    const gate = applyRecipeGate(merged, source?.recipe ?? null, source?.id ?? "", page.slug, page.body);
    // C2 — review.pending (mesmo gancho do caminho síncrono; LEI II sync↔batch). Fail-soft.
    if (gate.rejected.length) await addReviewItemsAndNotify(home, gate.rejected);
    console.log(
      `[recipe-gate] brain=${home} page=${page.slug} approved=${gate.counts.approved} ` +
        `rejected=${gate.counts.rejected} source=${source?.id ?? "-"}`,
    );
    // P1-C (mata A7b): página com unit errored/truncada é PARCIAL — persiste o que chegou (os
    // claims aprovados derivam JÁ), mas NÃO sela o frescor: prompt_version ganha o sufixo
    // '+parcial' (isFresh=false — difere de freshVersion) e markExtracted NÃO roda
    // (extract_version segue '' ⇒ a retomada de Fase B do P0-C — digestPendingPages na varredura
    // do worker e o caminho 'pendentes' do re-upload — re-extrai a página inteira depois,
    // REUSANDO o mecanismo existente, sem duplicar). Página com TODAS as units perdidas nem
    // entra em bySlug — já era re-extraível (extract_version='') e segue assim.
    const parcial = failedSlugs.has(slug);
    await e.putExtraction({
      source_slug: page.slug,
      type: page.type,
      date: lastDate,
      content_hash: page.content_hash || "",
      prompt_version: parcial ? `${versionTag}+parcial` : versionTag,
      extractions: gate.approved,
    });
    if (parcial) {
      console.log(`[batch-harvest-partial] brain=${home} page=${page.slug} units perdidas → frescor NÃO selado (re-extraível pela varredura P0-C)`);
    } else {
      await e.markExtracted(page.slug, versionTag);
    }
    touchedSlugs.push(slug);
  }

  // 3) deriveIncremental (M14) nos slugs tocados — MESMO write-path do síncrono.
  if (touchedSlugs.length) await deriveIncremental(home, touchedSlugs);
  return { harvested: touchedSlugs.length, errored };
}
