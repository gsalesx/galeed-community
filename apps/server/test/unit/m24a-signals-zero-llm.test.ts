/** M24-A · §4.5 — lint estrutural da LEI I (zero LLM no diretório signals/). */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL("../../src/core/memory/signals/", import.meta.url));
const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
const read = (f: string) => readFileSync(dir + f, "utf8");

describe("zero-LLM lint (LEI I)", () => {
  it("0. tem os 7 arquivos de produção", () => {
    expect(files.sort()).toEqual(
      ["d1-tendencia.ts", "d2-silencio.ts", "d3-compromisso.ts", "index.ts", "load.ts", "prioritizer.ts", "types.ts"],
    );
  });

  it("1. nenhum import de llm/anthropic/usage/config", () => {
    for (const f of files) {
      const src = read(f);
      expect(/from\s+"[^"]*\/lib\/llm/.test(src), `${f} importa lib/llm`).toBe(false);
      expect(/from\s+"[^"]*\/lib\/anthropic/.test(src), `${f} importa lib/anthropic`).toBe(false);
      expect(/from\s+"[^"]*\/platform\/usage/.test(src), `${f} importa platform/usage`).toBe(false);
      expect(/from\s+"[^"]*\/platform\/config/.test(src), `${f} importa platform/config`).toBe(false);
    }
  });

  it("2. nenhuma chamada structured/prose/streamProse/recordUsage", () => {
    for (const f of files) {
      expect(/\b(structured|prose|streamProse|recordUsage)\s*\(/.test(read(f)), `${f} chama LLM`).toBe(false);
    }
  });

  it("3. só load.ts e index.ts mencionam getEngine/engine.ts", () => {
    for (const f of files) {
      const src = read(f);
      const mencionaEngine = /getEngine|platform\/engine/.test(src);
      if (f === "load.ts" || f === "index.ts") continue;
      expect(mencionaEngine, `${f} (puro) menciona engine`).toBe(false);
    }
  });

  it("4. nenhum write-method do engine no diretório", () => {
    const WRITE = /\b(putFacts|putEdges|upsertPage|insertPageIfNew|replaceDerived|replaceFactsForSourcesAndGroups|putExtraction|putReflection|replaceHypotheses|putLlmUsage|addReviewItems)\b/;
    for (const f of files) {
      expect(WRITE.test(read(f)), `${f} usa write-method`).toBe(false);
    }
  });
});
