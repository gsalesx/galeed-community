/** M21/S4 — wizard "Criar um cérebro" (criar-cerebro.html): chat BOUNDED de 4 passos que monta a
 *  ESTRUTURA antes do primeiro documento. Espelha bff-onboarding.ts (M11/S4): roteiro FIXO, IA só
 *  normaliza (≤1 chamada/turno), avanço determinístico, servidor stateless (state viaja pro front),
 *  cartão legível — usuário NUNCA vê JSON. Confirm cria o brain + grava contexto M11 + pack M13 +
 *  fontes S1. NÃO edita bff-onboarding.ts. */
import { createHash } from "node:crypto";
import { config } from "../../core/platform/config.ts";
import { resolveProvider, structured, type Provider } from "../../lib/llm.ts";
import type { Tool } from "../../lib/anthropic.ts";
import { getEngine, SENSITIVITY_LEVELS, type SourceRecipe, type SourceRow } from "../../core/platform/engine.ts";
import { saveBrainContext } from "../../core/extraction/brain-context.ts";
import { mergeRecipeDimsIntoPack, loadSchemaPack } from "../../core/extraction/schema-pack.ts";
import { extractableDims, DEFAULT_EXTRACT_DIMS } from "../../core/extraction/extractable.ts";
import { resolveTipo } from "../../core/platform/brain.ts";
import { claimBrainSlug, removeBrainOwnership } from "../../core/access/accounts.ts";
import { BffError } from "./bff-common.ts";

export { BffError };

export type WizardStep = "purpose" | "areas" | "sources" | "sensitivity" | "review" | "done";

/** uma fonte em rascunho (vira SourceRow no confirm). */
export interface WizardSourceDraft {
  name: string;                // nome legível da fonte (dado do tenant)
  channel: "upload" | "paste"; // v1: só os caminhos reais
  type: string;                // slug do tipo (vira page.type / extractable key)
  recipe: SourceRecipe;        // fields sugeridos {dimension,label,area}
  default_sensitivity: string; // preenchido no passo 'sensitivity'
}

export interface WizardDraft {
  name: string;       // slug do brain ("acme-vendas") — sugerido no passo 1, editável
  label: string;      // nome legível ("acme / vendas")
  purpose: string;
  selfSlug: string;   // "" se o passo 1 não identificou o dono
  selfLabel: string;
  areas: string[];    // slugs de área (as "gavetas" do cérebro)
  sources: WizardSourceDraft[];
  sensitivity: string; // "" até o passo 4
}

export interface WizardState { step: WizardStep; draft: WizardDraft; asked: string[] }

/** projeção DETERMINÍSTICA do draft pro painel "cérebro se montando" (o front renderiza; não é
 *  mostrado cru). Espelha os 4 pgroups do mockup. */
export interface WizardPanel {
  name: string;                       // label do cérebro ("Cérebro sem nome" se vazio)
  status: string;                     // "se montando…" | "estrutura em definição" | "pronto pra nascer"
  purpose: string;                    // "" = card vazio
  areas: string[];                    // chips
  sources: { name: string; fields: string[]; areas: string[] }[]; // flines
  rules: string[];                    // ruleline(s) — frases prontas (sigilo + regra de ouro)
}

/** chip RICO (M21/fix-2) — o passo `sources` é uma COLEÇÃO multi-seleção (mockup `fillFontes`):
 *  `kind:'toggle'` = liga/desliga a fonte no draft SEM avançar; `kind:'go'` = "Pronto →" avança.
 *  `selected` reflete o estado atual do draft (front renderiza `.sel`). Os outros passos seguem
 *  usando `suggestions` (texto simples) — `chips` fica [] e o front cai no comportamento legado. */
export interface WizardChip {
  label: string;                 // texto exibido (= mensagem que volta ao back se clicado)
  kind?: "toggle" | "go";        // ausente = chip de texto simples (sugestão), compat com suggestions
  selected?: boolean;            // só p/ toggle: estado atual no draft
}

export interface WizardTurn {
  state: WizardState;
  question: string;       // "" quando review/done
  card: string;           // cartão-resumo legível (review/done); "" antes
  suggestions: string[];  // chips de resposta rápida SIMPLES (texto); [] no passo de coleção 'sources'
  chips: WizardChip[];    // chips RICOS (toggle/go) — só populado em 'sources'; [] nos demais
  panel: WizardPanel;
  done: boolean;
}

// ---------- roteiro fixo (perguntas LITERAIS — fiéis ao mockup, tenant-neutras) ----------

const QUESTIONS: Record<Exclude<WizardStep, "review" | "done">, string> = {
  purpose:     "O que esse cérebro vai cuidar? (ex.: vendas e clientes, financeiro, a empresa inteira)",
  areas:       "Essas são as áreas que eu sugiro — as gavetas do cérebro. Pode tirar ou acrescentar.",
  sources:     "De onde vem a informação hoje? Cada fonte tem a sua receita — é isso que deixa o fato certo.",
  sensitivity: "Última coisa: tem informação sensível aí dentro? Preço, salário, contrato…",
};

/** ordem determinística da coleta. A IA NUNCA decide isto (anti-loop, padrão M11-S4). */
const NEXT: Record<WizardStep, WizardStep> = {
  purpose: "areas", areas: "sources", sources: "sensitivity",
  sensitivity: "review", review: "done", done: "done",
};

/** bolha inicial do wizardStart (mockup) — vem ANTES da primeira pergunta. */
const INTRO =
  "Vou montar esse cérebro com você, antes de qualquer documento entrar. " +
  "Quando o cérebro sabe o que guardar, ele para de inventar.";

/** chips por passo — SUGESTÕES DE TEXTO do mockup. O que o usuário clicar volta como `message`
 *  normal; nenhum chip vira ramo de código (ADR-002). NOTA (fix-2): o passo `sources` NÃO usa
 *  `suggestions` — é coleção multi-seleção, servida via `chips` ricos (SOURCE_OPTIONS abaixo). */
const SUGGESTIONS: Record<WizardStep, string[]> = {
  purpose: ["Vendas e clientes", "Financeiro", "Suporte", "A empresa inteira", "Estratégia e conhecimento"],
  areas: ["Pode ser assim", "Tirar a última"],
  sources: [], // coleção → chips toggle+go (não suggestions)
  sensitivity: ["Preços são sigilosos", "Tudo pode ser interno", "Tem coisa secreta"],
  review: [],
  done: [],
};

/** opções de fonte do mockup (linha ~353) — viram chips TOGGLE no passo `sources`. Ordem fixa. */
const SOURCE_OPTIONS = ["WhatsApp", "Calls de vendas", "E-mail", "Planilhas", "Reuniões internas"];
const GO_CHIP_LABEL = "Pronto →"; // único chip que AVANÇA o passo de coleção (mockup confirmFontes)

/** presets 100% determinísticos por chip do passo `purpose` — ver deterministicChip() abaixo: clicar
 *  num chip conhecido não precisa de IA, a resposta já é previsível por construção. */
/** Presets REVISADOS pelo PO (decisão do fundador: "empresa vai além de preço"): todo preset de
 *  negócio carrega o núcleo transversal de conhecimento — estrategia/mercado/aprendizados — além
 *  do operacional. Teto 8 áreas (área é gaveta de guarda + unidade de RBAC + alvo de receita;
 *  sobrando vira ruído triplo). "decisoes" NÃO é área: decisão é dimensão de extração e mora na
 *  área do assunto dela. Slugs canônicos entre presets (concorrencia/concorrentes → mercado). */
const PURPOSE_PRESETS: Record<string, { purpose: string; name: string; label: string; areas: string[] }> = {
  "Vendas e clientes": {
    purpose: "Vendas e clientes da empresa",
    name: "vendas-e-clientes",
    label: "Vendas e Clientes",
    areas: ["vendas", "clientes", "propostas", "precos", "marketing", "mercado", "estrategia", "aprendizados"],
  },
  "Financeiro": {
    purpose: "Financeiro da empresa",
    name: "financeiro",
    label: "Financeiro",
    areas: ["financeiro", "contas-a-pagar", "contas-a-receber", "fornecedores", "impostos", "estrategia", "aprendizados"],
  },
  "Suporte": {
    purpose: "Suporte e atendimento a clientes",
    name: "suporte",
    label: "Suporte",
    areas: ["suporte", "clientes", "problemas", "produtos", "aprendizados"],
  },
  "A empresa inteira": {
    purpose: "A empresa inteira",
    name: "empresa",
    label: "Empresa",
    areas: ["vendas", "clientes", "financeiro", "operacao", "time", "estrategia", "mercado", "aprendizados"],
  },
  "Estratégia e conhecimento": {
    purpose: "Estratégia, mercado e aprendizados da empresa",
    name: "estrategia-e-conhecimento",
    label: "Estratégia e Conhecimento",
    areas: ["estrategia", "mercado", "metas", "riscos", "aprendizados", "projetos"],
  },
};

/** mapa determinístico do chip do passo `sensitivity` pro nível (mesmo enum de coerceSensitivity). */
const SENSITIVITY_CHIP_MAP: Record<string, string> = {
  "Preços são sigilosos": "sensivel",
  "Tudo pode ser interno": "interno",
  "Tem coisa secreta": "restrito",
};

// ---------- helpers ----------

/** slug curto/estável minúsculo (cópia de bff-onboarding.ts — módulos independentes). */
function slugify(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/** P1-C — id DETERMINÍSTICO da fonte no confirm: re-confirm (retry após falha no meio) faz
 *  upsert idempotente (on conflict (brain,id) do upsertSource), nunca fonte duplicada. O wizard
 *  já impede nome duplicado no draft (findSourceIndex). [ÁRBITRO] nenhum front lê id de fonte do
 *  retorno de wizardConfirm (só r.brain) — id determinístico é seguro de trocar. */
function sourceIdFor(brainSlug: string, name: string): string {
  return createHash("sha256").update(`${brainSlug}|${slugify(name)}`).digest("hex").slice(0, 32);
}

function emptyDraft(): WizardDraft {
  return {
    name: "", label: "", purpose: "", selfSlug: "", selfLabel: "",
    areas: [], sources: [], sensitivity: "",
  };
}

/** copia profunda do draft (nunca compartilha arrays mutáveis entre turnos). */
function cloneDraft(d: WizardDraft | undefined | null): WizardDraft {
  if (!d || typeof d !== "object") return emptyDraft();
  return {
    name: String(d.name ?? ""),
    label: String(d.label ?? ""),
    purpose: String(d.purpose ?? ""),
    selfSlug: String(d.selfSlug ?? ""),
    selfLabel: String(d.selfLabel ?? ""),
    areas: Array.isArray(d.areas) ? d.areas.map(String) : [],
    sources: Array.isArray(d.sources)
      ? d.sources.map((s) => ({
          name: String(s?.name ?? ""),
          channel: s?.channel === "paste" ? "paste" as const : "upload" as const,
          type: String(s?.type ?? ""),
          recipe: {
            fields: Array.isArray(s?.recipe?.fields)
              ? s.recipe.fields.map((f: any) => ({
                  dimension: String(f?.dimension ?? ""),
                  label: String(f?.label ?? ""),
                  area: String(f?.area ?? ""),
                }))
              : [],
            ...(s?.recipe?.guidance ? { guidance: String(s.recipe.guidance) } : {}),
            ...(s?.recipe?.triage_profile ? { triage_profile: String(s.recipe.triage_profile) } : {}),
          },
          default_sensitivity: String(s?.default_sensitivity ?? ""),
        }))
      : [],
    sensitivity: String(d.sensitivity ?? ""),
  };
}

function coerceSensitivity(level: any): string {
  return SENSITIVITY_LEVELS.includes(level) ? String(level) : "restrito";
}

/** nível legível — MESMO vocabulário do LockChip do front. */
function sensitivityLabel(level: string): string {
  const map: Record<string, string> = {
    publico: "Aberto", interno: "Interno", sensivel: "Sigiloso", restrito: "Secreto",
  };
  return map[level] ?? "Secreto";
}

// ---------- normalização por IA (1 tool por passo, BOUNDED; degrade SEMPRE fecha) ----------

const TOOLS: Record<Exclude<WizardStep, "review" | "done">, Tool> = {
  purpose: {
    name: "normalizar_proposito_wizard",
    description:
      "Normaliza a resposta livre sobre O QUE o cérebro vai cuidar. purpose = uma frase clara. " +
      "name = slug curto/minúsculo pro cérebro (sem espaços/acentos). label = nome legível. " +
      "selfSlug/selfLabel = dono/empresa SE a resposta citar (senão vazio). " +
      "areas = 4 a 7 slugs de áreas de guarda pra esse propósito (as gavetas do cérebro). " +
      "EQUILÍBRIO (decisão do fundador): as áreas cobrem o dia-a-dia do propósito (operacional) E o " +
      "conhecimento que se acumula — quando o propósito for um negócio ou área de negócio, inclua 1 a 2 " +
      "entre 'estrategia', 'mercado' e 'aprendizados', a menos que o usuário restrinja o escopo. " +
      "Guarda-corpos: NÃO crie área 'decisoes' (decisão é fato e mora na área do assunto); NÃO duplique " +
      "sinônimos (concorrencia/concorrentes → 'mercado'); NÃO invente domínio que não decorre do propósito.",
    input_schema: {
      type: "object",
      properties: {
        purpose: { type: "string", description: "uma frase clara do que o cérebro cuida" },
        name: { type: "string", description: "slug curto minúsculo pro cérebro" },
        label: { type: "string", description: "nome legível do cérebro" },
        selfSlug: { type: "string", description: "slug do dono/empresa, se citado; senão vazio" },
        selfLabel: { type: "string", description: "nome legível do dono, se citado; senão vazio" },
        areas: { type: "array", items: { type: "string" }, description: "4-7 slugs de áreas equilibradas (operacional + estrategia/mercado/aprendizados quando couber)" },
      },
      required: ["purpose", "name", "label", "areas"],
    },
  },
  areas: {
    name: "normalizar_areas",
    description:
      "Aplica o ajuste do usuário na lista de áreas do cérebro e devolve a lista FINAL de slugs " +
      "(minúsculos, sem espaços/acentos). O usuário pode aceitar, tirar ou acrescentar áreas.",
    input_schema: {
      type: "object",
      properties: {
        areas: { type: "array", items: { type: "string" }, description: "lista FINAL de slugs de área" },
      },
      required: ["areas"],
    },
  },
  sources: {
    name: "normalizar_fontes",
    description:
      "Extrai as fontes de informação citadas. name = nome legível. type = slug do tipo de página. " +
      "channel = 'upload' ou 'paste' (v1 só tem esses). fields = campos da receita: dimension = chave " +
      "da dimensão de extração, label = rótulo legível, area = slug de UMA das áreas do cérebro " +
      "(lista no contexto) onde o campo guarda.",
    input_schema: {
      type: "object",
      properties: {
        sources: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              type: { type: "string" },
              channel: { type: "string", enum: ["upload", "paste"] },
              fields: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    dimension: {
                      type: "string",
                      description:
                        "chave da dimensão de extração — UMA das dimensões listadas no contexto; NUNCA invente nem derive do nome da fonte",
                    },
                    label: { type: "string" },
                    area: { type: "string" },
                  },
                  required: ["dimension", "label", "area"],
                },
              },
            },
            required: ["name", "type", "channel", "fields"],
          },
        },
      },
      required: ["sources"],
    },
  },
  sensitivity: {
    name: "normalizar_sigilo",
    description:
      "Mapeia a resposta livre sobre sigilo pro nível padrão de entrada. default = o nível que melhor " +
      "traduz a resposta. perSource = exceções por fonte, SE o usuário distinguir fontes.",
    input_schema: {
      type: "object",
      properties: {
        default: { type: "string", enum: [...SENSITIVITY_LEVELS] },
        perSource: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              level: { type: "string", enum: [...SENSITIVITY_LEVELS] },
            },
            required: ["name", "level"],
          },
        },
      },
      required: ["default"],
    },
  },
};

/** contexto determinístico que acompanha a mensagem (a IA precisa ver o draft pra ajustar listas). */
function stepContext(step: Exclude<WizardStep, "review" | "done">, draft: WizardDraft): string {
  if (step === "areas") return draft.areas.length ? `Áreas atuais: ${draft.areas.join(", ")}.` : "Áreas atuais: nenhuma.";
  if (step === "sources") {
    // FIX-A (§3.1.5): a IA VÊ o vocabulário fechado de dims de extração (qualidade; a GARANTIA é
    // o pós-filtro de mergeSourcesIntoDraft que dropa o que não estiver aqui). Síncrono/determinístico.
    const vocab = [
      ...new Set([
        ...DEFAULT_EXTRACT_DIMS,
        ...Object.values(loadSchemaPack(draft.name).extractable).flatMap((sp) => sp.eval_dimensions ?? []),
      ]),
    ];
    const areasLine = draft.areas.length ? `Áreas do cérebro: ${draft.areas.join(", ")}. ` : "";
    return `${areasLine}Dimensões de extração disponíveis (fields.dimension SÓ pode usar estas): ${vocab.join(", ")}.`;
  }
  if (step === "sensitivity" && draft.sources.length) return `Fontes: ${draft.sources.map((s) => s.name).join(", ")}.`;
  return "";
}

/** chama a IA pra normalizar 1 resposta livre no step dado. BOUNDED: 1 chamada/turno. Erro/sem
 *  provider → null (o chamador degrada determinístico, sem travar o wizard). */
async function normalize(
  step: Exclude<WizardStep, "review" | "done">,
  message: string,
  draft: WizardDraft,
): Promise<any | null> {
  // GALEED_PROVIDER setado VAZIO = IA explicitamente desligada (smoke/CI) → degrade determinístico.
  // (var não-setada segue a resolução normal: cli por assinatura ou api por key.)
  if (process.env.GALEED_PROVIDER === "") return null;
  let provider: Provider;
  try {
    provider = resolveProvider(config().provider);
  } catch (err) {
    console.error(`[wizard] sem provider de IA no passo '${step}' — seguindo no degrade determinístico:`, err instanceof Error ? err.message : err);
    return null;
  }
  const cfg = config();
  const model = provider === "cli" ? cfg.cliModel : cfg.apiModel;
  const tool = TOOLS[step];
  const system =
    "Você normaliza a resposta livre de um usuário em campos estruturados pra montar a estrutura de um " +
    "cérebro de memória (propósito, áreas, fontes com receita, sigilo). Use SOMENTE a informação da " +
    "resposta e do contexto — nunca invente domínio. Responda em português.";
  const ctx = stepContext(step, draft);
  try {
    return await structured({
      provider,
      model,
      system,
      prompt: ctx ? `${ctx}\n\nResposta do usuário: ${message}` : message,
      tool,
      dims: [tool.name],
    });
  } catch (err) {
    console.error(`[wizard] normalização por IA falhou no passo '${step}' (provider ${provider}) — degrade determinístico:`, err instanceof Error ? err.message : err);
    return null;
  }
}

/** FIX-A: o TIPO EFETIVO de extração das páginas desta fonte = o MESMO funil de capture.ts:36
 *  (resolveTipo/TYPE_ALIAS). É por ESTA chave que getExtractSchema resolve as dims que o tool
 *  de extração emitirá (extract.ts:167). Wizard e extração falam o mesmo vocabulário POR
 *  CONSTRUÇÃO. Se capture.ts mudar o funil, o teste de invariante (§6.2-c) quebra JUNTO. */
export function effectiveExtractType(type: string): string {
  return resolveTipo(type);
}

/** FIX-A: dims REAIS que a extração emitirá pro tipo (pack do brain → DEFAULT_EXTRACT_DIMS).
 *  NUNCA inventa; NUNCA deriva do nome. Brain ainda não existe no wizard ⇒ resolve pack-env
 *  (GALEED_SCHEMA_PACK[_<BRAIN>]) ou EMPTY_PACK → DEFAULT_EXTRACT_DIMS (determinístico). */
export function realRecipeDims(home: string, type: string): string[] {
  try {
    return extractableDims(home, effectiveExtractType(type));
  } catch {
    return [...DEFAULT_EXTRACT_DIMS];
  }
}

/** fields da receita a partir das dims REAIS do tipo: {dimension:d, label:d, area:1ª área}.
 *  Substitui defaultFields (que passava o slug do NOME como type). */
function realRecipeFields(home: string, type: string, areas: string[]): SourceRecipe["fields"] {
  return realRecipeDims(home, type).map((d) => ({ dimension: d, label: d, area: areas[0] ?? "" }));
}

/** monta uma WizardSourceDraft determinística a partir de um nome (toggle / degrade / free-text
 *  sem IA). A receita vem das dims REAIS do tipo EFETIVO — IGUAL ao funil capture/extração. */
export function makeSourceDraft(name: string, draft: WizardDraft): WizardSourceDraft {
  const clean = name.trim();
  const type = slugify(clean);
  return {
    name: clean,
    channel: "upload",
    type,
    recipe: { fields: realRecipeFields(draft.name, type, draft.areas) },
    default_sensitivity: draft.sensitivity || "",
  };
}

/** procura uma fonte no draft por nome (case/acento-insensível via slug do nome). */
function findSourceIndex(draft: WizardDraft, name: string): number {
  const key = slugify(name);
  return draft.sources.findIndex((s) => slugify(s.name) === key);
}

/** toggle de UMA fonte (chip): adiciona se ausente, remove se presente. Espelha `toggleFonte`. */
function toggleSource(draft: WizardDraft, name: string): void {
  const i = findSourceIndex(draft, name);
  if (i >= 0) draft.sources.splice(i, 1);
  else draft.sources.push(makeSourceDraft(name, draft));
}

/** adiciona fontes por nome SEM duplicar (texto livre / correção tardia). Devolve as ADICIONADAS. */
function addSourcesByName(draft: WizardDraft, names: string[]): string[] {
  const added: string[] = [];
  for (const raw of names) {
    const name = raw.trim();
    if (!name) continue;
    if (findSourceIndex(draft, name) >= 0) continue;
    draft.sources.push(makeSourceDraft(name, draft));
    added.push(name);
  }
  return added;
}

/** parser determinístico (degrade) de MÚLTIPLAS fontes numa frase livre — fallback SEM IA. Quebra por
 *  vírgula/; e pelo conectivo " e ", limpa preâmbulo de correção, parênteses ("Conta Azul (meu ERP)")
 *  e stopwords. Conservador: nunca inventa. (Com IA, normalizar_fontes extrai melhor.) */
function parseSourceNames(text: string): string[] {
  let t = " " + text.trim().replace(/\s+/g, " ") + " ";
  // protege "e-mail"/"email" do split por " e " e da limpeza de hífen.
  t = t.replace(/\be[-\s]?mails?\b/gi, " __EMAIL__ ");
  // tira preâmbulo de correção: tudo ATÉ (e incluindo) "vem (também) de/do/da" ou "uso/tenho".
  t = t.replace(/.*?\b(?:v[eê]m|vem)(?:\s+tamb[ée]m)?\s+(?:de|do|da|dos|das)\b/i, " ");
  t = t.replace(/.*?\b(?:uso|usamos|tenho|temos|al[ée]m\s+disso)\b\s*/i, " ");
  // conectivos → vírgula (\b(e)\b agora é seguro: e-mail já está protegido).
  t = t.replace(/\s+\be\b\s+/gi, ", ").replace(/\b(tamb[ée]m|mais)\b/gi, ",").replace(/[;/]+/g, ",");
  const chunks = t
    .split(",")
    .map((s) =>
      s
        .replace(/\([^)]*\)/g, " ")            // "Conta Azul (meu ERP)" → "Conta Azul"
        .replace(/\b(meu|minha)\s+erp\b/gi, " ")
        .replace(/[^\p{L}\p{N}\s_-]+/gu, " ")
        .replace(
          /\b(de|do|da|dos|das|meu|minha|meus|minhas|as|os|um|uma|uns|umas|apenas|s[óo]|que|n[ãa]o|informa[çc][õo]es|vem|v[eê]m|tamb[ée]m|mais|por|a[íi]|a[íi]nda|ah|outra|outras|alguma|algumas|coisa|coisas|tem|t[eê]m|tenho|temos|uso|usamos|fonte|fontes|esqueci|tamb[ée]m|aqui|tudo|isso)\b/gi,
          " ",
        )
        .replace(/\s+/g, " ")
        .replace(/__EMAIL__/g, "e-mail")
        .trim(),
    )
    .filter((s) => s.length >= 2);
  // conservador (invariante "nunca inventa"): rejeita filler residual por slug — `\b` do JS não
  // ancora bem em acento ("aí"), então o stoplist abaixo é a rede final. Mantém nomes reais.
  const FILLER = new Set([
    "ai", "ah", "tem", "por", "mais", "uma", "um", "uns", "umas", "outra", "outras", "alguma",
    "algumas", "coisa", "coisas", "fonte", "fontes", "aqui", "tudo", "isso", "ainda", "ja", "tipo",
  ]);
  return chunks
    .filter((s) => !FILLER.has(slugify(s)))
    .filter((s, i, arr) => arr.findIndex((x) => slugify(x) === slugify(s)) === i)
    .slice(0, 12);
}

/** detecta se uma frase de texto livre FALA DE FONTES (em passos que não são `sources`): heurística
 *  determinística — palavras de canal/fonte conhecidas. Conservador (não dispara em sigilo puro). */
const SOURCE_HINTS =
  /\b(whats[\s-]?app|planilh|excel|e-?mail|email|conta\s+azul|erp|call|liga[çc]|reuni|crm|pdf|drive|sheets|notion|slack|telegram|sistema|plataforma|fonte)\b/i;
function mentionsSources(text: string): boolean {
  return SOURCE_HINTS.test(text);
}

/** MERGE de fontes no draft (fix-2). Usa a saída da IA (normalizar_fontes) se houver; senão o
 *  parser determinístico da frase. NUNCA substitui o que já existe — só adiciona o que falta (a
 *  multi-seleção por toggle convive com a correção por texto). Devolve os nomes ADICIONADOS. */
export function mergeSourcesIntoDraft(draft: WizardDraft, msg: string, ai: any | null): string[] {
  const added: string[] = [];
  if (Array.isArray(ai?.sources) && ai.sources.length) {
    for (const s of ai.sources as any[]) {
      const name = String(s?.name ?? "").trim();
      if (!name || findSourceIndex(draft, name) >= 0) continue;
      const type = slugify(String(s?.type ?? "")) || slugify(name);
      // FIX-A (§3.1.3): a IA NÃO escolhe dims (v1 = vocabulário FECHADO). A receita = EXATAMENTE
      // as dims REAIS do tipo (ordem do pack); a IA só ENRIQUECE label/area das que citou. Dim
      // inventada (eco do nome) é DROPADA com rastro (invariante #5).
      const real = realRecipeDims(draft.name, type);
      const realSet = new Set(real);
      const aiFields = new Map<string, { label: string; area: string }>();
      const dropadas: string[] = [];
      for (const f of Array.isArray(s?.fields) ? s.fields : []) {
        const dim = String(f?.dimension ?? "").trim();
        if (!dim) continue;
        if (!realSet.has(dim)) { dropadas.push(dim); continue; } // dim inventada → DROPA (com rastro)
        aiFields.set(dim, {
          label: String(f?.label ?? dim),
          // área fora do draft → "" (a receita nunca aponta gaveta que não existe).
          area: draft.areas.includes(slugify(String(f?.area ?? ""))) ? slugify(String(f.area)) : "",
        });
      }
      const fields = real.map((d) => ({
        dimension: d,
        label: aiFields.get(d)?.label ?? d,
        area: aiFields.get(d)?.area ?? (draft.areas[0] ?? ""),
      }));
      if (dropadas.length)
        console.log(`[wizard-receita] dims fora do vocabulário do tipo '${type}' dropadas: ${dropadas.join(", ")}`);
      draft.sources.push({
        name,
        channel: s?.channel === "paste" ? "paste" : "upload",
        type,
        recipe: { fields },
        default_sensitivity: draft.sensitivity || "",
      });
      added.push(name);
    }
    return added;
  }
  // degrade determinístico: parseia múltiplas fontes da frase e adiciona sem duplicar.
  return addSourcesByName(draft, parseSourceNames(msg));
}

/** aplica a resposta (normalizada por IA, ou degradada determinística) no draft, p/ o step dado. */
function applyToDraft(
  step: Exclude<WizardStep, "review" | "done">,
  draft: WizardDraft,
  message: string,
  ai: any | null,
): void {
  const msg = message.trim();
  switch (step) {
    case "purpose": {
      draft.purpose = (ai?.purpose && String(ai.purpose)) || msg;
      draft.name = slugify((ai?.name && String(ai.name)) || msg) || slugify(msg);
      draft.label = (ai?.label && String(ai.label)) || msg;
      draft.selfSlug = ai?.selfSlug ? slugify(String(ai.selfSlug)) : "";
      draft.selfLabel = ai?.selfLabel ? String(ai.selfLabel) : "";
      // degrade: areas=[] — o usuário lista no próximo passo.
      draft.areas = Array.isArray(ai?.areas) ? ai.areas.map((a: any) => slugify(String(a))).filter(Boolean) : [];
      break;
    }
    case "areas": {
      if (Array.isArray(ai?.areas)) {
        draft.areas = ai.areas.map((a: any) => slugify(String(a))).filter(Boolean);
      } else if (msg) {
        // degrade: split por vírgula/; + merge com as atuais (sem duplicar).
        const extra = msg.split(/[,;]+/).map((s) => slugify(s.trim())).filter(Boolean);
        draft.areas = [...new Set([...draft.areas, ...extra])];
      }
      break;
    }
    case "sources": {
      // fix-2: ADICIONA fontes (texto livre é cumulativo com os toggles já no draft), nunca
      // substitui em silêncio. Sem msg (ex.: só toggles já aplicados) → não mexe.
      mergeSourcesIntoDraft(draft, msg, ai);
      break;
    }
    case "sensitivity": {
      // falha-fechado: sem IA (ou nível fora do enum) → 'restrito'.
      const def = coerceSensitivity(ai?.default);
      draft.sensitivity = def;
      const perSource = Array.isArray(ai?.perSource) ? ai.perSource : [];
      for (const s of draft.sources) {
        const over = perSource.find((p: any) => String(p?.name ?? "").trim().toLowerCase() === s.name.trim().toLowerCase());
        s.default_sensitivity = over ? coerceSensitivity(over.level) : def;
      }
      break;
    }
  }
}

// ---------- painel + cartão (DETERMINÍSTICOS — sem IA, sem custo, sem alucinação) ----------

/** projeção determinística do draft pro painel "cérebro se montando". */
function renderPanel(step: WizardStep, d: WizardDraft): WizardPanel {
  const status =
    step === "review" || step === "done"
      ? "pronto pra nascer"
      : d.purpose
        ? "estrutura em definição"
        : "se montando…";
  const rules: string[] = [];
  if (d.sensitivity) {
    rules.push(
      `Tudo entra como ${sensitivityLabel(d.sensitivity)} por padrão. Você abre pra quem quiser em Acesso.`,
      "O que a receita não reconhecer vira hipótese e espera revisão. Nunca vira fato sozinho.",
    );
  }
  return {
    name: d.label || "Cérebro sem nome",
    status,
    purpose: d.purpose,
    areas: [...d.areas],
    sources: d.sources.map((s) => ({
      name: s.name,
      fields: s.recipe.fields.map((f) => f.label || f.dimension),
      areas: [...new Set(s.recipe.fields.map((f) => f.area).filter(Boolean))],
    })),
    rules,
  };
}

/** cartão-resumo DETERMINÍSTICO (padrão renderCardSync do M11-S4). É a tradução
 *  estrutura→linguagem-natural exigida pelo invariante (ADR-005-d) — nunca JSON. */
function renderCard(d: WizardDraft): string {
  const areas = d.areas.join(" · ");
  const fontes = d.sources.map((s) => s.name).join(", ");
  const nivel = sensitivityLabel(d.sensitivity || "restrito");
  return (
    `O cérebro ${d.label || d.name || "novo"} nasceu com estrutura: ${d.areas.length} áreas (${areas}), ` +
    `${d.sources.length} fontes com receita (${fontes}), e tudo entra como ${nivel} por padrão. ` +
    `O que a receita não reconhecer vira hipótese e espera a sua revisão — nunca vira fato sozinho.`
  );
}

/** chips RICOS do passo `sources` (fix-2): um toggle por opção do mockup (com `selected` refletindo
 *  o draft) + as fontes EXTRA que o usuário adicionou por texto (também como toggle marcado, pra que
 *  ele possa removê-las) + o chip `go` "Pronto →". Nos outros passos: []. */
function chipsFor(step: WizardStep, d: WizardDraft): WizardChip[] {
  if (step !== "sources") return [];
  const selected = new Set(d.sources.map((s) => slugify(s.name)));
  const labels = [...SOURCE_OPTIONS];
  // fontes adicionadas por texto livre que não estão no catálogo viram chips marcados também.
  for (const s of d.sources) {
    if (!labels.some((l) => slugify(l) === slugify(s.name))) labels.push(s.name);
  }
  const chips: WizardChip[] = labels.map((label) => ({
    label,
    kind: "toggle",
    selected: selected.has(slugify(label)),
  }));
  chips.push({ label: GO_CHIP_LABEL, kind: "go" });
  return chips;
}

/** `note` (fix-2): bolha de IA EXTRA antes da pergunta, p/ confirmar o que foi feito (ex.: "adicionei
 *  X, Y"). Quando presente, o front mostra a nota como bolha e re-pergunta o passo. */
function turn(
  step: WizardStep,
  draft: WizardDraft,
  asked: string[],
  opts?: { intro?: boolean; note?: string },
): WizardTurn {
  const isCollect = step === "purpose" || step === "areas" || step === "sources" || step === "sensitivity";
  // Degrade honesto: se a IA não sugeriu áreas (sem provider / falha), NÃO finge que sugeriu —
  // pede pro usuário listar. Os chips "Pode ser assim / Tirar a última" também não fazem sentido aí.
  const areasVazias = step === "areas" && draft.areas.length === 0;
  const base = areasVazias
    ? "Quais áreas esse cérebro deve guardar — as gavetas dele? Me diz separado por vírgula (ex.: clientes, financeiro, propostas)."
    : isCollect
      ? QUESTIONS[step as Exclude<WizardStep, "review" | "done">]
      : "";
  const intro = opts?.intro && isCollect ? `${INTRO} ` : "";
  const note = opts?.note ? `${opts.note} ` : "";
  const question = isCollect ? `${intro}${note}${base}` : "";
  return {
    state: { step, draft, asked },
    question,
    card: step === "review" || step === "done" ? renderCard(draft) : "",
    suggestions: areasVazias ? [] : [...SUGGESTIONS[step]],
    chips: chipsFor(step, draft),
    panel: renderPanel(step, draft),
    done: step === "done",
  };
}

// ---------- chip determinístico (turno instantâneo, sem IA) ----------

/** efeito de um chip determinístico: 'advance' = já aplicou no draft, wizardReply segue o MESMO
 *  caminho que a IA levaria (asked.push + avança pro próximo passo); 'stay' = o turno final já vem
 *  pronto (early return), caso do "Tirar a última" que fica no passo `areas`. */
type ChipEffect = { kind: "advance" } | { kind: "stay"; turn: WizardTurn };

/** PORQUÊ: quando o usuário clica num CHIP conhecido (as sugestões fixas de SUGGESTIONS), a resposta
 *  é 100% previsível — não há nada pra "normalizar". Chamar a IA (normalize(), 10-15s no provider
 *  cli) só pra reconhecer um texto que já é EXATAMENTE um dos chips é custo puro sem ganho: aqui
 *  aplicamos o resultado determinístico direto e devolvemos turno instantâneo. Comparação com
 *  SUGGESTIONS é EXATA e case-sensitive — texto livre (mesmo que pareça um chip) cai pro caminho
 *  normal com normalize(). `null` = não bateu nenhum chip do passo. */
function deterministicChip(
  step: Exclude<WizardStep, "review" | "done">,
  message: string,
  draft: WizardDraft,
  asked: string[],
): ChipEffect | null {
  const msg = message.trim();
  if (!SUGGESTIONS[step].includes(msg)) return null;

  if (step === "purpose") {
    const preset = PURPOSE_PRESETS[msg];
    if (!preset) return null;
    draft.purpose = preset.purpose;
    draft.name = slugify(preset.name);
    draft.label = preset.label;
    draft.selfSlug = "";
    draft.selfLabel = "";
    draft.areas = [...preset.areas];
    return { kind: "advance" };
  }

  if (step === "areas") {
    if (msg === "Pode ser assim") return { kind: "advance" }; // mantém como está, avança normal.
    if (msg === "Tirar a última") {
      if (draft.areas.length === 0) {
        return {
          kind: "stay",
          turn: turn("areas", draft, asked, { note: "Não há área pra tirar — me diz as áreas separado por vírgula." }),
        };
      }
      const removida = draft.areas.pop()!;
      return {
        kind: "stay",
        turn: turn("areas", draft, asked, { note: `Tirei "${removida}". Ficou: ${draft.areas.join(" · ")}.` }),
      };
    }
    return null;
  }

  if (step === "sensitivity") {
    const level = SENSITIVITY_CHIP_MAP[msg];
    if (!level) return null;
    draft.sensitivity = coerceSensitivity(level);
    // replica pra todas as fontes já no draft — mesmo comportamento do caminho com IA (applyToDraft).
    for (const s of draft.sources) s.default_sensitivity = draft.sensitivity;
    return { kind: "advance" };
  }

  return null;
}

// ---------- API pública (web-server.ts roteia ISTO; zona neutra — pendência no ARTIFACTS) ----------

/** Bolha inicial + primeira pergunta + estado vazio. O brain ainda NÃO existe. */
export async function wizardStart(): Promise<WizardTurn> {
  return turn("purpose", emptyDraft(), [], { intro: true });
}

/** Processa a mensagem do usuário no step atual: NORMALIZA (IA bounded, ≤1 chamada) → preenche o
 *  draft → avança o step (determinístico — a IA NUNCA decide o passo). No fim da coleta devolve
 *  step:"review" com o cartão legível. */
export async function wizardReply(
  inp: { state: WizardState; message: string; action?: "toggle" | "go" },
): Promise<WizardTurn> {
  if (!inp || !inp.state || typeof inp.state.step !== "string") {
    throw new BffError(400, "estado do wizard ausente ou inválido");
  }
  const step = inp.state.step;
  const message = typeof inp.message === "string" ? inp.message : "";
  const action = inp.action === "toggle" || inp.action === "go" ? inp.action : undefined;
  const draft = cloneDraft(inp.state.draft);
  const asked = [...(Array.isArray(inp.state.asked) ? inp.state.asked : [])];

  // ----- passo `sources`: COLEÇÃO multi-seleção (fix-2). Toggle/texto NÃO avançam; só `go`. -----
  if (step === "sources") {
    if (action === "go") {
      asked.push(QUESTIONS[step]);
      return turn(NEXT[step], draft, asked); // "Pronto →" → sensitivity
    }
    if (action === "toggle") {
      // clique num chip de fonte: liga/desliga no draft, painel re-renderiza, FICA no passo. Sem IA.
      if (message.trim()) toggleSource(draft, message);
      return turn("sources", draft, asked);
    }
    // texto livre no passo de fontes: ADICIONA múltiplas fontes (IA bounded, degrade parseia), FICA.
    const before = draft.sources.length;
    const ai = await normalize("sources", message, draft);
    const added = mergeSourcesIntoDraft(draft, message, ai);
    const note =
      added.length > 0
        ? `Anotei ${added.join(", ")} — sugiro a receita assim que você conectar.`
        : message.trim() && draft.sources.length === before
          ? "Não consegui identificar uma fonte aí — marca os chips ou escreve o nome da fonte."
          : "";
    return turn("sources", draft, asked, { note });
  }

  // step de coleta restante: normaliza (IA, bounded) e aplica no draft; avança SEMPRE (anti-trava).
  if (step === "purpose" || step === "areas") {
    // chip conhecido (SUGGESTIONS) → resposta determinística, sem IA (turno instantâneo).
    const chip = deterministicChip(step, message, draft, asked);
    if (chip) {
      if (chip.kind === "stay") return chip.turn;
      asked.push(QUESTIONS[step]);
      return turn(NEXT[step], draft, asked);
    }
    const ai = await normalize(step, message, draft);
    applyToDraft(step, draft, message, ai);
    asked.push(QUESTIONS[step]);
    return turn(NEXT[step], draft, asked);
  }

  // ----- passo `sensitivity`: pode chegar uma CORREÇÃO de FONTES por texto livre (caso do HTC).
  //  Nunca engole: se a frase fala de fontes, adiciona-as, responde o que adicionou e RE-pergunta o
  //  sigilo (não avança). Se for resposta de sigilo de verdade, segue o fluxo normal. -----
  if (step === "sensitivity") {
    // chip conhecido (SUGGESTIONS) → resposta determinística, sem IA (turno instantâneo).
    // Vem ANTES da detecção de correção de fontes: clique em chip exato nunca é "correção".
    const chip = deterministicChip(step, message, draft, asked);
    if (chip) {
      if (chip.kind === "stay") return chip.turn;
      asked.push(QUESTIONS[step]);
      return turn(NEXT[step], draft, asked);
    }
    if (message.trim() && mentionsSources(message)) {
      const before = draft.sources.length;
      const ai = await normalize("sources", message, draft);
      const added = mergeSourcesIntoDraft(draft, message, ai);
      if (added.length > 0) {
        const note = `Você tem razão — adicionei ${added.join(", ")} às fontes. ${plural(draft.sources.length)} agora.`;
        return turn("sensitivity", draft, asked, { note }); // re-pergunta o sigilo, NÃO avança
      }
      if (draft.sources.length === before) {
        // degrade sem IA / não entendeu: responde honestamente e re-pergunta (nunca engole).
        return turn("sensitivity", draft, asked, {
          note: "Acho que você quis corrigir as fontes, mas não consegui identificar quais — pode listar separando por vírgula?",
        });
      }
    }
    const ai = await normalize("sensitivity", message, draft);
    applyToDraft("sensitivity", draft, message, ai);
    asked.push(QUESTIONS[step]);
    return turn(NEXT[step], draft, asked);
  }

  // step "review": correção de FONTES por texto livre também é respeitada aqui (mesma regra do
  //  sigilo). Senão, mensagem livre = ajuste de propósito. Recompõe o cartão e FICA no review.
  if (step === "review") {
    if (message.trim() && mentionsSources(message)) {
      // fala de fontes → trata como correção de fontes; NUNCA cai pro ajuste de propósito (anti-engolir).
      const ai = await normalize("sources", message, draft);
      mergeSourcesIntoDraft(draft, message, ai);
      return turn("review", draft, asked);
    }
    if (message.trim()) {
      const ai = await normalize("purpose", message, draft);
      if (ai?.purpose) draft.purpose = String(ai.purpose);
      else draft.purpose = message.trim();
    }
    return turn("review", draft, asked);
  }

  // step "done" (ou desconhecido): nada a coletar; devolve o cartão final.
  return turn("done", draft, asked);
}

/** "N fontes" legível. */
function plural(n: number): string {
  return `${n} ${n === 1 ? "fonte" : "fontes"}`;
}

/** Cria o brain + grava tudo (transação lógica, ordem fixa). `accountId` vem da sessão. */
export async function wizardConfirm(
  accountId: string,
  inp: { state: WizardState },
): Promise<{ card: string; brain: { id: string; name: string } }> {
  if (!inp || !inp.state || !inp.state.draft || typeof inp.state.draft !== "object") {
    throw new BffError(400, "estado do wizard ausente ou inválido");
  }
  if (!accountId) throw new BffError(401, "não autenticado");
  const d = cloneDraft(inp.state.draft);

  // a+b. POSSE ATÔMICA do slug (P1-C: advisory lock fecha o TOCTOU do brainExists→addBrainMembership).
  const slug = slugify(d.name);
  if (!slug) throw new BffError(400, "dê um nome pro cérebro.");
  try {
    await claimBrainSlug(accountId, slug);
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    if (m === "esse nome de cérebro já existe — escolha outro.") throw new BffError(409, m);
    throw err;
  }

  try {
    // c. contexto M11 (self pode ficar vazio — o onboarding /comecar completa depois).
    await saveBrainContext(slug, {
      self: { slug: d.selfSlug, label: d.selfLabel, aliases: [] },
      purpose: d.purpose,
      roles: d.selfSlug ? [{ role: "self", speakers: [], label: d.selfLabel || d.selfSlug }] : [],
      sourceTypes: d.sources.map((s) => ({ type: s.type, label: s.name, otherRole: "other" as const })),
    });

    // d. schema-pack M13 — MERGE (ADR-016) sob DUAS chaves: s.type (retrocompat: /api/sources e o
    //    teste m21-wizard leem extractable[s.type]) E o tipo EFETIVO (a chave que a extração LÊ —
    //    é o que fecha o gate por construção). União idempotente; nunca remove.
    await mergeRecipeDimsIntoPack(
      slug,
      d.sources.flatMap((s) => {
        const dims = s.recipe.fields.map((f) => f.dimension);
        const eff = effectiveExtractType(s.type);
        return eff === s.type
          ? [{ type: s.type, dims }]
          : [{ type: s.type, dims }, { type: eff, dims }];
      }),
    );

    // e. fontes S1 — P1-C: sigilo POR FONTE (o que o passo 4 coletou em s.default_sensitivity
    //    vence; fallback: default global do draft; fallback final: 'restrito', falha-fechado) +
    //    id determinístico (idempotência do retry).
    const e = await getEngine(slug);
    for (const s of d.sources) {
      const row: SourceRow = {
        id: sourceIdFor(slug, s.name),
        name: s.name,
        channel: s.channel,
        type: s.type,
        recipe: s.recipe,
        default_sensitivity: s.default_sensitivity || d.sensitivity || "restrito",
        status: "ativa",
        last_read_at: null,
      };
      await e.upsertSource(row);
    }
  } catch (err) {
    // P1-C — compensação: falha em c/d/e desfaz a posse (sem membership órfã); os upserts de
    // contexto/pack/fonte são idempotentes — um retry do confirm reconstrói tudo do zero.
    await removeBrainOwnership(accountId, slug).catch(() => {});
    throw err;
  }

  // f. cartão-resumo determinístico + identidade do brain criado.
  return { card: renderCard(d), brain: { id: slug, name: d.label || slug } };
}
