/** M21/S5 — tipos LOCAIS da tela Fontes (espelham o HTTP do S3, nomes EXATOS).
 *  Shapes idênticos aos de `lib/api.ts` (SourceRow/HypothesisView do BFF) — locais
 *  pra tela não alargar tipo compartilhado (regra do slot). */

export interface SourceRecipeField { dimension: string; label: string; area: string }
export interface SourceRecipe { fields: SourceRecipeField[]; guidance?: string; triage_profile?: string }

/** M22-D — estado da conexão do conector (espelha SourceConnectionView do M22-A §4.5,
 *  migração 29; nunca vem do /api/sources — é MESCLADO client-side via GET /api/connectors/status). */
export type ConnectorStatus = "desconectado" | "conectado" | "erro";
export interface ConnectorState {
  provider: string;
  connection_id: string | null;
  status: ConnectorStatus;
  last_sync_at: string | null;
  last_error: string | null;
}

/** Resposta de POST /api/sources/:id/connect (espelha data de POST /connect/sessions do Nango —
 *  https://nango.dev/docs/reference/api/connect/sessions/create ; expira em 30 min). */
export interface ConnectStart {
  provider: string;
  token: string;
  connect_link: string;
  expires_at: string;
}

/** Resposta de GET /api/connectors/status (espelha SourceConnectionView do A §4.5). */
export interface ConnectorStatusRow extends ConnectorState { source_id: string }
export interface ConnectorsStatus { sources: ConnectorStatusRow[] }

export interface Source {
  id: string; name: string;
  /** "upload" | "paste" para fontes manuais; fontes-conector chegam com o channel do SEED
   *  ("conta-azul"/"gmail" — M22-A §2.3); o union literal vira aberto sem perder autocomplete. */
  channel: "upload" | "paste" | (string & {});
  type: string;
  recipe: SourceRecipe; default_sensitivity: string; status: "ativa" | "pausada";
  last_read_at: string | null; created_at?: string;
  pages_count?: number; facts_count?: number;
  /** M22-D — populado pelo MERGE client-side (anexarEstadoConector); nunca vem do /api/sources. */
  connector?: ConnectorState | null;
}
export interface HypothesesCount { pendente: number; aprovada: number; descartada: number }
