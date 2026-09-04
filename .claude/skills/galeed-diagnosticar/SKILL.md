---
name: galeed-diagnosticar
description: Use quando algo do Galeed "não funciona" — ingestão presa na fila, fato não aparece, bot responde vazio, sync do GitHub com erro, busca fraca, webhook não chega — antes de sair caçando no código.
---

# Diagnosticar o Galeed

Sempre na ordem: **sintoma → onde olhar → causa provável**. O Galeed falha FECHADO e
assíncrono — a maioria dos "bugs" é worker parado, escopo ou janela.

## Tabela de sintomas

| Sintoma | Olhe primeiro | Causa provável |
| --- | --- | --- |
| Upload/webhook preso em "na fila" | o worker está rodando? (`npm run dev` sobe; Docker: `docker compose ps`) | worker parado — ingestão é 100% assíncrona |
| Chat ingerido mas memória não aparece | resposta foi `202 buffered`? | **janela de conversa**: fecha com ~30 min de silêncio ou 100 msgs; worker fecha |
| Ingeriu mas extraiu ZERO fatos | painel → Saúde; terminal do worker | sem `ANTHROPIC_API_KEY` e sem binário `claude`; ou job em `error` na fila |
| Bot/integração responde vazio | painel → Acesso | chave sem **acesso total** — modo livre é invisível pra escopo por área (fail-closed) |
| 401 na API `/v1` | — | chave revogada/errada; god-token não vale na borda pública |
| 403 ao ingerir | painel → Conectar | chave sem `can_ingest` |
| Busca ruim/nada acha | `.env` | sem `OPENAI_API_KEY` = busca por palavra-chave (semântica desligada) |
| Espelho GitHub parado | Ajustes → GitHub do cérebro (status/erro da última sync) | PAT expirado/sem contents:write; 5xx do GitHub re-tenta sozinho no próximo tick (~2 min) |
| Arquivo não some da `entrada/` | fila (painel → Adicionar) | só some quando o job fica `done`; formato não aceito nunca é apagado |
| Espelho GitHub vazio | Ajustes → "memórias retidas" | filtro de sigilo — "O que espelhar" |
| Evento duplicado | payload | `ref`/`externalRef` instável na origem |

## Onde estão as evidências

- **Painel → Saúde**: visão geral do cérebro.
- **Painel → Adicionar**: status da fila (job a job).
- **Terminal do worker**: logs de extração, janelas e github-sync (`[worker] ...`).
- **Banco** (avançado): tabela `galeed_ingest_jobs` (status/attempts/error) —
  `docker exec galeed-db psql -U galeed -d galeed`.
- **Fila via CLI**: `npm run galeed -- ingestor list` e `ingestor test <slug> --from payload.json`.

## Regra de ouro

Antes de mexer no código: reproduza com `curl`, olhe o status do job na fila e o log do
worker. 9 de 10 problemas se resolvem com: subir o worker, dar acesso total ao bot, ou
esperar/forçar a janela fechar.
