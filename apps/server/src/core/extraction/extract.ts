/** CAMADA 2 — extração: fonte (galeed_pages) -> fatos tipados crus (galeed_extractions) via LLM.
 *  A saída crua é guardada por fonte; a DERIVAÇÃO bitemporal acontece depois, no `organize`. */
import { config } from "../platform/config.ts";
import { type Tool } from "../../lib/anthropic.ts";
import { resolveExtractionProvider, structured } from "../../lib/llm.ts";
import { recordUsage } from "../platform/usage.ts"; // M20 — custo de IA por chamada
import { UNTRUSTED_SYS, wrapUntrusted } from "../../lib/prompt-safety.ts";
import { getEngine, type PageRow } from "../platform/engine.ts";
import { withCodexBrain, getCodexBrain } from "../../lib/chatgpt-codex.ts";
import { buildExtractionUnits } from "../ingestion/segment.ts";
import { getExtractSchema } from "./extractable.ts";
import { ensureSchemaPack } from "./schema-pack.ts"; // M13 — warm-up DB-first do pack antes do consumo síncrono
import { getBrainContext, contextVersion } from "./brain-context.ts"; // M11/S1 — contexto do brain
import { anchorRoles } from "./role-anchor.ts"; // M11/S2 — pré-passo determinístico de papéis
// P1-C (mata A8a): a re-extração passa pelo MESMO gate do pipeline. Ciclo de módulo
// extract.ts ⇄ golden-rule.ts é seguro: ambos exportam FUNCTION DECLARATIONS (hoisted) e só se
// referenciam dentro de corpos async (call-time) — mesmo padrão já existente em batch-extract.
import { applyRecipeGate, recipeGuidance, addReviewItemsAndNotify } from "../ingestion/golden-rule.ts";

export const PROMPT_VERSION = "v3"; // v3: claim tipado (value_num/unit/period/tier) + 6 aprendizados gbrain

/** Uma unidade de extração: um pedaço de fonte JÁ com header de âncora pronto p/ o LLM (M9).
 *  Tipo-contrato compartilhado: declarado AQUI (dono = extract.ts) e importado por `core/segment.ts`.
 *  S2 substituiu o default S1 (1 unit truncada) pela segmentação temporal datada de `core/segment.ts`. */
export interface ExtractionUnit {
  header: string;     // linhas de âncora ("Fonte: …", "Conversa entre … de … a …"). Vai ANTES do corpo.
  body: string;       // corpo do segmento (texto cru, NÃO-confiável → será envolvido em wrapUntrusted)
  date: string;       // data efetiva deste segmento (YYYY-MM-DD ou ""). É o valid_from-base dos fatos.
  // M15/S5 (gap-S3-cut): texto SEMÂNTICO p/ o porteiro (S3 `scoreSegment`) pontuar, SEM o scaffold de
  // render `Speaker (ISO):` (que cega o porteiro com o `\d` do timestamp). Conversa = as `m.text` das
  // mensagens SOBREVIVENTES "\n"-juntas; doc/chunk = o próprio `body` (já semântico). ADITIVO: os 3
  // consumidores existentes (`extractUnit`/`extractOne`/`bff-context-edit`) leem só header/body → inerte.
  triageText: string;
}

/** SEAM #1 trocado na reconciliação (onda 1 M9): `buildExtractionUnits` vem de `core/segment.ts` (S2),
 *  que segmenta conversa por âncora temporal (sem truncar e perder contexto — R10). Mesma assinatura
 *  `(page: PageRow) => ExtractionUnit[]`. Importado no topo (binding local p/ `extractOne`) e
 *  re-exportado aqui pra preservar a API pública de `extract.ts`. O call site não mudou. */
export { buildExtractionUnits };

/** Semântica de UMA linha por dimensão conhecida — sem isto o modelo adivinha pelo nome da chave
 *  (e adivinha mal: o baseline A/B mostrou call estratégica rica extraindo ZERO em todas as dims).
 *  Dimensão custom de tenant cai no fallback (nome + guidance do pack orientam). */
const DIM_SEMANTICS: Record<string, string> = {
  facts: "fatos operacionais e de negócio que valem 'hoje' (capacidades, prazos, resultados de pesquisa, métricas)",
  decisions: "DECISÕES tomadas — o text carrega SEMPRE o porquê quando o texto der ('decidimos X porque Y'); decisão sem porquê é meia decisão",
  action_items: "compromissos assumidos: QUEM prometeu O QUÊ pra QUANDO",
  follow_ups_pending: "pendências em aberto esperando resposta/ação (e de quem)",
  objections: "objeções, resistências e contra-argumentos ouvidos (de cliente, sócio, mercado)",
  open_questions: "dúvidas em aberto e hipóteses ainda NÃO confirmadas",
  quotes: "falas literais marcantes (voz do cliente/time — sem parafrasear)",
  entities: "atores que aparecem: pessoa, empresa, CONCORRENTE, produto, ferramenta",
  claims: "afirmações estáveis sobre entidades (entity+predicate+value)",
};

function dimSemanticsBlock(dims: string[]): string {
  return dims
    .map((d) => `- ${d}: ${DIM_SEMANTICS[d] ?? "dimensão do domínio do tenant (siga o nome e a orientação do pack)"}`)
    .join("\n");
}

function buildTool(dims: string[], desc: string, guidance = ""): Tool {
  const item = {
    type: "object",
    properties: {
      text: { type: "string", description: "o fato em linguagem natural" },
      context_quote: { type: "string", description: "trecho literal de onde tirou" },
      entity: { type: "string", description: "sujeito canônico do fato em UMA palavra/slug curto e estável (ex.: 'accelera', 'kelvin', 'medicamento-x'). NÃO use a razão social completa nem sufixos ('Accelera 360' → 'accelera'). Vazio se não for afirmação sobre entidade." },
      predicate: { type: "string", description: "a relação/atributo, snake_case estável e GENÉRICO (ex.: 'preco', 'dose', 'status', 'mrr'). NÃO embuta a faixa/tier nem o sufixo do plano no predicado ('preço do plano Enterprise' / 'preco_plano_pro' → predicate='preco' + tier='enterprise'/'pro'). Vazio se não se aplica." },
      value: { type: "string", description: "o valor atual da relação (ex.: 'R$ 2500', 'fechado', 'Joinville')." },
      value_num: { type: "number", description: "o valor NUMÉRICO CRU do claim quando houver número (30000 para 'R$ 30 mil', 0.05 para '5%'). Omita se não há número." },
      unit: { type: "string", description: "unidade do value_num: 'BRL','USD','pct','people','un','months','days'… Omita se não se aplica." },
      period: { type: "string", description: "periodicidade quando o valor é por período: 'monthly','annual','quarterly','one_time'. Omita se não se aplica." },
      tier: { type: "string", description: "segmento/faixa/plano a que o claim se refere, quando o texto distinguir (ex.: 'enterprise','pro','starter','full','pocket','básico'). Omita só se o claim é único/sem faixa." },
      valid_from: { type: "string", description: "data (YYYY-MM-DD) em que esse valor passou a valer, se o texto disser; senão vazio (usa a data da fonte)." },
    },
    required: ["text"],
    additionalProperties: true,
  };
  const properties: Record<string, unknown> = {};
  for (const d of dims) properties[d] = { type: "array", items: item };
  return {
    name: "registrar_extracao",
    // A memória de um negócio vai MUITO além de números: decisões e seus porquês, compromissos,
    // relações (cliente/fornecedor/concorrente), aprendizados, riscos e pesquisa valem tanto quanto
    // preço. Os exemplos abaixo cobrem o ESPECTRO INTEIRO de propósito — a versão anterior só dava
    // exemplos monetários e o modelo devolvia vazio em conteúdo estratégico (baseline A/B).
    description:
      `Extrai dimensões semânticas de uma ${desc}. Em context_quote cole o trecho literal de onde tirou.\n` +
      `O QUE CADA DIMENSÃO SIGNIFICA:\n${dimSemanticsBlock(dims)}\n` +
      `Quando um item for uma AFIRMAÇÃO ESTÁVEL sobre uma entidade (uma decisão, um compromisso, uma relação, ` +
      `um risco, um resultado de pesquisa, um preço, um status, um atributo), preencha entity+predicate+value ` +
      `(e valid_from se houver data) para rastrear mudanças ao longo do tempo — use a MESMA grafia de ` +
      `entity/predicate quando for o mesmo assunto, pra o sistema detectar que a pessoa mudou de ideia. ` +
      `Se o item NÃO for uma afirmação sobre entidade (ex.: uma citação solta, uma pergunta em aberto), deixe esses campos vazios. ` +
      `Não invente nada que não esteja no texto.` +
      ` Quando o value for NUMÉRICO (preço, métrica de marketing, prazo, contagem), preencha value_num com o número CRU normalizado (30000, não "R$ 30K"; 0.05, não "5%") e unit (BRL/USD/pct/people/un/months/days/x/leads…); use period se for por período (monthly/annual). SEPARE a faixa/plano no campo tier (NUNCA no predicado).` +
      `\nEXEMPLOS DO ESPECTRO COMPLETO (imite a variedade):` +
      `\n- DECISÃO com porquê: "vamos parar de competir por preço e focar em premium, porque as clientes citam confiança, nunca preço" → decisions, text="Decidiu focar em tratamento premium PORQUE as clientes citam confiança e resultado, não preço", entity=<empresa-slug>, predicate=posicionamento, value="premium".` +
      `\n- COMPROMISSO: "assumo fechar a parceria com a Dra. Lins até o fim do mês" → action_items (ou facts), text="Paula se comprometeu a fechar parceria com Dra. Lins até o fim do mês", entity=paula, predicate=compromisso_parceria, value="Dra. Lins até fim do mês".` +
      `\n- RELAÇÃO/CONCORRENTE (pesquisa de mercado): "o concorrente NuBeauty abriu unidade no centro atendendo sábado" → facts, entity=nubeauty, predicate=concorrente_de, value=<empresa-slug>; e OUTRO claim entity=nubeauty, predicate=cobertura, value="centro, atende sábado".` +
      `\n- APRENDIZADO: "vídeo de antes-e-depois converte muito mais que foto estática" → facts, text="Aprendizado: vídeo de antes-e-depois converte mais que foto estática", entity=<empresa-slug>, predicate=aprendizado_conteudo, value="vídeo antes-e-depois > foto".` +
      `\n- MÉTRICA DE MARKETING: "o CPL caiu de 18 pra 12 reais em junho" → facts, entity=<empresa-slug>, predicate=cpl, value="R$ 12", value_num=12, unit=BRL, period=monthly, valid_from=<junho>.` +
      `\n- PREÇO com faixa: "Plano Enterprise custa R$ 30 mil/mês" → entity=<empresa-slug>, predicate=preco, value_num=30000, unit=BRL, period=monthly, tier=enterprise.` +
      ` Regras de qualidade (siga à risca): (1) ATÔMICO — um claim por afirmação; quebre compostos. (2) NÃO infle precisão — só ponha value_num/unit se o número estiver no texto; nunca arredonde nem invente casas. (3) SELF-REPORTED ≠ VERIFICADO — se é o próprio sujeito afirmando sobre si, é claim, não verdade absoluta; em dúvida, deixe como texto. (4) Teste "so what" — pule metadados triviais que não são fato útil. (5) entity em slug curto, predicate GENÉRICO e estável (preco, status, prazo_entrega, concorrente_de, responsavel_por, aprendizado_*), faixa/plano em tier. (6) context_quote = trecho LITERAL da fonte. (7) DECISÃO sem porquê é meia decisão: se o texto traz a justificativa, ela ENTRA no text. (8) RELAÇÕES entre entidades (cliente_de, fornecedor_de, concorrente_de, parceiro_de, responsavel_por) são fatos de primeira classe — capture-as.` +
      (guidance ? `\n\nORIENTAÇÃO DO DOMÍNIO (pack do tenant, prioritária p/ ancoragem):\n${guidance}` : ""),
    input_schema: { type: "object", properties, required: dims },
  };
}

/** Dica de entidades conhecidas (mecanismo `entityHints` do gbrain `src/core/facts/extract.ts` §76-77,174-177:
 *  "Known entity slugs the user already mentioned" injetadas no prompt p/ o LLM ANCORAR fatos em entidades
 *  canônicas, não no falante). Aqui as entidades vêm dos FATOS VIGENTES já no brain (genérico, tenant-neutro
 *  — qualquer domínio): pega os slugs mais frequentes. NÃO é vocabulário de negócio hardcoded. */
export async function entityHints(home: string, limit = 12): Promise<string[]> {
  try {
    const e = await getEngine(home);
    const cur = await e.currentFacts();
    const freq = new Map<string, number>();
    for (const f of cur) {
      const ent = (f.entity || "").toLowerCase().trim();
      if (ent) freq.set(ent, (freq.get(ent) ?? 0) + 1);
    }
    const freqList = [...freq.entries()].sort((a, b) => b[1] - a[1]).map(([ent]) => ent);
    // M11/S2: o self do contexto é sempre uma âncora candidata (mesmo num brain novo sem fatos ainda).
    // getBrainContext nunca lança (fail-soft → vazio); self="" preserva a lista de frequência pura.
    const ctx = await getBrainContext(home);
    const self = (ctx.self.slug || "").toLowerCase().trim();
    const out = self ? [self, ...freqList.filter((ent) => ent !== self)] : freqList;
    return out.slice(0, limit);
  } catch {
    return [];
  }
}

/** Bloco de dica de ancoragem por FREQUÊNCIA (entidades conhecidas do brain). Genérico, tenant-neutro.
 *  Vazio se não há entidades conhecidas. M11/S2: a regra de PAPÉIS (self/cliente) NÃO mora mais aqui —
 *  saiu do core (era domínio "venda" hardcoded, violava ADR-002) e passa a vir do contexto declarado
 *  pelo tenant (role-anchor.ts → RoleAnchoring.block). Aqui sobra só a dica genérica de frequência. */
export function entityHintBlock(hints: string[]): string {
  if (!hints.length) return "";
  return (
    `\n\nENTIDADES CONHECIDAS deste brain (prefira ANCORAR o sujeito do fato a uma destas, na MESMA grafia, ` +
    `quando o texto se referir a ela; não crie uma variante nova): ${hints.slice(0, 12).join(", ")}.`
  );
}

/** Versão composta de freshness: PROMPT_VERSION + a versão do contexto do brain. M11/S2: a re-extração
 *  (S6) precisa invalidar quando o contexto muda — por isso a `contextVersion` entra na chave. Brain sem
 *  contexto = `v3#ctx0`. Banco LIMPO: nada a migrar (o `v3` puro de hoje não existe mais no efeito). */
export async function freshVersion(home: string): Promise<string> {
  const cv = await contextVersion(home); // S1 (nunca lança; degrada p/ 0)
  return `${PROMPT_VERSION}#ctx${cv}`;
}

/** Uma fonte já está extraída e fresca? (mesmo content_hash + mesma versão composta prompt+contexto) */
export async function isFresh(home: string, page: PageRow): Promise<boolean> {
  const e = await getEngine(home);
  const meta = await e.extractionMeta(page.slug);
  if (!meta) return false;
  return meta.content_hash === (page.content_hash || "") && meta.prompt_version === (await freshVersion(home));
}

/** M15/S1 — contexto de extração de uma PÁGINA, computado UMA vez (não por unit): tool/provider/model +
 *  os blocos de âncora (papéis + hints de frequência). É o que `extractUnit` precisa pra extrair uma
 *  unit isolada sem reconstruir o prompt. Montado por `buildExtractionContext`. */
export interface ExtractionContext {
  tool: Tool;
  dims: string[];
  provider: string;
  model: string;
  ctxBlock: string;  // bloco de papéis (M11). "" ⇒ legado (golden M9 não muda).
  hintBlock: string; // bloco de entidades conhecidas (frequência). "" se não há.
}

/** M21 — overrides de extração vindos da RECEITA da fonte (DADO do tenant). Aditivo: ausente ⇒
 *  comportamento byte-idêntico (golden M9 prova). */
export interface ExtractionOverrides {
  guidance?: string;
}

/** Monta o ExtractionContext de uma página UMA vez (tool + provider/model + blocos de âncora). Async:
 *  lê pack/contexto/entity-hints (IO). Reusado por extractOne (loop) e exposto p/ o pipeline gatear
 *  unit-a-unit (M15/S3) sem reimplementar o prompt. M21: `overrides.guidance` (receita da fonte) entra
 *  no buildTool COMO o guidance do pack já entra — as dims NÃO mudam (a receita orienta o prompt e o
 *  gate decide depois; não amputa a extração). Sem overrides ⇒ byte-idêntico (schema.guidance já vem
 *  trimado de getExtractSchema, então o .trim() é no-op no caminho legado). */
export async function buildExtractionContext(
  home: string,
  page: PageRow,
  overrides?: ExtractionOverrides,
): Promise<ExtractionContext> {
  await ensureSchemaPack(home); // M13: pack DB-first no cache síncrono antes de getExtractSchema/extractableDims
  const cfg = config(home);
  // P1-C (item 6): extração exige 'api' (cli degrada o schema tipado em silêncio). 'cli' só com
  // fallback pro binário `claude` local (schema vai por instrução); senão erro claro. Cobre TODOS os caminhos de extração
  // real (extractOne/extractWorthyUnitsSync/batch consomem este ctx).
  const provider = resolveExtractionProvider(cfg.provider);
  const model = provider === "cli" ? cfg.cliModel : cfg.apiModel;

  const schema = getExtractSchema(home, page.type);
  const guidance = (schema.guidance + (overrides?.guidance ?? "")).trim();
  const tool = buildTool(schema.dims, schema.desc, guidance);
  // entity-hints (gbrain): entidades canônicas já conhecidas do brain, p/ ancorar o sujeito do fato
  // a uma entidade conhecida (não ao falante). Computado UMA vez por página (não por unit).
  const hintBlock = entityHintBlock(await entityHints(home));
  // M11/S2: pré-passo DETERMINÍSTICO de papéis (sem LLM, custo zero). Computado UMA vez por página.
  // ctx sem self (brain sem contexto) → ctxBlock="" → prompt IDÊNTICO ao legado → golden M9 não muda.
  const ctx = await getBrainContext(home); // S1 (nunca lança; degrada p/ vazio)
  const ctxBlock = anchorRoles(ctx, page.body, page.type, page.date || "").block;
  return { tool, dims: schema.dims, provider, model, ctxBlock, hintBlock };
}

/** P0-A: carimba a data determinística da unit em cada claim SEM data própria. Usa o campo `date` do
 *  claim — o MESMO que factValidFrom (indexer.ts:88) já lê como fallback (valid_from || date || since ||
 *  ex.date). NÃO toca `valid_from` (do LLM) nem sobrescreve `date` já presente. Mutação in-place;
 *  unitDate "" → no-op. Genérico: não sabe o que é WhatsApp (carimba qualquer claim de qualquer fonte). */
export function stampUnitDate(out: Record<string, any[]>, unitDate: string): void {
  if (!unitDate) return;
  for (const arr of Object.values(out)) {
    if (!Array.isArray(arr)) continue;
    for (const it of arr) {
      if (it && typeof it === "object" && !Array.isArray(it) && !it.date) (it as any).date = unitDate;
    }
  }
}

/** Extrai UMA unit já montada (header+body) → dims cruas (dim → claims desta unit). É o MIOLO do loop de
 *  extractOne, exposto p/ o pipeline gatear unit-a-unit (M15/S3) sem reimplementar o prompt. extractOne
 *  passa a chamá-la no loop — resultado público INALTERADO (golden M9 prova). Faz a chamada LLM; o
 *  putExtraction/markExtracted ficam em extractOne. */
export async function extractUnit(
  home: string,
  page: PageRow,
  unit: ExtractionUnit,
  ctx: ExtractionContext,
): Promise<Record<string, any[]>> {
  if (getCodexBrain() !== home) return withCodexBrain(home, () => extractUnit(home, page, unit, ctx));
  // ordem: header, contexto (mais forte), hints de frequência, corpo untrusted. ctxBlock="" ⇒ legado.
  // R9: o corpo da fonte é DADO não-confiável — delimitado, fora das instruções (anti prompt-injection).
  const prompt = `${unit.header}${ctx.ctxBlock}${ctx.hintBlock}\n\n${wrapUntrusted(unit.body)}`;
  const out: any = await structured({
    provider: ctx.provider as any,
    model: ctx.model,
    system: "Você extrai conhecimento estruturado de negócios. Seja fiel ao texto; não invente. " + UNTRUSTED_SYS,
    prompt,
    tool: ctx.tool,
    dims: ctx.dims,
    // M20: registra o custo desta chamada de extração (fail-soft; não bloqueia o pipeline).
    meter: (ev) =>
      void recordUsage(home, {
        op: "extract",
        provider: ev.provider,
        model: ev.model,
        tokensIn: ev.tokensIn,
        tokensOut: ev.tokensOut,
        cacheRead: ev.cacheRead,
        cacheWrite: ev.cacheWrite,
        costUsdReported: ev.costUsdReported,
        meta: { slug: page.slug, type: page.type },
      }),
  });
  const result: Record<string, any[]> = {};
  for (const d of ctx.dims) result[d] = Array.isArray(out?.[d]) ? out[d] : [];
  // P0-A: a data determinística desta unit viaja até o claim (campo `date` → fallback de valid_from no
  // indexer, sem tocá-lo). Cobre os 2 chamadores síncronos (extractOne + extractWorthyUnits). No-op se "".
  stampUnitDate(result, unit.date);
  return result;
}

export async function extractOne(home: string, page: PageRow) {
  if (getCodexBrain() !== home) return withCodexBrain(home, () => extractOne(home, page));
  const e = await getEngine(home);
  // P1-C (mata A8a): página carimbada por fonte (tag `src:<id>` — MESMA convenção do pipeline e
  // do reparo P0-C) re-extrai SOB o contrato; fail-closed espelho do processBlobJob. Página sem
  // tag src: ⇒ source=undefined ⇒ recipe null ⇒ gate pass-through BYTE-IDÊNTICO (golden M9 intacto).
  const srcTag = (page.tags ?? []).find((t) => t.startsWith("src:"));
  const sourceId = srcTag ? srcTag.slice("src:".length) : undefined;
  const source = sourceId ? await e.getSource(sourceId) : undefined;
  if (sourceId && !source)
    throw new Error("a fonte desta página não existe mais — re-extração bloqueada pelo contrato.");
  if (source && source.status === "pausada")
    throw new Error(`a fonte "${source.name}" está pausada — retome a leitura pra re-extrair.`);
  const ctx = await buildExtractionContext(
    home,
    page,
    source ? { guidance: recipeGuidance(source.recipe) } : undefined, // receita orienta o prompt (M21)
  );
  // R9: o corpo da fonte é DADO não-confiável — delimitado, fora das instruções (anti prompt-injection).
  const units = buildExtractionUnits(page);
  const merged: Record<string, any[]> = {};
  for (const d of ctx.dims) merged[d] = [];
  let lastDate = page.date || "";
  for (const unit of units) {
    const out = await extractUnit(home, page, unit, ctx);
    for (const d of ctx.dims) if (Array.isArray(out[d])) merged[d].push(...out[d]);
    if (unit.date) lastDate = unit.date;
  }

  // P1-C — o MESMO gate do pipeline/harvest, antes do putExtraction (re-extrair não contorna o
  // contrato; rejeitado vira hipótese na fila, com id determinístico — re-extração não duplica).
  const gate = applyRecipeGate(merged, source?.recipe ?? null, source?.id ?? "", page.slug, page.body);
  // C2 — review.pending (mesmo gancho do pipeline/harvest). Fail-soft.
  if (gate.rejected.length) await addReviewItemsAndNotify(home, gate.rejected);
  console.log(
    `[recipe-gate] brain=${home} page=${page.slug} approved=${gate.counts.approved} ` +
      `rejected=${gate.counts.rejected} source=${source?.id ?? "-"}`,
  );

  // M11/S2: grava o prompt_version COMPOSTO (v3#ctx<N>) p/ isFresh bater e invalidar quando o contexto muda.
  const versionTag = await freshVersion(home);
  await e.putExtraction({
    source_slug: page.slug,
    type: page.type,
    date: lastDate,
    content_hash: page.content_hash || "",
    prompt_version: versionTag,
    extractions: gate.approved,
  });
  await e.markExtracted(page.slug, versionTag);
  return { slug: page.slug, dims: ctx.dims };
}
