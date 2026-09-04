/** INVARIANTE (M16/S1): o cliente da Message Batches API + a fatoração da costura de extração.
 *
 *  Por que importa: a LEI II do M16 (equivalência batch≡sync) é garantida ESTRUTURALMENTE — o request do
 *  lote (S3) usa A MESMA `buildMessagesBody` que o `toolCall` síncrono, e o harvest do lote usa A MESMA
 *  `parseToolUse`. Se essa fatoração divergir do corpo que o `toolCall` montava inline, o lote extrairia
 *  algo diferente do síncrono (bug silencioso que a LEI proíbe). Estes testes travam:
 *   1. `buildMessagesBody` produz EXATAMENTE o corpo que o `toolCall` mandava (golden inline).
 *   2. round-trip `buildMessagesBody` → (resposta Messages simulada) → `parseToolUse`.
 *   3. `submitBatch`/`getBatch`/`getBatchResults` falam o shape certo da Batch API (fetch mockado).
 *   4. `getBatchResults` parseia JSONL linha-a-linha, tolera linha vazia, e CASA por custom_id (ordem
 *      QUALQUER) — nunca por posição.
 *  Sem Anthropic real: o lote REAL é o aceite do S5 (invariante #9). */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { anthropicHeaders, buildMessagesBody, parseToolUse, type Tool } from "../../src/lib/anthropic.ts";
import {
  submitBatch,
  getBatch,
  getBatchResults,
  type BatchRequest,
  type BatchHandle,
  type BatchResultLine,
} from "../../src/lib/batch-client.ts";

const TOOL: Tool = {
  name: "extract",
  description: "extrai fatos",
  input_schema: { type: "object", properties: { claims: { type: "array" } } },
};

const ORIGINAL_FETCH = globalThis.fetch;

/** Resposta fetch mínima (ok + json/text). */
function fakeRes(opts: { ok?: boolean; status?: number; json?: any; text?: string }): Response {
  const { ok = true, status = 200, json, text } = opts;
  return {
    ok,
    status,
    json: async () => json,
    text: async () => (text !== undefined ? text : JSON.stringify(json)),
  } as unknown as Response;
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

describe("anthropicHeaders — auth idêntica ao toolCall (GA, sem header beta)", () => {
  it("monta x-api-key + anthropic-version + content-type", () => {
    process.env.ANTHROPIC_API_KEY = "sk-abc";
    expect(anthropicHeaders()).toEqual({
      "x-api-key": "sk-abc",
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    });
    // garantia explícita: SEM header beta (Batch API é GA)
    expect(Object.keys(anthropicHeaders())).not.toContain("anthropic-beta");
  });

  it("lança se ANTHROPIC_API_KEY ausente", () => {
    delete process.env.ANTHROPIC_API_KEY;
    expect(() => anthropicHeaders()).toThrow(/ANTHROPIC_API_KEY/);
  });
});

describe("buildMessagesBody — byte-compatível com o corpo que toolCall montava inline", () => {
  it("produz EXATAMENTE o corpo golden (a costura da LEI II)", () => {
    const body = buildMessagesBody("claude-x", "olá mundo", TOOL);
    // Golden: o MESMO objeto que toolCall montava nas linhas 39-45 do anthropic.ts pré-refactor.
    expect(body).toEqual({
      model: "claude-x",
      max_tokens: 8000,
      tools: [TOOL],
      tool_choice: { type: "tool", name: "extract" },
      messages: [{ role: "user", content: "olá mundo" }],
    });
    // sem stream (a Batch API rejeita; o síncrono também não usava)
    expect(body).not.toHaveProperty("stream");
  });

  it("inclui system só quando fornecido (paridade com o `if (system)` do toolCall)", () => {
    expect(buildMessagesBody("m", "u", TOOL)).not.toHaveProperty("system");
    expect(buildMessagesBody("m", "u", TOOL, "regras")).toMatchObject({ system: "regras" });
  });

  it("respeita MAX_OUTPUT_TOKENS do env (mesma fonte que o toolCall)", () => {
    process.env.MAX_OUTPUT_TOKENS = "1234";
    expect(buildMessagesBody("m", "u", TOOL)).toMatchObject({ max_tokens: 1234 });
  });

  it("aplica safeText (surrogate solto vira �) no prompt e no system", () => {
    const loneHigh = "ola\uD800fim";
    const body = buildMessagesBody("m", loneHigh, TOOL, loneHigh) as any;
    expect(body.messages[0].content).toBe("ola�fim");
    expect(body.system).toBe("ola�fim");
  });
});

describe("parseToolUse — mesma semântica que o parsing inline do toolCall", () => {
  it("round-trip: buildMessagesBody → resposta Messages simulada → parseToolUse devolve o input", () => {
    const body = buildMessagesBody("m", "u", TOOL);
    const toolName = (body.tool_choice as any).name;
    // resposta Messages como a Anthropic devolveria pra esse tool_choice forçado
    const messageResponse = {
      stop_reason: "tool_use",
      content: [{ type: "tool_use", name: toolName, input: { claims: [{ text: "preço 30k" }] } }],
    };
    expect(parseToolUse(messageResponse)).toEqual({ claims: [{ text: "preço 30k" }] });
  });

  it("parseia result.message do lote IGUAL ao JSON do /v1/messages (mesmo shape)", () => {
    const line: BatchResultLine = {
      custom_id: "p1__0",
      result: { type: "succeeded", message: { content: [{ type: "tool_use", input: { ok: 1 } }] } },
    };
    if (line.result.type !== "succeeded") throw new Error("fixture");
    expect(parseToolUse(line.result.message)).toEqual({ ok: 1 });
  });

  it("lança em truncamento (max_tokens)", () => {
    expect(() => parseToolUse({ stop_reason: "max_tokens", content: [] })).toThrow(/max_tokens/);
  });

  it("lança quando não há bloco tool_use", () => {
    expect(() => parseToolUse({ content: [{ type: "text", text: "oi" }] })).toThrow(/sem tool_use/);
  });
});

describe("submitBatch — POST /v1/messages/batches", () => {
  const requests: BatchRequest[] = [{ custom_id: "p1__0", params: buildMessagesBody("m", "u", TOOL) }];

  it("manda POST com headers de auth e body { requests } e devolve o handle", async () => {
    const handle: BatchHandle = {
      id: "msgbatch_123",
      processing_status: "in_progress",
      request_counts: { processing: 1, succeeded: 0, errored: 0, canceled: 0, expired: 0 },
      results_url: null,
      created_at: "2026-06-04T00:00:00Z",
      expires_at: "2026-06-05T00:00:00Z",
    };
    const fetchMock = vi.fn(async () => fakeRes({ json: handle }));
    globalThis.fetch = fetchMock as any;

    const out = await submitBatch(requests);
    expect(out).toEqual(handle);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.anthropic.com/v1/messages/batches");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual(anthropicHeaders());
    expect(JSON.parse(init.body)).toEqual({ requests });
  });

  it("lança em lote vazio sem chamar fetch", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as any;
    await expect(submitBatch([])).rejects.toThrow(/lote vazio/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("propaga erro HTTP (sem backoff 429 interno — propaga e o caller decide)", async () => {
    globalThis.fetch = vi.fn(async () => fakeRes({ ok: false, status: 429, text: "rate limited" })) as any;
    await expect(submitBatch(requests)).rejects.toThrow(/Batch submit 429/);
  });
});

describe("getBatch — GET /v1/messages/batches/{id}", () => {
  it("monta a URL com o id e devolve o handle (ended → results_url populado)", async () => {
    const handle: BatchHandle = {
      id: "msgbatch_xyz",
      processing_status: "ended",
      request_counts: { processing: 0, succeeded: 2, errored: 0, canceled: 0, expired: 0 },
      results_url: "https://api.anthropic.com/v1/messages/batches/msgbatch_xyz/results",
      created_at: "2026-06-04T00:00:00Z",
      expires_at: "2026-06-05T00:00:00Z",
    };
    const fetchMock = vi.fn(async () => fakeRes({ json: handle }));
    globalThis.fetch = fetchMock as any;

    const out = await getBatch("msgbatch_xyz");
    expect(out.results_url).toBe(handle.results_url);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.anthropic.com/v1/messages/batches/msgbatch_xyz");
    expect(init.method).toBe("GET");
    expect(init.headers).toEqual(anthropicHeaders());
  });

  it("propaga erro HTTP", async () => {
    globalThis.fetch = vi.fn(async () => fakeRes({ ok: false, status: 404, text: "not found" })) as any;
    await expect(getBatch("nope")).rejects.toThrow(/Batch get 404/);
  });
});

describe("getBatchResults — GET results_url → JSONL parse, casar por custom_id", () => {
  const handle: BatchHandle = {
    id: "msgbatch_xyz",
    processing_status: "ended",
    request_counts: { processing: 0, succeeded: 1, errored: 1, canceled: 0, expired: 0 },
    results_url: "https://api.anthropic.com/v1/messages/batches/msgbatch_xyz/results",
    created_at: "2026-06-04T00:00:00Z",
    expires_at: "2026-06-05T00:00:00Z",
  };

  it("parseia JSONL succeeded+errored, tolera linhas vazias, e casa por custom_id (ordem QUALQUER)", async () => {
    // ordem propositalmente trocada (p2 antes de p1) + linhas vazias intercaladas + \r\n
    const jsonl = [
      "",
      JSON.stringify({
        custom_id: "p2__0",
        result: { type: "succeeded", message: { content: [{ type: "tool_use", input: { v: 2 } }] } },
      }),
      "",
      JSON.stringify({ custom_id: "p1__0", result: { type: "errored", error: { type: "invalid_request_error" } } }),
      "",
    ].join("\r\n");

    const fetchMock = vi.fn(async () => fakeRes({ text: jsonl }));
    globalThis.fetch = fetchMock as any;

    const lines = await getBatchResults(handle);
    expect(lines).toHaveLength(2);

    // fetch foi direto no results_url, com os headers de auth
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(handle.results_url);
    expect(init.headers).toEqual(anthropicHeaders());

    // casamento por custom_id (NUNCA por posição)
    const byId = new Map(lines.map((l) => [l.custom_id, l]));
    const ok = byId.get("p2__0")!;
    const err = byId.get("p1__0")!;
    expect(ok.result.type).toBe("succeeded");
    if (ok.result.type === "succeeded") expect(parseToolUse(ok.result.message)).toEqual({ v: 2 });
    expect(err.result.type).toBe("errored");
  });

  it("lança se results_url null (lote ainda não 'ended') sem chamar fetch", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as any;
    await expect(getBatchResults({ ...handle, results_url: null })).rejects.toThrow(/results_url null/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("propaga erro HTTP", async () => {
    globalThis.fetch = vi.fn(async () => fakeRes({ ok: false, status: 500, text: "boom" })) as any;
    await expect(getBatchResults(handle)).rejects.toThrow(/Batch results 500/);
  });
});
