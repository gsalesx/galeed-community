/** Distinção manual vs WhatsApp/conector — sem DB.
 *  kind=text = Adicionar/colar; kind=file só com blob source=upload ou nome da dropzone. */
import { describe, it, expect } from "vitest";
import { isManualIngestJob } from "../../src/connectors/bff/bff-ingest-delete.ts";

describe("isManualIngestJob", () => {
  it("texto colado é manual (WhatsApp não cria kind=text)", () => {
    expect(isManualIngestJob({ kind: "text", filename: null }, null)).toBe(true);
  });

  it("arquivo com blob source=upload é manual", () => {
    expect(isManualIngestJob({ kind: "file", filename: "contrato.pdf" }, "upload")).toBe(true);
  });

  it("arquivo de conector/WhatsApp NÃO é manual", () => {
    expect(isManualIngestJob({ kind: "file", filename: "wa:BAE594" }, "connector")).toBe(false);
    expect(isManualIngestJob({ kind: "file", filename: "nota.md" }, "connector")).toBe(false);
    expect(isManualIngestJob({ kind: "file", filename: "doc.pdf" }, "github")).toBe(false);
  });

  it("sem blob ainda: só nome da dropzone (pdf/md/txt/csv)", () => {
    expect(isManualIngestJob({ kind: "file", filename: "aula.pdf" }, null)).toBe(true);
    expect(isManualIngestJob({ kind: "file", filename: "notas.csv" }, null)).toBe(true);
    expect(isManualIngestJob({ kind: "file", filename: "wa:BAE594" }, null)).toBe(false);
    expect(isManualIngestJob({ kind: "file", filename: "mensagem" }, null)).toBe(false);
  });
});
