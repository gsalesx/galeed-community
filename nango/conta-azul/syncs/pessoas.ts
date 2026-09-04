import { createSync } from "nango";
import { z } from "zod";
import { Pessoa } from "../models.ts";
import { buildQuery, extractItems, maxAlteracao, throttleDelayMs, ENDPOINT } from "../helpers.ts";

/** Polling incremental de PESSOAS por data de alteração. Atenção: o wrapper da resposta é {items}
 *  (não {itens}) — a extractItems trata os dois (§2.1).
 *  Doc do padrão: https://nango.dev/docs/implementation-guides/use-cases/syncs/implement-a-sync */
export default createSync({
  description: "Pessoas (clientes/fornecedores) da Conta Azul — incremental por data_alteracao",
  version: "1.0.0",
  frequency: "every hour",
  autoStart: true,
  models: { Pessoa },
  checkpoint: z.object({ lastAlteracao: z.string().optional() }),
  exec: async (nango) => {
    const checkpoint = await nango.getCheckpoint();
    let pagina = 1;
    let last = checkpoint?.lastAlteracao;
    for (;;) {
      const res = await nango.get({
        endpoint: ENDPOINT.pessoas,
        params: buildQuery("pessoas", checkpoint, pagina, new Date()),
        retries: 5,
      });
      const { rows, hasMore } = extractItems("pessoas", res.data);
      if (rows.length) await nango.batchSave(rows.map((r) => Pessoa.parse(r)), "Pessoa");
      last = maxAlteracao(rows as any[], last);
      if (!hasMore) break;
      pagina++;
      await new Promise((r) => setTimeout(r, throttleDelayMs(0)));
    }
    if (last) await nango.saveCheckpoint({ lastAlteracao: last });
  },
});
