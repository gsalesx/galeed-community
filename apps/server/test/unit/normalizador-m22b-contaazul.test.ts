/** UNIT M22-B — normalizador Conta Azul (PURO; sem DB/LLM/rede). Prova: record → página PT +
 *  claims determinísticos; o gate REAL (applyRecipeGate) aprova os claims canônicos POR CONSTRUÇÃO
 *  (quote verbatim + valor ancorado), rejeita dimensão fora da receita; datas = data do EVENTO
 *  (nunca hoje); id_legado nunca vira external_ref; pessoa → claim 'perfil' value_num null; adapter
 *  do seam (contaAzulConnector) mapeia model→dimensão e injeta sourceId. Fixtures dos shapes
 *  OFICIAIS (§2.1, URLs no _doc dos JSON). */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  normalizeContaAzulBatch,
  formatBRL,
  CONTA_AZUL_RECIPE,
  contaAzulConnector,
  type ContaAzulModel,
  type ErpClaim,
} from "../../src/core/ingestion/connectors/conta-azul.ts";
import { applyRecipeGate } from "../../src/core/ingestion/golden-rule.ts";

function fixture(name: string): any {
  const p = fileURLToPath(new URL(`./fixtures/conta-azul/${name}`, import.meta.url));
  return JSON.parse(readFileSync(p, "utf-8"));
}
const VENDAS = fixture("vendas.json").itens as any[];
const PAGAR = fixture("contas-a-pagar.json").itens as any[];
const RECEBER = fixture("contas-a-receber.json").itens as any[];
const PESSOAS = fixture("pessoas.json").items as any[];

describe("M22-B — normalizador (record → página PT + claims)", () => {
  it("1) venda: date/valid_from = data do EVENTO (nunca hoje); externalRef pelo uuid; body com formatBRL", () => {
    const { pages } = normalizeContaAzulBatch({ model: "vendas", records: [VENDAS[0]] });
    expect(pages).toHaveLength(1);
    const p = pages[0];
    expect(p.date).toBe("2026-03-10"); // literal: data do record, NUNCA new Date()
    expect(p.claims[0].valid_from).toBe("2026-03-10");
    expect(p.externalRef).toBe("ca:vendas:123e4567-e89b-12d3-a456-426614174000");
    expect(p.body).toContain(formatBRL(1250));
    expect(p.body).toContain("R$ 1.250,00");
    // nunca a data de hoje
    const hoje = new Date().toISOString().slice(0, 10);
    if (hoje !== "2026-03-10") expect(p.date).not.toBe(hoje);
  });

  it("2) gate por construção: claims canônicos dos 4 modelos passam (rejected=[])", () => {
    const casos: { model: ContaAzulModel; rec: any }[] = [
      { model: "vendas", rec: VENDAS[0] },
      { model: "vendas", rec: VENDAS[1] },
      { model: "contas_a_pagar", rec: PAGAR[0] }, // com fornecedor nomeado
      { model: "contas_a_receber", rec: RECEBER[0] },
      { model: "pessoas", rec: PESSOAS[0] },
      { model: "pessoas", rec: PESSOAS[1] },
    ];
    for (const { model, rec } of casos) {
      const { pages } = normalizeContaAzulBatch({ model, records: [rec] });
      const p = pages[0];
      const gate = applyRecipeGate({ [p.dimension]: p.claims }, CONTA_AZUL_RECIPE, "conta-azul", "pg-teste", p.body);
      expect(gate.rejected, `${model}: ${JSON.stringify(gate.rejected)}`).toHaveLength(0);
      expect(gate.counts.approved).toBe(p.claims.length);
    }
  });

  it("3) dimensão FORA da receita → rejected 'fora_da_receita' (regra de ouro vale pro conector)", () => {
    const { pages } = normalizeContaAzulBatch({ model: "vendas", records: [VENDAS[0]] });
    const p = pages[0];
    const claimFora = p.claims[0];
    const gate = applyRecipeGate({ precos: [claimFora] }, CONTA_AZUL_RECIPE, "conta-azul", "pg-teste", p.body);
    expect(gate.counts.rejected).toBe(1);
    expect(gate.rejected[0].reason).toBe("fora_da_receita");
  });

  it("4) tier: vendas 1001 e 1002 do mesmo cliente → tiers diferentes; update da 1001 → MESMO tier", () => {
    const { pages: a } = normalizeContaAzulBatch({ model: "vendas", records: [VENDAS[0]] }); // 1001
    const { pages: b } = normalizeContaAzulBatch({ model: "vendas", records: [VENDAS[1]] }); // 1002
    const { pages: c } = normalizeContaAzulBatch({ model: "vendas", records: [VENDAS[2]] }); // 1001 update
    expect(a[0].claims[0].tier).toBe("venda-1001");
    expect(b[0].claims[0].tier).toBe("venda-1002");
    expect(c[0].claims[0].tier).toBe("venda-1001"); // mesma série → supersessão
    expect(a[0].claims[0].entity).toBe("acme-ltda");
    expect(b[0].claims[0].entity).toBe("acme-ltda");
  });

  it("5) record sem data → descartado com motivo PT; id_legado nunca aparece no externalRef", () => {
    const semData = { id: "sem-data-uuid", numero: 9, total: 100, id_legado: 999999, cliente: { nome: "X" } };
    const { pages, descartados } = normalizeContaAzulBatch({ model: "vendas", records: [semData] });
    expect(pages).toHaveLength(0);
    expect(descartados).toHaveLength(1);
    expect(descartados[0].motivo).toContain("sem data de evento");
    // pessoa com id_legado: external_ref usa SÓ o uuid novo
    const { pages: pp } = normalizeContaAzulBatch({ model: "pessoas", records: [PESSOAS[0]] });
    expect(pp[0].externalRef).toBe("ca:pessoas:550e8400-e29b-41d4-a716-446655440000");
    expect(pp[0].externalRef).not.toContain("700001"); // id_legado
    expect(pp[0].externalRef).not.toContain("legacy"); // uuid_legado
  });

  it("6) pessoa → claim 'perfil' com value_num null e quote verbatim", () => {
    const { pages } = normalizeContaAzulBatch({ model: "pessoas", records: [PESSOAS[1]] });
    const c = pages[0].claims[0];
    expect(c.predicate).toBe("perfil");
    expect(c.value_num).toBeNull();
    expect(c.value).toBe("cliente, fornecedor");
    expect(pages[0].body).toContain(c.context_quote);
    expect(c.entity).toBe("distribuidora-norte-ltda");
  });

  it("7) adapter do seam (contaAzulConnector): providerConfigKey, sourceSeed, normalize→payload", () => {
    expect(contaAzulConnector.providerConfigKey).toBe("conta-azul");
    const seed = contaAzulConnector.sourceSeed();
    expect(seed.id).toBe("conta-azul");
    expect(seed.channel).toBe("conta-azul");
    expect(seed.type).toBe("erp");
    expect(seed.default_sensitivity).toBe("restrito");

    const payloads = contaAzulConnector.normalize(VENDAS[0], { sourceId: "conta-azul", model: "Venda" }) as any[];
    expect(payloads).toHaveLength(1);
    const pl = payloads[0];
    expect(pl.sourceId).toBe("conta-azul");
    expect(pl.contentType).toBe("text/plain");
    expect(pl.externalRef).toBe("ca:vendas:123e4567-e89b-12d3-a456-426614174000");
    expect(pl.content).toContain(pl.externalRef); // proveniência legível no content
    expect(pl.timestamp).toBe("2026-03-10");
    const claim = pl.claims[0] as ErpClaim & { dimension: string };
    expect(claim.dimension).toBe("vendas");
    expect(claim.tier).toBe("venda-1001");
    expect(claim.valid_from).toBe("2026-03-10");

    // model desconhecido → []
    expect(contaAzulConnector.normalize(VENDAS[0], { sourceId: "conta-azul", model: "ModeloDesconhecido" })).toEqual([]);
  });
});
