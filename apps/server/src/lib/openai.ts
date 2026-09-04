/** Embeddings via OpenAI (busca semântica). Separado do provider de LLM de propósito:
 *  o LLM (extract/ask) roda na assinatura; o embedding roda na OpenAI (barato: ~$0.02/1M no
 *  text-embedding-3-small, ~$0.13/1M no -3-large). Vetores são normalizados (cosine = dot product). */

const API = "https://api.openai.com/v1/embeddings";

export function hasOpenAIKey(): boolean {
  return !!process.env.OPENAI_API_KEY;
}

function normalize(v: Float32Array): Float32Array {
  let s = 0;
  for (const x of v) s += x * x;
  s = Math.sqrt(s) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= s;
  return v;
}

/** Chat completion curto (OpenAI) — usado p/ query expansion/HyDE no retrieve (barato, gpt-4o-mini).
 *  Timeout + retry. Retorna texto; "" em falha (chamador decide o fallback). */
export async function chatComplete(prompt: string, system: string, opts: { model?: string; maxTokens?: number } = {}): Promise<string> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return "";
  const body = JSON.stringify({
    model: opts.model || "gpt-4o-mini",
    messages: [{ role: "system", content: system }, { role: "user", content: prompt }],
    max_tokens: opts.maxTokens ?? 120,
    temperature: 0,
  });
  for (let attempt = 1; ; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12_000);
    try {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST", signal: ctrl.signal,
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body,
      });
      clearTimeout(timer);
      if ((res.status === 429 || res.status >= 500) && attempt < 3) { await new Promise((r) => setTimeout(r, 1_000 * attempt)); continue; }
      if (!res.ok) return "";
      const j: any = await res.json();
      return (j.choices?.[0]?.message?.content || "").trim();
    } catch { clearTimeout(timer); if (attempt < 3) { await new Promise((r) => setTimeout(r, 1_000 * attempt)); continue; } return ""; }
  }
}

/** Embeda um lote de textos. Retorna vetores normalizados, na mesma ordem da entrada.
 *  `onUsage` (opcional, M20) recebe os tokens reais (usage.total_tokens) p/ registrar custo. */
export async function embed(texts: string[], model = "text-embedding-3-small", dims?: number, onUsage?: (totalTokens: number) => void): Promise<Float32Array[]> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY não definida (necessária para busca semântica).");
  const body: Record<string, unknown> = { model, input: texts };
  if (dims) body.dimensions = dims;

  for (let attempt = 1; ; attempt++) {
    const res = await fetch(API, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if ((res.status === 429 || res.status >= 500) && attempt < 5) {
      await new Promise((r) => setTimeout(r, Math.min(30_000, 1_000 * 2 ** attempt)));
      continue;
    }
    if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data: any = await res.json();
    if (onUsage && data?.usage) onUsage(Number(data.usage.total_tokens ?? data.usage.prompt_tokens ?? 0));
    return data.data
      .sort((a: any, b: any) => a.index - b.index)
      .map((d: any) => normalize(Float32Array.from(d.embedding)));
  }
}
