/** Boot idempotente dos ingestores de fábrica (espelha connector-registry-boot.ts).
 *  Chamado por quem sobe processo com a rota/listagem (gateway e BFF).
 *
 *  ALUNO: criou um ingestor novo? Importe e registre AQUI (1 linha) — ver INGESTORES.md. */
import { registerIngestor } from "./registry.ts";
import { textoIngestor } from "./texto.ts";
import { evolutionWhatsappIngestor } from "./evolution-whatsapp.ts";
import { notetakerIngestor } from "./notetaker.ts";
import { planilhaIngestor } from "./planilha.ts";
import { formularioIngestor } from "./formulario.ts";
import { chatIngestor } from "./chat.ts";
import { chatwootIngestor } from "./chatwoot.ts";

let _booted = false;

export function registerBuiltinIngestors(): void {
  if (_booted) return;
  registerIngestor(textoIngestor);
  registerIngestor(evolutionWhatsappIngestor);
  registerIngestor(notetakerIngestor);
  registerIngestor(planilhaIngestor);
  registerIngestor(formularioIngestor);
  registerIngestor(chatIngestor);
  registerIngestor(chatwootIngestor);
  _booted = true;
}
