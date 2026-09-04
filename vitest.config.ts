import { defineConfig } from "vitest/config";

/** Vitest resolve os imports `.ts` literais (os arquivos existem em disco), então o estilo
 *  NodeNext do projeto (`from "./x.ts"`) funciona sem tsconfig nem transform extra.
 *  `test` (npm) roda só test/unit (puro, sem infra). Integração é opt-in (precisa de Postgres). */
export default defineConfig({
  test: {
    include: ["apps/server/test/**/*.test.ts"],
    environment: "node",
    globals: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
