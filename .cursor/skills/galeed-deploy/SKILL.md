---
name: galeed-deploy
description: Use quando o aluno quiser colocar o Galeed em produção — "deploy", "subir na VPS", "colocar no ar", "HTTPS/domínio", Easypanel/Coolify/Portainer, backup, atualizar versão — em QUALQUER hospedagem.
---

# Deploy do Galeed (qualquer hospedagem)

O Galeed em produção é **Docker Compose** (`docker compose --profile app up -d --build`)
com ingress Caddy próprio. O que muda entre hospedagens é UMA decisão: **quem é o dono
das portas 80/443 da máquina?** Descubra antes de receitar.

## Passo 0 — descoberta (pergunte/verifique, não assuma)

1. Quem ocupa 80/443? `ss -ltnp | grep -E ':80|:443'` — nada = rota A; Traefik/Nginx/
   painel (Easypanel, Coolify, Portainer) = rota B.
2. Tem domínio com DNS apontado pra máquina? Sem domínio = rota C.
3. Recursos: build + 6 containers pedem ~2 GB de RAM livre e ~10 GB de disco.

## Rota A — máquina limpa + domínio (o caminho feliz)

O Caddy do Galeed é o ingress e emite HTTPS **sozinho** (Let's Encrypt):

```bash
cp .env.docker.example .env
# no .env:  GALEED_SITE_ADDRESS=galeed.suaempresa.com.br  ← só isso liga o HTTPS
#           GALEED_SECURE_COOKIES=1   ANTHROPIC_API_KEY=...   OPENAI_API_KEY=...
docker compose --profile app up -d --build
```

## Rota B — já existe proxy/painel na máquina (Easypanel, Coolify, Nginx…)

O TLS termina no proxy EXISTENTE; o Caddy do Galeed fica interno em HTTP:

```
# .env
COMPOSE_PROFILES=app                # painéis não têm o --profile do CLI — a env resolve
GALEED_SITE_ADDRESS=:80
GALEED_HTTP_PORT=127.0.0.1:8080     # porta interna livre; NUNCA 80/443
GALEED_HTTPS_PORT=127.0.0.1:8443
GALEED_SECURE_COOKIES=1             # o usuário final entra por HTTPS (do proxy)
```

E no proxy/painel: domínio `galeed.suaempresa.com.br` → destino `127.0.0.1:8080`
(Easypanel/Coolify: serviço Compose apontando pro seu fork do repo; no domínio, alvo é o
serviço `web` porta `80`). Painel que pede "Environment" gera o `.env` — se falhar com
"env file .env not found", crie o `.env` no próprio repositório de deploy.
O proxy só precisa repassar `/`, `/api`, `/auth`, `/v1` e `/docs` — tudo pro mesmo destino.

## Rota C — sem domínio

`GALEED_HTTP_PORT=8080` e acesse por `http://IP:8080`. Serve pra uso interno/teste.
**Inteligência da decisão**: o espelho GitHub FUNCIONA sem URL pública (o Galeed puxa por
polling — nada chama ele). Já **Zapier e webhooks de ingestores precisam de HTTPS
público** (a ferramenta chama VOCÊ) — pra testar sem domínio, use um túnel
(cloudflared/ngrok).

## Produção de verdade (não pule)

- **Banco fora da internet**: o compose já publica o Postgres SÓ no loopback
  (`127.0.0.1:5434`). Não "abra" essa porta — porta publicada pelo Docker NÃO passa
  pelo ufw.
- **Backup diário** (o cérebro inteiro mora aí): `crontab -e` →
  ```
  0 3 * * * docker exec galeed-db pg_dump -U galeed galeed | gzip > ~/backups/galeed-$(date +\%F).sql.gz
  ```
  Blobs (anexos): volume `galeed-blobs` (`docker run --rm -v galeed-community_galeed-blobs:/d -v ~/backups:/b alpine tar czf /b/blobs-$(date +\%F).tgz -C /d .`). Leve cópias pra FORA da máquina.
- **Atualizar versão**: backup → `git pull` → `docker compose --profile app up -d --build`.
  Migrações rodam sozinhas no boot (idempotentes); dados vivem nos volumes.
- **`GALEED_RLS`**: deixe `0` (default). Endurecer RLS exige role não-superuser própria no
  banco — tema avançado, NÃO é requisito pra produção do aluno.
- Painéis prefixam nomes: confirme com `docker ps | grep db` e `docker volume ls | grep blobs`
  antes de escrever o cron de backup.
- **Pós-deploy**: criar conta no domínio → gerar chave em Conectar → religar integrações
  (Zapier/n8n apontando pra URL nova; bots de leitura com **acesso total** em Acesso) →
  conferir em Adicionar que um upload de teste sai de "na fila" (worker vivo).

## Sintomas comuns

| Sintoma | Causa |
| --- | --- |
| Caddy não sobe / porta em uso | 80/443 ocupadas → você está na rota B; use porta interna |
| HTTPS não emite (rota A) | DNS não aponta pra máquina, ou 80/443 fechadas no firewall do provedor |
| Login não persiste (volta pra /entrar) | HTTPS na frente sem `GALEED_SECURE_COOKIES=1` (ou acesso por http com =1) |
| Build morre no meio | RAM insuficiente (<2 GB livres) — feche serviços ou adicione swap |
| Painel dá "env file .env not found" | crie o `.env` no repositório de deploy (aba Environment não gerou) |
| Zap dá timeout | Galeed sem URL pública HTTPS — rota C sem túnel |
| Mudei código e nada mudou | faltou `--build` no `up` |
