# Testes do Galeed — rede de invariantes da verdade

Antes desta suíte a única rede era o **eval gate** (qualidade de recuperação, `eval/`). Ela não cobre
o que mais importa num produto de memória: **não corromper a verdade silenciosamente**. Estes testes
travam os invariantes onde uma regressão muda dados do cliente sem acusar.

## Como rodar

```bash
npm test               # só unit (puro, sem infra) — use em CI e no loop de dev
npm run test:watch     # unit em watch
npm run test:integration   # precisa de Postgres (docker compose up -d) + .env
npm run test:all       # unit + integração
```

- **Unit** (`test/unit/`) não toca rede nem banco: funções puras. Rodam em ~400ms.
- **Integração** (`test/integration/`) precisa de Postgres+pgvector. Carregam o `.env` sozinhos
  (`helpers/db.ts`) e **dão skip automático** se não houver `DATABASE_URL`. Usam um brain dedicado e
  descartável (`__test_*`) que é limpo antes e depois — nunca tocam dados reais.

## O que cada arquivo protege

### Unit — invariantes puros
| Arquivo | Invariante | Por quê |
|---|---|---|
| `supersession.test.ts` | `applyBitemporal` — supersessão, corroboração, duplicata, não-verificado fora da cadeia, sem-data ordena antigo | **O coração da verdade.** Como o cérebro "muda de ideia". |
| `reconcile-integrity.test.ts` | hard gate de papel: opostos (gasto≠receita) NUNCA fundem; precedência sobre sinonímia errada | Trava a **regressão crítica** ad_spend→ticket (R$2.700 vs R$15k). |
| `normalize.test.ts` | `normalizeValue` — formas de moeda/número colapsam na mesma chave | Sem isso, supersessão cria crenças concorrentes espúrias. |
| `recency.test.ts` | `recencyFactor` — evergreen, piso, monotonicidade | Decaimento de score determinístico. |
| `confidence-decay.test.ts` | `effectiveConfidence`/`salienceScore` — nunca sobe, respeita piso, identidade não decai | Decay de leitura não pode inventar confiança. |
| `quote-check.test.ts` | `quoteIsGrounded` — anti-alucinação (R4) | Porta que marca um fato como `nao-verificado` na entrada. |

### Integração — caminho real do banco
| Arquivo | Invariante |
|---|---|
| `supersession-e2e.test.ts` | `buildIndex` deriva a verdade bitemporal correta e a grava atômico (idempotente). |
| `tiering-reversibility.test.ts` | esquecer é **reversível** (M5/R1): `shedCold`→`restoreCold` sem perder o body. |
| `tenant-isolation.test.ts` | isolamento multi-tenant: app filtra por `brain` (sempre) + **RLS sob role não-superuser** (gated por `GALEED_TEST_ROLE_URL`). |

## `it.fails` — bugs conhecidos rastreados, não escondidos

Alguns testes usam `it.fails`: ficam **VERDES enquanto o bug existe** e viram **VERMELHOS quando alguém
consertar** (sinal pra trocar por asserção real). Hoje rastreiam:
- `normalize`: milhar pt-BR (`R$ 2.700` ≠ `2700`) e número por extenso (`497 mil`).
- `reconcile-integrity`: subconceitos do mesmo papel (`ticket_medio` × `ticket_medio_b2b`) fundem por
  token-overlap — só o LLM-judge separa.

## Testar o RLS de verdade (opcional)

O `tenant-isolation` cobre o filtro de aplicação sempre. A camada RLS só vale **sob role não-superuser**
(o dev `galeed` é superuser e bypassa — ver `docs/LEARNINGS.md`). Para exercê-la, crie uma role limitada
e aponte:

```bash
GALEED_TEST_ROLE_URL=postgresql://role_limitada:senha@localhost:5434/galeed npm run test:integration
```

## Próximos invariantes a cobrir (backlog)

- `contradict.ts` — detecção nunca muta a verdade, só registra.
- `entities.ts` — clusterização de alias é estável/idempotente.
- timeout/concorrência do `openai.embed` (quando implementado).
