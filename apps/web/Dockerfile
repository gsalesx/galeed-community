# syntax=docker/dockerfile:1
# INGRESS público do Galeed: o Caddy serve o front (build estático do Vite) e
# faz reverse-proxy de /api,/auth -> BFF e /v1 -> gateway. É o ÚNICO contêiner
# exposto à internet; BFF, gateway, db e workers ficam só na rede interna.
#
# Contexto de build = RAIZ do repo (pra alcançar o Caddyfile na raiz).

# ── stage 1a: build do front (Vite -> /web/dist) ──
FROM node:22-slim AS build
WORKDIR /web
COPY apps/web/package.json apps/web/package-lock.json ./
RUN npm ci
COPY apps/web ./
ARG VITE_DOCS_URL=/docs
ENV VITE_DOCS_URL=$VITE_DOCS_URL
RUN npm run build

# ── stage 1b: build das docs (Astro -> /docs/dist) ──
FROM node:22-slim AS docs
WORKDIR /docs
COPY apps/docs/package.json apps/docs/package-lock.json ./
RUN npm ci
COPY apps/docs ./
RUN npm run build

# ── stage 2: Caddy servindo o front + docs + roteando as APIs ──
FROM caddy:2-alpine
COPY --from=build /web/dist /srv
COPY --from=docs /docs/dist /srv/docs
COPY Caddyfile /etc/caddy/Caddyfile
EXPOSE 80 443
