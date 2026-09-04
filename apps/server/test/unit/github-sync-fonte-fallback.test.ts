/** UNIT — pastaDe/renderPagina com páginas do WEBHOOK UNIVERSAL (/ingest → capture), que só
 *  carregam `fonte:<source>` (nunca `canal:`): antes do fallback, transcrição de notetaker e
 *  conversa de WhatsApp caíam AMBAS em anotacoes/. O contrato com `canal:` presente fica intacto
 *  (casos espelhados do github-sync.test.ts). PURO (sem DB). */
import { describe, it, expect } from "vitest";
import { pastaDe, renderPagina } from "../../src/core/platform/github-sync.ts";
import type { PageRow } from "../../src/core/platform/engine.ts";

const pagina = (over: Partial<PageRow> = {}): PageRow => ({
  slug: "s1", type: "notas", title: "T", date: "2026-07-01",
  path: "", body: "corpo", tags: [], sensitivity: "restrito", ...over,
});

describe("pastaDe — fallback fonte:/type quando NÃO há canal:", () => {
  it("fonte:whatsapp (webhook universal) → conversas (mesmo set CONVERSAS do canal:)", () => {
    expect(pastaDe(pagina({ tags: ["fonte:whatsapp"] }))).toBe("conversas");
    expect(pastaDe(pagina({ tags: ["fonte:telegram"] }))).toBe("conversas");
    expect(pastaDe(pagina({ tags: ["fonte:gmail"] }))).toBe("conversas");
  });

  it("type reunioes sem canal: (notetaker via /ingest — classify materializa o tipo) → reunioes", () => {
    expect(pastaDe(pagina({ type: "reunioes", tags: ["fonte:notetaker"] }))).toBe("reunioes");
  });

  it("doc: ganha do fallback (upload continua em documentos/)", () => {
    expect(pastaDe(pagina({ tags: ["doc:abc", "fonte:upload"] }))).toBe("documentos");
  });

  it("fonte fora do set (paste/upload sem doc:) segue em anotacoes", () => {
    expect(pastaDe(pagina({ tags: ["fonte:paste"] }))).toBe("anotacoes");
    expect(pastaDe(pagina({ tags: ["fonte:upload"] }))).toBe("anotacoes");
  });

  it("contrato com canal: presente INTACTO — canal desconhecido NÃO cai no fallback", () => {
    expect(pastaDe(pagina({ tags: ["canal:whatsapp"] }))).toBe("conversas");
    // canal:formulario (desconhecido) + type reunioes: canal presente manda → anotacoes, como antes
    expect(pastaDe(pagina({ type: "reunioes", tags: ["canal:formulario", "fonte:notetaker"] }))).toBe("anotacoes");
  });
});

describe("renderPagina — origem: cai pra fonte: quando não há canal:", () => {
  it("sem canal: → origem: <fonte>; com canal: o canal GANHA; sem nenhum → sem linha origem:", () => {
    const semCanal = renderPagina(pagina({ tags: ["fonte:whatsapp"] }), "x.md");
    expect(semCanal.content).toContain("origem: whatsapp");

    const comCanal = renderPagina(pagina({ tags: ["canal:gmail", "fonte:upload"] }), "x.md");
    expect(comCanal.content).toContain("origem: gmail");
    expect(comCanal.content).not.toContain("origem: upload");

    const semNada = renderPagina(pagina(), "x.md");
    expect(semNada.content).not.toContain("origem:");
  });
});
