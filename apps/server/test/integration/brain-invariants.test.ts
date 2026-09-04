/** INTEGRAÇÃO: invariantes do Cérebro.
 *  Esta suíte é o gate arquitetural mínimo antes de refatorar o Engine: protege as garantias que fazem
 *  o Galeed ser uma memória B2B confiável, não só um RAG.
 *
 *  Invariantes cobertos:
 *   - todo acesso a dado tenant-scoped respeita `brain`;
 *   - ingestão/capture com external_id é idempotente;
 *   - RBAC falha fechado sem grant ou principal ativo;
 *   - verdade bitemporal arquiva versão antiga, não sobrescreve em silêncio;
 *   - resposta sem fonte/quote ancorado é rejeitada pelo verificador determinístico.
 */
import { describe, it, expect, afterAll } from "vitest";
import { hasDb, rawConnect, wipeBrain } from "./helpers/db.ts";
import { getEngine, closeEngines, type PageRow, type ExtractionRow } from "../../src/core/platform/engine.ts";
import { capture } from "../../src/core/ingestion/capture.ts";
import { createPrincipal, setGrant, accessTest } from "../../src/core/access/principals.ts";
import { buildIndex } from "../../src/core/retrieval/indexer.ts";
import { verifyAnswer, type Claim, type VerifySource } from "../../src/core/retrieval/answer-verify.ts";

const A = "__test_brain_inv_a";
const B = "__test_brain_inv_b";

const page = (slug: string, body: string, extra: Partial<PageRow> = {}): PageRow => ({
  slug,
  type: "notas",
  title: slug,
  date: "2026-01-01",
  path: "",
  body,
  content_hash: slug,
  tags: [],
  ...extra,
});

const extraction = (slug: string, date: string, value: string, quote: string): ExtractionRow => ({
  source_slug: slug,
  type: "reunioes",
  date,
  content_hash: slug,
  prompt_version: "brain-invariants",
  extractions: {
    facts: [
      {
        entity: "acme",
        predicate: "preco_mensal",
        value,
        valid_from: date,
        context_quote: quote,
        text: `preço ${value}`,
      },
    ],
  },
});

let dbOk: Promise<boolean> | null = null;

async function dbAvailable(): Promise<boolean> {
  if (!hasDb()) return false;
  dbOk ??= (async () => {
    let sql: any;
    try {
      sql = await rawConnect();
      await Promise.race([
        sql`select 1`,
        new Promise((_, reject) => setTimeout(() => reject(new Error("db ping timeout")), 7000)),
      ]);
      return true;
    } catch {
      return false;
    } finally {
      if (sql) await sql.end({ timeout: 5 }).catch(() => {});
    }
  })();
  return dbOk;
}

async function resetBrains(): Promise<void> {
  await wipeBrain(A);
  await wipeBrain(B);
  await closeEngines();
}

async function runWithDb(fn: () => Promise<void>): Promise<void> {
  if (!hasDb()) return;
  const ok = await dbAvailable();
  expect(
    ok,
    "DATABASE_URL/GALEED_DB_URL/SUPABASE_DB_URL está definido, mas o Postgres de integração não respondeu.",
  ).toBe(true);
  if (!ok) return;
  await resetBrains();
  try {
    await fn();
  } finally {
    await resetBrains();
  }
}

describe("invariantes do Cérebro", () => {
  afterAll(async () => {
    if (await dbAvailable()) {
      await wipeBrain(A);
      await wipeBrain(B);
    }
    await closeEngines();
  });

  it("multi-tenant: um brain não lê página do outro, mesmo sabendo o slug", async () => {
    await runWithDb(async () => {
    const ea = await getEngine(A);
    const eb = await getEngine(B);
    await ea.upsertPage(page("segredo-compartilhavel", "segredo do tenant A"));
    await eb.upsertPage(page("segredo-de-b", "segredo do tenant B"));

    expect((await ea.allPages()).map((p) => p.slug)).toEqual(["segredo-compartilhavel"]);
    expect(await ea.getPage("segredo-de-b")).toBeUndefined();
    });
  });

  it("ingestão: repost com mesmo external_id não duplica página", async () => {
    await runWithDb(async () => {
    const first = await capture({
      home: A,
      text: "Reunião: decidimos manter o plano atual.",
      type: "notas",
      title: "Webhook idempotente",
      date: "2026-02-01",
      source: "webhook",
      externalId: "evt-123",
      area: "produto",
      sensitivity: "interno",
    });
    const second = await capture({
      home: A,
      text: "Reunião: decidimos manter o plano atual.",
      type: "notas",
      title: "Webhook idempotente",
      date: "2026-02-01",
      source: "webhook",
      externalId: "evt-123",
      area: "produto",
      sensitivity: "interno",
    });

    const pages = await (await getEngine(A)).allPages();
    expect(first.skipped).toBe(false);
    expect(second).toMatchObject({ skipped: true, slug: first.slug });
    expect(pages.map((p) => p.slug)).toEqual([first.slug]);
    });
  });

  it("RBAC: sem grant ou principal ativo falha fechado", async () => {
    await runWithDb(async () => {
    const e = await getEngine(A);
    await e.upsertPage(
      page("roadmap-produto", "conteúdo interno", {
        tags: ["area:produto"],
        sensitivity: "interno",
      }),
    );
    await createPrincipal(A, { id: "agente-sem-grant", kind: "agent", label: "Agente sem grant" });
    await createPrincipal(A, { id: "agente-desativado", kind: "agent", label: "Agente desativado" });
    await setGrant(A, { principalId: "agente-desativado", areas: ["produto"], sensitivityMax: "interno" });
    await e.setPrincipalStatus("agente-desativado", "disabled");

    const semGrant = await accessTest(A, "agente-sem-grant");
    const desativado = await accessTest(A, "agente-desativado");

    expect(semGrant.visiblePages).toBe(0);
    expect(semGrant.scope.areas).toEqual([]);
    expect(desativado.visiblePages).toBe(0);
    expect(desativado.scope.areas).toEqual([]);
    });
  });

  it("RBAC: grant explícito só libera área e sensibilidade permitidas", async () => {
    await runWithDb(async () => {
    const e = await getEngine(A);
    await e.upsertPage(page("produto-interno", "ok", { tags: ["area:produto"], sensitivity: "interno" }));
    await e.upsertPage(page("financeiro-interno", "bloqueado", { tags: ["area:financeiro"], sensitivity: "interno" }));
    await e.upsertPage(page("produto-restrito", "bloqueado", { tags: ["area:produto"], sensitivity: "restrito" }));
    await e.setSensitivity("produto-interno", "interno");
    await e.setSensitivity("financeiro-interno", "interno");
    await e.setSensitivity("produto-restrito", "restrito");
    await createPrincipal(A, { id: "agente-produto", kind: "agent", label: "Agente Produto" });
    await setGrant(A, { principalId: "agente-produto", areas: ["produto"], sensitivityMax: "interno" });

    const r = await accessTest(A, "agente-produto");

    expect(r.visiblePages).toBe(1);
    expect(r.sampleSlugs).toEqual(["produto-interno"]);
    });
  });

  it("bitemporalidade: fato novo arquiva o antigo sem sobrescrever a linha do tempo", async () => {
    await runWithDb(async () => {
    const e = await getEngine(A);
    await e.upsertPage(page("jan", "Acme fechou o plano em R$ 499 por mês em janeiro.", { type: "reunioes", date: "2026-01-10" }));
    await e.upsertPage(page("mar", "Acme renegociou o plano para R$ 599 por mês em março.", { type: "reunioes", date: "2026-03-10" }));
    await e.putExtraction(extraction("jan", "2026-01-10", "499", "plano em R$ 499 por mês"));
    await e.putExtraction(extraction("mar", "2026-03-10", "599", "plano para R$ 599 por mês"));
    await buildIndex(A);

    const timeline = await e.timeline("acme", { predicate: "preco_mensal" });
    const antigo = timeline.find((f) => f.value === "499");
    const vigente = timeline.find((f) => f.value === "599");

    expect(timeline.map((f) => f.value)).toEqual(["499", "599"]);
    expect(antigo).toMatchObject({ status: "arquivado", valid_to: "2026-03-10" });
    expect(vigente).toMatchObject({ status: "fato", valid_to: "" });
    });
  });

  it("saída: claim sem fonte/quote ancorado é rejeitado antes de chegar ao usuário", () => {
    const sources: VerifySource[] = [
      { slug: "bio", body: "Bruno Canguçu é médico Cirurgião Vascular e Endovascular." },
    ];
    const claims: Claim[] = [
      { text: "Bruno Canguçu é médico.", cite_slug: "bio", quote: "Bruno Canguçu é médico" },
      { text: "Bruno Canguçu é cirurgião cardiovascular.", cite_slug: "bio", quote: "Cirurgião Cardiovascular" },
      { text: "Bruno atende em São Paulo.", cite_slug: "fonte-inexistente", quote: "atende em São Paulo" },
    ];

    const r = verifyAnswer(claims, sources);

    expect(r.verified.map((c) => c.text)).toEqual(["Bruno Canguçu é médico."]);
    expect(r.dropped.map((d) => d.reason)).toEqual(["quote-not-grounded", "no-cite"]);
  });
});
