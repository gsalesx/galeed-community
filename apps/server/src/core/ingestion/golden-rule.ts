/** M21 — REGRA DE OURO da ingestão com contrato: o que a receita reconhece E ancora vira fato
 *  carimbado; o que não casa vira hipótese na fila de revisão — nunca fato sozinho, nunca descarte
 *  silencioso (invariante #5). PURO no gate; IO só em approve/discard. Tenant-neutro: receita é DADO
 *  (zero ramo por canal/formato — invariante III). Ver ADR-016. */
import { createHash } from "node:crypto";
import { quoteIsGrounded } from "../../lib/quote-check.ts";
import { valueIsAnchored, textValueIsAnchored } from "../../lib/value-anchor.ts";
import { entityIsVague } from "../../lib/vague-entity.ts";
import {
  getEngine,
  type SourceRecipe,
  type ReviewItemRow,
  type ReviewReason,
} from "../platform/engine.ts";
import { deriveIncremental } from "../retrieval/indexer.ts";
import { freshVersion } from "../extraction/extract.ts";
import { emitWebhookEvent } from "../platform/webhook-emit.ts"; // C2 — gancho review.pending (fail-soft)

export interface RecipeGateResult {
  approved: Record<string, any[]>; // claims que seguem pro putExtraction (com it.source_id injetado)
  rejected: ReviewItemRow[]; // status 'pendente', id determinístico (sha256 — ver reviewItemId)
  counts: { approved: number; rejected: number };
}

/** Id DETERMINÍSTICO do item de revisão: sha256(`${pageSlug}|${dim}|${quote}|${text}`).slice(0,32).
 *  DESIGN-SPEC §6: ids por conteúdo (não randomUUID) ⇒ re-harvest do batch (M16) re-posta o MESMO id e
 *  o `on conflict (brain,id) do nothing` do addReviewItems não duplica nem sobrescreve decisão. */
function reviewItemId(pageSlug: string, dim: string, quote: string, text: string): string {
  return createHash("sha256").update(`${pageSlug}|${dim}|${quote}|${text}`).digest("hex").slice(0, 32);
}

/** O gate. `recipe === null` (job sem fonte) ⇒ pass-through BYTE-IDÊNTICO (approved = o próprio merged,
 *  rejected=[]) — é assim que o golden M9 e todo o caminho sem fonte NÃO mudam. Com receita, o critério
 *  é OBJETIVO (DESIGN-SPEC §3): dimensão fora da receita → 'fora_da_receita'; claim com triple só passa
 *  quote+número ancorados na fonte (MESMOS quoteIsGrounded/valueIsAnchored do indexer); claim sem triple
 *  só passa com quote verbatim. Mais rígido que o motor DE PROPÓSITO: sob contrato, triple não-ancorado
 *  vai pra FILA (hoje viraria fato 'nao-verificado' direto). PURA — sem IO/env/clock. */
export function applyRecipeGate(
  merged: Record<string, any[]>,
  recipe: SourceRecipe | null,
  sourceId: string,
  pageSlug: string,
  pageBody: string,
): RecipeGateResult {
  // MODO LIVRE = sem receita OU receita SEM fields. Fonte auto-criada por ingestor (WhatsApp,
  // reuniões, chat…) nasce com fields:[] — "a receita pode ser criada depois na tela Fontes".
  // Antes, fields:[] engatava o gate com allowlist VAZIA e rejeitava 100% da extração pra fila
  // de revisão (baseline D: approved=0 rejected=17 numa call estratégica) — beco silencioso.
  // A receita só gateia quando DEFINE dimensões.
  if (recipe === null || recipe.fields.length === 0) {
    const total = Object.values(merged).reduce(
      (n, arr) => n + (Array.isArray(arr) ? arr.length : 0),
      0,
    );
    return { approved: merged, rejected: [], counts: { approved: total, rejected: 0 } };
  }

  const fields = new Set(recipe.fields.map((f) => f.dimension));
  const approved: Record<string, any[]> = {};
  for (const dim of Object.keys(merged)) approved[dim] = []; // mesmo shape do merged (dims preservadas)
  const rejected: ReviewItemRow[] = [];
  let nApproved = 0;

  for (const [dim, arr] of Object.entries(merged)) {
    if (!Array.isArray(arr)) continue;
    for (const it of arr) {
      // MESMA leitura de campos do derivePageFacts (indexer) — uma única semântica de claim no sistema.
      const quote = String(it?.context_quote || it?.quote || "");
      const entity = String(it?.entity || "").toLowerCase().trim();
      const predicate = String(it?.predicate || "").toLowerCase().trim().replace(/\s+/g, "_");
      const hasTriple = !!(entity && predicate);
      const value = String(it?.value ?? "").trim();
      const value_num =
        typeof it?.value_num === "number" && Number.isFinite(it.value_num) ? it.value_num : null;
      const grounded = quoteIsGrounded(quote, pageBody); // MESMA função do indexer (R4)
      const numAnchored = valueIsAnchored(value, value_num, pageBody); // MESMA função do indexer (S3/M9)

      let reason: ReviewReason | null;
      // ── CADEIA DE GATES (M23-B — ORDEM CRAVADA, motivo mais ESPECÍFICO primeiro): ──
      //   1. fora_da_receita       — a DIMENSÃO não está no contrato (independe do claim;
      //                              é o motivo certo mesmo se o claim também for vago/solto)
      //   2. entidade_vaga         — o claim não tem DONO claro (LEI II do M23): sem dono,
      //                              discutir ancoragem é inútil — a mensagem pro revisor é
      //                              "diga de quem é", não "a citação não confere"
      //   3. nao_ancorado (C4)     — triple não-numérico sem quote = evidência NENHUMA
      //   4. nao_ancorado (âncora) — evidência presente mas NÃO confere com a fonte
      // Mexer na ordem MUDA o motivo que o humano lê na fila Revisar — editar ESTE bloco e
      // o espelho no indexer (derivePageFacts) JUNTOS (disciplina do C4/fix-1 a695ee7).
      if (!fields.has(dim)) reason = "fora_da_receita";
      // M23-B/LEI II — espelho do indexer SEM a exceção review='aprovada' (aqui o claim é
      // PRÉ-decisão; o marcador só nasce no approveReviewItem). MESMO entityIsVague (lib
      // compartilhada, padrão quoteIsGrounded/valueIsAnchored). Sob contrato é mais RÍGIDO
      // que o motor de propósito (como o C4): vago vai pra FILA, não pra 'nao-verificado'.
      else if (hasTriple && entityIsVague(entity)) reason = "entidade_vaga";
      // P1-C (mata C4, lado gate): triple NÃO-numérico SEM context_quote E sem o value verbatim no
      // body NUNCA vira fato sob contrato — vai pra fila como hipótese. PREDICADO CANÔNICO do P1-A
      // (indexer.ts), espelhado EXPRESSÃO-A-EXPRESSÃO (fix-1 do reconcile P1):
      // `value_num === null && quote === "" && !textValueIsAnchored(value, body)`.
      // value_num 0 É numérico e segue pro ramo de ancoragem (linha abaixo), igual ao indexer.
      // textValueIsAnchored (achado criacao-de-fatos #5) fecha o viés numérico residual: valor
      // TEXTUAL presente literal no body ancora como o número ancora (mesma evidência, mesma barra).
      // Duplicação consciente de 3 linhas (gate puro, sem import do indexer); mudou lá, muda AQUI
      // JUNTO (P1-A-DESIGN-SPEC §1.3).
      else if (hasTriple && value_num === null && quote === "" && !textValueIsAnchored(value, pageBody))
        reason = "nao_ancorado";
      else if (hasTriple) reason = grounded && numAnchored ? null : "nao_ancorado";
      else reason = quote && grounded ? null : "nao_ancorado";

      if (reason === null) {
        approved[dim].push({ ...it, source_id: sourceId }); // carimbo viaja no meta do claim
        nApproved++;
      } else {
        const text = String(it?.text || "");
        rejected.push({
          id: reviewItemId(pageSlug, dim, quote, text),
          source_id: sourceId,
          source_slug: pageSlug,
          dimension: dim,
          text,
          quote,
          claim: it,
          reason,
          status: "pendente",
          decided_by: "",
          decided_at: null,
        });
      }
    }
  }

  return { approved, rejected, counts: { approved: nApproved, rejected: rejected.length } };
}

/** Receita → texto de orientação pro prompt (determinístico, sem LLM). "" se receita null OU vazia
 *  (sem fields e sem guidance) ⇒ prompt IDÊNTICO ao atual. */
export function recipeGuidance(recipe: SourceRecipe | null): string {
  if (!recipe) return "";
  const fields = Array.isArray(recipe.fields) ? recipe.fields : [];
  if (!fields.length && !recipe.guidance) return "";
  return (
    "\n\nRECEITA DESTA FONTE (contrato do tenant — priorize estes campos):\n" +
    fields
      .map((f) => `- ${f.dimension}: ${f.label}${f.area ? ` (área destino: ${f.area})` : ""}`)
      .join("\n") +
    (recipe.guidance ? `\n${recipe.guidance}` : "")
  );
}

/** C2 — GANCHO review.pending: adiciona itens à fila de revisão (status pendente) E emite o evento
 *  `review.pending` AGREGADO por reason. É a porta única do caminho de ingestão sob contrato (todos os
 *  sites que hoje fazem `e.addReviewItems(gate.rejected)` passam a chamar ISTO). O addReviewItems do
 *  engine continua storage PURO (on-conflict-do-nothing); a notificação fica AQUI, na regra de ouro.
 *
 *  FAIL-SOFT (igual recordUsage): a emissão NUNCA derruba a ingestão — emitWebhookEvent já é fail-soft e
 *  o try é cinto-e-suspensório (agregar/montar payload não pode lançar). Itens vazios = no-op total.
 *  Payload: { items: nº, by_reason: { <reason>: nº, … }, at } — agrega por reason do LOTE (DESIGN-SPEC).
 *  Idempotência: addReviewItems é on-conflict-do-nothing, mas o webhook é por CHAMADA (re-harvest do
 *  mesmo lote re-notifica — aceitável: o evento é "há itens pendentes", não "estes ids são novos"). */
export async function addReviewItemsAndNotify(home: string, items: ReviewItemRow[]): Promise<void> {
  if (!items.length) return;
  const e = await getEngine(home);
  await e.addReviewItems(items); // storage puro (inalterado): on conflict (brain,id) do nothing
  try {
    const byReason: Record<string, number> = {};
    for (const it of items) {
      const r = String(it.reason || "desconhecido");
      byReason[r] = (byReason[r] ?? 0) + 1;
    }
    await emitWebhookEvent(home, "review.pending", {
      items: items.length,
      by_reason: byReason,
      at: new Date().toISOString(),
    });
  } catch (err) {
    console.error(
      `[golden-rule] gancho review.pending falhou (fail-soft) brain=${home}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

/** Aprovar: ATÔMICO NO EFEITO e IDEMPOTENTE (P1-C, mata A8b). GATEADO por ancoragem determinística
 *  como o lote (gateClaimAnchoring, achado criacao-de-fatos #4): claim que nasceria 'nao-verificado'
 *  NÃO é aprovado às cegas — lança com o porquê legível em vez do meio-termo silencioso (aprovação
 *  que não produz efeito visível). Ordem crash-safe: (0) gate, (1) o claim entra na extração com
 *  marcador `review_id` (re-execução não duplica — o append checa o id), (2) deriva, (3) CAS do
 *  status (setReviewStatus é one-shot no engine: WHERE status='pendente'). Aprovar 2× = no-op
 *  silencioso. A DURABILIDADE contra re-extração/putExtraction é do trigger
 *  galeed_extractions_keep_approved (migração 27). Nota epistêmica inalterada: o status do fato sai
 *  do MOTOR (derivePageFacts) — aprovação humana não inventa ancoragem (só resolve o referente vago). */
export async function approveReviewItem(home: string, id: string, decidedBy: string): Promise<void> {
  const e = await getEngine(home);
  const item = await e.getReviewItem(id);
  if (!item) throw new Error("item de revisão não encontrado.");
  if (item.status === "aprovada") return; // idempotente: aprovar 2× = no-op
  if (item.status !== "pendente") throw new Error("este item já foi decidido.");

  // ── M24-B/LEI III: hipótese do SONHO nunca vira fato. ─────────────────────────────────
  // Aprovar = registrar a decisão (CAS one-shot); a ARESTA tipada materializa no entityGraph
  // (postgres.ts lê os 'conexao_sugerida' aprovados — a fila é a fonte DURÁVEL, invariante #5,
  // e sobrevive a resetIndex/replaceDerived). NADA de extração/derive aqui: o caminho
  // claim→extração→fato abaixo é EXCLUSIVO da ingestão (M21/M23-B).
  if (item.reason === "conexao_sugerida") {
    await e.setReviewStatus(id, "aprovada", decidedBy);
    return;
  }

  // ── Achado criacao-de-fatos #4 (aprovação morta): o caminho UNITÁRIO gateia como o LOTE (M25-A).
  // Sem isto, aprovar claim sem evidência cunhava fato 'nao-verificado' 0.30 — fora de currentFacts
  // e da cadeia bitemporal — com toast de sucesso na tela Revisar: o dono aprovava e "nada
  // acontecia". Agora o gate DETERMINÍSTICO roda ANTES do append; retido ⇒ throw com o porquê
  // legível (LOTE_PORQUE.*) — o approveHypothesisHandler converte em 409 e o front já exibe
  // e.message. vaguezaResolvida=true: a decisão humana POR ITEM resolve o referente vago (exceção
  // review='aprovada' do indexer, M23-B teste 4); ancoragem NUNCA é dispensada (aprovação não
  // inventa âncora). Página sumida ⇒ body "" ⇒ nada ancora ⇒ erro (mesma política "nunca aprovação
  // às cegas" do lote). O fetch da página subiu pra cá — o ramo sem extração abaixo REUSA.
  const page = await e.getPage(item.source_slug);
  const porque = gateClaimAnchoring(item.claim, page?.body ?? "", { vaguezaResolvida: true });
  if (porque !== null) throw new Error(porque);

  const claim = { ...item.claim, source_id: item.source_id, review: "aprovada", review_id: item.id };
  const ex = await e.getExtraction(item.source_slug);
  if (ex) {
    ex.extractions = ex.extractions ?? {};
    const arr = Array.isArray(ex.extractions[item.dimension]) ? ex.extractions[item.dimension] : [];
    const jaTem = arr.some((c: any) => c && c.review_id === item.id); // retomada pós-crash: não duplica
    if (!jaTem) {
      ex.extractions[item.dimension] = [...arr, claim];
      await e.putExtraction(ex);
    }
  } else {
    await e.putExtraction({
      source_slug: item.source_slug,
      type: page?.type ?? "",
      date: page?.date ?? "",
      content_hash: page?.content_hash ?? "",
      prompt_version: await freshVersion(home),
      extractions: { [item.dimension]: [claim] },
    });
  }
  await deriveIncremental(home, [item.source_slug]); // M14 — write-path incremental, MESMO motor
  await e.setReviewStatus(id, "aprovada", decidedBy); // CAS one-shot (já é WHERE status='pendente')
}

/** Descartar registrado: só muda o status (a linha permanece legível — invariante #5). */
export async function discardReviewItem(home: string, id: string, decidedBy: string): Promise<void> {
  const e = await getEngine(home);
  const item = await e.getReviewItem(id);
  if (!item) throw new Error("item de revisão não encontrado.");
  if (item.status !== "pendente") throw new Error("este item já foi decidido.");
  await e.setReviewStatus(id, "descartada", decidedBy);
}

/** M25-A — limite do scan de pendentes das operações de lote/grupos. Fila maior que o limite =
 *  operação PARCIAL (documentado; repetir a ação pega o resto — idempotente). Default cobre 10×
 *  a fila real de hoje (1.086). */
export const REVIEW_SCAN_LIMIT = Math.max(
  1,
  Number(process.env.GALEED_REVIEW_SCAN_LIMIT || "") || 10000,
);

/** M25-A — porquês LEGÍVEIS do gate de lote (PT, cravados; o front exibe cru — o enum nunca
 *  aparece pro humano, invariante M11). */
export const LOTE_PORQUE = {
  entidade_vaga: "sem dono claro — a entidade é vaga (“ele”, “a empresa”…).",
  sem_evidencia: "sem evidência nenhuma — o claim não tem citação, nem número, nem o valor aparece no texto da página.",
  nao_ancorado: "a citação ou o número não confere com o texto original da página.",
} as const;

/** M25-A — gate DETERMINÍSTICO de ancoragem de um claim SALVO (a LEI: decisão humana é por
 *  LOTE, ancoragem é por ITEM). É a cadeia do applyRecipeGate SEM o passo 1 (fora_da_receita):
 *  a decisão de lote do humano É a resposta à pergunta da dimensão; vagueza/evidência/âncora
 *  NUNCA são dispensadas (nota epistêmica P1-C — aprovação não inventa âncora). MESMA leitura
 *  de campos do derivePageFacts/applyRecipeGate — uma única semântica de claim no sistema;
 *  mudou lá, muda AQUI JUNTO (disciplina C4/M23-B). PURA — sem IO/env/clock.
 *  `opts.vaguezaResolvida` (aprovação UNITÁRIA, achado criacao-de-fatos #4): a decisão humana POR
 *  ITEM é o resolvedor do referente vago (mesma exceção review='aprovada' do indexer/M23-B teste 4)
 *  → pula SÓ o passo entidade_vaga; a ancoragem continua mandando. O LOTE chama sem opts (a decisão
 *  de lote não olha item a item — assimetria deliberada do M25-A, comportamento intacto).
 *  Retorna null (passa) ou o porquê legível (retém). */
export function gateClaimAnchoring(
  claim: any,
  pageBody: string,
  opts: { vaguezaResolvida?: boolean } = {},
): string | null {
  const it = claim ?? {};
  const quote = String(it?.context_quote || it?.quote || "");
  const entity = String(it?.entity || "").toLowerCase().trim();
  const predicate = String(it?.predicate || "").toLowerCase().trim().replace(/\s+/g, "_");
  const hasTriple = !!(entity && predicate);
  const value = String(it?.value ?? "").trim();
  const value_num =
    typeof it?.value_num === "number" && Number.isFinite(it.value_num) ? it.value_num : null;
  const grounded = quoteIsGrounded(quote, pageBody);
  const numAnchored = valueIsAnchored(value, value_num, pageBody);

  // cadeia M23-B passos 2→4 (ordem CRAVADA — motivo mais específico primeiro):
  if (hasTriple && !opts.vaguezaResolvida && entityIsVague(entity)) return LOTE_PORQUE.entidade_vaga;
  // C4 espelhado (mudou no indexer/applyRecipeGate, muda AQUI JUNTO): valor textual verbatim no
  // body é evidência — achado criacao-de-fatos #5.
  if (hasTriple && value_num === null && quote === "" && !textValueIsAnchored(value, pageBody))
    return LOTE_PORQUE.sem_evidencia;
  if (hasTriple) return grounded && numAnchored ? null : LOTE_PORQUE.nao_ancorado;
  return quote && grounded ? null : LOTE_PORQUE.nao_ancorado;
}

export interface LoteRetido {
  id: string;
  porque: string; // LOTE_PORQUE.* — legível, vai cru pro front
}

export interface LoteAprovacao {
  aprovados: number;
  retidos: LoteRetido[];
  ja_decididos: number;      // idempotência VISÍVEL: id já decidido/inexistente = nada a fazer
  paginas_derivadas: number; // slugs distintos que entraram no deriveIncremental ÚNICO
}

/** M25-A — aprovar EM LOTE, gateado por ancoragem determinística (zero LLM). Atômico no efeito
 *  e idempotente (LEI, corolário 2): MESMA ordem crash-safe do approveReviewItem — (1) append
 *  na extração com marcadores {source_id, review:'aprovada', review_id} e dedupe por review_id,
 *  (2) deriveIncremental UMA VEZ com todos os slugs tocados, (3) CAS do status por item.
 *  Repetir = no-op (ids decididos contam em ja_decididos). reason='conexao_sugerida' segue o
 *  caminho M24-B (só registra a decisão — sem gate, sem extração, sem derive).
 *  NÃO substitui approveReviewItem (unitário, intacto) — soma a variante de lote. */
export async function approveReviewItemsLote(
  home: string,
  ids: string[],
  decidedBy: string,
): Promise<LoteAprovacao> {
  const zero: LoteAprovacao = { aprovados: 0, retidos: [], ja_decididos: 0, paginas_derivadas: 0 };
  if (!ids.length) return zero;
  const e = await getEngine(home);

  // 1) UM scan de pendentes (não N getReviewItem): Map por id; ausente = decidido/inexistente.
  const pendentes = await e.listReview({ status: "pendente", limit: REVIEW_SCAN_LIMIT });
  const byId = new Map(pendentes.map((it) => [it.id, it]));
  const itens: ReviewItemRow[] = [];
  let jaDecididos = 0;
  for (const id of new Set(ids)) {
    const it = byId.get(id);
    if (it) itens.push(it);
    else jaDecididos++;
  }
  if (!itens.length) return { ...zero, ja_decididos: jaDecididos };

  // 2) conexao_sugerida = caminho M24-B (aprovar REGISTRA a decisão; a aresta materializa na
  //    leitura do grafo) — sem gate de ancoragem, sem extração, sem derive.
  const conexoes = itens.filter((it) => it.reason === "conexao_sugerida");
  const claims = itens.filter((it) => it.reason !== "conexao_sugerida");

  // 3) gate por ITEM contra o body REAL — 1 query de páginas (pagesBySlug), não N getPage.
  //    Página sumida ⇒ body "" ⇒ nada ancora ⇒ retido (nunca aprovação às cegas).
  const slugs = [...new Set(claims.map((it) => it.source_slug))];
  const pageMap = await e.pagesBySlug(slugs);
  const retidos: LoteRetido[] = [];
  const passantes: ReviewItemRow[] = [];
  for (const it of claims) {
    const porque = gateClaimAnchoring(it.claim, pageMap.get(it.source_slug)?.body ?? "");
    if (porque === null) passantes.push(it);
    else retidos.push({ id: it.id, porque });
  }

  // 4) append por PÁGINA (1 getExtraction + 1 putExtraction por slug — não por item). MESMOS
  //    marcadores do approveReviewItem; dedupe por review_id (retomada pós-crash não duplica —
  //    padrão P1-C). A durabilidade contra re-extração é do trigger keep_approved (migração 27).
  const porSlug = new Map<string, ReviewItemRow[]>();
  for (const it of passantes) {
    const arr = porSlug.get(it.source_slug) ?? [];
    arr.push(it);
    porSlug.set(it.source_slug, arr);
  }
  const slugsTocados: string[] = [];
  for (const [slug, doSlug] of porSlug) {
    const ex = await e.getExtraction(slug);
    const page = pageMap.get(slug);
    const row = ex ?? {
      source_slug: slug,
      type: page?.type ?? "",
      date: page?.date ?? "",
      content_hash: page?.content_hash ?? "",
      prompt_version: await freshVersion(home),
      extractions: {},
    };
    row.extractions = row.extractions ?? {};
    let mudou = !ex;
    for (const it of doSlug) {
      const arr = Array.isArray(row.extractions[it.dimension]) ? row.extractions[it.dimension] : [];
      const jaTem = arr.some((c: any) => c && c.review_id === it.id);
      if (jaTem) continue;
      row.extractions[it.dimension] = [
        ...arr,
        { ...it.claim, source_id: it.source_id, review: "aprovada", review_id: it.id },
      ];
      mudou = true;
    }
    if (mudou) await e.putExtraction(row);
    slugsTocados.push(slug);
  }

  // 5) derive UMA VEZ no lote inteiro (M14: deriveIncremental já é por-grupos-afetados — N
  //    slugs numa chamada = 1 leitura de cadeias + 1 escrita dirigida). NUNCA 1 derive/item.
  //    DESVIO da spec-literal (que chamava derive incondicional): lote SÓ-conexao_sugerida não
  //    toca página nenhuma ⇒ slugsTocados=[] ⇒ sem derive (cenário cravado §3.2/§5.C-4: conexão
  //    = registrar a decisão, sem extração/derive). deriveIncremental([]) seria no-op de efeito;
  //    pular o explicita e bate com o corolário 4 da LEI.
  if (slugsTocados.length) await deriveIncremental(home, slugsTocados);

  // 6) decisão por item DEPOIS do efeito durável (ordem crash-safe do approveReviewItem):
  //    CAS one-shot do engine (WHERE status='pendente') — repetir é no-op.
  for (const it of passantes) await e.setReviewStatus(it.id, "aprovada", decidedBy);
  for (const it of conexoes) await e.setReviewStatus(it.id, "aprovada", decidedBy);

  return {
    aprovados: passantes.length + conexoes.length,
    retidos,
    ja_decididos: jaDecididos,
    paginas_derivadas: slugsTocados.length,
  };
}

/** M25-A — descartar EM LOTE, registrado (decided_by/decided_at gravados pelo engine; a linha
 *  permanece legível — invariante #5, NUNCA silencioso). Idempotente: id não-pendente conta em
 *  ja_decididos. NÃO substitui discardReviewItem (unitário, intacto). */
export async function discardReviewItemsLote(
  home: string,
  ids: string[],
  decidedBy: string,
): Promise<{ descartados: number; ja_decididos: number }> {
  if (!ids.length) return { descartados: 0, ja_decididos: 0 };
  const e = await getEngine(home);
  const pendentes = await e.listReview({ status: "pendente", limit: REVIEW_SCAN_LIMIT });
  const byId = new Set(pendentes.map((it) => it.id));
  let descartados = 0;
  let jaDecididos = 0;
  for (const id of new Set(ids)) {
    if (byId.has(id)) {
      await e.setReviewStatus(id, "descartada", decidedBy);
      descartados++;
    } else jaDecididos++;
  }
  return { descartados, ja_decididos: jaDecididos };
}
