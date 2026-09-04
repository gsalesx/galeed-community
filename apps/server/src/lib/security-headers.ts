/** ACHADO #8 (EXTRAÍDO de web-server.ts) — headers de segurança em TODA resposta (send JSON, SSE e
 *  estático). Aplicado no INÍCIO do handler via res.setHeader (antes do dispatch), então cobre os
 *  três caminhos de escrita. Reusável pelos servers HTTP (BFF, gateway /v1) sem duplicar. NÃO mexe
 *  em CORS.
 *
 *  HSTS SÓ em produção (mesmo gate do cookie Secure): em dev o front roda em HTTP. O gate `secure`
 *  vem de env no chamador (NODE_ENV === "production" || SECURE_COOKIES === "1") e é passado aqui. */
import type { ServerResponse } from "node:http";

export function applySecurityHeaders(res: ServerResponse, secure: boolean): void {
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self' data:",
  );
  if (secure) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
}
