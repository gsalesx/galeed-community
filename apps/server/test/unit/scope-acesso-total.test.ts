/** ACESSO TOTAL ('*') — o fix do beco silencioso: páginas de MODO LIVRE (sem tag area:) eram
 *  invisíveis pra QUALQUER token escopado, mesmo com todas as áreas concedidas (/v1/facts=[]
 *  sem pista). O '*' explícito pula SÓ o filtro de área; sigilo e denyTypes continuam valendo,
 *  e quem não tem '*' segue fail-closed exatamente como antes. */
import { describe, it, expect } from "vitest";
import { inScope, temAcessoTotal, scopeFromGrant, AREA_TOTAL, type Scope } from "../../src/core/access/scope.ts";

const base: Scope = { principalId: "bot", areas: [AREA_TOTAL], sensitivityMax: "restrito", denyTypes: [], canIngest: true };

describe("acesso total ('*') no escopo", () => {
  it("página de MODO LIVRE (sem tag area:) passa com '*' — o caso do bot de integração", () => {
    const paginaModoLivre = { type: "conversa", tags: ["src:abc", "canal:whatsapp"], sensitivity: "restrito" };
    expect(inScope(paginaModoLivre, base)).toBe(true);
    // sem '*', a MESMA página é invisível mesmo com todas as áreas do brain concedidas (fail-closed)
    const todasAsAreas: Scope = { ...base, areas: ["clientes", "financeiro", "vendas"] };
    expect(inScope(paginaModoLivre, todasAsAreas)).toBe(false);
  });

  it("'*' NÃO pula sigilo nem denyTypes (só o filtro de área)", () => {
    const secreta = { type: "conversa", tags: [], sensitivity: "restrito" };
    expect(inScope(secreta, { ...base, sensitivityMax: "interno" })).toBe(false); // teto continua valendo
    expect(inScope({ type: "salario", tags: [], sensitivity: "publico" }, { ...base, denyTypes: ["salario"] })).toBe(false);
  });

  it("escopo comum segue fail-closed intacto (regressão)", () => {
    const scoped: Scope = { ...base, areas: ["vendas"] };
    expect(inScope({ type: "x", tags: ["area:vendas"], sensitivity: "publico" }, scoped)).toBe(true);
    expect(inScope({ type: "x", tags: ["area:financeiro"], sensitivity: "publico" }, scoped)).toBe(false);
    expect(inScope({ type: "x", tags: [], sensitivity: "publico" }, scoped)).toBe(false); // sem área → invisível
    expect(inScope({ type: "x", tags: ["area:vendas"], sensitivity: "publico" }, { ...scoped, areas: [] })).toBe(false);
  });

  it("temAcessoTotal + scopeFromGrant carregam o '*' do grant", () => {
    const scope = scopeFromGrant("bot", {
      principal_id: "bot", areas: ["*"], sensitivity_max: "restrito", deny_types: [], scope: "read", can_ingest: true,
    } as never);
    expect(temAcessoTotal(scope)).toBe(true);
    expect(temAcessoTotal({ ...scope, areas: ["vendas"] })).toBe(false);
  });
});
