/** Fixtures derivadas do CONTRATO OFICIAL do Nango (invariante #9 — sem conta ainda, o real é
 *  o contrato publicado): connect session token/connect_link/expires_at de
 *  https://nango.dev/docs/reference/api/connect/sessions/create (sessão expira em 30 min);
 *  Connect UI hospedada em https://connect.nango.dev (https://nango.dev/docs/reference/sdks/frontend).
 *  connector_state espelha o contrato do M22-A (specs/slots/M22/M22-D-DESIGN-SPEC.md §2.3). */
import { describe, it, expect } from "vitest";
import {
  PROVIDERS,
  anexarEstadoConector,
  estadoDaConexao,
  rotuloDoEstado,
  fonteDoProvider,
  descricaoDaSync,
  erroLegivel,
  ehConector,
} from "../../../web/src/screens/Fontes/connector.ts";
import type { ConnectorState, ConnectorStatusRow, Source } from "../../../web/src/screens/Fontes/types.ts";

// --- helpers de fixture (derivadas do contrato; nada inventado) ---
function fonte(over: Partial<Source> = {}): Source {
  return {
    id: "conta-azul",
    name: "Conta Azul",
    channel: "conta-azul",
    type: "vendas",
    recipe: { fields: [] },
    default_sensitivity: "restrito",
    status: "ativa",
    last_read_at: null,
    ...over,
  };
}
function conn(over: Partial<ConnectorState> = {}): ConnectorState {
  return {
    provider: "conta-azul",
    connection_id: "abc-123",
    status: "conectado",
    last_sync_at: null,
    last_error: null,
    ...over,
  };
}

describe("estadoDaConexao — tabela de verdade (precedência é contrato)", () => {
  it("1) fonte sem connector → null (upload/paste nunca ganham chip)", () => {
    expect(estadoDaConexao(fonte({ channel: "upload", connector: null }))).toBe(null);
    expect(estadoDaConexao(fonte({ channel: "paste", connector: undefined }))).toBe(null);
  });

  it("2) status pausada vence TUDO (mesmo connector conectado) → pausada", () => {
    const s = fonte({ status: "pausada", connector: conn({ status: "conectado" }) });
    expect(estadoDaConexao(s, true)).toBe("pausada");
  });

  it("3) aguardando + desconectado → aguardando; aguardando + conectado → conectada (banco vence a flag)", () => {
    expect(estadoDaConexao(fonte({ connector: conn({ status: "desconectado", connection_id: null }) }), true)).toBe(
      "aguardando",
    );
    expect(estadoDaConexao(fonte({ connector: conn({ status: "conectado" }) }), true)).toBe("conectada");
  });

  it("4) conectado→conectada · erro→erro · desconectado→desconectada (sem aguardando)", () => {
    expect(estadoDaConexao(fonte({ connector: conn({ status: "conectado" }) }))).toBe("conectada");
    expect(estadoDaConexao(fonte({ connector: conn({ status: "erro" }) }))).toBe("erro");
    expect(estadoDaConexao(fonte({ connector: conn({ status: "desconectado", connection_id: null }) }))).toBe(
      "desconectada",
    );
  });
});

describe("rotuloDoEstado — 5 literais EXATOS", () => {
  it("5) rótulos exatos do §4.3", () => {
    expect(rotuloDoEstado("conectada")).toBe("Conectada");
    expect(rotuloDoEstado("desconectada")).toBe("Desconectada");
    expect(rotuloDoEstado("pausada")).toBe("Pausada");
    expect(rotuloDoEstado("erro")).toBe("Erro na conexão");
    expect(rotuloDoEstado("aguardando")).toBe("Aguardando conexão…");
  });
});

describe("fonteDoProvider — match por connector.provider", () => {
  it("6) casa por provider e devolve undefined sem match", () => {
    const sources = [
      fonte({ id: "conta-azul", connector: conn({ provider: "conta-azul" }) }),
      fonte({ id: "gmail", channel: "gmail", connector: conn({ provider: "google-mail" }) }),
    ];
    expect(fonteDoProvider(sources, "conta-azul")?.id).toBe("conta-azul");
    expect(fonteDoProvider(sources, "google-mail")?.id).toBe("gmail");
    expect(fonteDoProvider(sources, "whatsapp")).toBeUndefined();
    // fonte sem connector nunca casa
    expect(fonteDoProvider([fonte({ connector: null })], "conta-azul")).toBeUndefined();
  });
});

describe("descricaoDaSync — formatador injetado (pura)", () => {
  const rel = () => "há 3 min";
  it("7) null/sem connector → nunca sincronizou; com ISO → última sincronização <rel>", () => {
    expect(descricaoDaSync(null, rel)).toBe("nunca sincronizou");
    expect(descricaoDaSync(undefined, rel)).toBe("nunca sincronizou");
    expect(descricaoDaSync(conn({ last_sync_at: null }), rel)).toBe("nunca sincronizou");
    expect(descricaoDaSync(conn({ last_sync_at: "2026-06-12T18:00:00.000Z" }), rel)).toBe(
      "última sincronização há 3 min",
    );
  });
});

describe("erroLegivel", () => {
  it("8) last_error → ele mesmo; status erro sem msg → fallback; conectado/sem connector → null", () => {
    expect(erroLegivel(conn({ status: "erro", last_error: "token expirou" }))).toBe("token expirou");
    expect(erroLegivel(conn({ status: "erro", last_error: null }))).toBe("a conexão falhou — reconecte.");
    expect(erroLegivel(conn({ status: "conectado", last_error: null }))).toBe(null);
    expect(erroLegivel(null)).toBe(null);
    expect(erroLegivel(undefined)).toBe(null);
  });
});

describe("PROVIDERS — catálogo sem botão de mentira", () => {
  it("9) contém EXATAMENTE conta-azul e google-mail (nada de WhatsApp)", () => {
    expect(PROVIDERS.map((p) => p.provider)).toEqual(["conta-azul", "google-mail"]);
    expect(PROVIDERS.find((p) => p.provider === "whatsapp")).toBeUndefined();
    expect(PROVIDERS.find((p) => p.provider === "conta-azul")?.nome).toBe("Conta Azul");
    expect(PROVIDERS.find((p) => p.provider === "google-mail")?.nome).toBe("E-mail");
  });
});

describe("anexarEstadoConector — MERGE client-side puro (LEI 1/§2.3)", () => {
  it("10) source_id casando → connector populado; sem linha → ausente (e ehConector false); determinística", () => {
    const sources = [fonte({ id: "conta-azul", connector: null }), fonte({ id: "upload-1", channel: "upload" })];
    const status: ConnectorStatusRow[] = [
      { source_id: "conta-azul", provider: "conta-azul", connection_id: "abc-123", status: "conectado", last_sync_at: null, last_error: null },
    ];
    const merged = anexarEstadoConector(sources, status);
    expect(merged[0].connector).toEqual({
      provider: "conta-azul",
      connection_id: "abc-123",
      status: "conectado",
      last_sync_at: null,
      last_error: null,
    });
    expect(ehConector(merged[0])).toBe(true);
    expect(merged[1].connector ?? null).toBe(null);
    expect(ehConector(merged[1])).toBe(false);
    // pura: não muta o input
    expect(sources[0].connector ?? null).toBe(null);
    // determinística: rodar de novo dá o mesmo resultado
    expect(anexarEstadoConector(sources, status)).toEqual(merged);
  });
});
