/** EVAL S2+ — gera SINOPSE por documento (1 frase: do que trata + a quem se refere) via OpenAI
 *  gpt-4o-mini, em PARALELO (rápido/barato), e cacheia em galeed_pages.synopsis (hash=content_hash).
 *  Depois, buildEmbeddings (com GALEED_CONTEXTUAL ligado) usa a sinopse cacheada SEM LLM no caminho.
 *  É o lever de TÓPICO que o contexto determinístico (metadado) não captura → recall de passagem. */
import { getEngine, closeEngines } from "../src/core/platform/engine.ts";

const HOME = "eval-a360";
const KEY = process.env.OPENAI_API_KEY!;
const CONCURRENCY = Number(process.env.SYN_CONCURRENCY || 16);
const SYS =
  "Em 1 frase curta (≤ 30 palavras), situe este documento no contexto de uma empresa: do que trata e " +
  "a quem/que assunto/cliente se refere. Cite nomes próprios de clientes/empresas/pessoas se houver. Sem preâmbulo, sem aspas.";

async function synopsize(title: string, body: string): Promise<string> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: SYS },
        { role: "user", content: `Título: ${title}\n\n${body.slice(0, 4000)}` },
      ],
      max_tokens: 80,
      temperature: 0,
    }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}`);
  const j: any = await res.json();
  return (j.choices?.[0]?.message?.content || "").trim().replace(/^["']|["']$/g, "").slice(0, 300);
}

const e: any = await getEngine(HOME);
const pages = await e.allPages();
let done = 0, ok = 0, err = 0;
const t0 = Date.now();

async function worker(slice: any[]) {
  for (const p of slice) {
    try {
      const cur = await e.getSynopsis(p.slug);
      if (cur.synopsis && cur.synopsis_hash === (p.content_hash || "")) { ok++; done++; continue; } // cache fresco
      const syn = await synopsize(p.title || p.slug, p.body || "");
      if (syn) { await e.setSynopsis(p.slug, syn, p.content_hash || ""); ok++; }
    } catch { err++; }
    if (++done % 100 === 0) console.error(`  ${done}/${pages.length} (${((Date.now() - t0) / 1000) | 0}s)`);
  }
}
// reparte em CONCURRENCY fatias e roda em paralelo
const slices: any[][] = Array.from({ length: CONCURRENCY }, () => []);
pages.forEach((p: any, i: number) => slices[i % CONCURRENCY].push(p));
await Promise.all(slices.map(worker));

console.log(JSON.stringify({ pages: pages.length, ok, err, ms: Date.now() - t0 }));
await closeEngines();
process.exit(0);
