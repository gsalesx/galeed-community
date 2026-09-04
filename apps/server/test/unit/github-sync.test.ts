/** GITHUB SYNC — partes PURAS (sha de blob git, forma humana do espelho, plano de diff).
 *  O e2e com repo real valida o resto (Git Data API, entrada por diff, remoção pós-done). */
import { describe, it, expect } from "vitest";
import {
  gitBlobSha, pastaDe, limpaNome, caminhosDePaginas, renderPagina, renderDossie,
  renderReadme, planoDeSync, mensagemDeCommit, ehGerenciado, hintDeEntrada, type PainelInfo,
} from "../../src/core/platform/github-sync.ts";
import type { PageRow } from "../../src/core/platform/engine.ts";

const pagina = (over: Partial<PageRow> = {}): PageRow => ({
  slug: "s1", type: "notas", title: "Reunião de equipe", date: "2026-08-03",
  path: "", body: "corpo", tags: [], sensitivity: "restrito", ...over,
});

describe("gitBlobSha — diff de saída sem baixar nada", () => {
  it("bate com o sha1 que o git calcularia (vetor conhecido: 'hello\\n')", () => {
    // $ echo 'hello' | git hash-object --stdin  → ce013625030ba8dba906f756967f9e9ca394464a
    expect(gitBlobSha("hello\n")).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
  });

  it("conteúdo com multibyte usa o TAMANHO EM BYTES (não em chars)", () => {
    const a = gitBlobSha("decisão\n");
    expect(a).toHaveLength(40);
    expect(a).not.toBe(gitBlobSha("decisao\n")); // ç muda o byte-len e o conteúdo
  });
});

describe("pastaDe — mapeamento canal→pasta humana", () => {
  it("reuniao → reunioes", () => {
    expect(pastaDe(pagina({ tags: ["canal:reuniao"] }))).toBe("reunioes");
  });
  it("whatsapp/chat/chatwoot/instagram/gmail → conversas", () => {
    for (const c of ["whatsapp", "chat", "chatwoot", "instagram", "gmail"])
      expect(pastaDe(pagina({ tags: [`canal:${c}`] }))).toBe("conversas");
  });
  it("planilha → documentos; sem canal mas com doc: (veio de arquivo) → documentos", () => {
    expect(pastaDe(pagina({ tags: ["canal:planilha"] }))).toBe("documentos");
    expect(pastaDe(pagina({ tags: ["doc:abc123", "fonte:upload"] }))).toBe("documentos");
  });
  it("webhook/formulario/sem nada → anotacoes (canal ganha do doc:)", () => {
    expect(pastaDe(pagina({ tags: ["canal:webhook"] }))).toBe("anotacoes");
    expect(pastaDe(pagina({ tags: ["canal:formulario", "doc:abc"] }))).toBe("anotacoes");
    expect(pastaDe(pagina())).toBe("anotacoes");
  });
});

describe("limpaNome + caminhosDePaginas — nomes que uma pessoa lê", () => {
  it("remove proibidos, colapsa espaço, corta em ~80 na fronteira de palavra", () => {
    expect(limpaNome('a/b\\c:d*e?f"g<h>i|j')).toBe("a b c d e f g h i j");
    expect(limpaNome("  x   y  ")).toBe("x y");
    const longo = limpaNome("palavra ".repeat(30));
    expect(longo.length).toBeLessThanOrEqual(80);
    expect(longo.endsWith("palavra")).toBe(true);
  });
  it("path = pasta/ano/data — título.md; colisão ganha sufixo estável por slug", () => {
    const a = pagina({ slug: "a", tags: ["canal:reuniao"] });
    const b = pagina({ slug: "b", tags: ["canal:reuniao"] }); // mesmo título+data
    const paths = [...caminhosDePaginas([b, a]).keys()]; // ordem de entrada invertida de propósito
    expect(paths).toEqual([
      "reunioes/2026/2026-08-03 — Reunião de equipe.md",
      "reunioes/2026/2026-08-03 — Reunião de equipe · 2.md",
    ]);
    expect(caminhosDePaginas([b, a]).get(paths[0])!.slug).toBe("a"); // 'a' fica sem sufixo sempre
  });
  it("título que já era nome de arquivo perde a extensão (sem 'politica.md.md')", () => {
    const p = pagina({ title: "politica-de-cancelamento.md", tags: ["doc:x"] });
    expect([...caminhosDePaginas([p]).keys()][0]).toBe("documentos/2026/2026-08-03 — politica-de-cancelamento.md");
  });
  it("sem data → sem-data/; título vazio cai no slug", () => {
    const p = pagina({ date: "", tags: ["canal:reuniao"] });
    expect([...caminhosDePaginas([p]).keys()][0]).toBe("reunioes/sem-data/sem-data — Reunião de equipe.md");
    const q = pagina({ title: "", slug: "meu-slug" });
    expect([...caminhosDePaginas([q]).keys()][0]).toBe("anotacoes/2026/2026-08-03 — meu-slug.md");
  });
});

describe("renderPagina — arquivo legível com frontmatter enxuto", () => {
  it("frontmatter com titulo/data/origem/sigilo/fonte; sem linha de areas vazia", () => {
    const { path, content } = renderPagina(
      pagina({ slug: "call-1", title: "Call estratégica", tags: ["canal:reuniao"], sensitivity: "interno" }),
      "reunioes/2026/2026-08-03 — Call estratégica.md",
    );
    expect(path).toBe("reunioes/2026/2026-08-03 — Call estratégica.md");
    expect(content).toContain('titulo: "Call estratégica"');
    expect(content).toContain("origem: reuniao");
    expect(content).toContain("sigilo: interno");
    expect(content).toContain("fonte: call-1");
    expect(content).not.toContain("areas:");
    expect(content).toContain("corpo");
  });
});

describe("renderDossie — decisões acima de números, agora em conhecimento/", () => {
  it("path sanitizado; seções na ordem decisões → vale hoje; vazias não aparecem", () => {
    const { path, content } = renderDossie("acme/filial: sp", [
      { dimension: "facts", predicate: "localizacao", value: "centro", text: "Abriu unidade no centro", valid_to: "", status: "fato", valid_from: "2026-07-02" },
      { dimension: "decisions", text: "Decidiu focar em premium PORQUE clientes citam confiança", valid_to: "", status: "fato" },
    ]);
    expect(path).toBe("conhecimento/acme filial sp.md");
    const iDecisao = content.indexOf("## Decisões");
    const iVale = content.indexOf("## O que vale hoje");
    expect(iDecisao).toBeGreaterThan(-1);
    expect(iVale).toBeGreaterThan(iDecisao); // decisões vêm ANTES dos fatos/números
    expect(content).toContain("PORQUE clientes citam confiança");
    expect(content).not.toContain("## Falas"); // seção vazia não aparece
    expect(content).toContain("não edite");
  });
});

describe("renderReadme — painel vivo e determinístico", () => {
  const info: PainelInfo = {
    brain: "clinica", totalPaginas: 2, retidas: 1, capEntidades: false,
    porPasta: { reunioes: 1, conversas: 1, documentos: 0, anotacoes: 0 },
    dossies: [{ entity: "mariana", n: 4, path: "conhecimento/mariana.md" }],
    recentes: [{ titulo: "Reunião de equipe", data: "2026-08-03", path: "reunioes/2026/2026-08-03 — Reunião de equipe.md" }],
  };
  it("contagens humanas, links encodados, nota de retidas", () => {
    const md = renderReadme(info);
    expect(md).toContain("1 reunião");
    expect(md).toContain("1 conversa");
    expect(md).toContain("(reunioes/2026/2026-08-03%20%E2%80%94%20Reuni%C3%A3o%20de%20equipe.md)");
    expect(md).toContain("(conhecimento/mariana.md)");
    expect(md).toContain("1 memória não está neste espelho"); // retidas, no singular
  });
  it("determinístico (sem relógio): duas chamadas = mesmo conteúdo", () => {
    expect(renderReadme(info)).toBe(renderReadme(info));
  });
});

describe("planoDeSync — espelho fiel", () => {
  const m = (o: Record<string, string>) => new Map(Object.entries(o));
  it("sobe só o que mudou; apaga gerenciado órfão (inclui memoria/ legada); não toca entrada/ nem alheio", () => {
    const desejados = m({ "README.md": "novo", "reunioes/2026/a.md": "igual" });
    const remotos = new Map([
      ["README.md", gitBlobSha("velho")],
      ["reunioes/2026/a.md", gitBlobSha("igual")],
      ["memoria/paginas/notas/x.md", gitBlobSha("legado")], // migração: estrutura antiga some
      ["conversas/2026/orfao.md", gitBlobSha("y")], // página apagada/sigilo elevado
      ["entrada/meu-arquivo.md", gitBlobSha("z")], // do usuário — intocável
      ["outra-coisa.md", gitBlobSha("w")], // fora das pastas gerenciadas — intocável
    ]);
    const plano = planoDeSync(desejados, remotos);
    expect(plano.subir.map((s) => s.path)).toEqual(["README.md"]);
    expect(plano.apagar).toEqual(["conversas/2026/orfao.md", "memoria/paginas/notas/x.md"]);
  });
  it("removerExtra tira arquivo INGERIDO da entrada/ sem apagar o resto dela", () => {
    const remotos = new Map([["entrada/ata.md", gitBlobSha("x")], ["entrada/outro.md", gitBlobSha("y")]]);
    const plano = planoDeSync(new Map(), remotos, ["entrada/ata.md"]);
    expect(plano.apagar).toEqual(["entrada/ata.md"]);
    expect(plano.subir).toEqual([]);
  });
  it("nada mudou → plano vazio (zero commit)", () => {
    const plano = planoDeSync(m({ "README.md": "a" }), new Map([["README.md", gitBlobSha("a")]]));
    expect(plano.subir).toEqual([]);
    expect(plano.apagar).toEqual([]);
  });
  it("ehGerenciado: LEIA-ME da entrada é nosso; o resto da entrada é do usuário", () => {
    expect(ehGerenciado("entrada/LEIA-ME.md")).toBe(true);
    expect(ehGerenciado("entrada/qualquer.md")).toBe(false);
    expect(ehGerenciado("conhecimento/x.md")).toBe(true);
    expect(ehGerenciado("README.md")).toBe(true);
    expect(ehGerenciado("LICENSE")).toBe(false);
  });
});

describe("mensagemDeCommit — histórico que uma pessoa lê", () => {
  it("conta novas por pasta, atualizados, removidos e ingeridos da entrada", () => {
    const plano = {
      subir: [
        { path: "reunioes/2026/a.md", content: "" },
        { path: "conversas/2026/b.md", content: "" },
        { path: "conversas/2026/c.md", content: "" },
        { path: "README.md", content: "" }, // já existia → atualizado, não é "memória nova"
      ],
      apagar: ["memoria/x.md"],
    };
    const msg = mensagemDeCommit(plano, new Map([["README.md", "sha-antigo"]]), 1);
    expect(msg).toContain("3 memórias novas (1 reunião, 2 conversas)");
    expect(msg).toContain("1 atualizado");
    expect(msg).toContain("1 removido");
    expect(msg).toContain("entrada: 1 ingerido");
  });
  it("sem nada de humano pra dizer → fallback simples", () => {
    expect(mensagemDeCommit({ subir: [], apagar: [] }, new Map(), 0)).toBe("galeed: sync");
  });
});

describe("hintDeEntrada — subpasta da entrada classifica a origem", () => {
  it("reunioes→reuniao, conversas→chat; raiz e pasta desconhecida não têm hint", () => {
    expect(hintDeEntrada("entrada/reunioes/ata.md")).toBe("reuniao");
    expect(hintDeEntrada("entrada/reuniao/ata.md")).toBe("reuniao");
    expect(hintDeEntrada("entrada/conversas/zap.txt")).toBe("chat");
    expect(hintDeEntrada("entrada/solto.md")).toBeUndefined();
    expect(hintDeEntrada("entrada/outra-pasta/x.md")).toBeUndefined();
  });
});
