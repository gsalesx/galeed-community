/** P0-A — parser dos formatos REAIS de WhatsApp (Android cru, iOS cru, bold-ISO do blob-store) +
 *  normalização DD/MM→ISO + falante estrutural. Determinístico, sem DB, sem LLM.
 *
 *  PROVENIÊNCIA das fixtures (invariante #9 — input REAL, fixtures = excerto SANITIZADO):
 *  - real-accelera-excerto.txt: 116 linhas CONTÍGUAS do corpo (sem frontmatter) do blob real
 *    `.galeed-blobs/Accelera/544c1b5bbf752db5` (_chat, 26KB, message_count: 191, 2026-04-17→05-08).
 *    Sanitização (estrutura byte-idêntica — timestamps/`**`/pontuação/quebras preservados):
 *    sobrenomes pseudonimizados de forma consistente (Cleto→Souza, Gabriel→Pereira); a senha em
 *    texto plano do blob ("Password: joao@2026") e o board-id privado do Miro → "********" e
 *    placeholder de tamanho aproximado; links vercel/LP privados → exemplo-cliente / exemplo.com.br.
 *    DESVIO declarado vs §4 (40-60 linhas): mantidas 116 linhas contíguas porque ≥3 dias DISTINTOS
 *    (5: 04-17/22/23/24/27) + 1 mensagem multilinha co-ocorrem só nesse span do blob real; cortar
 *    pra 60 linhas perderia a multilinha OU os dias. Fidelidade ao real contíguo > o teto de linhas.
 *  - android-ptbr.txt / ios-ptbr.txt: FORMATO é o contrato do CTO (Android "dd/mm/aaaa hh:mm - Nome:";
 *    iOS "[dd/mm/aa, hh:mm:ss] Nome:"); CONTEÚDO é re-render do MESMO excerto real (não inventado).
 *    Artefatos reais embutidos: iOS U+200E antes do "[", "‎<anexado: …>", "~ " de não-contato, 1
 *    linha AM/PM, ano de 2 dígitos; Android 1 msg de sistema sem "Nome:", 1 multilinha, 1 data com
 *    vírgula. (Pendência honesta §4: export FRESCO de cada plataforma é HTC do fundador.)
 *
 *  Asserts pelo comportamento MEDIDO (rodado 1× com tsx antes de cravar — LEARNINGS M17/S4). */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseConversationMessages } from "../../src/lib/conversation.ts";
import { buildExtractionUnits } from "../../src/core/ingestion/segment.ts";
import type { PageRow } from "../../src/core/platform/engine.ts";

const FX = fileURLToPath(new URL("./fixtures/whatsapp/", import.meta.url));
const read = (f: string) => readFileSync(FX + f, "utf8");
const LRM = "‎"; // U+200E

describe("P0-A — parser WhatsApp (bold-ISO real)", () => {
  it("bold-ISO real: parseia, sem scaffold no falante, ≥2 falantes, ≥3 dias distintos", () => {
    const m = parseConversationMessages(read("real-accelera-excerto.txt"));
    expect(m.length).toBeGreaterThan(0);
    // nenhum falante carrega "*" / "~" / U+200E (scaffold do export limpo no falante).
    for (const x of m) {
      expect(x.speaker).not.toMatch(/[*~]/);
      expect(x.speaker).not.toContain(LRM);
    }
    const speakers = new Set(m.filter((x) => x.speaker).map((x) => x.speaker));
    expect(speakers.size).toBeGreaterThanOrEqual(2);
    const days = new Set(m.filter((x) => x.timestamp).map((x) => x.timestamp.slice(0, 10)));
    expect(days.size).toBeGreaterThanOrEqual(3);
    // critério de recall do blob inteiro (191 msgs WhatsApp) está no gate §6.3; aqui é o excerto.
  });
});

describe("P0-A — parser WhatsApp (Android cru)", () => {
  it("Android: parseia DD/MM, sistema vira speaker='', multilinha anexa", () => {
    const m = parseConversationMessages(read("android-ptbr.txt"));
    expect(m.length).toBeGreaterThan(0);

    // DD/MM (não MM/DD): "17/04/2026 14:52" → 2026-04-17T14:52:00Z.
    const first = m[0];
    expect(first.timestamp).toBe("2026-04-17T14:52:00Z");
    // a 1ª linha é a msg de SISTEMA sem "Nome:" → speaker="" + texto preservado + timestamp válido.
    expect(first.speaker).toBe("");
    expect(first.text).toContain("criptografia");

    // 1 data com vírgula ("17/04/2026, 14:52") normaliza igual.
    const comma = m[1];
    expect(comma.timestamp).toBe("2026-04-17T14:52:00Z");
    expect(comma.speaker).toBe("Kelvin Souza");

    // multilinha: a linha de continuação (URL sem cabeçalho) anexa ao texto da última mensagem.
    const multi = m.find((x) => x.text.includes("\n"));
    expect(multi, "deve haver ≥1 mensagem multilinha").toBeTruthy();
    expect(multi!.text).toContain("\n");
  });
});

describe("P0-A — parser WhatsApp (iOS cru)", () => {
  it("iOS: U+200E não vaza, ano de 2 díg → 2026, AM/PM converte, ~Nome limpo", () => {
    const m = parseConversationMessages(read("ios-ptbr.txt"));
    expect(m.length).toBeGreaterThan(0);

    // nenhum U+200E vaza pro speaker.
    for (const x of m) expect(x.speaker).not.toContain(LRM);

    // "[17/04/26, …]" → ano 2024+? não: 2 díg "26" → 2026.
    const first = m[0];
    expect(first.timestamp.slice(0, 4)).toBe("2026");

    // linha AM/PM: "3:13:27 PM" → 15:13:27.
    const ampm = m.find((x) => x.timestamp.endsWith("T15:13:27Z"));
    expect(ampm, "a linha AM/PM deve converter pra 24h").toBeTruthy();

    // "~ Kelvin Souza" (não-contato) → "Kelvin Souza" (prefixo ~ removido).
    const tilde = m[2];
    expect(tilde.speaker).toBe("Kelvin Souza");
  });
});

describe("P0-A — inferência de ordem dia/mês", () => {
  it("corpo só-americano (2º comp >12) → ordem md", () => {
    const m = parseConversationMessages("03/15/2024, 2:30 PM - John: hi\n03/16/2024, 3:00 PM - Jane: yo");
    expect(m[0].timestamp).toBe("2024-03-15T14:30:00Z"); // md → mês=03, dia=15
  });

  it("corpo 100% ambíguo (todos ≤12) → DD/MM (default PT-BR)", () => {
    const m = parseConversationMessages("03/05/2024 10:00 - A: x\n04/05/2024 11:00 - B: y");
    expect(m[0].timestamp).toBe("2024-05-03T10:00:00Z"); // dm → dia=03, mês=05
  });
});

describe("P0-A — regressão aditiva (os 3 formatos antigos parseiam idêntico)", () => {
  it("[ISO] Nome: x / Nome (ISO): x / Nome: x (com fallbackDate) inalterados", () => {
    // 1. "[2024-03-01 14:30] Nome: texto"
    const a = parseConversationMessages("[2024-03-01 14:30] Joao Silva: oi");
    expect(a).toEqual([{ speaker: "Joao Silva", timestamp: "2024-03-01T14:30:00Z", text: "oi" }]);

    // 2. "Nome (2024-03-01): texto"
    const b = parseConversationMessages("Maria Souza (2024-03-01): ola");
    expect(b).toEqual([{ speaker: "Maria Souza", timestamp: "2024-03-01T00:00:00Z", text: "ola" }]);

    // 3. "Nome: texto" com fallbackDate.
    const c = parseConversationMessages("Pedro Lima: bom dia", { fallbackDate: "2024-03-01" });
    expect(c).toEqual([{ speaker: "Pedro Lima", timestamp: "2024-03-01T00:00:00Z", text: "bom dia" }]);
  });
});

describe("P0-A — buildExtractionUnits no excerto real (critério C1 em miniatura)", () => {
  it("units ≥2 e datas distintas ≥2; headers com 'Conversa … de <ISO> a <ISO>'", () => {
    const body = read("real-accelera-excerto.txt");
    const page = {
      brain: "__test_p0a_whatsapp",
      slug: "excerto-p0a-whatsapp",
      title: "excerto p0a-whatsapp",
      type: "reunioes",
      body,
      date: "2026-04-17",
      content_hash: "",
    } as unknown as PageRow;
    const units = buildExtractionUnits(page);
    expect(units.length).toBeGreaterThanOrEqual(2);
    const dates = new Set(units.map((u) => u.date));
    expect(dates.size).toBeGreaterThanOrEqual(2);
    // datas distintas vindas dos timestamps das mensagens (não a data da página).
    expect([...dates].some((d) => d !== "2026-04-17")).toBe(true);
    // header de âncora carrega o range ISO do segmento.
    expect(units.some((u) => /Conversa .*de \S+ a \S+/.test(u.header))).toBe(true);
  });
});
