# Nango · Conta Azul (M22-B)

Sync functions do conector **Conta Azul** (ERP) para o Galeed. Projeto **isolado** — tem seu
próprio `package.json` (deps `nango` + `zod`) e **não** é instalado pelo `npm install` da raiz do
repo. O vitest da raiz testa só os `helpers.ts` (puros); este diretório não tem `*.test.ts`.

## O que é

Polling incremental da API v2 da Conta Azul por **data de alteração** (`data_alteracao_de/_ate`),
com checkpoint, para os 4 modelos:

- `vendas` → `GET /v1/venda/busca`
- `contas_a_pagar` → `GET /v1/financeiro/eventos-financeiros/contas-a-pagar/buscar`
- `contas_a_receber` → `GET /v1/financeiro/eventos-financeiros/contas-a-receber/buscar`
- `pessoas` → `GET /v1/pessoas`

(Razão: BRIEF §4 — M22-B. Layout zero-yaml `createSync` + `index.ts`, doc oficial atual do Nango —
risco R6 da DESIGN-SPEC: se a conta/CLI pinado exigir `nango.yaml`, a adaptação é mecânica, mesmos
`helpers.ts`.)

## O que NÃO faz

- **Não escreve no nosso Postgres.** Quem escreve é o seam do M22-A
  (`deliverConnectorPayload`) + o normalizador `src/core/ingestion/connectors/conta-azul.ts`
  (record → página PT + claims determinísticos, zero LLM). As sync functions só populam o cache
  efêmero do Nango (LEI I); o webhook de sync (M22-A) puxa `GET /records` e entrega ao seam.
- **Não vê o token OAuth.** O refresh token rotativo é do Nango (LEI IV / BRIEF §4); a
  autenticação (`auth.contaazul.com`) é configurada NO Nango.

## Deploy real = HTC do fundador

Pré-requisitos (TODOs externos — BRIEF §6, ainda sem credenciais):

1. Conta no Nango (cloud ou self-host).
2. App registrado em `developers.contaazul.com` (OAuth 2.0 `auth.contaazul.com/oauth2/{authorize,token}`).
3. Integração `conta-azul` criada no Nango com as credenciais da Conta Azul + uma conexão (connection).

Comandos literais (doc: https://nango.dev/docs/implementation-guides/use-cases/syncs/implement-a-sync):

```bash
cd nango
npm install
npx nango dryrun vendas '<CONNECTION-ID>' -e dev
# (com checkpoint, p/ testar o incremental:)
npx nango dryrun vendas '<CONNECTION-ID>' -e dev --checkpoint '{"lastAlteracao":"2025-10-20T07:59:59"}'
npx nango deploy
```

## Notas de contrato (oficiais)

- **Rate limit:** 600 req/min e 10 req/s **por conta conectada** (https://developers.contaazul.com/faq,
  https://ajuda.contaazul.com/hc/pt-br/articles/360044777972). Os `helpers.ts` espaçam ≥125ms entre
  páginas e fazem backoff exponencial em 429.
- **Janela de vencimento OBRIGATÓRIA** nos `/buscar` (`data_vencimento_de/_ate` required mesmo
  filtrando por alteração —
  https://developers.contaazul.com/docs/financial-apis-openapi/v1/searchinstallmentstopaybyfilter.md).
  Cravado em `janelaVencimento`: hoje-730d .. hoje+1825d. **R4:** parcela com vencimento FORA da
  janela não aparece no incremental — limitação do CONTRATO oficial; largura confirmada no HTC.
- **Fuso (R5):** `data_alteracao` é ISO 8601 **São Paulo/GMT-3 sem offset explícito**; o checkpoint
  compara strings da PRÓPRIA API entre si (monotônico) — nunca misture com UTC.
- **Filtros de data de alteração** lançados no changelog 2025 (v2.1.2025.11.x) —
  https://developers.contaazul.com/changelog.
- Referência de implementação oficial (MIT): https://github.com/ContaAzul/n8n-nodes-contaazul.
