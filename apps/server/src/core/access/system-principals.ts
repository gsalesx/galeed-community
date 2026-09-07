/** Principais de sistema: token existe no backend (webhook), mas não são agentes gerenciáveis. */
export const SYSTEM_PRINCIPAL_IDS = new Set(["agent-whatsapp-evolution"]);

export function isSystemPrincipal(id: string): boolean {
  return SYSTEM_PRINCIPAL_IDS.has(id);
}
