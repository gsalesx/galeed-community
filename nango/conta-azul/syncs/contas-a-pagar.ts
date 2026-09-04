import { createSync } from "nango";
import { z } from "zod";
import { ContaAPagar } from "../models.ts";
import { buildQuery, extractItems, maxAlteracao, throttleDelayMs, ENDPOINT } from "../helpers.ts";

/** Polling incremental de CONTAS A PAGAR por data de alteração. A buildQuery injeta a janela de
 *  vencimento OBRIGATÓRIA (§2.1 — data_vencimento_de/_ate required).
 *  Doc do padrão: https://nango.dev/docs/implementation-guides/use-cases/syncs/implement-a-sync */
export default createSync({
  description: "Contas a pagar da Conta Azul — incremental por data_alteracao",
  version: "1.0.0",
  frequency: "every hour",
  autoStart: true,
  models: { ContaAPagar },
  checkpoint: z.object({ lastAlteracao: z.string().optional() }),
  exec: async (nango) => {
    const checkpoint = await nango.getCheckpoint();
    let pagina = 1;
    let last = checkpoint?.lastAlteracao;
    for (;;) {
      const res = await nango.get({
        endpoint: ENDPOINT.contas_a_pagar,
        params: buildQuery("contas_a_pagar", checkpoint, pagina, new Date()),
        retries: 5,
      });
      const { rows, hasMore } = extractItems("contas_a_pagar", res.data);
      if (rows.length) await nango.batchSave(rows.map((r) => ContaAPagar.parse(r)), "ContaAPagar");
      last = maxAlteracao(rows as any[], last);
      if (!hasMore) break;
      pagina++;
      await new Promise((r) => setTimeout(r, throttleDelayMs(0)));
    }
    if (last) await nango.saveCheckpoint({ lastAlteracao: last });
  },
});
