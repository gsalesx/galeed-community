/** Gerador `galeed schema scaffold-extractable <type> --pack <pack>` (M9/S4). Três efeitos atômicos:
 *  1) muta o JSON do pack: extractable[type] = {prompt_template, fixture_corpus, eval_dimensions};
 *  2) escreve <packDir>/prompts/extract/<type>.md (template editável);
 *  3) escreve <packDir>/fixtures/extract/<type>.jsonl (5 fixtures placeholder).
 *  Idempotente: refuse-to-overwrite (a menos de `force`). Paths validados (anti-traversal/symlink).
 *
 *  Adaptado do gbrain `src/core/schema-pack/scaffold-extractable.ts`:
 *   - buildPromptTemplate/buildFixtureCorpus (helpers puros) + a postura refuse-to-overwrite vêm de lá;
 *   - a regra "fixture path validation no consume site / scaffold só gera relativo" (D-EXTRACT-21) é
 *     replicada aqui como `validatePackRelativePath` (anti-traversal/symlink/absoluto/null byte);
 *   - o gbrain muta via `updateTypeOnPack` (manifest YAML + lock + audit); o Galeed faz read-modify-write
 *     do JSON flat preservando synonymClasses/roleTokens (sem o aparato de lock/manifest do gbrain).
 *   - shape de fixture/claim alinhado ao S3 (context_quote = substring verbatim; value_num número cru). */

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";

export interface ScaffoldExtractableOpts {
  type: string;       // tipo de página (slug simples: [a-z0-9_-])
  packPath: string;   // caminho do JSON do pack do tenant
  force?: boolean;    // sobrescreve os arquivos gerados
}

export interface ScaffoldResult {
  packPath: string;
  promptPath: string;   // relativo ao pack-root
  fixturePath: string;  // relativo ao pack-root
  wrote: string[];      // arquivos efetivamente escritos
  skipped: string[];    // arquivos pulados (já existiam, sem force)
}

const TYPE_RE = /^[a-z0-9][a-z0-9_-]*$/;

/** Valida um caminho RELATIVO ao pack-root. Rejeita: absoluto, contém `..`, null byte, ou resolve p/
 *  fora do pack-root (checa `path.resolve` + symlink real via `realpathSync` quando o alvo existir).
 *  Lança Error com mensagem clara. (D-EXTRACT-21 do gbrain.) */
export function validatePackRelativePath(rel: string, packRoot: string): string {
  if (typeof rel !== "string" || rel.length === 0) {
    throw new Error(`scaffold-extractable: caminho relativo vazio/ inválido: ${JSON.stringify(rel)}`);
  }
  if (rel.includes("\0")) {
    throw new Error(`scaffold-extractable: caminho contém null byte: ${JSON.stringify(rel)}`);
  }
  if (isAbsolute(rel)) {
    throw new Error(`scaffold-extractable: caminho deve ser RELATIVO ao pack-root, recebi absoluto: ${rel}`);
  }
  if (rel.split(/[\\/]/).some((seg) => seg === "..")) {
    throw new Error(`scaffold-extractable: caminho não pode conter '..' (traversal): ${rel}`);
  }
  const rootReal = realpathSync(packRoot);
  const abs = resolve(rootReal, rel);
  // resolve já normaliza; confirma que o alvo cai DENTRO do pack-root.
  if (abs !== rootReal && !abs.startsWith(rootReal + sep)) {
    throw new Error(`scaffold-extractable: caminho resolve p/ fora do pack-root: ${rel}`);
  }
  // se o alvo (ou um ancestral) já existe como symlink p/ fora do root, rejeita.
  let probe = abs;
  while (probe !== rootReal && probe.length > rootReal.length) {
    if (existsSync(probe)) {
      const real = realpathSync(probe);
      if (real !== rootReal && !real.startsWith(rootReal + sep)) {
        throw new Error(`scaffold-extractable: caminho aponta (symlink) p/ fora do pack-root: ${rel}`);
      }
      break;
    }
    probe = dirname(probe);
  }
  return abs;
}

/** Helper puro: corpo do template de prompt p/ este tipo. Regra de ancoragem alinhada ao S3
 *  (context_quote = substring verbatim do corpo; value_num número cru). PT. Pack-author edita depois. */
export function buildPromptTemplate(type: string): string {
  return `# Extração: ${type}

Extraia da fonte uma lista de claims estruturados. Responda com um JSON array de objetos:
[{ "text": "...", "context_quote": "...", "entity": "...", "predicate": "snake_case",
   "value": "...", "value_num": <number|null>, "unit": "...", "period": "...", "tier": "...",
   "valid_from": "YYYY-MM-DD" }]

Regras:
- context_quote DEVE ser uma substring VERBATIM do corpo da fonte. Não parafraseie.
- value_num só quando há número no texto; número CRU (30000, não "R$ 30K"). Não infle precisão.
- Um claim por afirmação (atômico). Pule metadados triviais (teste "so what").
- Não especule além do corpo. Em dúvida, deixe os campos tipados vazios.
`;
}

/** Helper puro: 5 fixtures placeholder (JSONL). Cada linha:
 *  { fixture_id, page_body, expected_claims: [...], notes }. Shape consumido pelo S5 (§1).
 *  Cobertura: single-claim, no-claim, multi-claim, ambiguous, implicit-date. Só nomes placeholder. */
export function buildFixtureCorpus(type: string): string {
  const fixtures = [
    {
      fixture_id: `${type}-001-single-claim`,
      page_body: "A empresa-exemplo fechou um contrato de 30000 reais por mês em 2024.",
      expected_claims: [
        {
          text: "contrato de 30000 reais por mês",
          context_quote: "contrato de 30000 reais por mês",
          entity: "empresa-exemplo",
          predicate: "contract_value",
          value: "30000",
          value_num: 30000,
          unit: "BRL",
          period: "mes",
          tier: "",
          valid_from: "2024-01-01",
        },
      ],
      notes: "Baseline: um claim numérico tipado.",
    },
    {
      fixture_id: `${type}-002-no-claim`,
      page_body: "Esta página é só texto de preenchimento e não contém nenhum claim extraível.",
      expected_claims: [],
      notes: "Caso negativo: o extrator deve retornar [].",
    },
    {
      fixture_id: `${type}-003-multi-claim`,
      page_body: "A startup-exemplo levantou 5000000 em 2021 e cresceu para 12 funcionários em 2022.",
      expected_claims: [
        {
          text: "levantou 5000000",
          context_quote: "levantou 5000000 em 2021",
          entity: "startup-exemplo",
          predicate: "funding_raised",
          value: "5000000",
          value_num: 5000000,
          unit: "BRL",
          period: "",
          tier: "",
          valid_from: "2021-01-01",
        },
        {
          text: "cresceu para 12 funcionários",
          context_quote: "cresceu para 12 funcionários em 2022",
          entity: "startup-exemplo",
          predicate: "headcount",
          value: "12",
          value_num: 12,
          unit: "",
          period: "",
          tier: "",
          valid_from: "2022-01-01",
        },
      ],
      notes: "Dois claims na mesma frase.",
    },
    {
      fixture_id: `${type}-004-ambiguous`,
      page_body: "O fundo-a talvez tenha liderado a rodada, embora as fontes sejam inconsistentes.",
      expected_claims: [
        {
          text: "fundo-a talvez liderou a rodada",
          context_quote: "O fundo-a talvez tenha liderado a rodada",
          entity: "fundo-a",
          predicate: "led_round",
          value: "",
          value_num: null,
          unit: "",
          period: "",
          tier: "",
          valid_from: "",
        },
      ],
      notes: "Claim textual, sem número (linguagem hedge).",
    },
    {
      fixture_id: `${type}-005-implicit-date`,
      page_body: "Em 03/02/2026 a equipe-exemplo aprovou o novo orçamento.",
      expected_claims: [
        {
          text: "equipe-exemplo aprovou o novo orçamento",
          context_quote: "a equipe-exemplo aprovou o novo orçamento",
          entity: "equipe-exemplo",
          predicate: "budget_approved",
          value: "",
          value_num: null,
          unit: "",
          period: "",
          tier: "",
          valid_from: "2026-02-03",
        },
      ],
      notes: "Data no texto → valid_from esperado.",
    },
  ];
  return fixtures.map((f) => JSON.stringify(f)).join("\n") + "\n";
}

/** Helper puro: a ExtractableSpec que vai p/ extractable[type] no JSON do pack. */
export function buildExtractableSpec(type: string): {
  prompt_template: string;
  fixture_corpus: string;
  eval_dimensions: string[];
} {
  return {
    prompt_template: `prompts/extract/${type}.md`,
    fixture_corpus: `fixtures/extract/${type}.jsonl`,
    eval_dimensions: ["faithfulness", "completeness"],
  };
}

/** Entry principal. read-modify-write do JSON do pack (preserva synonymClasses/roleTokens) + escreve
 *  prompt + fixtures. Idempotente (refuse-to-overwrite; `force` sobrescreve). Função pura de efeitos:
 *  o plugue CLI é do Integrador. */
export function scaffoldExtractable(opts: ScaffoldExtractableOpts): ScaffoldResult {
  const { type, packPath, force } = opts;
  if (!TYPE_RE.test(type)) {
    throw new Error(
      `scaffold-extractable: type inválido ${JSON.stringify(type)} — deve casar /^[a-z0-9][a-z0-9_-]*$/`,
    );
  }

  const packAbs = resolve(packPath);
  if (!existsSync(packAbs)) {
    throw new Error(`scaffold-extractable: pack não encontrado: ${packPath}`);
  }
  const packRoot = dirname(realpathSync(packAbs));

  // paths relativos ao pack-root (validados anti-traversal/symlink).
  const promptRel = `prompts/extract/${type}.md`;
  const fixtureRel = `fixtures/extract/${type}.jsonl`;
  const promptAbs = validatePackRelativePath(promptRel, packRoot);
  const fixtureAbs = validatePackRelativePath(fixtureRel, packRoot);

  // 1) read-modify-write do JSON do pack — preserva o que já existe, só insere/atualiza extractable[type].
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(packAbs, "utf8"));
  } catch (e) {
    throw new Error(`scaffold-extractable: pack JSON inválido (${packPath}): ${(e as Error).message}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`scaffold-extractable: pack JSON deve ser um objeto: ${packPath}`);
  }
  const extractable =
    raw.extractable && typeof raw.extractable === "object" && !Array.isArray(raw.extractable)
      ? (raw.extractable as Record<string, unknown>)
      : {};
  extractable[type] = buildExtractableSpec(type);
  raw.extractable = extractable;
  writeFileSync(packAbs, JSON.stringify(raw, null, 2) + "\n");

  // 2 + 3) escreve prompt + fixtures (refuse-to-overwrite a menos de force).
  const wrote: string[] = [];
  const skipped: string[] = [];

  mkdirSync(dirname(promptAbs), { recursive: true });
  if (!existsSync(promptAbs) || force) {
    writeFileSync(promptAbs, buildPromptTemplate(type));
    wrote.push(promptRel);
  } else {
    skipped.push(promptRel);
  }

  mkdirSync(dirname(fixtureAbs), { recursive: true });
  if (!existsSync(fixtureAbs) || force) {
    writeFileSync(fixtureAbs, buildFixtureCorpus(type));
    wrote.push(fixtureRel);
  } else {
    skipped.push(fixtureRel);
  }

  return { packPath: packAbs, promptPath: promptRel, fixturePath: fixtureRel, wrote, skipped };
}

/** Handler CLI puro (o Integrador pluga em cli.ts). Parseia args-like, chama scaffoldExtractable,
 *  devolve texto p/ stdout + exit code. NÃO chama process.exit aqui. */
export function scaffoldExtractableCli(args: {
  type?: string;
  pack?: string;
  force?: boolean;
}): { text: string; code: number } {
  if (!args.type) {
    return { text: "uso: galeed schema scaffold-extractable <type> --pack <pack.json> [--force]", code: 1 };
  }
  if (!args.pack) {
    return { text: "scaffold-extractable: --pack <pack.json> é obrigatório", code: 1 };
  }
  try {
    const r = scaffoldExtractable({ type: args.type, packPath: args.pack, force: args.force });
    const lines = [
      `scaffold-extractable: tipo '${args.type}' declarado em ${r.packPath}`,
      r.wrote.length ? `  escreveu: ${r.wrote.join(", ")}` : "",
      r.skipped.length ? `  pulou (já existia; use --force): ${r.skipped.join(", ")}` : "",
      `  edite ${r.promptPath} e ${r.fixturePath}, depois rode 'galeed extract benchmark'.`,
    ].filter(Boolean);
    return { text: lines.join("\n"), code: 0 };
  } catch (e) {
    return { text: `scaffold-extractable: ERRO — ${(e as Error).message}`, code: 1 };
  }
}
