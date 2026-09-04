---
name: galeed-zapier
description: Use quando o aluno quiser montar um Zap com o Galeed — "zapier", "zap", ligar Google Forms/Fireflies/Sheets/ManyChat no cérebro — ou tiver dúvida entre a app oficial e o Webhooks by Zapier.
---

# Zaps com o Galeed

Dois caminhos — os dois documentados com cases copy-paste em `ZAPIER.md` (raiz):

## 1. Hoje, sem instalar nada: "Webhooks by Zapier"

Ação **Custom Request**: POST em `https://seu-galeed/v1/ingestors/<slug>` com headers
`Authorization: Bearer gld_live_...` + `Content-Type: application/json`.

Cases prontos no `ZAPIER.md`: Google Forms → `formulario` · Fireflies → `notetaker` ·
Google Sheets → `planilha` (linha vira fato sem IA) · ManyChat/Telegram → `chat`
(janela de conversa) · e "responder com a memória" via `/v1/ask` usando `{{answer}}`
no passo seguinte.

## 2. A app oficial (sem mapear URL/header na mão)

`apps/zapier-galeed/` — 6 ações: Ingerir Texto · Mensagem de Chat · Transcrição de
Reunião · Formulário/Lead · Planilha/Tabela · Perguntar ao Cérebro. README do pacote
tem credencial, smoke (`npm run smoke`) e publicação.

- A app é **privada**: o aluno entra pelo **link de convite** da turma (quem publica é a
  Accelera: `npx zapier push` + `npx zapier users:links`).
- Credencial: URL do Galeed (sem `/v1`) + chave `gld_live_...` de **Conectar**.
- O Galeed precisa estar acessível na internet (o Zapier chama VOCÊ) — Docker com domínio,
  ou túnel (cloudflared/ngrok) pra testar.

## Regras que evitam suporte

- `ref` estável em toda ingestão (id do evento na origem) → re-execução do Zap não duplica.
- Ação **Perguntar** exige bot com **acesso total** (Acesso → "Todas as áreas") — sem isso
  a resposta vem vazia (escopo fail-closed esconde modo livre).
- Zapier não alcança `localhost` — em dev use túnel.

| Sintoma | Causa |
| --- | --- |
| 401 | chave errada; ou URL com `/v1` no final (a credencial pede SEM) |
| 403 | chave sem `can_ingest` |
| timeout no Zap | Galeed não acessível da internet (localhost sem túnel) |
| duplicou memória | faltou `ref` estável no payload |
