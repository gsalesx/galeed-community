/** M7/R16 — política de ingestão por CANAL: o que entra por um canal nasce já classificado
 *  (área + sensibilidade default), sem passo manual e sem LLM. Falha fechado: canal desconhecido
 *  → sem área + 'restrito'. O `source` é a pista que o webhook/connector passa ao capture
 *  (whatsapp, notetaker, email, zapier, upload, …) — o MESMO `source` que já vira a tag `fonte:<source>`. */

export interface ChannelPolicy {
  area: string;        // slug de área (ex.: "produto", "suporte"). "" = sem área.
  sensitivity: string; // um SENSITIVITY_LEVEL (publico|interno|sensivel|restrito).
}

/** Registro default canal→política. Vazio por padrão (o dono configura por canal via S5/S4 depois).
 *  Mantido como constante pra o v1 ser determinístico e auditável; promover a tabela por-brain é
 *  decisão futura (quando houver UI/config por tenant). */
export const CHANNEL_POLICY: Record<string, ChannelPolicy> = {
  // exemplos comentados — o registro nasce VAZIO; canal não-mapeado = fail-closed.
  // suporte:   { area: "suporte", sensitivity: "interno" },
  // notetaker: { area: "reunioes", sensitivity: "interno" },
};

/** Política fail-closed pra canal desconhecido / ausente. */
export const DEFAULT_CHANNEL_POLICY: ChannelPolicy = { area: "", sensitivity: "restrito" };

/** resolve a política de um `source`. Desconhecido/ausente → DEFAULT (sem área, 'restrito'). */
export function resolveChannel(source: string | undefined): ChannelPolicy {
  if (!source) return DEFAULT_CHANNEL_POLICY;
  return CHANNEL_POLICY[source.toLowerCase().trim()] ?? DEFAULT_CHANNEL_POLICY;
}
