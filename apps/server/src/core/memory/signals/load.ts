/** M24-A — carrega o snapshot dos detectores do engine (SÓ LEITURA, leitura DIRIGIDA):
 *  1. currentFacts() → chaves de grupo vigentes (1 linha por grupo — índice parcial 26/P1-A);
 *  2. factsInGroups(keys) → as cadeias bitemporais COMPLETAS desses grupos (todas as versões,
 *     superseded incluídas — é a série temporal do D1; índice 11/M9);
 *  3. pagesBySlug(slugs) → datas das páginas-fonte (eventos do D2);
 *  4. entityGraph() → factCount/degree/role/first_seen por entidade (salience do priorizador);
 *     entidade fora do grafo (< minFacts do entityGraph) → fallback computado das cadeias
 *     (factCount = nº de fatos, degree 0, role "assunto", firstSeen = menor valid_from).
 *  LIMITAÇÃO ANOTADA: grupos SEM versão vigente (cadeia toda fechada) ficam fora — por
 *  construção do applyBitemporal a cabeça da cadeia é sempre vigente, então é caso raro/legado.
 *  `now` injetável (determinismo nos testes). */
import { getEngine } from "../../platform/engine.ts";
import {
  type EntitySalienceInfo,
  type SeriesGroup,
  type SignalInputs,
} from "./types.ts";

export async function loadSignalInputs(home: string, now?: Date): Promise<SignalInputs> {
  const e = await getEngine(home);
  const cur = await e.currentFacts();

  // chaves de grupo únicas (entity != "" — currentFacts já filtra; engine.ts:500)
  const keyOf = (f: { entity?: string; predicate?: string; tier?: string }) =>
    `${f.entity ?? ""} ${f.predicate ?? ""} ${f.tier ?? ""}`;
  const keys = [...new Map(cur.map((f) => [keyOf(f), { entity: f.entity ?? "", predicate: f.predicate ?? "", tier: f.tier ?? "" }])).values()];

  const rows = keys.length ? await e.factsInGroups(keys) : [];
  const byKey = new Map<string, SeriesGroup>();
  for (const r of rows) {
    const k = keyOf(r);
    const g = byKey.get(k) ?? byKey.set(k, { entity: r.entity, predicate: r.predicate, tier: r.tier ?? "", facts: [] }).get(k)!;
    g.facts.push({
      entity: r.entity, predicate: r.predicate, tier: r.tier ?? "", value: r.value,
      value_num: r.value_num ?? null, valid_from: r.valid_from, valid_to: r.valid_to,
      confidence: r.confidence, status: r.status, source_slug: r.source_slug, meta: r.meta ?? {},
    });
  }
  const grupos = [...byKey.values()];
  for (const g of grupos)
    g.facts.sort((a, b) => a.valid_from.localeCompare(b.valid_from) || a.source_slug.localeCompare(b.source_slug));
  grupos.sort((a, b) => a.entity.localeCompare(b.entity) || a.predicate.localeCompare(b.predicate) || a.tier.localeCompare(b.tier));

  // datas das páginas-fonte (eventos do D2) — leitura em batch, dirigida
  const slugs = [...new Set(rows.map((r) => r.source_slug).filter(Boolean))];
  const pages = slugs.length ? await e.pagesBySlug(slugs) : new Map();
  const pageDates = new Map<string, string>();
  for (const s of slugs) pageDates.set(s, pages.get(s)?.date ?? "");

  // salience por entidade: entityGraph (M19) primeiro; fallback das cadeias
  const saliences = new Map<string, EntitySalienceInfo>();
  const g = await e.entityGraph();
  const degree = new Map<string, number>();
  for (const ed of g.edges) {
    degree.set(ed.src, (degree.get(ed.src) ?? 0) + 1);
    degree.set(ed.dst, (degree.get(ed.dst) ?? 0) + 1);
  }
  for (const n of g.nodes)
    saliences.set(n.id, { factCount: n.factCount, degree: degree.get(n.id) ?? 0, role: n.role ?? n.type, firstSeen: n.date || "" });
  for (const gr of grupos) {
    if (saliences.has(gr.entity)) continue;
    const prev = saliences.get(gr.entity);
    const factCount = grupos.filter((x) => x.entity === gr.entity).reduce((a, x) => a + x.facts.length, 0);
    const firstSeen = grupos.filter((x) => x.entity === gr.entity).flatMap((x) => x.facts.map((f) => f.valid_from)).filter(Boolean).sort()[0] ?? "";
    if (!prev) saliences.set(gr.entity, { factCount, degree: 0, role: "assunto", firstSeen });
  }

  const hoje = (now ?? new Date()).toISOString().slice(0, 10);
  return { grupos, pageDates, saliences, hoje };
}
