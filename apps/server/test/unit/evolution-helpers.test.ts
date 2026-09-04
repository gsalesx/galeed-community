import { describe, it, expect } from "vitest";
import { evolutionInstanceName, extractQrBase64 } from "../../src/core/platform/evolution.ts";

describe("evolutionInstanceName", () => {
  it("slugifica o brain", () => {
    expect(evolutionInstanceName("Minha Empresa!")).toBe("galeed-Minha-Empresa");
    expect(evolutionInstanceName("")).toBe("galeed-brain");
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
