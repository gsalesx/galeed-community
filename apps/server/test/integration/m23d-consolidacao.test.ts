/** M23-D — INTEGRAÇÃO (DESIGN-SPEC §6.3). Postgres real :5434, ZERO LLM. Semeia pelo engine REAL
 *  (upsertPage + putExtraction, NUNCA putPage — LEARNINGS M17/S4) 4 fontes com VARIANTES REAIS do
 *  corpus (S0 §5.1: "accelera"/"accelera 360"/"acelera" — fixture é excerto real, invariante #9),
 *  predicado `preco`, value_num distintos com quote VERBATIM no body e valid_from crescentes.
 *  Estado FRAGMENTADO (3 grupos) → runConsolidationStep funde o que é sinal FORTE SEM comando manual.
 *  Fix sobre-fusão #R3: "acelera" (grafia ≈ FORTE) funde; "accelera 360" (CONTENÇÃO = FRACO/ambíguo)
 *  fica CONSERVADOR (não funde sem desempate LLM) — o passo automático é zero-LLM.
 *
 *  Brain `m23d-consolidacao` (+ wipeBrain). NUNCA toca Accelera/produção. Skip sem DATABASE_URL.
 *  Os NÚMEROS de confiança foram prototipados contra o DB real antes de cravados (LEARNINGS M15). */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { hasDb, wipeBrain, rawConnect } from "./helpers/db.ts";
import { getEngine, closeEngines, type PageRow, type ExtractionRow } from "../../src/core/platform/engine.ts";
import { deriveIncremental } from "../../src/core/retrieval/indexer.ts";
import { runConsolidationStep } from "../../src/core/ingestion/consolidate-step.ts";
import { enqueueIngestJob, markJobDone, mergeJobResult, getJob } from "../../src/core/ingestion/ingest-queue.ts";

const BRAIN = "m23d-consolidacao";
const SLUGS = ["s1", "s2", "s3", "s4"];
// VARIANTES REAIS (S0 §5.1): "accelera" (2 fontes — canônico por frequência), "accelera 360", "acelera".
const ENT: Record<string, string> = { s1: "accelera", s2: "accelera", s3: "accelera 360", s4: "acelera" };
const VAL: Record<string, number> = { s1: 3000, s2: 5000, s3: 12000, s4: 12000 }; // s4 CORROBORA s3 (mesmo valor, fonte distinta)
const VF: Record<string, string> = { s1: "2025-01-01", s2: "2025-02-01", s3: "2025-03-01", s4: "2025-04-01" };

const page = (slug: string): PageRow => ({
  slug, type: "reunioes", title: slug, date: VF[slug], path: "",
  body: `${ENT[slug]}: preço ${VAL[slug]} por mês.`, content_hash: slug,
});
const extraction = (slug: string): ExtractionRow => ({
  source_slug: slug, type: "reunioes", date: VF[slug], content_hash: slug, prompt_version: "test",
  extractions: {
    preco: [{
      entity: ENT[slug], predicate: "preco", value: String(VAL[slug]), value_num: VAL[slug],
      unit: "BRL", period: "monthly", valid_from: VF[slug],
      context_quote: `preço ${VAL[slug]}`, text: `preço ${VAL[slug]}`,
    }],
  },
});

/** snapshot ordenado das colunas derivadas do brain — base da idempotência (§6.3.3). */
async function snapshotFacts(): Promise<any[]> {
  const sql = await rawConnect();
  try {
    return (await sql.unsafe(
      `select entity, predicate, value, value_num, valid_from, valid_to, status, confidence
         from galeed_facts where brain = $1 and predicate <> '' order by valid_from, value_num, source_slug`,
      [BRAIN],
    )) as any[];
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** semeia o estado FRAGMENTADO (3 grupos: accelera, accelera 360, acelera) via derive incremental. */
async function seedFragmented(): Promise<void> {
  await wipeBrain(BRAIN);
  const e = await getEngine(BRAIN);
  for (const s of SLUGS) await e.upsertPage(page(s));
  for (const s of SLUGS) await e.putExtraction(extraction(s));
  await deriveIncremental(BRAIN, SLUGS); // mapa vazio ⇒ entidades cruas ⇒ 3 grupos
}

describe.skipIf(!hasDb())("M23-D — consolidação automática (DB real :5434, zero LLM)", () => {
  beforeAll(async () => {
    delete process.env.GALEED_CONSOLIDATE; // garante default ligado
  });
  afterAll(async () => {
    await wipeBrain(BRAIN);
    await closeEngines();
  });
  beforeEach(async () => {
    await seedFragmented();
  });

  it("§6.3.1 — fusão automática: FORTE funde sem LLM; CONTENÇÃO (fraco) fica conservador", async () => {
    // MUDANÇA DE COMPORTAMENTO DE PROPÓSITO (fix sobre-fusão de entidades #R3): a consolidação
    // agora separa sinal FORTE (grafia/token — funde sozinho) de FRACO (contenção — ambíguo).
    //  · "acelera" ≈ "accelera" (editSim 0.875 ≥ 0.85) → sinal FORTE → funde SEM LLM. ✓
    //  · "accelera 360" ⊃ "accelera" (CONTENÇÃO de token) → sinal FRACO/ambíguo → NÃO funde sem
    //    desempate por LLM. Antes (over-merge) fundia por contenção transitiva — o bug que este fix
    //    mata. Aqui o passo é zero-LLM (sem provider de desempate), então fica CONSERVADOR: separado.
    // pré-condição: 3 grupos distintos antes da consolidação
    const e = await getEngine(BRAIN);
    const pre = await snapshotFacts();
    const preEntities = new Set(pre.map((r) => r.entity));
    expect(preEntities).toEqual(new Set(["accelera", "accelera 360", "acelera"]));

    const c = await runConsolidationStep(BRAIN);
    expect(c.status).toBe("ok");
    expect(c.merges).toBe(1); // só o grupo FORTE {accelera, acelera}
    expect(c.aliases_mudados).toBe(1); // só "acelera" (accelera 360 é contenção → não funde)
    expect(c.fontes_rederivadas).toBe(1); // só s4 (acelera → accelera)
    expect(c.grupos).toBe(1); // o grupo canônico (accelera, preco, "")

    // mapa: só o alias FORTE → canônico (mais frequente = "accelera"); a contenção NÃO entra
    const map = await e.getEntityResolve();
    expect(map["acelera"]).toBe("accelera");
    expect(map["accelera 360"]).toBeUndefined(); // conservador: na dúvida não funde

    // entidades pós: "accelera" (s1,s2,s4) e "accelera 360" (s3) permanecem SEPARADAS
    const post = await snapshotFacts();
    const postEntities = new Set(post.map((r) => r.entity));
    expect(postEntities).toEqual(new Set(["accelera", "accelera 360"]));

    // 2 vigentes: 1 por entidade (accelera=s4/12000; accelera 360=s3/12000). Nenhum alias solto.
    const vigentes = post.filter((r) => r.valid_to === "");
    expect(vigentes).toHaveLength(2);
    for (const v of vigentes) expect(v.status).toBe("fato");
    expect(new Set(vigentes.map((v) => Number(v.value_num)))).toEqual(new Set([12000]));
    // cadeia por valid_from: accelera 3000@01 arq, 5000@02 arq, accelera 360 12000@03 fato, accelera 12000@04 fato
    expect(post.map((r) => r.status)).toEqual(["arquivado", "arquivado", "fato", "fato"]);
  });

  it("§6.3.2 — canário M2 (não-inflação): confidences = min(0.98, 0.6 + 0.15·(k−1))", async () => {
    await runConsolidationStep(BRAIN);
    const post = await snapshotFacts();
    // MUDANÇA DE PROPÓSITO (fix sobre-fusão): s3 ("accelera 360") e s4 ("accelera") NÃO fundem mais
    // (contenção = sinal fraco, sem LLM não funde) → são entidades DIFERENTES → o valor 12000 deixa
    // de ser corroborado cross-fonte (cada um k=1) → 0.6 (antes, fundidos, era k=2 → 0.75). Segue
    // provando NÃO-INFLAÇÃO: confidence de fato não-corroborado fica no piso 0.6.
    const byVal = new Map(post.map((r) => [Number(r.value_num), Number(r.confidence)]));
    expect(byVal.get(3000)).toBeCloseTo(0.6, 5); // k=1
    expect(byVal.get(5000)).toBeCloseTo(0.6, 5); // k=1
    const run12k = post.filter((r) => Number(r.value_num) === 12000);
    expect(run12k).toHaveLength(2); // 1 em cada entidade (accelera, accelera 360)
    for (const r of run12k) expect(Number(r.confidence)).toBeCloseTo(0.6, 5); // k=1 cada → não infla
  });

  it("§6.3.3 — idempotência 2×: 2ª chamada = sem_mudanca + snapshot IDÊNTICO", async () => {
    await runConsolidationStep(BRAIN);
    const snap1 = await snapshotFacts();
    const c2 = await runConsolidationStep(BRAIN);
    expect(c2.status).toBe("sem_mudanca");
    const snap2 = await snapshotFacts();
    expect(snap2).toEqual(snap1); // byte-idêntico (confiança não infla no re-derive — RESET P1-A)
  });

  it("§6.3.4 — desligada: GALEED_CONSOLIDATE=0 → status desligada, nada muda no banco", async () => {
    const before = await snapshotFacts();
    process.env.GALEED_CONSOLIDATE = "0";
    try {
      const c = await runConsolidationStep(BRAIN);
      expect(c.status).toBe("desligada");
      const e = await getEngine(BRAIN);
      expect(await e.getEntityResolve()).toEqual({}); // mapa não escrito
      expect(await snapshotFacts()).toEqual(before); // facts inalterados (ainda fragmentados)
    } finally {
      delete process.env.GALEED_CONSOLIDATE; // restaura
    }
  });

  it("§6.3.5 — fila viva: mergeJobResult preserva chaves anteriores; job done, lease null", async () => {
    // enfileira um job próprio e fecha como o worker faz (sem LLM — prova só a fila/merge jsonb).
    const { jobId } = await enqueueIngestJob({ brain: BRAIN, kind: "text", type: "notas", title: "t1", textBody: "x" });
    await markJobDone(jobId, { total: 1, slugs: ["s1"], skipped: 0, message: "ok" });
    // espelha consolidateAfterJob: grava o rastro consolidacao via mergeJobResult (jsonb ||)
    const c = await runConsolidationStep(BRAIN);
    await mergeJobResult(jobId, { consolidacao: c });

    const job = await getJob(BRAIN, jobId);
    expect(job?.status).toBe("done");
    expect(job?.leaseUntil).toBeNull(); // lease liberado — reaper não o vê
    // merge jsonb: a chave anterior (total) sobrevive + a nova (consolidacao) entra
    expect((job?.resultJson as any)?.total).toBe(1);
    expect((job?.resultJson as any)?.consolidacao?.status).toBe("ok");
  });
});
