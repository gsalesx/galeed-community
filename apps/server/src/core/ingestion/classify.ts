/** Classificador determinístico (sem LLM) — o miolo da INGESTÃO AUTÔNOMA "só joga que organizamos".
 *  Decide TIPO + TÍTULO + PESSOAS a partir de texto cru + pista de fonte, por heurística barata.
 *  Quando a confiança é baixa, devolve { confident: false } → o TEMPO 2 (sono) escala pro LLM.
 *
 *  Filosofia (princípio 5): tempo 1 engole tudo; este classificador roda barato e crava o óbvio,
 *  deixando só o ambíguo pro LLM. Nunca falha: na dúvida, cai em "notas". */
import { TYPES, type Tipo } from "../platform/brain.ts";

export interface Classification {
  tipo: Tipo;
  title: string;
  people: string[];
  confident: boolean; // false → vale reprocessar com LLM no TEMPO 2
  signals: string[]; // o que disparou a decisão (debug/auditoria)
}

/** Pista da origem do webhook → viés de tipo. */
const SOURCE_HINT: Record<string, Tipo> = {
  notetaker: "reunioes",
  meeting: "reunioes",
  fireflies: "reunioes",
  fathom: "reunioes",
  zoom: "reunioes",
  gmeet: "reunioes",
  whatsapp: "notas",
  telegram: "notas",
  email: "notas",
  gmail: "notas",
};

/** Pistas de conteúdo (PT-BR), em ordem de prioridade. Cada regra: regex → tipo. */
const CONTENT_RULES: { re: RegExp; tipo: Tipo; signal: string }[] = [
  { re: /\b(decidimos|ficou decidido|decis[ãa]o|vamos seguir com|aprovad[oa]|definimos que)\b/i, tipo: "decisoes", signal: "verbo-decisão" },
  { re: /\b(reuni[ãa]o|call|ata da|1:1|daily|standup|kickoff|transcri[çc][ãa]o|participantes:)\b/i, tipo: "reunioes", signal: "marca-reunião" },
  { re: /\b(cliente|conta|lead|prospect|empresa|cnpj|raz[ãa]o social)\b/i, tipo: "clientes", signal: "marca-cliente" },
  { re: /\b(produto|feature|roadmap|pre[çc]o|pricing|plano|sku|pacote)\b/i, tipo: "produtos", signal: "marca-produto" },
  { re: /\b(conceito|framework|metodologia|princ[íi]pio|teoria|defini[çc][ãa]o)\b/i, tipo: "conceitos", signal: "marca-conceito" },
];

function extractPeople(text: string): string[] {
  const out = new Set<string>();
  // [[wikilinks]] e @menções viram pessoas candidatas (a resolução canônica é no indexer)
  for (const m of text.matchAll(/\[\[([^\]|]+)\]\]/g)) out.add(`[[${m[1].trim()}]]`);
  for (const m of text.matchAll(/(?:^|\s)@([a-zA-ZÀ-ÿ][\w.-]{1,30})/g)) out.add(`[[pessoas/${m[1].toLowerCase()}]]`);
  return [...out].slice(0, 20);
}

/** Título: 1ª linha não-vazia limpa (markdown header, bullets, timestamps de transcrição). */
function deriveTitle(text: string): string {
  for (const raw of text.trim().split("\n")) {
    const l = raw
      .replace(/^#+\s*/, "")
      .replace(/^[-*>\s]+/, "")
      .replace(/^\[?\d{1,2}:\d{2}(:\d{2})?\]?\s*/, "") // [00:12] do notetaker
      .trim();
    if (l.length >= 3) return l.slice(0, 80);
  }
  return "nota";
}

export function classify(text: string, opts: { source?: string; type?: string; title?: string } = {}): Classification {
  const signals: string[] = [];

  // tipo explícito vence tudo (modo manual ainda funciona)
  if (opts.type && TYPES.includes(opts.type as Tipo)) {
    return { tipo: opts.type as Tipo, title: opts.title?.trim() || deriveTitle(text), people: extractPeople(text), confident: true, signals: ["tipo-explícito"] };
  }

  let tipo: Tipo | null = null;

  // pista de fonte (viés inicial)
  const src = (opts.source || "").toLowerCase();
  for (const key of Object.keys(SOURCE_HINT)) {
    if (src.includes(key)) { tipo = SOURCE_HINT[key]; signals.push(`fonte:${key}`); break; }
  }

  // conteúdo pode sobrepor a fonte (mais específico): primeira regra que casar manda
  for (const rule of CONTENT_RULES) {
    if (rule.re.test(text)) {
      if (!tipo || tipo === "notas") { tipo = rule.tipo; signals.push(rule.signal); break; }
      // já tinha viés de fonte forte; conteúdo confirma/ajusta só se a fonte era genérica
      signals.push(rule.signal);
      tipo = rule.tipo;
      break;
    }
  }

  const confident = tipo !== null;
  return {
    tipo: tipo ?? "notas",
    title: opts.title?.trim() || deriveTitle(text),
    people: extractPeople(text),
    confident,
    signals: confident ? signals : ["sem-pista→notas"],
  };
}
