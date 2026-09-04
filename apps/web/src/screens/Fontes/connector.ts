/** M22-D — lógica PURA do estado de conexão dos conectores (sem React/DOM/fetch).
 *  Contrato externo: Nango connect sessions — token/connect_link/expires_at
 *  (https://nango.dev/docs/reference/api/connect/sessions/create). Estado SEMPRE derivado
 *  do que o BFF devolveu (LEI 1 do pacote): nada aqui inventa estado. */
import type { ConnectorState, Source } from "./types";

/** Providers HABILITADOS no catálogo (apresentação; a chave viaja opaca pro BFF).
 *  Chaves cravadas pelo árbitro (= providerConfigKey do A §4.4): "conta-azul" (Conta Azul) e
 *  "google-mail" (Gmail — https://github.com/NangoHQ/integration-templates/tree/main/integrations/google-mail). */
export interface ProviderCard {
  provider: string;        // chave no Nango (corpo do POST /api/sources/connector)
  nome: string;            // rótulo do card ("Conta Azul" | "E-mail")
  tag: string;             // tag do rodapé do card ("financeiro" | "conversas")
}
export const PROVIDERS: readonly ProviderCard[] = [
  { provider: "conta-azul", nome: "Conta Azul", tag: "financeiro" },
  { provider: "google-mail", nome: "E-mail", tag: "conversas" },
];
// "conta-azul" ADJUDICADO pelo árbitro: o integration-id no Nango é ESCOLHIDO POR NÓS ao criar
// a integração na conta (a chave do catálogo só sugere o default) — cravamos "conta-azul" em
// A/B/D. "google-mail" é a key oficial do template (M22-C §2).

/** MERGE client-side (LEI 1/§2.3): devolve as sources com `connector` populado a partir do
 *  GET /api/connectors/status (match por source_id; sem linha → connector ausente). PURA. */
export function anexarEstadoConector(
  sources: readonly Source[],
  status: readonly (ConnectorState & { source_id: string })[],
): Source[] {
  const porId = new Map<string, ConnectorState>();
  for (const row of status) {
    const { source_id, ...estado } = row;
    porId.set(source_id, estado);
  }
  return sources.map((s) => {
    const estado = porId.get(s.id);
    if (!estado) return s;
    return { ...s, connector: estado };
  });
}

/** Estado EXIBÍVEL da fonte-conector. Precedência (nesta ordem):
 *  pausada (status da fonte) > aguardando (connect_link aberto nesta sessão de tela e o banco
 *  ainda diz desconectado) > status do connector_state. Fonte sem connector → null (não é conector). */
export type EstadoConexao = "conectada" | "desconectada" | "pausada" | "erro" | "aguardando";
export function estadoDaConexao(s: Source, aguardando = false): EstadoConexao | null {
  if (!s.connector) return null;
  if (s.status === "pausada") return "pausada";
  if (aguardando && s.connector.status === "desconectado") return "aguardando";
  if (s.connector.status === "conectado") return "conectada";
  if (s.connector.status === "erro") return "erro";
  return "desconectada";
}

/** Rótulos EXATOS em PT (a UI usa SÓ estes). */
const ROTULOS: Record<EstadoConexao, string> = {
  conectada: "Conectada",
  desconectada: "Desconectada",
  pausada: "Pausada",
  erro: "Erro na conexão",
  aguardando: "Aguardando conexão…",
};
export function rotuloDoEstado(e: EstadoConexao): string {
  return ROTULOS[e];
}

/** Fonte-conector do provider neste brain (ou undefined). Match por connector.provider. */
export function fonteDoProvider(sources: readonly Source[], provider: string): Source | undefined {
  return sources.find((s) => s.connector?.provider === provider);
}

/** "última sincronização <relativo>" | "nunca sincronizou" (caller passa o formatador
 *  relativeTime de lib/format pra função ficar pura/testável com injeção). */
export function descricaoDaSync(
  c: ConnectorState | null | undefined,
  rel: (iso: string) => string,
): string {
  if (!c || !c.last_sync_at) return "nunca sincronizou";
  return "última sincronização " + rel(c.last_sync_at);
}

/** Erro legível: connector.last_error se houver; status erro sem mensagem →
 *  "a conexão falhou — reconecte."; senão null. */
export function erroLegivel(c: ConnectorState | null | undefined): string | null {
  if (!c) return null;
  if (c.last_error) return c.last_error;
  if (c.status === "erro") return "a conexão falhou — reconecte.";
  return null;
}

/** true ⇔ a fonte tem estado de conector mesclado (s.connector != null) — ADJUDICADO §2.3:
 *  channel é o do seed ("conta-azul"/"gmail"), NUNCA o discriminador. */
export function ehConector(s: Source): boolean {
  return s.connector != null;
}
