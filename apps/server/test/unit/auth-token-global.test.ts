/** GATEWAY /v1 (auth global) — authenticateTokenGlobal deriva o TENANT do próprio token
 *  (sem ?brain do cliente), e issueToken usa o prefixo gateado por env. Engine MOCADO (sem
 *  Postgres). Prova: (1) token válido → { brain, principal, scope } a partir do hash; (2) hash
 *  inexistente → null; (3) token revogado → null (tokenByHashGlobal já filtra revoked); (4)
 *  principal inativo → null (fail-closed); (5) issueToken usa GALEED_TOKEN_PREFIX/default. */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";

const { getEngine, brainHome } = vi.hoisted(() => ({
  getEngine: vi.fn(),
  brainHome: vi.fn(() => "galeed"),
}));

vi.mock("../../src/core/platform/engine.ts", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, getEngine };
});
vi.mock("../../src/core/platform/brain.ts", () => ({ brainHome }));

import { authenticateTokenGlobal, issueToken, hashToken } from "../../src/core/access/principals.ts";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** Fábrica de engine em memória, parametrizada por brain/principal/grant/token. O bootstrap
 *  (galeed) responde tokenByHashGlobal; o engine do brain do token responde principal/grant. */
function makeWorld(opts: {
  tokenHash: string;
  brain: string;
  principalId: string;
  principalStatus?: string;
  grantAreas?: string[];
  revoked?: boolean;
}) {
  const touched: string[] = [];
  const tokenRow =
    opts.revoked ? null : { brain: opts.brain, principal_id: opts.principalId };

  const bootEngine = {
    tokenByHashGlobal: vi.fn(async (h: string) => (h === opts.tokenHash ? tokenRow : null)),
    getPrincipal: vi.fn(async () => undefined),
    getGrant: vi.fn(async () => undefined),
    touchToken: vi.fn(async (h: string) => { touched.push(h); }),
  };
  const brainEngine = {
    tokenByHashGlobal: vi.fn(async () => null),
    getPrincipal: vi.fn(async (id: string) =>
      id === opts.principalId
        ? { id, kind: "agent", label: "bot", email: "", status: opts.principalStatus ?? "active" }
        : undefined,
    ),
    getGrant: vi.fn(async (id: string) =>
      id === opts.principalId
        ? { principal_id: id, areas: opts.grantAreas ?? ["produto"], sensitivity_max: "interno", deny_types: [], scope: "read" }
        : undefined,
    ),
    touchToken: vi.fn(async (h: string) => { touched.push(h); }),
  };

  getEngine.mockImplementation(async (brain: string) =>
    (brain === "galeed" ? bootEngine : brainEngine) as any,
  );
  return { bootEngine, brainEngine, touched };
}

beforeEach(() => {
  vi.clearAllMocks();
  brainHome.mockReturnValue("galeed");
});

describe("authenticateTokenGlobal — tenant derivado do token", () => {
  it("token válido → resolve { brain, principal, scope } a partir do hash e toca last_used_at", async () => {
    const raw = "gld_live_deadbeef";
    const world = makeWorld({ tokenHash: sha(raw), brain: "accelera", principalId: "agent-bot", grantAreas: ["produto", "vendas"] });

    const out = await authenticateTokenGlobal(raw);

    expect(out).not.toBeNull();
    expect(out!.brain).toBe("accelera");
    expect(out!.principal.id).toBe("agent-bot");
    expect(out!.principal.status).toBe("active");
    expect(out!.scope.principalId).toBe("agent-bot");
    expect(out!.scope.areas).toEqual(["produto", "vendas"]);
    expect(out!.scope.sensitivityMax).toBe("interno");
    // a busca global rodou no engine de bootstrap (brainHome), com o hash do token cru
    expect(world.bootEngine.tokenByHashGlobal).toHaveBeenCalledWith(sha(raw));
    // last_used_at tocado no engine do brain do token, pelo hash
    expect(world.brainEngine.touchToken).toHaveBeenCalledWith(sha(raw));
  });

  it("brain NUNCA vem do cliente — vem do tokenByHashGlobal", async () => {
    const raw = "gld_live_cafe";
    makeWorld({ tokenHash: sha(raw), brain: "tenant-x", principalId: "agent-bot" });
    const out = await authenticateTokenGlobal(raw);
    expect(out!.brain).toBe("tenant-x"); // o brain saiu da linha do token, não de input externo
  });

  it("hash inexistente → null", async () => {
    makeWorld({ tokenHash: sha("outro"), brain: "accelera", principalId: "agent-bot" });
    expect(await authenticateTokenGlobal("gld_live_naoexiste")).toBeNull();
  });

  it("token revogado → null (tokenByHashGlobal filtra revoked=false)", async () => {
    const raw = "gld_live_revoked";
    makeWorld({ tokenHash: sha(raw), brain: "accelera", principalId: "agent-bot", revoked: true });
    expect(await authenticateTokenGlobal(raw)).toBeNull();
  });

  it("principal inativo → null (fail-closed)", async () => {
    const raw = "gld_live_disabled";
    const world = makeWorld({ tokenHash: sha(raw), brain: "accelera", principalId: "agent-bot", principalStatus: "disabled" });
    expect(await authenticateTokenGlobal(raw)).toBeNull();
    expect(world.brainEngine.touchToken).not.toHaveBeenCalled(); // não toca token de principal barrado
  });

  it("token vazio → null sem tocar o engine", async () => {
    const world = makeWorld({ tokenHash: sha("x"), brain: "accelera", principalId: "agent-bot" });
    expect(await authenticateTokenGlobal("")).toBeNull();
    expect(world.bootEngine.tokenByHashGlobal).not.toHaveBeenCalled();
  });

  it("erro de INFRA do engine → RE-LANÇA (vira 500 honesto no gateway, não 401 fingindo token inválido)", async () => {
    // Fail-closed continua (erro nunca vira acesso), mas erro de infra NÃO pode mascarar como 401:
    // o gateway converte a exceção em 500 genérico. Token de fato inválido segue retornando null (401).
    getEngine.mockImplementation(async () => { throw new Error("db down"); });
    await expect(authenticateTokenGlobal("gld_live_qualquer")).rejects.toThrow("db down");
  });
});

describe("issueToken — prefixo gateado por env", () => {
  const prev = process.env.GALEED_TOKEN_PREFIX;
  afterEach(() => {
    if (prev === undefined) delete process.env.GALEED_TOKEN_PREFIX;
    else process.env.GALEED_TOKEN_PREFIX = prev;
  });

  function engineCapturingUpsert() {
    const upserted: any[] = [];
    getEngine.mockImplementation(async () => ({
      upsertToken: vi.fn(async (r: any) => { upserted.push(r); }),
    }) as any);
    return upserted;
  }

  it("default → gld_live_ quando GALEED_TOKEN_PREFIX não está setado", async () => {
    delete process.env.GALEED_TOKEN_PREFIX;
    const upserted = engineCapturingUpsert();
    const { token, tokenHash } = await issueToken("accelera", { principalId: "agent-bot" });
    expect(token.startsWith("gld_live_")).toBe(true);
    expect(tokenHash).toBe(hashToken(token)); // hash é do token INTEIRO (prefixo incluso)
    expect(upserted[0].token_hash).toBe(tokenHash);
  });

  it("respeita GALEED_TOKEN_PREFIX quando setado", async () => {
    process.env.GALEED_TOKEN_PREFIX = "gld_test_";
    engineCapturingUpsert();
    const { token } = await issueToken("accelera", { principalId: "agent-bot" });
    expect(token.startsWith("gld_test_")).toBe(true);
  });
});
