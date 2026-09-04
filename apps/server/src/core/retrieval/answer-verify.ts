/** Verificação ancorada da RESPOSTA (M17/S1, LEI I — especificidade rastreia à fonte). Puro, sem IO/LLM.
 *  Estende o invariante anti-alucinação da EXTRAÇÃO (quote-check M4 / value-anchor M9) para a GERAÇÃO:
 *  cada claim sintetizado pelo LLM só SOBREVIVE se o `quote` está verbatim na fonte citada E todo número
 *  do `text` está ancorado nessa fonte. O que não ancora é DROPADO (vira linha nas "Lacunas" — ADR-011).
 *
 *  Reusa `quoteIsGrounded` e `valueIsAnchored` — NÃO reimplementa normalização nem parse de número
 *  (invariante #9: sem parser à mão). Tenant-neutro, síncrono, determinístico, zero ramo de formato. */
import { quoteIsGrounded } from "../../lib/quote-check.ts";
import { valueIsAnchored } from "../../lib/value-anchor.ts";

/** Um claim sintetizado pelo LLM (S2 pede ao modelo via structured). `quote` é o trecho VERBATIM da
 *  fonte `cite_slug` que sustenta `text`. A verificação (verifyAnswer) confirma esse contrato. */
export interface Claim {
  /** a afirmação em prosa que vai (talvez) pra resposta final. Pode conter números/nomes/termos. */
  text: string;
  /** slug da fonte citada — DEVE existir em `sources` (passagem) ou em `facts` (fato vigente). */
  cite_slug: string;
  /** trecho verbatim da fonte `cite_slug` que sustenta `text`. Vazio = sem âncora → claim cai. */
  quote: string;
}

/** Uma fonte verificável: o corpo (passagem recuperada OU linha de fato) contra o qual se ancora.
 *  S2 monta isto a partir dos `hits`/`bestChunk`/bodies (passagens) E das linhas de FATOS injetadas. */
export interface VerifySource {
  /** slug — casa com Claim.cite_slug. Para fatos, use o `source_slug` do fato. */
  slug: string;
  /** o texto contra o qual quote/número são verificados (corpo da passagem ou a linha do fato). */
  body: string;
}

/** Um claim que NÃO sobreviveu + o porquê (vira linha nas "Lacunas" — decisão §8c). */
export interface DroppedClaim {
  claim: Claim;
  /** motivo determinístico: por que caiu (pra transparência nas Lacunas e pra debug do gate). */
  reason: "no-cite" | "quote-not-grounded" | "number-not-anchored";
}

export interface VerifyResult {
  /** claims que passaram TODAS as portas — só estes viram prosa (S2 renderiza só daqui). */
  verified: Claim[];
  /** claims dropados + reason — S2 lista o que foi removido por falta de âncora nas "Lacunas". */
  dropped: DroppedClaim[];
}

/** Verificador determinístico da LEI I (M17). Puro, síncrono, sem IO/LLM. Para cada claim:
 *  1. cite_slug tem que existir em `sources` (ou `facts`) — senão DROP "no-cite".
 *  2. quote tem que ser grounded no body dessa fonte (quoteIsGrounded) — senão DROP "quote-not-grounded".
 *  3. todo número do `text` tem que estar ancorado no body da fonte (valueIsAnchored) — senão DROP
 *     "number-not-anchored".
 *  Reusa quoteIsGrounded (M4) + valueIsAnchored (M9). NÃO reimplementa nada. Tenant-neutro.
 *
 *  @param claims  os claims que o LLM devolveu (S2).
 *  @param sources passagens recuperadas verificáveis (slug+body).
 *  @param facts   linhas de FATO vigente verificáveis (slug+body) — mesma estrutura; separadas só pra
 *                 clareza semântica. Internamente sources∪facts é o universo de fontes citáveis. */
export function verifyAnswer(
  claims: Claim[],
  sources: VerifySource[],
  facts: VerifySource[] = [],
): VerifyResult {
  // universo de fontes citáveis, indexado por slug (passagens + fatos).
  const bySlug = new Map<string, string>();
  for (const s of [...sources, ...facts]) {
    if (!s?.slug) continue;
    // se o mesmo slug aparece em passagem E fato, concatena os corpos (mais material p/ ancorar).
    bySlug.set(
      s.slug,
      bySlug.has(s.slug) ? `${bySlug.get(s.slug)}\n${s.body || ""}` : s.body || "",
    );
  }

  const verified: Claim[] = [];
  const dropped: DroppedClaim[] = [];

  for (const c of claims) {
    const body = c.cite_slug ? bySlug.get(c.cite_slug) : undefined;
    if (body == null) {
      dropped.push({ claim: c, reason: "no-cite" });
      continue;
    }

    // (2) o quote precisa estar VERBATIM (normalizado) na fonte citada.
    if (!quoteIsGrounded(c.quote, body)) {
      dropped.push({ claim: c, reason: "quote-not-grounded" });
      continue;
    }

    // (3) todo número do TEXT tem que ancorar no body da fonte. valueIsAnchored(value, valueNum, body):
    //     value = o text do claim ; valueNum = null (deixa o parser tolerante do value-anchor agir).
    //     valueIsAnchored é true quando NÃO há número (claim textual) — então "cardiovascular" (sem
    //     número) passa nesta porta mas JÁ caiu na porta (2) se o quote não o contém. Correto.
    if (!valueIsAnchored(c.text, null, body)) {
      dropped.push({ claim: c, reason: "number-not-anchored" });
      continue;
    }

    verified.push(c);
  }

  return { verified, dropped };
}
