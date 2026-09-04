# Conector Gmail (M22-C) — sync que roda NO Nango

Sync function que puxa as mensagens da caixa Gmail do tenant (backfill → incremental por
`historyId`) e entrega cada `Message` ao nosso BFF (webhook assinado + `GET /records`, tubulação do
**M22-A**). O **normalizador** (`src/core/ingestion/connectors/gmail.ts`) transforma cada record num
documento textual com cabeçalho determinístico em PT, datado com a **data do e-mail**.

## Provider key e escopo

- **Provider config key (integration-id no Nango):** `google-mail` (provider key oficial do Nango —
  https://docs.nango.dev/integrations/all/google-mail).
- **Escopo OAuth (SÓ LEITURA):** `https://www.googleapis.com/auth/gmail.readonly`
  (https://developers.google.com/gmail/api/auth/scopes). Tokens ficam **no Nango**, nunca no nosso
  Postgres (LEI IV do BRIEF §2).

## Como deployar (exige conta Nango — TODO externo, BRIEF §6)

```bash
# da raiz nango/ do projeto (manifesto/config é do Integrador no reconcile):
npx nango deploy <ambiente>     # publica integrations/.../syncs/messages.ts no Nango
# checagem de tipos best-effort sem deploy:
npx nango compile
```

Conta ainda não existe (TODO externo). O E2E real (deploy + caixa de verdade + records → fato com a
data do e-mail) é **HTC do fundador** (declarado, não simulado).

## Base e desvios (fidelidade ao contrato oficial — invariante #9)

**BASE:** template oficial
`NangoHQ/integration-templates@main:integrations/google-mail/syncs/messages.ts` (lido 2026-06-12),
copiado verbatim. **Zero-yaml**: o `createSync` é exportado do próprio arquivo — a sync é
auto-contida e não exige manifesto pra existir no repo.

**Desvios (EXATAMENTE 2, anotados no docblock da sync):**

1. **`fetchMessage` usa `format: 'full'`** (o template usa `'metadata'`): o normalizador precisa do
   `payload.body.data` (o corpo do e-mail).
   https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/get
2. **`syncBackfill` aceita recorte opcional por data:** se a connection metadata trouxer
   `{ backfill_after: "YYYY/MM/DD" }`, o list ganha `params.q = "after:YYYY/MM/DD"` (operador de
   busca do Gmail — `users.messages.list`, param `q`). Ausente ⇒ backfill total (comportamento do
   template). Mitiga backfill pesado de caixa inteira (BRIEF §8 risco 4).

A máquina de checkpoint (`backfill` → `history`, `historyId`, re-backfill no 404 de
`startHistoryId` expirado) é **idêntica ao template** — incremental por `historyId` (decisão do CTO).

## Fontes oficiais (o "input real")

- Shape do `Message` / `payload`: https://developers.google.com/gmail/api/reference/rest/v1/users.messages
- `users.messages.list` / `.get` / `users.history.list` / `users.getProfile`:
  https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages
- Template Nango: https://github.com/NangoHQ/integration-templates/blob/main/integrations/google-mail/syncs/messages.ts
- Integração Gmail no Nango: https://docs.nango.dev/integrations/all/google-mail
