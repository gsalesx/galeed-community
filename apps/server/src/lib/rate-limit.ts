/** Limitador de taxa em memória (janela fixa por chave). Zero-dep, suficiente p/ uma instância.
 *
 *  P1 (multi-instância em prod): este store é POR-PROCESSO — atrás de N réplicas, cada uma conta
 *  isolada e o limite efetivo vira N×max. Pra valer global o store deve virar COMPARTILHADO (Redis
 *  com INCR+EXPIR, ou um middleware de gateway). Aqui basta pra barrar brute-force/abuso numa box. */

type Bucket = { count: number; resetAt: number };

const store = new Map<string, Bucket>();

/** Conta um hit em `key` numa janela fixa de `windowMs`. Retorna se passou e, se não, em quantos
 *  segundos a janela reseta (Retry-After). Limpa buckets expirados de forma preguiçosa no acesso. */
export function rateLimit(key: string, max: number, windowMs: number): { ok: boolean; retryAfter: number } {
  const now = Date.now();
  const b = store.get(key);
  if (!b || now >= b.resetAt) {
    store.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, retryAfter: 0 };
  }
  if (b.count >= max) {
    return { ok: false, retryAfter: Math.max(1, Math.ceil((b.resetAt - now) / 1000)) };
  }
  b.count += 1;
  return { ok: true, retryAfter: 0 };
}
