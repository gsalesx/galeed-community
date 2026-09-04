/** Ingestor "formulario" — submissões de formulário (lead do site, Google Forms, Typeform,
 *  Tally…) viram memória pesquisável. O caminho universal é a automação (Zapier/Make/n8n)
 *  postar os campos; muitos forms também conseguem postar direto.
 *
 *  Aceita:
 *   { "formulario": "Orçamento pelo site", "campos": { "Nome": "João", "Telefone": "...", ... },
 *     "occurred_at"?: "...", "ref"?: "id-da-submissao" }
 *  ou o shape CHATO (campos soltos na raiz, como o Zapier manda por padrão): qualquer chave
 *  primitiva fora das reservadas vira campo. */
import { createHash } from "node:crypto";
import type { Ingestor, IngestorItem } from "./types.ts";

const RESERVADAS = new Set(["formulario", "form", "campos", "fields", "occurred_at", "date", "ref", "id", "title", "titulo"]);

function sha16(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : v === null || v === undefined ? "" : String(v).trim();
}

/** campos → pares [rótulo, valor] legíveis; ignora vazio/objeto aninhado (form real é plano). */
function paresDe(obj: Record<string, unknown>): [string, string][] {
  const out: [string, string][] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) continue;
    if (typeof v === "object" && !Array.isArray(v)) continue;
    const val = Array.isArray(v) ? v.map((x) => str(x)).filter(Boolean).join(", ") : str(v);
    if (val) out.push([k, val]);
  }
  return out;
}

export const formularioIngestor: Ingestor = {
  slug: "formulario",
  nome: "Formulário / lead",
  descricao: "Submissões de formulário (lead do site, Google Forms, Typeform) — via Zapier/Make/n8n ou POST direto.",
  exemplo: `{ "formulario": "Orçamento pelo site", "campos": { "Nome": "João Pereira", "Telefone": "(47) 99999-8888", "Mensagem": "Quero orçamento de drenagem" } }`,

  sourceSeed() {
    return {
      name: "Formulários",
      channel: "formulario",
      type: "formulario",
      recipe: { fields: [] }, // modo livre: a extração LLM lê nome/pedido/contato do texto
    };
  },

  normalize(body): IngestorItem[] {
    const b = (body ?? {}) as Record<string, unknown>;
    const nomeForm = str(b.formulario) || str(b.form) || str(b.titulo) || str(b.title) || "Formulário";

    const campos =
      b.campos && typeof b.campos === "object" && !Array.isArray(b.campos)
        ? paresDe(b.campos as Record<string, unknown>)
        : b.fields && typeof b.fields === "object" && !Array.isArray(b.fields)
          ? paresDe(b.fields as Record<string, unknown>)
          : paresDe(Object.fromEntries(Object.entries(b).filter(([k]) => !RESERVADAS.has(k.toLowerCase()))));
    if (!campos.length) return []; // submissão vazia/ping → ignora

    const occurred = str(b.occurred_at) || str(b.date);
    const timestamp = occurred && !Number.isNaN(Date.parse(occurred))
      ? new Date(occurred).toISOString()
      : new Date().toISOString();
    const corpo = campos.map(([k, v]) => `- **${k}**: ${v}`).join("\n");
    const externalRef = str(b.ref) || str(b.id) || `form:${sha16(`${nomeForm}\n${corpo}`)}`;

    return [{
      content: `# ${nomeForm}\n\nRecebido em ${timestamp.slice(0, 16).replace("T", " ")}\n\n${corpo}`,
      contentType: "text/markdown",
      timestamp,
      externalRef,
      title: nomeForm,
    }];
  },
};
