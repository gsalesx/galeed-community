# Casos reais — empresas tradicionais usando o Galeed

Quatro empresas simuladas com dados realistas, **rodadas de verdade** contra um Galeed
self-hosted com **zero chaves de API** (extração via binário `claude`). Cada caso é um
arquivo em `tools/casos/` que você pode **replayar na sua instância**:

```bash
npm run caso -- --caso imobiliaria \
  --token gld_live_SUA_CHAVE \            # chave com can_ingest (Conectar → gerar chave)
  --email voce@empresa.com --senha ... \   # seu login do painel (quem pergunta é o dono)
  --brain imobiliaria
```

Os papéis espelham o produto: a **máquina ingere** pela API pública (`/v1/ingestors/...`)
e o **dono pergunta** pelo painel. As respostas abaixo são as respostas REAIS do sistema
(as citações `[n]` apontam pras fontes; "Lacunas" é o cérebro sendo honesto sobre o que
não sabe — ele nunca inventa).

---

## Caso 1 — Imobiliária Horizonte (Balneário Camboriú/SC)

Corretora com 6 corretores. Carteira numa planilha, negociação no WhatsApp, visitas
anotadas em papel. **Conectaram:** a carteira (ingestor `planilha` — fatos na hora, sem
IA), o WhatsApp (`evolution-whatsapp`), as visitas gravadas (`notetaker`), os leads do
portal (`formulario`) e os e-mails encaminhados (`texto`).

**A rotina que entrou:** carteira com 3 imóveis (preço+status) · Roberto Lima pergunta
do apto pelo WhatsApp · visita transcrita (ele propõe R$ 850 mil à vista) · lead do
Imovelweb (Fernanda, sala comercial) · e-mail do proprietário (contraproposta R$ 870 mil,
comissão 6%, prazo sexta).

> ❓ **Qual o preço do Apto 302 do Edifício Solar e qual o status da negociação com o Roberto Lima?**
>
> O Apto 302 Edifício Solar era oferecido a R$ 890.000,00 desde 2026-07-01 [2] Houve
> proposta de 850 mil à vista [1] Não desço de R$ 870.000 [3] Se aceitar 870 à vista,
> fecho e pago a comissão integral de 6% [3]
> **Lacunas:** resposta de Roberto à contraproposta; confirmação se fechou; data exata do prazo.

Uma pergunta cruzou **três canais** — planilha [2], visita transcrita [1] e e-mail do
proprietário [3] — e ainda apontou o que falta pra fechar o negócio. É a memória que
nenhum corretor tem na segunda-feira de manhã.

> ❓ **Quais leads chegaram pelo portal e o que procuram?**
>
> Um lead chegou pelo portal Imovelweb [1] O lead é Fernanda Castro [1] O telefone é
> (47) 96666-5555 [1] O imóvel de interesse é Sala 1204 Business Center [1] Fernanda
> procura sala comercial para locação imediata [1] O motivo é que o escritório de
> advocacia está crescendo [1]

---

## Caso 2 — Distribuidora Vale Verde (alimentos B2B, Blumenau/SC)

Atende 80 mercados. Tabela com faixa atacado/varejo no Excel (com `;` e vírgula decimal,
como todo Excel BR), pedidos por WhatsApp e e-mail, negociação por telefone.

**A rotina que entrou:** tabela de preços em CSV com tier atacado/varejo (`planilha` —
6 fatos carimbados **sem nenhuma chamada de IA**) · fornecedor avisa atraso pelo WhatsApp ·
pedido do Mercado Bom Preço por e-mail · negociação com a Rede Super União transcrita.

> ❓ **Qual o preço do azeite Andorinha no atacado e no varejo?**
>
> O azeite Andorinha 500ml custa R$ 33,50 no atacado (12 unidades) [1] O azeite
> Andorinha 500ml custa R$ 38,90 no varejo [1]

> ❓ **O que ficou combinado com a rede Super União?**
>
> O café Melitta sairia a R$ 15,80 com pedido mensal mínimo de 100 unidades por loja [1]
> O fornecimento começaria em agosto [1] A loja do centro recebe só às terças [1]
> Marcos mandaria o contrato no dia seguinte [1]
> **Lacunas:** se o contrato foi enviado; se o primeiro pedido saiu em agosto.

O combinado por telefone — preço especial, mínimo por loja, restrição de entrega — virou
memória citável. É exatamente o tipo de acordo que se perde quando o vendedor sai de férias.

---

## Caso 3 — Clínica Belle Vie (estética, Joinville/SC)

Duas salas, 4 profissionais. O conhecimento vivia no WhatsApp da dona, num caderno de
preços e na cabeça da recepcionista.

**A rotina que entrou:** tabela de preços de agosto (`planilha`) · cliente remarca sessão
pelo WhatsApp · lead novo pergunta preço no WhatsApp · reunião semanal transcrita ·
lead do formulário do site.

> ❓ **Qual o preço do pacote de 10 sessões de limpeza de pele?**
>
> O preço do pacote de 10 sessões de limpeza de pele é R$ 1.500 [2] Mariana Souza tem um
> pacote de 10 sessões de limpeza de pele por R$ 1.200 [4]
> **Lacunas:** se o desconto da Mariana segue critério ou foi negociação única; se o
> preço dela se mantém após a atualização de agosto.

Repare: o cérebro **distinguiu o preço de tabela do preço negociado de uma cliente
específica** (que tinha entrado semanas antes, por outro canal) — e levantou a pergunta
comercial certa. Isso é o bitemporal trabalhando.

> ❓ **Quais pendências ficaram da última reunião de equipe?**
>
> Júlia tentará encaixar Mariana Souza para ser atendida sempre nas terças [1] Agendar o
> técnico para manutenção do aparelho de peeling antes de sexta [1] Dra. Paula fechar o
> orçamento da maca elétrica nova com teto de R$ 4.500 [1]

---

## Caso 4 — Argo Consultoria de Marketing (100% estratégico — ZERO preço)

O caso que prova a tese do fundador: *"empresa vai muito além de preço"*. Nenhuma pergunta
de valor — só pesquisa de mercado, análise de concorrente, decisão de posicionamento, call
de alinhamento e métricas de tráfego.

**A rotina que entrou:** pesquisa com 25 clínicas (`texto`) · análise da concorrente Agência
Vetor (`texto`) · call de alinhamento dos sócios (`notetaker`) · métricas de tráfego Q2
(`planilha` — CPL e taxas de conversão, números que NÃO são preço).

> ❓ **Qual foi a decisão de posicionamento e por quê?**
>
> A decisão foi especializar 100% em clínicas odontológicas premium [1] com abandono dos
> outros nichos até dezembro [1] Razão principal: é onde têm os melhores casos [1] Razão
> secundária: o concorrente é vulnerável no atendimento [1] A oportunidade estratégica é que
> o atendimento próximo é exatamente o que a base do concorrente reclama de não ter [2]

> ❓ **Quais compromissos os sócios assumiram e pra quando?**
>
> Duda assumiu a transição dos 4 clientes fora do nicho sem quebra de receita até setembro
> [1] Theo vai reorientar toda a produção para criativo com dentista [1] Rafa registrou o
> risco: se a Vetor lançar o contrato de garantia antes dos 3 estudos de caso, perdemos a
> janela de diferenciação [1]

> ❓ **O que sabemos da Agência Vetor?**
>
> Ponto forte: prova social pesada com 30 casos publicados [2] Ponto fraco: entrega
> padronizada; clientes reclamam de atendimento raso nas renovações [2] Risco: estão indo
> agressivamente atrás da nossa base [2]
> **Lacunas:** tamanho do time e faturamento da Vetor; data de lançamento do contrato de garantia.

> ❓ **Que aprendizado tivemos sobre criativos e o que os números mostram?**
>
> Criativo com dentista converte o dobro do institucional [fatos] Taxa de conversão: 2,1%
> contra 0,9% [fatos] Theo reorientou toda a produção para criativo com dentista [2]

Decisão **com os dois porquês**, compromissos com dono e prazo, SWOT do concorrente com o
risco crítico, e o aprendizado casado com os números que o comprovam. É o conhecimento que
normalmente evapora da cabeça dos sócios — citável, com fonte.

## O que os casos provam

1. **Ingestão sem fricção**: WhatsApp, planilha, reunião, formulário e e-mail entrando
   pelos ingestores prontos — nenhuma conta externa, nenhum OAuth.
2. **Fatos sem IA quando dá**: tabelas viram fatos carimbados na hora (caminho
   determinístico) — auditável linha a linha, custo zero.
3. **Respostas com fonte cruzando canais**: uma pergunta junta planilha + conversa +
   e-mail e cita cada pedaço.
4. **Honestidade**: o que o cérebro não sabe vira "Lacunas" — nunca invenção.
5. **Dedupe de verdade**: replayar um caso não duplica nada (re-execução segura).

Pra criar o SEU caso: copie um dos JSONs de `tools/casos/`, troque os eventos pela rotina
da SUA empresa e rode. Pra criar um canal novo: [INGESTORES.md](./INGESTORES.md).
