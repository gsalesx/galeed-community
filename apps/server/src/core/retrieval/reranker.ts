/** Reranker plugável (M6/D1) — estágio de PRECISÃO sobre o candidate set fundido do retrieve.
 *  Provider via env GALEED_RERANK_PROVIDER: "voyage" (Cohere/CLI podem ser somados depois) | "none".
 *  Sem provider/chave → retorna null (BYPASS gracioso: o retrieve mantém a ordem da fusão).
 *  Determinístico do ponto de vista do caminho: 1 chamada de rede, sem LLM generativo no hot path. */
import { voyageRerank, hasVoyageKey } from "../../lib/voyage.ts";
import { recordUsage } from "../platform/usage.ts"; // M20 — custo do reranker

export interface RerankCandidate {
  id: string; // slug do candidato
  text: string; // texto a ranquear (melhor chunk/excerpt disponível)
}
export interface RerankHit {
  id: string;
  score: number; // relevância [0..1]
  rank: number; // posição final (0-based)
}

export function rerankProvider(): string {
  return (process.env.GALEED_RERANK_PROVIDER || "none").toLowerCase();
}

/** Há reranker utilizável (provider + credencial)? */
export function rerankAvailable(): boolean {
  switch (rerankProvider()) {
    case "voyage":
      return hasVoyageKey();
    default:
      return false;
  }
}

/** Máx de chars por documento enviado ao reranker. Passagem ~512 tokens basta pro cross-encoder
 *  (pesquisa) e mantém o payload dentro do TPM do provider. Configurável por env. */
const MAX_DOC_CHARS = Number(process.env.GALEED_RERANK_DOC_CHARS || 1000);

/** Reordena candidatos pela relevância à query, devolvendo no máx `topK`.
 *  null = bypass (sem provider/chave) → o chamador usa a ordem que já tinha. */
export async function rerank(query: string, candidates: RerankCandidate[], topK: number, home?: string): Promise<RerankHit[] | null> {
  if (!candidates.length) return [];
  if (!rerankAvailable()) return null;

  // textos vazios não ajudam o cross-encoder; substitui pelo próprio id. Trunca p/ caber no TPM.
  const docs = candidates.map((c) => (c.text && c.text.trim() ? c.text : c.id).slice(0, MAX_DOC_CHARS));

  if (rerankProvider() === "voyage") {
    // M20: registra o custo do rerank quando o caller informa o brain (fail-soft).
    const onUsage = home
      ? (tok: number, model: string) => void recordUsage(home, { op: "rerank", provider: "voyage", model, tokensIn: tok, tokensOut: 0, meta: { docs: docs.length } })
      : undefined;
    const hits = await voyageRerank(query, docs, topK, onUsage);
    return hits.map((h, rank) => ({ id: candidates[h.index].id, score: h.score, rank }));
  }
  return null;
}
