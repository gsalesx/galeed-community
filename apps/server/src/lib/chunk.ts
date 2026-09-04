/** Chunking simples por janela de caracteres com sobreposição. Robusto (lida com parágrafos
 *  gigantes de transcrição). Bom o suficiente para busca semântica num cérebro pequeno. */
export function chunkText(body: string, size = 1200, overlap = 150): string[] {
  const clean = body.replace(/\r/g, "").trim();
  if (!clean) return [];
  if (clean.length <= size) return [clean];
  const out: string[] = [];
  let i = 0;
  const step = Math.max(1, size - overlap);
  while (i < clean.length) {
    out.push(clean.slice(i, i + size));
    i += step;
  }
  return out;
}
