/** INVARIANTE (M18/S1, LEI I): o STREAMING é do LLM, token-a-token, HTTP de verdade — NÃO animação
 *  cosmética de um texto já pronto. Estes testes provam, no nível do cliente (sem rede), que:
 *   1. `textStream` parseia o SSE da Anthropic e chama `onToken` por delta ENQUANTO chega (N deltas →
 *      N chamadas, na ORDEM), devolvendo a concatenação. (Prova "incremental, não acumula-e-fatia".)
 *   2. eventos não-texto (message_start/content_block_start/ping/message_delta/message_stop) são ignorados.
 *   3. um bloco SSE partido entre 2 reads do reader vira UM `onToken` correto (bufferização).
 *   4. evento `error` → rejeita (throw), sem emitir lixo.
 *   5. `streamProse` provider `api` delega a `textStream` (N tokens incrementais).
 *   6. `streamProse` provider `cli` chama `onToken(full)` UMA vez (fallback honesto — cli não streama).
 *  Sem Anthropic real (invariante #9: o stream REAL é o HTC do M18). fetch + ReadableStream mockados. */
import { EventEmitter } from "node:events";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

// O caminho `cli` do streamProse chama `prose` → `runClaude` → `spawn("claude", …)`. Como é chamada
// INTRA-módulo, um vi.spyOn(llm,'prose') não intercepta (ESM). Mockamos o `spawn` do child_process pra
// simular o binário `claude` devolvendo o envelope JSON {result}, sem CLI real. `_cliStdout` controla a saída.
let _cliStdout = "";
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn(() => {
      const ch: any = new EventEmitter();
      ch.stdout = new EventEmitter();
      ch.stderr = new EventEmitter();
      ch.stdin = { write: () => {}, end: () => {} };
      ch.kill = () => {};
      // emite a saída e fecha no próximo tick (assíncrono, como o processo real)
      setImmediate(() => {
        ch.stdout.emit("data", Buffer.from(_cliStdout));
        ch.emit("close", 0);
      });
      return ch;
    }),
  };
});

import { textStream, buildProseBody } from "../../src/lib/anthropic.ts";
import * as llm from "../../src/lib/llm.ts";

const ORIGINAL_FETCH = globalThis.fetch;
const enc = new TextEncoder();

/** Monta um `Response` mockado cujo `body` é um ReadableStream que emite, em ordem, os `chunks` dados
 *  (cada chunk é uma string já no wire-format SSE; um chunk pode conter 0+ eventos ou um evento partido). */
function sseResponse(chunks: string[], opts: { ok?: boolean; status?: number } = {}): Response {
  const { ok = true, status = 200 } = opts;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  return { ok, status, body, text: async () => "", json: async () => ({}) } as unknown as Response;
}

/** Evento SSE da Anthropic no formato `event: <name>\ndata: <json>\n\n`. */
function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Atalho: um content_block_delta de texto. */
function textDelta(t: string): string {
  return sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } });
}

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = "sk-test-key";
  delete process.env.MAX_OUTPUT_TOKENS;
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.MAX_OUTPUT_TOKENS;
});

describe("buildProseBody — body de PROSA sem tools/tool_choice (M18)", () => {
  it("NÃO inclui tools/tool_choice (é texto livre, não tool_use)", () => {
    const body = buildProseBody("claude-x", "olá") as any;
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("tool_choice");
    expect(body.messages).toEqual([{ role: "user", content: "olá" }]);
    expect(body.max_tokens).toBe(4000);
  });

  it("stream=true adiciona stream:true; default sem stream", () => {
    expect(buildProseBody("m", "u")).not.toHaveProperty("stream");
    expect(buildProseBody("m", "u", "", true)).toMatchObject({ stream: true });
  });

  it("system só quando fornecido, e aplica safeText (surrogate solto → �)", () => {
    expect(buildProseBody("m", "u")).not.toHaveProperty("system");
    const body = buildProseBody("m", "ola\uD800fim", "sys\uD800", true) as any;
    expect(body.messages[0].content).toBe("ola�fim");
    expect(body.system).toBe("sys�");
  });
});

describe("textStream — tokens incrementais REAIS (LEI I): N deltas → N onToken, na ordem", () => {
  it("3 content_block_delta → onToken 3×, na ordem, retorno = concatenação", async () => {
    const wire = [
      sse("message_start", { type: "message_start" }),
      sse("content_block_start", { type: "content_block_start", index: 0 }),
      textDelta("Bru"),
      textDelta("no"),
      textDelta(" Canguçu"),
      sse("message_stop", { type: "message_stop" }),
    ].join("");
    globalThis.fetch = vi.fn(async () => sseResponse([wire])) as any;

    const seen: string[] = [];
    const full = await textStream("m", "quem é?", "sys", (d) => seen.push(d));

    expect(seen).toEqual(["Bru", "no", " Canguçu"]); // 3×, ORDEM preservada
    expect(full).toBe("Bruno Canguçu"); // concatenação
  });

  it("POST stream:true com headers de auth no /v1/messages (corpo SEM tools)", async () => {
    const fetchMock = vi.fn(async () => sseResponse([textDelta("ok")]));
    globalThis.fetch = fetchMock as any;

    await textStream("claude-x", "u", "s", () => {});

    const [url, init] = fetchMock.mock.calls[0] as any;
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ "x-api-key": "sk-test-key", "anthropic-version": "2023-06-01" });
    const body = JSON.parse(init.body);
    expect(body.stream).toBe(true);
    expect(body).not.toHaveProperty("tools");
  });

  it("eventos não-texto intercalados (start/ping/message_delta/stop) NÃO viram onToken nem entram no retorno", async () => {
    const wire = [
      sse("message_start", { type: "message_start" }),
      sse("ping", { type: "ping" }),
      sse("content_block_start", { type: "content_block_start", index: 0 }),
      textDelta("A"),
      sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" } }),
      textDelta("B"),
      sse("message_stop", { type: "message_stop" }),
    ].join("");
    globalThis.fetch = vi.fn(async () => sseResponse([wire])) as any;

    const seen: string[] = [];
    const full = await textStream("m", "u", "s", (d) => seen.push(d));

    expect(seen).toEqual(["A", "B"]); // só os text_delta
    expect(full).toBe("AB");
  });

  it("bloco SSE partido entre 2 reads → UM onToken correto (bufferização, não 2 pela metade)", async () => {
    const evt = textDelta("Canguçu"); // "event: ...\ndata: {...}\n\n"
    const cut = Math.floor(evt.length / 2);
    // o evento chega dividido em DOIS chunks do reader (split no meio do JSON)
    globalThis.fetch = vi.fn(async () => sseResponse([evt.slice(0, cut), evt.slice(cut)])) as any;

    const seen: string[] = [];
    const full = await textStream("m", "u", "s", (d) => seen.push(d));

    expect(seen).toEqual(["Canguçu"]); // UMA emissão, inteira
    expect(full).toBe("Canguçu");
  });

  it("evento `error` no meio do stream → rejeita (throw), sem onToken de lixo depois", async () => {
    const wire = [
      textDelta("ini"),
      sse("error", { type: "error", error: { type: "overloaded_error", message: "boom" } }),
      textDelta("nunca"),
    ].join("");
    globalThis.fetch = vi.fn(async () => sseResponse([wire])) as any;

    const seen: string[] = [];
    await expect(textStream("m", "u", "s", (d) => seen.push(d))).rejects.toThrow(/Anthropic stream error/);
    expect(seen).toEqual(["ini"]); // só o que veio ANTES do erro; "nunca" não emitido
  });

  it("HTTP não-ok → throw (com status), sem abrir stream", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 401,
      body: null,
      text: async () => "unauthorized",
    })) as any;
    await expect(textStream("m", "u", "s", () => {})).rejects.toThrow(/Anthropic 401/);
  });

  it("propaga exceção do onToken (não engole — S2/S3 controla o ciclo de vida)", async () => {
    globalThis.fetch = vi.fn(async () => sseResponse([textDelta("x")])) as any;
    await expect(
      textStream("m", "u", "s", () => {
        throw new Error("caller jogou");
      }),
    ).rejects.toThrow(/caller jogou/);
  });
});

describe("streamProse — provider-agnóstico (M18)", () => {
  it("provider api → delega a textStream (N tokens incrementais, mesmo mock SSE)", async () => {
    const wire = [textDelta("Oi"), textDelta(" mundo")].join("");
    globalThis.fetch = vi.fn(async () => sseResponse([wire])) as any;

    const seen: string[] = [];
    const full = await llm.streamProse({ provider: "api", model: "m", system: "s", prompt: "p" }, (d) => seen.push(d));

    expect(seen).toEqual(["Oi", " mundo"]); // streaming real, N chamadas
    expect(full).toBe("Oi mundo");
  });

  it("provider cli → prose() não-stream + onToken(full) UMA vez, retorno = full", async () => {
    // o binário `claude` (mockado via spawn) devolve o envelope {result}; cli NÃO streama → 1 onToken.
    _cliStdout = JSON.stringify({ result: "resposta inteira do cli" });

    const seen: string[] = [];
    const full = await llm.streamProse({ provider: "cli", model: "haiku", system: "s", prompt: "p" }, (d) =>
      seen.push(d),
    );

    expect(seen).toEqual(["resposta inteira do cli"]); // UMA emissão (o texto inteiro)
    expect(full).toBe("resposta inteira do cli");
  });

  it("provider cli com resposta vazia → NÃO chama onToken (não emite token vazio)", async () => {
    _cliStdout = JSON.stringify({ result: "" });

    const seen: string[] = [];
    const full = await llm.streamProse({ provider: "cli", model: "haiku", system: "s", prompt: "p" }, (d) =>
      seen.push(d),
    );

    expect(seen).toEqual([]); // `if (full) onToken(full)` — vazio não emite
    expect(full).toBe("");
  });
});
