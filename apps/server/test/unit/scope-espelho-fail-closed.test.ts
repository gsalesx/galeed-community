/** UNIT — CONTRATO do filtro ESPELHO (inScope/filterByScope/scopeFromGrant). Em produção esta é a
 *  camada ÚNICA de enforcement de escopo (a RLS de área/sensibilidade não é armada por nenhum
 *  caminho de produção — ver cabeçalho de scope.ts): este teste CRAVA o fail-closed pra qualquer
 *  rota de leitura que passe por ele. PURO (sem DB, sem LLM). */
import { describe, it, expect } from "vitest";
import {
  EMPTY_SCOPE, scopeFromGrant, inScope, filterByScope, areasOf, temAcessoTotal, AREA_TOTAL,
} from "../../src/core/access/scope.ts";
import type { GrantRow } from "../../src/core/platform/engine.ts";

const grant = (over: Partial<GrantRow> = {}): GrantRow => ({
  principal_id: "p1", areas: ["financeiro"], sensitivity_max: "interno",
  deny_types: [], scope: "read", ...over,
});
const item = (over: Partial<{ type: string; tags: string[]; sensitivity: string }> = {}) => ({
  type: "notas", tags: ["area:financeiro"], sensitivity: "interno", ...over,
});

describe("fail-closed do escopo (a base de tudo)", () => {
  it("EMPTY_SCOPE vê NADA (com ou sem área no item) e não escreve", () => {
    expect(inScope(item(), EMPTY_SCOPE)).toBe(false);
    expect(inScope(item({ tags: [], sensitivity: "publico" }), EMPTY_SCOPE)).toBe(false);
    expect(EMPTY_SCOPE.canIngest).toBe(false);
  });

  it("sem grant / grant sem can_ingest → EMPTY_SCOPE + escrita negada", () => {
    const s = scopeFromGrant("p1", undefined);
    expect(s).toEqual({ ...EMPTY_SCOPE, principalId: "p1" });
    expect(scopeFromGrant("p1", grant()).canIngest).toBe(false); // ausente = false
  });

  it("item SEM tag area: só passa com acesso total '*' (nunca num escopo por área)", () => {
    const semArea = item({ tags: ["cliente-vip"] });
    expect(inScope(semArea, scopeFromGrant("p1", grant()))).toBe(false);
    expect(inScope(semArea, scopeFromGrant("p1", grant({ areas: [AREA_TOTAL] })))).toBe(true);
  });

  it("comparação de área é por IGUALDADE EXATA de slug — por isso capture normaliza na entrada", () => {
    const s = scopeFromGrant("p1", grant());
    expect(inScope(item({ tags: ["area:financeiro"] }), s)).toBe(true);
    expect(inScope(item({ tags: ["area:Financeiro"] }), s)).toBe(false); // não normalizada nunca casa
  });

  it("sensibilidade acima do teto barra MESMO com área certa ou acesso total", () => {
    expect(inScope(item({ sensitivity: "restrito" }), scopeFromGrant("p1", grant()))).toBe(false);
    expect(inScope(item({ sensitivity: "restrito" }), scopeFromGrant("p1", grant({ areas: [AREA_TOTAL] })))).toBe(false);
    // sensibilidade AUSENTE = restrito (rank fail-closed) → barra com teto interno
    expect(inScope(item({ sensitivity: undefined as any }), scopeFromGrant("p1", grant()))).toBe(false);
  });

  it("denyTypes nega o tipo mesmo com acesso total", () => {
    const s = scopeFromGrant("p1", grant({ areas: [AREA_TOTAL], deny_types: ["notas"] }));
    expect(inScope(item(), s)).toBe(false);
    expect(inScope(item({ type: "reunioes" }), s)).toBe(true);
  });

  it("filterByScope é o inScope aplicado à lista (nada passa por fora)", () => {
    const s = scopeFromGrant("p1", grant());
    const dentro = item();
    const fora = item({ tags: ["area:rh"] });
    expect(filterByScope([dentro, fora], s)).toEqual([dentro]);
  });

  it("helpers: areasOf extrai só area:*; temAcessoTotal exige o '*' literal", () => {
    expect(areasOf(["area:financeiro", "canal:gmail", "area:rh"])).toEqual(["financeiro", "rh"]);
    expect(areasOf(undefined)).toEqual([]);
    expect(temAcessoTotal(scopeFromGrant("p1", grant({ areas: ["financeiro"] })))).toBe(false);
    expect(temAcessoTotal(scopeFromGrant("p1", grant({ areas: [AREA_TOTAL] })))).toBe(true);
  });
});
