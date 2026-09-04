<div align="center">

# galeed

### A memória do seu negócio — uma camada de memória para IA sobre Postgres + pgvector.

**Captura, organiza e lembra. E responde com fontes.**

![Accelera 360](https://img.shields.io/badge/Accelera%20360-Community%20Edition-5A3EE0)
![Stack](https://img.shields.io/badge/stack-TypeScript%20%C2%B7%20Postgres%2Bpgvector-8A54FB)
[![Licença BSL 1.1](https://img.shields.io/badge/licen%C3%A7a-BSL%201.1-5A3EE0)](./LICENSE)
![PT--BR](https://img.shields.io/badge/idioma-PT--BR-yellow)

</div>

---

O Galeed é um cérebro de conhecimento para o seu negócio: você ingere conversas,
documentos e dados, ele extrai fatos com linha do tempo, organiza por áreas com
controle de acesso, e responde perguntas com as fontes ancoradas — pelo painel
web, pela API pública `/v1` (`Bearer gld_`), por MCP (Claude Code, Cursor etc.),
por webhooks e pelas integrações prontas (WhatsApp, Chatwoot, n8n, Zapier,
GitHub, planilhas, formulários — ver [Integrações](#integrações-como-o-conteúdo-entra-e-sai)).

Esta é a **edição community**, distribuída aos alunos e membros do ecossistema
Accelera 360. Ela é sincronizada periodicamente a partir do produto principal —
cada sync é um commit `sync vX.Y.Z` com tag.

---

## O que você pode (e não pode) fazer

O código está sob a **Business Source License 1.1** ([LICENSE](./LICENSE)),
da Accelera 360 Company LTDA. Em bom português:

- **PODE:** rodar na sua empresa (inclusive em produção), modificar à
  vontade, construir produtos e automações em cima, e prestar serviços aos
  seus clientes usando o Galeed como ferramenta.
- **NÃO PODE:** oferecer o próprio Galeed a terceiros como serviço
  hospedado/gerenciado que concorra com a versão paga da Accelera 360
  (ex.: vender "Galeed as a Service").
- Em **01/07/2030** esta versão vira **Apache 2.0** (open source pleno).

Dúvidas sobre licenciamento comercial: kelvin.cleto@accelera360.com.br.

## Subir com Docker (recomendado)

Pré-requisitos: Docker (com Compose) e git.

```bash
cp .env.docker.example .env    # ajuste se quiser; funciona sem chaves
docker compose --profile app up -d --build
```

Acesse **http://localhost** (porta configurável via `GALEED_HTTP_PORT` no
`.env`; use 8080 se a 80 estiver ocupada). Crie sua conta na tela inicial.

O que sobe: painel web (Caddy, que também roteia `/api` → BFF e `/v1` →
gateway da API), workers de ingestão/webhook e Postgres+pgvector (porta
5434 no host).

Chaves opcionais no `.env`:

- `OPENAI_API_KEY` — liga a busca semântica (sem ela, cai para
  busca por palavra-chave; todo o resto funciona).
- `ANTHROPIC_API_KEY` — usada na extração de fatos e na síntese de
  respostas (`ask`).

## Integrações: como o conteúdo entra (e sai)

Tudo entra por **um funil só** (dedupe + fila + extração de fatos). O que muda é a
porta. Guia completo com exemplos copy-paste: **[INGESTORES.md](./INGESTORES.md)**.

| Canal | Como liga | Guia |
| --- | --- | --- |
| **WhatsApp** (Evolution API) | webhook `POST /v1/ingestors/evolution-whatsapp` — a conversa inteira vira UMA memória (janela) | [INGESTORES.md](./INGESTORES.md) |
| **Chatwoot** (omnichannel: WhatsApp, Instagram, Telegram, e-mail…) | webhook `message_created` → `/v1/ingestors/chatwoot` | [INGESTORES.md](./INGESTORES.md) |
| **Qualquer chat** (ManyChat, Telegram, livechat…) | `POST /v1/ingestors/chat` — janela de conversa de graça | [INGESTORES.md](./INGESTORES.md) |
| **Reuniões** (Fireflies, tl;dv, MeetGeek…) | `POST /v1/ingestors/notetaker` com a transcrição | [INGESTORES.md](./INGESTORES.md) |
| **Formulários/leads** (Google Forms, Typeform…) | `POST /v1/ingestors/formulario` | [INGESTORES.md](./INGESTORES.md) |
| **Planilhas** (preços, catálogo) | `POST /v1/ingestors/planilha` — cada linha vira fato NA HORA, sem IA | [INGESTORES.md](./INGESTORES.md) |
| **GitHub** (espelho navegável) | Ajustes → GitHub do cérebro: a memória vira um repo organizado pra pessoas; solte arquivos em `entrada/` que ele ingere | [INGESTORES.md](./INGESTORES.md) |
| **Pasta local** (Drive for Desktop, Dropbox…) | `npm run galeed -- pasta --dir ~/pasta` | [INGESTORES.md](./INGESTORES.md) |
| **n8n** | nó nativo **Galeed** (8 operações, ingestão + perguntar) | [apps/n8n-nodes-galeed](./apps/n8n-nodes-galeed/README.md) |
| **Zapier** | app oficial com 6 ações — ou "Webhooks by Zapier" hoje mesmo | [ZAPIER.md](./ZAPIER.md) |
| **Agentes de IA** (Claude, Cursor…) | MCP: `npx @galeed/mcp` com a chave do bot | [apps/mcp](./apps/mcp/README.md) |
| **O que você quiser** | escreva um ingestor em 1 arquivo (normalize puro) e ganhe webhook + fila + dedupe de graça | [INGESTORES.md](./INGESTORES.md) |

> Bot de integração que também **lê** o cérebro (Perguntar/Fatos)? Convide-o em
> **Acesso** com **"Todas as áreas (acesso total)"** — sem isso, o conteúdo que entra
> sem etiqueta de área fica invisível pro token (fail-closed por design).

Quer ver funcionando com dados de empresas reais? `npm run caso` roda casos
completos (clínica, imobiliária, distribuidora, consultoria) — [CASOS.md](./CASOS.md).

## O monorepo

| Pasta | O que é |
| --- | --- |
| `apps/web` | Painel (React + Vite) — onboarding conversacional, busca, perguntar, dossiês, acesso |
| `apps/server` | BFF (`/api`), gateway público (`/v1`), workers de ingestão/webhook, core do cérebro |
| `apps/docs` | Este site de documentação (Astro) — servido em `/docs` no Docker |
| `apps/mcp` | `@galeed/mcp` — servidor MCP HTTP-only pra plugar qualquer agente de IA |
| `apps/n8n-nodes-galeed` | Nós nativos do n8n (ingestão + memória) |
| `apps/zapier-galeed` | Zapier App oficial (Platform CLI, 6 ações) |

## Skills — o repo te ensina a mexer nele

Abriu este projeto no **Claude Code**? Ele já descobre sozinho as skills em
`.claude/skills/`. É só pedir em português ("como crio um ingestor de Telegram?",
"monta o caso pra um escritório de advocacia", "sobe isso na minha VPS") e a skill
certa entra em ação.

| Skill | Pra quê |
| --- | --- |
| `galeed-mapa` | Entender o projeto: o que é cada pasta, por onde o dado entra, convenções |
| `galeed-rodar` | Subir (Docker ou dev local), rodar os casos demo, resolver "não sobe" |
| `galeed-criar-ingestor` | Conectar um canal novo (Telegram, CRM, qualquer webhook) em 1 arquivo |
| `galeed-n8n` | Montar fluxos no n8n com o cérebro |
| `galeed-zapier` | Montar Zaps (Webhooks by Zapier hoje ou a app oficial) |
| `galeed-conectar-ia` | Plugar Claude/Cursor/seu agente via MCP ou API `/v1` |
| `galeed-deploy` | Colocar em produção em qualquer hospedagem (VPS, Easypanel, Coolify…) |
| `galeed-diagnosticar` | "Não funciona": do sintoma à causa (fila, janela, acesso, sync) |
| `galeed-caso-de-uso` | Montar o caso de uso/pitch do Galeed pra um cliente, setor ou dor |

## Rodar os testes

```bash
npm ci
npm test       # suíte unit — roda sem banco/infra
```

## Desenvolvimento local (app fora do Docker)

```bash
docker compose up -d     # só o Postgres+pgvector (porta 5434)
cp .env.example .env
npm ci
npm run dev              # sobe TUDO: painel (5173) + BFF + API pública + worker de ingestão
```

Acesse **http://localhost:5173**. O `npm run dev` sobe os 4 processos de uma vez;
se preferir separado: `npm run dev:bff` (login/painel), `npm run worker`
(processa a fila de ingestão — sem ele os uploads ficam presos em "na fila"),
`npm run gateway:dev` (API `/v1`) e `npm run dev:web` (Vite).

Sobre a IA em dev: sem `ANTHROPIC_API_KEY` o servidor usa o binário `claude`
da sua máquina (assinatura), se existir. Sem nenhum dos dois, busca e captura
continuam funcionando; extração de fatos e o "perguntar" avisam o que falta.

## Suporte

Use o canal da turma da Accelera 360.

---

<div align="center">

**Accelera 360 Company LTDA** · CNPJ 57.155.365/0001-02

</div>
