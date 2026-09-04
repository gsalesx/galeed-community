# @galeed/mcp

Servidor [MCP](https://modelcontextprotocol.io) público do **Galeed**. Dá à sua IA a memória organizada do Galeed — perguntar, varrer fatos e ingerir conteúdo — via o gateway HTTP `/v1`.

**HTTP-only.** Não precisa do banco nem do código do Galeed: só uma chave de bot (`gld_live_...`) e a internet. Roda com um `npx`.

```bash
npx @galeed/mcp
```

## O que ele faz

Expõe 4 tools pro seu agente, cada uma mapeada 1:1 numa rota da borda pública `/v1`:

| Tool | Rota `/v1` | O que faz | Custo |
| --- | --- | --- | --- |
| `galeed_ask` | `POST /v1/ask` | Cérebro sintetiza uma resposta + citações | gasta LLM |
| `galeed_facts` | `GET /v1/facts` | Lista fatos tipados (bitemporais), paginado | grátis |
| `galeed_ingest` | `POST /v1/ingest` | Entrega conteúdo cru pra organizar (assíncrono) | requer `can_ingest` |
| `galeed_ingest_status` | `GET /v1/ingest/:id` | Status do batch de ingestão | grátis |

A autenticação é por `Authorization: Bearer <token>`. O **cérebro vem do token** — você só enxerga a memória do tenant da sua chave.

## Pegar a chave do bot

1. No painel do Galeed, abra o cérebro que o bot vai acessar.
2. Crie um **token de bot** (`gld_live_...`).
3. Se o bot precisar **escrever** (usar `galeed_ingest`), marque a permissão **can_ingest** ao criar o token. Sem ela, `galeed_ingest` responde com uma mensagem clara de 403 (as tools de leitura seguem funcionando).
4. Guarde a chave num lugar seguro — ela **não** deve ir pro controle de versão.

## Plugar no Claude Desktop / Claude Code

Copie `mcp.json.example` pra sua config de MCP (no Claude Desktop: `claude_desktop_config.json`) e troque o token:

```json
{
  "mcpServers": {
    "galeed": {
      "command": "npx",
      "args": ["@galeed/mcp"],
      "env": {
        "GALEED_API_URL": "https://api.galeed.com/v1",
        "GALEED_TOKEN": "gld_live_..."
      }
    }
  }
}
```

No **Claude Code**:

```bash
claude mcp add galeed -e GALEED_TOKEN=gld_live_... -- npx @galeed/mcp
```

Reinicie o cliente. As tools `galeed_*` aparecem pro agente.

## Configuração (env)

| Variável | Obrigatória | Default | Descrição |
| --- | --- | --- | --- |
| `GALEED_TOKEN` | **sim** | — | Chave do bot (`gld_live_...`). Falha explícita se ausente. **Nunca é logada.** |
| `GALEED_API_URL` | não | `https://api.galeed.com/v1` | Raiz do gateway `/v1`. |
| `GALEED_TIMEOUT_MS` | não | `30000` | Teto por request (ms). `galeed_ask` pode demorar — síntese de LLM. |

> ⚠️ **Use sempre `https://`** no `GALEED_API_URL`. A chave (`gld_live_...`) viaja no header `Authorization`; sob `http://` ela iria em texto claro na rede. O default já é HTTPS — só aponte para um `http://` se for um ambiente local de teste seu.

## Erros que o agente vai ver (e o que fazer)

O servidor traduz os status do gateway em mensagens acionáveis:

- **401** — token inválido/revogado → confira `GALEED_TOKEN`.
- **402** — limite diário de custo de LLM atingido → use `galeed_facts` (sem LLM) ou tente amanhã.
- **403** — token sem `can_ingest` → `galeed_ingest` bloqueado; peça um token com escrita.
- **410** — ingestão por URL/arquivo está desligada → mande o conteúdo cru em `content`.
- **429** — rate limit → aguarde e tente de novo.

## Privacidade

O token vive só em memória, é enviado apenas no header `Authorization` e **nunca** aparece em logs ou mensagens de erro.

## Desenvolvimento

```bash
npm install
npm run dev     # roda direto do TypeScript via tsx
npm run build   # bundle ESM → dist/index.js (o SDK fica externo)
```

Licença MIT.
