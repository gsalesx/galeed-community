/** INVARIANTE ARQUITETURAL: abertura de pool Postgres só em pontos autorizados.
 *  O core deve usar `platform/db-conn.ts` para módulos auxiliares e `PostgresEngine` para o engine
 *  por-tenant. Este teste impede que um módulo novo copie `await import("postgres")` ou `postgres(...)`
 *  e reabra a dívida resolvida pelo ADR-013. */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(new URL("../..", import.meta.url).pathname);
const SEARCH_DIRS = ["src", "test"];
const ALLOWED = new Set([
  "src/core/platform/db-conn.ts",
  "src/core/engines/postgres.ts",
  "test/integration/helpers/db.ts",
]);

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = resolve(dir, name);
    const st = statSync(path);
    if (st.isDirectory()) {
      if (name === "node_modules" || name === "dist" || name === "build") continue;
      out.push(...tsFiles(path));
    } else if (name.endsWith(".ts") || name.endsWith(".tsx")) {
      out.push(path);
    }
  }
  return out;
}

describe("arquitetura — fronteira de conexão Postgres", () => {
  it("não abre postgres fora de db-conn/PostgresEngine/helper de teste", () => {
    const offenders: string[] = [];
    for (const base of SEARCH_DIRS) {
      for (const file of tsFiles(resolve(ROOT, base))) {
        const rel = relative(ROOT, file);
        if (ALLOWED.has(rel) || rel === "test/unit/postgres-boundary.test.ts") continue;
        const src = readFileSync(file, "utf8");
        if (/import\(["']postgres["']\)|\bpostgres\s*\(/.test(src)) offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });
});
