#!/usr/bin/env -S npx tsx
/** galeed — memória para agentes de IA. CLI agnóstico ao runtime.
 *  Núcleo do contrato: `galeed <comando> [--brain <path>] [--json]`. */
import { readFileSync } from "node:fs";
// Config é env-driven (DATABASE_URL, ANTHROPIC_*, OPENAI_*). Carrega .env se existir
// (Node 22.5+ nativo). Sem .env, segue só com o ambiente do processo.
try {
  process.loadEnvFile();
} catch {
  /* sem .env: ok, usa process.env */
}
import { brainHome } from "./core/platform/brain.ts";
import { config } from "./core/platform/config.ts";
import { capture } from "./core/ingestion/capture.ts";
import { extractOne, isFresh } from "./core/extraction/extract.ts";
import { buildIndex } from "./core/retrieval/indexer.ts";
import { search, retrieve, retrieveExplained, getPage, facts, timeline, graph, stats, seloHeader, factSeloHeader } from "./core/retrieval/query.ts";
import { ask } from "./core/retrieval/ask.ts";
import { resolveProvider } from "./lib/llm.ts";
import { buildEmbeddings } from "./core/retrieval/embeddings.ts";
import { getEngine, closeEngines } from "./core/platform/engine.ts";
import { hasOpenAIKey } from "./lib/openai.ts";
import { dream, prune, verify, consolidateCold } from "./core/memory/sleep.ts";
import { dreamV2 } from "./core/memory/dream-v2.ts";
import { shedCold, restoreCold } from "./core/memory/tiering.ts";
import { sustainabilityReport, formatSustainability } from "./core/memory/sustainability.ts";
import { reconcile } from "./core/memory/reconcile.ts";
import { resolveEntities, graphQuery } from "./core/memory/entities.ts";
import { findContradictions, listContradictions } from "./core/memory/contradict.ts";
import { addGolden, seedGolden, runEval, evalReport } from "./core/memory/evalq.ts";
import { buildSemanticLinks } from "./core/memory/link.ts";
import { reflect } from "./core/memory/reflect.ts";
import { runSonoCycle } from "./core/ingestion/sono-step.ts"; // M24-D — sono = MESMO ciclo (manual+automático)
import { tagVocab } from "./core/ingestion/tags.ts";
import {
  cmdPrincipalAdd, cmdGrant, cmdTokenIssue, cmdTokenRevoke, cmdPrincipalStatus,
  cmdAreaAttach, cmdAreaDetach, cmdSensitivitySet, cmdAccessTest, cmdAccessLog,
} from "./core/access/access-cli.ts";

const HELP = `🧠 galeed — a memória do seu negócio (Postgres + CLI)

USO: galeed <comando> [args] [--brain <tenant>] [--json]
Config via ambiente: DATABASE_URL (Postgres+pgvector), GALEED_BRAIN (tenant), OPENAI_API_KEY (semântica).

ESCRITA
  init                          garante o schema no Postgres e testa a conexão
  capture [--type T] [--source S]  texto -> fonte no banco. SEM --type, o cérebro CLASSIFICA
                                sozinho (ingestão autônoma). --from <arquivo> | stdin. --source = origem.
  pasta --dir <pasta> [--type T] [--interval S] [--once]   vigia uma PASTA local e ingere
                                arquivo novo/alterado (pdf/md/txt/csv) pela fila assíncrona.
                                Drive/OneDrive/Dropbox: sincronize pro disco e aponte pra pasta.
  ingestor list                 ingestores registrados (webhooks POST /v1/ingestors/<slug>)
  ingestor test <slug> --from payload.json [--entregar]   roda o middleware localmente
                                (dry-run imprime os itens; --entregar ingere de verdade)
  extract <slug | --all>        destila fonte -> fatos tipados (usa LLM)
  organize [--no-embeddings]    deriva fatos bitemporais + grafo + embeddings (alias: index)
  embed                         (re)gera só os embeddings que faltam (precisa OPENAI_API_KEY)
  link [--threshold T] [--topk N]  cria arestas SEMÂNTICAS no grafo (páginas parecidas, via vetor)
  schema scaffold-extractable <type> --pack <pack.json> [--force]   gera prompt+fixtures de extração
                                p/ um tipo novo do tenant (extração genérica por domínio, sem code change)
  extract benchmark --type T --corpus <fix.jsonl> [--min-recall N] [--against <baseline.json>]
                                GATE de extração: golden + piso de recall (exit 1 se FAIL). Não suja o brain.
  extract regress --type T --corpus <fix.jsonl> --against <baseline.json> [--threshold N]
                                falha se o recall por dim cair além do threshold vs o baseline salvo
  extract receipts [--limit N]  custo acumulado da extração no brain (rollup $ + por run) — fundação de pricing

LEITURA (o que o agente usa)
  search "<q>" [--type T]       busca FTS (palavra-chave) -> hits
  retrieve "<q>" [-k N]         contexto + citações p/ o AGENTE  ← HÍBRIDO (semântico+FTS)
  ask "<q>"                     síntese feita pelo cérebro + lacunas (precisa chave)  ← modo não-LLM
  get <slug>                    devolve a página
  facts <dimensao> [--type T]   agrega fatos tipados (ex: facts objections)
                                [--as-of DATA] o que era verdade em DATA · [--current] só vigentes
  timeline <entidade> [--pred P] linha do tempo bitemporal (como o cérebro mudou de ideia)
  graph <slug>                  vizinhos no grafo (wikilinks)
  tags                          vocabulário vivo de tags semânticas (frequência por brain)
  stats                         contagens do cérebro
  doctor                        saúde do cérebro (engine, conexão, contagens, semântica)

SONO (TEMPO 2 — aprende offline)
  sleep                         dorme (ciclo M24): consolida + detecta sinais + sonha + verbaliza percepções + varre stale + poda
                                (poda AUTO conservadora: arquiva+resfria só lixo genuíno — órfã, 0 fatos, > GALEED_SONO_PRUNE_OLDER_DIAS
                                 dias, default 180; GALEED_SONO_PRUNE_APPLY=0 volta ao dry-run)
  reconcile [--llm]             canonicaliza predicados sinônimos (preco_mensal≡valor_mensalidade)
  resolve-entities [--llm]      funde entidades duplicadas (acme≡acme corp) — canonicaliza o sujeito
  graph-query <nó> [--pred P]   conexões tipadas de uma entidade no grafo (quem se liga a ela, como)
  contradictions [--run] [--llm]  lista (ou detecta com --run) fatos conflitantes da mesma entidade
  eval add "<q>" --expect a,b    registra query-ouro · eval run [-k N] mede P@k/recall/MRR · eval report
  reflect [--force] [--min N]   REFLETE sobre o lote novo → APRENDIZADOS citados (usa LLM barato/Haiku)
  dream [--min N] [--top K] [--dry-run]  SONHO v2: link-prediction (Adamic-Adar+RA) no grafo de ENTIDADES → hipóteses na fila de revisão
  verify [--apply]              re-checa hipóteses por recorrência (confirma/enfraquece/arquiva)
  prune [--older AAAA-MM-DD] [--apply]  lista (ou arquiva c/ --apply) memória esquecível
  consolidate [--older DATA] [--llm]  resume entidades frias numa página antes de arquivar (envelhecer bem)
  shed [--apply]                descarta vetores do frio (arquivado→cold; regenerável). dry-run sem --apply
  restore <slug>                traz uma página fria OU arquivada de volta (desarquiva + tier hot + re-embeda do body)
  sustainability [--dims N]     peso/custo da memória: páginas hot/cold, vetores, bytes estimados, cold%

ACESSO & GOVERNANÇA (M7 — quem vê o quê)
  principal add <id> --kind=human|agent [--label=...] [--email=...]   registra um principal
  principal disable|enable <id> alterna o status do principal (corta/restaura acesso)
  grant <principalId> --areas=a,b --max=<nivel> [--deny=t1,t2]        define o escopo do principal
  token issue <principalId> [--label=...]   emite token de acesso — mostra o token CRU UMA vez
  token revoke <tokenHashOuCru>             revoga um token (aceita o cru gal_… ou o hash)
  area attach|detach <slug> --area=<x>      classifica uma página numa área de conhecimento
  sensitivity set <slug> --level=<nivel>    define a sensibilidade (publico|interno|sensivel|restrito)
  access-test <principalId>     preview: o que ESTE principal enxerga (áreas + nº de páginas)
  access-log [--principal=<id>] [--limit=N] trilha de auditoria (quem perguntou o quê)

Toda saída aceita --json (stdout limpo; logs vão pra stderr).`;

function parseArgs(argv: string[]) {
  const pos: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const body = a.slice(2);
      const eq = body.indexOf("=");
      if (eq !== -1) {
        // forma --chave=valor (idem ao --chave valor). Aceita = vazio (--chave=) → string vazia.
        flags[body.slice(0, eq)] = body.slice(eq + 1);
        continue;
      }
      const key = body;
      const nxt = argv[i + 1];
      if (nxt !== undefined && !nxt.startsWith("--")) {
        flags[key] = nxt;
        i++;
      } else flags[key] = true;
    } else if (a.startsWith("-") && a.length === 2) {
      const nxt = argv[i + 1];
      flags[a.slice(1)] = nxt ?? true;
      if (nxt) i++;
    } else pos.push(a);
  }
  return { pos, flags };
}

function emit(json: boolean, data: any, human: () => void) {
  if (json) process.stdout.write(JSON.stringify(data, null, 2) + "\n");
  else human();
}

function stdin(): Promise<string> {
  return new Promise((res) => {
    if (process.stdin.isTTY) return res("");
    let d = "";
    process.stdin.on("data", (c) => (d += c));
    process.stdin.on("end", () => res(d));
  });
}

async function main() {
  const { pos, flags } = parseArgs(process.argv.slice(2));
  const cmd = pos[0];
  const json = !!flags.json;
  const home = brainHome(flags.brain as string | undefined);
  const need = () => {
    if (!(process.env.DATABASE_URL || process.env.GALEED_DB_URL || process.env.SUPABASE_DB_URL)) {
      console.error("DATABASE_URL não definida. Dev: `docker compose up -d` e copie .env.example → .env. Prod: a string do Supabase.");
      process.exit(1);
    }
  };
  const q = pos.slice(1).join(" ");

  switch (cmd) {
    case "init": {
      // DB-native: "init" garante o schema no Postgres (ensureSchema roda no open).
      const e = await getEngine(home);
      const s = await e.stats();
      emit(json, { ok: true, brain: home, engine: e.name, stats: s }, () =>
        console.log(`🧠 Galeed pronto (engine: ${e.name}, brain: ${home}) · ${s.pages} páginas`),
      );
      break;
    }
    case "capture": {
      need();
      // --from de DOC (pdf/csv/tsv): extrai+fatia+captura N páginas. .md/.txt e stdin seguem o fluxo simples.
      const from = flags.from as string | undefined;
      if (from && !/\.(md|markdown|txt)$/i.test(from)) {
        const { ingestDocument } = await import("./core/ingestion/ingest-doc.ts");
        const r = await ingestDocument({ home, buffer: readFileSync(from), filename: from, type: flags.type as string, source: "upload" });
        await buildIndex(home);
        emit(json, r, () => console.log(`📄 ${r.kind}: ${r.total} páginas (${r.skipped} idempotentes) — doc:${r.docHash}`));
        break;
      }
      const text = from ? readFileSync(from, "utf8") : await stdin();
      if (!text.trim()) {
        console.error("Nada para capturar (passe --from <arquivo> ou texto via stdin).");
        process.exit(1);
      }
      const r = await capture({
        home,
        text,
        type: flags.type as string, // opcional: sem ele, classifica sozinho
        title: flags.title as string, // opcional
        date: flags.date as string,
        source: flags.source as string,
        tags: flags.tags ? String(flags.tags).split(",") : [],
        people: flags.people ? String(flags.people).split(",") : [],
      });
      emit(json, r, () =>
        console.log(r.skipped ? `· ${r.slug} (idempotente)` : r.auto ? `📝 ${r.slug}  (auto: ${r.type}${r.confident ? "" : " · baixa confiança→sono"} · ${r.signals?.join(",")})` : `📝 ${r.slug}`),
      );
      break;
    }
    case "ingestor": {
      // DX pro aluno (INGESTORES.md): desenvolve/testa o normalize() SEM subir gateway.
      //   galeed ingestor list                          → registrados
      //   galeed ingestor test <slug> --from p.json     → roda o middleware e imprime os itens (dry-run)
      //   galeed ingestor test <slug> --from p.json --entregar   → entrega DE VERDADE no brain
      const { registerBuiltinIngestors } = await import("./core/ingestion/ingestors/boot.ts");
      const { getIngestor, listIngestors } = await import("./core/ingestion/ingestors/registry.ts");
      registerBuiltinIngestors();
      const sub = pos[1];
      if (sub === "list" || !sub) {
        const lista = listIngestors();
        emit(json, { ingestors: lista }, () => {
          for (const i of lista) console.log(`• ${i.slug.padEnd(20)} ${i.nome} — ${i.descricao}`);
          console.log(`\nWebhook: POST /v1/ingestors/<slug> · teste local: galeed ingestor test <slug> --from payload.json`);
        });
        break;
      }
      if (sub === "test") {
        const slug = pos[2];
        const ing = slug ? getIngestor(slug) : undefined;
        if (!ing) {
          console.error(`ingestor "${slug ?? ""}" não existe. Disponíveis: ${listIngestors().map((i) => i.slug).join(", ")}`);
          process.exit(1);
        }
        const from = flags.from as string | undefined;
        const raw = from ? readFileSync(from, "utf8") : await stdin();
        if (!raw.trim()) {
          console.error("Passe o payload: --from payload.json (ou via stdin).");
          process.exit(1);
        }
        let payload: unknown;
        try {
          payload = JSON.parse(raw);
        } catch (e) {
          console.error(`payload não é JSON válido: ${e instanceof Error ? e.message : e}`);
          process.exit(1);
        }
        if (flags.entregar) {
          need();
          const { deliverIngestorWebhook } = await import("./core/ingestion/ingestors/deliver.ts");
          const r = await deliverIngestorWebhook(home, ing, payload);
          emit(json, r, () =>
            console.log(`✅ ${r.recebidos} item(ns): ${r.enfileirados} na fila · ${r.aplicados} claims aplicados · ${r.dedupados} dedupados${r.erros.length ? ` · erros: ${r.erros.join(" | ")}` : ""}`));
          break;
        }
        // dry-run PURO: mostra exatamente o que o middleware produziria (nada toca o banco).
        const itens = ing.normalize(payload, { brain: home, sourceId: "(dry-run)", slug: ing.slug });
        emit(json, { itens }, () => {
          if (!itens.length) return console.log("(evento ignorado — normalize devolveu [])");
          itens.forEach((it, i) => {
            console.log(`\n── item ${i + 1}/${itens.length} ─ ref=${it.externalRef} ─ ${it.timestamp}`);
            if (it.claims?.length) console.log(`   claims determinísticos: ${it.claims.length}`);
            console.log(it.content.split("\n").map((l) => `   ${l}`).join("\n"));
          });
          console.log(`\n(dry-run: nada foi ingerido — use --entregar pra valer)`);
        });
        break;
      }
      console.error(`subcomando desconhecido: "${sub}". Use: galeed ingestor list | test <slug> --from payload.json [--entregar]`);
      process.exit(1);
      break;
    }
    case "pasta": {
      // INGESTOR DE PASTA LOCAL (ver INGESTORES.md): vigia --dir e enfileira arquivo novo/alterado.
      // O worker (npm run worker / docker profile app) precisa estar rodando pra fila andar.
      need();
      const dir = flags.dir as string | undefined;
      if (!dir) {
        console.error("Diga a pasta: galeed pasta --dir <caminho> [--type documento] [--interval 30] [--once]");
        process.exit(1);
      }
      const { runPastaWatcher } = await import("./connectors/pasta-watcher.ts");
      await runPastaWatcher({
        brain: home,
        dir,
        type: (flags.type as string) || "documento",
        intervalMs: Math.max(5, Number(flags.interval) || 30) * 1000,
        once: !!flags.once,
      });
      break;
    }
    case "extract": {
      need();
      // M9/S5 — subcomandos do gate/custo (zona neutra: Integrador plugou). Interceptam ANTES do extract LLM.
      if (pos[1] === "benchmark") {
        const { extractBenchmarkCli } = await import("./core/extraction/extract-benchmark.ts");
        const r = await extractBenchmarkCli({
          brain: home,
          type: flags.type as string,
          corpus: flags.corpus as string,
          minRecall: flags["min-recall"] !== undefined ? Number(flags["min-recall"]) : undefined,
          baseline: flags.against as string, // --against baseline.json → vira regress internamente
        });
        console.log(r.text);
        process.exit(r.code); // 0 PASS / 1 FAIL / 2 USAGE
      }
      if (pos[1] === "regress") {
        const { runRegress } = await import("./core/extraction/extract-benchmark.ts");
        const r = await runRegress({
          home,
          type: flags.type as string,
          fixturePath: flags.corpus as string,
          baselinePath: flags.against as string,
          threshold: flags.threshold !== undefined ? Number(flags.threshold) : undefined,
        });
        console.log(r.text);
        process.exit(r.ok ? 0 : 1);
      }
      if (pos[1] === "receipts") {
        const { extractReceiptsCli } = await import("./core/extraction/extract-receipt.ts");
        const r = await extractReceiptsCli({ brain: home, limit: flags.limit !== undefined ? Number(flags.limit) : undefined });
        console.log(r.text);
        process.exit(r.code);
      }
      const prov = resolveProvider(config(home).provider);
      console.error(`(provider: ${prov})`);
      const e = await getEngine(home);
      const all = await e.allPages();
      const targets = flags.all ? all : all.filter((p) => p.slug === pos[1]);
      if (!flags.all && !targets.length) console.error(`✗ fonte não encontrada: ${pos[1]}`);
      const res: any[] = [];
      for (const page of targets) {
        if (!flags.force && (await isFresh(home, page))) {
          console.error(`· ${page.slug} (cache)`);
          continue;
        }
        try {
          res.push(await extractOne(home, page));
          console.error(`✓ ${page.slug}`);
        } catch (err) {
          console.error(`✗ ${page.slug}: ${(err as Error).message}`);
        }
      }
      emit(json, { provider: prov, extracted: res.length, res }, () => console.log(`🔬 ${res.length} extrações (via ${prov})`));
      break;
    }
    case "index":
    case "organize": {
      need();
      const r = await buildIndex(home);
      let emb: any = { skipped: "--no-embeddings" };
      if (!flags["no-embeddings"]) emb = await buildEmbeddings(home, (s) => console.error(s));
      emit(json, { ...r, embeddings: emb }, () => {
        console.log(`🗂️  ${r.pages} páginas · ${r.facts} fatos (${r.bitemporal} bitemporais) · ${r.edges} links`);
        if (emb.skipped) console.log(`   (semântica: ${emb.skipped})`);
        else console.log(`   🧬 embeddings: ${emb.embedded} novos, ${emb.reused} reusados (${emb.model})`);
      });
      break;
    }
    case "embed": {
      need();
      const emb = await buildEmbeddings(home, (s) => console.error(s));
      emit(json, emb, () =>
        emb.skipped ? console.log(`(pulado: ${emb.skipped})`) : console.log(`🧬 ${emb.embedded} novos · ${emb.reused} reusados · ${emb.pruned} órfãos removidos (${emb.model})`),
      );
      break;
    }
    case "link": {
      need();
      const r = await buildSemanticLinks(home, { threshold: Number(flags.threshold) || undefined, topK: Number(flags.topk) || undefined });
      emit(json, r, () => {
        if (!r.pagesWithVec) return console.log("🔗 sem vetores — rode 'embed' antes (precisa OPENAI_API_KEY)");
        console.log(`🔗 ${r.added} arestas semânticas entre ${r.pagesWithVec} páginas (limiar ${r.threshold}, top-${r.topK}):`);
        r.sample.forEach((s) => console.log(`  · ${s.sim}  ${s.a.slice(0, 34)} ↔ ${s.b.slice(0, 34)}`));
      });
      break;
    }
    case "search": {
      need();
      const r = await search(home, q, Number(flags.k) || 8, flags.type as string);
      emit(json, r, () => r.forEach((h) => console.log(`• [${h.type}] ${h.slug}\n  ${h.excerpt}`)));
      break;
    }
    case "retrieve": {
      need();
      const r = flags.explain ? await retrieveExplained(home, q, Number(flags.k) || 6) : await retrieve(home, q, Number(flags.k) || 6);
      emit(json, r, () =>
        r.forEach((h) => {
          console.log(seloHeader(h.selo));
          if (h.stage) console.log(`  [score: base ${h.stage.base.toFixed(4)} × recency ${h.stage.recency.toFixed(2)} × salience ${h.stage.salience.toFixed(2)} = ${h.stage.final.toFixed(4)}]`);
          console.log(`  ${h.excerpt}\n`);
        }),
      );
      break;
    }
    case "ask": {
      need();
      const r = await ask(home, q, Number(flags.k) || 6);
      emit(json, r, () => console.log(r.answer));
      break;
    }
    case "get": {
      need();
      const r = await getPage(home, pos[1]);
      emit(json, r, () => console.log(r?.body ?? "(não encontrado)"));
      break;
    }
    case "facts": {
      need();
      const r = await facts(home, pos[1], {
        type: flags.type as string,
        limit: Number(flags.limit) || 200,
        asOf: flags["as-of"] as string,
        currentOnly: !!flags.current,
      });
      emit(json, r, () =>
        r.forEach((f) => {
          // fato bitemporal (tem entity) → selo rico; senão linha simples
          if (f.entity) console.log(`${factSeloHeader(f)}\n  ${f.text}`);
          else console.log(`• (${f.source_slug}) ${f.text}`);
        }),
      );
      break;
    }
    case "timeline": {
      need();
      const r = await timeline(home, pos[1], { predicate: flags.pred as string, limit: Number(flags.limit) || 200 });
      emit(json, r, () => {
        if (!r.length) return console.log(`(sem fatos bitemporais para "${pos[1]}")`);
        let lastPred = "";
        for (const f of r) {
          if (f.predicate !== lastPred) {
            console.log(`\n■ ${f.entity} · ${f.predicate}`);
            lastPred = f.predicate || "";
          }
          const ate = f.valid_to ? f.valid_to : "agora";
          const mark = f.status === "arquivado" ? "✗" : "✓";
          console.log(`  ${mark} ${f.valid_from || "?"} → ${ate}  ${f.value}  (conf ${(f.confidence ?? 0).toFixed(2)}, cite:${f.source_slug})`);
        }
      });
      break;
    }
    case "graph": {
      need();
      const r = await graph(home, pos[1]);
      emit(json, r, () => console.log(JSON.stringify(r, null, 2)));
      break;
    }
    case "stats": {
      need();
      const r = await stats(home);
      emit(json, r, () => console.log(`🧠 ${r.pages} páginas · ${r.facts} fatos · ${r.edges} links`));
      break;
    }
    case "tags": {
      need();
      const r = await tagVocab(home);
      emit(json, r, () => {
        if (!r.tags.length) return console.log("🏷️  vocabulário vazio (tags emergem do extract no TEMPO 2)");
        console.log(`🏷️  ${r.tags.length} tags · ${r.total} páginas`);
        r.tags.forEach((t) => console.log(`  ${String(t.count).padStart(4)}×  ${t.tag}  (${(t.ratio * 100).toFixed(0)}%)`));
      });
      break;
    }
    case "doctor": {
      need();
      const provider = resolveProvider(config(home).provider);
      const out: any = { engine: "postgres", brain: home, provider, openai: hasOpenAIKey(), rls: process.env.GALEED_RLS ? "on" : "off" };
      try {
        const e = await getEngine(home);
        out.ok = true;
        out.stats = await e.stats();
        out.vetores_ativos = await e.hasVectors();
        out.busca_semantica = out.vetores_ativos && out.openai ? "on" : "off";
      } catch (err) {
        out.ok = false;
        out.erro = (err as Error).message;
      }
      emit(json, out, () => {
        console.log(`🩺 engine: ${out.engine}${out.ok ? "" : "  ❌ " + out.erro}`);
        if (out.ok) {
          const s = out.stats;
          console.log(`   ${s.pages} páginas · ${s.facts} fatos · ${s.edges} links · ${s.vectors} vetores`);
          console.log(`   busca semântica: ${out.busca_semantica} · LLM: ${out.provider} · RLS: ${out.rls}`);
        }
      });
      break;
    }
    case "dream": {
      need();
      const r = await dreamV2(home, {
        minShared: Number(flags.min) || undefined,
        topK: Number(flags.top) || undefined,
        enqueue: !flags["dry-run"],
      });
      emit(json, r, () => {
        if (r.noop) return console.log("💤 nenhuma conexão acima do limiar — sono sem sonho (NOOP honesto).");
        console.log(`💭 ${r.hypotheses.length} hipóteses de conexão${flags["dry-run"] ? " (dry-run — nada gravado)" : " → fila de revisão (tela Revisar; aprovar cria a conexão no mapa, NUNCA fato)"}:`);
        r.hypotheses.forEach((h) => console.log(`  · ${h.text}`));
        if (r.clusters.length) console.log(`🧩 ${r.clusters.length} clusters de entidades (sinal informativo): ${r.clusters.map((c) => `[${c.members.slice(0, 3).join(", ")}${c.size > 3 ? "…" : ""}]`).join(" ")}`);
        console.log("ℹ️  o sonho de páginas (legado) foi aposentado — hipóteses agora nascem do grafo de ENTIDADES e vão pra fila M21.");
      });
      break;
    }
    case "prune": {
      need();
      const r = await prune(home, { apply: !!flags.apply, olderThan: flags.older as string });
      emit(json, r, () => {
        if (!r.candidates.length) return console.log("🧹 nada a podar");
        console.log(`🧹 ${r.candidates.length} candidatos a esquecer${flags.apply ? ` · ${r.archived} arquivados (flag, não deletados)` : " (dry-run; use --apply)"}:`);
        r.candidates.forEach((c) => console.log(`  · [${c.type}] ${c.slug} — ${c.reason} (score ${c.score})`));
      });
      break;
    }
    case "reconcile": {
      need();
      const r = await reconcile(home, { useLlm: !!flags.llm });
      emit(json, r, () => {
        console.log(`🔗 reconcile (${r.provider}): ${r.merges.length} grupos de predicados em ${r.entities} entidades`);
        r.merges.forEach((m) => console.log(`  · ${m.entity}: ${m.aliases.join(", ")} → ${m.canonical}`));
        if (r.merges.length) console.log("   (rode 'index' ou 'sleep' pra aplicar)");
      });
      break;
    }
    case "graph-query": {
      need();
      const r = await graphQuery(home, pos[1] || "", { predicate: flags.pred as string, currentOnly: !flags.all, limit: Number(flags.limit) || 100 });
      emit(json, r, () => {
        if (!r.length) return console.log(`(sem conexões para "${pos[1]}")`);
        r.forEach((h) => {
          const arrow = h.direction === "out" ? `${h.entity} —${h.predicate}→ ${h.value}` : `${h.value} —${h.predicate}→ ${h.entity}`;
          console.log(`  ${h.direction === "out" ? "→" : "←"} ${arrow}  (conf ${(h.confidence ?? 0).toFixed(2)}, cite:${h.source_slug})`);
        });
      });
      break;
    }
    case "contradictions": {
      need();
      if (flags.run) await findContradictions(home, { useLlm: !!flags.llm });
      const r = await listContradictions(home);
      emit(json, r, () => {
        if (!r.length) return console.log(flags.run ? "🔍 nenhuma contradição encontrada" : "🔍 nada registrado (rode --run pra detectar)");
        console.log(`⚠️  ${r.length} contradições registradas:`);
        r.forEach((c) => console.log(`  [${c.severity}/${c.verdict}] ${c.entity}: "${c.a_value}" (${c.a_slug}) ✗ "${c.b_value}" (${c.b_slug})`));
      });
      break;
    }
    case "eval": {
      need();
      const sub = pos[1];
      const fmt = (rep: any) => {
        const r = rep.run;
        console.log(`📊 run #${r.run_id} (k=${r.k}, ${r.n_queries} queries, semântica:${r.params?.semantic}): P@k ${r.p_at_k.toFixed(2)} · recall ${r.recall_at_k.toFixed(2)} · MRR ${r.mrr.toFixed(2)}`);
        if (rep.delta) console.log(`   Δ vs run anterior: P@k ${rep.delta.p_at_k >= 0 ? "+" : ""}${rep.delta.p_at_k.toFixed(2)} · recall ${rep.delta.recall_at_k >= 0 ? "+" : ""}${rep.delta.recall_at_k.toFixed(2)} · MRR ${rep.delta.mrr >= 0 ? "+" : ""}${rep.delta.mrr.toFixed(2)}`);
      };
      if (sub === "add") {
        const r = await addGolden(home, { query: pos.slice(2).join(" "), expected: flags.expect ? String(flags.expect).split(",").map((s) => s.trim()).filter(Boolean) : [], note: flags.note as string });
        emit(json, r, () => console.log(`✓ golden ${r.qid} (espera ${r.expected.length})`));
      } else if (sub === "seed") {
        const items = JSON.parse(readFileSync(flags.from as string, "utf8"));
        const n = await seedGolden(home, items);
        emit(json, { seeded: n }, () => console.log(`✓ ${n} queries-ouro carregadas`));
      } else if (sub === "run") {
        const rep = await runEval(home, { k: Number(flags.k) || undefined });
        emit(json, rep, () => fmt(rep));
      } else if (sub === "report") {
        const rep = await evalReport(home);
        emit(json, rep, () => (rep ? fmt(rep) : console.log("(nenhum run ainda — rode 'eval run')")));
      } else {
        console.log("uso: galeed eval add \"<query>\" --expect a,b | eval seed --from f.json | eval run [-k N] | eval report");
      }
      break;
    }
    case "pack": {                            // M13: pack seed --from <f.json> | pack show [--json]
      need();
      const sub = pos[1];
      if (sub === "seed") {
        const { packSeedCli } = await import("./core/extraction/pack-seed.ts");
        const r = await packSeedCli({ brain: home, from: flags.from as string });
        console.log(r.text);
        process.exit(r.code);
      } else if (sub === "show") {
        const { packShowCli } = await import("./core/extraction/pack-seed.ts");
        const r = await packShowCli({ brain: home, json });
        console.log(r.text);
        process.exit(r.code);
      } else {
        console.log("uso: galeed pack seed --from <arquivo.json> | pack show [--json]");
        process.exit(2);
      }
      break;
    }
    case "schema": {
      const sub = pos[1];
      if (sub === "scaffold-extractable") {
        const { scaffoldExtractableCli } = await import("./core/extraction/scaffold-extractable.ts");
        const r = scaffoldExtractableCli({ type: pos[2], pack: flags.pack as string, force: !!flags.force });
        console.log(r.text);
        process.exit(r.code);
      } else {
        console.log("uso: galeed schema scaffold-extractable <type> --pack <pack.json> [--force]");
      }
      break;
    }
    case "consolidate": {
      need();
      const r = await consolidateCold(home, { olderThan: flags.older as string, useLlm: !!flags.llm });
      emit(json, r, () => console.log(`🧊 consolidação (${r.provider}): ${r.summaries} resumos de ${r.entities} entidades frias · ${r.archivedAfter} fontes arquivadas após resumir`));
      break;
    }
    case "shed": {
      need();
      const r = await shedCold(home, { dryRun: !flags.apply });
      emit(json, r, () => {
        if (!r.cooled) return console.log("❄️ nada a resfriar (sem páginas arquivadas com vetores)");
        console.log(`❄️ ${r.cooled} páginas ${r.dryRun ? "resfriáveis" : "resfriadas"}${r.dryRun ? " (dry-run; use --apply)" : ` · ${r.vectorsShed} vetores descartados (regeneráveis via 'restore')`}:`);
        r.pages.forEach((s) => console.log(`  · ${s}`));
      });
      break;
    }
    case "restore": {
      need();
      const slug = pos[1] || "";
      if (!slug) { console.error("uso: galeed restore <slug>"); break; }
      const r = await restoreCold(home, slug);
      emit(json, r, () =>
        console.log(
          r.restored
            ? `♻️  ${slug} restaurada ao tier hot · ${r.vectorsRebuilt} chunks re-embedados${r.vectorsRebuilt === 0 ? " (sem OPENAI key? rode 'embed' depois)" : ""}`
            : `(nada a restaurar: ${slug} não existe ou já está ativa)`,
        ),
      );
      break;
    }
    case "sustainability": {
      need();
      const r = await sustainabilityReport(home, { dims: flags.dims ? Number(flags.dims) : undefined });
      emit(json, r, () => console.log(formatSustainability(r)));
      break;
    }
    case "resolve-entities": {
      need();
      const r = await resolveEntities(home, { useLlm: !!flags.llm, disambiguate: true });
      emit(json, r, () => {
        console.log(`🪪 entidades (${r.provider}): ${r.merges.length} grupos em ${r.entities} entidades`);
        r.merges.forEach((m) => console.log(`  · ${m.aliases.join(", ")} → ${m.canonical}`));
        if (r.merges.length) console.log("   (rode 'organize' ou 'sleep' pra aplicar)");
      });
      break;
    }
    case "reflect": {
      need();
      const r = await reflect(home, { threshold: Number(flags.min) || undefined, force: !!flags.force, apply: true });
      emit(json, r, () => {
        if (!r.triggered) return console.log(`💭 reflexão não disparou: ${r.reason}`);
        console.log(`💭 refleti sobre ${r.windowSize} fontes (via ${r.provider}) → ${r.learnings.length} aprendizados no banco:`);
        r.learnings.forEach((l) => console.log(`\n  ❓ ${l.question}\n  💡 ${l.text}\n     fontes: ${l.sources.join(", ") || "—"}`));
      });
      break;
    }
    case "verify": {
      need();
      const r = await verify(home, { minShared: Number(flags.min) || 2, apply: !!flags.apply });
      emit(json, r, () => {
        if (!r.length) return console.log("🔎 nenhuma hipótese pra verificar (rode 'dream' antes)");
        console.log(`🔎 ${r.length} hipóteses verificadas${flags.apply ? "" : " (dry-run; use --apply)"}:`);
        r.forEach((v) => console.log(`  · ${v.status.padEnd(12)} ${v.pair[0]} ↔ ${v.pair[1]}  (sinal ${v.was}→${v.now})`));
      });
      break;
    }
    case "sleep": {
      need();
      console.error("💤 dormindo (ciclo M24: consolidar → detectar → sonhar → verbalizar → varrer → podar)…");
      const t = await runSonoCycle(home); // manual = soberano: sem gatilho, sem teto, MESMO ciclo
      emit(json, t, () => {
        const f = t.fases ?? {};
        console.log(
          `🌅 acordou (${t.status}): 🔎 ${(f.detectores as any)?.sinais ?? 0} sinais · 💡 ${(f.reflexao as any)?.nascidas ?? 0} percepções (${t.chamadas_llm} chamadas LLM ≤ 1+${t.budget_k}) · 💭 ${(f.sonho as any)?.enfileiradas ?? 0} hipóteses na fila · ♻️ ${(f.reflexao as any)?.stales_novas ?? 0} stale · 🔗 ${(f.reconcile as any)?.merges ?? 0} predicados · 🪪 consolidação ${(f.consolidacao as any)?.status ?? "—"} · 📊 salience ${(f.salience as any)?.paginas ?? 0}p · 🧹 ${(f.prune as any)?.podaveis ?? 0} podáveis (${(f.prune as any)?.arquivadas ?? 0} arquivadas${f.shed ? ` · ❄️ ${(f.shed as any)?.cooled ?? 0} resfriadas` : ""})`,
        );
        for (const [nome, ft] of Object.entries(f)) if ((ft as any).status === "falhou") console.log(`   ⚠️ fase ${nome} falhou: ${(ft as any).erro}`);
      });
      break;
    }
    case "principal": {                       // principal add|disable|enable <id>
      need();
      const sub = pos[1];
      const r = sub === "add"     ? await cmdPrincipalAdd(home, pos.slice(1), flags)
              : sub === "disable" ? await cmdPrincipalStatus(home, pos.slice(1), flags, "disabled")
              : sub === "enable"  ? await cmdPrincipalStatus(home, pos.slice(1), flags, "active")
              : { error: "uso: principal add|disable|enable <id>" };
      emit(json, r, () =>
        console.log((r as any).error ?? ((r as any).principal
          ? `✓ principal ${(r as any).principal.id} (${(r as any).principal.kind})`
          : `✓ ${(r as any).id} → ${(r as any).status}`)));
      break;
    }
    case "grant": {                           // grant <principalId> --areas=a,b --max=<nivel> [--deny=t1,t2]
      need();
      const r = await cmdGrant(home, pos, flags);
      emit(json, r, () =>
        console.log((r as any).error ?? `✓ grant: ${pos[1]} → áreas ${flags.areas ?? "—"} · max ${flags.max}`));
      break;
    }
    case "token": {                           // token issue|revoke <arg>
      need();
      const sub = pos[1];
      const r = sub === "issue"  ? await cmdTokenIssue(home, pos.slice(1), flags)
              : sub === "revoke" ? await cmdTokenRevoke(home, pos.slice(1), flags)
              : { error: "uso: token issue|revoke" };
      emit(json, r, () =>
        console.log((r as any).error ?? ((r as any).token
          ? `🔑 ${(r as any).token}\n⚠️  ${(r as any).warning}`
          : `✓ token revogado (${(r as any).revoked})`)));
      break;
    }
    case "area": {                            // area attach|detach <slug> --area=<x>
      need();
      const sub = pos[1];
      const r = sub === "attach" ? await cmdAreaAttach(home, pos.slice(1), flags)
              : sub === "detach" ? await cmdAreaDetach(home, pos.slice(1), flags)
              : { error: "uso: area attach|detach <slug> --area=<x>" };
      emit(json, r, () =>
        console.log((r as any).error ?? `✓ ${sub} area:${(r as any).area} em ${(r as any).slug}${(r as any).changed ? "" : " (sem mudança)"}`));
      break;
    }
    case "sensitivity": {                      // sensitivity set <slug> --level=<nivel>
      need();
      const r = await cmdSensitivitySet(home, pos.slice(1), flags);  // pos[1]="set", pos[2]=slug → slice(1) faz pos[1]=slug
      emit(json, r, () =>
        console.log((r as any).error ?? `✓ ${(r as any).slug} → ${(r as any).level}`));
      break;
    }
    case "access-test": {                      // access-test <principalId>
      need();
      const r = await cmdAccessTest(home, pos, flags);
      emit(json, r, () =>
        console.log((r as any).error ?? `👁️  ${pos[1]} vê ${(r as any).visiblePages} páginas · áreas ${(r as any).scope.areas.join(",") || "—"} · max ${(r as any).scope.sensitivityMax}`));
      break;
    }
    case "access-log": {                       // access-log [--principal=<id>] [--limit=N]
      need();
      const r = await cmdAccessLog(home, pos, flags);
      emit(json, r, () =>
        (r as any).error
          ? console.log((r as any).error)
          : (r as any).entries.forEach((l: any) =>
              console.log(`${l.ts ?? "—"} · ${l.principal_id} · "${l.query}" · ${(l.areas_touched ?? []).join(",")} · ${l.n_returned} hits`)));
      break;
    }
    case "serve": {
      need();
      // --api sobe a API de leitura (base do SaaS); --ingest sobe o webhook de escrita.
      // sem flag = ambos (dev). O front consome só a API.
      const wantApi = flags.api || (!flags.ingest && !flags["no-api"]);
      const wantIngest = flags.ingest || (!flags.api && !flags["no-ingest"]);
      if (wantApi) {
        const { startApiServer } = await import("./connectors/api-server.ts");
        startApiServer(home);
      }
      if (wantIngest) {
        const { startIngestServer } = await import("./connectors/ingest-server.ts");
        startIngestServer(home);
      }
      await new Promise(() => {}); // mantém o processo vivo
      break;
    }
    default:
      console.log(HELP);
  }
}

main()
  .then(() => closeEngines())
  .catch(async (e) => {
    await closeEngines().catch(() => {});
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
