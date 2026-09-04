/** GITHUB SYNC — o cérebro legível e versionado, organizado PRA PESSOAS (decisão do fundador:
 *  "as pessoas gostam de VER os arquivos" + "organização humana, não de máquina"):
 *
 *    README.md                       ← painel vivo (o que o cérebro sabe, links, retidas)
 *    conhecimento/<entidade>.md      ← dossiês (decisões com porquê acima de números)
 *    reunioes|conversas|documentos|anotacoes/<ano>/data — Título humano.md
 *    entrada/                        ← o USUÁRIO solta .md/.txt/.csv/.pdf; nós ingerimos o DIFF
 *                                      via fila e REMOVEMOS o arquivo quando o job conclui
 *                                      ("sumiu = virou memória; ficou = processando ou erro").
 *
 *  As pastas geradas são espelho FIEL: o que sai do cérebro (página apagada, sigilo elevado)
 *  SOME do repo no próximo sync. entrada/ nunca entra em deleção em massa.
 *
 *  Mecânica: API REST do GitHub via fetch (zero deps, PAT fine-grained com contents:write).
 *  Sync de saída em UM commit por rodada (Git Data API: blobs → tree(+sha null p/ deleção) →
 *  commit → ref). Diff barato: sha de blob git calculado LOCALMENTE (sha1("blob N\0"+conteúdo)).
 *  SIGILO: default 'restrito' (espelha tudo — o repo é do próprio dono; a UI avisa "use repo
 *  privado") e o nº de retidas fica visível na config e no README. Editar o espelho NÃO
 *  re-ingere (v1 — merge bidirecional fica pra depois). */
import { createHash } from "node:crypto";
import { getSharedSql, sharedSqlGeneration } from "./db-conn.ts";
import { getEngine, sensitivityRank, type PageRow } from "./engine.ts";
import { timeline } from "../retrieval/query.ts";
import { putBlobOnly } from "../ingestion/ingest-doc.ts";
import { enqueueIngestJob } from "../ingestion/ingest-queue.ts";
import { detectDocKind } from "../../lib/extract-doc.ts";

const API = "https://api.github.com";
const ENTRADA_EXT = new Set([".md", ".markdown", ".txt", ".csv", ".tsv", ".pdf"]);
const MAX_ENTRADA_BYTES = 25 * 1024 * 1024;

export interface GithubConfig {
  brain: string;
  owner: string;
  repo: string;
  branch: string;
  pat: string;
  sigiloMax: string; // nível máximo espelhado ('restrito' default = tudo; o repo é do dono)
  enabled: boolean;
  lastSyncAt: string | null;
  lastCommit: string | null;
  lastError: string | null;
}

// ---------- schema (DDL idempotente lazy — padrão da fila) ----------

let _ready: Promise<void> | null = null;
let _readyGeneration = -1;

async function db(): Promise<any> {
  const sql = await getSharedSql();
  const gen = sharedSqlGeneration();
  if (_ready && _readyGeneration === gen) {
    await _ready;
    return sql;
  }
  _readyGeneration = gen;
  _ready = (async () => {
    await sql.unsafe(`
      create table if not exists galeed_github_sync (
        brain text primary key,
        owner text not null,
        repo text not null,
        branch text not null default 'main',
        pat text not null,
        sigilo_max text not null default 'restrito',
        enabled boolean not null default false,
        last_sync_at timestamptz,
        last_commit text,
        last_error text
      );
      create table if not exists galeed_github_entrada (
        brain text not null,
        path text not null,
        gh_sha text not null,
        ingested_at timestamptz not null default now(),
        primary key (brain, path)
      );
      alter table galeed_github_entrada add column if not exists doc_hash text;
      alter table galeed_github_entrada add column if not exists job_id text`);
  })();
  await _ready;
  return sql;
}

// ---------- config ----------

export async function getGithubConfig(brain: string): Promise<GithubConfig | null> {
  const sql = await db();
  const rows = (await sql`select * from galeed_github_sync where brain = ${brain} limit 1`) as any[];
  if (!rows.length) return null;
  const r = rows[0];
  return {
    brain, owner: r.owner, repo: r.repo, branch: r.branch, pat: r.pat,
    sigiloMax: r.sigilo_max, enabled: r.enabled === true,
    lastSyncAt: r.last_sync_at ? new Date(r.last_sync_at).toISOString() : null,
    lastCommit: r.last_commit ?? null, lastError: r.last_error ?? null,
  };
}

export async function setGithubConfig(
  brain: string,
  input: { owner: string; repo: string; branch?: string; pat?: string; sigiloMax?: string; enabled?: boolean },
): Promise<void> {
  const sql = await db();
  const atual = await getGithubConfig(brain);
  const pat = (input.pat ?? "").trim() || atual?.pat || ""; // PAT vazio no PUT = mantém o atual
  await sql`
    insert into galeed_github_sync (brain, owner, repo, branch, pat, sigilo_max, enabled)
    values (${brain}, ${input.owner.trim()}, ${input.repo.trim()},
            ${(input.branch ?? "main").trim() || "main"}, ${pat},
            ${input.sigiloMax ?? atual?.sigiloMax ?? "restrito"}, ${input.enabled ?? atual?.enabled ?? false})
    on conflict (brain) do update set
      owner = excluded.owner, repo = excluded.repo, branch = excluded.branch,
      pat = excluded.pat, sigilo_max = excluded.sigilo_max, enabled = excluded.enabled,
      last_error = null`;
}

export async function listEnabledGithubConfigs(): Promise<GithubConfig[]> {
  const sql = await db();
  const rows = (await sql`select brain from galeed_github_sync where enabled = true`) as any[];
  const out: GithubConfig[] = [];
  for (const r of rows) {
    const c = await getGithubConfig(r.brain as string);
    if (c) out.push(c);
  }
  return out;
}

// ---------- cliente REST (fetch puro) ----------

async function gh(cfg: GithubConfig, method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${cfg.pat}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 404) return null;
  // GET de ref num repo VAZIO devolve 409 "Git Repository is empty" — pro sync isso é "sem head
  // ainda" (primeiro commit sem parent), não um erro.
  if (res.status === 409 && method === "GET") return null;
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`GitHub ${method} ${path} → ${res.status}: ${txt.slice(0, 180)}`);
  }
  return res.json();
}

/** sha de blob do git calculado LOCALMENTE (diff de saída sem baixar nada): sha1("blob N\0"+c). */
export function gitBlobSha(content: string): string {
  const buf = Buffer.from(content, "utf8");
  return createHash("sha1").update(`blob ${buf.length}\0`).update(buf).digest("hex");
}

// ---------- renderização (PURA — testável): a forma HUMANA do espelho ----------
// Pastas do mundo real (decisão do fundador: "organização pra pessoas, não de máquina"):
// reunioes/ conversas/ documentos/ anotacoes/ por ano, conhecimento/ com dossiês,
// README painel e entrada/ do usuário.

const CONVERSAS = new Set(["whatsapp", "chat", "chatwoot", "instagram", "telegram", "sms", "gmail", "email"]);

export function pastaDe(p: PageRow): "reunioes" | "conversas" | "documentos" | "anotacoes" {
  const tags = p.tags ?? [];
  const canal = tags.find((t) => t.startsWith("canal:"))?.slice(6) ?? "";
  if (canal === "reuniao" || canal === "reunioes") return "reunioes";
  if (CONVERSAS.has(canal)) return "conversas";
  if (canal === "planilha") return "documentos";
  if (!canal && tags.some((t) => t.startsWith("doc:"))) return "documentos";
  // SEM `canal:` (webhook universal /ingest: capture só emite `fonte:<source>`): fallback pelo
  // type (classify já materializa reunião via SOURCE_HINT/conteúdo) e pela `fonte:` com o MESMO
  // set CONVERSAS. DEPOIS do check de doc: acima — upload continua em documentos/. Com `canal:`
  // presente (mesmo desconhecido) o contrato atual fica intacto.
  if (!canal) {
    if (p.type === "reunioes") return "reunioes";
    const fonte = tags.find((t) => t.startsWith("fonte:"))?.slice(6) ?? "";
    if (CONVERSAS.has(fonte)) return "conversas";
  }
  return "anotacoes";
}

/** nome humano seguro pra arquivo: sem / \ : * ? " < > | nem controles; ~80 chars na palavra. */
export function limpaNome(s: string): string {
  const limpo = s
    .replace(/[\/\\:*?"<>|]/g, " ")
    .replace(/[\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, "");
  if (limpo.length <= 80) return limpo;
  const corte = limpo.slice(0, 80);
  const esp = corte.lastIndexOf(" ");
  return (esp > 40 ? corte.slice(0, esp) : corte).trim();
}

/** link de markdown que funciona no GitHub: encodeURIComponent por segmento. */
export const encodeGh = (p: string): string => p.split("/").map(encodeURIComponent).join("/");

/** paths humanos: pasta/ano/data — título.md; colisão → " · 2" em ordem ESTÁVEL por slug. */
export function caminhosDePaginas(paginas: PageRow[]): Map<string, PageRow> {
  const out = new Map<string, PageRow>();
  const vistos = new Map<string, number>();
  for (const p of [...paginas].sort((a, b) => a.slug.localeCompare(b.slug))) {
    const data = /^\d{4}-\d{2}-\d{2}/.test(p.date || "") ? p.date.slice(0, 10) : "sem-data";
    const ano = data === "sem-data" ? "sem-data" : data.slice(0, 4);
    // título que já era NOME DE ARQUIVO (upload) perde a extensão — evita "politica.md.md"
    const nome = limpaNome((p.title || "").replace(/\.(md|markdown|txt|csv|tsv|pdf)\s*$/i, "")) || p.slug;
    const base = `${pastaDe(p)}/${ano}/${data} — ${nome}`;
    const n = (vistos.get(base) ?? 0) + 1;
    vistos.set(base, n);
    out.set(`${base}${n > 1 ? ` · ${n}` : ""}.md`, p);
  }
  return out;
}

/** página → arquivo .md com frontmatter ENXUTO (o espelho legível de UMA memória). */
export function renderPagina(p: PageRow, path: string): { path: string; content: string } {
  // origem: canal da fonte; sem `canal:` (webhook universal), a `fonte:` — melhor que omitir.
  const canal = (p.tags ?? []).find((t) => t.startsWith("canal:"))?.slice(6) ?? "";
  const origem = canal || ((p.tags ?? []).find((t) => t.startsWith("fonte:"))?.slice(6) ?? "");
  const front = [
    "---",
    `titulo: ${JSON.stringify(p.title || p.slug)}`,
    p.date ? `data: ${p.date}` : "",
    origem ? `origem: ${origem}` : "",
    `sigilo: ${p.sensitivity || "restrito"}`,
    `fonte: ${p.slug}`,
    "---",
  ].filter(Boolean).join("\n");
  return { path, content: `${front}\n\n${p.body.trim()}\n` };
}

/** dossiê → conhecimento/<entidade>.md (mesma hierarquia da tela: decisões > compromissos > resto). */
export function renderDossie(entity: string, fatos: Array<Record<string, any>>): { path: string; content: string } {
  const vig = (f: any) => (f.valid_to ?? "") === "" && f.status !== "arquivado";
  const linha = (f: any) => `- ${f.text || `${f.predicate}: ${f.value}`}${f.valid_from ? ` _(${f.valid_from})_` : ""}`;
  const secao = (titulo: string, itens: any[]): string =>
    itens.length ? `## ${titulo}\n\n${itens.map(linha).join("\n")}\n` : "";

  const decisoes = fatos.filter((f) => f.dimension === "decisions");
  const compromissos = fatos.filter((f) => f.dimension === "action_items" || f.dimension === "follow_ups_pending");
  const aprendizados = fatos.filter((f) => String(f.predicate ?? "").startsWith("aprendizado"));
  const valeHoje = fatos.filter(
    (f) => vig(f) && (f.dimension === "facts" || f.dimension === "claims") && !String(f.predicate ?? "").startsWith("aprendizado"),
  );
  const falas = fatos.filter((f) => f.dimension === "quotes");

  const content = [
    `# ${entity}`,
    "",
    "> Gerado pelo Galeed — não edite (é sobrescrito a cada sync).",
    "",
    secao("Decisões (com o porquê)", decisoes),
    secao("Compromissos e pendências", compromissos),
    secao("O que vale hoje", valeHoje),
    secao("Aprendizados", aprendizados),
    secao("Falas registradas", falas),
  ].filter((s) => s !== "").join("\n");
  return { path: `conhecimento/${limpaNome(entity) || entity}.md`, content: `${content}\n` };
}

/** painel do README — TUDO derivado dos dados (nada de relógio: re-sync ocioso = zero commit). */
export interface PainelInfo {
  brain: string;
  totalPaginas: number;
  retidas: number; // páginas fora do espelho pelo filtro de sigilo
  capEntidades: boolean; // bateu o teto de 200 dossiês
  porPasta: Record<string, number>; // reunioes/conversas/documentos/anotacoes
  dossies: Array<{ entity: string; n: number; path: string }>; // top já cortado
  recentes: Array<{ titulo: string; data: string; path: string }>;
}

const PLURAL: Record<string, [string, string]> = {
  reunioes: ["reunião", "reuniões"], conversas: ["conversa", "conversas"],
  documentos: ["documento", "documentos"], anotacoes: ["anotação", "anotações"],
};

export function renderReadme(info: PainelInfo): string {
  const contagens = (["reunioes", "conversas", "documentos", "anotacoes"] as const)
    .filter((k) => (info.porPasta[k] ?? 0) > 0)
    .map((k) => `${info.porPasta[k]} ${PLURAL[k][info.porPasta[k] === 1 ? 0 : 1]}`);
  if (info.dossies.length) contagens.push(`${info.dossies.length} dossiê${info.dossies.length === 1 ? "" : "s"}`);

  const linhas = [
    `# Memória do negócio — ${info.brain}`,
    "",
    "Este repositório é o espelho legível do cérebro no Galeed.",
    "",
    contagens.length ? `**O que tem aqui:** ${contagens.join(" · ")}` : "_O cérebro ainda não tem memórias espelhadas._",
    "",
    "## Como usar",
    "",
    "- Navegue pelas pastas — cada memória é um arquivo com data e título.",
    "- `conhecimento/` tem um dossiê por pessoa, empresa ou assunto.",
    "- **`entrada/` é sua**: solte arquivos .md/.txt/.csv/.pdf e o Galeed transforma em memória.",
    "  Quando o arquivo some da entrada, ele virou memória. Se ficou, ainda está processando (ou deu erro).",
    "- Todo o resto é gerado pelo Galeed a cada sincronização — edições fora de `entrada/` são sobrescritas.",
    "",
  ];
  if (info.dossies.length) {
    linhas.push("## Sobre quem o cérebro mais sabe", "");
    for (const d of info.dossies)
      linhas.push(`- [${d.entity}](${encodeGh(d.path)}) — ${d.n} fato${d.n === 1 ? "" : "s"}`);
    if (info.capEntidades) linhas.push("", "_Mostrando os 200 maiores dossiês._");
    linhas.push("");
  }
  if (info.recentes.length) {
    linhas.push("## Últimas memórias", "");
    for (const r of info.recentes)
      linhas.push(`- ${r.data} — [${r.titulo}](${encodeGh(r.path)})`);
    linhas.push("");
  }
  if (info.retidas > 0) {
    linhas.push(
      info.retidas === 1
        ? "_1 memória não está neste espelho por causa do filtro de sigilo (Ajustes → GitHub do cérebro)._"
        : `_${info.retidas} memórias não estão neste espelho por causa do filtro de sigilo (Ajustes → GitHub do cérebro)._`,
      "",
    );
  }
  return linhas.join("\n");
}

export const LEIA_ME_ENTRADA = `# Entrada — solte arquivos aqui

O Galeed lê esta pasta a cada ~2 minutos e transforma em memória o que você soltar.

- Formatos aceitos: .md, .txt, .csv, .tsv, .pdf (até 25 MB).
- Quando o arquivo **some** daqui, ele virou memória (aparece nas pastas do espelho na sincronização seguinte).
- Se o arquivo **ficou**, ou ainda está processando, ou o formato não é aceito, ou deu erro (veja Ajustes → GitHub do cérebro).
- Dica: solte em subpastas pra classificar — \`entrada/reunioes/ata.md\` entra como reunião; \`entrada/conversas/...\` como conversa.
`;

/** primeiro commit de repo VAZIO (Contents API) — o README de verdade vem no commit do sync. */
const README_BOOTSTRAP = "# Memória do negócio — espelho do Galeed\n\nPrimeira sincronização em andamento…\n";

// ---------- plano de sync (PURO): espelho FIEL, não só acumulativo ----------
// As pastas gerenciadas são regeneradas por inteiro: o que sumiu do cérebro SOME do espelho
// (página apagada, sigilo elevado). memoria/ legada entra só pra migração (deletar a árvore
// antiga). entrada/ é do usuário — NUNCA entra em deleção em massa; a remoção pontual de
// arquivo ingerido chega via removerExtra (dirigida pelo job 'done', ver syncIn).

const PREFIXOS_GERENCIADOS = ["conhecimento/", "reunioes/", "conversas/", "documentos/", "anotacoes/", "memoria/"];
const ARQUIVOS_GERENCIADOS = new Set(["README.md", "entrada/LEIA-ME.md"]);

export function ehGerenciado(path: string): boolean {
  return ARQUIVOS_GERENCIADOS.has(path) || PREFIXOS_GERENCIADOS.some((pref) => path.startsWith(pref));
}

export interface PlanoSync { subir: { path: string; content: string }[]; apagar: string[] }

export function planoDeSync(
  desejados: Map<string, string>,
  remotos: Map<string, string>,
  removerExtra: string[] = [],
): PlanoSync {
  const subir = [...desejados]
    .filter(([p, c]) => remotos.get(p) !== gitBlobSha(c))
    .map(([path, content]) => ({ path, content }));
  const apagar = new Set([...remotos.keys()].filter((p) => ehGerenciado(p) && !desejados.has(p)));
  for (const p of removerExtra) if (remotos.has(p) && !desejados.has(p)) apagar.add(p);
  return { subir, apagar: [...apagar].sort() };
}

export function mensagemDeCommit(plano: PlanoSync, remotos: Map<string, string>, entradaRemovidos: number): string {
  const novas = plano.subir.filter((s) => !remotos.has(s.path) && s.path.split("/")[0] in PLURAL);
  const porPasta = new Map<string, number>();
  for (const s of novas) {
    const pasta = s.path.split("/")[0];
    porPasta.set(pasta, (porPasta.get(pasta) ?? 0) + 1);
  }
  const partes: string[] = [];
  if (novas.length) {
    const detal = [...porPasta].map(([pasta, n]) => `${n} ${PLURAL[pasta][n === 1 ? 0 : 1]}`).join(", ");
    partes.push(`${novas.length} memória${novas.length === 1 ? " nova" : "s novas"} (${detal})`);
  }
  const atualizados = plano.subir.length - novas.length;
  if (atualizados) partes.push(`${atualizados} atualizado${atualizados === 1 ? "" : "s"}`);
  if (plano.apagar.length) partes.push(`${plano.apagar.length} removido${plano.apagar.length === 1 ? "" : "s"}`);
  if (entradaRemovidos) partes.push(`entrada: ${entradaRemovidos} ingerido${entradaRemovidos === 1 ? "" : "s"}`);
  return `galeed: ${partes.join(" · ") || "sync"}`;
}

// ---------- sync de SAÍDA (cérebro → GitHub, 1 commit por rodada, espelho FIEL) ----------

export interface SyncOutResult { enviados: number; removidos: number; retidas: number; commit: string | null }

/** quantas páginas ficam FORA do espelho pelo filtro de sigilo (transparência na UI/README). */
export async function contarRetidas(brain: string, sigiloMax: string): Promise<number> {
  const sql = await db();
  const cap = sensitivityRank(sigiloMax);
  const rows = (await sql`
    select count(*)::int as n from galeed_pages where brain = ${brain}
      and (case coalesce(nullif(sensitivity, ''), 'restrito')
           when 'publico' then 0 when 'interno' then 1 when 'sensivel' then 2 else 3 end) > ${cap}`) as any[];
  return rows[0]?.n ?? 0;
}

export async function syncOut(cfg: GithubConfig, removerEntrada: string[] = []): Promise<SyncOutResult> {
  const e = await getEngine(cfg.brain);
  const todas = await e.allPages();
  const paginas = todas.filter((p) => sensitivityRank(p.sensitivity) <= sensitivityRank(cfg.sigiloMax));
  const retidas = todas.length - paginas.length;

  // dossiês: entidades com fatos (cap 200 — repo legível, não dump infinito; o cap vira nota no README)
  const sql = await db();
  const ents = (await sql`
    select entity, count(*) as n from galeed_facts
     where brain = ${cfg.brain} and entity <> '' group by entity order by n desc, entity asc limit 200`) as any[];

  const desejados = new Map<string, string>();
  desejados.set("entrada/LEIA-ME.md", LEIA_ME_ENTRADA);
  const caminhos = caminhosDePaginas(paginas);
  for (const [path, p] of caminhos) desejados.set(path, renderPagina(p, path).content);

  // dossiês respeitam o teto de sigilo: fora do nível 'restrito' (tudo), só entram fatos cuja
  // página de origem está espelhada (source_slug ∈ páginas permitidas).
  const filtraSigilo = sensitivityRank(cfg.sigiloMax) < sensitivityRank("restrito");
  const permitidas = filtraSigilo ? new Set(paginas.map((p) => p.slug)) : null;
  const dossiesPainel: PainelInfo["dossies"] = [];
  for (const r of ents) {
    const entity = String(r.entity);
    let fatos = await timeline(cfg.brain, entity).catch(() => [] as any[]);
    if (permitidas && Array.isArray(fatos))
      fatos = fatos.filter((f: any) => !f.source_slug || permitidas.has(f.source_slug));
    if (Array.isArray(fatos) && fatos.length) {
      const { path, content } = renderDossie(entity, fatos as any[]);
      desejados.set(path, content);
      dossiesPainel.push({ entity, n: Number(r.n), path });
    }
  }

  // README painel — derivado só dos dados (determinístico: re-sync ocioso = zero commit)
  const porPasta: Record<string, number> = { reunioes: 0, conversas: 0, documentos: 0, anotacoes: 0 };
  for (const path of caminhos.keys()) {
    const pasta = path.split("/")[0];
    porPasta[pasta] = (porPasta[pasta] ?? 0) + 1;
  }
  const chaveData = (d: string) => (/^\d{4}-\d{2}-\d{2}/.test(d) ? d : ""); // sem-data por último
  const recentes = [...caminhos]
    .map(([path, p]) => ({ titulo: p.title || p.slug, data: p.date?.slice(0, 10) || "sem data", path }))
    .sort((a, b) => chaveData(b.data).localeCompare(chaveData(a.data)) || a.path.localeCompare(b.path))
    .slice(0, 10);
  desejados.set("README.md", renderReadme({
    brain: cfg.brain, totalPaginas: paginas.length, retidas,
    capEntidades: ents.length === 200,
    porPasta, dossies: dossiesPainel.slice(0, 10), recentes,
  }));

  // head atual. Repo 100% VAZIO nem aceita a Git Data API (blobs → 409): o bootstrap é criar o
  // README via Contents API (funciona em repo vazio e cria o commit inicial) e seguir o fluxo normal.
  let ref = await gh(cfg, "GET", `/repos/${cfg.owner}/${cfg.repo}/git/ref/heads/${cfg.branch}`);
  if (!ref) {
    await gh(cfg, "PUT", `/repos/${cfg.owner}/${cfg.repo}/contents/README.md`, {
      message: "galeed: início do espelho",
      content: Buffer.from(README_BOOTSTRAP, "utf8").toString("base64"),
      branch: cfg.branch,
    });
    ref = await gh(cfg, "GET", `/repos/${cfg.owner}/${cfg.repo}/git/ref/heads/${cfg.branch}`);
  }
  let baseTree: string | undefined;
  let parent: string | undefined;
  const remotos = new Map<string, string>(); // path → blob sha
  if (ref) {
    parent = ref.object.sha as string;
    const commit = await gh(cfg, "GET", `/repos/${cfg.owner}/${cfg.repo}/git/commits/${parent}`);
    baseTree = commit.tree.sha as string;
    const tree = await gh(cfg, "GET", `/repos/${cfg.owner}/${cfg.repo}/git/trees/${baseTree}?recursive=1`);
    for (const t of tree?.tree ?? []) if (t.type === "blob") remotos.set(t.path, t.sha);
  }

  // plano: sobe o que mudou, APAGA o gerenciado órfão (migração da memoria/ inclusa) e os
  // arquivos da entrada/ já ingeridos (job done). Deleção = tree entry com sha null sobre base_tree.
  const plano = planoDeSync(desejados, remotos, removerEntrada);
  if (!plano.subir.length && !plano.apagar.length) return { enviados: 0, removidos: 0, retidas, commit: null };

  const entries: { path: string; mode: string; type: string; sha: string | null }[] = [];
  for (const m of plano.subir) {
    const blob = await gh(cfg, "POST", `/repos/${cfg.owner}/${cfg.repo}/git/blobs`, {
      content: Buffer.from(m.content, "utf8").toString("base64"),
      encoding: "base64",
    });
    entries.push({ path: m.path, mode: "100644", type: "blob", sha: blob.sha });
  }
  for (const p of plano.apagar) entries.push({ path: p, mode: "100644", type: "blob", sha: null });
  const novaTree = await gh(cfg, "POST", `/repos/${cfg.owner}/${cfg.repo}/git/trees`, {
    ...(baseTree ? { base_tree: baseTree } : {}),
    tree: entries,
  });
  const commit = await gh(cfg, "POST", `/repos/${cfg.owner}/${cfg.repo}/git/commits`, {
    message: mensagemDeCommit(plano, remotos, removerEntrada.length),
    tree: novaTree.sha,
    ...(parent ? { parents: [parent] } : {}),
  });
  if (ref) {
    await gh(cfg, "PATCH", `/repos/${cfg.owner}/${cfg.repo}/git/refs/heads/${cfg.branch}`, { sha: commit.sha });
  } else {
    await gh(cfg, "POST", `/repos/${cfg.owner}/${cfg.repo}/git/refs`, { ref: `refs/heads/${cfg.branch}`, sha: commit.sha });
  }
  return { enviados: plano.subir.length, removidos: plano.apagar.length, retidas, commit: commit.sha as string };
}

// ---------- sync de ENTRADA (GitHub → fila de ingestão, diff por sha) ----------

export interface SyncInResult { ingeridos: number; jobs: string[]; remover: string[] }

/** subpasta da entrada/ como dica de origem: entrada/reunioes/ata.md → canal reuniao. */
export function hintDeEntrada(path: string): string | undefined {
  const seg = path.split("/");
  if (seg.length < 3) return undefined; // arquivo na raiz da entrada — sem hint
  return ({ reunioes: "reuniao", reuniao: "reuniao", conversas: "chat", conversa: "chat" } as Record<string, string>)[seg[1]];
}

export async function syncIn(cfg: GithubConfig): Promise<SyncInResult> {
  const out: SyncInResult = { ingeridos: 0, jobs: [], remover: [] };
  const ref = await gh(cfg, "GET", `/repos/${cfg.owner}/${cfg.repo}/git/ref/heads/${cfg.branch}`);
  if (!ref) return out; // repo vazio — nada a ingerir
  const commit = await gh(cfg, "GET", `/repos/${cfg.owner}/${cfg.repo}/git/commits/${ref.object.sha}`);
  const tree = await gh(cfg, "GET", `/repos/${cfg.owner}/${cfg.repo}/git/trees/${commit.tree.sha}?recursive=1`);
  const sql = await db();
  const fontesGarantidas = new Set<string>(); // upsert da fonte-hint 1x por rodada
  const naArvore = new Set<string>();

  for (const t of tree?.tree ?? []) {
    if (t.type !== "blob" || !String(t.path).startsWith("entrada/")) continue;
    if (t.path === "entrada/LEIA-ME.md") continue; // nosso — não se auto-ingere
    naArvore.add(String(t.path));
    const nome = String(t.path).split("/").pop() ?? "";
    const ext = nome.includes(".") ? nome.slice(nome.lastIndexOf(".")).toLowerCase() : "";
    if (!ENTRADA_EXT.has(ext)) continue; // formato não aceito: fica lá (nunca apagamos o que não processamos)
    if (typeof t.size === "number" && t.size > MAX_ENTRADA_BYTES) continue;

    const visto = (await sql`
      select gh_sha, job_id from galeed_github_entrada where brain = ${cfg.brain} and path = ${t.path} limit 1`) as any[];
    // sem mudança E com job rastreado → nada a fazer. Registro LEGADO (sem job_id, gravado antes
    // da remoção pós-done existir) cai pro fluxo normal: o dedupe por hash acha o job existente
    // e faz o backfill do job_id SEM re-ingerir — aí a remoção volta a funcionar.
    if (visto.length && visto[0].gh_sha === t.sha && visto[0].job_id) continue;

    const blob = await gh(cfg, "GET", `/repos/${cfg.owner}/${cfg.repo}/git/blobs/${t.sha}`);
    const buffer = Buffer.from(String(blob.content ?? ""), "base64");
    const kind = detectDocKind(undefined, nome);
    if (!["pdf", "csv", "tsv", "markdown", "text"].includes(kind)) continue;

    // dica de origem pela subpasta (a página nasce com canal:reuniao/chat e cai na pasta certa
    // do espelho) — a fonte é um registro fixo por canal, criado sob demanda.
    let sourceId: string | undefined;
    const hint = hintDeEntrada(String(t.path));
    if (hint) {
      sourceId = `github-entrada-${hint}`;
      if (!fontesGarantidas.has(sourceId)) {
        const e = await getEngine(cfg.brain);
        await e.upsertSource({
          id: sourceId, name: `Entrada GitHub — ${hint === "reuniao" ? "reuniões" : "conversas"}`,
          channel: hint, type: "", recipe: { fields: [] }, default_sensitivity: "restrito", status: "ativa",
        } as any);
        fontesGarantidas.add(sourceId);
      }
    }

    const docHash = createHash("sha256").update(buffer).digest("hex").slice(0, 16);
    const dup = (await sql`
      select id from galeed_ingest_jobs
       where brain = ${cfg.brain} and content_hash = ${docHash} and status not in ('error','dead')
       limit 1`) as any[];
    let jobId: string;
    if (dup.length) {
      jobId = String(dup[0].id); // conteúdo já conhecido — o arquivo aponta pro job existente
    } else {
      await putBlobOnly(cfg.brain, buffer, { filename: nome, source: "github" });
      ({ jobId } = await enqueueIngestJob({
        brain: cfg.brain, kind: "file", type: "documento",
        contentHash: docHash, filename: nome, title: nome, sourceId,
      }));
      out.ingeridos++;
      out.jobs.push(jobId);
    }
    await sql`
      insert into galeed_github_entrada (brain, path, gh_sha, doc_hash, job_id)
      values (${cfg.brain}, ${t.path}, ${t.sha}, ${docHash}, ${jobId})
      on conflict (brain, path) do update set
        gh_sha = excluded.gh_sha, doc_hash = excluded.doc_hash, job_id = excluded.job_id, ingested_at = now()`;
  }

  // ENTRADA LIMPA: arquivo cujo job CONCLUIU sai do repo no commit desta rodada.
  // "sumiu = virou memória; ficou = processando ou erro" — falha nunca é silenciosa.
  const prontos = (await sql`
    select e.path from galeed_github_entrada e
      join galeed_ingest_jobs j on j.id = e.job_id
     where e.brain = ${cfg.brain} and j.status = 'done'`) as any[];
  out.remover = prontos.map((r: any) => String(r.path)).filter((p: string) => naArvore.has(p));
  return out;
}

// ---------- rodada completa (o worker chama; a UI dispara manual) ----------

export interface GithubSyncSummary {
  brain: string;
  entradaIngeridos: number;
  entradaRemovidos: number;
  espelhoEnviados: number;
  espelhoRemovidos: number;
  retidas: number;
  commit: string | null;
  erro: string | null;
}

export async function runGithubSync(brain?: string): Promise<GithubSyncSummary[]> {
  const configs = brain
    ? [await getGithubConfig(brain)].filter((c): c is GithubConfig => !!c && c.enabled)
    : await listEnabledGithubConfigs();
  const sql = await db();
  const out: GithubSyncSummary[] = [];
  for (const cfg of configs) {
    const s: GithubSyncSummary = {
      brain: cfg.brain, entradaIngeridos: 0, entradaRemovidos: 0,
      espelhoEnviados: 0, espelhoRemovidos: 0, retidas: 0, commit: null, erro: null,
    };
    try {
      const inn = await syncIn(cfg); // entrada PRIMEIRO (o que o usuário soltou vira memória já nesta rodada… na próxima sync sai no espelho)
      s.entradaIngeridos = inn.ingeridos;
      s.entradaRemovidos = inn.remover.length;
      const outt = await syncOut(cfg, inn.remover);
      s.espelhoEnviados = outt.enviados;
      s.espelhoRemovidos = Math.max(0, outt.removidos - inn.remover.length); // só os do espelho (entrada contada à parte)
      s.retidas = outt.retidas;
      s.commit = outt.commit;
      await sql`update galeed_github_sync set last_sync_at = now(), last_commit = coalesce(${s.commit}, last_commit), last_error = null where brain = ${cfg.brain}`;
    } catch (err) {
      s.erro = err instanceof Error ? err.message : String(err);
      await sql`update galeed_github_sync set last_error = ${s.erro} where brain = ${cfg.brain}`.catch(() => {});
    }
    out.push(s);
  }
  return out;
}
