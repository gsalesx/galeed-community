---
name: galeed-mapa
description: Use quando o aluno quiser entender o projeto Galeed — "como funciona", "onde fica", "o que é cada pasta/app", "por onde entra o dado", "onde mexer pra mudar X" — antes de explorar o código às cegas.
---

# Mapa do Galeed

O Galeed é a memória do negócio: conteúdo cru entra por UM funil (dedupe + fila +
extração de fatos com receita), vira fatos bitemporais com fonte citada, e sai por
painel, API `/v1`, MCP e webhooks.

## O monorepo

| Pasta | O que é | Mexa aqui quando… |
| --- | --- | --- |
| `apps/server/src/core/` | o cérebro: ingestão, extração, recuperação, acesso | mudar COMO o Galeed pensa |
| `apps/server/src/connectors/web-server.ts` | BFF `/api` (painel; sessão por cookie) | tela precisa de dado novo |
| `apps/server/src/connectors/gateway-server.ts` | API pública `/v1` (Bearer `gld_`) | mudar o contrato público |
| `apps/server/src/connectors/ingest-worker.ts` | worker: fila, janelas de chat, sync GitHub | jobs/agendados |
| `apps/web/src/screens/` | painel React (uma pasta por tela) | UI |
| `apps/docs/` | site de documentação (`/docs` no Docker) | docs pro aluno |
| `apps/mcp/`, `apps/n8n-nodes-galeed/`, `apps/zapier-galeed/` | integrações distribuíveis | plugar IA/automação |

## O caminho do dado (o que importa entender)

```
canal → ingestor.normalize() → fila (galeed_ingest_jobs) → worker extrai fatos
      → receita/gate → fatos com selo → páginas + dossiês → painel / /v1 / MCP / espelho GitHub
```

- **Ingestores**: `apps/server/src/core/ingestion/ingestors/` (1 arquivo cada — ver skill galeed-criar-ingestor).
- **Extração**: `core/ingestion/process-blob-job.ts` (tags `src:`, `canal:`, `area:` nascem aqui).
- **Fatos/consulta**: `core/retrieval/` (timeline, ask).
- **Acesso** (quem vê o quê): `core/access/` — escopo por área é fail-closed; `'*'` = acesso total.
- **Espelho GitHub**: `core/platform/github-sync.ts`.

## Convenções que pegam desprevenido

- Sensibilidade default é `restrito` (falha fechado) — bot sem acesso total não vê modo livre.
- Ingestão é assíncrona SEMPRE: sem o worker rodando, tudo fica "na fila".
- jsonb com a lib `postgres` exige `sql.json(...)` (interpolar string dupla-serializa).
- Testes: `npm test` na RAIZ (unit, sem banco); `npm run test:all` exige Postgres (`docker compose up -d`).

Guias: `README.md` (mapa geral) · `INGESTORES.md` (entrada) · `CASOS.md` (demos) · site em `/docs`.
