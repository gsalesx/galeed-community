/** Chat completion via Qwen / DashScope (OpenAI-compatible). Cadeia de fallback do extract/ask. */

const DEFAULT_BASE = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";
const DEFAULT_MODEL = "qwen-plus";

export function hasQwenKey(): boolean {
  return !!(process.env.QWEN_API_KEY || process.env.DASHSCOPE_API_KEY);
}

function qwenKey(): string {
  return (process.env.QWEN_API_KEY || process.env.DASHSCOPE_API_KEY || "").trim();
}

function qwenBase(): string {
  return (process.env.QWEN_BASE_URL || DEFAULT_BASE).replace(/\/$/, "");
}

/** Chat que LANÇA em timeout/429/5xx/auth — pra cadeia de fallback do extract/ask. */
export async function qwenLlmText(
  prompt: string,
  system: string,
  opts: { model?: string; maxTokens?: number } = {},
): Promise<string> {
  const key = qwenKey();
  if (!key) throw new Error("QWEN_API_KEY / DASHSCOPE_API_KEY não definida.");
  const body = JSON.stringify({
    model: opts.model || process.env.QWEN_MODEL || DEFAULT_MODEL,
    messages: [
      { role: "system", content: system },
      { role: "user", content: prompt },
    ],
    max_tokens: opts.maxTokens ?? Number(process.env.MAX_OUTPUT_TOKENS || 4000),
    temperature: 0,
  });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 120_000);
  try {
    const res = await fetch(`${qwenBase()}/chat/completions`, {
      method: "POST",
      signal: ctrl.signal,
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body,
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(`Qwen ${res.status}: ${t.slice(0, 300)}`);
    }
    const j: any = await res.json();
    const text = (j.choices?.[0]?.message?.content || "").trim();
    if (!text) throw new Error("Qwen: resposta vazia.");
    return text;
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") throw new Error("Qwen timeout");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
