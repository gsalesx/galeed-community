/** P0 (#2/#5/#11) — clientIp() NÃO pode confiar no valor MAIS À ESQUERDA do X-Forwarded-For.
 *  Sob TRUST_PROXY=1 (topologia que o próprio rate-limit assume) o proxy reverso (nginx
 *  `proxy_add_x_forwarded_for`, Caddy, ALB) *apenda* o IP real do cliente à DIREITA. O leftmost é
 *  controlado pelo atacante: se a chave do rate-limit usasse o leftmost, bastava mandar
 *  `X-Forwarded-For: <ip aleatório>` a cada request para rotacionar a janela e anular TODO o
 *  rate-limit P0 — re-expondo scrypt em /auth/login (brute-force), mass-signup em /auth/signup e
 *  burn de LLM em /api/ask. O fix lê o RIGHTMOST (último hop confiável). Este teste trava isso. */
import { describe, it, expect, afterEach } from "vitest";
import type { IncomingMessage } from "node:http";
import { clientIp } from "../../src/connectors/web-server.ts";

const ORIGINAL_TRUST_PROXY = process.env.TRUST_PROXY;

function mockReq(headers: Record<string, string | undefined>, remoteAddress?: string): IncomingMessage {
  return { headers, socket: { remoteAddress } } as unknown as IncomingMessage;
}

afterEach(() => {
  // restaura o env exatamente como estava (não vaza TRUST_PROXY entre testes)
  if (ORIGINAL_TRUST_PROXY === undefined) delete process.env.TRUST_PROXY;
  else process.env.TRUST_PROXY = ORIGINAL_TRUST_PROXY;
});

describe("clientIp — anti-spoof de X-Forwarded-For (rightmost = último hop confiável)", () => {
  it("(1) sob TRUST_PROXY=1 pega o RIGHTMOST (IP real apendado pelo proxy), nunca o leftmost forjado", () => {
    process.env.TRUST_PROXY = "1";
    const req = mockReq({ "x-forwarded-for": "1.2.3.4, 9.9.9.9" }, "10.0.0.1");
    expect(clientIp(req)).toBe("9.9.9.9");
    expect(clientIp(req)).not.toBe("1.2.3.4"); // valor forjado pelo cliente
  });

  it("(2) atacante forjando vários IPs à esquerda NÃO muda a chave do balde", () => {
    process.env.TRUST_PROXY = "1";
    const req = mockReq({ "x-forwarded-for": "a, b, c, 9.9.9.9" }, "10.0.0.1");
    expect(clientIp(req)).toBe("9.9.9.9");
  });

  it("(3) SEM TRUST_PROXY ignora o XFF e cai no socket.remoteAddress", () => {
    delete process.env.TRUST_PROXY;
    const req = mockReq({ "x-forwarded-for": "1.2.3.4, 9.9.9.9" }, "10.0.0.1");
    expect(clientIp(req)).toBe("10.0.0.1");
  });

  it("(4) header ausente com TRUST_PROXY=1 cai no socket.remoteAddress", () => {
    process.env.TRUST_PROXY = "1";
    const req = mockReq({}, "10.0.0.1");
    expect(clientIp(req)).toBe("10.0.0.1");
  });
});
