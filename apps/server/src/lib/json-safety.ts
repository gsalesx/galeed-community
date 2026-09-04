/** P0 (#7) — defesas anti-DoS de JSON, EXTRAÍDAS de web-server.ts (e da cópia em ingest-server.ts)
 *  para serem reusadas pelos servers HTTP (BFF, ingest, gateway /v1) sem duplicar.
 *
 *  O crash de aninhamento profundo (RangeError de recursão) acontece DENTRO do JSON.parse, então um
 *  guard pós-parse NÃO salva: a stack já estourou antes de qualquer validação rodar. O fix é um SCAN
 *  PRÉ-PARSE puro (single-pass na string crua) que rejeita uma corrida de `[`/`{` consecutivos maior
 *  que o teto, ANTES de chamar JSON.parse. guardJsonShape pós-parse fica como defesa em profundidade
 *  (nós/profundidade do já-parseado).
 *
 *  HttpError carrega `httpCode` (espelho de `code`) para o catch do ingest-server, que lê `httpCode`. */

export class HttpError extends Error {
  public httpCode: number;
  constructor(public code: number, message: string) {
    super(message);
    this.httpCode = code;
  }
}

// Limites de forma do JSON: barram payloads de aninhamento profundo / explosão de chaves (DoS de
// parse/recursão). Pega o que o BODY_LIMIT em bytes não pega (ex.: `[[[[…]]]]` pequeno mas fundo).
export const MAX_JSON_DEPTH = 32;
export const MAX_JSON_NODES = 10000;
// Teto do SCAN PRÉ-PARSE: barra `[[[[…]]]]`/`{{{…}}}` ANTES do JSON.parse (o crash de recursão é
// DENTRO do parse — guardJsonShape pós-parse não salva). Folga acima do MAX_JSON_DEPTH lógico.
export const MAX_OPEN_RUN = 64;

/** SCAN DE PROFUNDIDADE PRÉ-PARSE (P0 DoS) — função pura, single-pass na string crua. Rejeita se
 *  houver uma corrida de caracteres de abertura `[`/`{` consecutivos (ignorando espaços em branco)
 *  maior que MAX_OPEN_RUN. NÃO é um parser de JSON: só conta aninhamento de abertura para impedir
 *  que `JSON.parse` estoure a própria stack (RangeError) antes de qualquer guard pós-parse rodar. */
export function scanJsonDepthPreParse(raw: string): void {
  let run = 0;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw.charCodeAt(i);
    if (ch === 0x5b /* [ */ || ch === 0x7b /* { */) {
      run += 1;
      if (run > MAX_OPEN_RUN) throw new HttpError(400, "JSON muito profundo");
    } else if (ch === 0x20 /* space */ || ch === 0x09 /* tab */ || ch === 0x0a /* \n */ || ch === 0x0d /* \r */) {
      // espaço em branco entre aberturas não zera a corrida (`[ [ [ …` continua sendo aninhamento)
    } else {
      run = 0;
    }
  }
}

/** Valida profundidade e contagem total de nós/chaves do objeto já parseado. Lança HttpError(400)
 *  se exceder. Função pura; itera em pilha (sem recursão) p/ não estourar a própria stack. */
export function guardJsonShape(root: unknown): void {
  let nodes = 0;
  const stack: Array<{ v: unknown; depth: number }> = [{ v: root, depth: 1 }];
  while (stack.length) {
    const { v, depth } = stack.pop()!;
    nodes += 1;
    if (depth > MAX_JSON_DEPTH || nodes > MAX_JSON_NODES) {
      throw new HttpError(400, "JSON muito complexo");
    }
    if (Array.isArray(v)) {
      for (const item of v) stack.push({ v: item, depth: depth + 1 });
    } else if (v && typeof v === "object") {
      for (const key of Object.keys(v as Record<string, unknown>)) {
        nodes += 1; // a chave conta como nó
        if (nodes > MAX_JSON_NODES) throw new HttpError(400, "JSON muito complexo");
        stack.push({ v: (v as Record<string, unknown>)[key], depth: depth + 1 });
      }
    }
  }
}
