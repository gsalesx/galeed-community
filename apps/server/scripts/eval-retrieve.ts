/** EVAL — caminho de leitura de produto: pra cada query do gabarito, o doc ESPERADO aparece no top-k?
 *  Compara 3 sinais: FTS (search), semântico (semanticSearch), e a fusão RRF (retrieve). */
import { search, retrieve } from "../src/core/retrieval/query.ts";
import { semanticSearch } from "../src/core/retrieval/embeddings.ts";
import { closeEngines } from "../src/core/platform/engine.ts";

const HOME = "eval-a360";
const K = 6;

// query → fragmento do slug esperado (gabarito)
const CASES: { q: string; expect: string }[] = [
  { q: "incentivo do governo de Portugal para inteligência artificial", expect: "ezequias" },
  { q: "qual o ticket médio do cliente Inject System", expect: "caike" },
  { q: "contrato de 497 mil com cliente do ramo imobiliário", expect: "ronaldo" },
  { q: "como funciona o repricing e a Buy Box na Amazon", expect: "kelvin-joao" },
  { q: "framework DATA diagnosticar analisar transformar ativar", expect: "matheus-zafred" },
  { q: "renomear a agência para acelera 2050 ticket de 20 mil", expect: "kelvin-paulo" },
  { q: "meta de faturamento de 4 milhões para 2026", expect: "caike" },
  { q: "plataforma multi-tenant de agentes de IA codada do zero", expect: "ronaldo" },
];

const inTop = (hits: any[], frag: string) =>
  (hits || []).slice(0, K).findIndex((h) => (h.slug || "").includes(frag));

let ftsOk = 0, semOk = 0, rrfOk = 0;
const rows: string[] = [];
for (const c of CASES) {
  const fts = await search(HOME, c.q, K).catch(() => []);
  const sem = (await semanticSearch(HOME, c.q, K).catch(() => [])) || [];
  const rrf = await retrieve(HOME, c.q, K).catch(() => []);
  const fi = inTop(fts, c.expect), si = inTop(sem, c.expect), ri = inTop(rrf as any[], c.expect);
  if (fi >= 0) ftsOk++; if (si >= 0) semOk++; if (ri >= 0) rrfOk++;
  const pos = (i: number) => (i < 0 ? "—" : `#${i + 1}`);
  rows.push(`${c.expect.padEnd(14)} | FTS ${pos(fi).padEnd(3)} | SEM ${pos(si).padEnd(3)} | RRF ${pos(ri).padEnd(3)} | "${c.q.slice(0, 42)}"`);
}
console.log(rows.join("\n"));
console.log(`\nACERTO no top-${K}:  FTS ${ftsOk}/${CASES.length} · SEM ${semOk}/${CASES.length} · RRF ${rrfOk}/${CASES.length}`);
await closeEngines();
process.exit(0);
