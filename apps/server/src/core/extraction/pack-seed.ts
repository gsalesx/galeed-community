/** M13/S2 — CLI `pack seed` / `pack show`. Handlers PUROS (recebem `{brain,...}`, retornam
 *  `{text, code}`) — o `cli.ts` parseia argv e injeta; aqui NÃO se lê `process.argv`. Espelha o
 *  `eval seed --from` (readFileSync + JSON.parse + chamada de persistência) e o padrão de handler de
 *  gate (`{ text, code }`). Faz o `a360.json` virar SEED (popula o banco UMA vez), não config viva.
 *
 *  Tenant-neutro (ADR-002): o domínio é INPUT (o JSON do pack), nunca código. Reusa a persistência do
 *  S1 (`saveSchemaPack`) — NÃO reimplementa. Ver docs/adr/ADR-007-config-db-native.md. */
import { readFileSync } from "node:fs";
import { dirname, resolve, isAbsolute, sep } from "node:path";
import {
  saveSchemaPack,
  loadSchemaPackAsync,
  schemaPackVersion,
  type SchemaPack,
} from "./schema-pack.ts";

/** M13: torna o pack SELF-CONTAINED pro banco. O `prompt_template` é um caminho relativo ao JSON de
 *  origem — o pack-root some quando o pack vai pro banco. Aqui resolvemos o arquivo (relativo ao dir do
 *  `from`) e embutimos o texto em `extractable[type].guidance`, pra `getExtractSchema` injetar a guidance
 *  mesmo com o pack vindo do banco (sem isto, o gate de extração regride: guidance vazia → recall cai). */
function inlineGuidance(pack: Partial<SchemaPack>, fromPath: string): void {
  if (!pack?.extractable || typeof pack.extractable !== "object") return;
  const root = dirname(resolve(fromPath));
  for (const spec of Object.values(pack.extractable)) {
    if (!spec || typeof spec !== "object") continue;
    if (spec.guidance && spec.guidance.trim()) continue; // já inline → respeita
    const rel = spec.prompt_template;
    if (!rel || typeof rel !== "string" || isAbsolute(rel) || rel.split(/[\\/]/).some((s) => s === "..")) continue;
    const abs = resolve(root, rel);
    if (abs !== root && !abs.startsWith(root + sep)) continue; // não escapa do dir do pack
    try {
      const text = readFileSync(abs, "utf8").trim();
      if (text) spec.guidance = text;
    } catch {
      /* arquivo ausente → segue sem inline (degrada pro default, como antes) */
    }
  }
}

/** Semeia a config de extração de um brain no banco a partir de um JSON de pack (espelha
 *  `eval seed --from`). NÃO lança: arquivo/JSON inválido → { code: 2 }. Tenant-neutro: saveSchemaPack
 *  normaliza os 3 campos e ignora campos de contexto. */
export async function packSeedCli({
  brain,
  from,
}: {
  brain: string;
  from: string;
}): Promise<{ text: string; code: number; version: number }> {
  if (!from)
    return {
      text: "✗ uso: galeed --brain <b> pack seed --from <arquivo.json>",
      code: 2,
      version: 0,
    };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(from, "utf8"));
  } catch (e) {
    return {
      text: `✗ não consegui ler/parsear ${from}: ${(e as Error).message}`,
      code: 2,
      version: 0,
    };
  }
  const pack = raw as Partial<SchemaPack>;
  inlineGuidance(pack, from); // M13: embute o prompt_template no pack → self-contained no banco
  const version = await saveSchemaPack(brain, pack); // S1 normaliza os 3 campos; ignora contexto
  const n =
    pack && typeof pack === "object" && pack.extractable ? Object.keys(pack.extractable).length : 0;
  const syn = Array.isArray(pack?.synonymClasses) ? pack.synonymClasses.length : 0;
  return {
    text: `✓ pack semeado no brain '${brain}' (v${version}) — ${syn} classes de sinônimo, ${n} tipos extraíveis`,
    code: 0,
    version,
  };
}

/** Imprime o pack efetivo do brain + a fonte (db|env|empty) + versão. Com json=true, imprime o objeto
 *  JSON do pack efetivo. Read-only → code sempre 0. */
export async function packShowCli({
  brain,
  json,
}: {
  brain: string;
  json?: boolean;
}): Promise<{ text: string; code: number }> {
  const pack = await loadSchemaPackAsync(brain); // popula cache + reflete DB>env>vazio
  const v = await schemaPackVersion(brain);
  // envKey replica EXATAMENTE a derivação de loadSchemaPack (schema-pack.ts) — não inventar outra.
  const envKey = `GALEED_SCHEMA_PACK_${brain.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
  const hasEnv = !!(process.env[envKey] || process.env.GALEED_SCHEMA_PACK);
  const source = v > 0 ? "db" : hasEnv ? "env" : "empty";
  if (json) {
    return {
      text: JSON.stringify(
        {
          source,
          version: v,
          synonymClasses: pack.synonymClasses,
          roleTokens: pack.roleTokens,
          extractable: pack.extractable,
        },
        null,
        2,
      ),
      code: 0,
    };
  }
  const types = Object.keys(pack.extractable);
  const lines = [
    `pack do brain '${brain}' — source: ${source}, version: ${v}`,
    `  synonymClasses: ${pack.synonymClasses.length}`,
    `  roleTokens: ${Object.keys(pack.roleTokens).length}`,
    `  extractable: ${types.length}${types.length ? " (" + types.join(", ") + ")" : ""}`,
  ];
  return { text: lines.join("\n"), code: 0 };
}
