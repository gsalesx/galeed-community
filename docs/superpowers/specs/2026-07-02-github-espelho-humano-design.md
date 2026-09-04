# Espelho GitHub navegável por pessoas + padrão produção

**Data:** 2026-07-02 · **Status:** aprovado pelo Kelvin
**Motivação:** a estrutura atual (`memoria/paginas/<tipo>/<slug>.md`) é organização de máquina —
com dados reais vira UMA pasta (`notas/`) cheia de slugs ilegíveis, o frontmatter `areas:` sai
sempre vazio e, como toda página real nasce `restrito` e o default espelha só até `interno`,
o espelho nasce VAZIO em silêncio. Além disso a feature tem pontas soltas de produção
(arquivo apagado nunca some do espelho = vazamento; dossiê ignora sigilo; entidade sem
sanitização no path; README estático; cap 200 silencioso).

## 1. Estrutura nova — origem + tempo (decisão do Kelvin)

```
README.md                ← painel vivo, regenerado a cada sync (determinístico, sem relógio)
conhecimento/            ← dossiês por entidade (nome sanitizado)
reunioes/<ano>/AAAA-MM-DD — Título humano.md
conversas/<ano>/AAAA-MM-DD — Título humano.md
documentos/<ano>/AAAA-MM-DD — Título humano.md
anotacoes/<ano>/AAAA-MM-DD — Título humano.md
entrada/                 ← caixa de entrada do usuário (contém entrada/LEIA-ME.md nosso)
```

- **Mapeamento por canal** (tag `canal:` da página): `reuniao`→reunioes;
  `whatsapp|chat|chatwoot|instagram|telegram|sms`→conversas; `planilha`→documentos;
  sem canal mas com tag `doc:` (veio de arquivo)→documentos; resto (webhook,
  formulario, paste…)→anotacoes.
- **Nome de arquivo** = `data — título` sanitizado (remove `/\:*?"<>|` e controles,
  colapsa espaços, ~80 chars em fronteira de palavra; vazio → slug). Colisão no mesmo
  path → sufixo ` · 2`, ` · 3` em ordem estável (por slug). Sem data → prefixo `sem-data`,
  pasta de ano `sem-data/`.
- **Frontmatter enxuto**: titulo, data, origem (canal), sigilo, fonte (slug). Sem linha
  de áreas vazia.
- **README painel**: o que o cérebro sabe (contagens por origem + dossiês), principais
  entidades (top 10 por nº de fatos, com link), últimas 10 memórias (com link,
  URL-encoded), instruções da entrada/, aviso "gerado pelo Galeed — edite só a entrada/".
  Determinístico: "última memória" usa a data da memória mais recente, nunca o relógio —
  re-sync sem mudança segue gerando ZERO commit.
- **Commit message humana**: ex. `galeed: 2 memórias novas (1 reunião, 1 conversa) · 1 dossiê atualizado · entrada: 1 ingerido`.

## 2. Espelho fiel (produção)

- **Deleção de obsoletos**: pastas gerenciadas (`README.md`, `conhecimento/`, `reunioes/`,
  `conversas/`, `documentos/`, `anotacoes/`, legada `memoria/`, `entrada/LEIA-ME.md`) são
  espelho exato do desejado — o que sumiu do cérebro (página apagada, sigilo elevado)
  SOME do GitHub no próximo sync (tree entry com `sha: null` sobre `base_tree`).
  `entrada/` nunca entra na regra de deleção em massa (só a remoção pós-ingestão, item 3).
- **Migração automática**: primeiro sync da versão nova apaga a árvore `memoria/` antiga
  e escreve a estrutura nova no MESMO commit (memoria/ é prefixo gerenciado sem desejados).
- **Dossiê respeita sigilo**: se sigiloMax < restrito, só entram fatos cujo `source_slug`
  pertence a página espelhável; em restrito (default) não filtra.
- **Cap 200 entidades** vira nota no README quando atingido.
- Função pura `planoDeSync(desejados, remotos, removerExtra) → {subir, apagar}` testável.

## 3. Entrada limpa (pedido do Kelvin)

- Ingestão da entrada/ é **async, automática, via fila**: worker a cada 120s (+ manual);
  arquivo vira blob guardado + job na `galeed_ingest_jobs` (mesma fila de upload: dedupe
  por hash, retry, status).
- **Remoção só com job `done`**: "sumiu = virou memória; ficou = processando ou erro".
  Falha nunca é silenciosa — o arquivo permanece na entrada/. `galeed_github_entrada`
  ganha colunas `job_id`/`doc_hash` pra rastrear; cada rodada checa jobs concluídos e
  inclui a remoção no commit da rodada (remoção sozinha também comita).
- Formato não suportado **não é apagado** (não deletamos o que não processamos);
  `entrada/LEIA-ME.md` explica formatos aceitos e a regra do "sumiu".
- `entrada/LEIA-ME.md` é pulado pelo syncIn (não se auto-ingere).
- **Subpasta como dica de origem**: `entrada/reunioes/ata.md` → memória com canal reuniao
  (cai em reunioes/ no espelho). Mapa: reunioes→reuniao, conversas→chat,
  documentos/anotacoes→sem hint especial.

## 4. Sigilo (decisão do Kelvin: espelhar tudo)

- Default de config nova vira **`restrito`** (espelha tudo): o repo é do próprio dono.
- UI Ajustes: "O que espelhar: [Tudo ▾]" + aviso "quem tem acesso ao repositório vê tudo
  que está nele — use um repositório PRIVADO".
- GET /api/github/config devolve `retidas` (nº de páginas acima do teto) e a UI mostra
  "X memórias retidas pelo filtro de sigilo" — nunca mais espelho vazio sem explicação.

## 5. Prova de pronto (pronto = produção)

- Unit: mapeamento canal→pasta, sanitização/colisão de nomes, planoDeSync (update,
  deleção, migração memoria/, não-toca entrada/), README determinístico, filtro de
  sigilo do dossiê.
- E2E REAL contra `a360-business/galeed-espelho-teste`: migração limpa memoria/;
  estrutura nova no ar; arquivo em entrada/ → job na fila → done → removido da entrada/
  e espelhado na pasta certa; página apagada some do espelho; re-sync ocioso = zero commit.
- Suíte completa verde. openapi.yaml e INGESTORES.md atualizados.

## Fora de escopo (próximo sprint de pontas soltas)

Merge bidirecional (editar memoria/ re-ingere), áreas fixas na tela Acesso (falta
endpoint /areas), tela Plano inalcançável com billing off, /docs só no Docker.
