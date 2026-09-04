/** M22-A — o registro de conectores é DADO (invariante III): o seam não conhece formato; cada handler
 *  vive num Map providerConfigKey → handler. register/get/clear, último ganha no re-registro. */
import { afterEach, describe, expect, it } from "vitest";
import {
  clearConnectorHandlers,
  getConnectorHandler,
  registerConnectorHandler,
  type ConnectorHandler,
  type ConnectorPayload,
} from "../../src/core/ingestion/connector-ingest.ts";

function fakeHandler(pck: string, channel = "fake"): ConnectorHandler {
  return {
    providerConfigKey: pck,
    sourceSeed: () => ({
      name: `Fonte ${pck}`,
      channel,
      type: "registro",
      recipe: { fields: [{ dimension: "vendas", label: "venda", area: "comercial" }] },
    }),
    normalize: (record, ctx): ConnectorPayload[] => [
      {
        sourceId: ctx.sourceId,
        content: String((record as any).text ?? ""),
        contentType: "text/plain",
        timestamp: "2026-06-12T00:00:00.000Z",
        externalRef: String((record as any).id ?? ""),
      },
    ],
  };
}

describe("registro de conectores (Map providerConfigKey → handler)", () => {
  afterEach(() => clearConnectorHandlers());

  it("get devolve undefined antes de registrar", () => {
    clearConnectorHandlers();
    expect(getConnectorHandler("conta-azul")).toBeUndefined();
  });

  it("register/get por providerConfigKey", () => {
    const h = fakeHandler("conta-azul");
    registerConnectorHandler(h);
    expect(getConnectorHandler("conta-azul")).toBe(h);
    expect(getConnectorHandler("google-mail")).toBeUndefined();
  });

  it("re-registro: ÚLTIMO ganha", () => {
    registerConnectorHandler(fakeHandler("conta-azul", "v1"));
    const h2 = fakeHandler("conta-azul", "v2");
    registerConnectorHandler(h2);
    expect(getConnectorHandler("conta-azul")).toBe(h2);
    expect(getConnectorHandler("conta-azul")?.sourceSeed().channel).toBe("v2");
  });

  it("clear esvazia o registro", () => {
    registerConnectorHandler(fakeHandler("conta-azul"));
    registerConnectorHandler(fakeHandler("google-mail"));
    clearConnectorHandlers();
    expect(getConnectorHandler("conta-azul")).toBeUndefined();
    expect(getConnectorHandler("google-mail")).toBeUndefined();
  });

  it("sourceSeed é factory PURA (mesmo shape a cada chamada, sem IO)", () => {
    const h = fakeHandler("conta-azul");
    const a = h.sourceSeed();
    const b = h.sourceSeed();
    expect(a).toEqual(b);
    expect(a.recipe.fields[0].dimension).toBe("vendas");
  });
});
