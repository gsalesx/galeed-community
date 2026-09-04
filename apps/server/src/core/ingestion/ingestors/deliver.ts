/** Entrega de um webhook de ingestor: resolve/auto-cria a FONTE do canal e passa cada item
 *  normalizado pelo seam único (deliverConnectorPayload — dedupe + fila + gate). Espelha o
 *  connectorCreateHandler do Nango na criação da fonte, MAS sem exigir Nango: o vínculo
 *  fonte↔ingestor usa provider_config_key = "ingestor:<slug>" (mesmas colunas da migração 29). */
import { randomUUID } from "node:crypto";
import { getEngine, type SourceRow } from "../../platform/engine.ts";
import { mergeRecipeDimsIntoPack } from "../../extraction/schema-pack.ts";
import {
  deliverConnectorPayload,
  finalizeConnectorDeliveries,
  findSourceByProvider,
  setSourceProvider,
  type DeliverResult,
} from "../connector-ingest.ts";
import type { Ingestor } from "./types.ts";

/** provider_config_key sintético do vínculo fonte↔ingestor (não é um provider Nango). */
export function ingestorProviderKey(slug: string): string {
  return `ingestor:${slug}`;
}

/** Resolve a fonte do ingestor no brain; cria na 1ª entrega a partir do sourceSeed(). Idempotente. */
export async function resolveIngestorSource(brain: string, ing: Ingestor): Promise<string> {
  const pck = ingestorProviderKey(ing.slug);
  const existing = await findSourceByProvider(brain, pck);
  if (existing) return existing.sourceId;

  const seed = ing.sourceSeed();
  const recipe = { ...seed.recipe, fields: seed.recipe.fields ?? [] };
  if (recipe.fields.length) {
    // mesmo merge receita→pack do createSourceHandler (a dim da receita entra no extractable[type]).
    await mergeRecipeDimsIntoPack(brain, [{ type: seed.type, dims: recipe.fields.map((f) => f.dimension) }]);
  }
  const row: SourceRow = {
    id: randomUUID(),
    name: seed.name,
    channel: seed.channel,
    type: seed.type,
    recipe,
    default_sensitivity: seed.default_sensitivity ?? "restrito",
    status: "ativa",
    last_read_at: null,
  };
  const e = await getEngine(brain);
  await e.upsertSource(row);
  await setSourceProvider(brain, row.id, pck);
  return row.id;
}

export interface IngestorDeliverSummary {
  ingestor: string;
  sourceId: string;
  recebidos: number; // itens que o normalize devolveu
  enfileirados: number; // viraram job novo na fila (caminho LLM)
  aplicados: number; // claims determinísticos aplicados direto
  dedupados: number; // re-entrega do mesmo evento (ignorada sem erro)
  najanela: number; // mensagens acumuladas no buffer de conversa (ingerem quando a janela fechar)
  jobs: string[]; // ids dos jobs criados (polling em /v1/ingest/:id)
}

/** Teto de itens por webhook: acima disso é quase certeza de payload errado (ou abuso) — e o loop
 *  de entrega tocaria o DB centenas de vezes numa request só. Lotes reais (Evolution, planilha)
 *  ficam MUITO abaixo. */
const MAX_ITENS_POR_LOTE = 500;

/** Erro de USO do ingestor (payload ruim / normalize quebrado) — o gateway devolve 400 com a
 *  mensagem, em vez de 500 genérico. Não confundir com erro de infra (esses continuam lançando). */
export class IngestorUsageError extends Error {}

/** Roda o middleware (normalize) e entrega cada item no seam. Erro de UM item não derruba o lote:
 *  o item inválido conta como erro legível no summary do chamador (o gateway devolve 400 se TODOS
 *  falharem e 202 se pelo menos um entrou). */
export async function deliverIngestorWebhook(
  brain: string,
  ing: Ingestor,
  body: unknown,
): Promise<IngestorDeliverSummary & { erros: string[] }> {
  const sourceId = await resolveIngestorSource(brain, ing);

  // O normalize é código plugável (inclusive de aluno): se lançar, vira 400 LEGÍVEL com o slug —
  // nunca um 500 opaco na borda. O mesmo vale pra retorno que não é array (contrato quebrado).
  let itens: ReturnType<Ingestor["normalize"]>;
  try {
    itens = ing.normalize(body, { brain, sourceId, slug: ing.slug });
  } catch (err) {
    throw new IngestorUsageError(
      `o ingestor "${ing.slug}" não conseguiu ler esse payload: ${err instanceof Error ? err.message : err}`,
    );
  }
  if (!Array.isArray(itens)) {
    throw new IngestorUsageError(`o ingestor "${ing.slug}" devolveu um resultado inválido (esperado um array de itens).`);
  }
  if (itens.length > MAX_ITENS_POR_LOTE) {
    throw new IngestorUsageError(
      `lote grande demais: ${itens.length} itens (teto ${MAX_ITENS_POR_LOTE}). Divida o envio.`,
    );
  }

  const out: IngestorDeliverSummary & { erros: string[] } = {
    ingestor: ing.slug,
    sourceId,
    recebidos: itens.length,
    enfileirados: 0,
    aplicados: 0,
    dedupados: 0,
    najanela: 0,
    jobs: [],
    erros: [],
  };

  // janela de conversa (import lazy: evita ciclo deliver↔janela — janela.ts importa deste módulo).
  const { appendToJanela, janelaConfig } = await import("./janela.ts");
  const cfg = janelaConfig();

  let houveClaims = false;
  for (const item of itens) {
    try {
      // canal de conversa COM buffer ligado → acumula; a conversa ingere quando a janela fechar.
      if (item.janela && cfg.silencioMin > 0) {
        await appendToJanela(brain, ing.slug, item.janela, {
          quem: item.janela.quem,
          texto: item.janela.texto,
          quando: item.timestamp,
          ref: item.externalRef,
        });
        out.najanela++;
        continue;
      }
      const { janela: _janela, ...payload } = item;
      const r: DeliverResult = await deliverConnectorPayload(brain, { ...payload, sourceId });
      if (r.outcome === "enqueued") {
        out.enfileirados++;
        if (r.jobId) out.jobs.push(r.jobId);
      } else if (r.outcome === "claims_applied") {
        out.aplicados++;
        houveClaims = true;
      } else {
        out.dedupados++;
      }
    } catch (err) {
      out.erros.push(err instanceof Error ? err.message : String(err));
    }
  }
  // caminho determinístico embeda 1× ao fim do lote (mesmo contrato do webhook Nango).
  if (houveClaims) await finalizeConnectorDeliveries(brain);
  return out;
}
