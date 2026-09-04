# @galeed/docs

Documentação **pública** do Galeed — site estático construído com [Astro](https://astro.build)
puro (sem Starlight), 100% fiel ao design em `docs/design-system/documentacao.html`.

App **standalone** (este diretório não faz parte de um workspace npm — mesmo padrão do `web/`).
Instale e rode de dentro de `apps/docs/`.

## Rodar

```sh
# de dentro de apps/docs/
npm install
npm run dev        # dev server com hot-reload
```

- **Dev:** `npm run dev` → **http://localhost:4321** (porta default do Astro).
- **Build de produção:** `npm run build` (saída em `dist/`).
- **Preview do build:** `npm run preview` → serve o `dist/` estático.

Requer **Node >= 22.5.0** (ver `engines` no `package.json`). `sharp` cuida da otimização de
imagens no build.

## Estrutura

```
apps/docs/
  astro.config.mjs        # Astro puro (Shiki com tema css-variables)
  src/
    styles/global.css     # base visual — tokens oklch + componentes do design system
    data/toc.ts           # ordem + grupos das seções (a nav e a página leem daqui)
    components/            # peças reutilizáveis do design (1 componente = 1 pedaço do design)
    sections/<id>.astro    # uma seção por id do TOC (preenchidas pelos agentes de conteúdo)
    pages/index.astro      # página única — Hero + todas as seções na ordem do TOC
  public/galeed-logo.png   # logo da marca (usado na nav)
```

### Componentes (`src/components/`)

API simples e estável para os agentes de conteúdo montarem as seções:

- `Layout.astro` — `<head>`, shell, nav lateral (lê `toc.ts`), toast e o script de copiar-código + scroll-spy.
- `Hero.astro` — cabeçalho da página (eyebrow, title, subtitle, pills).
- `Section.astro` — invólucro de seção (id, ix, title, intro + slot).
- `Hero` / `Admonition` (note/warn/tip) / `Principle` (callout escuro com aspa).
- `CodeBlock.astro` — bloco com chrome do design (lang, filename, Copiar) + realce Shiki.
- `Endpoint.astro` — barra de endpoint (método, path com `/v1`, selo de escopo).
- `ParamTable.astro` — tabela de parâmetros (data-driven via `rows` ou slot).
- `Fields.astro` / `Field.astro` — anatomia do selo / leitura da receita.
- `QSteps.astro` / `QStep.astro` — passos numerados do início rápido.
- `Tools.astro` / `Tool.astro` — grid de ferramentas (MCP).
- `Codes.astro` — linhas de códigos de status (erros e limites).
- `Chip.astro` — chips de status e sigilo (`.vchip`).

## `openapi.yaml` — trava do contrato INTERNO (NÃO mexer)

Este diretório também guarda `openapi.yaml`. Ele **não** faz parte deste site público —
é a trava do contrato HTTP **interno** do Galeed, validada por
`test/unit/docs-openapi-drift.test.ts` (na raiz do repo). Mantenha o arquivo onde está; o
teste de drift deve continuar verde:

```sh
# da RAIZ do repo
npx vitest run test/unit/docs-openapi-drift.test.ts
```
