# Extração: call de venda da Accelera 360 (preço por tier no tempo)

Esta página é uma **call de venda / oferta** do produto **Accelera 360** (também dito "Accelera", "Acelera",
"A360"). O objetivo desta extração é capturar a **tabela de preços do produto e sua EVOLUÇÃO no tempo**,
separada por **plano/faixa (tier)**.

## Ancoragem (o que importa)

- O **preço cotado numa call de venda é o preço do PRODUTO/OFERTA em discussão (a Accelera), NÃO do falante**
  que o pronuncia (Kelvin, Ana, o vendedor) nem do cliente. Sempre que aparecer um valor de plano/mensalidade/
  contrato do produto, ancore:
  - `entity` = **`accelera`** (slug curto, minúsculo, SEMPRE essa grafia — nunca "Accelera 360", "A360",
    "kelvin", nem o nome do cliente).
  - `predicate` = **`preco`** (genérico — NUNCA `preco_plano_pro`, `preco_treinamento`, `mensalidade_x`:
    o plano vai no `tier`, não no predicado).
  - `value_num` = o número CRU em reais (`3000` para "R$ 3 mil", `30000` para "R$ 30 mil", `990` para "R$ 990").
  - `unit` = `BRL`. `period` = `monthly` se for por mês (mensalidade), `one_time` se for valor único.
  - `tier` = o **plano/faixa** quando o texto distinguir: `starter`, `pocket`, `pro`, `full`, `enterprise`,
    ou outro nome de plano dito na call. Se a call não nomear o plano mas o preço claramente é o do produto,
    deixe `tier` vazio (a série temporal ainda é útil) — mas PREFIRA capturar o tier quando ele aparecer.
  - `valid_from` = a data em que esse preço passou a valer (data dita no texto; senão a data da call).

## Série temporal (por que separar tier)

A Accelera teve VÁRIOS preços ao longo do tempo e por plano (ex.: degraus 290 / 3.000 / 5.000 / 12.000 /
18.000 / 30.000). Cada cotação numa call é **um ponto** dessa série. Extraia CADA preço como um claim
próprio (`entity=accelera`, `predicate=preco`, `tier`, `value_num`, `valid_from`) para que o sistema
monte a evolução por `(entity, predicate, tier)` ordenada por `valid_from`. Não funda preços diferentes
num só; não escolha "o preço atual".

## Regras

- Um claim por preço cotado (atômico). Se a call cita 2 planos, são 2 claims.
- `context_quote` = trecho LITERAL da call de onde tirou o valor.
- Só preencha `value_num` se o número estiver no texto; não arredonde nem invente.
- Preço que o CLIENTE paga a OUTRO fornecedor (não à Accelera) NÃO é preço da Accelera — ancore na entidade
  certa (ou deixe textual). Só o preço DO produto Accelera vai em `entity=accelera, predicate=preco`.
- Call de descoberta sem preço da Accelera → não invente claim de preço.
