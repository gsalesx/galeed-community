/** R15 (recorte de storage) — relatório de PESO/custo da memória. Determinístico, leitura pura,
 *  zero LLM. Projeta os contadores do engine (StorageStats) em bytes estimados + coldRatio.
 *
 *  Nota: a DESIGN-SPEC pede `embCfg(home).dims`. `embCfg` é função privada de `embeddings.ts`
 *  (não exportada) e é literalmente `config(home).embeddings`. Para ficar no território (não editar
 *  config.ts/embeddings.ts) usamos a API pública equivalente `config(home).embeddings.dims`. */
import { getEngine } from "../platform/engine.ts";
import { config } from "../platform/config.ts";

export interface SustainabilityReport {
  pages: { total: number; hot: number; cold: number; archived: number };
  vectors: number;
  facts: number;
  edges: number;
  bodyBytes: number; // sum(octet_length(body)) — vem do StorageStats
  estVectorBytes: number; // vectors * dims * 4 (float32)
  estTotalBytes: number; // bodyBytes + estVectorBytes
  coldRatio: number; // pagesCold / max(1, pagesTotal)  [0..1]
  dims: number; // dimensão usada na estimativa
}

/** Monta o relatório a partir de engine.storageStats(). `dims` default = config(home).embeddings.dims. */
export async function sustainabilityReport(
  home: string,
  opts?: { dims?: number },
): Promise<SustainabilityReport> {
  const e = await getEngine(home);
  const s = await e.storageStats();
  const dims = opts?.dims ?? config(home).embeddings.dims;
  const estVectorBytes = s.vectors * dims * 4;
  const estTotalBytes = s.bodyBytes + estVectorBytes;
  const coldRatio = s.pagesCold / Math.max(1, s.pagesTotal);
  return {
    pages: {
      total: s.pagesTotal,
      hot: s.pagesHot,
      cold: s.pagesCold,
      archived: s.pagesArchived,
    },
    vectors: s.vectors,
    facts: s.facts,
    edges: s.edges,
    bodyBytes: s.bodyBytes,
    estVectorBytes,
    estTotalBytes,
    coldRatio,
    dims,
  };
}

/** Linha humana p/ CLI/doctor. Ex.:
 *  "🌱 12 páginas (9 hot · 3 cold · 3 arq) · 240 vetores · ~1.4 MB (body 0.2 + vec 1.2) · cold 25%" */
export function formatSustainability(r: SustainabilityReport): string {
  const mb = (b: number) => {
    const v = b / 1e6;
    // 1–2 casas: abaixo de 10 MB mostra 2 casas, acima disso 1 casa.
    return v < 10 ? v.toFixed(2) : v.toFixed(1);
  };
  const pct = Math.round(r.coldRatio * 100);
  return (
    `🌱 ${r.pages.total} páginas ` +
    `(${r.pages.hot} hot · ${r.pages.cold} cold · ${r.pages.archived} arq) · ` +
    `${r.vectors} vetores · ` +
    `~${mb(r.estTotalBytes)} MB (body ${mb(r.bodyBytes)} + vec ${mb(r.estVectorBytes)}) · ` +
    `cold ${pct}%`
  );
}
