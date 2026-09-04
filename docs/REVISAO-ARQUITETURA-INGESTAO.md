# Revisão arquitetural — ingestão & memória (2026-07-07)

Branch `revisao/arquitetura-ingestao`, a partir de `bb36523`. Revisão pedida pelo dono do
produto com três suspeitas explícitas: (a) o decaimento de fatos que "joga pra lixeira" pode
não estar funcionando; (b) a extração já deu valor só a números/financeiro e deixava o resto
de fora; (c) furos gerais na ingestão. Método: 5 revisores paralelos por subsistema →
verificação adversarial de cada achado (34 confirmados, 0 refutados) → 5 pacotes de
implementação em territórios não-sobrepostos. Barra de verificação do repo (tsx/vitest/esbuild,
sem passo de `tsc`): **`npm test` = 111 arquivos / 870 testes verdes**; builds de `apps/mcp` e
`apps/web` verdes.

## O diagnóstico central: a lixeira era código morto

A "lixeira" existia inteira no código — flag `archived` reversível, tiering hot/cold,
consolidação com resumo — mas **nada a acionava na instalação padrão** (worker + painel, aluno
que nunca abre o CLI):

- O ciclo de sono rodava `prune` **sempre em dry-run** (`sono-step.ts`): contava os "podáveis" e
  não arquivava nada. Os únicos escritores de `archived=true` eram alcançáveis só por
  `galeed prune --apply` / `galeed consolidate` manuais.
- Como nada arquivava, `shedCold` (arquivada→cold, descarta vetores) nunca achava candidata — a
  cadeia archived→cold→restore era inerte.
- E o pior: quando alguém **arquivava** de fato, a página **vazava de volta** na recuperação
  (busca vetorial e expansão de grafo não filtravam `archived`), com selo enganoso "registrado".
- O decaimento que de fato funcionava era só o `recencyFactor` (fatos antigos pesam menos na
  busca) — esse estava e continua correto.

Além disso, o `galeed link` (arestas semânticas do grafo) era feature morta pela mesma
mecânica: qualquer ingestão rodava `replaceDerived`, que apagava **todas** as arestas, inclusive
as semânticas.

## O que foi corrigido (por pacote)

### A — Decaimento → lixeira de ponta a ponta
- Arquivamento automático **ligado** no ciclo de sono, com critério AUTO ultra-conservador:
  só vira candidata a página órfã (0 links), sem nenhum fato e mais velha que o cutoff
  (`GALEED_SONO_PRUNE_OLDER_DIAS`, default 180). Desligável por `GALEED_SONO_PRUNE_APPLY=0`.
  O CLI manual mantém o critério amplo. Fase nova `shed` completa archived→cold. Cutoff via
  relógio injetável (`pruneCutoff`, pura e testada).
- Vazamentos fechados: `vectorSearch`/`pagesBySlug`/graph-expansion não devolvem mais arquivada;
  `PageRow.archived` passou a ser projetado.
- `restoreCold` agora desarquiva **qualquer** página arquivada (antes exigia `tier='cold'`,
  deixando a archived+hot sem caminho de volta); gap do `getPage` sem `tier` fechado.
- `pruneVectors`/`buildEmbeddings` não deletam mais os vetores de página arquivada (preserva o
  tiering — quem descarta vetor é só o `shedCold` medido).
- `consolidateCold` reescreve o resumo com o corpo fresco antes de arquivar (antes o dedupe por
  `externalId` pulava o resumo e arquivava com texto velho).
- `CONF_HALFLIFE` alinhado às dimensões que a extração realmente produz.
- Arestas semânticas do `galeed link` preservadas: delete escopado `kind <> 'semantic'` +
  `replaceEdgesOfKind()` transacional (idempotente, sem duplicar).

### B — Fim do viés qualitativo residual na extração
O desenviesamento anterior (prompts) resolveu o prompt; sobrava viés **estrutural** nos gates:
- Segmento de 1 mensagem (decisão final de conversa) não é mais descartado — funde no anterior.
- "Combinado / sim / não / perfeito" sobrevivem ao prune quando respondem a mensagem mantida
  (fechamento de decisão deixa de virar ruído).
- Preâmbulo antes da 1ª fala (resumo executivo / action items do notetaker) vira mensagem
  inicial em vez de sumir.
- Aprovar um claim na fila de revisão agora **produz efeito** (roda o gate com o corpo real e
  promove a verificado).
- Valor **textual** verbatim ancora como número ancora (fim do viés numérico no gate C4);
  número por extenso ("trinta dias", "cem mil") passa a ancorar.
- Fato "registrado" (sem triple) corroborado por fontes distintas sobe de confiança até 0.75
  (< triple, deliberado) — deixa de ser cidadão de segunda classe por construção.
- `action_items` entrou nas dimensões default (o prompt já apontava pra ela).

### C — Robustez da fila
- **Corrida da janela de chat** (crítico): mensagem que chegava durante o flush era apagada sem
  ingerir. DELETE virou condicional por versão (`msg_count` snapshot); a sobra re-flusha com
  `first_at` recalculado.
- **Dead-letter do poller de lote** (crítico): erro definitivo (401/404) virava loop infinito e
  bloqueava o repair do brain inteiro. Agora classifica pelo status HTTP, conta `poll_failures` e
  marca `error` após o teto — o brain se destrava sozinho.
- Varredura de reparo periódica (não só no boot), heartbeat por unidade na Fase B, e
  `GALEED_JANELA_MIN=0` drena o buffer em vez de encalhar.

### D — Saída honesta e painel que enxerga o estado real
- Tela **Saúde** ganhou os cards "Sono e memória" (quando dormiu, o que fez/falhou, candidatas à
  poda, peso da memória: ativas/frias/lixeira) e **"Lixeira"** com botão **Restaurar** — antes o
  estado do decaimento era 100% invisível, então era impossível saber que não rodava.
- `/v1/facts` honesto: não serve mais fato `nao-verificado` como "fact", e aceita `?dim=`
  (default `decisions`) em vez de só a dimensão hardcoded.
- Painel acompanha jobs de lote (`batch_submitted`/`batch_harvesting`) — antes o item congelava.
- Timeline avisa quando trunca (antes cortava 200 linhas em silêncio); Dossiê resgata fatos
  qualitativos "registrados" sem triple.

### E — Consistência de tags e capture
- Tipo custom de fonte não colapsa mais pra "notas" (o merge receita→pack usa a chave efetiva).
- `area` do webhook normaliza com o mesmo `slugify` dos grants (antes a página sumia pra token
  escopado por diferença de caixa/acento).
- Tags técnicas (`src:<uuid>`, `doc:<hash>`, `canal:`, `area:`) saíram do vocabulário vivo, do
  selo epistêmico e do prefixo de embedding (`isTechTag`).
- Espelho GitHub classifica a pasta por `fonte:`/tipo também (antes tudo que entrava pelo webhook
  universal caía em documentos/anotações).
- Doc da camada RLS corrigida para a verdade: em produção o enforcement de escopo é o filtro
  espelho da app (`inScope`/`filterByScope`), camada única; a RLS só é provada em script manual.

## Segunda rodada — os dois furos de integridade fechados (2026-07-08)

Depois da revisão, atacamos os dois itens que eram furos reais de integridade (não só melhoria):

- **Vazamento de fatos da lixeira (era a pendência 5, resolvida — commit `85a215a`):** arquivar uma
  página a sumia da busca/grafo, mas as leituras de VERDADE ATUAL (`facts`/`timeline`/`currentFacts`)
  seguiam servindo os fatos dela — /v1, tela Fatos, timeline e Dossiê. Fechado com o filtro
  `notArchivedSource()` nas três leituras (o write-path `factsInGroups` NÃO filtra, de propósito —
  a supersessão bitemporal precisa ver tudo). Reversível de graça. Provado no Postgres real
  (arquiva→some→restaura→volta, zero reescrita).
- **Sobre-fusão de entidades (era a pendência 4, resolvida — commit `36c6bce`):** "joão" bridava
  "joão silva" e "joão souza" (contenção + union-find transitivo). Fechado separando sinal FORTE
  (grafia/token — funde sozinho) de FRACO (contenção — ambíguo); grupo ambíguo desempata por LLM
  (decisão do dono), cacheado em `galeed_entity_disambig` (só ambíguo, perguntado 1×); sem LLM →
  conservador ("na dúvida não funde"). Limitação conservadora conhecida: um sufixo-extensão
  ("accelera 360") não funde sozinho com a base quando a base também tem variante de grafia
  ("acelera") — recuperável por `galeed resolve --llm`.

## Pendências deixadas de propósito (decisão de design maior)

1. **Supersessão de fato textual por paráfrase** (`indexer.ts sameFactValue`): hoje compara por
   igualdade de string, então reescrita do mesmo valor vira falsa "mudança de ideia". Corrigir
   exige similaridade semântica com guarda de negação — fora do escopo desta revisão.
2. **Reingestão de conteúdo editado** (`process-blob-job.ts`): cria página nova e deixa a antiga
   viva (duplicata sem supersessão no nível de página). Precisa de decisão de design sobre
   supersessão de página.
3. **Armar a RLS de escopo de verdade** (`core/access/scope.ts`): hoje é camada única (filtro
   espelho). Armar a 2ª camada exige `engine.withScope` transacional + policy em `galeed_facts`
   e `deny_types` — mudança de arquitetura, documentada no cabeçalho de `scope.ts`.
4. **Data-fix de instalações existentes**: fontes notetaker já gravadas mantêm `type='call'`; e
   fontes gmail já conectadas mantêm a receita com a área antiga. São `UPDATE`s pontuais — não
   entram no código, ficam como nota de operação para quando houver base instalada.
5. **Ecos de `dim` / motor do Dossiê**: o `?dim=` foi propagado para OpenAPI e MCP público; o fix
   preferido do Dossiê (preservar `entity` no fato registrado, em `indexer.ts`) ficou como
   complemento client-side — se o fix do motor entrar depois, o complemento vira no-op via dedupe.
6. **Sufixo-extensão vs base com variante de grafia** (limitação conservadora do fix de entidades):
   ver a seção "Segunda rodada" — recuperável por `galeed resolve --llm`.

## Envs novas (todas com default seguro)

| Env | Default | O que faz |
| --- | --- | --- |
| `GALEED_SONO_PRUNE_APPLY` | `1` | liga o arquivamento automático no sono (`0` = só dry-run) |
| `GALEED_SONO_PRUNE_OLDER_DIAS` | `180` | idade mínima da página pra virar candidata no AUTO |
| `GALEED_BATCH_POLL_MAX_FAILURES` | `5` | teto de falhas definitivas do poller antes do dead-letter |
| `GALEED_REPAIR_INTERVAL_MS` | `900000` | intervalo da varredura de reparo periódica (15 min) |
