/** Bots internos: token fica no backend; não aparecem em Acesso/Chaves. */
export const SYSTEM_PRINCIPAL_IDS = new Set(["agent-whatsapp-evolution"]);

export function isSystemPrincipal(id: string, label?: string): boolean {
  return SYSTEM_PRINCIPAL_IDS.has(id) || label === "WhatsApp (Evolution)";
}
