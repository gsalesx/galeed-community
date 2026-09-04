/** Entrypoint do @galeed/mcp (HTTP-only). Lê a config por env, monta o GaleedClient e conecta o
 *  servidor MCP via stdio. Fail-fast se a chave não foi configurada.
 *
 *  ENV:
 *    GALEED_TOKEN    (OBRIGATÓRIO) chave do bot — gld_live_...   ← NUNCA é logada
 *    GALEED_API_URL  (opcional)    raiz do /v1 (default https://api.galeed.com/v1)
 *    GALEED_TIMEOUT_MS (opcional)  teto por request em ms (default 30000) */
import { GaleedClient } from "./client.js";
import { buildServer, StdioServerTransport } from "./server.js";

const DEFAULT_API_URL = "https://api.galeed.com/v1";

async function main(): Promise<void> {
  const token = process.env.GALEED_TOKEN?.trim();
  if (!token) {
    // FAIL-FAST: sem chave não há memória. Mensagem clara no stderr (stdout é o canal MCP).
    console.error(
      "galeed-mcp: variável GALEED_TOKEN ausente. Configure a chave do seu bot (gld_live_...) no env do servidor MCP.\n" +
        "Exemplo (mcp.json):\n" +
        '  "galeed": { "command": "npx", "args": ["@galeed/mcp"], "env": { "GALEED_TOKEN": "gld_live_..." } }',
    );
    process.exit(1);
  }

  const baseUrl = process.env.GALEED_API_URL?.trim() || DEFAULT_API_URL;
  const timeoutRaw = Number(process.env.GALEED_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : 30_000;

  const client = new GaleedClient(baseUrl, token, timeoutMs);
  const server = buildServer(client);

  await server.connect(new StdioServerTransport());
  // stderr só — JAMAIS imprime o token (nem prefixo/sufixo dele).
  console.error(`galeed MCP no ar (HTTP-only) → ${baseUrl}`);
}

main().catch((e) => {
  console.error(`galeed-mcp: falha ao iniciar — ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
