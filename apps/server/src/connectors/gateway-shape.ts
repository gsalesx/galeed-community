/** GATEWAY /v1 — TRADUÇÃO de shape (a peça que torna a doc verdadeira). Funções PURAS que mapeiam
 *  o shape INTERNO do motor (FactItem do bff-m9 + PageRow-fonte do engine) para o contrato PÚBLICO
 *  documentado em apps/docs/openapi.yaml + apps/docs/src/sections/{perguntar,fatos,conceitos}.astro.
 *
 *  Sem HTTP, sem I/O, sem dependência do engine — só mapeamento determinístico. O gateway-server.ts
 *  carrega o contexto da página-fonte (engine.pagesBySlug) e passa pra cá; aqui só traduzimos.
 *
 *  REGRA DE OURO (do briefing): se um campo NÃO existir no motor, OMITIR ou null — NUNCA inventar.
 *
 *  Campo a campo contra o contrato público (perguntar.astro / fatos.astro / conceitos.astro):
 *    id           ← FactItem não tem id estável → derivado determinístico de (slug|entity|predicate|
 *                   tier|valid_from|value) com prefixo "fact_". Estável entre chamadas p/ o mesmo fato.
 *    status       ← natureza/status interno (fato|hipotese|arquivado|registrado) → público
 *                   (fact|hypothesis|archived). "registrado"/desconhecido → "fact" (registro vira fato).
 *    text         ← FactItem.text (conteúdo do fato; "" se vazio).
 *    confidence   ← FactItem.confidence (0–1). null se ausente (não fabrica 1.0).
 *    sensitivity  ← sensibilidade da PÁGINA-FONTE (publico|interno|sensivel|restrito) →
 *                   (open|internal|confidential|secret). Sem página → "secret" (falha-fechado).
 *    area[]       ← tags `area:<slug>` da PÁGINA-FONTE (areasOf). [] se nenhuma.
 *    source       ← { type: tipo da página-fonte, ref: source_slug, occurred_at: data da página
 *                   ou valid_from do fato }. occurred_at null se nenhuma data.
 *    valid_from   ← FactItem.valid_from (null se "").
 *    valid_until  ← FactItem.valid_to; "" (vigente) → null.
 *    supersedes   ← o motor NÃO expõe o predecessor por fato → null (omitido honesto, ver LIMITAÇÕES).
 */
import { createHash } from "node:crypto";
import { areasOf } from "../core/access/scope.ts";
import type { FactItem } from "./bff/bff-m9.ts";

/** PageRow-fonte (subset do que precisamos p/ traduzir): tipo, data, tags (área), sensibilidade. */
export interface SourcePageCtx {
  type?: string;
  date?: string;
  tags?: string[];
  sensitivity?: string;
}

/** status público desta rota (fase 1). hypothesis NÃO é prometido por /v1/facts (parte de
 *  dim:"decisions", que não contém hipóteses) — fica como roadmap. Ver publicStatus/LIMITAÇÕES. */
export type PublicStatus = "fact" | "archived";

/** Selo público de uma fonte (o JSON exato de perguntar.astro / fatos.astro / conceitos.astro). */
export interface PublicFact {
  id: string;
  status: PublicStatus;
  text: string;
  confidence: number | null;
  sensitivity: "open" | "internal" | "confidential" | "secret";
  area: string[];
  source: { type: string; ref: string; occurred_at: string | null };
  valid_from: string | null;
  valid_until: string | null;
  supersedes: string | null;
}

/** status público desta rota — derivado do STATUS interno E do TEMPO.
 *
 *  O motor grava status:"fato" mesmo em fato VENCIDO (a supersessão é via valid_to, não via o campo
 *  status). Por isso o status público NÃO pode vir só do campo cru: um fato com `valid_until` no
 *  PASSADO (relativo a `asOf`, ou a hoje quando asOf ausente) está SUPERADO ⇒ "archived",
 *  independentemente do status interno. Sem valid_until (vigente) ou com valid_until no futuro ⇒
 *  "fact". O status interno "arquivado" também mapeia "archived" (consistência).
 *
 *  hypothesis NÃO é prometido por esta rota (dim:"decisions" não traz hipóteses) — "hipotese" e
 *  qualquer desconhecido caem em "fact". Ver PublicStatus / contrato (fatos.astro).
 *
 *  LIMITAÇÃO/HONESTIDADE: claims 'nao-verificado' (quote NÃO ancorado na fonte — suspeitos de
 *  alucinação) NUNCA chegam aqui: são excluídos ANTES da tradução por `publishable()` (o invariante
 *  interno do motor — postgres.ts currentFacts: "nao-verificado nunca é verdade vigente" — vale
 *  também na borda pública). Este mapeamento só vê material publicável. */
export function publicStatus(
  internal: string | undefined,
  validUntil?: string | null,
  asOf?: string,
): PublicStatus {
  // 1) TEMPO primeiro: valid_until não-nulo E no passado (< asOf-ou-hoje) → superado = archived.
  const vu = validUntil && validUntil.length ? validUntil : null;
  if (vu) {
    const ref = asOf && asOf.length ? asOf : new Date().toISOString().slice(0, 10);
    if (vu < ref) return "archived";
  }
  // 2) status interno: só "arquivado" leva a archived; o resto (fato/registrado/hipotese/…) = fact.
  if ((internal || "").toLowerCase() === "arquivado") return "archived";
  return "fact";
}

/** FILTRO DE HONESTIDADE da borda /v1 (fase 1): a rota promete FATOS — claim com status interno
 *  'nao-verificado' (quote não ancorado na fonte ⇒ suspeito de alucinação, confidence ~0.3, e que
 *  a supersessão bitemporal deliberadamente IGNORA) não é fato e NÃO sai por /v1/facts nem pelo
 *  facts[] do /v1/ask. Sem este filtro, publicStatus o rotulava "fact" (mentira no contrato).
 *  Aplicar DEPOIS do escopo (o `withheld` conta só barreira de ACESSO, não filtro de qualidade).
 *  Se um dia o material não-verificado for exposto, que seja por parâmetro explícito (roadmap),
 *  nunca por default. Função pura, testável sem HTTP. */
export function publishable(facts: FactItem[]): FactItem[] {
  return facts.filter((f) => (f.status || "").toLowerCase() !== "nao-verificado");
}

/** Formato aceito pro parâmetro público `dim` do /v1/facts: nome de dimensão minúsculo (a..z,
 *  0-9, _), até 40 chars. NÃO é allowlist de valores — as dimensões reais são definidas por
 *  receita/pack do tenant (inclusive em PT: "decisoes", "compromissos"…), então validamos só o
 *  FORMATO (o SQL a jusante é parametrizado; dim inexistente devolve [] honesto). */
export const DIM_RE = /^[a-z][a-z0-9_]{0,39}$/;

/** sensibilidade interna (publico|interno|sensivel|restrito) → pública (open|internal|confidential|
 *  secret). Ausente/desconhecida → "secret" (falha-fechado, espelha o default 'restrito' do engine). */
export function publicSensitivity(
  internal: string | undefined,
): "open" | "internal" | "confidential" | "secret" {
  switch ((internal || "").toLowerCase()) {
    case "publico":
      return "open";
    case "interno":
      return "internal";
    case "sensivel":
      return "confidential";
    case "restrito":
      return "secret";
    default:
      return "secret"; // falha-fechado: sem sensibilidade conhecida = o mais fechado
  }
}

/** id público estável de um fato. O FactItem não tem id próprio (a camada de fatos é derivada), então
 *  derivamos um hash determinístico da identidade do fato — MESMO fato ⇒ MESMO id entre chamadas. */
export function factId(f: FactItem): string {
  const key = [
    f.source_slug ?? "",
    f.entity ?? "",
    f.predicate ?? "",
    f.tier ?? "",
    f.valid_from ?? "",
    f.value ?? "",
    f.text ?? "",
  ].join("|");
  return "fact_" + createHash("sha256").update(key).digest("hex").slice(0, 12);
}

/** "" / undefined → null; senão a string. (valid_to "" do motor = vigente = null no contrato.) */
function nullIfEmpty(v: string | undefined): string | null {
  return v && v.length ? v : null;
}

/** Traduz UM FactItem interno + o contexto da página-fonte para o selo PÚBLICO. Função pura.
 *  `asOf` (opcional, do /v1/facts?as_of=) é o ponto temporal usado pra decidir se o fato está
 *  SUPERADO (valid_until < asOf → archived); ausente = hoje. */
export function toPublicFact(f: FactItem, page: SourcePageCtx | undefined, asOf?: string): PublicFact {
  return {
    id: factId(f),
    status: publicStatus(f.status, f.valid_to, asOf),
    text: f.text ?? "",
    confidence: typeof f.confidence === "number" ? f.confidence : null,
    sensitivity: publicSensitivity(page?.sensitivity),
    area: areasOf(page?.tags),
    source: {
      type: page?.type ?? "",
      ref: f.source_slug ?? "",
      occurred_at: nullIfEmpty(page?.date) ?? nullIfEmpty(f.valid_from),
    },
    valid_from: nullIfEmpty(f.valid_from),
    valid_until: nullIfEmpty(f.valid_to),
    supersedes: null, // o motor não expõe o predecessor por fato — null honesto (ver LIMITAÇÕES)
  };
}

/** Bloco `withheld` do /v1/ask: honestidade sobre o que o escopo escondeu.
 *
 *  SEMÂNTICA (MINOR fix — alinhar contagem ↔ promessa): `count` é o nº de FATOS DA RESPOSTA (a série
 *  bitemporal das entidades casadas na pergunta) que o escopo da borda removeu — NÃO um total absoluto
 *  do corpus barrado. Com o Blocker corrigido, o MOTOR já é escopado (a prosa nunca vê o que está fora
 *  do acesso); este `withheld` é a contagem honesta dos fatos da série que a borda barrou como
 *  defesa-em-profundidade. Não promete precisão sobre TODO o corpus — não há como computá-la exata sem
 *  varrer o brain inteiro, e fingir um total seria desonesto. reason é fixo e legível ("fora do seu
 *  acesso", igual ao produto). count=0 ⇒ reason "". */
export function withheldBlock(count: number): { count: number; reason: string } {
  const n = Math.max(0, count | 0);
  return { count: n, reason: n > 0 ? "fora do seu acesso" : "" };
}
