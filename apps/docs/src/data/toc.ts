// Sumário (TOC) do site de documentação. A nav lateral E a página leem daqui — é a
// única fonte da ordem e dos grupos das seções. Os agentes de conteúdo NÃO mexem aqui:
// eles preenchem src/sections/<id>.astro.

export type Method = "get" | "post" | "del";

export interface TocSection {
  /** id da <section> (= âncora #id e nome do arquivo src/sections/<id>.astro) */
  id: string;
  /** índice de dois dígitos exibido na TOC e no cabeçalho da seção */
  ix: string;
  /** título da seção */
  title: string;
  /** grupo a que pertence (deve existir em GROUPS) */
  group: string;
  /** verbo HTTP, quando a seção é um endpoint (mostra o chip na TOC) */
  method?: Method;
}

export const GROUPS: string[] = [
  "Comece aqui",
  "Na prática",
  "Referência da API",
  "Integração",
];

export const SECTIONS: TocSection[] = [
  { id: "introducao", ix: "00", title: "Introdução", group: "Comece aqui" },
  { id: "inicio", ix: "01", title: "Início rápido", group: "Comece aqui" },
  { id: "conceitos", ix: "02", title: "Conceitos", group: "Comece aqui" },
  { id: "arquitetura", ix: "03", title: "Arquitetura do Galeed", group: "Comece aqui" },
  { id: "casos", ix: "04", title: "Casos de uso", group: "Na prática" },
  { id: "fluxos", ix: "05", title: "Fluxos", group: "Na prática" },
  { id: "auth", ix: "06", title: "Autenticação", group: "Referência da API" },
  { id: "ingestao", ix: "07", title: "Ingestão", group: "Referência da API", method: "post" },
  { id: "perguntar", ix: "08", title: "Perguntar", group: "Referência da API", method: "post" },
  { id: "fatos", ix: "09", title: "Fatos", group: "Referência da API", method: "get" },
  { id: "fontes", ix: "10", title: "Fontes e receitas", group: "Referência da API" },
  { id: "mcp", ix: "11", title: "MCP: conecte qualquer IA", group: "Integração" },
  { id: "integracoes", ix: "12", title: "Integrações prontas", group: "Integração", method: "post" },
  { id: "webhooks", ix: "13", title: "Webhooks", group: "Integração" },
  { id: "erros", ix: "14", title: "Erros e limites", group: "Integração" },
];

/** Seções agrupadas, na ordem de GROUPS, preservando a ordem de SECTIONS dentro de cada grupo. */
export function sectionsByGroup(): { group: string; items: TocSection[] }[] {
  return GROUPS.map((group) => ({
    group,
    items: SECTIONS.filter((s) => s.group === group),
  }));
}
