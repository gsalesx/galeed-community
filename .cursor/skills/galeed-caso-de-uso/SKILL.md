---
name: galeed-caso-de-uso
description: Use quando o aluno precisar montar um caso de uso, pitch ou proposta do Galeed pra um cliente/setor/dor específico — "como o Galeed ajudaria um(a) X", "monta o caso pro cliente Y", "reunião amanhã com Z", "proposta/apresentação do Galeed".
---

# Caso de uso do Galeed pra um cliente

O entregável é um documento que o aluno apresenta pro DONO do negócio (não-técnico):
a dor dele, o que entraria no cérebro, o que ele passaria a perguntar, e o valor no
dia a dia. **Antes de escrever, leia `CASOS.md`** — é o calibrador: 4 casos rodados de
verdade, com o formato real das respostas (citações `[n]` + "Lacunas").

## Descoberta (quando o aluno não trouxe tudo)

Pergunte só o que faltar: **setor/tamanho** · **a dor na frase do cliente** ("quando X
acontece, ninguém sabe Y") · **onde o conhecimento mora hoje** (WhatsApp? e-mail?
planilha? cabeça de alguém?) · **quem perguntaria ao cérebro** (dono, time, bot de
atendimento?).

## A estrutura do caso (nesta ordem)

1. **A dor em linguagem do dono** — abra com a frase do cliente; mostre o custo dela
   (férias, saída de funcionário, retrabalho, cliente repetindo a história).
2. **O Galeed em uma frase** — "a memória do negócio: o que hoje se combina por
   [canais dele] vira registro com data e fonte; qualquer pessoa autorizada pergunta
   em português e recebe resposta citando de onde veio". Self-hosted = o dado não
   sai da empresa (LGPD/sigilo).
3. **O que entra no cérebro — SEM mudar a rotina** (tabela: "o que a empresa já faz
   hoje" → "como entra"). Use SÓ canais que existem: WhatsApp (Evolution/Chatwoot) ·
   qualquer chat · e-mail via automação (Zapier/n8n) · transcrição de reunião
   (notetaker) · formulários · planilha (linha vira fato SEM IA) · arquivos em pasta
   sincronizada · espelho GitHub.
4. **O que ele passaria a perguntar** — 3 perguntas do MUNDO DELE com respostas no
   formato real do produto: afirmações com `[n]`, cruzando 2+ canais, e uma seção
   **Lacunas** honesta. Inclua uma pergunta de linha do tempo ("o que valia antes vs
   agora") — bitemporal é diferencial.
5. **Os momentos de valor no dia a dia** — 3 a 4 cenas concretas (férias/saída de
   alguém, onboarding, visão do dono, atendimento que não recomeça do zero).
6. **Sigilo e acesso** — áreas com acesso fechado por padrão; quem não pode, não vê
   que existe. (Antecipa a pergunta que o dono sempre faz.)
7. **O que o Galeed NÃO é** — ele lembra; NÃO faz o trabalho da profissão (não redige
   petição/receita/proposta), NÃO inventa (Lacunas), NÃO é mais um sistema pra
   preencher. Honestidade fecha venda.
8. **Piloto de 30 dias** — 2-3 canais, 2-3 pessoas voluntárias, e o teste de fogo na
   semana 4 (simular a dor: alguém "sai de férias" e outro responde só perguntando
   ao cérebro).

## Regras de aterramento (o que separa caso de uso de conto de fadas)

- **Nunca prometa o que o produto não tem**: OCR, integração nativa com sistema do
  setor (PJe, CRM X, ERP Y), IA que executa a tarefa, app mobile. Integração com
  sistema específico = "via automação (n8n/Zapier) ou webhook" — que é verdade.
- Exemplos de resposta SEMPRE no formato real (`[n]` + Lacunas) — copie a cara das
  respostas do `CASOS.md`, nunca uma resposta "mágica" sem fonte.
- A dor do cliente aparece com as PALAVRAS dele no título e na abertura.

## O golpe de misericórdia: demo executável

Ofereça transformar o caso em demo AO VIVO: copie um JSON de `tools/casos/`
(estrutura: `{ empresa, historia, eventos[{ingestor, rotulo, payload}], perguntas[] }`),
troque por eventos do MUNDO DO CLIENTE e rode `npm run caso` — o aluno apresenta o
Galeed respondendo perguntas sobre a empresa fictícia do MESMO setor do prospect,
com respostas reais. Nada vende mais que isso.
