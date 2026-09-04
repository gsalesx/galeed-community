/** M22-B — Conector Conta Azul: ERP → páginas PT + claims DETERMINÍSTICOS (zero LLM).
 *  Shapes do OpenAPI oficial — fontes citadas em §2.1 da DESIGN-SPEC (invariante #9):
 *  vendas:  https://developers.contaazul.com/docs/sales-apis-openapi/v1/searchvendas.md
 *  pagar:   https://developers.contaazul.com/docs/financial-apis-openapi/v1/searchinstallmentstopaybyfilter.md
 *  receber: https://developers.contaazul.com/docs/financial-apis-openapi/v1/searchinstallmentstoreceivebyfilter.md
 *  pessoas: https://developers.contaazul.com/open-api-docs/open-api-person/v1/retornapessoasporfiltros.md
 *  Módulo FOLHA (ADR-002/invariante III): o core não sabe o que é "conta azul". Importa SÓ a API
 *  pública existente do motor; nenhum arquivo do motor é editado. */
import { createHash } from "node:crypto";
import { slugify } from "../../../lib/slug.ts";
import {
  getEngine,
  type SourceRow,
  type SourceRecipe,
} from "../../platform/engine.ts";
import { applyRecipeGate, addReviewItemsAndNotify } from "../golden-rule.ts";
import { capture } from "../capture.ts";
import { putBlobOnly } from "../ingest-doc.ts";
import { deriveIncremental } from "../../retrieval/indexer.ts";

/** sha16 = sha256(texto).hex.slice(0,16) — MESMA convenção do capture/P1-D (capture.ts:39). */
function sha16(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/** Os 4 modelos sincronizados. As chaves são as DIMENSÕES da receita (§5). */
export type ContaAzulModel = "vendas" | "contas_a_pagar" | "contas_a_receber" | "pessoas";

/** Um lote de records crus de UM modelo (como saem do GET /records do Nango, sem _nango_metadata). */
export interface ContaAzulBatch {
  model: ContaAzulModel;
  records: unknown[]; // shape oficial do modelo (validado/normalizado dentro do normalizador)
}

/** Página normalizada: 1 record → 1 página PT + claims da dimensão do modelo. */
export interface NormalizedErpPage {
  externalRef: string; // `ca:<model>:<uuid do record>` — PROVENIÊNCIA renderizada DENTRO do body
  title: string; // PT legível, ex.: "Venda nº 1001 — Acme Ltda"
  date: string; // YYYY-MM-DD — data do EVENTO (LEI V), vira page.date
  body: string; // a página textual PT (fonte do quote/âncora)
  dimension: ContaAzulModel; // dimensão dos claims (= chave na receita)
  claims: ErpClaim[]; // claims determinísticos (shape do indexer/gate)
}

/** Claim no MESMO shape que o applyRecipeGate/derivePageFacts leem (golden-rule.ts §60-68). */
export interface ErpClaim {
  text: string; // o claim em linguagem natural (PT)
  entity: string; // slug (slugify do nome) — dono claro (LEI II do M23)
  predicate: "venda" | "conta_a_pagar" | "conta_a_receber" | "perfil";
  value: string; // grafia EXATA presente no body (âncora por construção)
  value_num: number | null; // número cru (1250.5) — null nos claims sem número (perfil)
  unit: string; // "BRL" | "" (perfil)
  period: string; // "" (eventos pontuais)
  tier: string; // SÉRIE estável por documento: "venda-1001" | "parcela-<id8>" | ""
  valid_from: string; // YYYY-MM-DD — data do EVENTO (factValidFrom lê direto; P0-A)
  context_quote: string; // linha VERBATIM do body (quoteIsGrounded passa por construção)
}

/** Helper de moeda ÚNICO (pt-BR): 1250 → "R$ 1.250,00". O Intl insere um NBSP (U+00A0) entre
 *  "R$" e o número; normalizamos pra espaço comum (legibilidade) — usado nos DOIS lados (body e
 *  claim), então value/context_quote são SEMPRE substrings literais do body (ancoragem por
 *  construção; R2 da DESIGN-SPEC). */
export function formatBRL(n: number): string {
  // O Intl pt-BR insere um NBSP (U+00A0) entre "R$" e o número; normalizamos pra espaco comum
  // (legibilidade) — usado nos DOIS lados (body e claim), entao value/context_quote sao SEMPRE
  // substrings literais do body (ancoragem por construcao; R2 da DESIGN-SPEC).
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" })
    .format(n)
    .replace(/\u00a0/g, " ");
}

/** data com hora ("2024-01-15T10:30:00") → "2024-01-15"; já-data → ela mesma; vazio → "". */
function dateOnly(raw: unknown): string {
  const s = String(raw ?? "").trim();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : "";
}

/** Normalizador PURO (sem IO/env/clock): records oficiais → páginas+claims. Record que não
 *  parseia (sem id ou sem data de evento) NÃO é descartado em silêncio: entra em `descartados`
 *  com motivo legível em PT (invariante #5 — quem chama loga/decide). */
export function normalizeContaAzulBatch(batch: ContaAzulBatch): {
  pages: NormalizedErpPage[];
  descartados: { record: unknown; motivo: string }[];
} {
  const pages: NormalizedErpPage[] = [];
  const descartados: { record: unknown; motivo: string }[] = [];
  for (const rec of batch.records) {
    const r = rec as any;
    const id = String(r?.id ?? "").trim();
    if (!id) {
      descartados.push({ record: rec, motivo: "registro sem id — não ingerido" });
      continue;
    }
    let page: NormalizedErpPage | null = null;
    switch (batch.model) {
      case "vendas":
        page = normalizeVenda(r, id);
        break;
      case "contas_a_pagar":
        page = normalizeParcela(r, id, "contas_a_pagar");
        break;
      case "contas_a_receber":
        page = normalizeParcela(r, id, "contas_a_receber");
        break;
      case "pessoas":
        page = normalizePessoa(r, id);
        break;
    }
    if (!page) {
      descartados.push({ record: rec, motivo: "registro sem data de evento — não ingerido" });
      continue;
    }
    pages.push(page);
  }
  return { pages, descartados };
}

function normalizeVenda(r: any, id: string): NormalizedErpPage | null {
  const date = dateOnly(r?.data); // data do EVENTO (LEI V)
  if (!date) return null;
  const numero = r?.numero;
  const total = typeof r?.total === "number" ? r.total : Number(r?.total);
  const valBRL = formatBRL(Number.isFinite(total) ? total : 0);
  const clienteNome = String(r?.cliente?.nome ?? "").trim();
  const situacao = String(r?.situacao?.nome ?? r?.situacao?.descricao ?? "").trim();
  const externalRef = `ca:vendas:${id}`;

  // linha 1 = a âncora literal (prefixo é o context_quote do claim)
  const alvoCliente = clienteNome || "cliente não informado";
  const quote = `Venda nº ${numero} para ${alvoCliente} em ${date}: ${valBRL}`;
  const linha1 = `${quote}${situacao ? ` (situação: ${situacao})` : ""}.`;
  const linha2 =
    `Cliente: ${alvoCliente}. Registro Conta Azul ${externalRef}` +
    `${r?.data_alteracao ? ` (alterado em ${r.data_alteracao})` : ""}.`;
  const body = `${linha1}\n${linha2}`;

  const title = `Venda nº ${numero} — ${alvoCliente}`;

  // Com cliente nomeado → claim TIPADO (triple); sem nome → claim só-textual (nunca inventa entity).
  const claim: ErpClaim = clienteNome
    ? {
        text: `Venda nº ${numero} para ${clienteNome}: ${valBRL} em ${date}`,
        entity: slugify(clienteNome),
        predicate: "venda",
        value: valBRL,
        value_num: Number.isFinite(total) ? total : null,
        unit: "BRL",
        period: "",
        tier: `venda-${numero}`, // SÉRIE por venda (entity,predicate,tier) — supersessão por nº
        valid_from: date,
        context_quote: quote,
      }
    : {
        text: `Venda nº ${numero}: ${valBRL} em ${date}`,
        entity: "",
        predicate: "venda",
        value: valBRL,
        value_num: Number.isFinite(total) ? total : null,
        unit: "BRL",
        period: "",
        tier: `venda-${numero}`,
        valid_from: date,
        context_quote: quote,
      };

  return { externalRef, title, date, body, dimension: "vendas", claims: [claim] };
}

function normalizeParcela(
  r: any,
  id: string,
  dimension: "contas_a_pagar" | "contas_a_receber",
): NormalizedErpPage | null {
  // data do EVENTO econômico: competência (regime de competência) || vencimento (cravado §7.2)
  const date = dateOnly(r?.data_competencia) || dateOnly(r?.data_vencimento);
  if (!date) return null;
  const venc = dateOnly(r?.data_vencimento);
  const comp = dateOnly(r?.data_competencia);
  const descricao = String(r?.descricao ?? "").trim();
  const total = typeof r?.total === "number" ? r.total : Number(r?.total);
  const valBRL = formatBRL(Number.isFinite(total) ? total : 0);
  const status = String(r?.status_traduzido ?? r?.status ?? "").trim();
  const isPagar = dimension === "contas_a_pagar";
  // a pagar usa fornecedor; a receber usa cliente
  const parteNome = String((isPagar ? r?.fornecedor?.nome : r?.cliente?.nome) ?? "").trim();
  const parteLabel = isPagar ? "Fornecedor" : "Cliente";
  const tipoLabel = isPagar ? "Conta a pagar" : "Conta a receber";
  const externalRef = `ca:${dimension}:${id}`;

  const quote = `${tipoLabel}: ${descricao} — ${valBRL}, vencimento ${venc || "n/d"}`;
  const linha1 = `${quote}${status ? ` (status: ${status})` : ""}.`;
  const fonteEntidade = parteNome || descricao;
  const linha2 =
    `${parteLabel}: ${fonteEntidade}.` +
    `${comp ? ` Competência: ${comp}.` : ""}` +
    ` Registro Conta Azul ${externalRef}` +
    `${r?.data_alteracao ? ` (alterado em ${r.data_alteracao})` : ""}.`;
  const body = `${linha1}\n${linha2}`;

  const title = `${tipoLabel}: ${descricao || fonteEntidade}`;

  const predicate = isPagar ? "conta_a_pagar" : "conta_a_receber";
  // entity = fornecedor/cliente nomeado, senão a descrição (pode ser vago → o gate manda pra fila)
  const claim: ErpClaim = {
    text: `${tipoLabel} de ${fonteEntidade}: ${valBRL}, vencimento ${venc || "n/d"}${status ? ` (${status})` : ""}`,
    entity: slugify(fonteEntidade),
    predicate,
    value: valBRL,
    value_num: Number.isFinite(total) ? total : null,
    unit: "BRL",
    period: "",
    tier: `parcela-${id.slice(0, 8)}`, // SÉRIE por parcela — update da parcela supersede
    valid_from: date,
    context_quote: quote,
  };

  return { externalRef, title, date, body, dimension, claims: [claim] };
}

function normalizePessoa(r: any, id: string): NormalizedErpPage | null {
  // data do EVENTO: criação (fallback: data de alteração)
  const date = dateOnly(r?.data_criacao) || dateOnly(r?.data_alteracao);
  if (!date) return null;
  const nome = String(r?.nome ?? "").trim();
  if (!nome) return null;
  const tipo = String(r?.tipo_pessoa ?? "").trim();
  const perfisArr = Array.isArray(r?.perfis) ? r.perfis.map((p: unknown) => String(p)) : [];
  const perfis = perfisArr.join(", ").toLowerCase(); // "cliente, fornecedor" — substring da linha 1
  const documento = String(r?.documento ?? "").trim();
  const externalRef = `ca:pessoas:${id}`;

  const quote = `Pessoa no Conta Azul: ${nome}${tipo ? ` (${tipo})` : ""}, perfis: ${perfis || "n/d"}`;
  const linha1 = `${quote}.${documento ? ` Documento: ${documento}.` : ""}`;
  const linha2 =
    `Registro Conta Azul ${externalRef}` +
    ` (criado em ${dateOnly(r?.data_criacao) || "n/d"}` +
    `${r?.data_alteracao ? `, alterado em ${r.data_alteracao}` : ""}).`;
  const body = `${linha1}\n${linha2}`;

  const title = `Pessoa: ${nome}`;

  const claim: ErpClaim = {
    text: `${nome} cadastrado no Conta Azul${perfis ? ` como ${perfis}` : ""}`,
    entity: slugify(nome),
    predicate: "perfil",
    value: perfis,
    value_num: null,
    unit: "",
    period: "",
    tier: "",
    valid_from: date,
    context_quote: quote,
  };

  return { externalRef, title, date, body, dimension: "pessoas", claims: [claim] };
}

/** A RECEITA da fonte (DADO — jsonb; ADR-016). Financeiro ⇒ sensibilidade 'restrito'.
 *  SEM guidance e SEM triage_profile: este caminho NÃO passa por prompt nem triagem LLM. */
export const CONTA_AZUL_RECIPE: SourceRecipe = {
  fields: [
    { dimension: "vendas", label: "venda realizada", area: "financeiro" },
    { dimension: "contas_a_pagar", label: "conta a pagar (despesa)", area: "financeiro" },
    { dimension: "contas_a_receber", label: "conta a receber (receita)", area: "financeiro" },
    { dimension: "pessoas", label: "cadastro de pessoa (cliente/fornecedor)", area: "financeiro" },
  ],
};

/** Factory PURA da fonte (sem IO) — usada pelo seed e pelo handler do seam (§4). id determinístico. */
function contaAzulSourceRow(): SourceRow {
  return {
    id: "conta-azul", // determinístico (id é text PK; o seed precisa ser re-executável)
    name: "Conta Azul (ERP)",
    channel: "conta-azul", // texto/DADO → vira tag canal:conta-azul (mecanismo M21 existente)
    type: "erp",
    recipe: CONTA_AZUL_RECIPE,
    default_sensitivity: "restrito", // financeiro → restrito (falha-fechado)
    status: "ativa",
    last_read_at: null,
  };
}

/** Seed idempotente da fonte (padrão M21: upsertSource on conflict (brain,id)). */
export async function seedContaAzulSource(brain: string): Promise<SourceRow> {
  const e = await getEngine(brain);
  const row = contaAzulSourceRow();
  await e.upsertSource(row);
  return (await e.getSource(row.id)) ?? row;
}

/** Resumo do applier (legível pro log/job/result). AJUSTE DO ÁRBITRO (seam do A §4.2-B/§4.3):
 *  idempotência por CONTEÚDO (external_id = `sl:<sha16(body)>`, UNIQUE da migração 28) — record
 *  ATUALIZADO ⇒ body novo ⇒ hash novo ⇒ página NOVA na MESMA série de fatos (tier); a antiga fica
 *  como evidência histórica (supersessão nos FATOS, não apagando página). Por isso NÃO há
 *  "paginasAtualizadas": update conta como paginasNovas. */
export interface ErpIngestResult {
  paginasNovas: number; // conteúdo inédito (inclui record ALTERADO — body novo)
  paginasInalteradas: number; // re-sync byte-idêntico → capture skipou (zero duplicata, LEI VI)
  claimsAprovados: number; // passaram o applyRecipeGate → fato carimbado
  claimsParaRevisao: number; // hipóteses na fila (galeed_ingest_review)
  descartados: number; // records ilegíveis (com log do motivo)
  slugs: string[];
}

/** APPLIER determinístico (IO, ZERO LLM): páginas normalizadas → motor, via API pública.
 *  Fail-closed: fonte inexistente / pausada → Error legível em PT. Algoritmo: §8 da DESIGN-SPEC. */
export async function ingestContaAzulPages(
  brain: string,
  sourceId: string,
  pages: NormalizedErpPage[],
): Promise<ErpIngestResult> {
  const e = await getEngine(brain);
  const source = await e.getSource(sourceId);
  if (!source)
    throw new Error(
      "a fonte conta-azul não existe neste cérebro — rode o seed antes de sincronizar.",
    );
  if (source.status === "pausada")
    throw new Error(`a fonte "${source.name}" está pausada — retome a leitura pra ingerir.`);

  // tags do CONTRATO (MESMA convenção do processBlobJob:118-126)
  const tags = [
    `src:${source.id}`,
    ...(source.channel?.trim() ? [`canal:${slugify(source.channel)}`] : []),
    ...[...new Set(source.recipe.fields.map((f) => (f.area || "").trim()).filter(Boolean))].map(
      (a) => `area:${slugify(a)}`,
    ),
  ];

  let paginasNovas = 0;
  let paginasInalteradas = 0;
  let claimsAprovados = 0;
  let claimsParaRevisao = 0;
  const slugsTocados: string[] = [];

  for (const p of pages) {
    const cap = await capture({
      home: brain,
      text: p.body,
      type: source.type,
      title: p.title,
      date: p.date,
      source: "connector", // pista de mecanismo (como "paste"/"upload") — nunca ramo
      externalId: `sl:${sha16(p.body)}`, // idempotência por CONTEÚDO (P1-D / migração 28)
      tags,
      sensitivity: source.default_sensitivity,
    });
    if (cap.skipped) {
      paginasInalteradas++;
      continue; // re-sync byte-idêntico: nada mudou
    }
    paginasNovas++;
    const slug = cap.slug;
    slugsTocados.push(slug);

    // o capture grava o body como text.trim() + "\n" (capture.ts:69) — usar ESSE body no gate
    const pageBody = p.body.trim() + "\n";
    const gate = applyRecipeGate(
      { [p.dimension]: p.claims },
      source.recipe,
      source.id,
      slug,
      pageBody,
    );
    // C2 — review.pending (gancho da regra de ouro, fail-soft).
    if (gate.rejected.length) await addReviewItemsAndNotify(brain, gate.rejected);
    claimsAprovados += gate.counts.approved;
    claimsParaRevisao += gate.counts.rejected;
    console.log(
      `[recipe-gate] brain=${brain} page=${slug} approved=${gate.counts.approved} rejected=${gate.counts.rejected} source=conta-azul`,
    );

    await e.putExtraction({
      source_slug: slug,
      type: source.type,
      date: p.date,
      content_hash: sha16(p.body),
      prompt_version: "conta-azul-deterministic-v1",
      extractions: gate.approved,
    });
    await e.markExtracted(slug, "conta-azul-deterministic-v1");
  }

  if (slugsTocados.length) await deriveIncremental(brain, slugsTocados); // M14 — supersessão por série
  await e.touchSourceRead(source.id); // M21 — last_read_at

  return {
    paginasNovas,
    paginasInalteradas,
    claimsAprovados,
    claimsParaRevisao,
    descartados: 0,
    slugs: slugsTocados,
  };
}

/** Conveniência (prova direta do slot + caminho manual/CLI): blob verbatim do lote (proveniência,
 *  LEI I) + normaliza + aplica. */
export async function ingestContaAzulBatch(
  brain: string,
  sourceId: string,
  batch: ContaAzulBatch,
): Promise<ErpIngestResult> {
  // original VERBATIM no blob (proveniência LEI I; idempotente por hash)
  await putBlobOnly(brain, Buffer.from(JSON.stringify(batch.records)), {
    contentType: "application/json",
    filename: `conta-azul-${batch.model}.json`,
    source: "connector",
  });
  const { pages, descartados } = normalizeContaAzulBatch(batch);
  for (const d of descartados)
    console.log(`[conta-azul] descartado: ${d.motivo}`); // invariante #5 — nunca silencioso
  const res = await ingestContaAzulPages(brain, sourceId, pages);
  return { ...res, descartados: descartados.length };
}

/** Map model do Nango (PascalCase do models.ts) → ContaAzulModel (dimensão da receita). */
const NANGO_MODEL_TO_DIMENSION: Record<string, ContaAzulModel> = {
  Venda: "vendas",
  ContaAPagar: "contas_a_pagar",
  ContaAReceber: "contas_a_receber",
  Pessoa: "pessoas",
};

/** O HANDLER do seam (ADJUDICADO pelo árbitro — M22-A-DESIGN-SPEC §4.4 é o canônico).
 *  Estruturalmente compatível com `ConnectorHandler` do M22-A SEM importá-lo (worktrees
 *  paralelas): no reconcile o Integrador registra com `registerConnectorHandler(contaAzulConnector)`
 *  (1 linha) e o caminho de PRODUÇÃO vira webhook → normalize → deliverConnectorPayload (caminho B
 *  do seam: claims determinísticos, zero LLM). */
export const contaAzulConnector = {
  providerConfigKey: "conta-azul" as const,
  sourceSeed() {
    const row = contaAzulSourceRow();
    return {
      id: row.id as "conta-azul",
      name: row.name,
      channel: row.channel as "conta-azul",
      type: row.type as "erp",
      recipe: row.recipe,
      default_sensitivity: row.default_sensitivity as "restrito",
    };
  },
  /** mapeia ctx.model (nome do Model no Nango) → dimensão, normaliza 1 record e converte cada
   *  NormalizedErpPage no payload do seam (ConnectorPayload + ConnectorClaim do A §4.1). Model
   *  desconhecido → [] (o webhook do A loga). */
  normalize(record: unknown, ctx: { sourceId: string; model: string }): unknown[] {
    const dimension = NANGO_MODEL_TO_DIMENSION[ctx.model];
    if (!dimension) return [];
    const { pages } = normalizeContaAzulBatch({ model: dimension, records: [record] });
    return pages.map((page) => ({
      sourceId: ctx.sourceId,
      content: page.body,
      contentType: "text/plain" as const,
      timestamp: page.date, // YYYY-MM-DD (parseia ISO) — data do EVENTO
      externalRef: page.externalRef,
      title: page.title,
      claims: page.claims.map((c) => ({ dimension: page.dimension, ...c })),
    }));
  },
};
