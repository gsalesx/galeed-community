---
name: galeed-rodar
description: Use quando o aluno quiser subir/rodar o Galeed (Docker ou dev local), rodar os casos demo, ou quando "não sobe", "porta ocupada", "tela em branco", "npm run dev dá erro".
---

# Rodar o Galeed

## Produção do aluno: Docker (recomendado)

```bash
cp .env.docker.example .env      # funciona sem nenhuma chave
docker compose --profile app up -d --build
```

Acesse **http://localhost** (porta 80 ocupada? `GALEED_HTTP_PORT=8080` no `.env`).
Sobe: painel (Caddy, que também roteia `/api`, `/v1` e `/docs`), workers e
Postgres+pgvector (porta 5434 no host).

## Dev local (mexer no código)

```bash
docker compose up -d     # SÓ o Postgres (5434)
cp .env.example .env
npm ci
npm run dev              # painel :5173 + BFF :8789 + API pública :8790 + worker
```

Processos separados se precisar: `npm run dev:bff` · `npm run worker` ·
`npm run gateway:dev` · `npm run dev:web`.

## Chaves (todas opcionais)

- `OPENAI_API_KEY` → busca semântica (sem ela: palavra-chave; resto funciona).
- `ANTHROPIC_API_KEY` → extração de fatos + perguntar. Sem ela, o servidor usa o
  binário `claude` da máquina (assinatura), se existir. Sem nenhum: captura e busca
  funcionam; extração/perguntar avisam o que falta.

## Ver funcionando com dados reais (demos)

```bash
npm run caso -- --caso imobiliaria --token gld_live_SUA_CHAVE \
  --email voce@empresa.com --senha ... --brain imobiliaria
```

4 casos prontos (imobiliaria, distribuidora, clinica-estetica, consultoria) — ver `CASOS.md`.

## Quando não sobe

| Sintoma | Checagem |
| --- | --- |
| upload preso em "na fila" | o **worker** está rodando? (`npm run dev` sobe; avulso é `npm run worker`) |
| erro de conexão com banco | `docker compose up -d` rodou? porta é **5434** (não 5432) |
| painel em branco no :5173 | BFF caiu? veja o terminal do `npm run dev` |
| `npx`/npm falha com EACCES no cache | cache do npm com arquivos root-owned: `sudo chown -R $(id -u):$(id -g) ~/.npm` |
| Docker: mudou código e nada mudou | `docker compose --profile app up -d --build` (o `--build` importa) |
| teste: `npm test` na raiz | suíte unit não precisa de banco; `test:all` precisa do Postgres |
