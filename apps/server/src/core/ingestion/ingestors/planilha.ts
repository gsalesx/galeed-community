/** Ingestor "planilha" — TABELA → claims DETERMINÍSTICOS (zero LLM, caminho B do seam).
 *
 *  O caso mais comum de empresa tradicional: tabela de preços, catálogo de serviços, lista de
 *  fornecedores, comissões. Nada disso precisa de IA pra virar fato — cada linha JÁ É um claim
 *  (entidade · atributo · valor). Este ingestor rende a tabela como página legível e emite um
 *  claim POR LINHA, ancorado por construção: o context_quote de cada claim é a PRÓPRIA linha
 *  do body (mesma técnica do conector Conta Azul — R2: value/quote sempre substrings literais).
 *
 *  Aceita DOIS formatos:
 *   A) linhas estruturadas:
 *      { "titulo": "Tabela de preços", "data": "2026-08-01",
 *        "linhas": [ { "entidade": "Limpeza de pele", "atributo": "preço", "valor": 180,
 *                      "unidade": "BRL", "periodo": "", "tier": "", "data": "2026-08-01" } ] }
 *   B) CSV com cabeçalho (colunas: entidade, atributo, valor [, unidade, periodo, tier, data]):
 *      { "titulo": "...", "csv": "entidade,atributo,valor\nLimpeza de pele,preço,180" }
 *
 *  Re-enviar a MESMA tabela deduplica; tabela alterada vira página nova e os claims novos
 *  SUPERAM os antigos pelo bitemporal (valid_from) — o cérebro guarda a história do preço. */
import { createHash } from "node:crypto";
import type { ConnectorClaim } from "../connector-ingest.ts";
import type { Ingestor, IngestorItem } from "./types.ts";

/** dimensão dos claims — TEM que existir na receita da fonte (sourceSeed abaixo), senão o gate
 *  manda tudo pra fila de revisão. */
const DIM = "planilha";

function sha16(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

/** slug curto/estável minúsculo (mesma convenção dos conectores — módulos independentes). */
function slugify(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

/** moeda pt-BR SEM NBSP (mesma técnica do conta-azul: usada no body E no claim → âncora por construção). */
function formatBRL(n: number): string {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" })
    .format(n)
    .replace(/\u00a0/g, " ");
}

interface Linha {
  entidade: string;
  atributo: string;
  valor: string; // grafia EXATA que vai pro body (e pro claim.value)
  valorNum: number | null;
  unidade: string;
  periodo: string;
  tier: string;
  data: string; // YYYY-MM-DD ("" = usa a data da tabela)
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : v === null || v === undefined ? "" : String(v).trim();
}

function dateOnly(raw: unknown): string {
  const m = str(raw).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : "";
}

/** número tolerante a formato BR — SÓ quando o valor É numérico ("R$ 1.250,50", "180", "5%").
 *  Texto com dígito dentro ("7 dias úteis") NÃO vira número: não infle precisão (regra de
 *  qualidade da extração — melhor value textual que value_num enganoso). */
function numeroDe(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const s = str(v).replace(/^R\$\s*/i, "").replace(/%$/, "").trim();
  if (!/^-?[\d.,]+$/.test(s)) return null;
  const canon = s.includes(",") ? s.replace(/\./g, "").replace(",", ".") : s;
  const n = Number(canon);
  return Number.isFinite(n) ? n : null;
}

/** valor exibível: número + unidade BRL → "R$ 1.250,00"; senão a grafia original. */
function renderValor(bruto: unknown, valorNum: number | null, unidade: string): string {
  if (valorNum !== null && unidade.toUpperCase() === "BRL") return formatBRL(valorNum);
  const s = str(bruto);
  return s || (valorNum !== null ? String(valorNum) : "");
}

function linhaDe(raw: Record<string, unknown>): Linha | null {
  const entidade = str(raw.entidade);
  const atributo = str(raw.atributo);
  if (!entidade || !atributo) return null;
  const unidade = str(raw.unidade);
  const valorNum = numeroDe(raw.valor);
  const valor = renderValor(raw.valor, valorNum, unidade);
  if (!valor) return null;
  return {
    entidade,
    atributo,
    valor,
    valorNum,
    unidade,
    periodo: str(raw.periodo),
    tier: str(raw.tier),
    data: dateOnly(raw.data),
  };
}

/** mini-CSV com cabeçalho: suporta aspas duplas ("a,b") e vírgula OU ponto-e-vírgula (Excel BR). */
export function parseCsv(texto: string): Record<string, string>[] {
  const linhas = texto.replace(/\r\n?/g, "\n").split("\n").filter((l) => l.trim() !== "");
  if (linhas.length < 2) return [];
  const sep = (linhas[0].match(/;/g)?.length ?? 0) > (linhas[0].match(/,/g)?.length ?? 0) ? ";" : ",";
  const campos = (l: string): string[] => {
    const out: string[] = [];
    let cur = "";
    let emAspas = false;
    for (let i = 0; i < l.length; i++) {
      const c = l[i];
      if (emAspas) {
        if (c === '"' && l[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') emAspas = false;
        else cur += c;
      } else if (c === '"') emAspas = true;
      else if (c === sep) { out.push(cur); cur = ""; }
      else cur += c;
    }
    out.push(cur);
    return out.map((s) => s.trim());
  };
  const header = campos(linhas[0]).map((h) => slugify(h).replace(/-/g, "_"));
  return linhas.slice(1).map((l) => {
    const vals = campos(l);
    const row: Record<string, string> = {};
    header.forEach((h, i) => { row[h] = vals[i] ?? ""; });
    return row;
  });
}

export const planilhaIngestor: Ingestor = {
  slug: "planilha",
  nome: "Planilha / tabela (fatos direto, sem IA)",
  descricao: "Tabela de preços, catálogo, comissões: cada linha vira um fato carimbado na hora — zero LLM.",
  exemplo: `{ "titulo": "Tabela de preços — agosto", "data": "2026-08-01", "linhas": [ { "entidade": "Limpeza de pele", "atributo": "preço", "valor": 180, "unidade": "BRL" } ] }`,

  sourceSeed() {
    return {
      name: "Planilhas e tabelas",
      channel: "planilha",
      type: "tabela",
      // a receita PRECISA conter a dimensão dos claims — é ela que o gate aprova.
      recipe: { fields: [{ dimension: DIM, label: "Linha da tabela", area: "" }] },
    };
  },

  normalize(body): IngestorItem[] {
    const b = (body ?? {}) as Record<string, unknown>;
    const titulo = str(b.titulo) || str(b.title) || "Tabela";
    const dataTabela = dateOnly(b.data) || dateOnly(b.occurred_at) || new Date().toISOString().slice(0, 10);

    let brutas: Record<string, unknown>[] = [];
    if (Array.isArray(b.linhas)) brutas = b.linhas as Record<string, unknown>[];
    else if (str(b.csv)) brutas = parseCsv(str(b.csv));
    const linhas = brutas.map(linhaDe).filter((l): l is Linha => l !== null);
    if (!linhas.length) return []; // sem linha válida → ignora (o 202 explica "ignored")

    // body: 1 linha de texto POR linha da tabela — o claim ancora nela VERBATIM.
    const linhasTexto = linhas.map((l) => {
      const extras = [l.tier && `plano ${l.tier}`, l.periodo && `por ${l.periodo}`, (l.data || dataTabela) && `desde ${l.data || dataTabela}`]
        .filter(Boolean)
        .join(" · ");
      return `- ${l.entidade} — ${l.atributo}: ${l.valor}${extras ? ` (${extras})` : ""}`;
    });
    // "Data — X" (travessão): "Data: X" seria lido como falante pelo segmentador de conversa.
    const content = `# ${titulo}\n\nData — ${dataTabela}\n\n${linhasTexto.join("\n")}`;

    const claims: ConnectorClaim[] = linhas.map((l, i) => {
      const c: ConnectorClaim = {
        dimension: DIM,
        entity: slugify(l.entidade),
        predicate: slugify(l.atributo).replace(/-/g, "_"),
        value: l.valor,
        date: l.data || dataTabela,
        valid_from: l.data || dataTabela,
        context_quote: linhasTexto[i], // a linha LITERAL do body — grounded por construção
        text: `${l.entidade}: ${l.atributo} ${l.valor}`,
      };
      if (l.valorNum !== null) c.value_num = l.valorNum;
      if (l.unidade) c.unit = l.unidade;
      if (l.periodo) c.period = l.periodo;
      if (l.tier) c.tier = l.tier;
      return c;
    });

    return [{
      content,
      contentType: "text/markdown",
      timestamp: `${dataTabela}T00:00:00.000Z`,
      externalRef: `planilha:${sha16(content)}`,
      title: titulo,
      claims,
    }];
  },
};
