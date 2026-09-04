/** P1-C/item 6 (revisto) — resolveExtractionProvider PURO. Contrato atual: a API é preferida
 *  ('api' explícito, ou 'auto' com chave), e SEM chave a extração cai na assinatura local
 *  (CLI `claude` ou ChatGPT/Codex em ~/.codex/auth.json). Sem chave E sem assinatura → erro claro
 *  citando ANTHROPIC_API_KEY. cliAvailable()/codexAvailable() dependem da máquina. */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resolveExtractionProvider, subscriptionAvailable } from "../../src/lib/llm.ts";

describe("P1-C item 6 — resolveExtractionProvider (api preferida; cli é fallback com schema por instrução)", () => {
  let savedKey: string | undefined;
  let savedProvider: string | undefined;
  let savedBackend: string | undefined;

  beforeEach(() => {
    savedKey = process.env.ANTHROPIC_API_KEY;
    savedProvider = process.env.GALEED_PROVIDER;
    savedBackend = process.env.GALEED_CLI_BACKEND;
    delete process.env.GALEED_PROVIDER;
    delete process.env.GALEED_CLI_BACKEND;
  });
  afterEach(() => {
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedKey;
    if (savedProvider === undefined) delete process.env.GALEED_PROVIDER;
    else process.env.GALEED_PROVIDER = savedProvider;
    if (savedBackend === undefined) delete process.env.GALEED_CLI_BACKEND;
    else process.env.GALEED_CLI_BACKEND = savedBackend;
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

  it("3. prefer='cli' → assinatura presente: 'cli' com warning 1×; ausente: lança citando a key", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    if (subscriptionAvailable()) {
      expect(resolveExtractionProvider("cli")).toBe("cli");
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toMatch(/claude|ChatGPT\/Codex/);
    } else {
      expect(() => resolveExtractionProvider("cli")).toThrow("ANTHROPIC_API_KEY");
    }
  });

  it("4. prefer=undefined SEM key → assinatura presente: 'cli'; ausente: lança citando a key", () => {
    delete process.env.ANTHROPIC_API_KEY;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    if (subscriptionAvailable()) {
      expect(resolveExtractionProvider(undefined)).toBe("cli");
    } else {
      expect(() => resolveExtractionProvider(undefined)).toThrow("ANTHROPIC_API_KEY");
    }
  });
});
