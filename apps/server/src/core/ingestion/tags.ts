/** TAGS SEMÂNTICAS DINÂMICAS — o "selo que CRESCE". Determinístico (sem LLM): mantém um
 *  VOCABULÁRIO VIVO por brain agregando as tags das fontes (galeed_pages.tags). Tags recorrentes
 *  sobem (viram vocabulário consolidado do negócio); raras ficam visíveis pra decair.
 *  A PROPOSTA de tags novas a partir do conteúdo é do extract (LLM, TEMPO 2); aqui é só contagem. */
import { getEngine } from "../platform/engine.ts";

export interface TagStat {
  tag: string;
  count: number;
  ratio: number; // count / total de páginas (proxy de saliência)
}

/** Prefixos TÉCNICOS reservados — proveniência/contrato de acesso, não semântica do negócio:
 *  fonte:<mecanismo de entrada> · src:<uuid da fonte> · canal:<canal da fonte> · area:<escopo M7>
 *  · doc:<sha16 do upload>. Ficam FORA do vocabulário vivo e do selo epistêmico (query.ts):
 *  `#src:3f2a…` com contagem alta enterra as tags reais e vira ruído apresentado à LLM como
 *  semântica. area:/canal: são eixos próprios (escopo/proveniência) — se um dia entrarem no selo,
 *  que seja como eixo, não como tag semântica. */
const TECH_TAG_PREFIXES = ["fonte:", "src:", "canal:", "area:", "doc:"] as const;

export function isTechTag(tag: string): boolean {
  return TECH_TAG_PREFIXES.some((p) => tag.startsWith(p));
}

/** Vocabulário vivo: toda tag das fontes (exceto as técnicas — isTechTag) com contagem. */
export async function tagVocab(home: string): Promise<{ total: number; tags: TagStat[] }> {
  const e = await getEngine(home);
  const pages = await e.allPages();
  const count = new Map<string, number>();
  let total = 0;
  for (const pg of pages) {
    total++;
    for (const raw of pg.tags ?? []) {
      const tag = String(raw).trim().toLowerCase();
      if (!tag || isTechTag(tag)) continue; // técnica é proveniência/acesso, não tag semântica
      count.set(tag, (count.get(tag) ?? 0) + 1);
    }
  }
  const tags = [...count.entries()]
    .map(([tag, c]) => ({ tag, count: c, ratio: total ? c / total : 0 }))
    .sort((a, b) => b.count - a.count);
  return { total, tags };
}
