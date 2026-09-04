# syntax=docker/dockerfile:1
# Imagem do BACKEND do Galeed — serve BFF, gateway e os workers a partir do
# MESMO código. Roda via tsx (o projeto não compila TS). O comando de cada
# serviço é definido no docker-compose (command:), reaproveitando esta imagem.
#
# Contexto de build = RAIZ do repo: pós-reorg o package.json/package-lock e o
# node_modules ficam na raiz, e o código em apps/server. Por isso copiamos a
# raiz (deps) e depois apps/server (código).
FROM node:22-slim

# tini = PID 1 correto (reaping de zumbis nos workers que rodam em loop infinito)
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production

# 1) deps de produção. tsx está pinado em dependencies; vitest/yaml (devDeps)
#    ficam de fora via --omit=dev. Camada cacheada enquanto o lock não muda.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# 2) código do backend + dados de runtime (schema-packs lidos via GALEED_SCHEMA_PACK).
#    .dockerignore já exclui test/ e eval/.
COPY apps/server ./apps/server

# BFF 8789 · gateway 8790. Workers não escutam porta.
EXPOSE 8789 8790

ENTRYPOINT ["/usr/bin/tini", "--"]
# Default = BFF; gateway e workers sobrescrevem `command` no compose.
CMD ["npx", "tsx", "apps/server/src/connectors/web-server.ts"]
