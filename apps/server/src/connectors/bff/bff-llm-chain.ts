/** BFF da cadeia de LLM (Conectar): ordem + toggle. Sem colar API key. */
import { hasKey } from "../../lib/anthropic.ts";
import { hasCodexCredentials } from "../../lib/chatgpt-codex.ts";
import { hasOpenAIKey } from "../../lib/openai.ts";
import { hasQwenKey } from "../../lib/qwen.ts";
import { getLlmChain, saveLlmChain, type LlmChainSlot, type LlmSlotId } from "../../core/platform/llm-chain.ts";
import { BffError } from "./bff-common.ts";

export interface LlmSlotView {
  id: LlmSlotId;
  enabled: boolean;
  ready: boolean;
  hint: string;
}

export interface LlmChainView {
  slots: LlmSlotView[];
  message: string;
}

async function decorate(home: string, slots: LlmChainSlot[]): Promise<LlmSlotView[]> {
  const chatgpt = await hasCodexCredentials(home);
  const anthropic = hasKey();
  const openai = hasOpenAIKey();
  const qwen = hasQwenKey();
  const readyOf: Record<LlmSlotId, boolean> = { chatgpt, anthropic, openai, qwen };
  const hintOf: Record<LlmSlotId, string> = {
    chatgpt: chatgpt ? "Assinatura ChatGPT ligada neste cérebro." : "Conecte o ChatGPT abaixo (Plus/Pro).",
    anthropic: anthropic ? "ANTHROPIC_API_KEY no .env do servidor." : "Coloque ANTHROPIC_API_KEY no .env e reinicie.",
    openai: openai ? "OPENAI_API_KEY no .env do servidor." : "Coloque OPENAI_API_KEY no .env e reinicie.",
    qwen: qwen
      ? "QWEN_API_KEY (ou DASHSCOPE_API_KEY) no .env do servidor."
      : "Coloque QWEN_API_KEY ou DASHSCOPE_API_KEY no .env e reinicie.",
  };
  return slots.map((s) => ({
    id: s.id,
    enabled: s.enabled,
    ready: readyOf[s.id],
    hint: hintOf[s.id],
  }));
}

export async function llmChainStatusHandler(home: string): Promise<LlmChainView> {
  const slots = await decorate(home, await getLlmChain(home));
  return {
    slots,
    message: "Se a de cima falhar, tenta a de baixo. Uma de cada vez — não mistura.",
  };
}

export async function llmChainSaveHandler(home: string, body: { slots?: unknown }): Promise<LlmChainView> {
  if (body?.slots !== undefined && !Array.isArray(body.slots)) {
    throw new BffError(400, "a ordem das IAs precisa ser uma lista.");
  }
  const saved = await saveLlmChain(home, body?.slots);
  const slots = await decorate(home, saved);
  return {
    slots,
    message: "Ordem salva. Se a de cima falhar, tenta a de baixo.",
  };
}
