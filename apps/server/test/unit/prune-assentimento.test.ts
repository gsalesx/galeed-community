/** Achado criacao-de-fatos #2 — pruneSegmentMessages podava "Combinado"/"sim"/"não"/"perfeito"
 *  como saudação (GREETING_RE), decapitando o fechamento do negócio: a unit ficava só com a
 *  pergunta ("fechamos em R$ 25 mil/mês então?") e o LLM extraía pergunta em aberto no lugar de
 *  acordo selado — recusa ("não") sumia igual, invertendo o sentido.
 *  Fix: resgate CONTEXTUAL (ASSENT_RE + prevKept) — assentimento/negação logo após mensagem MANTIDA
 *  sobrevive; isolado entre ruído continua caindo (o corte agregado do gate M15/S4 não muda — o
 *  porteiro de UNITS do S1 fica intacto). Puro, sem DB/LLM. */
import { describe, it, expect } from "vitest";
import { buildExtractionUnits } from "../../src/core/ingestion/segment.ts";
import type { PageRow } from "../../src/core/platform/engine.ts";

const page = (body: string): PageRow => ({
  slug: "p", type: "reunioes", title: "chat", date: "2026-06-01", path: "", body, content_hash: "p",
});

const bodyOf = (p: PageRow) => buildExtractionUnits(p).map((u) => u.body).join("\n");

describe("pruneSegmentMessages — assentimento/negação com contexto sobrevive na unit", () => {
  it("'Combinado' respondendo à pergunta com número viaja pro LLM (acordo selado, não pergunta aberta)", () => {
    const body = [
      "[2026-06-01 10:00] Kelvin Cleto: fechamos em R$ 25 mil/mês então?",
      "[2026-06-01 10:01] Bruno Silva: Combinado",
    ].join("\n");
    const all = bodyOf(page(body));
    expect(all).toContain("R$ 25 mil");
    expect(all).toContain("Combinado"); // antes: podado por GREETING_RE — a unit só tinha a pergunta
  });

  it("a RECUSA ('não') também sobrevive — podá-la invertia o sentido do trecho", () => {
    const body = [
      "[2026-06-01 10:00] Kelvin Cleto: fechamos em R$ 25 mil/mês então?",
      "[2026-06-01 10:01] Bruno Silva: não",
    ].join("\n");
    const all = bodyOf(page(body));
    expect(all).toContain("não");
  });

  it("'combinado' ISOLADO entre ruído continua podado (protege o corte do gate M15/S4)", () => {
    const body = [
      "[2026-06-01 10:00] Kelvin Cleto: a proposta do plano fechou em R$ 25 mil como discutido",
      "[2026-06-01 10:01] Bruno Silva: kkkk",
      "[2026-06-01 10:02] Carla Souza: combinado",
    ].join("\n");
    const all = bodyOf(page(body));
    expect(all).toContain("R$ 25 mil");
    expect(all).not.toContain("kkkk");
    expect(all).not.toContain("combinado"); // sem mensagem MANTIDA imediatamente antes → é ruído
  });

  it("segmento todo-social (saudação + assentimento sem contexto) segue virando 0 units", () => {
    const body = [
      "[2026-06-01 10:00] Kelvin Cleto: bom dia",
      "[2026-06-01 10:01] Bruno Silva: combinado",
    ].join("\n");
    expect(buildExtractionUnits(page(body))).toEqual([]);
  });
});
