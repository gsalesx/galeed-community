---
name: galeed-conectar-ia
description: Use quando o aluno quiser plugar uma IA/agente no cérebro — "conectar o Claude", "MCP", "meu agente perguntar pro Galeed", chave de bot, API /v1 — ou quando o agente conectado responde vazio/401.
---

# Conectar uma IA ao cérebro

Três portas, da mais simples pra mais crua. Em TODAS: a chave `gld_live_...` nasce no
painel (**Conectar → chaves do cérebro**) e o escopo viaja com ela.

## A regra nº 1 (causa 90% dos "responde vazio")

Bot que **lê** o cérebro precisa ser convidado em **Acesso** com
**"Todas as áreas (acesso total)"**. O escopo por área é fail-closed: conteúdo que entra
em modo livre (sem etiqueta de área) fica INVISÍVEL pra chave escopada — o bot não erra,
ele simplesmente não vê.

## 1. MCP — Claude Code, Claude Desktop, Cursor… (recomendado)

```json
{ "mcpServers": { "galeed": {
    "command": "npx", "args": ["-y", "@galeed/mcp"],
    "env": { "GALEED_KEY": "gld_live_...", "GALEED_URL": "https://seu-galeed" } } } }
```

Template pronto: `mcp.json.example` (raiz). O pacote é HTTP-only (`apps/mcp/`, README lá):
não precisa do banco nem do código. 4 tools: `galeed_ask`, `galeed_facts`,
`galeed_ingest` (requer `can_ingest`), `galeed_ingest_status`.

## 2. API `/v1` direto (qualquer linguagem)

```bash
curl -X POST "https://seu-galeed/v1/ask" \
  -H "Authorization: Bearer gld_live_..." -H "Content-Type: application/json" \
  -d '{ "question": "O que decidimos sobre preços?" }'
```

- `POST /v1/ask` → `{ answer, facts[], withheld }` (gasta LLM)
- `GET /v1/facts?area=...&status=...` → fatos tipados, sem IA
- `POST /v1/ingest` e `POST /v1/ingestors/<slug>` → escrever (requer `can_ingest`)
- O **cérebro vem do token** — não existe `?brain=` na borda pública.
- Referência completa: site `/docs` (Docker) ou `apps/docs/`.

## 3. Automação sem código

n8n e Zapier têm skill própria (galeed-n8n, galeed-zapier).

## Erros comuns

| Sintoma | Causa |
| --- | --- |
| respostas vazias / `withheld` alto | bot sem acesso total (regra nº 1) |
| 401 | chave revogada/errada; god-token (API_TOKEN) NÃO autentica no `/v1` por design |
| 403 no ingest | chave sem `can_ingest` |
| MCP não conecta | `GALEED_URL` sem https/host errado; teste `curl $URL/v1/ingestors` com a chave |
| agente "esquece" | o Galeed é a memória — mande o agente GRAVAR decisões via `galeed_ingest` |
