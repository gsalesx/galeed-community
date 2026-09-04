/** M22-B — helpers PUROS das sync functions Conta Azul (zero import de 'nango' — é o que o vitest
 *  da raiz testa). Query incremental por data_alteracao, paginação, throttle e a janela de
 *  vencimento OBRIGATÓRIA dos endpoints /buscar.
 *  Contratos oficiais (citados nos docblocks; §2.1 da DESIGN-SPEC):
 *   - filtros data_alteracao_de/_ate (ISO 8601 SP/GMT-3): https://developers.contaazul.com/docs/sales-apis-openapi/v1/searchvendas.md
 *   - data_vencimento_de/_ate OBRIGATÓRIOS: https://developers.contaazul.com/docs/financial-apis-openapi/v1/searchinstallmentstopaybyfilter.md
 *   - rate limit 600/min e 10/s POR CONTA: https://developers.contaazul.com/faq
 *   - wrapper {itens} (pessoas usa {items}): https://github.com/ContaAzul/n8n-nodes-contaazul */

export type ContaAzulModel = "vendas" | "contas_a_pagar" | "contas_a_receber" | "pessoas";

/** Tamanho de página padrão (enum oficial: 10,20,50,100,200,500,1000 — searchvendas.md). */
export const TAMANHO_PAGINA = 100;

/** Endpoint REST oficial por modelo (§2.1). */
export const ENDPOINT: Record<ContaAzulModel, string> = {
  vendas: "/v1/venda/busca",
  contas_a_pagar: "/v1/financeiro/eventos-financeiros/contas-a-pagar/buscar",
  contas_a_receber: "/v1/financeiro/eventos-financeiros/contas-a-receber/buscar",
  pessoas: "/v1/pessoas",
};

/** "2026-06-12T00:00:00" — ISO 8601 SP/GMT-3 SEM offset (como a API da Conta Azul espera; R5). */
function isoSemOffset(d: Date): string {
  return d.toISOString().slice(0, 19);
}
function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Janela de vencimento OBRIGATÓRIA dos endpoints /buscar (§2.1: data_vencimento_de/_ate são
 *  required mesmo filtrando por alteração). Cravado: hoje-730d .. hoje+1825d (2 anos atrás a 5 anos
 *  à frente — cobre parcelas longas; largura confirmada no HTC — R4). */
export function janelaVencimento(hoje: Date): { data_vencimento_de: string; data_vencimento_ate: string } {
  const de = new Date(hoje.getTime() - 730 * 24 * 3600 * 1000);
  const ate = new Date(hoje.getTime() + 1825 * 24 * 3600 * 1000);
  return { data_vencimento_de: ymd(de), data_vencimento_ate: ymd(ate) };
}

/** Query incremental: sem checkpoint → SEM data_alteracao_de (1ª sync = full); com checkpoint →
 *  data_alteracao_de = checkpoint.lastAlteracao. Sempre pagina/tamanho_pagina. As contas a
 *  pagar/receber SEMPRE carregam a janela de vencimento (obrigatória, §2.1). */
export function buildQuery(
  model: ContaAzulModel,
  checkpoint: { lastAlteracao?: string } | null,
  pagina: number,
  hoje: Date,
): Record<string, string | number> {
  const q: Record<string, string | number> = {
    pagina,
    tamanho_pagina: TAMANHO_PAGINA,
  };
  const last = checkpoint?.lastAlteracao;
  if (last) {
    q.data_alteracao_de = last;
    q.data_alteracao_ate = isoSemOffset(hoje);
  }
  if (model === "contas_a_pagar" || model === "contas_a_receber") {
    const j = janelaVencimento(hoje);
    q.data_vencimento_de = j.data_vencimento_de;
    q.data_vencimento_ate = j.data_vencimento_ate;
  }
  return q;
}

/** Itera as páginas da resposta oficial: vendas/parcelas vêm em {itens:[...]}, pessoas em
 *  {items:[...]} (atenção ao 'i' — §2.1). hasMore = a página veio cheia (length === tamanho). */
export function extractItems(model: string, body: unknown): { rows: unknown[]; hasMore: boolean } {
  const b = (body ?? {}) as any;
  const rows: unknown[] = Array.isArray(b.itens)
    ? b.itens
    : Array.isArray(b.items)
      ? b.items
      : [];
  return { rows, hasMore: rows.length === TAMANHO_PAGINA };
}

/** Maior data_alteracao vista no lote (próximo checkpoint). Preserva `atual` se o lote não trouxer
 *  nada maior (comparação de strings ISO da PRÓPRIA API entre si — monotônico; R5). */
export function maxAlteracao(rows: { data_alteracao?: string }[], atual?: string): string | undefined {
  let max = atual;
  for (const r of rows) {
    const a = r?.data_alteracao;
    if (!a) continue;
    if (max === undefined || a > max) max = a;
  }
  return max;
}

/** Plano de throttle: 600/min e 10/s POR CONTA (§2.1) → mínimo de 125ms entre requests (≈8 req/s,
 *  margem) e backoff exponencial em 429 (base 1s, fator 2, máx 5 tentativas; satura). Puro: devolve
 *  o delay; quem dorme é o sync. */
export function throttleDelayMs(tentativa429: number): number {
  const ESPACAMENTO_MIN = 125;
  if (tentativa429 <= 0) return ESPACAMENTO_MIN;
  const MAX_TENTATIVAS = 5;
  const t = Math.min(tentativa429, MAX_TENTATIVAS);
  return 1000 * Math.pow(2, t - 1); // 1s, 2s, 4s, 8s, 16s (satura na 5ª)
}
