/** RECONCILIAÇÃO DE CONTRADIÇÃO — canonicalização de PREDICADO (#2 do roadmap).
 *
 *  Problema: o extract gera o mesmo conceito com nomes diferentes (`preco_mensal` vs
 *  `valor_mensalidade` vs `mensalidade`). Aí a supersessão bitemporal não percebe que são a
 *  MESMA coisa e os mantém como crenças paralelas — o "mudou de ideia" se perde.
 *
 *  Sacada de design: o LLM NÃO decide "quem vence" (isso a regra determinística de supersessão
 *  já faz). O LLM só CANONICALIZA o nome do predicado. Depois a supersessão cuida do resto.
 *  → barato, e o julgamento caro fica isolado num passo opcional.
 *
 *  Fluxo: agrupa predicados por entity → acha grupos similares (string-sim DETERMINÍSTICO) →
 *  [LLM opcional refina] → grava fatos/_reconcile.json (mapa predicado→canônico por entity).
 *  O indexer LÊ esse arquivo e reescreve o predicado antes de `applyBitemporal`.
 *
 *  Princípio: roda no TEMPO 2 (sono/batch). Sem LLM, cai pro merge por similaridade de string. */
import { config } from "../platform/config.ts";
import { resolveProvider, prose } from "../../lib/llm.ts";
import { getEngine, type ReconcileMap } from "../platform/engine.ts";
import { loadSchemaPack, ensureSchemaPack, type SchemaPack } from "../extraction/schema-pack.ts";

export type { ReconcileMap } from "../platform/engine.ts";

/** distância de edição normalizada (0=idêntico, 1=totalmente diferente). */
function editSim(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (!m || !n) return 0;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return 1 - d[m][n] / Math.max(m, n);
}

/** sobreposição de tokens (snake_case): {preco,mensal} vs {valor,mensal} → 0.33. */
function tokenSim(a: string, b: string): number {
  const ta = new Set(a.split("_")), tb = new Set(b.split("_"));
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / new Set([...ta, ...tb]).size;
}

/** Sinônimos vêm do SCHEMA-PACK do brain (default vazio → sempre false). NADA de vocabulário de negócio
 *  no core: o produto não pode nascer amarrado a um idioma/domínio. Ver ADR-002 + schema-pack.ts. */
function sameSynonymClass(a: string, b: string, pack: SchemaPack): boolean {
  if (!pack.synonymClasses.length) return false;
  const synOf = new Map<string, number>();
  pack.synonymClasses.forEach((cls, i) => cls.forEach((tok) => synOf.set(tok, i)));
  const ca = new Set<number>(), cb = new Set<number>();
  for (const t of a.split("_")) if (synOf.has(t)) ca.add(synOf.get(t)!);
  for (const t of b.split("_")) if (synOf.has(t)) cb.add(synOf.get(t)!);
  for (const c of ca) if (cb.has(c)) return true;
  return false;
}

/** Papel semântico do predicado SEGUNDO O PACK (sem pack → null, não bloqueia). */
function roleOf(p: string, pack: SchemaPack): string | null {
  const toks = new Set(p.split("_"));
  for (const [role, tokens] of Object.entries(pack.roleTokens)) if (tokens.some((t) => toks.has(t))) return role;
  return null;
}
/** HARD GATE de integridade: papéis opostos do pack (ex.: gasto ≠ receita) NUNCA fundem, por mais
 *  parecido que seja o nome. Sem pack de papéis → neutro. (Foi o bug: ad-spend→ticket.)
 *  Exportada p/ teste de invariante (test/unit/reconcile-integrity.test.ts). */
export function roleConflict(a: string, b: string, pack: SchemaPack): boolean {
  const ra = roleOf(a, pack), rb = roleOf(b, pack);
  return !!ra && !!rb && ra !== rb;
}

/** Candidatos a MESMO conceito. DEFAULT (sem pack) = só ESTRUTURAL e CONSERVADOR — typo/acento
 *  (editSim alto) ou tokens snake_case compartilhados. Isso é neutro a idioma/domínio e prioriza
 *  precisão > recall (na dúvida, não funde). O pack adiciona sinônimos do negócio; o hard gate de papel
 *  veta opostos. A sinonímia semântica de verdade (cross-idioma, sem lista) vem do LLM-judge na
 *  verificação. */
export function similar(a: string, b: string, pack: SchemaPack): boolean {
  if (roleConflict(a, b, pack)) return false; // na dúvida, NÃO funde
  return editSim(a, b) >= 0.85 || tokenSim(a, b) >= 0.6 || sameSynonymClass(a, b, pack);
}

/** Lê todas as extrações e devolve, por entity, o conjunto de predicados com contagem. */
async function predicatesByEntity(home: string): Promise<Map<string, Map<string, number>>> {
  const out = new Map<string, Map<string, number>>();
  const e = await getEngine(home);
  for (const ex of await e.allExtractions()) {
    for (const arr of Object.values(ex.extractions || {})) {
      if (!Array.isArray(arr)) continue;
      for (const it of arr as any[]) {
        const ent = String(it.entity || "").toLowerCase().trim();
        const p = String(it.predicate || "").toLowerCase().trim().replace(/\s+/g, "_");
        if (!ent || !p) continue;
        const m = out.get(ent) ?? out.set(ent, new Map()).get(ent)!;
        m.set(p, (m.get(p) ?? 0) + 1);
      }
    }
  }
  return out;
}

export interface ReconcileResult {
  entities: number;
  merges: { entity: string; canonical: string; aliases: string[] }[];
  provider: "deterministico" | "cli" | "api";
}

/** Constrói/atualiza o mapa de canonicalização. NEUTRO A DOMÍNIO/IDIOMA: o default só funde por
 *  estrutura (typo/token) + schema-pack do brain (opcional). Com `useLlm`, o LLM-judge VERIFICA cada
 *  grupo (pode VETAR um merge errado) e escolhe o canônico — é a semântica geral, cross-idioma, sem
 *  lista hardcoded. Precisão > recall: na dúvida, não funde. */
export async function reconcile(home: string, opts: { useLlm?: boolean } = {}): Promise<ReconcileResult> {
  await ensureSchemaPack(home); // M13: garante que o pack DB-first esteja no cache síncrono ANTES de loadSchemaPack
  const byEntity = await predicatesByEntity(home);
  const pack = loadSchemaPack(home); // vazio por default → core não nasce amarrado a um negócio
  const map: ReconcileMap = {};
  const merges: ReconcileResult["merges"] = [];
  let usedLlm = false;
  const cfg = config(home);
  const provider = resolveProvider(cfg.provider);

  for (const [entity, preds] of byEntity) {
    const names = [...preds.keys()];
    if (names.length < 2) continue;

    // agrupa predicados similares (union-find simples)
    const parent = new Map(names.map((n) => [n, n]));
    const find = (x: string): string => (parent.get(x) === x ? x : parent.set(x, find(parent.get(x)!)).get(x)!);
    for (let i = 0; i < names.length; i++)
      for (let j = i + 1; j < names.length; j++)
        if (similar(names[i], names[j], pack)) parent.set(find(names[i]), find(names[j]));

    const clusters = new Map<string, string[]>();
    for (const n of names) (clusters.get(find(n)) ?? clusters.set(find(n), []).get(find(n))!).push(n);

    for (const group of clusters.values()) {
      if (group.length < 2) continue; // nada a reconciliar
      // canônico determinístico = o mais frequente (desempate: mais curto)
      let canonical = group.sort((a, b) => (preds.get(b)! - preds.get(a)!) || a.length - b.length)[0];

      // LLM-judge (geral, cross-idioma): VERIFICA se o grupo é mesmo UM atributo (pode vetar) e nomeia.
      if (opts.useLlm && (provider === "cli" || provider === "api")) {
        try {
          const ans = await prose({
            provider,
            model: provider === "cli" ? cfg.cliModel : cfg.apiModel,
            system:
              "Você verifica se nomes de atributos descrevem EXATAMENTE o mesmo atributo da mesma entidade. " +
              "Papéis diferentes (ex.: dinheiro que ENTRA vs que SAI, valor vs quantidade) NÃO são o mesmo. " +
              "Se forem o mesmo, responda SÓ o nome canônico em snake_case. Se NÃO forem, responda só: NAO.",
            prompt: `Entidade "${entity}". Estes nomes descrevem o mesmo atributo? ${group.join(", ")}`,
          });
          const raw = ans.trim();
          usedLlm = true;
          if (/^n[aã]o$/i.test(raw)) continue; // LLM VETOU o merge → não funde (na dúvida, separa)
          const clean = raw.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
          if (clean && clean.length <= 40) canonical = clean;
        } catch {
          /* mantém o determinístico */
        }
      }

      map[entity] ??= {};
      for (const alias of group) if (alias !== canonical) map[entity][alias] = canonical;
      merges.push({ entity, canonical, aliases: group.filter((g) => g !== canonical) });
    }
  }

  await (await getEngine(home)).putReconcile(map);
  return { entities: byEntity.size, merges, provider: usedLlm ? provider : "deterministico" };
}
