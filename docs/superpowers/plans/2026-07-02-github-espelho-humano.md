# Espelho GitHub navegável por pessoas — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Reestruturar o espelho GitHub pra navegação humana (origem+tempo), torná-lo espelho FIEL (deleta obsoleto), limpar a entrada/ pós-job-done e consertar o default de sigilo que fazia o espelho nascer vazio.

**Architecture:** Toda a lógica de forma (paths, nomes, README, plano de diff) vira função PURA em `github-sync.ts`, testável sem rede. `syncOut`/`syncIn` só orquestram IO (Postgres + GitHub REST). Deleção via tree entry `sha: null` sobre `base_tree`. Remoção da entrada/ é dirigida pelo status `done` do job na fila `galeed_ingest_jobs`.

**Tech Stack:** TypeScript (Node), lib `postgres`, GitHub Git Data API via fetch puro, Vitest, React (Ajustes).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-02-github-espelho-humano-design.md` (aprovado).
- Pastas geradas: `README.md`, `conhecimento/`, `reunioes/`, `conversas/`, `documentos/`, `anotacoes/`, `entrada/LEIA-ME.md`. Legada `memoria/` é gerenciada SÓ pra deleção (migração).
- `entrada/` (exceto LEIA-ME.md) NUNCA entra em deleção em massa; remoção pontual só com job `done`.
- README/dossiês/páginas determinísticos — NADA de relógio (`new Date()`/`Date.now()`) no conteúdo gerado; re-sync ocioso = zero commit.
- Default de sigilo espelhado: `restrito` (tudo) — em `setGithubConfig`, no DDL e no PUT do BFF.
- Copy de UI em PT-BR leigo (padrão do produto).
- Suíte: `npx vitest run` na raiz (709 testes hoje) — verde antes de cada commit.

---

### Task 1: Renders novos (funções puras de forma)

**Files:**
- Modify: `apps/server/src/core/platform/github-sync.ts` (seção "renderização")
- Test: `apps/server/test/unit/github-sync.test.ts`

**Interfaces:**
- Produces (usadas nas Tasks 2–4):
  - `pastaDe(p: PageRow): "reunioes"|"conversas"|"documentos"|"anotacoes"`
  - `limpaNome(s: string): string`
  - `caminhosDePaginas(paginas: PageRow[]): Map<string, PageRow>` (path→página, colisão resolvida, determinística)
  - `renderPagina(p: PageRow, path: string): { path: string; content: string }`
  - `renderDossie(entity: string, fatos: ...): { path: string; content: string }` (agora `conhecimento/<nome>.md`)
  - `renderReadme(info: PainelInfo): string` e `interface PainelInfo`
  - `LEIA_ME_ENTRADA: string` (conteúdo de `entrada/LEIA-ME.md`)
  - `encodeGh(path: string): string` (encodeURIComponent por segmento)

- [x] **Step 1: Failing tests** — em `github-sync.test.ts`, substituir os testes de render antigos (paths `memoria/...`) por:

```ts
import { pastaDe, limpaNome, caminhosDePaginas, renderPagina, renderDossie, renderReadme, gitBlobSha } from "../../src/core/platform/github-sync.ts";

const pagina = (over: any = {}) => ({
  slug: "s1", type: "notas", title: "Reunião de equipe", date: "2026-08-03",
  path: "", body: "corpo", tags: [], sensitivity: "restrito", ...over,
});

describe("pastaDe — mapeamento canal→pasta humana", () => {
  it("reuniao → reunioes", () => expect(pastaDe(pagina({ tags: ["canal:reuniao"] }) as any)).toBe("reunioes"));
  it("whatsapp/chatwoot/gmail → conversas", () => {
    for (const c of ["whatsapp", "chat", "chatwoot", "instagram", "gmail"])
      expect(pastaDe(pagina({ tags: [`canal:${c}`] }) as any)).toBe("conversas");
  });
  it("planilha → documentos; sem canal com doc: → documentos", () => {
    expect(pastaDe(pagina({ tags: ["canal:planilha"] }) as any)).toBe("documentos");
    expect(pastaDe(pagina({ tags: ["doc:abc123", "fonte:upload"] }) as any)).toBe("documentos");
  });
  it("webhook/formulario/sem nada → anotacoes", () => {
    expect(pastaDe(pagina({ tags: ["canal:webhook"] }) as any)).toBe("anotacoes");
    expect(pastaDe(pagina() as any)).toBe("anotacoes");
  });
});

describe("limpaNome + caminhos", () => {
  it("remove proibidos, colapsa espaço, corta em ~80 na palavra", () => {
    expect(limpaNome('a/b\\c:d*e?f"g<h>i|j')).toBe("a b c d e f g h i j");
    expect(limpaNome("  x   y  ")).toBe("x y");
    const longo = limpaNome("palavra ".repeat(30));
    expect(longo.length).toBeLessThanOrEqual(80);
    expect(longo.endsWith("palavra")).toBe(true);
  });
  it("path = pasta/ano/data — título.md; colisão ganha sufixo estável", () => {
    const a = pagina({ slug: "a", tags: ["canal:reuniao"] });
    const b = pagina({ slug: "b", tags: ["canal:reuniao"] }); // mesmo título+data
    const paths = [...caminhosDePaginas([b, a] as any).keys()];
    expect(paths).toEqual([
      "reunioes/2026/2026-08-03 — Reunião de equipe.md",
      "reunioes/2026/2026-08-03 — Reunião de equipe · 2.md",
    ]); // ordenado por slug: 'a' fica sem sufixo, independente da ordem de entrada
  });
  it("sem data → sem-data/", () => {
    const p = pagina({ date: "", tags: ["canal:reuniao"] });
    expect([...caminhosDePaginas([p] as any).keys()][0]).toBe("reunioes/sem-data/sem-data — Reunião de equipe.md");
  });
});

describe("renderPagina / renderDossie / renderReadme", () => {
  it("frontmatter enxuto, sem linha de areas vazia", () => {
    const { content } = renderPagina(pagina({ tags: ["canal:reuniao"] }) as any, "reunioes/2026/x.md");
    expect(content).toContain("titulo:");
    expect(content).toContain("origem: reuniao");
    expect(content).not.toContain("areas:");
  });
  it("dossiê vai pra conhecimento/ com nome sanitizado", () => {
    const { path } = renderDossie("acme/filial: sp", [{ dimension: "decisions", text: "x" }]);
    expect(path).toBe("conhecimento/acme filial sp.md");
  });
  it("README é painel determinístico com links encodados", () => {
    const info = {
      brain: "clinica", totalPaginas: 2, retidas: 1, capEntidades: false,
      porPasta: { reunioes: 1, conversas: 1, documentos: 0, anotacoes: 0 },
      dossies: [{ entity: "mariana", n: 4, path: "conhecimento/mariana.md" }],
      recentes: [{ titulo: "Reunião de equipe", data: "2026-08-03", path: "reunioes/2026/2026-08-03 — Reunião de equipe.md" }],
    };
    const md = renderReadme(info as any);
    expect(md).toContain("1 reunião");
    expect(md).toContain("(reunioes/2026/2026-08-03%20%E2%80%94%20Reuni%C3%A3o%20de%20equipe.md)");
    expect(md).toContain("1 memória não está neste espelho"); // retidas
    expect(renderReadme(info as any)).toBe(md); // determinístico
  });
});
```

- [x] **Step 2:** `npx vitest run apps/server/test/unit/github-sync.test.ts` → FAIL (funções não existem / paths antigos).

- [x] **Step 3: Implementação** em `github-sync.ts` — substituir a seção de renderização:

```ts
const CONVERSAS = new Set(["whatsapp", "chat", "chatwoot", "instagram", "telegram", "sms", "gmail", "email"]);

export function pastaDe(p: PageRow): "reunioes" | "conversas" | "documentos" | "anotacoes" {
  const tags = p.tags ?? [];
  const canal = tags.find((t) => t.startsWith("canal:"))?.slice(6) ?? "";
  if (canal === "reuniao" || canal === "reunioes") return "reunioes";
  if (CONVERSAS.has(canal)) return "conversas";
  if (canal === "planilha") return "documentos";
  if (!canal && tags.some((t) => t.startsWith("doc:"))) return "documentos";
  return "anotacoes";
}

/** nome humano seguro pra arquivo: sem / \ : * ? " < > | nem controles; ~80 chars na palavra. */
export function limpaNome(s: string): string {
  const limpo = s.replace(/[\/\\:*?"<>|]/g, " ").replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().replace(/^[.\s]+|[.\s]+$/g, "");
  if (limpo.length <= 80) return limpo;
  const corte = limpo.slice(0, 80);
  const esp = corte.lastIndexOf(" ");
  return (esp > 40 ? corte.slice(0, esp) : corte).trim();
}

export const encodeGh = (p: string) => p.split("/").map(encodeURIComponent).join("/");

/** paths humanos: pasta/ano/data — título.md; colisão → " · 2" em ordem estável por slug. */
export function caminhosDePaginas(paginas: PageRow[]): Map<string, PageRow> {
  const out = new Map<string, PageRow>();
  const vistos = new Map<string, number>();
  for (const p of [...paginas].sort((a, b) => a.slug.localeCompare(b.slug))) {
    const data = /^\d{4}-\d{2}-\d{2}/.test(p.date || "") ? p.date : "sem-data";
    const ano = data === "sem-data" ? "sem-data" : data.slice(0, 4);
    const nome = limpaNome(p.title || "") || p.slug;
    const base = `${pastaDe(p)}/${ano}/${data} — ${nome}`;
    const n = (vistos.get(base) ?? 0) + 1;
    vistos.set(base, n);
    out.set(`${base}${n > 1 ? ` · ${n}` : ""}.md`, p);
  }
  return out;
}
```

`renderPagina(p, path)` mantém frontmatter (titulo/data/origem/sigilo/fonte, sem areas vazia); `renderDossie` muda path pra `conhecimento/${limpaNome(entity) || entity}.md`; `renderReadme(info)` monta o painel (contagens com plural correto, top entidades e recentes como links `[título](encodeGh(path))`, nota de retidas no singular/plural, nota de cap); `LEIA_ME_ENTRADA` com formatos, regra do "sumiu = virou memória" e dica de subpastas. Sem relógio em nenhum render.

- [x] **Step 4:** `npx vitest run apps/server/test/unit/github-sync.test.ts` → PASS.
- [x] **Step 5:** `git add -A && git commit -m "feat(github): renders humanos — origem+tempo, nomes limpos, README painel"`

---

### Task 2: planoDeSync — diff com deleção + mensagem de commit humana

**Files:**
- Modify: `apps/server/src/core/platform/github-sync.ts`
- Test: `apps/server/test/unit/github-sync.test.ts`

**Interfaces:**
- Consumes: `gitBlobSha` (existente), constantes de pastas da Task 1.
- Produces: `ehGerenciado(path: string): boolean`; `planoDeSync(desejados: Map<string,string>, remotos: Map<string,string>, removerExtra?: string[]): { subir: {path,content}[]; apagar: string[] }`; `mensagemDeCommit(plano, remotos: Map<string,string>, entradaRemovidos: number): string`.

- [x] **Step 1: Failing tests**

```ts
describe("planoDeSync — espelho fiel", () => {
  const m = (o: Record<string, string>) => new Map(Object.entries(o));
  it("sobe só o que mudou; apaga gerenciado órfão (inclui memoria/ legada); não toca entrada/", () => {
    const desejados = m({ "README.md": "novo", "reunioes/2026/a.md": "igual" });
    const remotos = new Map([
      ["README.md", gitBlobSha("velho")],
      ["reunioes/2026/a.md", gitBlobSha("igual")],
      ["memoria/paginas/notas/x.md", gitBlobSha("legado")],
      ["conversas/2026/orfao.md", gitBlobSha("y")],
      ["entrada/meu-arquivo.md", gitBlobSha("z")],
      ["outra-coisa.md", gitBlobSha("w")],
    ]);
    const plano = planoDeSync(desejados, remotos);
    expect(plano.subir.map((s) => s.path)).toEqual(["README.md"]);
    expect(plano.apagar.sort()).toEqual(["conversas/2026/orfao.md", "memoria/paginas/notas/x.md"]);
  });
  it("removerExtra tira arquivo da entrada/ (ingerido) sem apagar o resto dela", () => {
    const remotos = new Map([["entrada/ata.md", gitBlobSha("x")], ["entrada/outro.md", gitBlobSha("y")]]);
    const plano = planoDeSync(new Map(), remotos, ["entrada/ata.md"]);
    expect(plano.apagar).toEqual(["entrada/ata.md"]);
  });
  it("nada mudou → plano vazio", () => {
    const plano = planoDeSync(m({ "README.md": "a" }), new Map([["README.md", gitBlobSha("a")]]));
    expect(plano.subir).toEqual([]);
    expect(plano.apagar).toEqual([]);
  });
});

describe("mensagemDeCommit", () => {
  it("conta novas por pasta em linguagem humana", () => {
    const plano = { subir: [
      { path: "reunioes/2026/a.md", content: "" }, { path: "conversas/2026/b.md", content: "" },
      { path: "conversas/2026/c.md", content: "" }, { path: "README.md", content: "" },
    ], apagar: ["memoria/x.md"] };
    const msg = mensagemDeCommit(plano as any, new Map([["README.md", "sha-antigo"]]), 1);
    expect(msg).toContain("3 memórias novas (1 reunião, 2 conversas)");
    expect(msg).toContain("1 removido");
    expect(msg).toContain("entrada: 1 ingerido");
  });
});
```

- [x] **Step 2:** rodar → FAIL.
- [x] **Step 3: Implementação**

```ts
const PREFIXOS_GERENCIADOS = ["conhecimento/", "reunioes/", "conversas/", "documentos/", "anotacoes/", "memoria/"];
const ARQUIVOS_GERENCIADOS = new Set(["README.md", "entrada/LEIA-ME.md"]);
export function ehGerenciado(path: string): boolean {
  return ARQUIVOS_GERENCIADOS.has(path) || PREFIXOS_GERENCIADOS.some((pref) => path.startsWith(pref));
}

export interface PlanoSync { subir: { path: string; content: string }[]; apagar: string[] }

export function planoDeSync(desejados: Map<string, string>, remotos: Map<string, string>, removerExtra: string[] = []): PlanoSync {
  const subir = [...desejados].filter(([p, c]) => remotos.get(p) !== gitBlobSha(c)).map(([path, content]) => ({ path, content }));
  const apagar = new Set([...remotos.keys()].filter((p) => ehGerenciado(p) && !desejados.has(p)));
  for (const p of removerExtra) if (remotos.has(p) && !desejados.has(p)) apagar.add(p);
  return { subir, apagar: [...apagar].sort() };
}

const NOME_PASTA: Record<string, [string, string]> = {
  reunioes: ["reunião", "reuniões"], conversas: ["conversa", "conversas"],
  documentos: ["documento", "documentos"], anotacoes: ["anotação", "anotações"],
  conhecimento: ["dossiê", "dossiês"],
};

export function mensagemDeCommit(plano: PlanoSync, remotos: Map<string, string>, entradaRemovidos: number): string {
  const novas = plano.subir.filter((s) => !remotos.has(s.path) && s.path.split("/")[0] in NOME_PASTA);
  const porPasta = new Map<string, number>();
  for (const s of novas) { const p = s.path.split("/")[0]; porPasta.set(p, (porPasta.get(p) ?? 0) + 1); }
  const partes: string[] = [];
  if (novas.length) {
    const detal = [...porPasta].map(([p, n]) => `${n} ${NOME_PASTA[p][n === 1 ? 0 : 1]}`).join(", ");
    partes.push(`${novas.length} memória${novas.length === 1 ? " nova" : "s novas"} (${detal})`);
  }
  const atualizados = plano.subir.length - novas.length;
  if (atualizados) partes.push(`${atualizados} atualizado${atualizados === 1 ? "" : "s"}`);
  if (plano.apagar.length) partes.push(`${plano.apagar.length} removido${plano.apagar.length === 1 ? "" : "s"}`);
  if (entradaRemovidos) partes.push(`entrada: ${entradaRemovidos} ingerido${entradaRemovidos === 1 ? "" : "s"}`);
  return `galeed: ${partes.join(" · ") || "sync"}`;
}
```

- [x] **Step 4:** rodar → PASS.
- [x] **Step 5:** `git commit -m "feat(github): planoDeSync — espelho fiel com deleção + commit message humana"`

---

### Task 3: syncOut rewire + sigilo default restrito + contarRetidas

**Files:**
- Modify: `apps/server/src/core/platform/github-sync.ts` (`syncOut`, `setGithubConfig`, DDL, novo `contarRetidas`)

**Interfaces:**
- Consumes: Task 1 renders, Task 2 plano.
- Produces: `syncOut(cfg, removerEntrada?: string[]): Promise<{ enviados: number; removidos: number; retidas: number; commit: string | null }>`; `contarRetidas(brain: string, sigiloMax: string): Promise<number>`.

- [x] **Step 1:** Reescrever `syncOut`:
  - `todas = await e.allPages()`; `paginas = todas.filter(rank ≤ cap)`; `retidas = todas.length - paginas.length`.
  - `desejados`: `entrada/LEIA-ME.md` + páginas via `caminhosDePaginas` → `renderPagina(p, path)` + dossiês (query atual, `conhecimento/`) + `README.md` por último (PainelInfo montado dos itens já calculados: contagens por pasta, top 10 entidades, 10 recentes por data desc, retidas, capEntidades = ents.length === 200).
  - Filtro de sigilo do dossiê: se `sensitivityRank(cfg.sigiloMax) < sensitivityRank("restrito")`, `allowedSlugs = new Set(paginas.map(p => p.slug))` e filtrar `fatos.filter(f => !f.source_slug || allowedSlugs.has(f.source_slug))` — em `restrito` não filtra.
  - Trocar o diff inline por `const plano = planoDeSync(desejados, remotos, removerEntrada)`; se `!plano.subir.length && !plano.apagar.length` → `{ enviados: 0, removidos: 0, retidas, commit: null }`.
  - Tree entries: subir como hoje (blob POST); apagar como `{ path, mode: "100644", type: "blob", sha: null }` no MESMO array (exige `base_tree` — bootstrap de repo vazio já garante ref antes).
  - Commit message: `mensagemDeCommit(plano, remotos, removerEntrada?.length ?? 0)`.
- [x] **Step 2:** Defaults: `setGithubConfig` → `input.sigiloMax ?? atual?.sigiloMax ?? "restrito"`; DDL `sigilo_max text not null default 'restrito'`.
- [x] **Step 3:** `contarRetidas`:

```ts
export async function contarRetidas(brain: string, sigiloMax: string): Promise<number> {
  const sql = await db();
  const cap = sensitivityRank(sigiloMax);
  const rows = (await sql`
    select count(*)::int as n from galeed_pages where brain = ${brain}
      and (case coalesce(nullif(sensitivity,''),'restrito')
           when 'publico' then 0 when 'interno' then 1 when 'sensivel' then 2 else 3 end) > ${cap}`) as any[];
  return rows[0]?.n ?? 0;
}
```

- [x] **Step 4:** `npx vitest run apps/server/test/unit/github-sync.test.ts` → PASS (typecheck do arquivo inteiro via suite). Rodar também `npx tsc --noEmit -p apps/server` se existir tsconfig de check (senão a suite cobre).
- [x] **Step 5:** `git commit -m "feat(github): syncOut fiel (deleção+migração memoria/) + default espelhar tudo + contarRetidas"`

---

### Task 4: syncIn — LEIA-ME skip, remoção pós-done, subpasta como origem

**Files:**
- Modify: `apps/server/src/core/platform/github-sync.ts` (`syncIn`, DDL, `runGithubSync`)

**Interfaces:**
- Consumes: `enqueueIngestJob({brain,kind,type,contentHash,filename,title,sourceId})`, `putBlobOnly`, `getEngine(brain).upsertSource(row)` (SourceRow: id,name,channel,type,recipe:{fields:[]},default_sensitivity,status).
- Produces: `syncIn(cfg): Promise<{ ingeridos: number; jobs: string[]; remover: string[] }>`; `runGithubSync` summary vira `{ brain, entradaIngeridos, entradaRemovidos, espelhoEnviados, espelhoRemovidos, retidas, commit, erro }`.

- [x] **Step 1:** DDL — acrescentar ao bloco lazy:

```sql
alter table galeed_github_entrada add column if not exists doc_hash text;
alter table galeed_github_entrada add column if not exists job_id text;
```

- [x] **Step 2:** `syncIn`:
  - Pular `entrada/LEIA-ME.md` (`if (t.path === "entrada/LEIA-ME.md") continue;`).
  - Hint de subpasta: `const seg = String(t.path).split("/"); const hint = seg.length >= 3 ? ({ reunioes: "reuniao", reuniao: "reuniao", conversas: "chat", conversa: "chat" } as Record<string,string>)[seg[1]] : undefined;`
  - Se `hint`: garantir a fonte uma vez por rodada — `const srcId = "github-entrada-" + hint;` e `await e.upsertSource({ id: srcId, name: "Entrada GitHub — " + (hint === "reuniao" ? "reuniões" : "conversas"), channel: hint, type: "", recipe: { fields: [] }, default_sensitivity: "restrito", status: "ativa" })` (cache em Set local pra não repetir upsert). Passar `sourceId: srcId` no `enqueueIngestJob`.
  - Dedupe por hash: se já existe job não-erro com o hash, usar `dup[0].id` como `job_id` do registro (o arquivo aponta pro job que já existe — remoção quando ele concluir).
  - Gravar `doc_hash` e `job_id` no upsert de `galeed_github_entrada`.
  - `remover`: no fim, `select e.path from galeed_github_entrada e join galeed_ingest_jobs j on j.id = e.job_id where e.brain = ${brain} and j.status = 'done'` filtrado por paths ainda presentes na árvore remota desta rodada.
- [x] **Step 3:** `runGithubSync`: `const inn = await syncIn(cfg); const outt = await syncOut(cfg, inn.remover);` e montar o summary novo (campos acima). Conferir `apps/server/src/connectors/ingest-worker.ts` (tick do worker) e ajustar o log se referenciar campos antigos.
- [x] **Step 4:** Teste unit do shape puro que dá: hint de subpasta é lógica pura — extrair `hintDeEntrada(path: string): string | undefined` e testar:

```ts
describe("hintDeEntrada", () => {
  it("subpasta vira canal; raiz não tem hint", () => {
    expect(hintDeEntrada("entrada/reunioes/ata.md")).toBe("reuniao");
    expect(hintDeEntrada("entrada/conversas/zap.txt")).toBe("chat");
    expect(hintDeEntrada("entrada/solto.md")).toBeUndefined();
    expect(hintDeEntrada("entrada/outra-pasta/x.md")).toBeUndefined();
  });
});
```

- [x] **Step 5:** `npx vitest run apps/server/test/unit/github-sync.test.ts` → PASS.
- [x] **Step 6:** `git commit -m "feat(github): entrada limpa pós-job-done + subpasta como origem + LEIA-ME"`

---

### Task 5: BFF + openapi

**Files:**
- Modify: `apps/server/src/connectors/web-server.ts:855-885`
- Modify: `apps/docs/openapi.yaml` (bloco /api/github/*)

- [x] **Step 1:** GET `/api/github/config`: incluir `retidas` — `const retidas = c ? await contarRetidas(home, c.sigiloMax) : 0;` e devolver `{ ...c, pat: undefined, temPat: !!c.pat, retidas }`.
- [x] **Step 2:** PUT: `sigiloMax: str(b.sigiloMax) || "restrito"`.
- [x] **Step 3:** POST sync: devolver o summary novo como está (campos renomeados: `entradaRemovidos`, `espelhoRemovidos`, `retidas`).
- [x] **Step 4:** `openapi.yaml`: atualizar schemas de config (campo `retidas: integer`) e do resultado de sync (`entradaRemovidos`, `espelhoRemovidos`, `retidas`); descrever a estrutura nova de pastas na descrição do recurso.
- [x] **Step 5:** suite verde (tem teste de openapi/rotas) → `git commit -m "feat(github/bff): retidas na config + default espelhar tudo + openapi"`

---

### Task 6: UI Ajustes — "O que espelhar", aviso e status com retidas

**Files:**
- Modify: `apps/web/src/screens/Ajustes/index.tsx:895-1046`

- [x] **Step 1:** `GhConfigView` ganha `retidas?: number`; estado `sigiloMax` default `"restrito"` (e no load, `c.sigiloMax ?? "restrito"`).
- [x] **Step 2:** Copy do parágrafo intro: estrutura nova (pastas por origem — reuniões, conversas, documentos, anotações — + `conhecimento/` com dossiês + `entrada/` sua) e a regra "sumiu da entrada = virou memória".
- [x] **Step 3:** Select vira "O que espelhar": `restrito`→"Tudo (recomendado)" PRIMEIRO, depois `sensivel`→"Até sigiloso", `interno`→"Até interno", `publico`→"Só aberto". Abaixo do select, aviso fixo: "Quem tem acesso ao repositório vê tudo que está nele — use um repositório privado."
- [x] **Step 4:** Status: junto de "última sync", quando `cfg.retidas > 0` mostrar `· {retidas} memória(s) retidas pelo filtro de sigilo`. Toast do sync manual passa a incluir removidos: `Sync ok: X no espelho · Y removidos · Z da entrada pra fila.`
- [x] **Step 5:** Build web (`npx vite build` em apps/web ou o check da suíte) → `git commit -m "feat(web/ajustes): o que espelhar (tudo default) + aviso + retidas no status"`

---

### Task 7: Docs + suíte completa

**Files:**
- Modify: `INGESTORES.md` (seção GitHub)

- [x] **Step 1:** Atualizar a seção GitHub: árvore nova de pastas (exemplo real), regra da entrada/ ("sumiu = virou memória"), subpastas de classificação, default de sigilo "tudo" com aviso de repo privado.
- [x] **Step 2:** `npx vitest run` (suíte INTEIRA) → verde.
- [x] **Step 3:** `git commit -m "docs(ingestores): espelho GitHub navegável — estrutura nova e entrada limpa"`

---

### Task 8: E2E REAL contra a360-business/galeed-espelho-teste

Checklist manual/scriptado (tsx no scratchpad, usando a config real do brain de demo no Postgres dev):

- [x] **Step 1:** `runGithubSync(<brain demo>)` → conferir via API: árvore tem `README.md`, `conhecimento/`, pastas de origem; `memoria/` NÃO existe mais (migração no mesmo commit).
- [x] **Step 2:** Re-sync imediato → `commit: null` (zero mudanças, README determinístico).
- [x] **Step 3:** Commitar um `entrada/reunioes/ata-teste.md` via API → sync → job na fila com source `github-entrada-reuniao` → esperar worker processar → sync seguinte REMOVE o arquivo da entrada/ e a memória aparece em `reunioes/`.
- [x] **Step 4:** Apagar a página de teste do cérebro → sync → arquivo some do espelho.
- [x] **Step 5:** GET /api/github/config → `retidas` coerente com o sigilo configurado.
- [x] **Step 6:** Registrar os resultados no commit final: `git commit -m "community: espelho GitHub pra pessoas — origem+tempo, espelho fiel, entrada limpa (e2e real)"`
