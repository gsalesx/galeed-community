import { describe, it, expect } from "vitest";
import { buildV1OpenApi } from "../../src/connectors/v1-openapi.ts";

describe("v1 openapi", () => {
  it("documenta /v1/ask e usa o baseUrl dado", () => {
    const doc = buildV1OpenApi("https://exemplo.com") as any;
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.servers[0].url).toBe("https://exemplo.com");
    expect(doc.paths["/v1/ask"].post.operationId).toBe("ask");
    expect(doc.components.securitySchemes.bearerAuth.scheme).toBe("bearer");
  });
});
