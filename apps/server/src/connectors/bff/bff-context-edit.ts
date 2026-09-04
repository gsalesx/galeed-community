/** M11/S6 — handlers PUROS da edição de contexto + preview + re-extração (tela Ajustes).
 *
 *  Fecha o loop de produto da Ingestão-com-Contexto:
 *    - contextGet/contextSave: o fundador EDITA o contexto visualmente (S1 grava → versão sobe).
 *    - contextPreview: "com este contexto, de um doc-exemplo eu extrairia ISTO" — em LINGUAGEM NATURAL.
 *    - reextractEstimate/reextractRun: re-extração SOB COMANDO (D3) com aviso de custo ANTES de rodar.
 *
 *  Handlers PUROS (recebem home/input, devolvem objeto serializável ou lançam BffError) — espelham
 *  bff-onboarding.ts (S4). O web-server.ts (zona neutra) só importa estes e roteia (/api/context*).
 *
 *  INVARIANTES (ADR-005-d / D3):
 *    - O usuário NUNCA vê JSON nem prompt_template. O `card` e o `summary` são prosa.
 *    - Re-extração é SOB COMANDO (chamada no clique de confirmação), nunca no save. Aviso de custo antes.
 *    - O preview NÃO persiste: a página de exemplo é EFÊMERA (em memória), nada toca galeed_pages/extractions.
 *
 *  Motor / core INTOCÁVEIS: só IMPORTA getBrainContext/saveBrainContext (S1), isFresh/PROMPT_VERSION (S2),
 *  estimateTokens/estimateCostUsd (extract-receipt), allPages (engine) e o provider de LLM (D2). */
import { config } from "../../core/platform/config.ts";
import { resolveProvider, structured, prose } from "../../lib/llm.ts";
import {
  getBrainContext,
  saveBrainContext,
  type BrainContext,
} from "../../core/extraction/brain-context.ts";
import { isFresh, extractOne, entityHints, entityHintBlock, buildExtractionUnits } from "../../core/extraction/extract.ts";
import { estimateTokens, estimateCostUsd } from "../../core/extraction/extract-receipt.ts";
import { getEngine, type PageRow } from "../../core/platform/engine.ts";
import { getExtractSchema } from "../../core/extraction/extractable.ts";
import { deriveIncremental } from "../../core/retrieval/indexer.ts";
import { anchorRoles } from "../../core/extraction/role-anchor.ts";
import { UNTRUSTED_SYS, wrapUntrusted } from "../../lib/prompt-safety.ts";
import type { Tool } from "../../lib/anthropic.ts";
import { BffError } from "./bff-common.ts";

export { BffError };

// ---------- contexto traduzido p/ o front (campos rotulados, NUNCA JSON cru na tela) ----------

/** Contexto traduzido p/ o shape visual + cartão legível. NUNCA expõe prompt_template. */
export interface ContextView {
  context: Omit<BrainContext, "version">; // editável pelo front
  version: number;
  card: string; // resumo legível ("Seu cérebro guarda…")
}

export async function contextGet(home: string): Promise<ContextView> {
  const ctx = await getBrainContext(home);
  return {
    context: { self: ctx.self, purpose: ctx.purpose, roles: ctx.roles, sourceTypes: ctx.sourceTypes },
    version: ctx.version,
    card: renderCard(ctx),
  };
}

export async function contextSave(
  home: string,
  inp: { context: Omit<BrainContext, "version"> },
): Promise<ContextView> {
  if (!inp || !inp.context || typeof inp.context !== "object") {
    throw new BffError(400, "contexto ausente");
  }
  const version = await saveBrainContext(home, inp.context); // S1 (versão sobe → invalida re-extração)
  const ctx = await getBrainContext(home);
  return {
    context: { self: ctx.self, purpose: ctx.purpose, roles: ctx.roles, sourceTypes: ctx.sourceTypes },
    version,
    card: renderCard(ctx),
  };
}

// ---------- preview-loop (em LINGUAGEM NATURAL, zero persistência) ----------

export interface PreviewResult {
  summary: string;
}

/** "com este contexto, de um doc-exemplo eu extrairia ISTO" — em prosa. Roda a extração context-aware
 *  (S2) sobre um exemplo EFÊMERO (em memória, NÃO persiste) e descreve os fatos em linguagem natural. */
export async function contextPreview(
  home: string,
  inp: { sampleText: string; type: string },
): Promise<PreviewResult> {
  const sample = (inp?.sampleText || "").trim();
  if (!sample) throw new BffError(400, "cole um trecho de exemplo pra eu mostrar o que extrairia.");
  // Página EFÊMERA (em memória) — NÃO grava no brain.
  const page: PageRow = {
    slug: "__preview__",
    type: inp.type || "reunioes",
    title: "preview",
    date: "",
    path: "",
    body: sample,
    content_hash: "preview",
    tags: [],
    sensitivity: "publico",
  };
  const summary = await describeExtraction(home, page);
  return { summary };
}

/** Monta o prompt de extração context-aware (réplica do `extractOne` do S2 — header + ctxBlock + hints +
 *  corpo untrusted) e chama `structured` DIRETO (sem `putExtraction`/`markExtracted`), pega os claims e os
 *  DESCREVE em prosa via `prose` (Haiku/provider da config). NÃO persiste nada (decisão no ARTIFACTS:
 *  preferível ao "extractOne + limpar slug", que deixaria uma extração órfã — o engine não tem deletePage/
 *  deleteExtraction). Se não sai fato, devolve a frase honesta. Fail-soft: sem provider/erro → frase honesta. */
async function describeExtraction(home: string, page: PageRow): Promise<string> {
  const HONESTO = "Desse exemplo eu não tiraria nenhum fato — talvez falte contexto ou algum número.";
  try {
    const cfg = config(home);
    const provider = resolveProvider(cfg.provider);
    const model = provider === "cli" ? cfg.cliModel : cfg.apiModel;

    const schema = getExtractSchema(home, page.type);
    const tool = buildPreviewTool(schema.dims, schema.desc, schema.guidance);
    const hintBlock = entityHintBlock(await entityHints(home));
    const ctx = await getBrainContext(home);
    const ctxBlock = anchorRoles(ctx, page.body, page.type, page.date || "").block;
    const units = buildExtractionUnits(page);

    const claims: Array<{ text: string }> = [];
    for (const unit of units) {
      const prompt = `${unit.header}${ctxBlock}${hintBlock}\n\n${wrapUntrusted(unit.body)}`;
      const out: any = await structured({
        provider,
        model,
        system: "Você extrai conhecimento estruturado de negócios. Seja fiel ao texto; não invente. " + UNTRUSTED_SYS,
        prompt,
        tool,
        dims: schema.dims,
      });
      for (const d of schema.dims) {
        if (Array.isArray(out?.[d])) {
          for (const it of out[d]) {
            const t = it && typeof it.text === "string" ? it.text.trim() : "";
            if (t) claims.push({ text: t });
          }
        }
      }
    }

    if (!claims.length) return HONESTO;

    // descreve os claims em PROSA (linguagem natural, nunca JSON cru) — Haiku/provider da config.
    const lista = claims.map((c) => `- ${c.text}`).join("\n");
    const summary = (
      await prose({
        provider,
        model,
        system:
          "Você explica, em português claro e em UMA frase ou duas, o que um cérebro de memória guardaria " +
          "de um texto. Comece com 'Eu guardaria:' e liste os fatos em prosa, sem bullets, sem JSON, sem aspas técnicas.",
        prompt: `Fatos extraídos do exemplo:\n${lista}\n\nDescreva em prosa o que eu guardaria.`,
      })
    ).trim();
    return summary || `Eu guardaria: ${claims.map((c) => c.text).join("; ")}.`;
  } catch {
    return HONESTO;
  }
}

/** Tool de extração mínima p/ o PREVIEW (só precisa do `text` de cada claim, pra descrever em prosa).
 *  NÃO reusa o buildTool do S2 (que é privado a extract.ts e território do S2); aqui basta o texto. */
function buildPreviewTool(dims: string[], desc: string, guidance = ""): Tool {
  const item = {
    type: "object",
    properties: {
      text: { type: "string", description: "o fato em linguagem natural" },
      context_quote: { type: "string", description: "trecho literal de onde tirou" },
      entity: { type: "string", description: "sujeito canônico do fato (slug curto), vazio se não se aplica" },
      predicate: { type: "string", description: "a relação/atributo (snake_case), vazio se não se aplica" },
      value: { type: "string", description: "o valor atual da relação" },
    },
    required: ["text"],
    additionalProperties: true,
  };
  const properties: Record<string, unknown> = {};
  for (const d of dims) properties[d] = { type: "array", items: item };
  return {
    name: "registrar_extracao",
    description:
      `Extrai dimensões semânticas de uma ${desc} para um PREVIEW. Em context_quote cole o trecho literal. ` +
      `Não invente nada que não esteja no texto.` +
      (guidance ? `\n\nORIENTAÇÃO DO DOMÍNIO (pack do tenant):\n${guidance}` : ""),
    input_schema: { type: "object", properties, required: dims },
  };
}

// ---------- re-extração SOB COMANDO com aviso de custo (D3) ----------

export interface ReextractEstimate {
  staleDocs: number;
  totalDocs: number;
  costUsdEstimate: number;
}

/** Quantos docs ficaram DESATUALIZADOS (contexto mudou → contextVersion subiu → isFresh=false) + custo
 *  estimado. NÃO re-extrai. `isFresh` (S2) considera content_hash + PROMPT_VERSION + contextVersion. */
export async function reextractEstimate(home: string): Promise<ReextractEstimate> {
  const e = await getEngine(home);
  const pages = await e.allPages();
  let stale = 0;
  let tokens = 0;
  for (const p of pages) {
    if (!(await isFresh(home, p))) {
      stale++;
      tokens += estimateTokens(p.body || "");
    }
  }
  const cfg = config(home);
  const model = resolveProvider(cfg.provider) === "cli" ? cfg.cliModel : cfg.apiModel;
  // saída ~20% da entrada (heurística do gate); o custo só dá ordem de grandeza pro aviso (D3).
  const costUsdEstimate = estimateCostUsd({ tokensIn: tokens, tokensOut: Math.round(tokens * 0.2), model });
  return { staleDocs: stale, totalDocs: pages.length, costUsdEstimate };
}

export interface ReextractResult {
  reextracted: number;
  blocked: number; // P1-C: páginas puladas (fonte pausada/removida ou erro de extração) — aditivo
  derivedFacts: number; // FIX-A (ADITIVO): fatos derivados do lote re-extraído (0 se nada re-extraiu)
  message: string;
}

/** Re-extrai SÓ os docs stale (isFresh=false). Idempotente (hash + contextVersion). SOB COMANDO —
 *  chamado no clique de confirmação do front, NUNCA no save (D3). P1-C: cada página re-extrai SOB
 *  o contrato (extractOne gateado); uma página bloqueada (fonte pausada/removida, provider) NÃO
 *  aborta o lote inteiro — é contada em `blocked` e logada. */
export async function reextractRun(home: string): Promise<ReextractResult> {
  const e = await getEngine(home);
  const pages = await e.allPages();
  let blocked = 0;
  // FIX-A/BUG 2: coleciona os slugs que extractOne completou — extractOne (extract.ts:236) faz
  // putExtraction+markExtracted mas NÃO deriva (o derive é do CHAMADOR). reextractRun era o único
  // chamador que esquecia → claims aprovados paravam em galeed_extractions até um organize manual.
  const reextracted: string[] = [];
  for (const p of pages) {
    if (!(await isFresh(home, p))) {
      try {
        await extractOne(home, p); // S2 + P1-C: re-extração context-aware E gateada pelo contrato
        reextracted.push(p.slug);
      } catch (err) {
        // P1-C: uma página bloqueada (fonte pausada/removida, provider) NÃO aborta o lote inteiro.
        // (slug bloqueado NÃO entra em `reextracted` → fica FORA do derive.)
        blocked++;
        console.error(`[reextract] página ${p.slug} pulada: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  const n = reextracted.length;

  // FIX-A/BUG 2: UMA chamada com o LOTE completo de slugs re-extraídos (M14, write-path O(1) —
  // NUNCA buildIndex full no handler). Erro do derive NÃO é engolido (invariante #5): propaga com
  // mensagem PT legível — as extrações estão salvas, dá pra re-tentar.
  let derivedFacts = 0;
  if (reextracted.length) {
    try {
      const d = await deriveIncremental(home, reextracted);
      derivedFacts = d.facts;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new BffError(
        500,
        `re-extraí ${n} documento(s), mas a organização dos fatos falhou: ${msg}. ` +
          `As extrações estão salvas — rode organize ou re-tente.`,
      );
    }
  }

  const base =
    n === 0
      ? blocked > 0
        ? `Não consegui re-extrair — ${blocked} ${blocked === 1 ? "documento ficou bloqueado" : "documentos ficaram bloqueados"} (fonte pausada/removida ou erro de extração); veja o log.`
        : "Tudo já está atualizado — nada a re-extrair."
      : `Re-extraí ${n} ${n === 1 ? "documento" : "documentos"} com o contexto novo e organizei os fatos.`;
  const extra = n > 0 && blocked > 0 ? ` ${blocked} ${blocked === 1 ? "ficou de fora" : "ficaram de fora"} (fonte pausada/removida); veja o log.` : "";
  return { reextracted: n, blocked, derivedFacts, message: base + extra };
}

// ---------- cartão-resumo legível (DETERMINÍSTICO — sem IA, sem custo, sem alucinação) ----------

/** Cartão determinístico — MESMA regra do S4 (renderCardSync de bff-onboarding.ts). Copiado, não
 *  importado entre slots (o S4 não exporta a função; e o DESIGN-SPEC §1 manda copiar). É a tradução
 *  JSON→linguagem-natural exigida pelo invariante ADR-005-d. */
function renderCard(ctx: BrainContext | Omit<BrainContext, "version">): string {
  const linhas: string[] = [];
  if (ctx.self.label || ctx.self.slug) linhas.push(`Seu cérebro guarda a memória de ${ctx.self.label || ctx.self.slug}.`);
  if (ctx.purpose) linhas.push(`Serve pra: ${ctx.purpose}.`);
  const self = ctx.roles.find((r) => r.role === "self");
  const client = ctx.roles.find((r) => r.role === "client");
  if (self) linhas.push(`Você é ${self.label || "o dono"}.`);
  if (client) linhas.push(`Do outro lado costumam estar ${client.label || "os clientes"}.`);
  if (ctx.sourceTypes.length) linhas.push(`Fontes: ${ctx.sourceTypes.map((t) => t.label || t.type).join(", ")}.`);
  return linhas.join(" ") || "Sem contexto declarado — vou usar o modo geral.";
}
