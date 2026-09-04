// M-PAY-E / M-PAY-H (Onda 5) — emissão de NFS-e via Spedy (provedor fiscal BR). SEAM fail-soft,
// GATEADO por SPEDY_API_TOKEN: sem token = no-op (registra 'skipped'). NUNCA derruba o webhook de
// billing — roda FORA da transação do billing (side-effect externo) e NUNCA lança. Idempotente por
// `eventId` (1 NFS-e por invoice.paid; reprocesso → no-op). Retorna o status final para o chamador
// observar (o webhook ignora o retorno; testes asseguram o contrato).
//
// ── ENV NECESSÁRIA (config fiscal da empresa; sem ela o seam fica em no-op 'skipped') ─────────────
//   SPEDY_API_TOKEN              token da conta Spedy (plano Avançado). VAZIO = seam desligado.
//   SPEDY_API_BASE               base URL da API (default https://api.spedy.com.br). Sem barra final.
//   SPEDY_FEDERAL_SERVICE_CODE   item da lista LC 116/03 (código federal do serviço prestado).
//   SPEDY_CITY_SERVICE_CODE      código municipal do serviço (varia por município do prestador).
//   SPEDY_CNAE_CODE              CNAE da atividade.
//   SPEDY_ISS_RATE               alíquota de ISS (ex.: 0.02 = 2%). Regime Simples define o tratamento.
//   (+ pré-requisitos fora do código: e-CNPJ A1 instalado na conta Spedy e inscrição municipal ativa.)
// Espelhado no docs/DEPLOY.md (seção NFS-e). Até a conta estar provisionada, mantenha
// SPEDY_API_TOKEN vazio (no-op). Alternativa de menor esforço = o conector nativo Stripe↔Spedy no
// painel (Caminho A), sem este código.
//
// ⚠️ CONTRATO A CONFIRMAR: a doc técnica da Spedy (docs.spedy.com.br) está atrás de login (403). O
// endpoint (POST /invoices), o sandbox e o shape do payload de NFS-e vêm da pesquisa; o HEADER de
// auth exato, a BASE URL e o schema completo precisam ser confirmados na conta paga (plano Avançado).
import { getSharedSql, sharedSqlGeneration } from "./db-conn.ts";

// Espelhado na migration 42. Rastreia 1 emissão por invoice.paid (idempotência) + status.
export const NFSE_DDL = `
  create table if not exists galeed_nfse_emissions (
    event_id     text primary key,
    account_id   text,
    status       text not null,
    provider_id  text,
    amount_cents bigint,
    error        text,
    created_at   timestamptz not null default now()
  );
`;

let _ready: Promise<void> | null = null;
let _gen = -1;
async function db(): Promise<any> {
  const sql = await getSharedSql();
  const gen = sharedSqlGeneration();
  if (!_ready || _gen !== gen) {
    _gen = gen;
    _ready = sql.unsafe(NFSE_DDL);
  }
  await _ready;
  return sql;
}

export function spedyEnabled(): boolean {
  return !!process.env.SPEDY_API_TOKEN;
}

export interface NfseInput {
  eventId: string; // idempotência (1 NFS-e por invoice.paid)
  accountId: string | null;
  amountCents: number;
  description: string;
  receiver?: { name?: string; taxId?: string; email?: string };
}

// Status final da tentativa. 'duplicate' = evento já reivindicado (reprocesso); 'skipped' = seam
// desligado (sem token); 'requested' = POST aceito pela Spedy; 'error' = falha (fail-soft, não lança).
export type NfseStatus = "skipped" | "requested" | "error" | "duplicate";
export interface NfseResult {
  status: NfseStatus;
}

/** Emite a NFS-e (fail-soft, idempotente por eventId). NUNCA lança — retorna o status final. */
export async function emitNfse(input: NfseInput): Promise<NfseResult> {
  // Contrato de input: eventId é a chave de idempotência e é obrigatório. Sem ele não há como
  // dedup-ar nem rastrear — degrada para 'error' (fail-soft) em vez de inserir lixo no rastro.
  if (!input?.eventId) {
    console.warn("[nfse] emitNfse sem eventId — ignorado (fail-soft)");
    return { status: "error" };
  }
  const amountCents = Number.isFinite(input.amountCents) ? Math.max(0, Math.trunc(input.amountCents)) : 0;
  try {
    const sql = await db();
    // idempotência: reivindica o evento; reprocesso → no-op.
    const claim = (await sql`
      insert into galeed_nfse_emissions (event_id, account_id, status, amount_cents)
      values (${input.eventId}, ${input.accountId ?? null}, 'pending', ${amountCents})
      on conflict (event_id) do nothing returning event_id
    `) as any[];
    if (claim.length === 0) return { status: "duplicate" };

    if (!spedyEnabled()) {
      await sql`update galeed_nfse_emissions set status = 'skipped', error = 'SPEDY_API_TOKEN ausente' where event_id = ${input.eventId}`;
      return { status: "skipped" };
    }

    // Chamada à Spedy — CONTRATO A CONFIRMAR (ver topo). Payload conforme a pesquisa.
    const baseUrl = (process.env.SPEDY_API_BASE || "https://api.spedy.com.br").replace(/\/+$/, "");
    const res = await fetch(`${baseUrl}/invoices`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.SPEDY_API_TOKEN}` },
      body: JSON.stringify({
        description: input.description,
        federalServiceCode: process.env.SPEDY_FEDERAL_SERVICE_CODE, // item LC 116/03 (config fiscal)
        cityServiceCode: process.env.SPEDY_CITY_SERVICE_CODE,
        cnaeCode: process.env.SPEDY_CNAE_CODE,
        receiver: {
          name: input.receiver?.name,
          federalTaxNumber: input.receiver?.taxId, // CPF/CNPJ do tomador
          email: input.receiver?.email,
        },
        total: { invoiceAmount: amountCents / 100, issRate: Number(process.env.SPEDY_ISS_RATE || 0) },
      }),
    });
    if (!res.ok) {
      await sql`update galeed_nfse_emissions set status = 'failed', error = ${`HTTP ${res.status}`} where event_id = ${input.eventId}`;
      console.warn(`[nfse] Spedy respondeu ${res.status} (event ${input.eventId})`);
      return { status: "error" };
    }
    const body = (await res.json().catch(() => ({}))) as any;
    await sql`update galeed_nfse_emissions set status = 'requested', provider_id = ${body?.id ?? null} where event_id = ${input.eventId}`;
    console.log(`[nfse] NFS-e solicitada à Spedy (event ${input.eventId})`);
    return { status: "requested" };
  } catch (e) {
    console.warn(`[nfse] emitNfse erro (fail-soft) event ${input.eventId}:`, e instanceof Error ? e.message : e);
    // fail-soft: tenta marcar 'error' no rastro, mas mesmo isso não pode lançar.
    try {
      const sql = await db();
      await sql`update galeed_nfse_emissions set status = 'error', error = ${e instanceof Error ? e.message : String(e)} where event_id = ${input.eventId}`;
    } catch {
      /* o próprio rastro indisponível — só loga acima */
    }
    return { status: "error" };
  }
}
