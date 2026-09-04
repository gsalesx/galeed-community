# Zapier + Galeed

Duas formas de usar o Galeed no Zapier — a imediata (funciona hoje, sem publicar nada) e a
oficial (a Zapier App deste repo, com ações prontas).

---

## 1. Hoje, sem publicar nada: "Webhooks by Zapier"

Qualquer Zap pode falar com o Galeed usando a ação **Webhooks by Zapier → Custom Request**:

- **Method**: POST · **URL**: `https://seu-galeed/v1/ingestors/<slug>`
- **Headers**: `Authorization: Bearer gld_live_SUA_CHAVE` · `Content-Type: application/json`
- **Data**: o JSON do ingestor (abaixo).

### Cases prontos (copie e adapte)

**Google Forms → Galeed** (lead do formulário vira memória)
> Trigger: Google Forms "New Form Response" → Action: Webhooks POST em `/v1/ingestors/formulario`
```json
{ "formulario": "Orçamento pelo site", "ref": "{{Response ID}}",
  "campos": { "Nome": "{{Nome}}", "Telefone": "{{Telefone}}", "Mensagem": "{{Mensagem}}" } }
```

**Fireflies → Galeed** (reunião transcrita vira memória)
> Trigger: webhook do Fireflies → Action: buscar o transcript (GraphQL deles) → Webhooks POST em `/v1/ingestors/notetaker`
```json
{ "title": "{{Meeting Title}}", "transcript": "{{Transcript Text}}",
  "participants": "{{Attendees}}", "occurred_at": "{{Date}}", "ref": "{{Meeting ID}}" }
```

**Google Sheets → Galeed** (linha nova na tabela de preços vira FATO, sem IA)
> Trigger: Sheets "New/Updated Row" → Action: Webhooks POST em `/v1/ingestors/planilha`
```json
{ "titulo": "Tabela de preços", "data": "{{Data de vigência}}",
  "linhas": [ { "entidade": "{{Produto}}", "atributo": "preço", "valor": "{{Preço}}", "unidade": "BRL", "tier": "{{Faixa}}" } ] }
```

**Telegram/Instagram (ManyChat) → Galeed** (conversa com janela)
> Trigger: mensagem nova → Action: Webhooks POST em `/v1/ingestors/chat`
```json
{ "canal": "telegram", "chat_id": "{{Chat ID}}", "quem": "{{Nome do contato}}",
  "texto": "{{Mensagem}}", "chat_label": "Telegram — {{Nome do contato}}" }
```

**Responder com a memória** (qualquer fluxo → resposta com fonte)
> Action: Webhooks POST em `/v1/ask` com `{ "question": "{{Pergunta}}" }` → use `{{answer}}` no passo seguinte (WhatsApp, Slack, e-mail). O bot precisa de **acesso total** (Acesso → "Todas as áreas").

---

## 2. A Zapier App oficial (este repo: `apps/zapier-galeed/`)

App do Zapier Platform CLI com **auth + 6 ações prontas** (sem mapear URL/header na mão):
Ingerir Texto · Mensagem de Chat · Transcrição de Reunião · Formulário/Lead ·
Planilha/Tabela · **Perguntar ao Cérebro**. Smoke local validado contra um Galeed vivo
(`npm run smoke`).

**Como publicar (só o dono, ~10 min):**

```bash
cd apps/zapier-galeed
npm install
npx zapier login          # conta Zapier da Accelera
npx zapier register "Galeed"
npx zapier push
```

**Distribuição pros alunos (sem review da Zapier):** a app fica **privada** — gere o link de
convite com `npx zapier users:links` (ou Developer Platform → Sharing) e mande pra turma.
Quem clicar passa a ver a app "Galeed" no editor de Zaps. Publicação no diretório público
(beta/review da Zapier) é opcional e pode vir depois.

**Credencial na app**: URL do Galeed (sem `/v1`) + chave `gld_...` de **Conectar**. Pra usar
o "Perguntar", convide o bot em **Acesso** com **"Todas as áreas (acesso total)"**.
