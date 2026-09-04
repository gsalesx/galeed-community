/** M10 — tipos comuns aos handlers do BFF (zona neutra). Uma ÚNICA definição de `BffError` que os
 *  slots (bff-m9.ts / bff-rbac-write.ts) importam; o web-server.ts a trata no catch via `instanceof`.
 *  Mantém `.code` (status HTTP) e `.message` — o catch traduz pra `send(res, code, { error })`. */
export class BffError extends Error {
  constructor(
    public code: number,
    message: string,
  ) {
    super(message);
    this.name = "BffError";
  }
}
