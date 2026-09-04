/** P1-C/item 6 (revisto) — resolveExtractionProvider PURO. Contrato atual: a API é preferida
 *  ('api' explícito, ou 'auto' com chave), e SEM chave a extração cai no binário `claude` local
 *  quando ele existe (o structured() do caminho 'cli' instrui o modelo com o próprio
 *  tool.input_schema — o schema tipado não se perde mais). Sem chave E sem binário → erro claro
 *  citando ANTHROPIC_API_KEY. cliAvailable() depende da máquina, então os casos 'cli' fazem
 *  a asserção condicional ao ambiente. */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resolveExtractionProvider, cliAvailable } from "../../src/lib/llm.ts";

describe("P1-C item 6 — resolveExtractionProvider (api preferida; cli é fallback com schema por instrução)", () => {
  let savedKey: string | undefined;

  beforeEach(() => {
    savedKey = process.env.ANTHROPIC_API_KEY;
  });
  afterEach(() => {
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedKey;
    vi.restoreAllMocks();
  });

  it("1. prefer='api' → 'api' (sempre, sem env)", () => {
    delete process.env.ANTHROPIC_API_KEY;
    expect(resolveExtractionProvider("api")).toBe("api");
  });

  it("2. prefer=undefined + chave → 'api' (auto prefere api na extração, mesmo com binário claude)", () => {
    process.env.ANTHROPIC_API_KEY = "sk-p1c-contrato";
    expect(resolveExtractionProvider(undefined)).toBe("api");
  });

  it("3. prefer='cli' → binário presente: 'cli' com warning 1×; ausente: lança citando a key", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    if (cliAvailable()) {
      expect(resolveExtractionProvider("cli")).toBe("cli");
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain("binário `claude` local");
    } else {
      expect(() => resolveExtractionProvider("cli")).toThrow("ANTHROPIC_API_KEY");
    }
  });

  it("4. prefer=undefined SEM key → binário presente: 'cli'; ausente: lança citando a key", () => {
    delete process.env.ANTHROPIC_API_KEY;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    if (cliAvailable()) {
      expect(resolveExtractionProvider(undefined)).toBe("cli");
    } else {
      expect(() => resolveExtractionProvider(undefined)).toThrow("ANTHROPIC_API_KEY");
    }
  });
});
