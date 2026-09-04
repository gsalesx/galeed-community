/** Cliente HTTP PURO do gateway público /v1 do Galeed. ZERO dependência de DB/core —
 *  fala só com a borda pública por `fetch` (nativo do Node 18+) e `Authorization: Bearer <token>`.
 *
 *  Superfície (espelha src/connectors/gateway-server.ts):
 *    POST /ask         body { question }                                  → { answer, facts[], withheld }
 *    GET  /facts       ?area&status&as_of&min_confidence&limit&cursor     → { facts[], cursor?, truncated? }
 *    POST /ingest      body { source, content, occurred_at?, sensitivity? } → 202 { batch_id, status, source, received_at }   (requer can_ingest)
 *    GET  /ingest/:id                                                      → { batch_id, status, progress?, result? }
 *
 *  REGRA DE SEGURANÇA: o token NUNCA aparece numa mensagem de erro, log ou exceção. */

/** Erro de chamada ao gateway com o status HTTP preservado, pra mapear pra mensagem acionável. */
export class GaleedApiError extends Error {
  readonly status: number;
  /** corpo (texto) da resposta de erro, já sanitizado — nunca contém o token. */
  readonly body: string;
  constructor(status: number, message: string, body: string) {
    super(message);
    this.name = "GaleedApiError";
    this.status = status;
    this.body = body;
  }
}

export interface PublicFact {
  // shape público do gateway (gateway-shape.ts). Mantido aberto: o cliente é um pass-through honesto.
  [key: string]: unknown;
}

export interface AskResult {
  answer: string;
  facts: PublicFact[];
  withheld: unknown;
}

export interface FactsParams {
  dim?: string;
  area?: string;
  status?: "fact" | "archived";
  as_of?: string;
  min_confidence?: number;
  limit?: number;
  cursor?: string;
}

export interface FactsResult {
  facts: PublicFact[];
  cursor?: string;
  truncated?: boolean;
}

export interface IngestBody {
  source: string;
  content: string;
  occurred_at?: string;
  sensitivity?: "open" | "internal" | "confidential" | "secret";
}

export interface IngestAccepted {
  batch_id: string;
  status: string;
  source: string;
  received_at: string;
}

export interface IngestStatus {
  batch_id: string;
  status: string;
  progress?: number;
  result?: { facts: number; hypotheses?: number; pending_review?: number };
}

export class GaleedClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;

  /** @param baseUrl raiz do /v1 (ex.: "https://api.galeed.com/v1"). Barra final é normalizada.
   *  @param token   chave do bot (gld_live_...). Guardada em memória; NUNCA logada/serializada.
   *  @param timeoutMs teto por request (default 30s; /ask pode demorar — síntese de LLM). */
  constructor(baseUrl: string, token: string, timeoutMs = 30_000) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.token = token;
    this.timeoutMs = timeoutMs;
  }

  /** POST /v1/ask — o cérebro sintetiza a resposta (gasta LLM). */
  ask(question: string): Promise<AskResult> {
    return this.request<AskResult>("POST", "/ask", { question });
  }

  /** GET /v1/facts — fatos tipados, paginados por cursor. */
  facts(params: FactsParams = {}): Promise<FactsResult> {
    const qs = new URLSearchParams();
    if (params.dim) qs.set("dim", params.dim);
    if (params.area) qs.set("area", params.area);
    if (params.status) qs.set("status", params.status);
    if (params.as_of) qs.set("as_of", params.as_of);
    if (params.min_confidence !== undefined) qs.set("min_confidence", String(params.min_confidence));
    if (params.limit !== undefined) qs.set("limit", String(params.limit));
    if (params.cursor) qs.set("cursor", params.cursor);
    const query = qs.toString();
    return this.request<FactsResult>("GET", `/facts${query ? `?${query}` : ""}`);
  }

  /** POST /v1/ingest — enfileira conteúdo cru pra organização (requer can_ingest → 403 sem ela). */
  ingest(body: IngestBody): Promise<IngestAccepted> {
    return this.request<IngestAccepted>("POST", "/ingest", body);
  }

  /** GET /v1/ingest/:id — status público do batch (polling até "organized"|"failed"). */
  ingestStatus(batchId: string): Promise<IngestStatus> {
    return this.request<IngestStatus>("GET", `/ingest/${encodeURIComponent(batchId)}`);
  }

  /** Núcleo do fetch: Bearer auth, timeout via AbortSignal, !ok → GaleedApiError sem vazar o token. */
  private async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          // O TOKEN VIVE SÓ AQUI. Nunca é ecoado em erro/log abaixo.
          authorization: `Bearer ${this.token}`,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      // erro de rede/timeout — NÃO inclui a URL com qualquer credencial (não há), nem o token.
      if (e instanceof DOMException && e.name === "TimeoutError") {
        throw new GaleedApiError(0, `tempo esgotado após ${this.timeoutMs}ms ao chamar ${method} ${path}`, "");
      }
      const reason = e instanceof Error ? e.message : String(e);
      throw new GaleedApiError(0, `falha de rede ao chamar ${method} ${path}: ${reason}`, "");
    }

    const text = await res.text();
    if (!res.ok) {
      // corpo do erro do gateway é JSON { error } — extraímos a mensagem. Nunca contém o token.
      let serverMsg = text;
      try {
        const parsed = JSON.parse(text) as { error?: unknown };
        if (parsed && typeof parsed.error === "string") serverMsg = parsed.error;
      } catch {
        /* corpo não-JSON — usa o texto cru (sanitizado: é resposta do servidor, não a request) */
      }
      throw new GaleedApiError(res.status, `${method} ${path} → HTTP ${res.status}: ${serverMsg}`, serverMsg);
    }

    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new GaleedApiError(res.status, `${method} ${path} → resposta não é JSON válido`, "");
    }
  }
}
