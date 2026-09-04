/** Ingestor "texto" — o mais simples possível; serve de TEMPLATE pro aluno copiar.
 *
 *  Aceita: { text, title?, occurred_at?, ref? }  (ou "content" como sinônimo de "text").
 *  Uso: qualquer automação que consiga dar um POST JSON (Zapier/Make/n8n, script, cron).
 *
 *  Pra criar o SEU ingestor: copie este arquivo, troque slug/nome/sourceSeed e escreva o seu
 *  normalize() — a parte que "trabalha o dado antes de ingerir de vez". Registre em boot.ts.
 *  Guia completo: INGESTORES.md na raiz. */
import { createHash } from "node:crypto";
import type { Ingestor, IngestorItem } from "./types.ts";

function sha16(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

export const textoIngestor: Ingestor = {
  slug: "texto",
  nome: "Texto (webhook genérico)",
  descricao: "Qualquer automação que faça POST de um JSON { text, title?, occurred_at?, ref? }.",
  exemplo: `{ "title": "Ata da reunião", "text": "Decidimos que...", "occurred_at": "2026-07-01" }`,

  sourceSeed() {
    return {
      name: "Webhook de texto",
      channel: "webhook",
      type: "texto",
      recipe: { fields: [] }, // modo livre: extração padrão, sem gate de receita
    };
  },

  normalize(body): IngestorItem[] {
    const b = (body ?? {}) as Record<string, unknown>;
    const text = str(b.text) || str(b.content);
    if (!text) return []; // sem texto não há o que ingerir (ping/ack → ignora)

    const title = str(b.title) || undefined;
    const occurred = str(b.occurred_at);
    const timestamp = occurred && !Number.isNaN(Date.parse(occurred))
      ? new Date(occurred).toISOString()
      : new Date().toISOString();
    // ref estável = dedupe: re-enviar o MESMO evento não duplica nada.
    const externalRef = str(b.ref) || `texto:${sha16(`${title ?? ""}\n${text}`)}`;

    return [{
      content: title ? `# ${title}\n\n${text}` : text,
      contentType: "text/markdown",
      timestamp,
      externalRef,
      title,
    }];
  },
};
