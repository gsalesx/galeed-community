/** M11/S3 — handler PURO do download do ORIGINAL VERBATIM (/api/source). Módulo reusável: reusa o
 *  Engine (getPage) + scope.ts (resolveScope/inScope) do M7 + BlobStore. O Integrador pluga a rota no
 *  web-server.ts (SEAM) — aqui só a lógica, GATED pelo RBAC.
 *
 *  Regra de ferro (ADR-005-b): o blob é o cru COM PII; o download HERDA o escopo do M7 (falha-fechado).
 *  Quem não vê a página NÃO baixa o original — senão o sigilo vaza por baixo. */
import { getEngine } from "../../core/platform/engine.ts";
import { blobPointerFor } from "../../core/ingestion/ingest-doc.ts";
import { getBlobStore } from "../../core/ingestion/blob-store.ts";
import { resolveScope, inScope } from "../../core/access/scope.ts";
import { BffError } from "./bff-common.ts";

/** Extrai o docHash do documento a partir da página. A captura grava a tag `doc:<docHash>` (1 por
 *  documento); o blob é por docHash. Cai p/ page.content_hash (hash da slice) se não houver tag `doc:`. */
function docHashOf(page: { tags?: string[]; content_hash?: string }): string {
  const tag = (page.tags ?? []).find((t) => t.startsWith("doc:"));
  if (tag) return tag.slice(4);
  return page.content_hash || "";
}

/** Resolve o original verbatim de uma página, com GATE de RBAC (M7).
 *  - `principalId` ausente/"" → DONO logado (admin): baixa qualquer página do PRÓPRIO brain (home já
 *     validado por requireBrain no web-server — membership). Mesmo modelo das rotas de leitura do M10.
 *  - `principalId` presente → agente ESCOPADO: só baixa se a página estiver no escopo (inScope). Fora → 403.
 *  Página inexistente / sem blob → 404. Devolve o binário + metadados p/ o web-server emitir. */
export async function sourceHandler(
  home: string,
  slug: string,
  principalId?: string,
): Promise<{ buffer: Buffer; mime: string; filename: string }> {
  if (!slug) throw new BffError(400, "faltou ?slug=");
  const e = await getEngine(home);
  const page = await e.getPage(slug);
  if (!page) throw new BffError(404, "fonte não encontrada");

  // GATE RBAC: agente escopado só baixa o que vê. Falha-fechado (scope vazio → inScope false → 403).
  if (principalId) {
    const scope = await resolveScope(home, principalId);
    if (!inScope({ type: page.type, tags: page.tags, sensitivity: page.sensitivity }, scope)) {
      throw new BffError(403, "sem acesso a esta fonte");
    }
  }

  const hash = docHashOf(page);
  if (!hash) throw new BffError(404, "fonte sem original guardado");
  const ptr = await blobPointerFor(home, hash);
  const buf = await getBlobStore().get(home, hash);
  if (!ptr || !buf) throw new BffError(404, "original não disponível");
  return { buffer: buf, mime: ptr.mime || "application/octet-stream", filename: ptr.filename || slug };
}
