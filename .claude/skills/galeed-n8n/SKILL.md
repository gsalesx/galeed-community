---
name: galeed-n8n
description: Use quando o aluno quiser montar fluxo/automação no n8n com o Galeed — "fluxo n8n", "workflow", "ligar o n8n no cérebro", instalar o nó, credencial, ou quando o nó Galeed não aparece/dá 401/403.
---

# Fluxos n8n com o Galeed

O nó nativo vive em `apps/n8n-nodes-galeed/` (README completo lá). 8 operações:
ingestão (texto · mensagem de chat · transcrição de reunião · formulário/lead ·
planilha/tabela · payload cru pra qualquer slug) + memória (perguntar · buscar fatos).

## Instalar

- **n8n self-hosted (npm)**: Settings → Community Nodes → Install → `n8n-nodes-galeed`.
- **Local sem npm** (validado): `npm run build` em `apps/n8n-nodes-galeed/`, depois
  `docker cp dist/credentials` e `dist/nodes` pra `/home/node/.n8n/custom/` do container,
  `chown -R node:node` e restart (comandos exatos no README do pacote).

## Credencial "Galeed API"

- URL do Galeed **sem** `/v1` — n8n em Docker + Galeed no host = `http://host.docker.internal:8790`.
- Chave `gld_live_...` do painel (**Conectar → chaves**), com `can_ingest` pra ingerir.
- Botão de testar credencial chama `GET /v1/ingestors` — se listar, conexão ok.
- Bot vai **ler** (Perguntar/Buscar fatos)? Convide em **Acesso → "Todas as áreas
  (acesso total)"** — senão o modo livre é invisível (fail-closed) e a resposta vem vazia.

## Receitas que funcionam

| Fluxo | Trigger n8n | Operação Galeed |
| --- | --- | --- |
| Formulário → lead na memória | Webhook/Forms | Enviar formulário/lead |
| Reunião transcrita → memória | Fireflies/tl;dv (buscar transcript) | Enviar transcrição |
| Planilha de preços → fatos NA HORA | Google Sheets row | Enviar planilha/tabela |
| Chat (Telegram, site…) → 1 memória por conversa | mensagem nova | Enviar mensagem de chat (janela automática) |
| Responder com a memória | qualquer | Perguntar → use `answer` no passo seguinte |

Sem o nó instalado? Nó **HTTP Request** direto em `POST {URL}/v1/ingestors/<slug>` com
header `Authorization: Bearer gld_live_...` — payloads em `INGESTORES.md`.

## Erros comuns

| Sintoma | Causa |
| --- | --- |
| nó não aparece após instalar custom | faltou `chown node:node` ou restart do container |
| 401 | chave errada/revogada; ou URL com `/v1` duplicado |
| 403 no ingerir | chave sem `can_ingest` |
| Perguntar devolve vazio | bot sem acesso total (Acesso → Todas as áreas) |
| `ECONNREFUSED` no docker | use `host.docker.internal`, não `localhost` |
