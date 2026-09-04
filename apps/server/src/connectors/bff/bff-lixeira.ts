/** LIXEIRA de páginas — ver o que o cérebro decidiu esquecer e trazer de volta com um clique.
 *
 *  Achado "Painel não tem lixeira nem restauração" (decaimento-lixeira, validado em código):
 *  allPages/search/graphAll filtram archived (postgres.ts) e NENHUMA rota expunha as páginas
 *  arquivadas nem chamava restauração — pro usuário leigo, arquivar era indistinguível de
 *  apagar. Aqui: listagem (SELECT direto — o engine não tem archivedPages(); postgres.ts é
 *  território de outro pacote, então a query mora na borda, padrão ADR-013 via getSharedSql)
 *  + restauração via restoreCold (core/memory/tiering.ts — cobre cold E archived+hot).
 *
 *  Handlers PUROS no padrão bff-percepcoes.ts. ZERO LLM (o re-embed do restore é embeddings,
 *  não LLM de síntese). RBAC: requireBrain no web-server ANTES (leitura/ação do dono). */
import { getSharedSql } from "../../core/platform/db-conn.ts";
import { restoreCold } from "../../core/memory/tiering.ts";
import { BffError } from "./bff-common.ts";

/** Uma página na lixeira (subset leve — o body NÃO viaja pra listagem). */
export interface LixeiraItem {
  slug: string;
  type: string;
  title: string;
  date: string;
  tier: string; // 'hot' = vetores ainda presentes | 'cold' = resfriada (re-embeda no restore)
}

export interface LixeiraPage {
  items: LixeiraItem[];
  total: number; // total de arquivadas no brain (a lista corta em LIMIT)
}

export interface RestauroResult {
  slug: string;
  restored: boolean; // false = não existe ou já está ativa (nada a restaurar)
  vectorsRebuilt: number;
}

const LIMIT = 500; // teto da listagem (lixeira maior que isso ainda mostra o total honesto)

/** GET /api/lixeira → páginas com archived=true, mais recentes primeiro. */
export async function lixeiraHandler(home: string): Promise<LixeiraPage> {
  const sql = await getSharedSql();
  const rows = (await sql`
    select slug, type, title, date, coalesce(tier, 'hot') as tier
    from galeed_pages
    where brain = ${home} and coalesce(archived, false) = true
    order by date desc, slug asc
    limit ${LIMIT}`) as any[];
  const totalRows = (await sql`
    select count(*)::int as n
    from galeed_pages
    where brain = ${home} and coalesce(archived, false) = true`) as any[];
  return {
    items: rows.map((r) => ({
      slug: String(r.slug),
      type: String(r.type ?? ""),
      title: String(r.title ?? ""),
      date: String(r.date ?? ""),
      tier: String(r.tier ?? "hot"),
    })),
    total: Number(totalRows[0]?.n ?? rows.length),
  };
}

/** POST /api/lixeira/restaurar { slug } → desarquiva/reaquece a página (restoreCold cobre os dois
 *  estados: cold pós-shed e archived+hot pós-prune). Nada é apagado na lixeira — restaurar é
 *  sempre possível; restored:false = slug inexistente ou página já ativa (o front avisa). */
export async function restaurarHandler(home: string, slug: string): Promise<RestauroResult> {
  const s = (slug || "").trim();
  if (!s) throw new BffError(400, "diga qual memória restaurar (slug).");
  return restoreCold(home, s);
}
