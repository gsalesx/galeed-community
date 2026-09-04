/** Galeed C1 — assinatura HMAC dos webhooks de SAÍDA (entrega push por brain).
 *
 *  Espelha o idioma de verifyNangoWebhook (src/lib/nango.ts:51-71): HMAC-SHA256 hex sobre o RAW body,
 *  comparação via crypto.timingSafeEqual (NUNCA ===) com guarda de comprimento. Aqui o lado é o oposto:
 *  o Galeed é quem ASSINA (somos o emissor); o cliente VERIFICA do lado dele.
 *
 *  HEADER: cada POST de webhook leva `X-Galeed-Signature: <hex>` — o HMAC-SHA256 do corpo exato
 *  enviado, com a secret CRUA do webhook (a mesma `secret` mostrada UMA vez ao cliente no registro;
 *  guardada em galeed_webhooks.secret só para o worker assinar; a listagem NUNCA a devolve).
 *
 *  O CLIENTE VERIFICA assim (recomende isto na doc do registro): recompute o HMAC-SHA256 hex do raw
 *  body recebido com a secret mostrada no registro e compare com X-Galeed-Signature em tempo constante.
 *  Bater ⇒ o evento veio mesmo do Galeed e não foi adulterado. verifyWebhookBody abaixo é exatamente
 *  essa rotina (útil em testes e se o cliente também rodar Node). */
import { createHmac, timingSafeEqual } from "node:crypto";

/** Assina o corpo cru de um webhook: HMAC-SHA256 hex (idioma do nango.ts). Vai no header
 *  X-Galeed-Signature. O worker chama isto na entrega usando galeed_webhooks.secret do brain. */
export function signWebhookBody(rawBody: string, secret: string): string {
  return createHmac("sha256", secret).update(Buffer.from(rawBody, "utf8")).digest("hex");
}

/** Verifica X-Galeed-Signature contra o corpo cru e a secret (timingSafeEqual; comprimentos
 *  diferentes ⇒ false sem throw — assinatura forjada de tamanho diferente nunca derruba nada). */
export function verifyWebhookBody(rawBody: string, signature: string, secret: string): boolean {
  if (!signature) return false;
  const expected = signWebhookBody(rawBody, secret);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
