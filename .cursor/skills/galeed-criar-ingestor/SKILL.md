---
name: galeed-criar-ingestor
description: Use quando o aluno quiser conectar um canal novo ao Galeed (Telegram, Slack, CRM, ERP, qualquer webhook) criando um ingestor — ou perguntar "como faço X virar memória", "criar ingestor", "webhook de entrada", "integrar ferramenta Y".
---

# Criar um ingestor no Galeed

Um ingestor é **1 arquivo** com `sourceSeed()` + `normalize()` puro. Registrado, ele ganha
DE GRAÇA: webhook `POST /v1/ingestors/<slug>`, dedupe, fila, extração e status no painel.
Guia narrativo: `INGESTORES.md` (raiz). Esta skill é a receita executável.

## Antes de codar: precisa mesmo de ingestor novo?

- Canal de **chat** genérico (Telegram, livechat, ManyChat…)? O ingestor `chat` já serve —
  a automação só mapeia `{ canal, chat_id, chat_label, quem, texto }`. Ingestor dedicado
  só elimina o middleman.
- Ferramenta com n8n/Zapier? Use o nó/app pronto (skills galeed-n8n / galeed-zapier).

## Receita (paths exatos)

1. **Copie o template**: `apps/server/src/core/ingestion/ingestors/texto.ts` →
   `<slug>.ts` no mesmo diretório. Pra canal de CHAT, copie `chat.ts` (tem a janela).
2. **Ajuste** `slug`, `nome`, `descricao`, `exemplo` (JSON string real do canal) e
   `sourceSeed()` — shape exato:
   ```ts
   sourceSeed() {
     return { name: "Meu canal", channel: "meu-canal", type: "texto",
              recipe: { fields: [] } }; // fields: [] = modo livre (extração padrão)
   }
   ```
   O `channel` vira a tag `canal:` da página (decide a pasta no espelho GitHub).
3. **Escreva `normalize(body): IngestorItem[]`** — função PURA (sem fetch/env/IO):
   - devolve `[]` pra evento sem conteúdo (ping, ack, mídia sem texto);
   - `externalRef` ESTÁVEL (id da mensagem/registro na origem) = dedupe de graça;
   - proveniência legível dentro do `content` (de onde veio, quem, quando);
   - **canal de chat? declare `janela: { chatId, chatLabel, quem, texto }`** — prefixe o
     `chatId` com o slug (`"meucanal:" + id`) e a conversa inteira vira UMA memória;
   - linha de tabela/dado estruturado? emita `claims` determinísticos (zero IA) — modelo
     em `planilha.ts`.
4. **Registre (1 linha)** em `apps/server/src/core/ingestion/ingestors/boot.ts`.
5. **Teste unitário** (normalize é puro — sem banco): crie
   `apps/server/test/unit/ingestors-<slug>.test.ts` no padrão de `ingestors-chat.test.ts`.
   Rode da RAIZ do repo: `npm test`.
6. **Teste vivo**: `npm run dev` + chave com `can_ingest` (painel → Conectar) e:
   ```bash
   curl -X POST "http://localhost:8790/v1/ingestors/<slug>" \
     -H "Authorization: Bearer gld_live_..." -H "Content-Type: application/json" \
     -d '<exemplo>'
   ```
   Ou sem subir nada: `npm run galeed -- ingestor test <slug> --from payload.json`.
7. **Documente**: seção curta no `INGESTORES.md`, no padrão das existentes.

## Produção: como a ferramenta chama o Galeed

- Header `Authorization: Bearer gld_live_...` sempre que a ferramenta deixar.
- Não deixa (Telegram, Chatwoot…)? Fallback documentado: `?token=gld_live_...` na URL.
  O Galeed NÃO lê headers proprietários (ex.: X-Telegram-Bot-Api-Secret-Token).
- O webhook só ingere; se o bot também vai LER (perguntar/fatos), convide-o em
  **Acesso → "Todas as áreas (acesso total)"** — sem isso, conteúdo de modo livre é
  invisível pro token (fail-closed).

## Erros comuns

| Sintoma | Causa |
| --- | --- |
| 404 no webhook | esqueceu o registro no `boot.ts` (ou não reiniciou o `npm run dev`) |
| Evento duplicando | `externalRef` instável (timestamp/random em vez do id da origem) |
| Chat virando 1 memória por mensagem | não declarou `janela` no item |
| `202 buffered` e "nada acontece" | é a janela: fecha com ~30 min de silêncio ou 100 msgs (worker precisa estar rodando) |
| Teste quebra com fetch/env | `normalize` tem IO — ele deve ser puro |
