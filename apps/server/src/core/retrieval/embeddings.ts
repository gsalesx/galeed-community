/** Camada de busca semântica (embeddings OpenAI). A ORQUESTRAÇÃO vive aqui; o ARMAZENAMENTO
 *  e a similaridade ficam no engine ativo:
 *   - SQLite: vetores em BLOB + cosine brute-force em JS.
 *   - Supabase: vetores em `vector(N)` + busca nativa pgvector (`<=>`).
 *  Em ambos: só embeda chunk novo/alterado (cache por hash) → rebuild não re-paga a OpenAI. */
import { createHash } from "node:crypto";
import { config, type EmbCfg } from "../platform/config.ts";
import { chunkText } from "../../lib/chunk.ts";
import { embed, hasOpenAIKey } from "../../lib/openai.ts";
import { contextualizeChunk, deterministicContext, ensureSynopses } from "./contextual.ts";
import { getEngine, type SemHit, type VecRow } from "../platform/engine.ts";
import { recordUsage } from "../platform/usage.ts"; // M20 — custo dos embeddings

export type { SemHit } from "../platform/engine.ts";
export type { EmbCfg } from "../platform/config.ts";

function embCfg(home: string): EmbCfg {
  return config(home).embeddings;
}

function chunkHash(slug: string, idx: number, text: string): string {
  return createHash("sha256").update(`${slug}::${idx}::${text}`).digest("hex").slice(0, 32);
}

/** Garante embeddings p/ todos os chunks atuais; embeda só o que falta; remove órfãos. */
export async function buildEmbeddings(home: string, onLog?: (s: string) => void) {
  const cfg = embCfg(home);
  if (!cfg.enabled) return { skipped: "embeddings desabilitados (GALEED_EMBED_DISABLED)" };
  if (!hasOpenAIKey()) return { skipped: "OPENAI_API_KEY não definida — busca fica só por palavra-chave" };

  const e = await getEngine(home);
  const have = await e.vectorHashes();
  const current = new Set<string>();
  const pending: { hash: string; slug: string; idx: number; text: string; embText: string }[] = [];

  // M6 — contexto OPT-IN (GALEED_CONTEXTUAL=1). MEDIDO no gate: prefixo de contexto (determinístico
  // OU sinopse) REGREDIU o recall neste corpus (0.68→0.59) — o prefixo compartilhado entre chunks do
  // mesmo doc dilui o sinal discriminativo. Default = chunk CRU (melhor medido). Ver docs/LEARNINGS.md.
  const useCtx = process.env.GALEED_CONTEXTUAL === "1";
  const synopses = await ensureSynopses(home, onLog);
  for (const pg of await e.allPages()) {
    const syn = synopses.get(pg.slug) ?? "";
    const ctx = useCtx ? deterministicContext(pg) : "";
    chunkText(pg.body).forEach((c, i) => {
      const embText = contextualizeChunk(ctx, syn, c); // vai pro embedding
      const h = chunkHash(pg.slug, i, embText); // hash inclui o contexto → invalida quando muda
      current.add(h);
      if (!have.has(h)) pending.push({ hash: h, slug: pg.slug, idx: i, text: c, embText });
    });
  }

  const model = cfg.model || "text-embedding-3-small";
  // Batch por ORÇAMENTO DE TOKENS (não por contagem fixa): a OpenAI limita 300K tokens/request, e
  // chunks grandes + prefixo de contexto podem estourar um batch de 100. Margem segura: ~200K (~4 chars/token).
  const TOKEN_BUDGET = 150_000;
  const MAX_ITEMS = 256; // limite prático de itens/request
  const estTokens = (s: string) => Math.ceil(s.length / 4);
  let embedded = 0;
  let i = 0;
  while (i < pending.length) {
    const batch: typeof pending = [];
    let toks = 0;
    while (i < pending.length && batch.length < MAX_ITEMS) {
      const t = estTokens(pending[i].embText);
      if (batch.length && toks + t > TOKEN_BUDGET) break; // fecha o batch antes de estourar
      batch.push(pending[i]);
      toks += t;
      i++;
    }
    const vecs = await embed(batch.map((b) => b.embText), model, cfg.dims, (tok) =>
      void recordUsage(home, { op: "embed", provider: "openai", model, tokensIn: tok, tokensOut: 0, meta: { items: batch.length } }),
    ); // embeda o contextualizado
    const rows: VecRow[] = batch.map((b, j) => ({ hash: b.hash, slug: b.slug, chunk_idx: b.idx, text: b.text, vec: vecs[j] })); // guarda o chunk ORIGINAL
    await e.putVectors(rows);
    embedded += batch.length;
    onLog?.(`  embeddings ${i}/${pending.length}`);
  }

  // `current` vem de allPages, que EXCLUI arquivadas — mas o pruneVectors do engine NUNCA deleta
  // vetor de página arquivada (achado decaimento-lixeira#4, opção A: preservar): descartar vetor de
  // arquivada é decisão MEDIDA do shedCold (tiering.ts), não efeito colateral da ingestão. `pruned`
  // aqui é estimativa superior (órfãos de arquivadas ficam); a leitura já filtra archived no vectorSearch.
  const prunedCount = [...have].filter((h) => !current.has(h)).length;
  await e.pruneVectors(current);

  return { embedded, reused: current.size - embedded, pruned: prunedCount, model, total: current.size };
}

/** Busca semântica. `dedupe=true` → 1 hit por página (citações); `false` → top-k CHUNKS (síntese).
 *  Retorna null quando não disponível (desabilitada / sem chave / sem vetores). */
export async function semanticSearch(home: string, q: string, k = 6, dedupe = true, embedText?: string): Promise<SemHit[] | null> {
  const cfg = embCfg(home);
  if (!cfg.enabled || !hasOpenAIKey()) return null;
  const e = await getEngine(home);
  if (!(await e.hasVectors())) return null;
  // HyDE/query-expansion: quando `embedText` vem, embeda ELE (query enriquecida) — casa melhor o chunk.
  const qModel = cfg.model || "text-embedding-3-small";
  const [qv] = await embed([embedText || q], qModel, cfg.dims, (tok) =>
    void recordUsage(home, { op: "embed:query", provider: "openai", model: qModel, tokensIn: tok, tokensOut: 0 }),
  );
  return e.vectorSearch(qv, k, dedupe);
}
