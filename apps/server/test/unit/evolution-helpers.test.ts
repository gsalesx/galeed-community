import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  evolutionInstanceName,
  nextEvolutionInstanceName,
  extractQrBase64,
  extractPairingCode,
  normalizeWhatsAppNumber,
  isZombieEvolutionState,
} from "../../src/core/platform/evolution.ts";

const here = dirname(fileURLToPath(import.meta.url));
const ui = readFileSync(join(here, "../../../web/src/screens/Conectar/index.tsx"), "utf8");

describe("evolutionInstanceName", () => {
  it("slugifica o brain", () => {
    expect(evolutionInstanceName("Minha Empresa!")).toBe("galeed-Minha-Empresa");
    expect(evolutionInstanceName("")).toBe("galeed-brain");
    expect(evolutionInstanceName("Meu cérebro", 2)).toBe("galeed-Meu-c-rebro-2");
  });
});

describe("nextEvolutionInstanceName", () => {
  it("pula nomes já usados", () => {
    const base = evolutionInstanceName("loja");
    expect(nextEvolutionInstanceName("loja", [])).toBe(base);
    expect(nextEvolutionInstanceName("loja", [base])).toBe(`${base}-2`);
    expect(nextEvolutionInstanceName("loja", [base, `${base}-2`])).toBe(`${base}-3`);
  });
});

describe("normalizeWhatsAppNumber / pairing / zombie", () => {
  it("aceita E.164 com pontuação e rejeita curto", () => {
    expect(normalizeWhatsAppNumber("+55 (11) 99999-8888")).toBe("5511999998888");
    expect(() => normalizeWhatsAppNumber("9999")).toThrow(/DDI/);
  });
  it("extrai pairingCode de 8 chars", () => {
    expect(extractPairingCode({ pairingCode: "WZYEH1YY" })).toBe("WZYEH1YY");
    expect(extractPairingCode({ qrcode: { pairingCode: "ab12cd34" } })).toBe("AB12CD34");
    expect(extractPairingCode({ pairingCode: "curto" })).toBeNull();
  });
  it("reconhece estado zumbi sem marcar open", () => {
    expect(isZombieEvolutionState("close")).toBe(true);
    expect(isZombieEvolutionState("NOT CONNECTION")).toBe(true);
    expect(isZombieEvolutionState("open")).toBe(false);
    expect(isZombieEvolutionState("connecting")).toBe(false);
  });
});

describe("extractQrBase64", () => {
  it("aceita qrcode.base64 data-URL", () => {
    const data = { qrcode: { base64: "data:image/png;base64," + "A".repeat(80) } };
    expect(extractQrBase64(data)).toMatch(/^data:image\/png;base64,/);
  });

  it("empacota base64 cru longo", () => {
    const raw = "iVBORw0KGgo" + "A".repeat(220);
    expect(extractQrBase64({ base64: raw })).toBe(`data:image/png;base64,${raw}`);
  });

  it("ignora code curto do WA Web", () => {
    expect(extractQrBase64({ qrcode: { code: "2@abc" } })).toBeNull();
  });
});

describe("painel Conectar WhatsApp", () => {
  it("lista contas, QR ou número e pairing code", () => {
    expect(ui).toContain("Adicionar WhatsApp");
    expect(ui).toContain("Conectar com número de telefone");
    expect(ui).toContain("pairingCode");
  });
});
