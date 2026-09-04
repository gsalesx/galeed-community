/** M18 · S3 (seam do Integrador) — gate §5.1+§5.2 do brief: STREAMING REAL + carga ancorada no `done`.
 *
 *  Prova, no nível HTTP/SSE de verdade (BFF em porta efêmera, cliente HTTP lendo o corpo conforme chega),
 *  que a rota `GET /api/ask/stream`:
 *    (1) emite TOKENS INCREMENTAIS — ≥2 eventos `data:` SEPARADOS NO TEMPO antes do `done` (LEI I:
 *        streaming HTTP de verdade, não um texto pronto fatiado);
 *    (2) fecha com `event: done` carregando a carga ANCORADA `{citations, facts}` (a MESMA do /api/ask),
 *        SEM 2ª síntese (askStreamPayload = só recuperação);
 *    (3) em erro da síntese → `event: error` (front cai no fallback api.ask).
 *
 *  Mock no LIMITE do seam (o que o web-server.ts importa): `askStream` (S2) emite N deltas determinísticos
 *  com folga no tempo entre eles (prova o flush incremental — não há LLM/retrieval real aqui); `accounts`
 *  (auth) passa sem DB; `askStreamPayload` (S3/BFF) devolve a carga rica sem retrieve real. Território:
 *  SÓ teste novo. ZERO edição de produção. */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

// --- auth: requireBrain passa com qualquer cookie, sem tocar o Postgres ---
vi.mock("../../src/core/access/accounts.ts", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    sessionAccount: vi.fn(async () => ({ id: "acc-test", name: "Test", email: "t@t.test" })),
    brainsOf: vi.fn(async () => [{ id: "__test_m18_sse", name: "SSE", role: "owner" }]),
  };
});

// --- askStream (S2): emite N deltas determinísticos COM folga no tempo (prova incremental, sem LLM) ---
const DELTAS = ["Bruno ", "é ", "médico ", "cirurgião."];
let askStreamMode: "ok" | "throw" = "ok";
vi.mock("../../src/core/retrieval/ask.ts", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    askStream: vi.fn(async (_home: string, _q: string, onToken: (d: string) => void) => {
      for (const d of DELTAS) {
        await new Promise((r) => setTimeout(r, 15)); // espaça os flushes no tempo → eventos SEPARADOS
        if (askStreamMode === "throw" && d === DELTAS[2]) throw new Error("síntese caiu no meio");
        onToken(d);
      }
      return { sources: ["bio-bruno"], gaps: [], provider: "api" };
    }),
  };
});

// --- askStreamPayload (S3/BFF): carga ancorada rica, sem retrieve/DB real ---
const PAYLOAD = {
  citations: [{ slug: "bio-bruno", title: "Bruno", selo: { tipo: "doc" } }],
  facts: [{ source_slug: "bio-bruno", entity: "Bruno", predicate: "é", value: "médico" }],
};
vi.mock("../../src/connectors/bff/bff-m9.ts", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, askStreamPayload: vi.fn(async () => PAYLOAD) };
});

import { startWebServer } from "../../src/connectors/web-server.ts";

let server: Server;
let base = "";

beforeAll(async () => {
  process.env.WEB_PORT = "0"; // porta efêmera
  server = startWebServer();
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const addr = server.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Lê o corpo SSE incrementalmente, registrando o TIMESTAMP de cada chunk recebido. Resolve com o texto
 *  acumulado + a lista de instantes (pra provar que os `data:` chegaram em momentos distintos). */
async function readSse(url: string): Promise<{ text: string; chunkTimes: number[]; status: number }> {
  const res = await fetch(url, { headers: { cookie: "galeed_sess=fake" } });
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let text = "";
  const chunkTimes: number[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    text += dec.decode(value, { stream: true });
    chunkTimes.push(Date.now());
  }
  return { text, chunkTimes, status: res.status };
}

/** Conta eventos `data: {...}` que são TOKENS (têm `.t`), antes do `event: done`. */
function parseSse(text: string): { tokens: string[]; donePayload: unknown; errorPayload: unknown } {
  const tokens: string[] = [];
  let donePayload: unknown = undefined;
  let errorPayload: unknown = undefined;
  let curEvent = "message";
  for (const block of text.split("\n\n")) {
    if (!block.trim()) continue;
    curEvent = "message";
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) curEvent = line.slice(6).trim();
      else if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    if (!data) continue;
    const parsed = JSON.parse(data);
    if (curEvent === "done") donePayload = parsed;
    else if (curEvent === "error") errorPayload = parsed;
    else if (typeof parsed?.t === "string") tokens.push(parsed.t);
  }
  return { tokens, donePayload, errorPayload };
}

describe("M18/S3 — SSE /api/ask/stream (tokens incrementais + carga ancorada no done)", () => {
  it("emite ≥2 eventos data: SEPARADOS no tempo antes do done, depois a carga ancorada", async () => {
    askStreamMode = "ok";
    const { text, chunkTimes, status } = await readSse(`${base}/api/ask/stream?q=Quem%20e%20o%20Bruno&brain=__test_m18_sse`);
    expect(status).toBe(200);

    const { tokens, donePayload, errorPayload } = parseSse(text);
    expect(errorPayload).toBeUndefined();

    // (1) LEI I — tokens incrementais: todos os N deltas chegaram, na ordem.
    expect(tokens).toEqual(DELTAS);
    expect(tokens.length).toBeGreaterThanOrEqual(2);

    // (1b) e chegaram SEPARADOS no tempo (não foi um texto pronto fatiado e despejado de uma vez):
    //      ≥2 instantes distintos de recebimento, com janela total perceptível.
    const distinct = new Set(chunkTimes);
    expect(distinct.size).toBeGreaterThanOrEqual(2);
    expect(chunkTimes[chunkTimes.length - 1] - chunkTimes[0]).toBeGreaterThan(20);

    // (2) §5.2 — o `done` traz a carga ANCORADA {citations, facts} (shape do /api/ask), sem 2ª síntese.
    expect(donePayload).toEqual(PAYLOAD);
  });

  it("erro na síntese → event: error (front cai no fallback api.ask)", async () => {
    askStreamMode = "throw";
    const { text, status } = await readSse(`${base}/api/ask/stream?q=falha&brain=__test_m18_sse`);
    expect(status).toBe(200); // headers SSE já foram (200); o erro vem no corpo como event:error
    const { tokens, donePayload, errorPayload } = parseSse(text);
    expect(donePayload).toBeUndefined();
    expect(tokens.length).toBeGreaterThanOrEqual(1); // alguns tokens vieram antes do erro
    // erro NÃO-tipado é mascarado pro cliente (ACHADO #16/#23 — mensagem/stack só no log server-side)
    expect(errorPayload).toMatchObject({ error: "erro interno" });
  });

  it("sem ?q= → 400 JSON (antes de abrir o stream)", async () => {
    const res = await fetch(`${base}/api/ask/stream?brain=__test_m18_sse`, { headers: { cookie: "galeed_sess=fake" } });
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("q=") });
  });
});
