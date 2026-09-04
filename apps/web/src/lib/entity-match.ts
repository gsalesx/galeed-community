/** Port DETERMINÍSTICO (e consciente) do matchEntities do motor
 *  (apps/server/src/core/retrieval/ask.ts — P1-B): decide se um TEXTO menciona uma ENTIDADE,
 *  por PALAVRA INTEIRA (fronteira unicode), nunca substring — "aceleradora" NÃO casa "accelera".
 *
 *  Uso no Dossiê (achado "Dossiê cego a fatos registrados sem triple"): fato 'registrado' nasce
 *  com entity = "" quando o extrator não fecha o triple, então nunca volta pelo /api/timeline —
 *  este helper resgata, client-side, os registrados cujo texto menciona a entidade do dossiê.
 *  Heurística IGUAL à do motor: casa quando o texto contém ≥1 token distintivo (len≥4) da
 *  entidade E ≥50% dos tokens dela. Tenant-neutro, qualquer idioma, zero léxico de negócio. */

/** token presente como PALAVRA INTEIRA (fronteira = não-letra/não-dígito unicode). */
function hasWord(text: string, token: string): boolean {
  const esc = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])`, "u").test(text);
}

/** O `text` menciona a entidade `entitySlug`? (slug com separadores -/_/espaço, ex.: "acme_corp") */
export function entityMentioned(entitySlug: string, text: string): boolean {
  const nt = (text || "").toLowerCase();
  if (!nt) return false;
  const toks = (entitySlug || "").toLowerCase().split(/[-_\s]+/).filter((t) => t.length > 2);
  if (!toks.length) return false;
  const hit = toks.filter((t) => hasWord(nt, t));
  const hasDistinctive = hit.some((t) => t.length >= 4);
  return hasDistinctive && hit.length / toks.length >= 0.5;
}
