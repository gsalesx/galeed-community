/** M23-C/S4 — sanidade/scrub do corpus de gate (PURO, sem DB/LLM). Excertos REAIS do S0 com slug
 *  de proveniência; predicado fixo por classe; valid_from ancorado no MÊS do timestamp da mensagem;
 *  nenhum PII além do que o S0 já publicou; cópia byte-idêntica nos dois lugares. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const fxPath = fileURLToPath(new URL("../../fixtures/extract/memoria-nao-numerica.jsonl", import.meta.url));
const packFxPath = fileURLToPath(
  new URL("../../schema-packs/fixtures/extract/memoria-nao-numerica.jsonl", import.meta.url),
);
const raw = readFileSync(fxPath, "utf8");
const fixtures = raw
  .trim()
  .split("\n")
  .filter((l) => l.trim().length > 0)
  .map((l) => JSON.parse(l) as any);

const PREDS = new Set(["relacao", "decisao", "compromisso"]);

describe("M23-C — sanidade/scrub do corpus memoria-nao-numerica.jsonl", () => {
  it("1. JSONL parseável; fixture_id único com prefixo m23c-", () => {
    const ids = fixtures.map((f) => f.fixture_id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^m23c-/);
  });

  it("2. predicate ∈ {relacao,decisao,compromisso}; entity slug; valid_from ISO e mês no timestamp do body", () => {
    for (const f of fixtures) {
      for (const c of f.expected_claims) {
        expect(PREDS.has(c.predicate)).toBe(true);
        expect(c.entity).toMatch(/^[a-z][a-z0-9-]*$/);
        expect(c.valid_from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        const month = c.valid_from.slice(0, 7);
        const stamps = [...f.page_body.matchAll(/\[(\d{4}-\d{2}-\d{2}) \d{2}:\d{2}:\d{2}\]/g)].map(
          (m) => m[1].slice(0, 7),
        );
        expect(stamps).toContain(month);
      }
    }
  });

  it("3. page_body contém ≥1 timestamp [YYYY-MM-DD HH:MM:SS]", () => {
    for (const f of fixtures) {
      expect(/\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]/.test(f.page_body)).toBe(true);
    }
  });

  it("4. notes contém 'S0 §' e um slug de proveniência (parte-N | chat)", () => {
    for (const f of fixtures) {
      expect(f.notes).toContain("S0 §");
      expect(/parte-\d+|chat/.test(f.notes)).toBe(true);
    }
  });

  it("5. scrub: nenhum telefone, e-mail ou CNPJ no page_body", () => {
    for (const f of fixtures) {
      expect(/\b\d{2,3}[\s.-]?\d{4,5}-?\d{4}\b/.test(f.page_body)).toBe(false); // telefone
      expect(/\S+@\S+\.\S+/.test(f.page_body)).toBe(false); // e-mail
      expect(/\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/.test(f.page_body)).toBe(false); // CNPJ
    }
  });

  it("6. contagem: ≥4 fixtures com expected por classe; ≥1 fixture com expected=[]", () => {
    const byClass: Record<string, number> = { relacao: 0, decisao: 0, compromisso: 0 };
    let negativas = 0;
    for (const f of fixtures) {
      if (f.expected_claims.length === 0) {
        negativas++;
        continue;
      }
      const pred = f.expected_claims[0].predicate;
      byClass[pred] = (byClass[pred] ?? 0) + 1;
    }
    expect(byClass.relacao).toBeGreaterThanOrEqual(4);
    expect(byClass.decisao).toBeGreaterThanOrEqual(4);
    expect(byClass.compromisso).toBeGreaterThanOrEqual(4);
    expect(negativas).toBeGreaterThanOrEqual(1);
  });

  it("7. cópia em schema-packs/ é byte-idêntica", () => {
    expect(readFileSync(packFxPath, "utf8")).toBe(raw);
  });
});
