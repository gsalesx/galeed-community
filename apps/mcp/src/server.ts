/** Servidor MCP público do Galeed (HTTP-only). Mesmo IDIOMA do SDK que src/mcp/server.ts
 *  (Server + StdioServerTransport + CallToolRequestSchema/ListToolsRequestSchema), mas SEM tocar
 *  DB/core: cada tool chama o GaleedClient (fetch puro contra o gateway /v1) e devolve o JSON.
 *
 *  Erros do gateway viram mensagens CLARAS e ACIONÁVEIS pro agente (401/402/403/410/429 → o que fazer).
 *  O token NUNCA é logado nem aparece numa resposta de tool. */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { GaleedClient, GaleedApiError, type FactsParams, type IngestBody } from "./client.js";

/** Traduz um erro do gateway numa mensagem que orienta o agente a agir (sem expor token/internals). */
function explainError(e: unknown): string {
  if (e instanceof GaleedApiError) {
    switch (e.status) {
      case 401:
        return "Galeed: token inválido ou revogado (401). Verifique a variável GALEED_TOKEN (chave gld_live_...) na config do MCP.";
      case 402:
        return "Galeed: limite diário de custo de LLM atingido neste cérebro (402). A síntese (galeed_ask) fica indisponível hoje — use galeed_facts (não gasta LLM) ou tente novamente amanhã (UTC).";
      case 403:
        return "Galeed: este token NÃO tem permissão de escrita (can_ingest) (403). galeed_ingest está bloqueado — peça ao dono do cérebro um token com can_ingest. As tools de leitura (galeed_ask, galeed_facts) seguem funcionando.";
      case 410:
        return `Galeed: recurso desligado de propósito (410): ${e.body || e.message}. Envie o conteúdo cru no campo 'content' (ingestão por URL/arquivo está desativada por segurança).`;
      case 429:
        return "Galeed: limite de taxa atingido (429). Aguarde alguns segundos e tente de novo (respeite o Retry-After).";
      case 400:
        return `Galeed: requisição inválida (400): ${e.body || e.message}. Ajuste os argumentos e tente de novo.`;
      case 404:
        return `Galeed: não encontrado (404): ${e.body || e.message}.`;
      case 0:
        return `Galeed: falha de conexão com o gateway — ${e.message}. Verifique GALEED_API_URL e a rede.`;
      default:
        return `Galeed: erro do gateway (HTTP ${e.status}): ${e.body || e.message}.`;
    }
  }
  return `Galeed: erro inesperado — ${e instanceof Error ? e.message : String(e)}`;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (client: GaleedClient, args: Record<string, unknown>) => Promise<unknown>;
}

const TOOLS: ToolDef[] = [
  {
    name: "galeed_ask",
    description:
      "Pergunta ao cérebro do Galeed em linguagem natural: ele SINTETIZA uma resposta a partir da memória " +
      "organizada (gasta LLM). Devolve { answer, facts[], withheld }. Use quando quiser uma resposta pronta " +
      "com citações; prefira galeed_facts pra varrer fatos sem custo de LLM.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "A pergunta em linguagem natural." },
      },
      required: ["question"],
    },
    run: (client, a) => client.ask(String(a.question ?? "")),
  },
  {
    name: "galeed_facts",
    description:
      "Lista fatos tipados do cérebro (bitemporais: cada fato tem status/confiança/janela de validade). " +
      "NÃO gasta LLM. Só devolve fatos VERIFICADOS (não-verificados ficam de fora). Filtros: dim (dimensão, " +
      "default 'decisions'), area, status (fact|archived), as_of (o que era verdade NESTA data ISO), " +
      "min_confidence (0–1), limit. Pagina por cursor (devolvido em { cursor } quando há mais).",
    inputSchema: {
      type: "object",
      properties: {
        dim: { type: "string", description: "Dimensão dos fatos (ex.: decisions, action_items, precos). Default: decisions." },
        area: { type: "string", description: "Filtra por área de conhecimento (substring)." },
        status: { type: "string", enum: ["fact", "archived"], description: "fact = vigente; archived = superado." },
        as_of: { type: "string", description: "Data ISO 8601 — recorte temporal (o que era verdade nesta data)." },
        min_confidence: { type: "number", minimum: 0, maximum: 1, description: "Confiança mínima (0–1)." },
        limit: { type: "number", minimum: 1, maximum: 200, description: "Máx. de fatos por página (default 50, teto 200)." },
        cursor: { type: "string", description: "Cursor opaco da página seguinte (do retorno anterior)." },
      },
    },
    run: (client, a) => {
      const params: FactsParams = {};
      if (typeof a.dim === "string") params.dim = a.dim;
      if (typeof a.area === "string") params.area = a.area;
      if (a.status === "fact" || a.status === "archived") params.status = a.status;
      if (typeof a.as_of === "string") params.as_of = a.as_of;
      if (typeof a.min_confidence === "number") params.min_confidence = a.min_confidence;
      if (typeof a.limit === "number") params.limit = a.limit;
      if (typeof a.cursor === "string") params.cursor = a.cursor;
      return client.facts(params);
    },
  },
  {
    name: "galeed_ingest",
    description:
      "Entrega conteúdo cru (transcrição, e-mail, nota) pro Galeed ORGANIZAR na memória. Assíncrono: " +
      "devolve 202 { batch_id, status } e você faz polling com galeed_ingest_status até 'organized'. " +
      "REQUER um token com permissão de escrita (can_ingest) — sem ela o Galeed responde 403 com orientação.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "Rótulo da fonte (ex.: 'reuniao-cliente', 'email'). Vira a receita de extração." },
        content: { type: "string", description: "O conteúdo CRU em texto (não URL, não arquivo)." },
        occurred_at: { type: "string", description: "Quando o conteúdo ocorreu (data ISO 8601). Ancora a linha do tempo." },
        sensitivity: {
          type: "string",
          enum: ["open", "internal", "confidential", "secret"],
          description: "Nível de sensibilidade do conteúdo.",
        },
      },
      required: ["source", "content"],
    },
    run: (client, a) => {
      const body: IngestBody = { source: String(a.source ?? ""), content: String(a.content ?? "") };
      if (typeof a.occurred_at === "string") body.occurred_at = a.occurred_at;
      if (a.sensitivity === "open" || a.sensitivity === "internal" || a.sensitivity === "confidential" || a.sensitivity === "secret") {
        body.sensitivity = a.sensitivity;
      }
      return client.ingest(body);
    },
  },
  {
    name: "galeed_ingest_status",
    description:
      "Consulta o status de um batch de ingestão pelo batch_id (devolvido por galeed_ingest). " +
      "Status público: organizing → indexed → organized (sucesso) | failed. Faça polling até um estado terminal.",
    inputSchema: {
      type: "object",
      properties: {
        batch_id: { type: "string", description: "O batch_id retornado por galeed_ingest." },
      },
      required: ["batch_id"],
    },
    run: (client, a) => client.ingestStatus(String(a.batch_id ?? "")),
  },
];

/** Monta o MCP Server já fiado ao client. O caller (index.ts) conecta o StdioServerTransport. */
export function buildServer(client: GaleedClient): Server {
  const server = new Server({ name: "galeed", version: "0.1.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = TOOLS.find((t) => t.name === req.params.name);
    if (!tool) {
      return { isError: true, content: [{ type: "text", text: `Galeed: tool desconhecida: ${req.params.name}` }] };
    }
    try {
      const result = await tool.run(client, (req.params.arguments ?? {}) as Record<string, unknown>);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (e) {
      // erro vira mensagem acionável pro agente (e isError pro runtime), NUNCA vaza o token.
      return { isError: true, content: [{ type: "text", text: explainError(e) }] };
    }
  });

  return server;
}

export { StdioServerTransport };
