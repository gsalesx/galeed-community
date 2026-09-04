/** INGESTORES planilha + formulario — normalizadores PUROS (sem DB/IO).
 *  A invariante SAGRADA da planilha: todo claim.context_quote e todo claim.value são substrings
 *  LITERAIS do content (âncora por construção — o gate rejeita o que não confere). */
import { describe, it, expect } from "vitest";
import { planilhaIngestor, parseCsv } from "../../src/core/ingestion/ingestors/planilha.ts";
import { formularioIngestor } from "../../src/core/ingestion/ingestors/formulario.ts";
import type { IngestorCtx } from "../../src/core/ingestion/ingestors/types.ts";

const CTX: IngestorCtx = { brain: "teste", sourceId: "src-1", slug: "x" };

describe("ingestor planilha — claims determinísticos", () => {
  const tabela = {
    titulo: "Tabela de preços — agosto",
    data: "2026-08-01",
    linhas: [
      { entidade: "Limpeza de pele", atributo: "preço", valor: 180, unidade: "BRL" },
      { entidade: "Drenagem linfática", atributo: "preço", valor: "1.250,50", unidade: "BRL", tier: "pacote-10" },
      { entidade: "Skinceuticals", atributo: "prazo de entrega", valor: "7 dias úteis" },
    ],
  };

  it("cada linha vira um claim ANCORADO: quote e value são substrings literais do content", () => {
    const [item] = planilhaIngestor.normalize(tabela, CTX);
    expect(item.claims).toHaveLength(3);
    for (const c of item.claims!) {
      expect(item.content).toContain(c.context_quote); // âncora por construção
      expect(item.content).toContain(c.value!); // grafia exata no body
      expect(c.dimension).toBe("planilha"); // = dimensão da receita do sourceSeed
    }
  });

  it("normaliza: entity/predicate em slug, número BR vira value_num, BRL formatado, tier preservado", () => {
    const [item] = planilhaIngestor.normalize(tabela, CTX);
    const [limpeza, drenagem, prazo] = item.claims!;
    expect(limpeza.entity).toBe("limpeza-de-pele");
    expect(limpeza.predicate).toBe("preco");
    expect(limpeza.value).toBe("R$ 180,00");
    expect(limpeza.value_num).toBe(180);
    expect(limpeza.valid_from).toBe("2026-08-01");
    expect(drenagem.value_num).toBe(1250.5);
    expect(drenagem.tier).toBe("pacote-10");
    expect(prazo.value).toBe("7 dias úteis");
    expect(prazo.value_num).toBeUndefined(); // valor textual não inventa número
  });

  it("aceita CSV com ; (Excel BR), aspas e cabeçalho com acento; mesma tabela re-enviada tem o MESMO ref", () => {
    const csv = 'Entidade;Atributo;Valor;Unidade\n"Limpeza, de pele";preço;180;BRL\nDrenagem;preço;140;BRL';
    const [a] = planilhaIngestor.normalize({ titulo: "T", data: "2026-08-01", csv }, CTX);
    expect(a.claims).toHaveLength(2);
    expect(a.claims![0].entity).toBe("limpeza-de-pele");
    const [b] = planilhaIngestor.normalize({ titulo: "T", data: "2026-08-01", csv }, CTX);
    expect(a.externalRef).toBe(b.externalRef); // dedupe de re-entrega
  });

  it("linha sem entidade/atributo/valor é descartada; payload sem linha válida → []", () => {
    const [item] = planilhaIngestor.normalize(
      { titulo: "T", linhas: [{ entidade: "X", atributo: "preço", valor: 10 }, { entidade: "", atributo: "a", valor: 1 }] },
      CTX,
    );
    expect(item.claims).toHaveLength(1);
    expect(planilhaIngestor.normalize({ titulo: "T", linhas: [] }, CTX)).toEqual([]);
    expect(planilhaIngestor.normalize({}, CTX)).toEqual([]);
  });

  it("parseCsv: vírgula OU ponto-e-vírgula, aspas duplas escapadas", () => {
    const rows = parseCsv('a,b\n"x, y",2\n"com ""aspas""",3');
    expect(rows).toEqual([{ a: "x, y", b: "2" }, { a: 'com "aspas"', b: "3" }]);
  });
});

describe("ingestor formulario", () => {
  it("campos viram markdown legível; ref explícito ou hash estável", () => {
    const [a] = formularioIngestor.normalize(
      { formulario: "Orçamento pelo site", campos: { Nome: "João Pereira", Telefone: "(47) 99999-8888", Mensagem: "Quero orçamento de drenagem" }, ref: "sub-1" },
      CTX,
    );
    expect(a.content).toContain("# Orçamento pelo site");
    expect(a.content).toContain("**Nome**: João Pereira");
    expect(a.content).toContain("Quero orçamento de drenagem");
    expect(a.externalRef).toBe("sub-1");
  });

  it("shape plano do Zapier (campos na raiz) também funciona; reservadas ficam de fora", () => {
    const [a] = formularioIngestor.normalize(
      { form: "Lead", Nome: "Ana", Interesse: "pacote 10 sessões", occurred_at: "2026-07-02T10:00:00Z" },
      CTX,
    );
    expect(a.content).toContain("**Nome**: Ana");
    expect(a.content).toContain("pacote 10 sessões");
    expect(a.content).not.toContain("occurred_at");
    expect(a.timestamp).toBe("2026-07-02T10:00:00.000Z");
  });

  it("array vira lista separada por vírgula; submissão vazia → []", () => {
    const [a] = formularioIngestor.normalize({ campos: { Serviços: ["limpeza", "drenagem"] } }, CTX);
    expect(a.content).toContain("**Serviços**: limpeza, drenagem");
    expect(formularioIngestor.normalize({}, CTX)).toEqual([]);
    expect(formularioIngestor.normalize({ campos: {} }, CTX)).toEqual([]);
  });
});
