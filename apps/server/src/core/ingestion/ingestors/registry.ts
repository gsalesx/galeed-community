/** Registro dos ingestores (espelha o padrão do connector-ingest: Map em memória, boot idempotente
 *  e explícito em quem sobe o processo — gateway lista/executa; BFF só lista pro painel). */
import type { Ingestor } from "./types.ts";

const ingestors = new Map<string, Ingestor>();

export function registerIngestor(i: Ingestor): void {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(i.slug)) {
    throw new Error(`slug de ingestor inválido: "${i.slug}" (use kebab-case minúsculo).`);
  }
  ingestors.set(i.slug, i); // último ganha (re-registro em teste/hot reload)
}

export function getIngestor(slug: string): Ingestor | undefined {
  return ingestors.get(slug);
}

/** Metadados pro painel/docs (nunca expõe a função normalize). Ordem estável por slug. */
export function listIngestors(): { slug: string; nome: string; descricao: string; exemplo?: string }[] {
  return [...ingestors.values()]
    .sort((a, b) => a.slug.localeCompare(b.slug))
    .map(({ slug, nome, descricao, exemplo }) => ({ slug, nome, descricao, exemplo }));
}

export function clearIngestors(): void {
  ingestors.clear(); // SÓ testes
}
