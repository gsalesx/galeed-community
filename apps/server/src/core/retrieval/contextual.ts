/** Contextual Retrieval (Anthropic) — situa o chunk no contexto da página antes de embeddar (S3/M2).
 *  Sinopse via LLM barato (Haiku), cacheada por content_hash. O prefixo é determinístico; o chunk
 *  ORIGINAL é o que fica guardado em galeed_vectors.text (citação não polui). Sem provider/LLM,
 *  cai pra prefixo só-com-título — ainda ajuda, nunca quebra o embed. */
import { config } from "../platform/config.ts";
import { resolveProvider, prose } from "../../lib/llm.ts";
import { getEngine, type PageRow } from "../platform/engine.ts";
import { isTechTag } from "../ingestion/tags.ts";

const SYS =
  "Em 1 frase curta (≤ 25 palavras), situe este documento no contexto de uma empresa: do que trata " +
  "e a quem/que assunto se refere. Sem preâmbulo, sem aspas.";

/** Contexto DETERMINÍSTICO (sem LLM, grátis) do documento, p/ situar cada chunk: do que trata e a
 *  quem se refere. É o maior lever de recall barato (Anthropic Contextual Retrieval, versão sem custo):
 *  um chunk "13 a 17 mil" passa a carregar "reunião · Caike · Inject System" e casa a query.
 *  Monta de campos estruturados (título, tipo, data, pessoas, tags) que JÁ existem na página. */
export function deterministicContext(p: { title?: string; type?: string; date?: string; people?: string[]; tags?: string[] }): string {
  const bits: string[] = [];
  if (p.title && !/^title$/i.test(p.title)) bits.push(p.title);
  if (p.type) bits.push(p.type);
  if (p.date) bits.push(p.date);
  const ppl = (p.people || []).filter(Boolean).slice(0, 8);
  if (ppl.length) bits.push(ppl.join(", "));
  // técnicas (src:<uuid>/doc:<sha>/canal:/area:) são proveniência/acesso, não semântica — fora do
  // prefixo de embedding (senão `#src:3f2a…` polui o vetor). Mesmo critério do vocabulário/selo (tags.ts).
  const tags = (p.tags || []).filter((t) => t && !isTechTag(t)).slice(0, 6);
  if (tags.length) bits.push(tags.map((t) => "#" + t).join(" "));
  return bits.join(" · ");
}

/** Prefixo anexado ao chunk antes de embeddar. `context` = contexto determinístico (+sinopse opcional).
 *  Nunca usa LLM aqui. O chunk ORIGINAL é o que fica guardado (citação não polui). */
export function contextualizeChunk(context: string, synopsis: string, chunk: string): string {
  const head = [context, synopsis].filter(Boolean).join(" · ");
  return head ? `[${head}]\n\n${chunk}` : chunk;
}

/** Gera (ou reusa do cache) a sinopse de UMA página. LLM só se faltar/estiver stale e houver provider. */
export async function pageSynopsis(home: string, page: PageRow): Promise<string> {
  const e = await getEngine(home);
  const hash = page.content_hash || "";
  const { synopsis, synopsis_hash } = await e.getSynopsis(page.slug);
  if (synopsis && synopsis_hash === hash) return synopsis; // cache fresco

  const cfg = config(home);
  const provider = resolveProvider(cfg.provider);
  if (provider !== "cli" && provider !== "api") return ""; // sem LLM → só-título
  try {
    const body = page.body.length > 4000 ? page.body.slice(0, 4000) : page.body;
    const out = await prose({
      provider,
      model: provider === "cli" ? cfg.cliModel : cfg.apiModel,
      system: SYS,
      prompt: `Título: ${page.title || page.slug}\n\n${body}`,
    });
    const syn = out.trim().replace(/^["']|["']$/g, "").slice(0, 300);
    if (syn) await e.setSynopsis(page.slug, syn, hash);
    return syn;
  } catch {
    return ""; // best-effort: erro de LLM nunca aborta o embed
  }
}

/** Garante a sinopse de todas as páginas que mudaram. Mapa slug→synopsis (vazio sem LLM). */
export async function ensureSynopses(home: string, onLog?: (s: string) => void): Promise<Map<string, string>> {
  // M6: sinopse LLM é OPT-IN (GALEED_CONTEXTUAL=1). Default OFF porque, medido no gate, a sinopse
  // RASA (intro-truncada) REGREDIU o recall (0.82→0.73): contexto genérico dilui o sinal do chunk.
  // Só vale com sinopse de doc-INTEIRO (map-reduce) provada no gate. O contexto determinístico
  // (metadado) continua sempre ligado em buildEmbeddings, de graça.
  if (process.env.GALEED_CONTEXTUAL !== "1") return new Map();
  const e = await getEngine(home);
  const pages = await e.allPages();
  const out = new Map<string, string>();
  let i = 0;
  for (const pg of pages) {
    out.set(pg.slug, await pageSynopsis(home, pg));
    if (++i % 10 === 0) onLog?.(`  sinopses ${i}/${pages.length}`);
  }
  return out;
}
