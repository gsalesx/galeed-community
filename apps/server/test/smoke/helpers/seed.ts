/** M10/S1 — fixture descartável DETERMINÍSTICO do smoke de API (sem LLM, sem PII).
 *  Semeia o brain `__smoke_m10` (+ o brain alheio `__smoke_m10_other`) via engine/accounts/principals
 *  DIRETO (não por extração): páginas (pública / area:vendas / restrito·area:financeiro), série de preço
 *  TIPADA (Accelera: enterprise 3k arquivado → 30k vigente + starter 500), 1 fato restrito, 1 principal
 *  restrito + token cru, 1 receipt. Exporta as constantes que S2/S3/S4 reusam nos asserts.
 *
 *  Reusa loadEnv/hasDb/rawConnect/wipeBrain de ../../integration/helpers/db.ts (IMPORT — não edita). */
import { getEngine, type FactRow, type PageRow } from "../../../src/core/platform/engine.ts";
import { createPrincipal, setGrant, issueToken } from "../../../src/core/access/principals.ts";
import { createAccount, accountByEmail, addBrainMembership } from "../../../src/core/access/accounts.ts";
import { writeReceipt } from "../../../src/core/extraction/extract-receipt.ts";
import { rawConnect, wipeBrain } from "../../integration/helpers/db.ts";

// --- Constantes do fixture (S2/S3 IMPORTAM destas — nomes EXATOS, não traduzir) ---
export const SMOKE_BRAIN = "__smoke_m10";
export const OWNER_EMAIL = "smoke-owner@galeed.test";
export const OWNER_PASSWORD = "SmokeM10!owner";
export const MEMBER_EMAIL = "smoke-member@galeed.test"; // membership 'member' (p/ teste de /api/cost só-owner)
export const MEMBER_PASSWORD = "SmokeM10!member";
export const OTHER_BRAIN = "__smoke_m10_other"; // brain ALHEIO ao owner (p/ teste de 403 cross-tenant)

/** principal restrito do fixture (p/ preview/escrita/token). */
export const RESTRICTED_PRINCIPAL_ID = "agent-vendas";
/** token CRU emitido pro principal restrito — só o smoke conhece; usado nos asserts de auth/revoke. */
export let SMOKE_TOKEN_RAW = ""; // populado por seedFixture(); export let pra ser lido após o seed

/** valores EXATOS que o smoke assere (contrato com S2/S4). */
export const EXPECTED = {
  entity: "accelera",
  predicate: "preco",
  enterpriseCurrentNum: 30000, // value_num do tier enterprise VIGENTE
  enterpriseArchivedNum: 3000, // value_num do tier enterprise ARQUIVADO (degrau anterior)
  starterNum: 500,
  unit: "BRL",
  period: "monthly",
} as const;

/** Semeia o brain-fixture. Idempotente: wipe antes; contas com upsert de membership. */
export async function seedFixture(): Promise<void> {
  await wipeFixture();

  // (a) conta owner + membership owner do brain de teste (createAccount com brainName cria a membership)
  const owner = await accountByEmail(OWNER_EMAIL);
  if (!owner) {
    await createAccount({ name: "Smoke Owner", email: OWNER_EMAIL, password: OWNER_PASSWORD, brainName: SMOKE_BRAIN });
  }
  // garante membership owner do SMOKE_BRAIN (createAccount usa o brainName como id do brain)
  const o = await accountByEmail(OWNER_EMAIL);
  if (o) await addBrainMembership(o.id, SMOKE_BRAIN, "owner");

  // (b) conta member: membership 'member' no MESMO brain (p/ /api/cost só-owner → 403)
  const member = await accountByEmail(MEMBER_EMAIL);
  if (!member) {
    await createAccount({ name: "Smoke Member", email: MEMBER_EMAIL, password: MEMBER_PASSWORD });
  }
  const m = await accountByEmail(MEMBER_EMAIL);
  if (m) await addBrainMembership(m.id, SMOKE_BRAIN, "member");

  const e = await getEngine(SMOKE_BRAIN);

  // (c) páginas: pública / area:vendas / restrito·area:financeiro (o fato sensível mora aqui).
  //     O `body` é texto REAL (sem LLM) e contém os termos que o FTS do retrieve casa — assim o
  //     /api/ask recupera a página por full-text (o fixture não tem vetores: determinismo D2).
  const page = (slug: string, tags: string[], sensitivity: string, body: string): PageRow =>
    ({
      slug,
      type: "reunioes",
      title: slug,
      date: "2024-06-01",
      path: "",
      body,
      content_hash: slug,
      tags,
      sensitivity,
    } as PageRow);
  await e.upsertPage(page("call-publica", [], "publico", "Apresentacao publica do produto Accelera 360 para o mercado."));
  await e.upsertPage(
    page(
      "call-vendas",
      ["area:vendas"],
      "interno",
      "Reuniao de vendas sobre o preco da Accelera 360. Quanto custa: plano enterprise passou de R$ 3 mil para R$ 30 mil por mes; plano starter custa R$ 500 por mes.",
    ),
  );
  await e.upsertPage(
    page("call-financeiro", ["area:financeiro"], "restrito", "Folha confidencial: salario do CEO."),
  ); // página restrita

  // (d) SÉRIE DE PREÇO TIPADA (caso Accelera) — inserida DIRETO (sem extração/LLM). 3 fatos:
  //     enterprise arquivado (3k, valid_to=2024-06-01) → enterprise vigente (30k) ; starter isolado (500).
  const fact = (opt: {
    slug: string;
    tier: string;
    vn: number;
    v: string;
    from: string;
    to: string;
    status: string;
  }): FactRow =>
    ({
      source_slug: opt.slug,
      type: "reunioes",
      dimension: "decisions",
      idx: 0,
      text: "",
      quote: `${opt.v}/mês`,
      meta: {},
      entity: EXPECTED.entity,
      predicate: EXPECTED.predicate,
      value: opt.v,
      value_num: opt.vn,
      unit: EXPECTED.unit,
      period: EXPECTED.period,
      tier: opt.tier,
      valid_from: opt.from,
      valid_to: opt.to,
      confidence: 0.9,
      status: opt.status,
    } as FactRow);
  await e.putFacts([
    fact({ slug: "call-vendas", tier: "enterprise", vn: 3000, v: "R$ 3 mil", from: "2024-01-01", to: "2024-06-01", status: "arquivado" }),
    fact({ slug: "call-vendas", tier: "enterprise", vn: 30000, v: "R$ 30 mil", from: "2024-06-01", to: "", status: "fato" }),
    fact({ slug: "call-vendas", tier: "starter", vn: 500, v: "R$ 500", from: "2024-01-01", to: "", status: "fato" }),
  ]);

  // (e) FATO RESTRITO numa página restrita (dimension igual; é o que o preview NÃO pode vazar)
  await e.putFacts([
    {
      source_slug: "call-financeiro",
      type: "reunioes",
      dimension: "decisions",
      idx: 0,
      text: "",
      quote: "folha confidencial",
      meta: {},
      entity: "folha",
      predicate: "salario_ceo",
      value: "R$ 80 mil",
      value_num: 80000,
      unit: EXPECTED.unit,
      period: EXPECTED.period,
      tier: "",
      valid_from: "2024-06-01",
      valid_to: "",
      confidence: 0.9,
      status: "fato",
    } as FactRow,
  ]);

  // (f) principal restrito + grant (só vendas, teto interno) + token CRU guardado
  await createPrincipal(SMOKE_BRAIN, { id: RESTRICTED_PRINCIPAL_ID, kind: "agent", label: "Agente Vendas" });
  await setGrant(SMOKE_BRAIN, { principalId: RESTRICTED_PRINCIPAL_ID, areas: ["vendas"], sensitivityMax: "interno", denyTypes: [] });
  const issued = await issueToken(SMOKE_BRAIN, { principalId: RESTRICTED_PRINCIPAL_ID, label: "smoke" });
  SMOKE_TOKEN_RAW = issued.token;

  // (g) 1 receipt de extração (p/ /api/cost ter rollup > 0)
  await writeReceipt(SMOKE_BRAIN, {
    run_id: "smoke-run-1",
    fixture_corpus: "",
    model: "claude-haiku-4-5",
    prompt_version: "v3",
    schema_version: "v1",
    corpus_sha8: "smoke000",
    tokens_in: 1000,
    tokens_out: 200,
    cost_usd: 0.0016,
    recall: null,
    per_dim: {},
  });

  // (h) brain ALHEIO (sem membership do owner) — p/ assert de 403 cross-tenant
  const eo = await getEngine(OTHER_BRAIN);
  await eo.upsertPage(page("call-alheia", [], "publico", "Conteudo de outro tenant — alheio ao owner do fixture."));
}

/** Apaga TODO o fixture (brains + contas/sessões/memberships). Chamado no afterAll e no início do seed. */
export async function wipeFixture(): Promise<void> {
  await wipeBrain(SMOKE_BRAIN);
  await wipeBrain(OTHER_BRAIN);

  // contas: apaga as do fixture p/ idempotência entre runs. Tolera ausência das tabelas/linhas.
  const sql = await rawConnect();
  try {
    const emails = [OWNER_EMAIL, MEMBER_EMAIL];
    // sessões e memberships penduram no account_id → apaga primeiro, depois a conta.
    await sql
      .unsafe(
        `delete from galeed_sessions where account_id in (select id from galeed_accounts where email = any($1))`,
        [emails],
      )
      .catch(() => {});
    await sql
      .unsafe(
        `delete from galeed_account_brains where account_id in (select id from galeed_accounts where email = any($1))`,
        [emails],
      )
      .catch(() => {});
    await sql.unsafe(`delete from galeed_accounts where email = any($1)`, [emails]).catch(() => {});
  } finally {
    await sql.end({ timeout: 5 });
  }
}
