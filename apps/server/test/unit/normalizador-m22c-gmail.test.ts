/** UNIT M22-C — normalizeGmailMessage + htmlParaTexto (PURO: sem DB/LLM/rede/clock).
 *  Fixtures derivadas do contrato oficial (test/unit/fixtures/gmail/*.json, fonte no _fonte).
 *  Prova: cabeçalho PT exato, data DO E-MAIL (não new Date()), externalRef por mensagem (não thread),
 *  html-only não quebra, DFS+anexo ignorado, fallbacks de corpo/data, determinismo, htmlParaTexto. */
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  normalizeGmailMessage,
  htmlParaTexto,
  gmailConnector,
  type GmailMessageRecord,
} from "../../src/core/ingestion/connectors/gmail.ts";

function fix(name: string): GmailMessageRecord {
  const p = fileURLToPath(new URL(`./fixtures/gmail/${name}.json`, import.meta.url));
  return JSON.parse(readFileSync(p, "utf8")) as GmailMessageRecord;
}

const ANCHOR = "A proposta do tier 2 fica em R$ 30 mil por ano.";

afterEach(() => {
  vi.useRealTimers();
});

describe("M22-C normalizeGmailMessage — multipart (prefere text/plain)", () => {
  it("1. cabeçalho PT EXATO + prefere text/plain; Data = data do e-mail", () => {
    const doc = normalizeGmailMessage(fix("message-multipart"))!;
    expect(doc).not.toBeNull();
    const expectedHeader = [
      "De: Maria Silva <maria@exemplo.com.br>",
      "Para: kelvin@kcggroup.com.br",
      "Cc: financeiro@exemplo.com.br",
      "Assunto: Proposta comercial — tier 2",
      "Data: 2025-05-14",
      "Ref: gmail:msg-m22c-gmail-001",
    ].join("\n");
    expect(doc.content.startsWith(expectedHeader + "\n\n")).toBe(true);
    // corpo = text/plain (não html); contém a frase ancorável; NÃO contém markup html.
    expect(doc.content).toContain(ANCHOR);
    expect(doc.content).not.toContain("<p>");
    expect(doc.contentType).toBe("text/plain");
  });

  it("2. timestamp vem do internalDate, NÃO de new Date() (relógio congelado em dia ≠ fixture)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2099-12-31T23:59:59.000Z"));
    const doc = normalizeGmailMessage(fix("message-multipart"))!;
    expect(doc.timestamp).toBe("2025-05-14T12:00:00.000Z");
  });

  it("3. externalRef por MENSAGEM, title; mesma thread, ids ≠ → externalRef ≠", () => {
    const doc = normalizeGmailMessage(fix("message-multipart"))!;
    expect(doc.externalRef).toBe("gmail:msg-m22c-gmail-001");
    expect(doc.title).toBe("Proposta comercial — tier 2");
    // mesma thread (thread-m22c-gmail-A), id diferente → externalRef DIFERENTE (delta por mensagem).
    const outro = fix("message-nested-mixed"); // mesmo threadId, id 003
    expect(outro.threadId).toBe(doc ? fix("message-multipart").threadId : "");
    const docOutro = normalizeGmailMessage(outro)!;
    expect(docOutro.externalRef).toBe("gmail:msg-m22c-gmail-003");
    expect(docOutro.externalRef).not.toBe(doc.externalRef);
  });
});

describe("M22-C normalizeGmailMessage — html-only e nested", () => {
  it("4. html-only não lança; contém a frase ancorável; sem <p / <style / &nbsp;", () => {
    const doc = normalizeGmailMessage(fix("message-html-only"))!;
    expect(doc).not.toBeNull();
    expect(doc.content).toContain(ANCHOR);
    expect(doc.content).not.toContain("<p");
    expect(doc.content).not.toContain("<style");
    expect(doc.content).not.toContain("&nbsp;");
    // &amp; foi decodificado pra &
    expect(doc.content).toContain("Kelvin & equipe");
  });

  it("5. nested-mixed → corpo = text/plain interno; nada do anexo (proposta.pdf)", () => {
    const doc = normalizeGmailMessage(fix("message-nested-mixed"))!;
    expect(doc.content).toContain("Conforme alinhado");
    expect(doc.content).toContain("a proposta do tier 2 fica em R$ 30 mil por ano");
    expect(doc.content).not.toContain("proposta.pdf");
    expect(doc.content).not.toContain("ANGjdJ"); // attachmentId não vaza
  });
});

describe("M22-C normalizeGmailMessage — fallbacks e bordas", () => {
  it("6. sem payload+snippet → corpo=snippet; sem payload e sem snippet → null; Date header fallback; sem data → null", () => {
    // sem payload, com snippet → corpo = snippet
    const semPayload: GmailMessageRecord = {
      id: "x1",
      threadId: "t1",
      internalDate: "1747224000000",
      snippet: "resumo curto do e-mail",
    };
    const d1 = normalizeGmailMessage(semPayload)!;
    expect(d1.content).toContain("resumo curto do e-mail");

    // sem payload e sem snippet → null
    const d2 = normalizeGmailMessage({ id: "x2", threadId: "t2", internalDate: "1747224000000" });
    expect(d2).toBeNull();

    // sem internalDate mas com header Date válido → timestamp do header
    const d3 = normalizeGmailMessage({
      id: "x3",
      threadId: "t3",
      snippet: "tem corpo",
      payload: { headers: [{ name: "Date", value: "Wed, 14 May 2025 09:00:00 -0300" }] },
    })!;
    expect(d3.timestamp).toBe("2025-05-14T12:00:00.000Z");

    // sem data nenhuma → null (mesmo com corpo)
    const d4 = normalizeGmailMessage({ id: "x4", threadId: "t4", snippet: "corpo mas sem data" });
    expect(d4).toBeNull();
  });

  it("7. determinismo: 2× deep-equal", () => {
    const a = normalizeGmailMessage(fix("message-multipart"));
    const b = normalizeGmailMessage(fix("message-multipart"));
    expect(a).toEqual(b);
  });
});

describe("M22-C htmlParaTexto — conversão mínima", () => {
  it("8. entidades numéricas (&#231;/&#x1F600;), colapso de \\n, remoção de <script>", () => {
    const html =
      "<script>alert('x')</script><p>a&#231;&#x1F600;</p>\n\n\n\n<div>b</div>";
    const txt = htmlParaTexto(html);
    expect(txt).not.toContain("alert");
    expect(txt).toContain("aç😀");
    expect(txt).not.toMatch(/\n{3,}/); // 3+ \n colapsados
  });

  it("9. tags removidas, &amp;/&nbsp; decodificados, trim", () => {
    expect(htmlParaTexto("<b>x</b>&amp;<i>y</i>")).toBe("x&y");
    expect(htmlParaTexto("  <p>z&nbsp;w</p>  ")).toBe("z w");
  });
});

describe("M22-C gmailConnector — handler estrutural", () => {
  it("10. normalize(record, ctx) → [{...doc, sourceId}]; null → []", () => {
    expect(gmailConnector.providerConfigKey).toBe("google-mail");
    expect(gmailConnector.model).toBe("Message");
    const out = gmailConnector.normalize(fix("message-multipart"), { sourceId: "fonte-xyz" });
    expect(out).toHaveLength(1);
    expect(out[0].sourceId).toBe("fonte-xyz");
    expect(out[0].externalRef).toBe("gmail:msg-m22c-gmail-001");
    expect(out[0].contentType).toBe("text/plain");
    // record sem data → [] (nunca descarte mudo: lista vazia, o caller loga)
    const vazio = gmailConnector.normalize({ id: "z", threadId: "tz", snippet: "sem data" }, { sourceId: "s" });
    expect(vazio).toEqual([]);
  });
});
