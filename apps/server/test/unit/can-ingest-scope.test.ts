/** can_ingest — capacidade de ESCRITA no grant (gateway /v1/ingest gateia por scope.canIngest).
 *  INVARIANTE FAIL-CLOSED: o token nasce SÓ-LEITURA. Só um grant com can_ingest=true expõe
 *  scope.canIngest=true; qualquer outro caminho (grant ausente, flag ausente/false/null, coluna
 *  ausente no banco antigo → undefined) → canIngest=false. Sem isso, /v1/ingest abriria escrita
 *  por default e o aditivo quebraria o contrato de segurança (token só lê a menos que ganhe escrita). */
import { describe, it, expect } from "vitest";
import { scopeFromGrant, EMPTY_SCOPE } from "../../src/core/access/scope.ts";
import type { GrantRow } from "../../src/core/platform/engine.ts";

/** grant base só-leitura (espelha o default real): áreas+teto, sem can_ingest. */
function grant(over: Partial<GrantRow>): GrantRow {
  return {
    principal_id: "agent-bot",
    areas: ["produto"],
    sensitivity_max: "interno",
    deny_types: [],
    scope: "read",
    ...over,
  };
}

describe("scopeFromGrant — canIngest (capacidade de escrita, fail-closed)", () => {
  it("can_ingest=true → scope.canIngest=true", () => {
    const scope = scopeFromGrant("agent-bot", grant({ can_ingest: true }));
    expect(scope.canIngest).toBe(true);
    // o resto do escopo não muda (a capacidade é ADITIVA)
    expect(scope.areas).toEqual(["produto"]);
    expect(scope.sensitivityMax).toBe("interno");
  });

  it("can_ingest=false → scope.canIngest=false", () => {
    expect(scopeFromGrant("agent-bot", grant({ can_ingest: false })).canIngest).toBe(false);
  });

  it("can_ingest AUSENTE no grant (flag não setada) → false (fail-closed)", () => {
    // grant sem a propriedade can_ingest — o caso comum de grant só-leitura
    expect(scopeFromGrant("agent-bot", grant({})).canIngest).toBe(false);
  });

  it("can_ingest=undefined (coluna ausente no banco antigo → getGrant devolve undefined) → false", () => {
    expect(scopeFromGrant("agent-bot", grant({ can_ingest: undefined })).canIngest).toBe(false);
  });

  it("can_ingest=null (linha legada, coluna null) → false (só ===true libera)", () => {
    // simula o que vem do driver quando a coluna existe mas é null
    expect(scopeFromGrant("agent-bot", grant({ can_ingest: null as unknown as boolean })).canIngest).toBe(false);
  });

  it("grant AUSENTE (sem grant / principal disabled) → EMPTY_SCOPE, canIngest=false", () => {
    const scope = scopeFromGrant("agent-bot", undefined);
    expect(scope.canIngest).toBe(false);
    expect(scope.areas).toEqual([]);
    expect(scope.principalId).toBe("agent-bot");
  });

  it("EMPTY_SCOPE é fail-closed por construção (canIngest=false)", () => {
    expect(EMPTY_SCOPE.canIngest).toBe(false);
  });
});
