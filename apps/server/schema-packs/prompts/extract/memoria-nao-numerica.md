# Extração: memória não-numérica de conversa (relação · decisão · compromisso)

Esta página é uma **conversa/notas** (export de chat, grupo, anotações). O objetivo desta
extração é capturar a MEMÓRIA NÃO-NUMÉRICA em 3 classes, cada uma com **predicado FIXO** —
o predicado NUNCA é inventado; o que varia é entity/value/meta.

## Regra de ouro (vale pras 3 classes)

- **`context_quote` é OBRIGATÓRIO e LITERAL**: cole o trecho exato da página de onde tirou o
  claim. Claim sem quote literal vira hipótese, nunca fato — não emita claim sem quote.
- **`predicate` é FIXO pela classe**: `relacao`, `decisao` ou `compromisso`. NUNCA crie
  variantes (`decisao_encerramento`, `aluno_de`, `papel_socio`… são ERROS).
- **`entity` = slug curto minúsculo da PESSOA** (primeiro nome: `rodrigo`, `kelvin`). Sem
  sobrenome, sem acento composto, sem org no lugar da pessoa.
- **`entity` NUNCA é pronome nem genérico** ("ele", "ela", "o cliente", "o produto", "a galera"):
  claim com entidade vaga vira hipótese na fila, NUNCA fato. Se o texto não nomear a pessoa,
  deixe o claim em `facts` ou não emita — não chute um sujeito.
- **`valid_from` = a data da MENSAGEM** de onde o claim saiu (o timestamp `[YYYY-MM-DD …]`
  que precede a fala). Não use a data de hoje nem a do export.
- **NÃO preencha `value_num`** nestas 3 classes (são memória não-numérica).
- O que não couber em nenhuma das 3 classes vai em `facts` (registro textual) — NÃO force.
- Anúncio repetido de aula/live da própria comunidade ("aula hoje às 20h", "ao vivo") NÃO é
  decisão nem compromisso — ignore ou registre em `facts`.

## `relacoes` — vínculo/papel declarado (predicate FIXO: `relacao`)

Vínculo de uma pessoa com organização/pessoa/grupo: sócio, aluno, mentor, cargo, profissão.
- `entity` = a pessoa. `value` = o RÓTULO do papel, curto e minúsculo (`socio`, `aluno`,
  `mentor`, `principal developer`).
- **`alvo`** (campo extra) = slug de COM QUEM/COM O QUÊ é o vínculo (`gustavo`, a empresa, o
  programa). O alvo vai SEMPRE em `alvo`, NUNCA dentro do `value` ("sócio do Gustavo" é ERRO;
  `value="socio"`, `alvo="gustavo"`).
- Assinatura de falante "Nome - Papel - Organização" é uma relação declarada válida.
- Exemplo: "Rodrigo aqui, sou sócio do Gustavo" → `{entity: "rodrigo", predicate: "relacao",
  value: "socio", alvo: "gustavo", context_quote: "Rodrigo aqui, sou sócio do Gustavo"}`.

## `decisoes` — escolha tomada ou descartada (predicate FIXO: `decisao`)

Escolha com efeito futuro: "decidi X", "vou fazer Y", "desisti de Z", "ficou decidido".
- `entity` = quem decidiu. `value` = o que foi decidido, frase curta auto-contida.
- **`sentido`** (campo extra) = `adotada` (vai fazer) ou `descartada` (desistiu/recusou).
- **`sobre`** (campo extra, opcional) = o tema/objeto da decisão, 1-3 palavras.
- Exemplo: "Pensei fazer cold call mas desisti." → `{entity: "<quem-falou>", predicate:
  "decisao", value: "nao fazer cold call", sentido: "descartada", sobre: "prospeccao",
  context_quote: "Pensei fazer cold call mas desisti."}`.

## `compromissos` — promessa assumida, com ou sem prazo (predicate FIXO: `compromisso`)

Obrigação que alguém assume de entregar/fazer algo: "te entrego até", "me comprometo a",
"fico devendo até sexta", "o prazo é quarta dia 17".
- `entity` = quem se comprometeu. `value` = o que prometeu, frase curta auto-contida.
- `valid_from` = quando COMBINOU (a data da mensagem) — NUNCA o prazo.
- **`prazo`** (campo extra) = a data-limite em `YYYY-MM-DD`, SÓ se a data estiver no texto
  (resolva "sexta"/"dia 17" usando a data da mensagem; se não der pra resolver com o que está
  escrito, NÃO preencha).
- **`com_quem`** (campo extra, opcional) = slug de pra quem foi prometido.
- Exemplo: "[2025-09-23 12:04:58] Kelvin: te entrego os documentos até sexta" →
  `{entity: "kelvin", predicate: "compromisso", value: "entregar os documentos",
  prazo: "2025-09-26", context_quote: "te entrego os documentos até sexta",
  valid_from: "2025-09-23"}`.
