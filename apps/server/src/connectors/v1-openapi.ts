/** OpenAPI 3.1 da API pública /v1 — fonte ÚNICA (servida em GET /v1/openapi.json). Pensado pra
 *  importação direta como Action de GPT: bearer auth + paths reais do gateway. NÃO documenta o BFF. */
export function buildV1OpenApi(baseUrl: string): object {
  return {
    openapi: "3.1.0",
    info: {
      title: "Galeed — API pública /v1",
      version: "1.0.0",
      description: "Leia e alimente a memória de um cérebro Galeed. O cérebro é derivado do token (Bearer gld_live_…); não se escolhe brain na chamada.",
    },
    servers: [{ url: baseUrl }],
    security: [{ bearerAuth: [] }],
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", description: "Chave do cérebro: gld_live_…" },
      },
    },
    paths: {
      "/v1/ask": {
        post: {
          operationId: "ask",
          summary: "Pergunta ancorada (resposta sintetizada + citações). Gasta crédito (LLM).",
          requestBody: {
            required: true,
            content: { "application/json": { schema: {
              type: "object", required: ["question"],
              properties: { question: { type: "string", description: "A pergunta em linguagem natural." } },
            } } },
          },
          responses: {
            "200": { description: "Resposta ancorada", content: { "application/json": { schema: {
              type: "object",
              properties: {
                answer: { type: "string" },
                facts: { type: "array", items: { type: "object" } },
                withheld: { type: "object", properties: { count: { type: "integer" }, reason: { type: "string" } } },
              },
            } } } },
            "401": { description: "token inválido/revogado" },
            "402": { description: "sem crédito / pagamento pendente" },
            "429": { description: "rate limit" },
          },
        },
      },
      "/v1/facts": {
        get: {
          operationId: "facts",
          summary: "Lista fatos tipados (sem LLM, grátis). Fatos ainda não-verificados NÃO são servidos.",
          parameters: [
            { name: "dim", in: "query", description: "Dimensão dos fatos (ex.: decisions, action_items, precos). Default: decisions.", schema: { type: "string", default: "decisions" } },
            { name: "area", in: "query", schema: { type: "string" } },
            { name: "status", in: "query", schema: { type: "string" } },
            { name: "as_of", in: "query", schema: { type: "string" } },
            { name: "min_confidence", in: "query", schema: { type: "number" } },
            { name: "limit", in: "query", schema: { type: "integer" } },
            { name: "cursor", in: "query", schema: { type: "string" } },
          ],
          responses: { "200": { description: "Fatos", content: { "application/json": { schema: {
            type: "object", properties: { facts: { type: "array", items: { type: "object" } }, cursor: { type: "string" } },
          } } } } },
        },
      },
      "/v1/ingest": {
        post: {
          operationId: "ingest",
          summary: "Manda conteúdo cru pra organizar (requer chave com escrita / can_ingest).",
          requestBody: {
            required: true,
            content: { "application/json": { schema: {
              type: "object", required: ["source", "content"],
              properties: {
                source: { type: "string" }, content: { type: "string" },
                occurred_at: { type: "string" }, participants: { type: "array", items: { type: "string" } },
                sensitivity: { type: "string" },
              },
            } } },
          },
          responses: { "202": { description: "Em organização", content: { "application/json": { schema: {
            type: "object", properties: { batch_id: { type: "string" }, status: { type: "string" } },
          } } } }, "403": { description: "token sem can_ingest" } },
        },
      },
      "/v1/ingest/{id}": {
        get: {
          operationId: "ingestStatus",
          summary: "Status de um batch de ingestão.",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "Status do batch" } },
        },
      },
    },
  };
}
