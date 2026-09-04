/** Cliente Anthropic minimalista via fetch (sem SDK).
 *  Padrão tool_use forçado (JSON estrito) destilado do _extract-lib.ts do teste. */

const API = "https://api.anthropic.com/v1/messages";

/** Remove surrogates UTF-16 SOLTOS (high sem low ou low sem high). Exports de WhatsApp/etc. trazem emoji
 *  quebrado/encoding ruim → `JSON.stringify` os emite como `\udXXX` avulso → o parser estrito da Anthropic
 *  rejeita com 400 "no low surrogate in string". Pares válidos (emoji ok) são preservados. */
function safeText(s: string): string {
  return typeof s === "string"
    ? s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "�")
    : s;
}

export interface Tool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/** Usage REAL devolvido pela Messages API (raiz da observabilidade de custo, M20). Capturado e repassado
 *  via callback `onUsage` (opcional, não-quebra) — antes era descartado. */
export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export function hasKey(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Headers de auth da Anthropic (x-api-key + anthropic-version + content-type). Fonte ÚNICA de auth —
 *  reusada por toolCall/textCall (síncrono) e por batch-client (Message Batches API, M16/S1). GA, sem
 *  header beta. Lança se ANTHROPIC_API_KEY ausente. */
export function anthropicHeaders() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY não definida (export antes de usar extract/ask).");
  return {
    "x-api-key": key,
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
  };
}

/** Monta o corpo Messages API de uma chamada tool_use FORÇADA. FATORADO de toolCall (M16/S1) — toolCall
 *  passa a chamá-la, e o request do lote (S3) chama a MESMA função → params byte-idênticos (garante a
 *  LEI II — equivalência batch≡sync). safeText JÁ aplicado aqui (não duplicar no caller). */
export function buildMessagesBody(model: string, userPrompt: string, tool: Tool, system = ""): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    max_tokens: Number(process.env.MAX_OUTPUT_TOKENS || 8000),
    tools: [tool],
    tool_choice: { type: "tool", name: tool.name },
    messages: [{ role: "user", content: safeText(userPrompt) }],
  };
  if (system) body.system = safeText(system);
  return body;
}

/** Extrai o input do bloco tool_use de uma resposta Messages (data = JSON do /v1/messages OU
 *  result.message do lote). FATORADO de toolCall (M16/S1) — o harvest do lote (S3) parseia com a MESMA
 *  lógica. Lança em truncamento (max_tokens) / sem tool_use. */
export function parseToolUse<T = any>(data: any): T {
  if (data?.stop_reason === "max_tokens")
    throw new Error("resposta truncada (max_tokens) — aumente MAX_OUTPUT_TOKENS");
  const tu = (data?.content || []).find((c: any) => c.type === "tool_use");
  if (!tu) throw new Error("resposta sem tool_use");
  return tu.input as T;
}

/** Chama a Messages API com tool_use forçado; devolve o input do tool já parseado.
 *  `onUsage` (opcional) recebe o usage REAL da resposta — fonte do custo (M20). */
export async function toolCall<T = any>(model: string, userPrompt: string, tool: Tool, system = "", onUsage?: (u: AnthropicUsage) => void): Promise<T> {
  const body = buildMessagesBody(model, userPrompt, tool, system);

  for (let attempt = 1; ; attempt++) {
    const res = await fetch(API, { method: "POST", headers: anthropicHeaders(), body: JSON.stringify(body) });
    if ((res.status === 429 || res.status === 529) && attempt < 5) {
      await sleep(Math.min(60_000, 2_000 * 2 ** attempt));
      continue;
    }
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data: any = await res.json();
    if (onUsage && data?.usage) onUsage(data.usage as AnthropicUsage);
    return parseToolUse<T>(data);
  }
}

/** Chamada de texto simples (para síntese). `onUsage` (opcional) recebe o usage REAL (custo, M20). */
export async function textCall(model: string, userPrompt: string, system = "", onUsage?: (u: AnthropicUsage) => void): Promise<string> {
  const body: Record<string, unknown> = {
    model,
    max_tokens: Number(process.env.MAX_OUTPUT_TOKENS || 4000),
    messages: [{ role: "user", content: safeText(userPrompt) }],
  };
  if (system) body.system = safeText(system);
  const res = await fetch(API, { method: "POST", headers: anthropicHeaders(), body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data: any = await res.json();
  if (onUsage && data?.usage) onUsage(data.usage as AnthropicUsage);
  return (data.content || [])
    .filter((c: any) => c.type === "text")
    .map((c: any) => c.text)
    .join("\n");
}

/** Body Messages API para TEXTO LIVRE (prosa) — sem tools/tool_choice. Espelha buildMessagesBody mas
 *  pra síntese de prosa (M18). safeText aplicado aqui (não duplicar no caller). `stream` controla o
 *  modo (textStream passa true; reusável por textCall no futuro, mas NÃO mexer em textCall agora). */
export function buildProseBody(model: string, userPrompt: string, system = "", stream = false): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    max_tokens: Number(process.env.MAX_OUTPUT_TOKENS || 4000),
    messages: [{ role: "user", content: safeText(userPrompt) }],
  };
  if (system) body.system = safeText(system);
  if (stream) body.stream = true;
  return body;
}

/** Síntese de TEXTO em STREAMING (M18/LEI I). POST /v1/messages com stream:true; lê o corpo como SSE
 *  da Anthropic e chama onToken(delta) por pedaço de texto ENQUANTO chega; acumula e devolve o texto
 *  final. Reusa anthropicHeaders + buildProseBody(stream:true). Backoff 429/529 SÓ antes do 1º byte.
 *  Sem SDK, sem dep nova. Tenant-neutro.
 *
 *  @param onToken chamado a cada `content_block_delta.delta.text`. Pode ser chamado 0+ vezes.
 *  @returns o texto completo (concatenação de todos os deltas). */
export async function textStream(
  model: string,
  userPrompt: string,
  system: string,
  onToken: (delta: string) => void,
  onUsage?: (u: AnthropicUsage) => void,
): Promise<string> {
  const body = buildProseBody(model, userPrompt, system, true);

  // Backoff SÓ na ABERTURA (antes do 1º byte). Depois que o stream abre, retry simples não dá — erro encerra.
  let res: Response;
  for (let attempt = 1; ; attempt++) {
    res = await fetch(API, { method: "POST", headers: anthropicHeaders(), body: JSON.stringify(body) });
    if ((res.status === 429 || res.status === 529) && attempt < 5) {
      await sleep(Math.min(60_000, 2_000 * 2 ** attempt));
      continue;
    }
    break;
  }
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
  if (!res.body) throw new Error("Anthropic stream sem corpo");

  // Parser SSE mínimo da Anthropic: eventos separados por \n\n; cada um tem linhas `event:` e `data:`.
  // Só nos importa `content_block_delta` com `delta.type==="text_delta"` → delta.text. `message_stop`
  // encerra. Erros vêm como evento `error`. NÃO inventar tolerância além disto (invariante #9).
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let full = "";
  // usage acumulado do stream: input/cache vêm no message_start; output (cumulativo) no message_delta.
  const usage: AnthropicUsage = { input_tokens: 0, output_tokens: 0 };

  const flushEvent = (raw: string) => {
    // raw = um bloco "event: X\ndata: {…}" (pode ter múltiplas linhas data:)
    let ev = "";
    const dataLines: string[] = [];
    for (const line of raw.split("\n")) {
      if (line.startsWith("event:")) ev = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    if (!dataLines.length) return;
    const dataStr = dataLines.join("\n");
    if (dataStr === "[DONE]") return;
    let payload: any;
    try {
      payload = JSON.parse(dataStr);
    } catch {
      return; // linha não-JSON (ping) → ignora
    }
    const type = payload?.type || ev;
    if (type === "content_block_delta" && payload?.delta?.type === "text_delta") {
      const t = payload.delta.text || "";
      if (t) {
        full += t;
        onToken(t);
      }
    } else if (type === "message_start" && payload?.message?.usage) {
      // input + cache vêm UMA vez, no início.
      const mu = payload.message.usage;
      usage.input_tokens = mu.input_tokens ?? 0;
      usage.cache_read_input_tokens = mu.cache_read_input_tokens ?? 0;
      usage.cache_creation_input_tokens = mu.cache_creation_input_tokens ?? 0;
      usage.output_tokens = mu.output_tokens ?? 0;
    } else if (type === "message_delta" && payload?.usage) {
      // output_tokens é CUMULATIVO no message_delta — o último vale.
      if (typeof payload.usage.output_tokens === "number") usage.output_tokens = payload.usage.output_tokens;
    } else if (type === "error") {
      throw new Error(`Anthropic stream error: ${JSON.stringify(payload.error || payload).slice(0, 200)}`);
    }
    // content_block_start / ping / message_stop → ignorados (sem texto/usage).
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    // eventos completos terminam em \n\n; processa todos os completos, guarda o resto no buf.
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      if (raw.trim()) flushEvent(raw);
    }
  }
  if (buf.trim()) flushEvent(buf); // último bloco sem \n\n final
  if (onUsage) onUsage(usage);
  return full;
}
