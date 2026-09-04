/** Extração determinística de FALANTES de transcrição (sem LLM).
 *  O corpus real não tem [[wikilinks]], mas tem o grafo escondido: QUEM FALA em cada reunião.
 *  "Kelvin Cleto: ..." → entidade pessoa. Duas reuniões que compartilham falantes, ou duas
 *  pessoas que co-ocorrem, formam o grafo naturalmente — base pro sonho/expansão no corpus real.
 *
 *  Heurística: linha começando com "Nome Sobrenome:" (2-4 palavras Capitalizadas, ≤40 chars antes
 *  do ':'). Conta falas por pessoa; ignora ruído (1 fala = provável artefato). Canonicaliza pelo slug. */
import { slugify } from "../../lib/slug.ts";

const SPEAKER_RE = /^([A-ZÀ-Ú][\p{L}.'-]+(?:\s+[A-ZÀ-Ú][\p{L}.'-]+){0,3}):\s/u;
const MIN_TURNS = 2; // ≥2 falas pra contar como participante real (corta ruído de transcrição)
const STOP = new Set(["transcrição", "transcricao", "participantes", "resumo", "ata", "notas", "obs"]);

export interface Speaker {
  name: string; // nome legível ("Kelvin Cleto")
  slug: string; // canônico ("kelvin-cleto") — vira o id do nó-pessoa
  turns: number; // nº de falas (peso)
}

/** Extrai os falantes de um corpo de transcrição. Determinístico. */
export function extractSpeakers(body: string): Speaker[] {
  const turns = new Map<string, { name: string; n: number }>();
  for (const line of body.split("\n")) {
    const m = line.match(SPEAKER_RE);
    if (!m) continue;
    const name = m[1].trim();
    if (name.length > 40 || name.length < 3) continue;
    const slug = slugify(name);
    if (!slug || STOP.has(slug)) continue;
    // descarta "palavra única minúscula" e tokens que claramente não são nome
    if (!/[A-ZÀ-Ú]/.test(name[0])) continue;
    const cur = turns.get(slug) ?? { name, n: 0 };
    cur.n++;
    turns.set(slug, cur);
  }
  return [...turns.entries()]
    .filter(([, v]) => v.n >= MIN_TURNS)
    .map(([slug, v]) => ({ name: v.name, slug: `pessoas/${slug}`, turns: v.n }))
    .sort((a, b) => b.turns - a.turns);
}
