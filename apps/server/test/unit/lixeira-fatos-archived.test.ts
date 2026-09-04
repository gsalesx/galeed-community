/** Vazamento de fatos da lixeira (achado da revisão): arquivar uma página some com ela da busca/
 *  grafo, MAS as leituras de VERDADE ATUAL precisam parar de servir os fatos dela também — senão o
 *  "esquecido" continua falando em /v1/facts, na tela Fatos, na timeline e no Dossiê.
 *
 *  Invariante de FONTE (padrão postgres-boundary/lixeira-edges-semanticas — sem banco):
 *   (a) as TRÊS leituras de verdade — facts(), timeline(), currentFacts() — filtram por página-fonte
 *       arquivada via o helper notArchivedSource();
 *   (b) o write-path factsInGroups() NÃO filtra (a supersessão bitemporal M14 precisa enxergar todos
 *       os fatos do grupo, arquivados inclusive) — regressão se alguém "consertar" isso por engano;
 *   (c) o filtro usa `not exists ... galeed_pages ap ... archived` e correlaciona
 *       galeed_facts.source_slug (fato órfão passa; alias evita ambiguidade de coluna).
 *  A prova de COMPORTAMENTO (arquiva→some→restaura→volta) é o teste de integração DB-gated
 *  test/integration/lixeira-fatos-archived.test.ts. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";

const SRC = readFileSync(resolve(new URL("../..", import.meta.url).pathname, "src/core/engines/postgres.ts"), "utf8");

/** Recorta o corpo de um método async do engine (do `async nome(` até o próximo `async ` no mesmo nível). */
function methodBody(name: string): string {
  const start = SRC.indexOf(`async ${name}(`);
  expect(start, `método ${name} existe`).toBeGreaterThan(-1);
  const rest = SRC.slice(start + 6);
  const next = rest.indexOf("\n  async ");
  return next === -1 ? rest : rest.slice(0, next);
}

describe("lixeira — leitura de fatos respeita página arquivada", () => {
  it("existe um helper único de filtro correlacionando galeed_facts.source_slug", () => {
    expect(SRC).toContain("private notArchivedSource(");
    // correlato ao outer, alias dedicado, coalesce do flag — a semântica do fragmento
    expect(SRC).toMatch(/not exists\s*\(\s*select 1 from galeed_pages ap/);
    expect(SRC).toContain("ap.slug = galeed_facts.source_slug");
    expect(SRC).toContain("coalesce(ap.archived, false) = true");
  });

  it.each(["facts", "timeline", "currentFacts"])("%s() aplica notArchivedSource()", (m) => {
    expect(methodBody(m)).toContain("notArchivedSource");
  });

  it("factsInGroups() NÃO filtra archived (write-path da supersessão M14)", () => {
    expect(methodBody("factsInGroups")).not.toContain("notArchivedSource");
  });
});
