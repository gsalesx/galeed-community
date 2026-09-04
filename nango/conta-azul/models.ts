/** M22-B — modelos zod dos shapes OFICIAIS da Conta Azul (§2.1 da DESIGN-SPEC). Campos extras:
 *  .passthrough() — o shape oficial pode crescer sem quebrar. Cada modelo cita a URL da doc. */
import { z } from "zod";

/** Shape oficial GET /v1/venda/busca — https://developers.contaazul.com/docs/sales-apis-openapi/v1/searchvendas.md */
export const Venda = z
  .object({
    id: z.string(), // uuid NOVO (chave de external_ref — LEI VI)
    numero: z.number(),
    total: z.number(),
    data: z.string(), // "2023-12-31" — data do EVENTO
    data_alteracao: z.string(), // ISO 8601 SP/GMT-3 — cursor incremental
    id_legado: z.number().optional(), // compat — NUNCA chave
    situacao: z.object({ nome: z.string() }).passthrough().optional(),
    cliente: z.object({ id: z.string().optional(), nome: z.string() }).passthrough().optional(),
  })
  .passthrough();

/** Shape oficial …/contas-a-pagar/buscar — https://developers.contaazul.com/docs/financial-apis-openapi/v1/searchinstallmentstopaybyfilter.md */
export const ContaAPagar = z
  .object({
    id: z.string(),
    descricao: z.string().optional(),
    data_vencimento: z.string(),
    data_competencia: z.string().optional(),
    status: z.string().optional(),
    status_traduzido: z.string().optional(),
    total: z.number(),
    nao_pago: z.number().optional(),
    pago: z.number().optional(),
    data_alteracao: z.string(),
    fornecedor: z.object({ id: z.string().optional(), nome: z.string() }).passthrough().optional(),
    categorias: z.array(z.object({ id: z.string().optional(), nome: z.string() }).passthrough()).optional(),
  })
  .passthrough();

/** Shape oficial …/contas-a-receber/buscar — https://developers.contaazul.com/docs/financial-apis-openapi/v1/searchinstallmentstoreceivebyfilter.md */
export const ContaAReceber = z
  .object({
    id: z.string(),
    descricao: z.string().optional(),
    data_vencimento: z.string(),
    data_competencia: z.string().optional(),
    status: z.string().optional(),
    status_traduzido: z.string().optional(),
    total: z.number(),
    nao_pago: z.number().optional(),
    pago: z.number().optional(),
    data_alteracao: z.string(),
    cliente: z.object({ id: z.string().optional(), nome: z.string() }).passthrough().optional(),
    categorias: z.array(z.object({ id: z.string().optional(), nome: z.string() }).passthrough()).optional(),
  })
  .passthrough();

/** Shape oficial GET /v1/pessoas — https://developers.contaazul.com/open-api-docs/open-api-person/v1/retornapessoasporfiltros.md */
export const Pessoa = z
  .object({
    id: z.string(),
    nome: z.string(),
    perfis: z.array(z.string()).optional(), // ex.: ["CLIENTE","FORNECEDOR"]
    tipo_pessoa: z.string().optional(), // "FISICA"|"JURIDICA"|"ESTRANGEIRA"
    documento: z.string().optional(),
    data_criacao: z.string().optional(),
    data_alteracao: z.string(),
    id_legado: z.number().optional(), // compat — NUNCA chave
    uuid_legado: z.string().optional(), // compat — NUNCA chave
  })
  .passthrough();
