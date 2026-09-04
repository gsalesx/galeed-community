#!/usr/bin/env -S npx tsx
/** Adaptador MCP fino — expõe o MESMO core do CLI como tools MCP (stdio).
 *  Para runtimes que falam MCP nativo (Claude Code etc.).
 *  Requer: npm i @modelcontextprotocol/sdk  (única dependência, só deste adaptador).
 *
 *  Config no cliente MCP:
 *    { "command": "npx", "args": ["tsx", "<este_arquivo>"], "env": { "GALEED_HOME": "<path>" } }
 */
import { brainHome } from "../core/platform/brain.ts";
import { search, retrieve, getPage, facts, timeline, graph, stats } from "../core/retrieval/query.ts";
import { capture } from "../core/ingestion/capture.ts";
import { ask } from "../core/retrieval/ask.ts";
import { getEngine } from "../core/platform/engine.ts";
import { authenticateToken } from "../core/access/principals.ts";
import { inScope, type Scope } from "../core/access/scope.ts";

const HOME = brainHome();

// Token de principal por env: o token CARREGA o grant. Se setado, resolvemos UMA vez no boot.
// Fail-closed: setado mas inválido/revogado/principal disabled → falha o boot (NÃO cai pra admin).
const principalToken = process.env.GALEED_PRINCIPAL_TOKEN;
const auth = principalToken ? await authenticateToken(HOME, principalToken) : null;
if (principalToken && !auth) {
  console.error("galeed MCP: GALEED_PRINCIPAL_TOKEN inválido/revogado ou principal inativo — abortando (fail-closed).");
  process.exit(1);
}
const scope: Scope | undefined = auth?.scope;

/** auditoria de leitura de principal (best-effort: não derruba a tool). */
async function logAccess(query: string, nReturned: number) {
  if (!scope) return;
  try {
    await (await getEngine(HOME)).appendAccessLog({
      principal_id: scope.principalId, query, areas_touched: scope.areas, n_returned: nReturned,
    });
  } catch { /* best-effort */ }
}

/** filtra itens-fonte (com `source_slug`) pelo escopo via página-fonte (não vaza fora do escopo). */
async function filterBySourceScope<T extends { source_slug?: string }>(items: T[]): Promise<T[]> {
  if (!scope || !items.length) return items;
  const pages = await (await getEngine(HOME)).pagesBySlug(items.map((i) => i.source_slug || ""));
  return items.filter((i) => {
    const p = pages.get(i.source_slug || "");
    return !!p && inScope({ type: p.type, tags: p.tags, sensitivity: p.sensitivity }, scope);
  });
}

const n = (r: unknown) => (Array.isArray(r) ? r.length : r ? 1 : 0);

// Import dinâmico para não acoplar o core ao SDK.
const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
const { CallToolRequestSchema, ListToolsRequestSchema } = await import("@modelcontextprotocol/sdk/types.js");

const TOOLS = [
  {
    name: "galeed_search",
    description: "Busca FTS no cérebro. args: { q, type? }",
    run: async (a: any) => {
      const r = await search(HOME, a.q, a.k ?? 8, a.type, scope);
      await logAccess(a.q, n(r));
      return r;
    },
  },
  {
    name: "galeed_retrieve",
    description:
      "Recupera contexto + citações para VOCÊ (agente) sintetizar. Prefira este a 'ask'. Cada trecho vem com um SELO " +
      "epistêmico (status, natureza, fonte, valid_from, via, cite) — use-o pra ponderar a confiança do trecho. args: { q, k? }",
    run: async (a: any) => {
      const r = await retrieve(HOME, a.q, a.k ?? 6, scope ? { scope } : undefined);
      await logAccess(a.q, n(r));
      return r;
    },
  },
  {
    name: "galeed_ask",
    description: "O cérebro sintetiza a resposta + lacunas (gasta LLM). args: { q }",
    run: async (a: any) => {
      const r = await ask(HOME, a.q, a.k ?? 6, scope);
      await logAccess(a.q, 1);
      return r;
    },
  },
  {
    name: "galeed_get",
    description: "Devolve uma página por slug. args: { slug }",
    run: async (a: any) => {
      const page = await getPage(HOME, a.slug);
      if (scope) {
        // não vaza fonte fora do escopo: nega se a página não passa no filtro espelho.
        const ok = page && inScope({ type: (page as any).type, tags: (page as any).tags, sensitivity: (page as any).sensitivity }, scope);
        await logAccess(a.slug, ok ? 1 : 0);
        if (!ok) return { error: "fora do escopo" };
      }
      return page;
    },
  },
  {
    name: "galeed_facts",
    description:
      "Agrega fatos tipados. Fatos sobre entidades vêm com status/confiança/janela de validade (bitemporal). " +
      "args: { dimension, type?, asOf? (o que era verdade em DATA), currentOnly? }",
    run: async (a: any) => {
      const r = await facts(HOME, a.dimension, { type: a.type, asOf: a.asOf, currentOnly: a.currentOnly });
      if (scope) {
        const scoped = await filterBySourceScope(r);
        await logAccess(a.dimension, scoped.length);
        return scoped;
      }
      return r;
    },
  },
  {
    name: "galeed_timeline",
    description:
      "Linha do tempo bitemporal de uma ENTIDADE: como uma crença/valor evoluiu (ex.: o preço mudou de X→Y). " +
      "Mostra cada versão com janela de validade e status (vigente/arquivado). args: { entity, predicate? }",
    run: async (a: any) => {
      const r = await timeline(HOME, a.entity, { predicate: a.predicate });
      if (scope) {
        const scoped = await filterBySourceScope(r);
        await logAccess(a.entity, scoped.length);
        return scoped;
      }
      return r;
    },
  },
  {
    name: "galeed_graph",
    description: "Vizinhos no grafo. args: { slug }",
    run: async (a: any) => {
      if (scope) {
        // o nó precisa estar in-scope; senão nega (não revela vizinhança fora do escopo).
        const page = await getPage(HOME, a.slug);
        const ok = page && inScope({ type: (page as any).type, tags: (page as any).tags, sensitivity: (page as any).sensitivity }, scope);
        await logAccess(a.slug, ok ? 1 : 0);
        if (!ok) return { error: "fora do escopo" };
      }
      return graph(HOME, a.slug);
    },
  },
  {
    name: "galeed_capture",
    description: "Grava uma página nova. args: { text, type?, title? }",
    run: (a: any) => {
      // v1 = só-leitura: principal (com token) NÃO escreve. Admin (sem token) segue podendo.
      if (scope) throw new Error("escrita não permitida p/ principal (v1 é só-leitura)");
      return capture({ home: HOME, text: a.text, type: a.type, title: a.title });
    },
  },
  { name: "galeed_stats", description: "Contagens do cérebro.", run: () => stats(HOME) },
];

const server = new Server({ name: "galeed", version: "0.1.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: { type: "object", properties: { q: { type: "string" }, slug: { type: "string" }, dimension: { type: "string" }, type: { type: "string" }, text: { type: "string" }, title: { type: "string" }, k: { type: "number" }, entity: { type: "string" }, predicate: { type: "string" }, asOf: { type: "string" }, currentOnly: { type: "boolean" } } },
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req: any) => {
  const tool = TOOLS.find((t) => t.name === req.params.name);
  if (!tool) throw new Error(`tool desconhecida: ${req.params.name}`);
  const result = await tool.run(req.params.arguments ?? {});
  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
});

await server.connect(new StdioServerTransport());
console.error(`galeed MCP no ar (brain: ${HOME}, principal: ${auth ? auth.principal.id + " [escopado]" : "admin"})`);
