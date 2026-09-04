# Ingestores — como o conteúdo entra no Galeed

> Quer ver tudo isso funcionando com dados de empresas reais? Rode os casos prontos:
> `npm run caso -- --caso imobiliaria ...` — ver [CASOS.md](./CASOS.md).
> Integrações sem código: nó do n8n em `apps/n8n-nodes-galeed/` · Zapier em [ZAPIER.md](./ZAPIER.md).

O Galeed tem **um funil único de entrada** (o "seam"): tudo que entra passa por dedupe,
fila assíncrona, extração de fatos e pela receita da fonte. Um **ingestor** é a peça que
fica ANTES do funil — o *middleware* que recebe o dado cru de um canal (WhatsApp, notetaker,
automação, pasta…) e o **prepara** antes de ingerir de vez:

```
canal externo ──► Ingestor.normalize()  ◄── o middleware: limpa, recorta, formata, ancora
                        │
                        ▼
              seam único (dedupe + fila)
                        │
                        ▼
        extração de fatos ─► receita/regra de ouro ─► fatos com selo
```

Todo ingestor registrado ganha **automaticamente** um webhook público:

```
POST /v1/ingestors/<slug>
Authorization: Bearer gld_live_SUA_CHAVE        (chave com can_ingest — gere em Conectar)
```

> A ferramenta não deixa configurar header? Use `?token=gld_live_...` na URL como fallback
> (ciente de que URL pode parar em log de acesso — prefira o header sempre que der).

> **Bot que também LÊ (Perguntar/Buscar fatos pela API)?** Convide-o em **Acesso** com
> **"Todas as áreas (acesso total)"** — o recomendado pra integrações. Escopo por área é
> fail-closed e esconderia o conteúdo de modo livre (que não tem área definida).

`GET /v1/ingestors` lista os disponíveis. Re-entregar o mesmo evento **não duplica nada**
(dedupe por `externalRef`).

## Ingestores de fábrica

### `texto` — webhook genérico (e o template pra copiar)
Qualquer automação que faça POST de JSON:

```bash
curl -X POST "$GALEED/v1/ingestors/texto" \
  -H "Authorization: Bearer gld_live_SUA_CHAVE" -H "Content-Type: application/json" \
  -d '{ "title": "Ata da reunião", "text": "Decidimos que...", "occurred_at": "2026-07-01" }'
```

### `evolution-whatsapp` — WhatsApp via Evolution API (self-hosted)
**Caminho fácil (local):** suba `docker compose --profile app --profile evolution up -d --build`
e use o painel **Conectar → WhatsApp (Evolution)** — o Galeed cria a instância, mostra o QR
e configura o webhook sozinho.

Na mão: na sua instância Evolution, configure o webhook do evento **MESSAGES_UPSERT** apontando para
`/v1/ingestors/evolution-whatsapp` (com o header `Authorization: Bearer ...` — o painel da
Evolution aceita headers; senão use `?token=`). O ingestor extrai só o **texto** (mensagem,
reply, legenda de mídia), monta a proveniência (chat/grupo, quem, quando) e ignora o resto
(áudio sem transcrição, presence, acks).

**Janela de conversa (ingest inteligente).** Uma mensagem sozinha não carrega contexto —
"Consegue remarcar?" sem o "claro, sexta 15h" que vem depois não vira fato. Por isso o
WhatsApp **não ingere mensagem a mensagem**: cada mensagem entra num buffer por chat
(resposta `202 buffered`) e a conversa INTEIRA vira **uma página só** quando a janela fecha:

- o chat fica `GALEED_JANELA_MIN` minutos em silêncio (default **30** — a conversa "acabou"), ou
- a janela junta `GALEED_JANELA_MAX_MSGS` mensagens (default **100**).

Quem fecha as janelas é o worker de ingestão (a cada `GALEED_JANELA_FLUSH_MS`, default 60s).
A página sai como diálogo cronológico (`[09:26] Beatriz: ...` / `[09:28] Você: ...`) — a
extração enxerga pergunta + resposta + decisão juntas, e o custo cai ~10-20× num WhatsApp
movimentado. `GALEED_JANELA_MIN=0` desliga o buffer **e drena o que já estava bufferizado** (cada
mensagem passa a ingerir na hora; nada fica preso de uma configuração anterior).

### `chatwoot` — inbox omnichannel: dezenas de canais numa integração só
Se você (ou seu cliente) usa **Chatwoot** — o inbox open-source que unifica WhatsApp,
Instagram DM, Messenger, Telegram, e-mail e livechat — UMA configuração conecta TODOS
esses canais ao cérebro: Chatwoot → Settings → Integrations → **Webhooks** → URL
`https://seu-galeed/v1/ingestors/chatwoot?token=gld_live_...` com o evento
**message_created** marcado (o painel do Chatwoot não deixa configurar header — por isso
o `?token=`). Cada conversa vira uma janela; notas internas do atendente entram marcadas
como "(nota interna)". É o caminho recomendado pra omnichannel já existente.

### `chat` — QUALQUER canal de conversa (janela incluída)
**Regra da plataforma: todo canal com comportamento de chat usa a janela de conversa.**
Instagram DM (ManyChat), Telegram, livechat do site (Crisp/Tawk), Slack… a automação só
mapeia os campos — não precisa escrever ingestor novo:

```bash
curl -X POST "$GALEED/v1/ingestors/chat" \
  -H "Authorization: Bearer gld_live_SUA_CHAVE" -H "Content-Type: application/json" \
  -d '{ "canal": "instagram", "chat_id": "dm-8817", "chat_label": "Instagram — @beatriz",
        "quem": "Beatriz", "texto": "Vocês têm horário no sábado?" }'
```

Aceita lote (`{ "canal": "...", "mensagens": [...] }`). O `chat_id` é prefixado pelo canal —
chats de ferramentas diferentes nunca caem na mesma janela. Escrevendo um ingestor próprio
de canal de chat? Declare `janela: { chatId, chatLabel, quem, texto }` no item e o buffer
vem de graça (é assim que o `evolution-whatsapp` faz).

### `planilha` — tabela → fatos carimbados NA HORA (zero IA)
O caso mais comum de empresa tradicional: tabela de preços, catálogo, comissões. Cada
linha vira um **claim determinístico** (entidade · atributo · valor), ancorado e auditável
— sem nenhuma chamada de IA. Aceita linhas estruturadas OU CSV (com `;` e vírgula decimal
do Excel BR; colunas `entidade, atributo, valor [, unidade, periodo, tier, data]`):

```bash
curl -X POST "$GALEED/v1/ingestors/planilha" \
  -H "Authorization: Bearer gld_live_SUA_CHAVE" -H "Content-Type: application/json" \
  -d '{ "titulo": "Tabela de preços — agosto", "data": "2026-08-01",
        "linhas": [ { "entidade": "Limpeza de pele", "atributo": "preço", "valor": 180, "unidade": "BRL" } ] }'
```

Tabela nova **supera** a antiga pelo bitemporal (valid_from) — o cérebro guarda a
história do preço. Re-enviar a mesma tabela não duplica.

### `formulario` — leads e submissões de formulário
Google Forms, Typeform, Tally, formulário do site — via Zapier/Make/n8n ou POST direto.
Aceita `{ "formulario": "...", "campos": { ... } }` ou o shape plano do Zapier (campos
soltos na raiz).

### `notetaker` — transcrições de reunião (qualquer notetaker)
Fireflies, tl;dv, MeetGeek, Otter… O webhook nativo do Fireflies manda só o `meetingId` —
por isso o caminho universal é a sua automação (Zapier/Make/n8n) buscar a transcrição e
mandar o **texto**:

```json
{ "title": "Comercial — Acme", "transcript": "Kelvin: fechamos em R$ 2.500/mês...",
  "participants": ["Kelvin", "Mariana"], "occurred_at": "2026-07-01T14:00:00Z" }
```

### GitHub — o cérebro num repositório que qualquer pessoa navega
Configure em **Ajustes → GitHub do cérebro** (repo **privado** + PAT fine-grained com
*contents: read/write*). O Galeed organiza a memória do jeito que gente procura:

```
README.md            ← painel: o que o cérebro sabe, principais dossiês, últimas memórias
conhecimento/        ← um dossiê por pessoa/empresa/assunto (decisões com porquê acima de números)
reunioes/2026/2026-08-03 — Reunião de equipe.md
conversas/2026/2026-08-01 — WhatsApp 4799992222.md
documentos/2026/2026-08-01 — Tabela de preços (agosto).md
anotacoes/2026/…
entrada/             ← SUA pasta (veja abaixo)
```

Tudo em **um commit por sync** (a cada ~2 min ou pelo botão "Sincronizar agora"), com
mensagem legível (ex.: `galeed: 2 memórias novas (1 reunião, 1 conversa)`). O espelho é
**fiel**: memória apagada (ou com sigilo elevado) some do repo no sync seguinte.

**`entrada/`** é sua caixa de entrada: solte `.md/.txt/.csv/.tsv/.pdf` (até 25 MB) e o
Galeed ingere via fila. **Quando o arquivo some da entrada, virou memória**; se ficou, ainda
está processando ou deu erro (formato não aceito nunca é apagado). Dica: subpastas
classificam — `entrada/reunioes/ata.md` entra como reunião, `entrada/conversas/…` como conversa.

Por padrão o espelho leva **tudo** (o repo é seu) — dá pra restringir por sigilo em Ajustes,
e o painel mostra quantas memórias ficaram retidas pelo filtro. As pastas geradas são
sobrescritas a cada sync: edite só a `entrada/`.

### Pasta local — arquivos do Drive sem OAuth
Instale o Google Drive for Desktop (ou OneDrive/Dropbox), sincronize a pasta pro disco e:

```bash
npm run galeed -- pasta --dir ~/GoogleDrive/Galeed --type documento
```

Todo `pdf/md/txt/csv` novo ou alterado entra na fila (o worker precisa estar rodando —
`npm run dev` já sobe tudo). Atenção: Google Docs *nativos* sincronizam como atalho
(`.gdoc`) — exporte como PDF pra ingerir. Rodar de novo não re-ingere o que já entrou.

## Criando o SEU ingestor (é 1 arquivo)

1. Copie `apps/server/src/core/ingestion/ingestors/texto.ts` para `meu-canal.ts` no mesmo
   diretório e ajuste `slug`, `nome`, `descricao` e o `sourceSeed()` (a fonte que o canal cria).
2. Escreva o `normalize(body)` — **função pura** (sem fetch, sem env): recebe o payload cru
   e devolve `[]` (ignorar) ou itens `{ content, contentType, timestamp, externalRef, title? }`.
   - `externalRef` estável = dedupe de graça (id da mensagem, id do registro…).
   - Coloque a **proveniência legível no content** (de onde veio, quem, quando).
   - Quer o caminho zero-LLM? Emita `claims` determinísticos (ver `ConnectorClaim` no seam).
3. Registre em `apps/server/src/core/ingestion/ingestors/boot.ts` (1 linha).
4. Teste sem subir nada — o normalize é puro:

```ts
// apps/server/test/unit/meu-canal.test.ts (padrão em ingestors.test.ts)
expect(meuCanalIngestor.normalize(payloadCru, ctx)[0].content).toContain("...");
```

5. Suba o gateway (`npm run dev`) e chame `POST /v1/ingestors/meu-canal`. Pronto: fila,
   status no painel (Adicionar), extração e receita vêm de graça.

## E os conectores OAuth (Drive nativo, Gmail…)?

Pra sincronizar direto da API do provedor (sem pasta local) o caminho é um **provedor de
OAuth gerenciado** — o código já tem o seam do [Nango](https://nango.dev) (conectores
Conta Azul e Gmail em `core/ingestion/connectors/`), e o [Composio](https://composio.dev)
é alternativa equivalente. Ambos exigem conta no serviço + registrar o app OAuth (Google
etc.) — fricção que os ingestores acima não têm. Ative depois com:
`NANGO_SECRET_KEY` + `NANGO_WEBHOOK_SECRET` no `.env` (tela Fontes → catálogo).
