/** UNIT M22-B — helpers PUROS das sync functions Nango (sem import de 'nango'; sem rede). Prova:
 *  query incremental por data_alteracao, janela de vencimento obrigatória, paginação por wrapper
 *  oficial (itens/items), checkpoint monotônico e throttle/backoff. Contratos oficiais nos docblocks
 *  de nango/conta-azul/helpers.ts (§2.1 da DESIGN-SPEC). */
import { describe, it, expect } from "vitest";
import {
  buildQuery,
  extractItems,
  maxAlteracao,
  throttleDelayMs,
  janelaVencimento,
  TAMANHO_PAGINA,
} from "../../../../nango/conta-azul/helpers.ts";

const HOJE = new Date("2026-06-12T00:00:00Z");

describe("M22-B — nango helpers (puros)", () => {
  it("1) buildQuery: sem checkpoint não manda data_alteracao_de; com checkpoint manda; contas a pagar/receber sempre com vencimento", () => {
    const full = buildQuery("vendas", null, 1, HOJE);
    expect(full.data_alteracao_de).toBeUndefined();
    expect(full.pagina).toBe(1);
    expect(full.tamanho_pagina).toBe(TAMANHO_PAGINA);

    const inc = buildQuery("vendas", { lastAlteracao: "2026-03-15T11:00:00" }, 2, HOJE);
    expect(inc.data_alteracao_de).toBe("2026-03-15T11:00:00");
    expect(inc.pagina).toBe(2);

    // vendas NÃO tem janela de vencimento; parcelas SEMPRE têm (obrigatórias §2.1)
    expect(full.data_vencimento_de).toBeUndefined();
    for (const m of ["contas_a_pagar", "contas_a_receber"] as const) {
      const q = buildQuery(m, null, 1, HOJE);
      expect(q.data_vencimento_de, m).toBeDefined();
      expect(q.data_vencimento_ate, m).toBeDefined();
    }
  });

  it("janelaVencimento: hoje-730d .. hoje+1825d", () => {
    const j = janelaVencimento(HOJE);
    expect(j.data_vencimento_de).toBe("2024-06-12"); // hoje-730d (2024 bissexto)
    expect(j.data_vencimento_ate).toBe("2031-06-11"); // hoje+1825d
  });

  it("2) extractItems: wrapper itens (vendas/parcelas) e items (pessoas); hasMore sse length===tamanho", () => {
    expect(extractItems("vendas", { itens: [{ id: "a" }, { id: "b" }] }).rows).toHaveLength(2);
    expect(extractItems("pessoas", { items: [{ id: "p" }] }).rows).toHaveLength(1);
    expect(extractItems("vendas", {}).rows).toHaveLength(0);

    const cheia = { itens: Array.from({ length: TAMANHO_PAGINA }, (_, i) => ({ id: String(i) })) };
    expect(extractItems("vendas", cheia).hasMore).toBe(true);
    const parcial = { itens: [{ id: "x" }] };
    expect(extractItems("vendas", parcial).hasMore).toBe(false);
  });

  it("3) maxAlteracao: maior ISO do lote; preserva o atual quando o lote é menor", () => {
    const rows = [
      { data_alteracao: "2026-03-10T09:12:00.000" },
      { data_alteracao: "2026-03-15T11:00:00.000" },
      { data_alteracao: "2026-02-01T00:00:00.000" },
    ];
    expect(maxAlteracao(rows)).toBe("2026-03-15T11:00:00.000");
    // lote mais antigo que o atual → preserva o atual
    expect(maxAlteracao([{ data_alteracao: "2025-01-01T00:00:00" }], "2026-03-15T11:00:00")).toBe(
      "2026-03-15T11:00:00",
    );
    // sem nenhuma data → mantém atual (undefined se não havia)
    expect(maxAlteracao([{}], undefined)).toBeUndefined();
  });

  it("4) throttleDelayMs: ≥125ms sem 429; backoff exponencial que satura na 5ª tentativa", () => {
    expect(throttleDelayMs(0)).toBeGreaterThanOrEqual(125);
    expect(throttleDelayMs(1)).toBe(1000);
    expect(throttleDelayMs(2)).toBe(2000);
    expect(throttleDelayMs(3)).toBe(4000);
    expect(throttleDelayMs(4)).toBe(8000);
    expect(throttleDelayMs(5)).toBe(16000);
    expect(throttleDelayMs(99)).toBe(16000); // satura
  });
});
