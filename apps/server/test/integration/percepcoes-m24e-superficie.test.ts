/** M24-E — integração da SUPERFÍCIE de percepções (§6.4) contra Postgres real :5434. Fixture
 *  derivada LENDO o corpus REAL (brain Accelera, SOMENTE LEITURA — invariante #9); seed só no brain
 *  de teste eval-m24e-superficie. Prova: bloco no caminho real do ask; BFF real + paginação;
 *  Accelera intocado. ZERO LLM (E é leitura pura; percepcoesForQuery e o handler não chamam IA). */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { hasDb, rawConnect } from "./helpers/db.ts";
import { getEngine, closeEngines, type PercepcaoRow } from "../../src/core/platform/engine.ts";
import { percepcoesForQuery } from "../../src/core/retrieval/ask.ts";
import { percepcoesHandler } from "../../src/connectors/bff/bff-percepcoes.ts";

const BRAIN = "eval-m24e-superficie";
const ACCELERA = "Accelera"; // grafia exata no banco real

async function wipe(brain: string) {
  const sql = await rawConnect();
  try {
    await sql`delete from galeed_percepcoes where brain = ${brain}`;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

describe.skipIf(!hasDb())("M24-E superfície de percepções — Postgres real", () => {
  let slugsReais: string[] = [];

  beforeAll(async () => {
    await wipe(BRAIN);
    // 1) LER o corpus real (read-only): a série de preço da accelera é o caso canônico.
    const real = await getEngine(ACCELERA);
    const serie = await real.timeline("accelera", { predicate: "preco", limit: 200 });
    expect(serie.length).toBeGreaterThanOrEqual(3); // a série existe no corpus real (falha honesta se não)
    slugsReais = [...new Set(serie.map((f) => f.source_slug).filter(Boolean))].slice(0, 3);
    expect(slugsReais.length).toBeGreaterThanOrEqual(1);

    // 2) seed SÓ no brain de teste: 1 viva (accelera/preco, cites = slugs reais) + 1 stale + 1 arquivada.
    const e = await getEngine(BRAIN);
    const cites = slugsReais.map((s) => ({ source_slug: s, entity: "accelera", predicate: "preco", tier: "", valid_from: "2025-01-01", quote: "" }));
    const viva: PercepcaoRow = {
      id: "m24e-viva", classe: "tendencia", entity: "accelera", predicate: "preco", tier: "",
      texto: "O preço da Accelera subiu de R$ 3 mil para R$ 30 mil — aceleração clara.",
      severidade: "alta", cites, numbers: { pctTotal: 900, magnitude: 900 }, estado: "viva", validated_at: null,
    };
    await e.upsertPercepcao(viva);
    await e.upsertPercepcao({ ...viva, id: "m24e-stale", entity: "nortex-m24e", predicate: "atividade", texto: "Silêncio de nortex.", classe: "silencio", cites: [], numbers: { ratio: 2.4, magnitude: 2.4 } });
    await e.setPercepcaoEstado("m24e-stale", "stale");
    await e.upsertPercepcao({ ...viva, id: "m24e-arq", entity: "nortex-m24e", predicate: "compromisso", texto: "Compromisso vencido.", classe: "compromisso_vencido", cites: [], numbers: { diasVencidos: 45, magnitude: 45 } });
    await e.setPercepcaoEstado("m24e-arq", "arquivada");
  });

  afterAll(async () => {
    await wipe(BRAIN);
    await closeEngines();
  });

  it("§6.4.3 bloco no caminho real: match casa accelera/preço; sem match = byte-zero", async () => {
    const bloco = await percepcoesForQuery(BRAIN, "como evoluiu o preço da accelera?");
    expect(bloco).toContain("PERCEPÇÕES DO CÉREBRO");
    expect(bloco).toContain("aceleração clara");
    for (const s of slugsReais.slice(0, 3)) expect(bloco).toContain(s);
    const vazio = await percepcoesForQuery(BRAIN, "quem é o fornecedor de embalagens?");
    expect(vazio).toBe("");
  });

  it("§6.4.4 BFF real: só a viva por default; paginação consistente; counts certos", async () => {
    const def = await percepcoesHandler(BRAIN, {});
    expect(def.items).toHaveLength(1);
    expect(def.items[0].estado).toBe("viva");
    expect(def.counts).toEqual({ viva: 1, stale: 1, arquivada: 1 });

    // paginação sobre "todas" (3 itens): página de 2 + página de 1, sem repetição (ordem estável).
    const p1 = await percepcoesHandler(BRAIN, { estado: "todas", limit: 2, offset: 0 });
    const p2 = await percepcoesHandler(BRAIN, { estado: "todas", limit: 2, offset: 2 });
    expect(p1.items).toHaveLength(2);
    expect(p2.items).toHaveLength(1);
    const ids = new Set([...p1.items, ...p2.items].map((i) => i.id));
    expect(ids.size).toBe(3); // sem repetição
  });

  it("§6.4.5 Accelera intocado (prova de leitura-somente)", async () => {
    const sql = await rawConnect();
    try {
      const before = (await sql`select count(*)::int c from galeed_percepcoes where brain = ${ACCELERA}`) as any[];
      // re-roda o caminho de leitura que tocou o brain Accelera
      const real = await getEngine(ACCELERA);
      await real.timeline("accelera", { predicate: "preco", limit: 200 });
      await percepcoesHandler(BRAIN, {});
      const after = (await sql`select count(*)::int c from galeed_percepcoes where brain = ${ACCELERA}`) as any[];
      expect(after[0].c).toBe(before[0].c); // nenhuma percepção escrita no Accelera
    } finally {
      await sql.end({ timeout: 5 });
    }
  });
});
