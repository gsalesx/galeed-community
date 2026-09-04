/** C1 — libs puras de webhook: guarda anti-SSRF + assinatura HMAC.
 *  Não toca rede: o lookup do DNS é INJETADO (validateOutboundUrl aceita um resolver fake). A entrega
 *  (deliverWebhook) é exercitada contra um http server de LOOPBACK (porta efêmera) sob o escape SÓ-TESTE. */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { validateOutboundUrl, deliverWebhook, type LookupAll } from "../../src/lib/ssrf-guard.ts";
import { signWebhookBody, verifyWebhookBody } from "../../src/lib/webhook-signature.ts";

/** Resolver fake: todo hostname resolve para os IPs dados (não chama a rede). */
function lookupReturning(...ips: string[]): LookupAll {
  return async () => ips.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
}
/** Resolver fake que falha (NXDOMAIN-like). */
const lookupFails: LookupAll = async () => {
  throw new Error("ENOTFOUND");
};

describe("C1 ssrf-guard — validateOutboundUrl", () => {
  it("ACEITA host público (DNS → 8.8.8.8)", async () => {
    const r = await validateOutboundUrl("https://hooks.cliente.com/galeed", lookupReturning("8.8.8.8"));
    expect(r.ok).toBe(true);
  });

  it("rejeita http:// (protocolo não-https)", async () => {
    const r = await validateOutboundUrl("http://hooks.cliente.com/galeed", lookupReturning("8.8.8.8"));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/https/);
  });

  it("rejeita hostname literal localhost", async () => {
    const r = await validateOutboundUrl("https://localhost/x", lookupReturning("8.8.8.8"));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/localhost/);
  });

  it("rejeita 127.0.0.1 (loopback) — IP literal e via DNS", async () => {
    const lit = await validateOutboundUrl("https://127.0.0.1/x", lookupReturning("8.8.8.8"));
    expect(lit.ok).toBe(false);
    const viaDns = await validateOutboundUrl("https://rebind.cliente.com/x", lookupReturning("127.0.0.1"));
    expect(viaDns.ok).toBe(false);
    expect(viaDns.reason).toMatch(/127\.0\.0\.1/);
  });

  it("rejeita 10.x (private)", async () => {
    const r = await validateOutboundUrl("https://10.0.0.5/x", lookupReturning("8.8.8.8"));
    expect(r.ok).toBe(false);
  });

  it("rejeita 172.16/12 e 192.168/16 (private)", async () => {
    expect((await validateOutboundUrl("https://172.16.3.4/x", lookupReturning("8.8.8.8"))).ok).toBe(false);
    expect((await validateOutboundUrl("https://192.168.1.1/x", lookupReturning("8.8.8.8"))).ok).toBe(false);
  });

  it("rejeita 169.254.169.254 (link-local / metadata da cloud)", async () => {
    const r = await validateOutboundUrl("https://169.254.169.254/latest/meta-data", lookupReturning("8.8.8.8"));
    expect(r.ok).toBe(false);
    // e via DNS rebinding para o mesmo IP
    const viaDns = await validateOutboundUrl("https://meta.evil.com/x", lookupReturning("169.254.169.254"));
    expect(viaDns.ok).toBe(false);
  });

  it("rejeita 0.0.0.0 (unspecified)", async () => {
    const r = await validateOutboundUrl("https://0.0.0.0/x", lookupReturning("8.8.8.8"));
    expect(r.ok).toBe(false);
  });

  it("rejeita ::1 (loopback IPv6, com colchetes)", async () => {
    const r = await validateOutboundUrl("https://[::1]/x", lookupReturning("8.8.8.8"));
    expect(r.ok).toBe(false);
  });

  it("rejeita fc00::/7 (unique-local) e fe80::/10 (link-local) IPv6", async () => {
    expect((await validateOutboundUrl("https://[fc00::1]/x", lookupReturning("8.8.8.8"))).ok).toBe(false);
    expect((await validateOutboundUrl("https://[fe80::1]/x", lookupReturning("8.8.8.8"))).ok).toBe(false);
  });

  it("rejeita IPv4 mapeado em IPv6 (::ffff:127.0.0.1) — não burla o loopback", async () => {
    const lit = await validateOutboundUrl("https://[::ffff:127.0.0.1]/x", lookupReturning("8.8.8.8"));
    expect(lit.ok).toBe(false);
    const viaDns = await validateOutboundUrl("https://map.evil.com/x", lookupReturning("::ffff:10.0.0.1"));
    expect(viaDns.ok).toBe(false);
  });

  it("rejeita se UM dos IPs resolvidos é interno (multi-record, fail-closed)", async () => {
    const r = await validateOutboundUrl("https://mix.cliente.com/x", lookupReturning("8.8.8.8", "127.0.0.1"));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/127\.0\.0\.1/);
  });

  it("rejeita quando o DNS falha (fail-closed)", async () => {
    const r = await validateOutboundUrl("https://nx.cliente.com/x", lookupFails);
    expect(r.ok).toBe(false);
  });

  it("rejeita URL malformada", async () => {
    const r = await validateOutboundUrl("not a url", lookupReturning("8.8.8.8"));
    expect(r.ok).toBe(false);
  });

  // ===== ACHADO 3 — IPv4 embutido em IPv6 (NAT64 / 6to4) contrabandeando interno =====
  it("ACHADO 3: rejeita NAT64 64:ff9b::7f00:1 (rfc6052 → embute 127.0.0.1)", async () => {
    // literal
    const lit = await validateOutboundUrl("https://[64:ff9b::7f00:1]/x", lookupReturning("8.8.8.8"));
    expect(lit.ok).toBe(false);
    expect(lit.reason).toMatch(/nat64|interna/i);
    // via DNS
    const viaDns = await validateOutboundUrl("https://nat64.evil.com/x", lookupReturning("64:ff9b::7f00:1"));
    expect(viaDns.ok).toBe(false);
  });

  it("ACHADO 3: rejeita 6to4 2002:7f00:1:: (embute 127.x interno)", async () => {
    const lit = await validateOutboundUrl("https://[2002:7f00:0001::]/x", lookupReturning("8.8.8.8"));
    expect(lit.ok).toBe(false);
    expect(lit.reason).toMatch(/6to4|interna/i);
    const viaDns = await validateOutboundUrl("https://sixtofour.evil.com/x", lookupReturning("2002:7f00:1::"));
    expect(viaDns.ok).toBe(false);
  });

  it("ACHADO 3: NAT64/6to4 que embute IP PÚBLICO segue OK (allowlist não é cega)", async () => {
    // 6to4 de 8.8.8.8 = 2002:0808:0808:: → embute 8.8.8.8 (público) → PASSA.
    const ok6to4 = await validateOutboundUrl("https://[2002:808:808::]/x", lookupReturning("9.9.9.9"));
    expect(ok6to4.ok).toBe(true);
    // NAT64 de 8.8.8.8 = 64:ff9b::0808:0808 → embute 8.8.8.8 → PASSA.
    const okNat64 = await validateOutboundUrl("https://[64:ff9b::808:808]/x", lookupReturning("9.9.9.9"));
    expect(okNat64.ok).toBe(true);
  });

  it("ALLOWLIST: rejeita faixas IPv4 não-unicast (ex.: 192.0.2.x TEST-NET = reserved, não unicast)", async () => {
    // a allowlist passa SÓ unicast; faixas reserved/documentação (192.0.2/24) reprovam por construção.
    const r = await validateOutboundUrl("https://192.0.2.10/x", lookupReturning("8.8.8.8"));
    expect(r.ok).toBe(false);
  });

  it("ACEITA IPv6 público unicast (ex.: 2606:4700:4700::1111)", async () => {
    const r = await validateOutboundUrl("https://[2606:4700:4700::1111]/x", lookupReturning("8.8.8.8"));
    expect(r.ok).toBe(true);
    expect(r.family).toBe(6);
  });

  // ===== ACHADO 1 — a guarda RETORNA o IP aprovado (para o pin da entrega) =====
  it("ACHADO 1: ok=true devolve { ip, family } do IP APROVADO (literal e via DNS)", async () => {
    const lit = await validateOutboundUrl("https://1.1.1.1/x", lookupReturning("8.8.8.8"));
    expect(lit.ok).toBe(true);
    expect(lit.ip).toBe("1.1.1.1");
    expect(lit.family).toBe(4);

    const viaDns = await validateOutboundUrl("https://hooks.cliente.com/x", lookupReturning("8.8.8.8"));
    expect(viaDns.ok).toBe(true);
    expect(viaDns.ip).toBe("8.8.8.8"); // o IP que a guarda escolheu/validou
    expect(viaDns.family).toBe(4);
  });

  it("ACHADO 1: multi-record com 1º interno reprova ANTES de aprovar qualquer IP", async () => {
    const r = await validateOutboundUrl("https://mix.cliente.com/x", lookupReturning("127.0.0.1", "8.8.8.8"));
    expect(r.ok).toBe(false);
    expect(r.ip).toBeUndefined();
  });
});

// ===== ACHADO 1 — anti DNS-REBINDING: a ENTREGA conecta no IP que a GUARDA aprovou (pin) =====
describe("C1 ssrf-guard — deliverWebhook PINA o socket no IP validado (anti-rebinding TOCTOU)", () => {
  let srv: Server;
  let port = 0;
  let lastBody = "";
  let lastHostHeader = "";

  beforeAll(async () => {
    srv = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c as Buffer));
      req.on("end", () => {
        lastBody = Buffer.concat(chunks).toString("utf8");
        lastHostHeader = String(req.headers["host"] ?? "");
        if (req.url === "/redir") {
          res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data" });
          res.end();
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", () => resolve()));
    const addr = srv.address();
    port = typeof addr === "object" && addr ? addr.port : 0;
  });

  afterAll(async () => {
    await new Promise<void>((r) => srv.close(() => r()));
  });

  it("a entrega conecta no IP que validateOutboundUrl APROVOU — NÃO numa re-resolução do DNS", async () => {
    // Resolver MALICIOSO de rebinding: PÚBLICO na 1ª chamada (validação), 127.0.0.1 na 2ª (conexão).
    // O ponto do achado: o pin usa o IP que a guarda aprovou (1ª = público), não a 2ª re-resolução.
    let calls = 0;
    const rebinding: LookupAll = async () => {
      calls += 1;
      // a 1ª resolução devolve um host público; QUALQUER chamada posterior devolveria 127.0.0.1.
      return calls === 1
        ? [{ address: "8.8.8.8", family: 4 }]
        : [{ address: "127.0.0.1", family: 4 }];
    };

    const guard = await validateOutboundUrl("https://hooks.cliente.com/x", rebinding);
    expect(guard.ok).toBe(true);
    expect(guard.ip).toBe("8.8.8.8"); // a guarda aprovou o PÚBLICO (1ª resolução), não a 2ª (privada)

    // A entrega usa uma URL com HOSTNAME (não IP literal) → o `lookup` pinado de node:http É exercitado.
    // Pinamos no loopback do servidor de teste (127.0.0.1) — em produção seria guard.ip (8.8.8.8). O que
    // o achado exige: o socket conecta no IP QUE LHE FOI PASSADO (o que a guarda aprovou), SEM jamais
    // re-resolver o DNS. Provamos por (a) onConnectIp = o IP pinado e (b) o resolver não foi chamado de novo.
    const callsBefore = calls;
    let connectedIp = "";
    const res = await deliverWebhook(`http://hooks.cliente.com:${port}/ok`, "127.0.0.1", 4, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hello: "pinned" }),
      onConnectIp: (ip) => {
        connectedIp = ip;
      },
    });
    expect(res.status).toBe(200);
    expect(connectedIp).toBe("127.0.0.1"); // o socket foi PINADO no IP passado (sem re-resolver o DNS)
    expect(lastHostHeader).toMatch(/hooks\.cliente\.com/); // Host header = hostname, não o IP pinado
    expect(calls).toBe(callsBefore); // o resolver do DNS NÃO foi chamado de novo na entrega (pin, não TOCTOU)
    expect(JSON.parse(lastBody)).toEqual({ hello: "pinned" });
  });

  it("se a guarda reprova (resolve privado), o worker NÃO conecta (guard.ok=false sem ip)", async () => {
    const privateResolver: LookupAll = async () => [{ address: "127.0.0.1", family: 4 }];
    const guard = await validateOutboundUrl("https://rebind.evil.com/x", privateResolver);
    expect(guard.ok).toBe(false);
    expect(guard.ip).toBeUndefined(); // sem IP aprovado → o worker marca dead e NÃO chama deliverWebhook
  });

  it("entrega NÃO segue 3xx (sem auto-redirect): 302 vira status 3xx (entrega não-confirmada)", async () => {
    const res = await deliverWebhook(`http://127.0.0.1:${port}/redir`, "127.0.0.1", 4, {
      method: "POST",
      body: "{}",
    });
    expect(res.status).toBe(302); // node:http NÃO segue → o worker classifica 3xx como dead
  });

  it("o Host header é o HOSTNAME (não o IP pinado) — cert/virtualhost corretos", async () => {
    await deliverWebhook(`http://127.0.0.1:${port}/ok`, "127.0.0.1", 4, { method: "POST", body: "{}" });
    expect(lastHostHeader).toMatch(/127\.0\.0\.1/); // host = hostname:port da URL, não um IP arbitrário
  });

  it("timeout: um destino que nunca responde rejeita (não prende o worker)", async () => {
    const slow = createServer(() => {
      /* nunca responde */
    });
    await new Promise<void>((r) => slow.listen(0, "127.0.0.1", () => r()));
    const a = slow.address();
    const sp = typeof a === "object" && a ? a.port : 0;
    await expect(
      deliverWebhook(`http://127.0.0.1:${sp}/hang`, "127.0.0.1", 4, { method: "POST", body: "{}", timeoutMs: 200 }),
    ).rejects.toThrow(/timeout/i);
    await new Promise<void>((r) => slow.close(() => r()));
  });
});

describe("C1 webhook-signature — sign/verify round-trip", () => {
  const secret = "whsec_galeed_c1_exemplo";
  const body = JSON.stringify({ event: "ingest.organized", brain: "accelera", ts: 1718200000 });

  it("assina e verifica (round-trip) com a mesma secret", () => {
    const sig = signWebhookBody(body, secret);
    expect(sig).toMatch(/^[0-9a-f]{64}$/); // hex sha256
    expect(verifyWebhookBody(body, sig, secret)).toBe(true);
  });

  it("rejeita assinatura ERRADA (corpo adulterado)", () => {
    const sig = signWebhookBody(body, secret);
    const tampered = body.replace("accelera", "outro-brain");
    expect(verifyWebhookBody(tampered, sig, secret)).toBe(false);
  });

  it("rejeita assinatura ERRADA (secret diferente)", () => {
    const sig = signWebhookBody(body, secret);
    expect(verifyWebhookBody(body, sig, "secret-errada")).toBe(false);
  });

  it("rejeita assinatura de comprimento diferente sem lançar (timingSafeEqual guarded)", () => {
    expect(verifyWebhookBody(body, "deadbeef", secret)).toBe(false);
    expect(verifyWebhookBody(body, "", secret)).toBe(false);
  });
});
