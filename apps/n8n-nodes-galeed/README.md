# n8n-nodes-galeed

Nós do [n8n](https://n8n.io) pro **Galeed** — a memória do seu negócio. Com eles, qualquer
um dos milhares de apps do n8n vira canal de entrada (ou de consulta) do seu cérebro,
sem escrever uma linha de código.

## O que o nó faz

**Ingestão** (requer chave com `can_ingest`):
- **Enviar texto** — ata, e-mail, nota → memória.
- **Enviar mensagem de chat** — canal de conversa com [janela](../../INGESTORES.md): o diálogo
  inteiro vira uma memória só.
- **Enviar transcrição de reunião** — Fireflies, tl;dv, MeetGeek…
- **Enviar formulário/lead** — Google Forms, Typeform, site.
- **Enviar planilha/tabela** — cada linha vira fato carimbado na hora (sem IA).
- **Enviar payload cru** — qualquer ingestor pelo slug (inclusive os seus).

**Memória**:
- **Perguntar** — resposta sintetizada com fontes.
- **Buscar fatos** — série de fatos vigentes (sem IA).

## Instalação

No n8n self-hosted: **Settings → Community Nodes → Install** e digite `n8n-nodes-galeed`.

**Instalação local (validada num n8n real, sem npm):**

```bash
npm run build   # nesta pasta
docker cp dist/credentials SEU_N8N:/home/node/.n8n/custom/credentials
docker cp dist/nodes       SEU_N8N:/home/node/.n8n/custom/nodes
docker exec -u root SEU_N8N chown -R node:node /home/node/.n8n/custom
docker restart SEU_N8N
```

O nó aparece como **Galeed** (tipo interno `CUSTOM.galeed` no modo custom; vira
`n8n-nodes-galeed.galeed` quando instalado via npm). Se o Galeed roda no host e o n8n em
Docker, use `http://host.docker.internal:8790` como URL na credencial.

## Credencial

**Galeed API**: a URL do seu Galeed (sem `/v1`) + a chave `gld_...` gerada no painel em
**Conectar → chaves do cérebro**. O botão de testar credencial lista os ingestores.

> **Importante**: pro bot LER o cérebro (Perguntar/Buscar fatos), convide-o em **Acesso**
> marcando **"Todas as áreas (acesso total)"** — é o recomendado pra integrações. Sem isso,
> o escopo por área (fail-closed) esconde o conteúdo que entra em modo livre.

## Receitas prontas

- **Fireflies → Galeed**: Webhook (Fireflies) → GraphQL (busca o transcript) → *Galeed:
  Enviar transcrição de reunião*.
- **Google Forms → Galeed**: Form Trigger → *Galeed: Enviar formulário/lead* (mapeie os
  campos no JSON).
- **Planilha Google → Galeed**: Google Sheets Trigger → *Galeed: Enviar planilha/tabela*
  (linhas em JSON) — preços viram fatos sem IA.
- **Telegram → Galeed**: Telegram Trigger → *Galeed: Enviar mensagem de chat* (canal
  `telegram`, id do chat, quem falou, texto) — janela de conversa incluída.
- **Responder no n8n com a memória**: qualquer fluxo → *Galeed: Perguntar* → manda a
  resposta (com fontes) pra onde quiser.

Mais contexto: [INGESTORES.md](../../INGESTORES.md) e [CASOS.md](../../CASOS.md) na raiz do repo.
