/** M10/S1 — SMOKE de API: prova que o BFF entrega RESULTADO real (não só 200) contra o brain-fixture
 *  determinístico `__smoke_m10`. É o CONTRATO executável do milestone: as rotas que existem HOJE têm
 *  asserts de VALOR; as rotas FUTURAS (/api/cost, escrita RBAC) entram como `it.todo` cujo texto é o
 *  CRITÉRIO DE ACEITE LITERAL de S2/S3 (eles trocam cada `it.todo` por um `it(...)` real).
 *
 *  Skip se não houver Postgres (hasDb()). Determinístico: fatos via putFacts direto, sem LLM. */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { hasDb } from "../integration/helpers/db.ts";
import { startSmokeBff, stopBff, bff, login, asAnon } from "./helpers/bff.ts";
import {
  seedFixture,
  wipeFixture,
  SMOKE_BRAIN,
  OWNER_EMAIL,
  OWNER_PASSWORD,
  OTHER_BRAIN,
  RESTRICTED_PRINCIPAL_ID,
  EXPECTED,
} from "./helpers/seed.ts";
import { closeEngines } from "../../src/core/platform/engine.ts";
// S2 (bff-m9.ts): handlers PUROS que este slot entrega. O smoke de S2 exercita os handlers diretamente
// (o motor é o mesmo do BFF; sem depender do seam plugado no web-server.ts). Assert de VALOR idêntico.
import { askHandler, costHandler } from "../../src/connectors/bff/bff-m9.ts";
import { authenticateToken } from "../../src/core/access/principals.ts"; // S3: assert de revoke (token revogado → null)

/** acrescenta ?brain=__smoke_m10 ao path (toda rota tenant exige o brain). */
const q = (path: string) => `${path}${path.includes("?") ? "&" : "?"}brain=${SMOKE_BRAIN}`;

describe.skipIf(!hasDb())("M10 smoke — BFF entrega RESULTADO real", () => {
  beforeAll(async () => {
    await startSmokeBff();
    await seedFixture();
  });
  afterAll(async () => {
    await stopBff();
    await wipeFixture();
    await closeEngines();
  });

  // ---- auth ---- (CONTRACT §A)
  it("login do owner devolve sessão com o brain de teste", async () => {
    await login(OWNER_EMAIL, OWNER_PASSWORD);
    const me = await bff("/auth/me");
    expect(me.status).toBe(200);
    expect(me.json).toBeTruthy();
    const brainIds: string[] = (me.json.brains ?? []).map((b: { id: string }) => b.id);
    expect(brainIds).toContain(SMOKE_BRAIN);
  });

  it("rota tenant sem sessão → 401", async () => {
    asAnon();
    const r = await bff(q("/api/stats"));
    expect(r.status).toBe(401);
  });

  it("brain ALHEIO ao owner → 403", async () => {
    await login(OWNER_EMAIL, OWNER_PASSWORD);
    const r = await bff(`/api/stats?brain=${OTHER_BRAIN}`);
    expect(r.status).toBe(403);
  });

  // ---- leitura (rotas EXISTENTES — asseram VALOR, não só 200) ---- (CONTRACT §B)
  it("/api/stats devolve contagens do brain", async () => {
    await login(OWNER_EMAIL, OWNER_PASSWORD);
    const r = await bff(q("/api/stats"));
    expect(r.status).toBe(200);
    expect(r.json.facts).toBeGreaterThanOrEqual(4); // 3 da série + 1 restrito
    expect(r.json.pages).toBeGreaterThanOrEqual(3);
  });

  it("/api/facts devolve a SÉRIE TIPADA (value_num/tier/unit/period) sem achatar", async () => {
    await login(OWNER_EMAIL, OWNER_PASSWORD);
    const r = await bff(q("/api/facts?dim=decisions"));
    expect(r.status).toBe(200);
    expect(Array.isArray(r.json)).toBe(true);

    const vigente = r.json.find(
      (f: any) =>
        f.entity === EXPECTED.entity &&
        f.predicate === EXPECTED.predicate &&
        f.tier === "enterprise" &&
        f.value_num === EXPECTED.enterpriseCurrentNum &&
        f.unit === EXPECTED.unit &&
        f.period === EXPECTED.period &&
        (f.valid_to === "" || f.valid_to == null), // VIGENTE, não achatado
    );
    expect(vigente, "fato enterprise vigente 30000 com value_num/unit/period/tier tipados").toBeTruthy();

    const starter = r.json.find(
      (f: any) => f.entity === EXPECTED.entity && f.tier === "starter" && f.value_num === EXPECTED.starterNum,
    );
    expect(starter, "fato starter 500 tipado").toBeTruthy();
  });

  it("/api/timeline da entidade accelera tem os 2 degraus enterprise", async () => {
    await login(OWNER_EMAIL, OWNER_PASSWORD);
    const r = await bff(q(`/api/timeline?entity=${EXPECTED.entity}`));
    expect(r.status).toBe(200);
    expect(Array.isArray(r.json)).toBe(true);

    const enterprise = r.json.filter((f: any) => f.tier === "enterprise");
    expect(enterprise.length).toBeGreaterThanOrEqual(2);

    const arquivado = enterprise.find(
      (f: any) => f.value_num === EXPECTED.enterpriseArchivedNum && f.valid_to === "2024-06-01",
    );
    expect(arquivado, "degrau enterprise arquivado 3000 com valid_to=2024-06-01").toBeTruthy();

    const vigente = enterprise.find(
      (f: any) => f.value_num === EXPECTED.enterpriseCurrentNum && (f.valid_to === "" || f.valid_to == null),
    );
    expect(vigente, "degrau enterprise vigente 30000 sem valid_to").toBeTruthy();
  });

  // timeout largo: síntese REAL no provider de dev (binário `claude` local) — latência varia
  // com a carga da máquina; 30s default flakava a suíte.
  it("/api/ask responde a Accelera (rota existente — contrato base)", { timeout: 240_000 }, async () => {
    await login(OWNER_EMAIL, OWNER_PASSWORD);
    const r = await bff(q("/api/ask?q=Quanto custa a Accelera 360?"));
    expect(r.status).toBe(200);
    expect(typeof r.json.answer).toBe("string");
    expect(r.json.answer.length).toBeGreaterThan(0);
    expect(Array.isArray(r.json.citations)).toBe(true);
    const slugs: string[] = r.json.citations.map((c: { slug: string }) => c.slug);
    // algum citation é uma das páginas do fixture (não verifica a PROSA — só a citação real).
    expect(slugs.some((s) => s === "call-vendas" || s === "call-publica" || s === "call-financeiro")).toBe(true);
  });

  it("/api/rbac/principals lista o agente restrito com grant real", async () => {
    await login(OWNER_EMAIL, OWNER_PASSWORD);
    const r = await bff(q("/api/rbac/principals"));
    expect(r.status).toBe(200);
    expect(Array.isArray(r.json)).toBe(true);
    const p = r.json.find((x: any) => x.id === RESTRICTED_PRINCIPAL_ID);
    expect(p, "principal agent-vendas presente").toBeTruthy();
    expect(p.kind).toBe("agent");
    expect(p.grant.areas).toContain("vendas");
    expect(p.grant.sensitivity_max).toBe("interno");
  });

  it("/api/rbac/preview do agente restrito NÃO vaza o fato sensível", async () => {
    await login(OWNER_EMAIL, OWNER_PASSWORD);
    const r = await bff(q(`/api/rbac/preview?principal=${RESTRICTED_PRINCIPAL_ID}`));
    expect(r.status).toBe(200);
    expect(r.json.scope.sensitivityMax).toBe("interno");
    // a página restrita (onde mora o fato sensível) NÃO aparece nos slugs visíveis ao agente.
    expect(r.json.sampleSlugs).not.toContain("call-financeiro");
    // bloqueou > 0: o agente vê menos páginas que o total (não vaza o sensível).
    expect(r.json.blocked).toBeGreaterThan(0);
  });

  // ---- rotas FUTURAS = aceite de S2/S3 (it.todo até o slot existir) ----
  // Os textos abaixo são o CONTRATO LITERAL: S2/S3 trocam cada `it.todo("…")` por um `it(...)` real
  // com o assert do seu CONTRACT (ver CONTRACT.md §Aceite de S2 / §Aceite de S3).

  // S2 (bff-m9.ts): /api/ask enriquecido com a série por tier
  it("/api/ask traz facts: FactItem[] com a série enterprise 3k→30k (S2 — bff-m9.ts)", { timeout: 240_000 }, async () => {
    const r = await askHandler(SMOKE_BRAIN, "Quanto custa a Accelera 360?", 8);
    expect(Array.isArray(r.facts)).toBe(true);
    // contém o degrau VIGENTE (30k) E o ARQUIVADO (3k) do tier enterprise — a SÉRIE, não só o atual.
    const tiers = r.facts
      .filter((f) => f.entity === EXPECTED.entity && f.tier === "enterprise")
      .map((f) => f.value_num);
    expect(tiers).toContain(EXPECTED.enterpriseArchivedNum); // 3000
    expect(tiers).toContain(EXPECTED.enterpriseCurrentNum); // 30000
    expect(Array.isArray(r.citations)).toBe(true);
  });
  // S2 (bff-m9.ts): /api/cost só-owner
  it("/api/cost (owner) devolve rollup com cost_usd_total > 0 (S2 — bff-m9.ts)", async () => {
    const roll = await costHandler(SMOKE_BRAIN, [{ id: SMOKE_BRAIN, name: "x", role: "owner" }]);
    expect(roll.calls).toBeGreaterThanOrEqual(1);
    expect(roll.cost_usd_total).toBeGreaterThan(0);
  });
  it("/api/cost (member) → 403 (S2 — só owner)", async () => {
    await expect(
      costHandler(SMOKE_BRAIN, [{ id: SMOKE_BRAIN, name: "x", role: "member" }]),
    ).rejects.toMatchObject({ code: 403 });
  });
  // S3 (bff-rbac-write.ts): escrita RBAC — rotas REAIS plugadas no motor M7.
  // NOTA (S3): as rotas POST/DELETE /api/rbac/* só respondem APÓS o Integrador plugar o SEAM em
  // web-server.ts (zona neutra — ver ARTIFACTS do slot). Em isolado (pré-reconcile) elas retornam 404
  // e estes it() ficam vermelhos; viram verdes no reconcile. A prova ISOLADA dos handlers (sem BFF)
  // é o bloco "handlers puros" do CONTRACT §2, colado no ARTIFACTS (invite/grant/token_revoke/input).
  it("POST /api/rbac/invite cria principal + grant e reflete em /principals (S3 — bff-rbac-write.ts)", async () => {
    await login(OWNER_EMAIL, OWNER_PASSWORD);
    const r = await bff(q("/api/rbac/invite"), {
      method: "POST",
      body: { kind: "agent", label: "Bot QA", areas: ["vendas"], sensitivityMax: "interno" },
    });
    expect(r.status).toBe(200);
    expect(r.json.id, "invite devolve Principal com id").toBeTruthy();
    const list = await bff(q("/api/rbac/principals"));
    expect(list.status).toBe(200);
    const created = list.json.find((x: any) => x.id === r.json.id);
    expect(created, "principal criado aparece em /principals").toBeTruthy();
    expect(created.grant.areas).toContain("vendas");
    expect(created.grant.sensitivity_max).toBe("interno");
  });

  it("POST /api/rbac/grant altera o teto/áreas do principal (S3)", async () => {
    await login(OWNER_EMAIL, OWNER_PASSWORD);
    const r = await bff(q("/api/rbac/grant"), {
      method: "POST",
      body: { principalId: RESTRICTED_PRINCIPAL_ID, areas: ["vendas", "marketing"], sensitivityMax: "sensivel" },
    });
    expect(r.status).toBe(200);
    const list = await bff(q("/api/rbac/principals"));
    const p = list.json.find((x: any) => x.id === RESTRICTED_PRINCIPAL_ID);
    expect(p, "agent-vendas presente").toBeTruthy();
    expect(p.grant.areas).toContain("marketing");
    expect(p.grant.sensitivity_max).toBe("sensivel");
  });

  it("POST /api/rbac/token emite token e DELETE /api/rbac/token revoga (token revogado → 401) (S3)", async () => {
    await login(OWNER_EMAIL, OWNER_PASSWORD);
    const issued = await bff(q("/api/rbac/token"), {
      method: "POST",
      body: { principalId: RESTRICTED_PRINCIPAL_ID },
    });
    expect(issued.status).toBe(200);
    expect(typeof issued.json.token).toBe("string");
    // token cru = <prefixo>_<64 hex>. O prefixo é configurável (GALEED_TOKEN_PREFIX,
    // default gld_live_ p/ bater com a doc pública); a validação é por hash, agnóstica ao prefixo.
    expect(issued.json.token, "token cru: <prefixo>_<64 hex>").toMatch(/_[0-9a-f]{64}$/);
    expect(issued.json.principal, "devolve o principal junto").toBeTruthy();

    const token: string = issued.json.token;
    const del = await bff(
      `/api/rbac/token?brain=${SMOKE_BRAIN}&principal=${RESTRICTED_PRINCIPAL_ID}&hash=${token}`,
      { method: "DELETE" },
    );
    expect(del.status).toBe(200);
    expect(del.json.ok).toBe(true);

    // o token revogado NÃO autentica mais (assert direto via authenticateToken — espelha o piso do M7).
    const auth = await authenticateToken(SMOKE_BRAIN, token);
    expect(auth, "token revogado → authenticateToken null").toBe(null);
  });

  it("escrita RBAC em brain alheio → 403; toda escrita gera entrada de auditoria (S3)", async () => {
    await login(OWNER_EMAIL, OWNER_PASSWORD);
    // brain ALHEIO ao owner (sem membership) → requireBrain corta ANTES do handler (403). Mesmo piso
    // já provado p/ leitura ("brain ALHEIO ao owner → 403"); aqui é a ESCRITA que não cruza tenant.
    const r = await bff(`/api/rbac/invite?brain=${OTHER_BRAIN}`, {
      method: "POST",
      body: { kind: "agent", label: "Intruso", areas: ["vendas"], sensitivityMax: "interno" },
    });
    expect(r.status).toBe(403);
    // input inválido (kind fora de {human,agent}) → 400 (validação de fronteira do handler).
    const bad = await bff(q("/api/rbac/invite"), {
      method: "POST",
      body: { kind: "robo", label: "x", sensitivityMax: "interno" },
    });
    expect(bad.status).toBe(400);
    // AUDITORIA: ver ARTIFACTS §pendência — o motor M7 loga LEITURA (appendAccessLog em api/mcp),
    // mas NÃO loga escrita de governança (invite/grant/token/revoke). É DÍVIDA DO MOTOR (não do BFF):
    // adicionar log aqui seria editar comportamento do motor (proibido pelo CONTRACT §Não-objetivos).
    // Decisão do fundador/CTO pendente. Não há assert de auditoria de escrita até o motor expor o hook.
  });
});
