#!/usr/bin/env node
/** CASOS REAIS — replay de um caso de empresa contra um Galeed vivo (ver CASOS.md).
 *
 *  Cada caso é um JSON com a rotina de uma empresa tradicional: eventos que chegam pelos
 *  INGESTORES (WhatsApp, planilha, reunião, formulário…) e as perguntas que o dono faria
 *  depois. O runner posta cada evento em POST /v1/ingestors/<slug>, espera a fila digerir
 *  e faz as perguntas via /v1/ask — imprimindo as respostas com fonte.
 *
 *  Papéis fiéis ao produto: a MÁQUINA ingere pela API pública (token gld_ com can_ingest) e a
 *  DONA pergunta pelo painel (login) — tokens de agente são escopados por área (fail-closed) e
 *  material de modo livre não aparece pra eles; o dono vê tudo.
 *
 *  Uso:
 *    node tools/casos/rodar.mjs --caso clinica-estetica --token gld_live_... \
 *      --email voce@empresa.com --senha ... --brain clinica-estetica \
 *      [--url http://localhost:8790] [--painel http://localhost:8789]
 *
 *  Flags: --so-ingestao (pula as perguntas) · --timeout <s> (espera da fila; default 600) */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = args[i + 1];
  return v && !v.startsWith("--") ? v : true;
}

const caso = flag("caso");
const token = flag("token", process.env.GALEED_TOKEN);
const base = String(flag("url", process.env.GALEED_URL || "http://localhost:8790")).replace(/\/+$/, "");
const painel = String(flag("painel", process.env.GALEED_PAINEL || "http://localhost:8789")).replace(/\/+$/, "");
const email = flag("email", process.env.GALEED_EMAIL);
const senha = flag("senha", process.env.GALEED_SENHA);
const brain = flag("brain");
const soIngestao = !!flag("so-ingestao", false);
const timeoutS = Number(flag("timeout", 600));

if (!caso || !token || token === true) {
  console.error("Uso: node tools/casos/rodar.mjs --caso <nome> --token gld_live_... --email <login do painel> --senha <senha> --brain <slug>");
  console.error("Casos disponíveis: clinica-estetica · imobiliaria · distribuidora · consultoria");
  process.exit(1);
}

const dir = dirname(fileURLToPath(import.meta.url));
const spec = JSON.parse(await readFile(join(dir, `${caso}.json`), "utf8"));

const H = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

async function post(path, body) {
  const r = await fetch(`${base}${path}`, { method: "POST", headers: H, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok && r.status !== 202) throw new Error(`${path} → ${r.status}: ${JSON.stringify(data).slice(0, 200)}`);
  return data;
}

console.log(`\n🏢 CASO: ${spec.empresa}`);
console.log(`   ${spec.historia}\n`);

// ── 1. eventos entram pelos ingestores (a rotina da empresa) ────────────────
const jobs = [];
let aplicados = 0;
for (const ev of spec.eventos) {
  const r = await post(`/v1/ingestors/${ev.ingestor}`, ev.payload);
  jobs.push(...(r.jobs ?? []));
  aplicados += r.aplicados ?? 0;
  const como = r.aplicados ? `${r.aplicados} fatos carimbados NA HORA (zero IA)` : r.enfileirados ? `na fila` : r.dedupados ? "já estava (dedupe)" : "ignorado";
  console.log(`  → [${ev.ingestor}] ${ev.rotulo}: ${como}`);
}

// ── 2. espera a fila digerir (a extração roda no worker) ────────────────────
if (jobs.length) {
  process.stdout.write(`\n⏳ digerindo ${jobs.length} entrada(s) na fila`);
  const fim = Date.now() + timeoutS * 1000;
  const pend = new Set(jobs);
  while (pend.size && Date.now() < fim) {
    for (const id of [...pend]) {
      const r = await fetch(`${base}/v1/ingest/${id}`, { headers: H });
      const j = await r.json().catch(() => ({}));
      if (j.status === "organized" || j.status === "failed") pend.delete(id);
    }
    if (pend.size) {
      process.stdout.write(".");
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  console.log(pend.size ? ` (timeout — ${pend.size} ainda na fila)` : " pronto ✅");
}
if (aplicados) console.log(`💎 ${aplicados} fatos determinísticos aplicados sem nenhuma chamada de IA.`);

// ── 3. as perguntas que a DONA faria no painel (o VALOR) ────────────────────
if (!soIngestao && spec.perguntas?.length) {
  if (!email || email === true || !senha || senha === true || !brain || brain === true) {
    console.log(`\n(perguntas puladas: passe --email/--senha/--brain pra perguntar como o dono no painel)`);
  } else {
    const login = await fetch(`${painel}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: senha }),
    });
    const cookie = login.headers.getSetCookie?.().map((c) => c.split(";")[0]).join("; ") ?? "";
    if (!login.ok || !cookie) {
      console.error(`\nnão consegui logar no painel (${login.status}) — perguntas puladas.`);
    } else {
      console.log(`\n💬 Perguntando ao cérebro (como o dono, no painel):`);
      for (const q of spec.perguntas) {
        const r = await fetch(`${painel}/api/ask?q=${encodeURIComponent(q)}&brain=${encodeURIComponent(brain)}`, {
          headers: { cookie },
        });
        const data = await r.json().catch(() => ({}));
        const resposta = String(data.answer ?? data.error ?? "").trim().replace(/\n{2,}/g, "\n");
        console.log(`\n  ❓ ${q}\n${resposta.split("\n").map((l) => `     ${l}`).join("\n")}`);
      }
    }
  }
}

console.log(`\n✔ caso "${caso}" concluído.\n`);
