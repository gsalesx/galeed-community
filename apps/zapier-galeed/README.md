# zapier-galeed — a Zapier App oficial do Galeed

App do [Zapier Platform CLI](https://platform.zapier.com/reference/cli-docs) que liga
qualquer um dos ~7.000 apps do Zapier ao cérebro — sem mapear URL nem header na mão.
Cases prontos de Zaps (Google Forms, Fireflies, Sheets, ManyChat…) em
[../../ZAPIER.md](../../ZAPIER.md).

## Ações (6)

| Ação | O que faz | Rota por baixo |
| --- | --- | --- |
| **Ingerir Texto** | ata, e-mail, nota → memória | `POST /v1/ingestors/texto` |
| **Ingerir Mensagem de Chat** | canal de conversa com janela — o diálogo inteiro vira UMA memória | `POST /v1/ingestors/chat` |
| **Ingerir Transcrição de Reunião** | Fireflies, tl;dv, MeetGeek… | `POST /v1/ingestors/notetaker` |
| **Ingerir Formulário/Lead** | Google Forms, Typeform, site | `POST /v1/ingestors/formulario` |
| **Ingerir Planilha/Tabela** | cada linha vira fato carimbado NA HORA (sem IA) | `POST /v1/ingestors/planilha` |
| **Perguntar ao Cérebro** | resposta sintetizada com fontes — use `{{answer}}` no passo seguinte | `POST /v1/ask` |

Todas as ações de ingestão aceitam `ref` (id estável na origem): reenvio com a mesma
ref **não duplica** nada.

## Credencial

- **URL do Galeed** (sem `/v1`) — ex.: `https://galeed.suaempresa.com.br`
- **Chave** `gld_live_...` gerada no painel em **Conectar → chaves do cérebro**
  (precisa de `can_ingest` pra ingerir)

> Pra usar o **Perguntar**, convide o bot em **Acesso** com **"Todas as áreas
> (acesso total)"** — sem isso, o conteúdo que entra sem etiqueta de área fica
> invisível pro token (fail-closed por design).

O teste de credencial do Zapier chama `GET /v1/ingestors` — se listar, está tudo certo.

## Desenvolver e testar

```bash
npm install
npm run validate            # zapier validate (schema da app)
npm run smoke               # smoke com createAppTester contra um Galeed vivo
                            # (GALEED_URL e GALEED_KEY no ambiente)
```

## Publicar e distribuir (só o dono, ~10 min)

```bash
npx zapier login            # conta Zapier da Accelera
npx zapier register "Galeed"
npx zapier push
```

**Distribuição pros alunos, sem review da Zapier:** a app fica **privada** — gere o
link de convite com `npx zapier users:links` (ou Developer Platform → Sharing) e mande
pra turma. Quem clicar passa a ver a app "Galeed" no editor de Zaps. Publicação no
diretório público (beta/review) é opcional e pode vir depois.
