/** Camada de provider de LLM — abstrai DE ONDE vem a inteligência.
 *
 *  - "cli": usa o binário `claude` local (autenticado pela ASSINATURA do usuário). Zero API key.
 *           Carrega o contexto do harness Claude Code por chamada (mais lento, mas não custa $ —
 *           consome cota da assinatura). Default, pra facilitar.
 *  - "api": usa api.anthropic.com com ANTHROPIC_API_KEY (tool_use forçado, enxuto/rápido pra
 *           batches grandes). Caminho de escala.
 *
 *  extract/ask falam SÓ com esta camada — nunca direto com um provider. */
import { spawn, spawnSync } from "node:child_process";
import { toolCall, textCall as apiText, textStream, hasKey, type Tool, type AnthropicUsage } from "./anthropic.ts";

export type Provider = "cli" | "api";

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

/** Resolve o provider: respeita a preferência explícita; em "auto" prefere a assinatura (cli). */
export function resolveProvider(prefer?: string): Provider {
  if (prefer === "cli" || prefer === "api") return prefer;
  if (cliAvailable()) return "cli";
  if (hasKey()) return "api";
  return "cli"; // erro claro depois, se faltar tudo
}

/** Resolução de provider PARA EXTRAÇÃO. Preferência: 'api' explícito → api; 'auto' com chave →
 *  api (a API tem tool-use nativo, o caminho mais fiel). Desde que o `structured()` do caminho
 *  'cli' passou a instruir o modelo com o PRÓPRIO tool.input_schema (schema tipado completo:
 *  value_num/unit/period/tier + guidance da receita), o 'cli' deixou de degradar em silêncio —
 *  então 'auto' SEM chave cai no binário `claude` local quando ele existe (self-host/dev com
 *  assinatura, zero chave). Sem chave E sem binário → erro claro. */
export function resolveExtractionProvider(prefer?: string): Provider {
  if (prefer === "api") return "api";
  if (prefer !== "cli" && hasKey()) return "api";
  // daqui pra baixo a resolução cai em 'cli'
  if (cliAvailable()) {
    console.warn("[llm] extração via binário `claude` local (sem ANTHROPIC_API_KEY) — o schema tipado vai por instrução; a API tem tool-use nativo e é preferível em produção.");
    return "cli";
  }
  throw new Error(
    "extração de fatos precisa de IA — configure ANTHROPIC_API_KEY no .env (ou instale o CLI `claude` na máquina do servidor) e reinicie.",
  );
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

/** Extração estruturada (JSON estrito). */
export async function structured(o: StructuredOpts): Promise<any> {
  if (o.provider === "api") return toolCall(o.model, o.prompt, o.tool, o.system, apiMeter(o.meter, o.model));

  // O hint deriva do PRÓPRIO tool.input_schema — o mesmo contrato do provider api. O hint antigo
  // hard-codava o shape da EXTRAÇÃO ({dim: [{text, context_quote,…}]}), o que quebrava em silêncio
  // todo caller com schema próprio (wizard, onboarding, ground/ask, entity-attr, reflect): o JSON
  // voltava no formato errado, o caller degradava e o usuário via o produto "burro" sem nenhum erro.
  const hint =
    `${o.tool.description}\n\n` +
    `Responda SOMENTE com um objeto JSON válido (sem markdown, sem texto fora dele) que satisfaça ` +
    `EXATAMENTE este JSON Schema (inclua todas as chaves de "required"; siga as descrições de cada campo):\n` +
    JSON.stringify(o.tool.input_schema);
  const sys = (o.system ? o.system + " " : "") + hint;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const envelope = await runClaude(["-p", "--model", o.model, "--system-prompt", sys, "--output-format", "json"], o.prompt);
    cliMeter(o.meter, o.model, envelope); // a chamada custou — registra mesmo se o parse falhar
    const result = unwrapResult(envelope);
    try {
      return parseJsonLoose(result);
    } catch {
      if (attempt === 2) throw new Error(`CLI não retornou JSON parseável: ${result.slice(0, 200)}`);
    }
  }
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
 *  instrui o shape + `parseJsonLoose`, 2 tentativas (espelha `structured`). Reusa
 *  `runClaude`/`unwrapResult`/`parseJsonLoose` (já no módulo). Sem dep nova. */
export async function structuredSynthesis(
  o: SynthesisOpts,
): Promise<{ claims: any[]; gaps: any[] }> {
  if (o.provider === "api") return toolCall(o.model, o.prompt, o.tool, o.system, apiMeter(o.meter, o.model));

  const hint =
    `Responda SOMENTE com um objeto JSON válido (sem markdown, sem texto fora dele) com EXATAMENTE estas ` +
    `chaves: "claims" (array de objetos {"text": "...", "cite_slug": "...", "quote": "..."}) e ` +
    `"gaps" (array de strings). O "quote" é um trecho COPIADO LITERALMENTE (verbatim) de UMA das fontes ` +
    `do contexto, e "cite_slug" é o slug dessa fonte. NÃO inclua no "text" nenhum número, nome ou termo ` +
    `que não apareça no "quote".`;
  const sys = (o.system ? o.system + " " : "") + hint;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const envelope = await runClaude(["-p", "--model", o.model, "--system-prompt", sys, "--output-format", "json"], o.prompt);
    cliMeter(o.meter, o.model, envelope);
    const result = unwrapResult(envelope);
    try {
      const parsed = parseJsonLoose(result);
      return {
        claims: Array.isArray(parsed.claims) ? parsed.claims : [],
        gaps: Array.isArray(parsed.gaps) ? parsed.gaps : [],
      };
    } catch {
      if (attempt === 2) throw new Error(`CLI não retornou JSON parseável: ${result.slice(0, 200)}`);
    }
  }
  return { claims: [], gaps: [] };
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
  if (o.provider === "api") return apiText(o.model, o.prompt, o.system, apiMeter(o.meter, o.model));
  const envelope = await runClaude(["-p", "--model", o.model, "--system-prompt", o.system, "--output-format", "json"], o.prompt);
  cliMeter(o.meter, o.model, envelope);
  return unwrapResult(envelope);
}

export interface StreamProseOpts {
  provider: Provider;
  model: string; // cli: alias; api: id completo
  system: string;
  prompt: string;
  meter?: UsageMeter; // M20
}

/** Síntese em prosa STREAMADA (M18). provider `api` → textStream (token-a-token HTTP real); provider
 *  `cli` → prose() não-stream + onToken(full) UMA vez (o caminho de streaming de produção é o `api`; o
 *  cli do `claude` não expõe streaming HTTP simples — fallback honesto, não simula tokens). Devolve o
 *  texto completo (igual a textStream/prose). */
export async function streamProse(o: StreamProseOpts, onToken: (delta: string) => void): Promise<string> {
  if (o.provider === "api") return textStream(o.model, o.prompt, o.system, onToken, apiMeter(o.meter, o.model));
  const full = await prose({ provider: o.provider, model: o.model, system: o.system, prompt: o.prompt, meter: o.meter });
  if (full) onToken(full); // 1 "token" = a resposta inteira (cli não streama)
  return full;
}
