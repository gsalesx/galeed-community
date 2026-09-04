import { defineConfig } from "astro/config";

// Documentação PÚBLICA do Galeed — site estático em Astro puro (sem integrações).
// O design vive em src/styles/global.css (copiado verbatim do design system) e nos
// componentes de src/components/. As seções (src/sections/*.astro) são preenchidas
// pelos agentes de conteúdo; a fundação só precisa BUILDAR e ser fiel ao design.
//
// Ajuste `site`/`base` no deploy (ex.: docs.galeed.com). base default "/".
// base: "/docs" faz o Astro prefixar todos os assets e links internos com /docs,
// para que o site funcione servido atrás do Caddy em /docs/*.
export default defineConfig({
  base: "/docs",
  // Shiki para o realce de código dos <CodeBlock>, com um tema escuro custom que
  // reproduz as cores do design (--code-bg de fundo, tok-k/s/n/p).
  markdown: {
    shikiConfig: {
      theme: "css-variables",
    },
  },
});
