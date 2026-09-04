/** CAMADA 1 — captura: texto cru -> fonte no banco (galeed_pages). Determinístico, sem LLM.
 *  Idempotente quando recebe externalId — e ATÔMICO: o UNIQUE (brain, external_id) arbitra (P1-D). */
import { createHash } from "node:crypto";
import { resolveTipo } from "../platform/brain.ts";
import { slugify } from "../../lib/slug.ts";
import { classify } from "./classify.ts";
import { getEngine } from "../platform/engine.ts";
import { resolveChannel } from "./channels.ts";

export interface CaptureInput {
  home: string; // id do tenant (brain)
  text: string;
  type?: string; // opcional — sem ele o cérebro CLASSIFICA sozinho (ingestão autônoma)
  title?: string; // opcional — derivado do conteúdo se ausente
  date?: string;
  tags?: string[];
  people?: string[];
  source?: string; // origem do webhook (whatsapp, notetaker, email...) — pista pro classificador
  externalId?: string; // id do evento na origem (ex.: messageId, meetingId) — garante idempotência
  // --- M7: classificação de acesso na ENTRADA ---
  area?: string;        // área (texto livre — é SLUGIFICADA aqui); vira a tag `area:<slug>`. Se ausente, resolve de `source`.
  sensitivity?: string; // nível; se ausente, resolve de `source`. Fail-closed → 'restrito'.
}

export async function capture(inp: CaptureInput) {
  const e = await getEngine(inp.home);

  // dedup por external_id: re-post da mesma origem não duplica
  if (inp.externalId) {
    const seen = await e.pageByExternalId(inp.externalId);
    if (seen) return { slug: seen, type: "", path: "", rel: "", skipped: true as const };
  }

  // INGESTÃO AUTÔNOMA: classifica tipo/título/pessoas sozinho quando não vêm explícitos.
  const cls = classify(inp.text, { source: inp.source, type: inp.type, title: inp.title });
  const tipo = inp.type ? resolveTipo(inp.type) : cls.tipo;
  const title = cls.title;
  const date = inp.date || new Date().toISOString().slice(0, 10);
  const hash = createHash("sha256").update(inp.text).digest("hex").slice(0, 16);

  // slug único SEM colisão por truncamento (A10): o sufixo de hash entra DEPOIS do corte do
  // título — stem ≤ 73 chars (80 − 7 do sufixo "-xxxxxx"); o slug final NUNCA passa de 80.
  // Colisão de slug = sufixa com hash do conteúdo (determinístico: mesmo conteúdo → mesmo slug).
  // NOTA (§1.4 da spec): getPage não expõe content_hash, então NÃO há como distinguir "mesmo
  // conteúdo" aqui — toda colisão sufixa (comportamento de fato preservado, agora explícito).
  const full = `${date}-${slugify(title)}`;
  let slug = full.slice(0, 80);
  const existing = await e.getPage(slug);
  if (existing) slug = suffixed(full, hash);

  // M7/R16 — classificação de acesso na ENTRADA (determinística, sem LLM).
  // Resolve a política do canal (`source`); explícito ganha do canal; fail-closed → 'restrito'.
  // A área vira a tag `area:<slug>` comparada por IGUALDADE nos grants (scope.ts) e na RLS —
  // normaliza com o MESMO slugify dos caminhos por fonte (process-blob-job/connector-ingest),
  // senão "Financeiro" do webhook nunca casa com grant 'financeiro' (página invisível fail-closed,
  // sem aviso). NUNCA slugify de vazio: slugify("") = "sem-titulo" taggearia toda página sem
  // canal mapeado (pol.area default é "") com area:sem-titulo.
  const pol = resolveChannel(inp.source);
  const rawArea = (inp.area ?? pol.area).trim();
  const area = rawArea ? slugify(rawArea) : "";
  const sensitivity = inp.sensitivity ?? pol.sensitivity;

  // pessoas = as passadas explicitamente ∪ as detectadas no texto
  const people = [...new Set([...(inp.people ?? []), ...cls.people])];
  const tags = [...(inp.tags ?? [])];
  if (inp.source) tags.push(`fonte:${inp.source}`);
  if (area && !tags.includes(`area:${area}`)) tags.push(`area:${area}`);

  const row = {
    slug,
    type: tipo,
    title,
    date,
    path: "",
    body: inp.text.trim() + "\n",
    content_hash: hash,
    external_id: inp.externalId,
    people,
    tags,
    extract_version: "", // ainda não extraída
  };

  if (inp.externalId) {
    // P1-D/M9b — escrita ATÔMICA: o UNIQUE (migração 28) arbitra; check-then-insert morreu.
    // Corrida perdida/re-post simultâneo ⇒ inserted=false ⇒ skipped (NUNCA sobrescreve nem
    // re-dispara Fase B). 23505 = colisão de SLUG com external_id diferente (raríssimo):
    // re-resolve e tenta 1× com slug sufixado; persistindo, falha com mensagem legível.
    let inserted = false;
    try {
      inserted = await e.insertPageIfNew(row);
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const seen = await e.pageByExternalId(inp.externalId);
      if (seen) return { slug: seen, type: "", path: "", rel: "", skipped: true as const };
      row.slug = suffixed(full, hash);
      try {
        inserted = await e.insertPageIfNew(row); // 2º 23505 sobe como erro (legível abaixo)
      } catch (err2) {
        if (isUniqueViolation(err2))
          throw new Error(`colisão persistente de slug ao capturar "${row.slug}" — re-tente a ingestão.`);
        throw err2;
      }
    }
    if (!inserted) {
      const seen = await e.pageByExternalId(inp.externalId);
      return { slug: seen ?? row.slug, type: "", path: "", rel: "", skipped: true as const };
    }
    slug = row.slug;
  } else {
    await e.upsertPage(row); // caminho SEM externalId: byte-idêntico a hoje (cli/mcp)
  }
  // upsertPage/insertPageIfNew (S1) não gravam `sensitivity` no INSERT (coluna tem default
  // 'restrito'); gravar o nível resolvido aqui SÓ quando a página foi de fato gravada
  // (idempotente; sobrescreve o default). Fail-closed preservado. Skip NÃO toca a página.
  await e.setSensitivity(slug, sensitivity);

  return { slug, type: tipo, path: "", rel: "", skipped: false as const, auto: !inp.type, confident: cls.confident, signals: cls.signals, area, sensitivity };
}

/** helper local (função pura): slug ≤ 80 com sufixo de hash DEPOIS do truncamento (A10). */
function suffixed(full: string, hash: string): string {
  const stem = full.slice(0, 73).replace(/-+$/, "");
  return `${stem}-${hash.slice(0, 6)}`;
}

/** helper local: violação de unicidade do Postgres (o driver `postgres` expõe err.code). */
function isUniqueViolation(err: unknown): boolean {
  return !!err && typeof err === "object" && (err as any).code === "23505";
}
