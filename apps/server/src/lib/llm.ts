/** Camada de provider de LLM — abstrai DE ONDE vem a inteligência.
 *
 *  - "cli": assinatura local — backend Claude (`claude` binário) OU ChatGPT/Codex OAuth
 *           (tokens no Postgres do brain; `~/.codex/auth.json` só em dev). Zero API key de LLM.
 *           Backend: GALEED_CLI_BACKEND=claude|codex|auto (ou GALEED_PROVIDER=codex).
 *  - "api": usa api.anthropic.com com ANTHROPIC_API_KEY (tool_use forçado, enxuto/rápido pra
 *           batches grandes). Caminho de escala.
 *
 *  extract/ask falam SÓ com esta camada — nunca direto com um provider. */
import { spawn, spawnSync } from "node:child_process";
import { toolCall, textCall as apiText, textStream, hasKey, type Tool, type AnthropicUsage } from "./anthropic.ts";
import { hasCodexAuth, hasCodexCredentials, codexText, resolveCodexModel, getCodexBrain } from "./chatgpt-codex.ts";
import { hasOpenAIKey, openaiLlmText } from "./openai.ts";
import { hasQwenKey, qwenLlmText } from "./qwen.ts";
import { getLlmChain, type LlmSlotId } from "../core/platform/llm-chain.ts";

export type Provider = "cli" | "api";
type CliBackend = "claude" | "codex";

/** Evento de consumo de uma chamada de LLM (M20). O `meter` é injetado pelo CALLER (core), que fecha
 *  home+op e grava via recordUsage. Mantém esta camada (lib) PURA — sem import de core/DB. */
export interface LlmUsageEvent {
  provider: Provider;
  model: string;
  tokensIn: number;
  tokensOut: number;
  cacheRead?: number;
  cacheWrite?: number;
  /** custo reportado pelo provider (envelope do `claude` CLI). Quando dado, vence o cálculo por pricing. */
  costUsdReported?: number;
}
export type UsageMeter = (ev: LlmUsageEvent) => void;

/** Adapta a usage da Anthropic (api) → meter. Retorna undefined se não há meter (não chama o cliente à toa). */
function apiMeter(meter: UsageMeter | undefined, model: string): ((u: AnthropicUsage) => void) | undefined {
  if (!meter) return undefined;
  return (u) =>
    meter({
      provider: "api",
      model,
      tokensIn: u.input_tokens ?? 0,
      tokensOut: u.output_tokens ?? 0,
      cacheRead: u.cache_read_input_tokens ?? 0,
      cacheWrite: u.cache_creation_input_tokens ?? 0,
    });
}

/** Extrai usage/custo do envelope JSON do `claude -p --output-format json` (cli) → meter. Fail-soft. */
function cliMeter(meter: UsageMeter | undefined, model: string, envelopeJson: string): void {
  if (!meter) return;
  try {
    const env = JSON.parse(envelopeJson);
    const u = env.usage || {};
    meter({
      provider: "cli",
      model,
      tokensIn: u.input_tokens ?? 0,
      tokensOut: u.output_tokens ?? 0,
      cacheRead: u.cache_read_input_tokens ?? 0,
      cacheWrite: u.cache_creation_input_tokens ?? 0,
      costUsdReported: typeof env.total_cost_usd === "number" ? env.total_cost_usd : undefined,
    });
  } catch {
    /* envelope sem usage → ignora (custo é best-effort) */
  }
}

let _cliAvail: boolean | null = null;
export function cliAvailable(): boolean {
  if (_cliAvail !== null) return _cliAvail;
  try {
    _cliAvail = spawnSync("claude", ["--version"], { timeout: 5000 }).status === 0;
  } catch {
    _cliAvail = false;
  }
  return _cliAvail;
}

export function codexAvailable(): boolean {
  return hasCodexAuth();
}

/** Assinatura local disponível (Claude CLI, arquivo Codex, ou provider=codex — tokens no banco). */
export function subscriptionAvailable(): boolean {
  return cliAvailable() || codexAvailable() || isCodexPreferAlias(process.env.GALEED_PROVIDER);
}

/** Preflight async: banco do brain > arquivo. */
export async function subscriptionAvailableAsync(brain?: string): Promise<boolean> {
  if (cliAvailable()) return true;
  return hasCodexCredentials(brain);
}

function isCodexPreferAlias(v?: string): boolean {
  const s = (v || "").toLowerCase();
  return s === "codex" || s === "chatgpt" || s === "openai-codex";
}

/** Backend da assinatura (`cli`): Claude binário ou ChatGPT/Codex OAuth. */
export function resolveCliBackend(prefer?: string): CliBackend {
  const envBackend = (process.env.GALEED_CLI_BACKEND || "").toLowerCase();
  if (envBackend === "codex" || envBackend === "chatgpt") return "codex";
  if (envBackend === "claude") return "claude";
  if (isCodexPreferAlias(prefer) || isCodexPreferAlias(process.env.GALEED_PROVIDER)) return "codex";
  // auto: Claude se houver; senão Codex se houver auth
  if (cliAvailable()) return "claude";
  if (codexAvailable()) return "codex";
  return "claude";
}

/** Resolve o provider: respeita a preferência explícita; em "auto" prefere a assinatura (cli). */
export function resolveProvider(prefer?: string): Provider {
  if (prefer === "api") return "api";
  if (prefer === "cli" || isCodexPreferAlias(prefer)) return "cli";
  if (subscriptionAvailable()) return "cli";
  if (hasKey()) return "api";
  return "cli"; // erro claro depois, se faltar tudo
}

/** Resolução de provider PARA EXTRAÇÃO. Preferência: 'api' explícito → api; 'auto' com chave →
 *  api (a API tem tool-use nativo, o caminho mais fiel). Sem chave → assinatura local
 *  (Claude CLI ou ChatGPT/Codex). Sem chave E sem assinatura síncrona → ainda 'cli':
 *  a cadeia em withLlmFallback é quem tenta ChatGPT/Anthropic/OpenAI. */
export function resolveExtractionProvider(prefer?: string): Provider {
  if (prefer === "api") return "api";
  if (prefer !== "cli" && !isCodexPreferAlias(prefer) && hasKey()) return "api";
  if (subscriptionAvailable()) {
    const backend = resolveCliBackend(prefer);
    console.warn(
      backend === "codex"
        ? "[llm] extração via ChatGPT/Codex (assinatura OAuth) — schema tipado por instrução; a API Anthropic tem tool-use nativo e é preferível em produção."
        : "[llm] extração via binário `claude` local (sem ANTHROPIC_API_KEY) — o schema tipado vai por instrução; a API tem tool-use nativo e é preferível em produção.",
    );
    return "cli";
  }
  // Sem chave/assinatura síncrona: NÃO aborta aqui. structured()/withLlmFallback
  // percorre a cadeia do cérebro (ChatGPT no banco, Anthropic, OpenAI). Se todas
  // falharem, o erro é transitório e o job de ingestão espera.
  return "cli";
}

/** Falha de transporte/auth/cota — o job deve ESPERAR e retentar, não morrer. */
export function isTransientLlmError(message: string): boolean {
  const m = String(message || "");
  return (
    /timeout|ETIMEDOUT|ECONNRESET|abort/i.test(m) ||
    /\b(429|529|500|502|503|401|403)\b/.test(m) ||
    /ANTHROPIC_API_KEY|OPENAI_API_KEY|QWEN_API_KEY|DASHSCOPE_API_KEY|sem credenciais|ChatGPT\/Codex|Todas as IAs da cadeia/i.test(m) ||
    /precisa de IA|claude CLI (timeout|não executou)|OpenAI timeout|Qwen timeout/i.test(m)
  );
}

function slotReady(id: LlmSlotId): boolean {
  if (id === "chatgpt") return hasCodexAuth() || isCodexPreferAlias(process.env.GALEED_PROVIDER);
  if (id === "anthropic") return hasKey();
  if (id === "qwen") return hasQwenKey();
  return hasOpenAIKey();
}

async function enabledSlots(brain?: string): Promise<LlmSlotId[]> {
  const home = brain || getCodexBrain();
  if (!home) return [];
  const chain = await getLlmChain(home);
  const out: LlmSlotId[] = [];
  for (const s of chain) {
    if (!s.enabled) continue;
    if (s.id === "chatgpt") {
      if ((await hasCodexCredentials(home)) || hasCodexAuth()) out.push(s.id);
      continue;
    }
    if (slotReady(s.id)) out.push(s.id);
  }
  return out;
}

async function withLlmFallback<T>(run: (slot: LlmSlotId | "legacy") => Promise<T>): Promise<T> {
  const slots = await enabledSlots();
  if (!slots.length) return run("legacy");
  const errors: string[] = [];
  for (const slot of slots) {
    try {
      return await run(slot);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!isTransientLlmError(msg)) throw e;
      errors.push(`${slot}: ${msg}`);
      console.warn(`[llm] ${slot} falhou — tentando a próxima:`, msg.slice(0, 180));
    }
  }
  throw new Error(`Todas as IAs da cadeia falharam. ${errors.join(" · ")}`);
}

/** Texto via assinatura: Claude CLI ou ChatGPT/Codex. */
async function subscriptionText(
  model: string,
  prompt: string,
  system: string,
  meter?: UsageMeter,
): Promise<string> {
  return subscriptionTextFor(undefined, model, prompt, system, meter);
}

async function subscriptionTextFor(
  force: "codex" | "claude" | undefined,
  model: string,
  prompt: string,
  system: string,
  meter?: UsageMeter,
): Promise<string> {
  const backend = force ?? resolveCliBackend();
  if (backend === "codex") {
    const m = resolveCodexModel(model);
    return codexText(m, prompt, system, (u) => {
      if (!meter) return;
      meter({ provider: "cli", model: m, tokensIn: u.input_tokens, tokensOut: u.output_tokens });
    });
  }
  const envelope = await runClaude(["-p", "--model", model, "--system-prompt", system, "--output-format", "json"], prompt);
  cliMeter(meter, model, envelope);
  return unwrapResult(envelope);
}

/** Roda `claude -p ... --output-format json`, prompt via stdin (suporta prompts grandes). */
function runClaude(args: string[], input: string, timeoutMs = 180_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const ch = spawn("claude", args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "",
      err = "";
    const t = setTimeout(() => {
      ch.kill("SIGKILL");
      reject(new Error("claude CLI timeout"));
    }, timeoutMs);
    ch.stdout.on("data", (d) => (out += d));
    ch.stderr.on("data", (d) => (err += d));
    ch.on("error", (e) => {
      clearTimeout(t);
      reject(new Error(`claude CLI não executou: ${e.message}`));
    });
    ch.on("close", (code) => {
      clearTimeout(t);
      if (code === 0) resolve(out);
      else reject(new Error(`claude CLI saiu ${code}: ${err.slice(0, 300)}`));
    });
    ch.stdin.write(input);
    ch.stdin.end();
  });
}

function unwrapResult(envelopeJson: string): string {
  const env = JSON.parse(envelopeJson);
  if (env.is_error) throw new Error(`claude CLI erro: ${String(env.result || "").slice(0, 200)}`);
  return String(env.result ?? "");
}

/** Extrai um objeto JSON de texto livre (tolera cercas ```json e texto ao redor). */
function parseJsonLoose(text: string): any {
  let s = text.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const i = s.indexOf("{");
  const j = s.lastIndexOf("}");
  if (i >= 0 && j > i) s = s.slice(i, j + 1);
  return JSON.parse(s);
}

// ---------- Interface pública ----------

export interface StructuredOpts {
  provider: Provider;
  model: string; // cli: alias "haiku"; api: id completo
  system: string;
  prompt: string;
  tool: Tool; // fonte única do CONTRATO de saída (api: tool-use; cli: schema vira instrução)
  dims: string[]; // legado (meter/telemetria); o hint do cli deriva do tool.input_schema
  meter?: UsageMeter; // M20: registra o consumo desta chamada
}

async function structuredViaJsonHint(o: StructuredOpts, textFn: (sys: string) => Promise<string>): Promise<any> {
  const hint =
    `${o.tool.description}\n\n` +
    `Responda SOMENTE com um objeto JSON válido (sem markdown, sem texto fora dele) que satisfaça ` +
    `EXATAMENTE este JSON Schema (inclua todas as chaves de "required"; siga as descrições de cada campo):\n` +
    JSON.stringify(o.tool.input_schema);
  const sys = (o.system ? o.system + " " : "") + hint;
  let last = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    last = await textFn(sys);
    try {
      return parseJsonLoose(last);
    } catch {
      if (attempt === 2) throw new Error(`CLI não retornou JSON parseável: ${last.slice(0, 200)}`);
    }
  }
}

/** Extração estruturada (JSON estrito). */
export async function structured(o: StructuredOpts): Promise<any> {
  return withLlmFallback(async (slot) => {
    if (slot === "anthropic" || (slot === "legacy" && o.provider === "api")) {
      return toolCall(o.model, o.prompt, o.tool, o.system, apiMeter(o.meter, o.model));
    }
    if (slot === "openai") {
      return structuredViaJsonHint(o, (sys) =>
        openaiLlmText(o.prompt, sys, { model: process.env.OPENAI_MODEL }),
      );
    }
    if (slot === "qwen") {
      return structuredViaJsonHint(o, (sys) =>
        qwenLlmText(o.prompt, sys, { model: process.env.QWEN_MODEL }),
      );
    }
    // chatgpt ou legacy cli
    return structuredViaJsonHint(o, (sys) => subscriptionTextFor(slot === "chatgpt" ? "codex" : undefined, o.model, o.prompt, sys, o.meter));
  });
}

export interface SynthesisOpts {
  provider: Provider;
  model: string; // cli: alias; api: id completo
  system: string;
  prompt: string;
  tool: Tool; // usado no provider api (toolCall)
  meter?: UsageMeter; // M20
}

/** Síntese ESTRUTURADA (M17/S2) — saída JSON `{claims:[{text,cite_slug,quote}], gaps:[]}`.
 *  Diferente de `structured` (orientado a EXTRAÇÃO entity/predicate/value): aqui o hint do caminho `cli`
 *  descreve o shape de claims/gaps, NÃO o de extração. provider `api` → `toolCall(tool)`; `cli` →
 *  instrui o shape + `parseJsonLoose`, 2 tentativas (espelha `structured`). */
export async function structuredSynthesis(
  o: SynthesisOpts,
): Promise<{ claims: any[]; gaps: any[] }> {
  const hint =
    `Responda SOMENTE com um objeto JSON válido (sem markdown, sem texto fora dele) com EXATAMENTE estas ` +
    `chaves: "claims" (array de objetos {"text": "...", "cite_slug": "...", "quote": "..."}) e ` +
    `"gaps" (array de strings). O "quote" é um trecho COPIADO LITERALMENTE (verbatim) de UMA das fontes ` +
    `do contexto, e "cite_slug" é o slug dessa fonte. NÃO inclua no "text" nenhum número, nome ou termo ` +
    `que não apareça no "quote".`;
  const sys = (o.system ? o.system + " " : "") + hint;
  return withLlmFallback(async (slot) => {
    if (slot === "anthropic" || (slot === "legacy" && o.provider === "api")) {
      return toolCall(o.model, o.prompt, o.tool, o.system, apiMeter(o.meter, o.model));
    }
    const textFn =
      slot === "openai"
        ? (s: string) => openaiLlmText(o.prompt, s, { model: process.env.OPENAI_MODEL })
        : slot === "qwen"
          ? (s: string) => qwenLlmText(o.prompt, s, { model: process.env.QWEN_MODEL })
          : (s: string) => subscriptionTextFor(slot === "chatgpt" ? "codex" : undefined, o.model, o.prompt, s, o.meter);
    let last = "";
    for (let attempt = 1; attempt <= 2; attempt++) {
      last = await textFn(sys);
      try {
        const parsed = parseJsonLoose(last);
        return {
          claims: Array.isArray(parsed.claims) ? parsed.claims : [],
          gaps: Array.isArray(parsed.gaps) ? parsed.gaps : [],
        };
      } catch {
        if (attempt === 2) throw new Error(`CLI não retornou JSON parseável: ${last.slice(0, 200)}`);
      }
    }
    return { claims: [], gaps: [] };
  });
}

export interface ProseOpts {
  provider: Provider;
  model: string;
  system: string;
  prompt: string;
  meter?: UsageMeter; // M20
}

/** Síntese em prosa. */
export async function prose(o: ProseOpts): Promise<string> {
  return withLlmFallback(async (slot) => {
    if (slot === "anthropic" || (slot === "legacy" && o.provider === "api")) {
      return apiText(o.model, o.prompt, o.system, apiMeter(o.meter, o.model));
    }
    if (slot === "openai") return openaiLlmText(o.prompt, o.system, { model: process.env.OPENAI_MODEL });
    if (slot === "qwen") return qwenLlmText(o.prompt, o.system, { model: process.env.QWEN_MODEL });
    return subscriptionTextFor(slot === "chatgpt" ? "codex" : undefined, o.model, o.prompt, o.system, o.meter);
  });
}

export interface StreamProseOpts {
  provider: Provider;
  model: string; // cli: alias; api: id completo
  system: string;
  prompt: string;
  meter?: UsageMeter; // M20
}

/** Síntese em prosa STREAMADA (M18). provider `api` → textStream (token-a-token HTTP real); provider
 *  `cli` → prose() não-stream + onToken(full) UMA vez (o caminho de streaming de produção é o `api`;
 *  assinatura Claude/Codex não expõe streaming HTTP simples — fallback honesto). Devolve o
 *  texto completo (igual a textStream/prose). */
export async function streamProse(o: StreamProseOpts, onToken: (delta: string) => void): Promise<string> {
  return withLlmFallback(async (slot) => {
    if (slot === "anthropic" || (slot === "legacy" && o.provider === "api")) {
      return textStream(o.model, o.prompt, o.system, onToken, apiMeter(o.meter, o.model));
    }
    const full =
      slot === "openai"
        ? await openaiLlmText(o.prompt, o.system, { model: process.env.OPENAI_MODEL })
        : slot === "qwen"
          ? await qwenLlmText(o.prompt, o.system, { model: process.env.QWEN_MODEL })
          : await subscriptionTextFor(slot === "chatgpt" ? "codex" : undefined, o.model, o.prompt, o.system, o.meter);
    if (full) onToken(full);
    return full;
  });
}
