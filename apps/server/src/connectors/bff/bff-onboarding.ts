/** M11/S4 — handlers PUROS do onboarding conversacional (chat BOUNDED → BrainContext).
 *
 *  É o COMO do "brain com contexto configurado": um chat de roteiro FIXO (≤5 perguntas) entrevista
 *  o fundador, a IA (Haiku/provider da config — D2) só NORMALIZA cada resposta livre em campos do
 *  BrainContext, e o handler devolve um cartão-resumo LEGÍVEL (texto) — NUNCA JSON (ADR-005-d).
 *
 *  Handlers puros (recebem home/input, devolvem objeto serializável ou lançam BffError) — espelham
 *  bff-m9.ts. O web-server.ts (zona neutra) só importa estes e roteia (/api/onboarding/*).
 *
 *  Servidor STATELESS: o estado do chat (step + draft parcial + asked) viaja pro front a cada turno
 *  e volta no próximo. O AVANÇO do step é DETERMINÍSTICO (self→purpose→roles→sourceTypes→review); a
 *  IA NUNCA controla o fluxo (anti-loop / anti-custo). Sem provider → degrada determinístico (o
 *  onboarding ainda fecha). Tenant-neutro: o contexto sai das RESPOSTAS do usuário, nada hardcoded.
 *
 *  Motor / core INTOCÁVEIS: só IMPORTA getBrainContext/saveBrainContext (S1) e o provider de LLM. */
import { config } from "../../core/platform/config.ts";
import { resolveProvider, structured, type Provider } from "../../lib/llm.ts";
import type { Tool } from "../../lib/anthropic.ts";
import {
  getBrainContext,
  saveBrainContext,
  type BrainContext,
  type Role,
  type RoleSpec,
  type SourceTypeSpec,
} from "../../core/extraction/brain-context.ts";
import { BffError } from "./bff-common.ts";

export { BffError };

/** As etapas do roteiro bounded (fixas, em ordem). O `state.step` aponta pra próxima. */
export type OnboardingStep = "self" | "purpose" | "roles" | "sourceTypes" | "review" | "done";

/** Estado do chat, devolvido ao front a cada turno e reenviado no próximo (servidor stateless). */
export interface OnboardingState {
  step: OnboardingStep;
  /** acumulado parcial do contexto (interno — o front NÃO renderiza isto cru). */
  draft: Omit<BrainContext, "version">;
  /** histórico mínimo (perguntas já feitas) p/ a IA não repetir. Texto, não JSON exposto. */
  asked: string[];
}

/** Resposta de um turno do chat. `question` = próxima pergunta (linguagem natural). `card` só vem no
 *  step "review"/"done" (resumo legível). `done` = entrevista fechada (pode confirmar). NUNCA expõe JSON. */
export interface OnboardingTurn {
  state: OnboardingState;
  question: string; // "" quando done
  card: string; // "" até o review; no review/done = cartão-resumo legível
  done: boolean;
}

const ROLE_VALUES: Role[] = ["self", "client", "host", "participant", "other"];

/** Roteiro fixo (perguntas em linguagem natural — tenant-neutro). */
const QUESTIONS: Record<Exclude<OnboardingStep, "review" | "done">, string> = {
  self: "Pra começar: de quem ou de qual empresa é esse cérebro? (ex.: o nome da sua empresa ou o seu nome)",
  purpose: "Pra que você vai usar esse cérebro? O que você mais quer lembrar ou consultar depois?",
  roles: "Quem costuma aparecer no que você joga aqui? (ex.: você/sua equipe de um lado, clientes do outro)",
  sourceTypes: "Que tipos de coisa você vai jogar aqui? (ex.: calls de venda, aulas, conversas de suporte)",
};

/** ordem determinística da coleta. A IA NUNCA decide isto. */
const NEXT: Record<OnboardingStep, OnboardingStep> = {
  self: "purpose",
  purpose: "roles",
  roles: "sourceTypes",
  sourceTypes: "review",
  review: "done",
  done: "done",
};

// ---------- helpers ----------

/** slug curto/estável minúsculo (fallback determinístico quando não há IA). */
function slugify(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function coerceRole(r: any): Role {
  return ROLE_VALUES.includes(r) ? (r as Role) : "other";
}

/** copia profunda do draft (nunca compartilha arrays mutáveis entre turnos). */
function cloneDraft(d: Omit<BrainContext, "version">): Omit<BrainContext, "version"> {
  return {
    self: { slug: d.self.slug, label: d.self.label, aliases: [...d.self.aliases] },
    purpose: d.purpose,
    roles: d.roles.map((r) => ({ role: r.role, speakers: [...r.speakers], label: r.label })),
    sourceTypes: d.sourceTypes.map((t) => ({ type: t.type, label: t.label, otherRole: t.otherRole })),
  };
}

// ---------- normalização por IA (1 chamada por turno, BOUNDED) ----------

const TOOLS: Record<Exclude<OnboardingStep, "review" | "done">, Tool> = {
  self: {
    name: "normalizar_self",
    description:
      "Extrai o dono/sujeito do cérebro a partir da resposta livre. slug = identificador curto, " +
      "minúsculo, estável (sem espaços/acentos). label = nome legível. aliases = outras grafias do mesmo.",
    input_schema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "identificador curto, minúsculo, sem espaços/acentos" },
        label: { type: "string", description: "nome legível" },
        aliases: { type: "array", items: { type: "string" }, description: "outras grafias do mesmo" },
      },
      required: ["slug", "label", "aliases"],
    },
  },
  purpose: {
    name: "normalizar_proposito",
    description: "Resume em UMA frase clara pra que o usuário vai usar o cérebro.",
    input_schema: {
      type: "object",
      properties: { purpose: { type: "string", description: "uma frase clara" } },
      required: ["purpose"],
    },
  },
  roles: {
    name: "normalizar_papeis",
    description:
      "Extrai os papéis recorrentes citados. role: self (o dono/equipe), client (o outro lado/clientes), " +
      "host, participant ou other. speakers = nomes citados pra esse papel. label = rótulo legível.",
    input_schema: {
      type: "object",
      properties: {
        roles: {
          type: "array",
          items: {
            type: "object",
            properties: {
              role: { type: "string", enum: ROLE_VALUES },
              speakers: { type: "array", items: { type: "string" } },
              label: { type: "string" },
            },
            required: ["role", "speakers", "label"],
          },
        },
      },
      required: ["roles"],
    },
  },
  sourceTypes: {
    name: "normalizar_tipos",
    description:
      "Extrai os tipos de fonte que o usuário vai jogar no cérebro. type = chave curta minúscula, " +
      "label = rótulo legível, otherRole = papel default de quem NÃO é o dono nesse tipo (client/host/participant/other).",
    input_schema: {
      type: "object",
      properties: {
        sourceTypes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              type: { type: "string" },
              label: { type: "string" },
              otherRole: { type: "string", enum: ROLE_VALUES },
            },
            required: ["type", "label", "otherRole"],
          },
        },
      },
      required: ["sourceTypes"],
    },
  },
};

/** chama a IA pra normalizar 1 resposta livre no step dado. BOUNDED: 1 chamada/turno. Erro/sem
 *  provider → null (o chamador degrada determinístico, sem travar o onboarding). */
async function normalize(
  home: string,
  step: Exclude<OnboardingStep, "review" | "done">,
  message: string,
): Promise<any | null> {
  let provider: Provider;
  try {
    provider = resolveProvider(config(home).provider);
  } catch {
    return null;
  }
  const cfg = config(home);
  const model = provider === "cli" ? cfg.cliModel : cfg.apiModel;
  const tool = TOOLS[step];
  const system =
    "Você normaliza a resposta livre de um usuário em campos estruturados pra montar o contexto de um " +
    "cérebro de memória. Use SOMENTE a informação da resposta — nunca invente domínio. Responda em português.";
  try {
    return await structured({
      provider,
      model,
      system,
      prompt: message,
      tool,
      dims: [tool.name],
    });
  } catch {
    return null;
  }
}

/** aplica a resposta (normalizada por IA, ou degradada determinística) no draft, p/ o step dado. */
function applyToDraft(
  step: Exclude<OnboardingStep, "review" | "done">,
  draft: Omit<BrainContext, "version">,
  message: string,
  ai: any | null,
): void {
  const msg = message.trim();
  switch (step) {
    case "self": {
      const slug = (ai?.slug && String(ai.slug)) || slugify(msg);
      draft.self = {
        slug: slugify(slug) || slugify(msg),
        label: (ai?.label && String(ai.label)) || msg,
        aliases: Array.isArray(ai?.aliases) ? ai.aliases.map(String) : [],
      };
      break;
    }
    case "purpose": {
      draft.purpose = (ai?.purpose && String(ai.purpose)) || msg;
      break;
    }
    case "roles": {
      if (Array.isArray(ai?.roles) && ai.roles.length) {
        draft.roles = (ai.roles as any[]).map((r): RoleSpec => ({
          role: coerceRole(r?.role),
          speakers: Array.isArray(r?.speakers) ? r.speakers.map(String) : [],
          label: String(r?.label ?? ""),
        }));
      } else if (msg) {
        // degrada: guarda a resposta crua como rótulo de um papel "self" + um "client" (anti-trava).
        draft.roles = [
          { role: "self", speakers: [], label: msg },
        ];
      }
      break;
    }
    case "sourceTypes": {
      if (Array.isArray(ai?.sourceTypes) && ai.sourceTypes.length) {
        draft.sourceTypes = (ai.sourceTypes as any[]).map((t): SourceTypeSpec => ({
          type: (t?.type && slugify(String(t.type))) || slugify(String(t?.label ?? "")),
          label: String(t?.label ?? t?.type ?? ""),
          otherRole: coerceRole(t?.otherRole),
        }));
      } else if (msg) {
        // degrada: cada item separado por vírgula vira um tipo (otherRole default = client).
        draft.sourceTypes = msg
          .split(/[,;]+/)
          .map((s) => s.trim())
          .filter(Boolean)
          .map((label): SourceTypeSpec => ({ type: slugify(label), label, otherRole: "client" }));
      }
      break;
    }
  }
}

// ---------- cartão-resumo legível (DETERMINÍSTICO — sem IA, sem custo, sem alucinação) ----------

/** Cartão DETERMINÍSTICO a partir do draft (decisão registrada no ARTIFACTS): mais barato e sem
 *  alucinação. É a tradução JSON→linguagem-natural exigida pelo invariante (ADR-005-d). */
function renderCardSync(ctx: Omit<BrainContext, "version">): string {
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

/** assinatura async pro contrato do DESIGN-SPEC (renderCard(home, ctx)); o corpo é determinístico. */
async function renderCard(_home: string, ctx: Omit<BrainContext, "version">): Promise<string> {
  return renderCardSync(ctx);
}

// ---------- API pública (web-server.ts roteia ISTO) ----------

/** Primeira pergunta + estado inicial (draft herda o contexto atual se já houver). */
export async function onboardingStart(home: string): Promise<OnboardingTurn> {
  const cur = await getBrainContext(home);
  const draft: Omit<BrainContext, "version"> = {
    self: { slug: cur.self.slug, label: cur.self.label, aliases: [...cur.self.aliases] },
    purpose: cur.purpose,
    roles: cur.roles.map((r) => ({ role: r.role, speakers: [...r.speakers], label: r.label })),
    sourceTypes: cur.sourceTypes.map((t) => ({ type: t.type, label: t.label, otherRole: t.otherRole })),
  };
  return {
    state: { step: "self", draft, asked: [] },
    question: QUESTIONS.self,
    card: "",
    done: false,
  };
}

/** Processa a mensagem do usuário no step atual: NORMALIZA → preenche o draft → avança o step
 *  (determinístico). No último step de coleta (ou ao "ajustar" no review), compõe o cartão e
 *  devolve step:"review", card:<texto>, done:false. */
export async function onboardingReply(
  home: string,
  inp: { state: OnboardingState; message: string },
): Promise<OnboardingTurn> {
  if (!inp || !inp.state || typeof inp.state.step !== "string") {
    throw new BffError(400, "estado do onboarding ausente ou inválido");
  }
  const step = inp.state.step;
  const message = typeof inp.message === "string" ? inp.message : "";
  const draft = cloneDraft(inp.state.draft);
  const asked = [...(Array.isArray(inp.state.asked) ? inp.state.asked : [])];

  // step de coleta: normaliza (IA, bounded) e aplica no draft.
  if (step === "self" || step === "purpose" || step === "roles" || step === "sourceTypes") {
    const ai = await normalize(home, step, message);
    applyToDraft(step, draft, message, ai);
    asked.push(QUESTIONS[step]);
    const next = NEXT[step];
    if (next === "review") {
      const card = await renderCard(home, draft);
      return { state: { step: "review", draft, asked }, question: "", card, done: false };
    }
    return {
      state: { step: next, draft, asked },
      question: QUESTIONS[next as Exclude<OnboardingStep, "review" | "done">],
      card: "",
      done: false,
    };
  }

  // step "review": uma mensagem aqui = "ajustar". Re-normaliza como self por padrão? Não: o ajuste
  // livre é tratado como atualização de propósito (campo mais provável de revisão por texto livre);
  // o front também pode reenviar à coleta. Mantém o cartão recomposto. Anti-trava: nunca loopa.
  if (step === "review") {
    if (message.trim()) {
      const ai = await normalize(home, "purpose", message);
      applyToDraft("purpose", draft, message, ai);
    }
    const card = await renderCard(home, draft);
    return { state: { step: "review", draft, asked }, question: "", card, done: false };
  }

  // step "done" (ou desconhecido): nada a coletar; devolve o cartão final.
  const card = await renderCard(home, draft);
  return { state: { step: "done", draft, asked }, question: "", card, done: true };
}

/** Persiste o contexto confirmado (S1) e devolve o cartão final. Versão do contexto sobe. */
export async function onboardingConfirm(
  home: string,
  inp: { context: Omit<BrainContext, "version"> },
): Promise<{ card: string; version: number }> {
  if (!inp || !inp.context || typeof inp.context !== "object") {
    throw new BffError(400, "contexto do onboarding ausente");
  }
  const version = await saveBrainContext(home, inp.context); // S1
  const card = await renderCard(home, inp.context);
  return { card, version };
}
