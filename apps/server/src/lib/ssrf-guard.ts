/** Galeed C1 — guarda anti-SSRF para webhooks de SAÍDA (entrega push por brain).
 *
 *  POR QUÊ: a URL do webhook é fornecida pelo cliente no REGISTRO (self-serve, /v1/webhooks).
 *  Sem guarda, um cliente poderia apontar o webhook para 127.0.0.1, 169.254.169.254 (metadata da
 *  cloud), 10.x da VPC interna etc. e usar NOSSO worker como proxy para varrer/atacar a rede interna
 *  (SSRF clássico). Postura herdada de ingest-server.ts:73-78 (que matou doc_url/audio_url de payload).
 *
 *  DEFESA EM DUAS CAMADAS (chame validateOutboundUrl as DUAS vezes):
 *   1. NO REGISTRO (sync): rejeita já na criação do webhook URLs obviamente internas (UX + 1ª barreira).
 *   2. NA ENTREGA (no worker, de novo, imediatamente antes do POST): obrigatório contra DNS-REBINDING
 *      — um host público no registro pode ter o DNS re-apontado para 127.0.0.1 depois.
 *
 *  ANTI-REBINDING DE VERDADE (a parte que importa — o que validar de novo SOZINHO não resolvia):
 *   validar na entrega só fecha a janela SE a conexão usar o MESMO IP que foi validado. Com `fetch`
 *   (undici) a entrega RE-RESOLVE o DNS por baixo, então havia uma janela TOCTOU: o nome resolvia
 *   público na validação e privado (127.0.0.1, 169.254.169.254) microssegundos depois, na conexão.
 *   FECHADO AGORA: validateOutboundUrl RETORNA o IP exato que aprovou ({ ip, family }), e a entrega
 *   (deliverWebhook) conecta NAQUELE IP via a opção `lookup` do node:https.request — o socket é pinado
 *   no IP já validado, sem nova resolução de DNS. Host header e TLS servername continuam = hostname
 *   (certificado válido). node:https NÃO segue 3xx por padrão → um 302 p/ http://169.254.169.254 nunca
 *   é seguido (vetor REDIRECT também fechado). Sem o pin, redirect:"manual" só fechava o REDIRECT, não
 *   o REBINDING — por isso a entrega trocou de fetch para node:https.request com lookup pinado.
 *
 *  Regras de IP — ALLOWLIST (fail-closed por construção): um IP resolvido SÓ passa se for UNICAST
 *  GLOBAL (ipaddr range()==="unicast" — público de internet). Qualquer outra faixa reprova. Para IPv6,
 *  ANTES de julgar, destrincha o IPv4 embutido (ipv4Mapped ::ffff:a.b.c.d; NAT64 rfc6052 64:ff9b::/96;
 *  6to4 2002::/16) e re-julga o IPv4 extraído pelas regras de IPv4 — senão 64:ff9b::7f00:1 ou
 *  2002:7f00:1:: contrabandeariam 127.0.0.1 para dentro. Protocolo DEVE ser https:; localhost barrado. */
import { lookup as dnsLookup } from "node:dns/promises";
import https from "node:https";
import http from "node:http";
import ipaddr from "ipaddr.js";

export interface ValidationResult {
  ok: boolean;
  reason?: string;
  /** O IP exato que a guarda APROVOU (presente só quando ok=true). A entrega DEVE conectar NESटE IP
   *  (pin anti-rebinding) — não re-resolver o DNS. Para multi-record, é o 1º IP aprovado. */
  ip?: string;
  /** family do `ip` aprovado (4 ou 6) — passada ao `lookup` pinado de node:https.request. */
  family?: number;
}

/** Assinatura mínima de dns.lookup({ all: true }) — injetável para teste (mocka sem depender de rede). */
export type LookupAll = (
  hostname: string,
  options: { all: true },
) => Promise<Array<{ address: string; family: number }>>;

/** Julga UM IPv4 textual pela ALLOWLIST: passa SÓ se range()==="unicast" (público de internet).
 *  Tudo o mais (private 10/172.16/192.168, loopback 127/8, linkLocal 169.254/16 incl. metadata da
 *  cloud, carrierGradeNat, broadcast, reserved, unspecified, multicast) reprova. Retorna o nome da
 *  faixa que reprovou, ou null se for unicast (ok). */
function judgeIPv4(v4: ipaddr.IPv4): string | null {
  const range = v4.range();
  return range === "unicast" ? null : range;
}

/** Classifica um IP textual pela ALLOWLIST. Retorna o nome da faixa que reprovou, ou null se passou.
 *  IPv6: destrincha IPv4 embutido (ipv4Mapped/NAT64/6to4) e re-julga pelas regras de IPv4; só então,
 *  se for IPv6 "puro", exige unicast global. Fecha o buraco simétrico do IPv4-em-IPv6. */
function blockedRangeOf(addr: string): string | null {
  let parsed: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    parsed = ipaddr.parse(addr);
  } catch {
    // IP que nem o ipaddr.js parseia → não confiável, bloqueia.
    return "unparseable";
  }

  if (parsed.kind() === "ipv6") {
    const v6 = parsed as ipaddr.IPv6;

    // (a) ::ffff:a.b.c.d — IPv4 mapeado: julga o IPv4 embutido (loopback/private mapeado segue interno).
    if (v6.isIPv4MappedAddress()) {
      const v4 = v6.toIPv4Address();
      const bad = judgeIPv4(v4);
      return bad ? `ipv4-mapped ${bad}` : null;
    }

    const bytes = v6.toByteArray(); // 16 bytes
    const range = v6.range();

    // (b) NAT64 rfc6052 (64:ff9b::/96): IPv4 embutido nos últimos 4 bytes (12-15). Ex.: 64:ff9b::7f00:1
    //     embute 127.0.0.1. Extrai e re-julga pelo IPv4 — senão contrabandearia o loopback p/ dentro.
    if (range === "rfc6052") {
      const v4 = ipaddr.fromByteArray(bytes.slice(12, 16)) as ipaddr.IPv4;
      const bad = judgeIPv4(v4);
      return bad ? `nat64 ${bad}` : null;
    }

    // (c) 6to4 (2002::/16): IPv4 embutido nos bytes 2-5. Ex.: 2002:7f00:1:: embute 127.0.0.1.
    if (range === "6to4") {
      const v4 = ipaddr.fromByteArray(bytes.slice(2, 6)) as ipaddr.IPv4;
      const bad = judgeIPv4(v4);
      return bad ? `6to4 ${bad}` : null;
    }

    // (d) IPv6 "puro" — ALLOWLIST: passa SÓ se unicast global. Loopback ::1, uniqueLocal fc00::/7,
    //     linkLocal fe80::/10, multicast, reserved, unspecified — todos reprovam.
    return range === "unicast" ? null : range;
  }

  return judgeIPv4(parsed as ipaddr.IPv4);
}

/** ESCAPE SÓ-TESTE (documentado e fail-closed por default): quando GALEED_WEBHOOK_ALLOW_LOCAL=1, a
 *  guarda libera destinos LOCAIS (http + 127.0.0.1/localhost) para que o smoke do worker possa subir um
 *  http server numa porta efêmera e receber o POST de verdade — sem isto, a própria guarda anti-SSRF
 *  (corretamente) bloquearia o loopback do teste. NUNCA é ligado em produção: o gate é uma env explícita,
 *  o default é fechado, e o alcance é mínimo (só loopback/localhost via http; todo o resto — link-local,
 *  metadata da cloud, RFC1918, IPv6 interno — continua barrado mesmo com o flag ligado). */
function allowLocalForTest(): boolean {
  return process.env.GALEED_WEBHOOK_ALLOW_LOCAL === "1";
}

/** Para o escape SÓ-TESTE: o IP reprovado é loopback puro (127/8 ou ::1)? Só estes são liberados. */
function isLoopbackBlock(blocked: string): boolean {
  return (
    blocked === "loopback" ||
    blocked === "ipv4-mapped loopback" ||
    blocked === "nat64 loopback" ||
    blocked === "6to4 loopback"
  );
}

/** Valida uma URL de webhook de SAÍDA. Chame no REGISTRO (sync) E de novo na ENTREGA (anti-rebinding).
 *  fail-closed: qualquer erro/incerteza ⇒ { ok: false }.
 *  Em ok=true devolve TAMBÉM { ip, family } — o IP EXATO aprovado — para a entrega pinar o socket nele
 *  (deliverWebhook), fechando a janela de rebinding. Para IP literal, ip = o próprio literal. Para
 *  hostname, ip = o 1º registro DNS que passou (todos são validados; um interno reprova a URL inteira). */
export async function validateOutboundUrl(
  url: string,
  lookup: LookupAll = dnsLookup as unknown as LookupAll,
): Promise<ValidationResult> {
  // (1) parseia
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: "URL inválida" };
  }

  const testLocal = allowLocalForTest();

  // (2) protocolo DEVE ser https: (escape SÓ-TESTE libera http p/ o loopback do smoke — ver acima).
  if (parsed.protocol !== "https:" && !(testLocal && parsed.protocol === "http:")) {
    return { ok: false, reason: `protocolo não permitido: ${parsed.protocol} (exigido https:)` };
  }

  // new URL() mantém os colchetes em hostname para IPv6 literal ([::1]); tira-os para ipaddr.parse.
  const hostname = parsed.hostname.replace(/^\[/, "").replace(/\]$/, "");

  // (4) hostname literal localhost (e variações com ponto final) — barrado antes mesmo do DNS.
  //     (escape SÓ-TESTE libera localhost p/ o loopback do smoke — ver allowLocalForTest.)
  const hostLower = hostname.replace(/\.$/, "").toLowerCase();
  if (hostLower === "localhost" || hostLower.endsWith(".localhost")) {
    if (testLocal) return { ok: true, ip: "127.0.0.1", family: 4 };
    return { ok: false, reason: "hostname localhost não permitido" };
  }

  // Se o host JÁ é um IP literal, julga direto (não há DNS a resolver). ipaddr aceita só o IP "cru";
  // a URL pode trazer IPv6 entre colchetes ([::1]) — new URL já tira os colchetes do .hostname.
  if (ipaddr.isValid(hostLower)) {
    const blocked = blockedRangeOf(hostLower);
    const family = hostLower.includes(":") ? 6 : 4;
    if (!blocked) return { ok: true, ip: hostLower, family };
    // escape SÓ-TESTE: libera SOMENTE loopback (127/8, ::1) — todo o resto (link-local, RFC1918,
    // metadata da cloud, IPv6 interno) continua barrado mesmo com o flag ligado.
    if (testLocal && isLoopbackBlock(blocked)) {
      return { ok: true, ip: hostLower, family };
    }
    return { ok: false, reason: `IP literal em faixa interna (${blocked})` };
  }

  // (3) resolve DNS (todos os registros) e valida CADA IP.
  let records: Array<{ address: string; family: number }>;
  try {
    records = await lookup(hostname, { all: true });
  } catch (e) {
    return { ok: false, reason: `falha ao resolver DNS de ${hostname}: ${(e as Error).message}` };
  }
  if (!records || records.length === 0) {
    return { ok: false, reason: `DNS de ${hostname} não resolveu nenhum IP` };
  }
  // 1º IP aprovado (para o pin da entrega). TODOS são validados: um interno reprova a URL inteira.
  let approved: { address: string; family: number } | null = null;
  for (const rec of records) {
    const blocked = blockedRangeOf(rec.address);
    if (blocked) {
      // escape SÓ-TESTE: libera SOMENTE loopback resolvido (host de teste apontando p/ 127.0.0.1/::1).
      if (testLocal && isLoopbackBlock(blocked)) {
        if (!approved) approved = rec;
        continue;
      }
      return { ok: false, reason: `${hostname} resolve para IP interno ${rec.address} (${blocked})` };
    }
    if (!approved) approved = rec;
  }
  if (!approved) {
    return { ok: false, reason: `DNS de ${hostname} não resolveu nenhum IP aprovado` };
  }
  // family do registro pode vir 0 em alguns resolvers → deriva pelo formato do endereço.
  const family = approved.family === 6 || approved.family === 4 ? approved.family : approved.address.includes(":") ? 6 : 4;
  return { ok: true, ip: approved.address, family };
}

/** Resposta mínima de uma entrega de webhook (o worker só precisa do status). */
export interface WebhookResponse {
  status: number;
}

/** Entrega o POST do webhook PINANDO o socket no IP já aprovado pela guarda (anti DNS-rebinding REAL):
 *   - `pinnedIp`/`pinnedFamily` vêm do validateOutboundUrl chamado AGORA (na entrega). O `lookup`
 *     injetado no request devolve SEMPRE esse IP — o socket nunca re-resolve o DNS, então não há janela
 *     TOCTOU entre validar e conectar. Host header e TLS servername seguem = hostname (cert válido).
 *   - node:https.request NÃO segue 3xx (sem auto-redirect) → um 302 p/ http://169.254.169.254 vira só
 *     uma resposta 3xx que o worker classifica como entrega-não-confirmada (dead). Fecha o vetor REDIRECT.
 *   - http (node:http.request) só para o escape SÓ-TESTE (loopback do smoke), nunca em produção.
 *   - timeout via req.setTimeout + destroy (um host lento não pode prender o worker).
 *  PRÉ-CONDIÇÃO: o chamador JÁ rodou validateOutboundUrl(url) AGORA e passou o ip/family que ela aprovou. */
export async function deliverWebhook(
  url: string,
  pinnedIp: string,
  pinnedFamily: number,
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    timeoutMs?: number;
    /** SÓ-TESTE: observa o IP em que o socket foi PINADO (provar o anti-rebinding sem tocar a rede). */
    onConnectIp?: (ip: string) => void;
  } = {},
): Promise<WebhookResponse> {
  const { timeoutMs = 10_000, method = "POST", headers = {}, body, onConnectIp } = init;
  const parsed = new URL(url);
  const isHttps = parsed.protocol === "https:";
  const transport = isHttps ? https : http;

  // PIN: o lookup do socket devolve SEMPRE o IP que a guarda aprovou — nunca re-resolve o DNS.
  // Node chama lookup em duas formas: (hostname, cb) OU (hostname, options, cb), e com options.all=true
  // o callback espera um ARRAY [{address,family}] em vez de (address, family). Cobrimos as duas.
  const family = pinnedFamily === 6 ? 6 : 4;
  const pinnedLookup = (
    _hostname: string,
    optionsOrCb: unknown,
    maybeCb?: (...args: unknown[]) => void,
  ): void => {
    const opts = (typeof optionsOrCb === "function" ? {} : optionsOrCb) as { all?: boolean };
    const cb = (typeof optionsOrCb === "function" ? optionsOrCb : maybeCb) as (...args: unknown[]) => void;
    onConnectIp?.(pinnedIp);
    if (opts && opts.all) {
      cb(null, [{ address: pinnedIp, family }]);
    } else {
      cb(null, pinnedIp, family);
    }
  };

  return await new Promise<WebhookResponse>((resolve, reject) => {
    const req = transport.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname.replace(/^\[/, "").replace(/\]$/, ""),
        port: parsed.port || (isHttps ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
        method,
        headers: { ...headers, host: headers.host ?? parsed.host },
        // TLS servername = hostname (não o IP) → certificado válido apesar do pin no IP.
        servername: isHttps ? parsed.hostname.replace(/^\[/, "").replace(/\]$/, "") : undefined,
        // PIN anti-rebinding: conecta no IP já validado, sem re-resolver o DNS.
        lookup: pinnedLookup as unknown as undefined,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        // drena e descarta o corpo (o worker só precisa do status); libera o socket.
        res.on("data", () => {});
        res.on("end", () => resolve({ status }));
        res.on("error", reject);
      },
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`timeout após ${timeoutMs}ms`));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}
