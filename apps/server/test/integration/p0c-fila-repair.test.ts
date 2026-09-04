/** P0-C — SMOKE da VARREDURA DE REPARO (auditoria C3b + M3a). DB real; LLM MOCKADO (vi.mock de
 *  extract.ts via importOriginal mantendo tudo e trocando SÓ extractUnit; vi.hoisted — LEARNINGS
 *  M18/S2). Brain `repair-p0c-fila` (sufixo único). Prova: (1) página extract_version='' + job done →
 *  runRepairSweep extrai/deriva (fato com source_slug); (2) página só-ruído → marca extraída, não chama
 *  o mock; (3) extração sem derive → fatos; re-rodar idempotente (L5); (4) guard de brain ativo;
 *  (5) M3a: flag embeddings 'failed' → 'ok' quando buildEmbeddings resolve, permanece quando rejeita. */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { hasDb, rawConnect } from "./helpers/db.ts";

// vi.hoisted — as fns mock existem quando a factory do vi.mock roda (içada pro topo). LEARNINGS M18/S2.
const { mockExtractUnit, mockBuildEmbeddings, embeddingsShouldFail } = vi.hoisted(() => ({
  mockExtractUnit: vi.fn(),
  mockBuildEmbeddings: vi.fn(),
  embeddingsShouldFail: { value: false },
}));

vi.mock("../../src/core/extraction/extract.ts", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../../src/core/extraction/extract.ts")>();
  return { ...orig, extractUnit: mockExtractUnit };
});

vi.mock("../../src/core/retrieval/embeddings.ts", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../../src/core/retrieval/embeddings.ts")>();
  return {
    ...orig,
    buildEmbeddings: (...args: any[]) => {
      mockBuildEmbeddings(...args);
      return embeddingsShouldFail.value
        ? Promise.reject(new Error("sem chave de embeddings (mock)"))
        : Promise.resolve(undefined);
    },
  };
});

import { runRepairSweep } from "../../src/core/ingestion/repair.ts";
import {
  enqueueIngestJob,
  markJobDone,
  mergeJobResult,
  listRepairableBrains,
  closeIngestQueue,
} from "../../src/core/ingestion/ingest-queue.ts";
import { getEngine, closeEngines } from "../../src/core/platform/engine.ts";
import type { PageRow } from "../../src/core/platform/engine.ts";

const BRAIN = "repair-p0c-fila";

async function wipeAll(): Promise<void> {
  const sql = await rawConnect();
  try {
    for (const t of ["galeed_pages", "galeed_extractions", "galeed_facts", "galeed_edges", "galeed_ingest_jobs", "galeed_vectors"]) {
      await sql.unsafe(`delete from ${t} where brain = $1`, [BRAIN]).catch(() => {});
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function countFacts(slug?: string): Promise<number> {
  const sql = await rawConnect();
  try {
    const rows = slug
      ? await sql.unsafe(`select count(*)::int as n from galeed_facts where brain=$1 and source_slug=$2`, [BRAIN, slug])
      : await sql.unsafe(`select count(*)::int as n from galeed_facts where brain=$1`, [BRAIN]);
    return Number((rows as any[])[0].n);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

// getPage REAL não seleciona extract_version (só allPages o expõe) — leio direto da coluna via SQL.
async function pageExtractVersion(slug: string): Promise<string> {
  const sql = await rawConnect();
  try {
    const rows = (await sql.unsafe(`select coalesce(extract_version,'') as v from galeed_pages where brain=$1 and slug=$2`, [BRAIN, slug])) as any[];
    return rows.length ? String(rows[0].v) : "";
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** PageRow mínimo capturado-mas-nunca-extraído (extract_version=''). NUNCA usa putPage — LEARNINGS M17/S4. */
function pageRow(slug: string, body: string): PageRow {
  return {
    slug,
    type: "conversa",
    title: "fixture repair",
    date: "2026-01-10",
    path: "",
    body,
    content_hash: `h-${slug}`,
    external_id: `ext-${slug}`,
    tags: ["fonte:paste"], // sem src: → sem contrato (pass-through), kind text
    extract_version: "", // capturado, nunca extraído
  };
}

describe.skipIf(!hasDb())("P0-C — varredura de reparo (C3b + M3a)", () => {
  beforeEach(async () => {
    await wipeAll();
    vi.clearAllMocks();
    embeddingsShouldFail.value = false;
    // default: 1 claim ancorado VERBATIM do body (senão o indexer rebaixa pra nao-verificado).
    mockExtractUnit.mockImplementation(async (_home: string, page: PageRow) => {
      const quote = page.body.includes("R$ 30 mil") ? "R$ 30 mil" : page.body.slice(0, 40);
      return {
        facts: [
          {
            text: "preço do produto",
            entity: "acme",
            predicate: "preco",
            value: "30 mil",
            value_num: 30000,
            context_quote: quote,
          },
        ],
      };
    });
  });
  afterAll(async () => {
    await wipeAll();
    await closeIngestQueue();
    await closeEngines();
  });

  it("(1) página extract_version='' + job done → varredura extrai, persiste, deriva (≥1 fato com source_slug)", async () => {
    const e = await getEngine(BRAIN);
    await e.upsertPage(pageRow("pg-1", "O contrato da Acme fechou em R$ 30 mil por mês."));
    const { jobId } = await enqueueIngestJob({ brain: BRAIN, kind: "text", type: "conversa", textBody: "x" });
    await markJobDone(jobId, { total: 1, slugs: ["pg-1"], skipped: 0, message: "ok" });

    const rep = await runRepairSweep();

    expect(rep.pagesDigested).toBeGreaterThanOrEqual(1);
    expect(await pageExtractVersion("pg-1")).not.toBe("");
    expect(mockExtractUnit).toHaveBeenCalled();
    expect(await countFacts("pg-1")).toBeGreaterThanOrEqual(1);
  });

  it("(2) página só-ruído (0 worthy) → marca extract_version e NÃO chama extractUnit", async () => {
    const e = await getEngine(BRAIN);
    // corpo sem número/entidade/asserção — o porteiro pula (0 worthy).
    await e.upsertPage(pageRow("pg-noise", "kkkk\nbom dia\n👍\nblz"));
    const { jobId } = await enqueueIngestJob({ brain: BRAIN, kind: "text", type: "conversa", textBody: "y" });
    await markJobDone(jobId, { total: 1, slugs: ["pg-noise"], skipped: 0, message: "ok" });

    await runRepairSweep();

    expect(await pageExtractVersion("pg-noise")).not.toBe(""); // marcada (não re-visita)
    expect(mockExtractUnit).not.toHaveBeenCalled();
  });

  it("(3) extração persistida sem derive → varredura deriva; re-rodar é idempotente (L5)", async () => {
    const e = await getEngine(BRAIN);
    // página JÁ extraída (extract_version != '') — não cai no passo 1 (markExtracted persiste a coluna;
    // upsertPage ignora extract_version — getPage/postgres não a grava por esse caminho).
    await e.upsertPage(pageRow("pg-underived", "A Acme fechou em R$ 30 mil."));
    await e.markExtracted("pg-underived", "v-old");
    // extração persistida com dims não-vazias, mas 0 fatos derivados (crash entre putExtraction e derive).
    await e.putExtraction({
      source_slug: "pg-underived",
      type: "conversa",
      date: "2026-01-10",
      content_hash: "h-pg-underived",
      prompt_version: "v-old",
      extractions: { facts: [{ text: "preço", entity: "acme", predicate: "preco", value: "30 mil", value_num: 30000, context_quote: "R$ 30 mil" }] },
    });
    // job terminal no brain → listRepairableBrains o inclui (brain SEM job ativo, mas COM ≥1 job).
    const { jobId } = await enqueueIngestJob({ brain: BRAIN, kind: "text", type: "conversa", textBody: "u" });
    await markJobDone(jobId, { total: 1, slugs: ["pg-underived"], skipped: 0, message: "ok" });
    expect(await countFacts("pg-underived")).toBe(0);

    await runRepairSweep();
    const after1 = await countFacts("pg-underived");
    expect(after1).toBeGreaterThanOrEqual(1);

    await runRepairSweep(); // re-roda
    const after2 = await countFacts("pg-underived");
    expect(after2).toBe(after1); // idempotente — não duplica
  });

  it("(4) guard de brain ativo: job queued no brain → listRepairableBrains NÃO o inclui; varredura não toca", async () => {
    const e = await getEngine(BRAIN);
    await e.upsertPage(pageRow("pg-guarded", "A Acme fechou em R$ 30 mil."));
    await enqueueIngestJob({ brain: BRAIN, kind: "text", type: "conversa", textBody: "z" }); // queued (ativo)

    const brains = await listRepairableBrains();
    expect(brains).not.toContain(BRAIN);

    await runRepairSweep();
    expect(await pageExtractVersion("pg-guarded")).toBe(""); // intocada
    expect(mockExtractUnit).not.toHaveBeenCalled();
  });

  it("(5) M3a: job done com embeddings='failed' → flag flipa pra 'ok' (buildEmbeddings resolve); permanece quando rejeita", async () => {
    // sem páginas pendentes — só o passo 3 (embeddings) importa.
    const { jobId } = await enqueueIngestJob({ brain: BRAIN, kind: "text", type: "conversa", textBody: "emb" });
    await markJobDone(jobId, { total: 1, slugs: ["s"], skipped: 0, message: "ok", embeddings: "failed" });

    const rep = await runRepairSweep();
    expect(rep.jobsEmbeddingsOk).toBeGreaterThanOrEqual(1);
    const sql = await rawConnect();
    try {
      const r = (await sql.unsafe(`select result_json->>'embeddings' as e from galeed_ingest_jobs where id=$1`, [jobId])) as any[];
      expect(r[0].e).toBe("ok");
    } finally {
      await sql.end({ timeout: 5 });
    }

    // agora um job failed com buildEmbeddings rejeitando → flag permanece 'failed'.
    const { jobId: jobId2 } = await enqueueIngestJob({ brain: BRAIN, kind: "text", type: "conversa", textBody: "emb2" });
    await markJobDone(jobId2, { total: 1, slugs: ["s"], skipped: 0, message: "ok", embeddings: "failed" });
    embeddingsShouldFail.value = true;
    await runRepairSweep();
    const sql2 = await rawConnect();
    try {
      const r = (await sql2.unsafe(`select result_json->>'embeddings' as e from galeed_ingest_jobs where id=$1`, [jobId2])) as any[];
      expect(r[0].e).toBe("failed");
    } finally {
      await sql2.end({ timeout: 5 });
    }
  });
});
