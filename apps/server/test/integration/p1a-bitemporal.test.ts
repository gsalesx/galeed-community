/** P1-A — o caso canônico da VERDADE bitemporal (a LEI do pacote). DB real, ZERO LLM: semeia
 *  upsertPage + putExtraction direto (NUNCA putPage, LEARNINGS M17/S4) e deriva com buildIndex/
 *  deriveIncremental. Série do preço da Accelera (memória do fundador), intercalada com
 *  corroborações de fontes distintas. Skip automático sem DATABASE_URL. NUNCA toca brains de
 *  produção/Accelera — brains sufixados *-p1a-bitemporal. */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { hasDb, wipeBrain, rawConnect } from "./helpers/db.ts";
import { getEngine, closeEngines, type PageRow, type ExtractionRow } from "../../src/core/platform/engine.ts";
import { buildIndex, deriveIncremental } from "../../src/core/retrieval/indexer.ts";

const BRAIN = "canonico-p1a-bitemporal";
const ENGINE_BRAIN = "engine-p1a-bitemporal";
const ENTITY = "accelera";
const PRED = "preco_mensal";

const page = (slug: string, date: string, body: string): PageRow => ({
  slug, type: "reunioes", title: slug, date, path: "", body, content_hash: slug,
});

/** claim numérico ancorado: body com o número VERBATIM (senão valueIsAnchored rebaixa). */
const extraction = (slug: string, date: string, value_num: number, validFrom: string): ExtractionRow => ({
  source_slug: slug, type: "reunioes", date, content_hash: slug, prompt_version: "test",
  extractions: {
    facts: [{
      entity: ENTITY, predicate: PRED, value: String(value_num), value_num,
      unit: "BRL", period: "monthly", valid_from: validFrom,
      context_quote: `plano fechado em ${value_num}`, text: `preço ${value_num}`,
    }],
  },
});

const SERIE: Array<[string, string, number, string]> = [
  ["jan", "2026-01-10", 3000, "2026-01-10"],
  ["fev", "2026-02-10", 5000, "2026-02-10"],
  ["fev-b", "2026-02-20", 5000, "2026-02-20"],
  ["mar", "2026-03-10", 12000, "2026-03-10"],
  ["abr", "2026-04-10", 18000, "março de 2024"], // valid_from LIXO → fallback data da página
  ["mai", "2026-05-10", 30000, "2026-05-10"],
  ["mai-b", "2026-05-20", 30000, "2026-05-20"],
];

async function seed() {
  await wipeBrain(BRAIN);
  const e = await getEngine(BRAIN);
  for (const [slug, date, val] of SERIE) {
    await e.upsertPage(page(slug, date, `Accelera: plano fechado em ${val} por mês.`));
  }
  for (const [slug, date, val, vf] of SERIE) {
    await e.putExtraction(extraction(slug, date, val, vf));
  }
  await buildIndex(BRAIN);
}

describe.skipIf(!hasDb())("P1-A — verdade bitemporal canônica (DB real, zero LLM)", () => {
  beforeAll(async () => {
    await seed();
  });

  afterAll(async () => {
    await wipeBrain(BRAIN);
    await wipeBrain(ENGINE_BRAIN);
    await closeEngines();
  });

  it("L1 — EXATAMENTE 1 vigente por grupo (currentFacts + SQL cru)", async () => {
    const e = await getEngine(BRAIN);
    const cur = (await e.currentFacts()).filter((f) => f.entity === ENTITY && f.predicate === PRED);
    expect(cur).toHaveLength(1);
    expect(cur[0].value_num).toBe(30000);
    expect(cur[0].status).toBe("fato");
    expect(cur[0].valid_to).toBe("");

    const sql = await rawConnect();
    try {
      const rows = (await sql.unsafe(
        `select count(*)::int c from galeed_facts where brain=$1 and entity=$2 and predicate=$3 and coalesce(tier,'')=$4 and status='fato' and (valid_to is null or valid_to='')`,
        [BRAIN, ENTITY, PRED, ""],
      )) as any[];
      expect(rows[0].c).toBe(1);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it("timeline íntegra e ordenada — todo elo não-final fecha no sucessor", async () => {
    const e = await getEngine(BRAIN);
    const tl = (await e.timeline(ENTITY, { predicate: PRED })).filter((f) => f.predicate === PRED);
    // ordenada por valid_from (timeline já ordena) — valores na ordem da série
    const vals = tl.map((f) => f.value_num);
    expect(vals).toEqual([3000, 5000, 5000, 12000, 18000, 30000, 30000]);
    // todo elo não-final tem valid_to = valid_from do sucessor (sucessores são datados)
    for (let i = 0; i < tl.length - 1; i++) {
      expect(tl[i].valid_to).toBe(tl[i + 1].valid_from);
    }
    expect(tl[tl.length - 1].valid_to).toBe(""); // último vigente
    // corroborações ('corroborado') e degraus ('arquivado')
    const byVf = (vf: string) => tl.find((f) => f.valid_from === vf)!;
    expect(byVf("2026-02-10").status).toBe("corroborado"); // 5k(fev) → 5k(fev-b)
    expect(byVf("2026-02-20").status).toBe("arquivado"); // 5k(fev-b) → 12k(mar) degrau
    expect(byVf("2026-05-10").status).toBe("corroborado"); // 30k(mai) → 30k(mai-b)
  });

  it("A1d/L3 — lixo não corrompe: nenhum valid_from não-ISO; 18k usa data da página", async () => {
    const e = await getEngine(BRAIN);
    const tl = (await e.timeline(ENTITY, { predicate: PRED })).filter((f) => f.predicate === PRED);
    expect(tl.every((f) => f.valid_from !== "março de 2024")).toBe(true);
    const f18 = tl.find((f) => f.value_num === 18000)!;
    expect(f18.valid_from).toBe("2026-04-10"); // fallback: data da página
    // está ENTRE 12k e 30k na cadeia (não "depois de tudo")
    const idx = tl.findIndex((f) => f.value_num === 18000);
    expect(tl[idx - 1].value_num).toBe(12000);
    expect(tl[idx + 1].value_num).toBe(30000);
  });

  it("facts(asOf) — valor certo por mês (comparação lexicográfica, datas completas)", async () => {
    const e = await getEngine(BRAIN);
    const at = async (asOf: string) => {
      const rows = (await e.facts("facts", { asOf })).filter((f) => f.entity === ENTITY && f.predicate === PRED);
      return rows.map((f) => f.value_num);
    };
    expect(await at("2026-01-15")).toContain(3000);
    expect(await at("2026-02-15")).toContain(5000);
    expect(await at("2026-02-25")).toContain(5000); // linha corroborada cobre a janela
    expect(await at("2026-03-15")).toContain(12000);
    expect(await at("2026-04-15")).toContain(18000);
    expect(await at("2026-06-01")).toContain(30000);
  });

  it("M2/L2 — derive 2× não infla; equivalência incremental ≡ full", async () => {
    const e = await getEngine(BRAIN);
    const capture = async () => {
      const tl = (await e.timeline(ENTITY, { predicate: PRED })).filter((f) => f.predicate === PRED);
      const m = new Map<string, number>();
      for (const f of tl) m.set(`${f.value_num}|${f.valid_from}`, f.confidence!);
      return m;
    };
    const base = await capture();
    // confianças esperadas: runs de 2 fontes = 0.75; runs de 1 fonte = 0.60
    expect(base.get("5000|2026-02-10")).toBeCloseTo(0.75, 10);
    expect(base.get("30000|2026-05-10")).toBeCloseTo(0.75, 10);
    expect(base.get("3000|2026-01-10")).toBeCloseTo(0.6, 10);
    expect(base.get("12000|2026-03-10")).toBeCloseTo(0.6, 10);

    await deriveIncremental(BRAIN, ["fev-b"]);
    const after1 = await capture();
    await deriveIncremental(BRAIN, ["fev-b"]);
    const after2 = await capture();
    const eq = (a: Map<string, number>, b: Map<string, number>) => {
      expect([...a.keys()].sort()).toEqual([...b.keys()].sort());
      for (const [k, v] of a) expect(b.get(k)).toBeCloseTo(v, 10);
    };
    eq(after1, base);
    eq(after2, base);
  });

  it("determinismo do banco — currentFacts byte-idêntico; facts(limit) traz as MAIS NOVAS", async () => {
    // roda ANTES do ghost (C4) ser semeado, pra medir o recorte sobre a cadeia limpa.
    const e = await getEngine(BRAIN);
    const a = await e.currentFacts();
    const b = await e.currentFacts();
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    const top3 = (await e.facts("facts", { limit: 3 })).filter((f) => f.entity === ENTITY && f.predicate === PRED);
    // as 3 linhas mais novas por valid_from (desc): mai-b(30k), mai(30k), abr(18k)
    expect(top3.map((f) => f.value_num)).toEqual([30000, 30000, 18000]);
  });

  it("C4 + A2b — claim sem value_num e sem quote vira nao-verificado, fora de currentFacts", async () => {
    const e = await getEngine(BRAIN);
    await e.upsertPage(page("ghost", "2026-06-01", "Accelera: nota sem evidência."));
    await e.putExtraction({
      source_slug: "ghost", type: "reunioes", date: "2026-06-01", content_hash: "ghost", prompt_version: "test",
      extractions: { facts: [{ entity: ENTITY, predicate: PRED, value: "99999", valid_from: "2026-06-01" }] },
    });
    await deriveIncremental(BRAIN, ["ghost"]);
    const tl = (await e.timeline(ENTITY, { predicate: PRED })).filter((f) => f.predicate === PRED);
    const ghost = tl.find((f) => f.source_slug === "ghost");
    expect(ghost).toBeDefined();
    expect(ghost!.status).toBe("nao-verificado");
    const cur = (await e.currentFacts()).filter((f) => f.entity === ENTITY && f.predicate === PRED);
    expect(cur).toHaveLength(1);
    expect(cur[0].value_num).toBe(30000); // o vigente segue sendo o 30k
  });

  it("migração 26 aplicada — índice parcial galeed_facts_vigentes existe", async () => {
    await getEngine(BRAIN); // garante ensureSchema
    const sql = await rawConnect();
    try {
      const rows = (await sql.unsafe(
        `select indexname from pg_indexes where tablename='galeed_facts' and indexname='galeed_facts_vigentes'`,
      )) as any[];
      expect(rows).toHaveLength(1);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it("fix do engine (§2.3) — getPage/pagesBySlug expõem os 4 campos como allPages", async () => {
    await wipeBrain(ENGINE_BRAIN);
    const e = await getEngine(ENGINE_BRAIN);
    const p: PageRow = {
      slug: "eng", type: "reunioes", title: "eng", date: "2026-01-01", path: "", body: "corpo",
      content_hash: "hash-eng", external_id: "ext-eng", extract_version: "v9",
    };
    await e.upsertPage(p);
    await e.setSalience("eng", 0.42);

    const all = (await e.allPages()).find((x) => x.slug === "eng")!;
    const got = await e.getPage("eng");
    const map = await e.pagesBySlug(["eng"]);
    const bySlug = map.get("eng")!;

    expect(got).toBeDefined();
    for (const field of ["content_hash", "external_id", "extract_version", "salience"] as const) {
      expect(got![field]).toEqual(all[field]);
      expect(bySlug[field]).toEqual(all[field]);
    }
    expect(got!.content_hash).toBe("hash-eng");
    expect(got!.external_id).toBe("ext-eng");
    expect(got!.extract_version).toBe("v9");
    expect(got!.salience).toBe(0.42);
  });
});
