/** Reranker via Voyage AI (estágio de PRECISÃO do retrieval, M6/D1). Cross-encoder que reordena
 *  candidatos pela relevância à query — o árbitro final sobre o candidate set fundido (vec+FTS).
 *  Separado do embed (OpenAI) e do LLM (assinatura) de propósito. Robusto: timeout + retry. */

const API = "https://api.voyageai.com/v1/rerank";

export function hasVoyageKey(): boolean {
  return !!process.env.VOYAGE_API_KEY;
}

export interface VoyageRerankHit {
  index: number; // índice do documento na lista de entrada
  score: number; // relevance_score [0..1]
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Reordena `documents` pela relevância a `query`. Retorna [{index, score}] já ordenado desc,
 *  no máximo `topK`. Timeout de 15s por tentativa + retry exponencial em 429/5xx/rede. */
export async function voyageRerank(query: string, documents: string[], topK: number, onUsage?: (totalTokens: number, model: string) => void): Promise<VoyageRerankHit[]> {
  const key = process.env.VOYAGE_API_KEY;
  if (!key) throw new Error("VOYAGE_API_KEY não definida (necessária para o reranker).");
  if (!documents.length) return [];
  const model = process.env.GALEED_RERANK_MODEL || "rerank-2.5-lite";
  const body = JSON.stringify({ query, documents, model, top_k: Math.min(topK, documents.length), truncation: true });

  for (let attempt = 1; ; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15_000); // corrige G12 (sem timeout pendura pra sempre)
    try {
      const res = await fetch(API, {
        method: "POST",
        signal: ctrl.signal,
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body,
      });
      clearTimeout(timer);
      if ((res.status === 429 || res.status >= 500) && attempt < 3) {
        // respeita Retry-After se vier; senão backoff curto (no 429 de rate-limit, falhar rápido
        // é melhor que pendurar — o chamador em lote faz o throttle).
        const ra = Number(res.headers.get("retry-after"));
        await sleep(ra > 0 ? Math.min(ra * 1000, 20_000) : 1_000 * attempt);
        continue;
      }
      if (!res.ok) throw new Error(`Voyage rerank ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const data: any = await res.json();
      if (onUsage && data?.usage) onUsage(Number(data.usage.total_tokens ?? 0), model);
      return (data.data || [])
        .map((d: any) => ({ index: d.index, score: d.relevance_score }))
        .sort((a: VoyageRerankHit, b: VoyageRerankHit) => b.score - a.score);
    } catch (e) {
      clearTimeout(timer);
      const retriable = (e as Error).name === "AbortError" || /fetch failed|network|ECONN|ETIMEDOUT/i.test((e as Error).message);
      if (retriable && attempt < 5) {
        await sleep(Math.min(30_000, 1_000 * 2 ** attempt));
        continue;
      }
      throw e;
    }
  }
}
