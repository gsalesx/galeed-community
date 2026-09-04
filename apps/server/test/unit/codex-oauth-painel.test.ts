/** Contrato do BFF Codex OAuth: a UI nunca recebe tokens nem device_auth_id. */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const bff = readFileSync(join(here, "../../src/connectors/bff/bff-codex-oauth.ts"), "utf8");
const ui = readFileSync(join(here, "../../../web/src/screens/Conectar/index.tsx"), "utf8");
const compose = readFileSync(join(here, "../../../../docker-compose.dokploy.yml"), "utf8");
const codex = readFileSync(join(here, "../../src/lib/chatgpt-codex.ts"), "utf8");

describe("codex oauth no painel", () => {
  it("start/poll não devolvem device_auth_id nem tokens", () => {
    expect(bff).toMatch(/return \{ verificationUrl, userCode, interval \}/);
    expect(bff).not.toMatch(/return \{[^}]*deviceAuthId/);
    expect(bff).not.toMatch(/return \{[^}]*access_token/);
    expect(bff).not.toMatch(/console\.(log|info|debug|warn)\([^)]*token/i);
  });

  it("Conectar tem Conectar ChatGPT e Desconectar", () => {
    expect(ui).toContain("Conectar ChatGPT");
    expect(ui).toContain("Desconectar");
    expect(ui).toContain("window.open");
  });

  it("compose Dokploy não monta auth.json do host", () => {
    expect(compose).not.toMatch(/codex-auth\.json|:\/root\/\.codex\/auth\.json/);
  });

  it("chatgpt-codex lê banco antes do arquivo", () => {
    expect(codex).toContain("loadDbSource()) || readAuthFile()");
    expect(codex).toContain("Precedência: tokens no Postgres");
  });
});
