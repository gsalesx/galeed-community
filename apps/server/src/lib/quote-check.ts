/** Verificação de ancoragem de quote (M4/S1, anti-alucinação R4). Puro, sem IO.
 *  Um fato cujo `context_quote` não aparece na fonte é suspeito de alucinação. */
const norm = (s: string) => (s || "").toLowerCase().replace(/\s+/g, " ").trim();

export function quoteIsGrounded(quote: string, body: string): boolean {
  const q = norm(quote);
  if (!q) return true; // sem quote → não penaliza por ausência
  const b = norm(body);
  if (b.includes(q)) return true; // substring exata (após normalizar espaço)
  const qt = q.split(/[^a-zà-ú0-9]+/i).filter((t) => t.length > 3);
  if (!qt.length) return true;
  const bt = new Set(b.split(/[^a-zà-ú0-9]+/i));
  const hit = qt.filter((t) => bt.has(t)).length;
  return hit / qt.length >= 0.7; // ≥70% dos tokens significativos do quote estão na fonte
}
