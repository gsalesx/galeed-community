import { createSync } from "nango";
import { z } from "zod";
import { Venda } from "../models.ts";
import { buildQuery, extractItems, maxAlteracao, throttleDelayMs, ENDPOINT } from "../helpers.ts";

/** Polling incremental de VENDAS por data de alteração (filtro liberado no changelog 2025 — §2.1).
 *  Doc do padrão: https://nango.dev/docs/implementation-guides/use-cases/syncs/implement-a-sync */
export default createSync({
  description: "Vendas da Conta Azul — incremental por data_alteracao",
  version: "1.0.0",
  frequency: "every hour",
  autoStart: true,
  models: { Venda },
  checkpoint: z.object({ lastAlteracao: z.string().optional() }),
  exec: async (nango) => {
    const checkpoint = await nango.getCheckpoint();
    let pagina = 1;
    let last = checkpoint?.lastAlteracao;
    for (;;) {
      const res = await nango.get({
        endpoint: ENDPOINT.vendas,
        params: buildQuery("vendas", checkpoint, pagina, new Date()),
        retries: 5, // 429/5xx — o Nango aplica backoff; throttleDelayMs cobre o espaçamento
      });
      const { rows, hasMore } = extractItems("vendas", res.data);
      if (rows.length) await nango.batchSave(rows.map((r) => Venda.parse(r)), "Venda");
      last = maxAlteracao(rows as any[], last);
      if (!hasMore) break;
      pagina++;
      await new Promise((r) => setTimeout(r, throttleDelayMs(0))); // ≥125ms entre páginas (rate §2.1)
    }
    if (last) await nango.saveCheckpoint({ lastAlteracao: last });
  },
});
