/** M10/S1 — sobe o BFF (startWebServer) em PORTA EFÊMERA (WEB_PORT=0) e expõe um fetch tipado com
 *  cookie de sessão acumulado. Espelha o estilo de test/integration/helpers/db.ts. IMPORTA o server
 *  (não edita web-server.ts). */
import { startWebServer } from "../../../src/connectors/web-server.ts";
import type { Server } from "node:http";

let _server: Server | null = null;
let _baseUrl = "";
let _cookie = ""; // cookie de sessão acumulado (Set-Cookie do último login)
let _reqSeq = 0; // sequência p/ X-Forwarded-For único por request (ver bff())

/** Sobe o BFF em porta EFÊMERA (WEB_PORT=0) e resolve a baseUrl real. */
export async function startSmokeBff(): Promise<{ baseUrl: string }> {
  process.env.WEB_PORT = "0"; // o OS escolhe a porta livre
  // Simula a topologia de prod (proxy reverso confiável): o rate-limit P0 chaveia por clientIp,
  // que sob TRUST_PROXY=1 lê o ÚLTIMO hop do X-Forwarded-For. Cada request da suíte manda um XFF
  // único (ver bff()), então os ~12 logins do owner não colidem no mesmo balde (10/60s) — o
  // throttle continua ATIVO e testável, só não trava a própria suíte. NÃO afrouxa o produto.
  process.env.TRUST_PROXY = "1";
  _server = startWebServer();
  await new Promise<void>((resolve) => _server!.once("listening", () => resolve()));
  const addr = _server!.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  _baseUrl = `http://127.0.0.1:${port}`;
  return { baseUrl: _baseUrl };
}

export async function stopBff(): Promise<void> {
  if (_server) await new Promise<void>((r) => _server!.close(() => r()));
  _server = null;
  _cookie = "";
}

/** fetch contra o BFF; injeta o cookie acumulado; captura Set-Cookie. `auth:false` força anônimo. */
export async function bff(
  path: string,
  opts: { method?: string; body?: unknown; auth?: boolean } = {},
): Promise<{ status: number; json: any; raw: string }> {
  const headers: Record<string, string> = {};
  if (opts.auth !== false && _cookie) headers["cookie"] = _cookie;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  // IP de cliente único por request (rightmost do XFF, lido sob TRUST_PROXY=1): espalha os baldes
  // do rate-limit P0 para a suíte não trombar no próprio throttle (10/60s por IP).
  headers["x-forwarded-for"] = `10.0.${(_reqSeq >> 8) & 255}.${_reqSeq & 255}`;
  _reqSeq += 1;
  const res = await fetch(_baseUrl + path, {
    method: opts.method || "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) _cookie = setCookie.split(";")[0]; // guarda só `galeed_sess=...`
  const raw = await res.text();
  let json: any = null;
  try {
    json = raw ? JSON.parse(raw) : null;
  } catch {
    /* não-json */
  }
  return { status: res.status, json, raw };
}

/** loga (POST /auth/login) e passa a usar o cookie da sessão. */
export async function login(email: string, password: string): Promise<void> {
  _cookie = ""; // limpa antes
  const r = await bff("/auth/login", { method: "POST", body: { email, password }, auth: false });
  if (r.status !== 200) throw new Error(`login falhou: ${r.status} ${r.raw}`);
}

/** descarta a sessão (vira anônimo). */
export function asAnon(): void {
  _cookie = "";
}
