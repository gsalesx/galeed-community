#!/usr/bin/env node
/** Dev local em UM comando: sobe BFF (:8789), gateway (:8790), worker de ingestão e o painel
 *  (Vite :5173), com log prefixado por processo. O Postgres vem antes: `docker compose up -d`.
 *  Ctrl-C derruba todos juntos. Zero dependências (node: builtins). */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const PROCS = [
  { name: "bff",     cmd: "npx", args: ["tsx", "apps/server/src/connectors/web-server.ts"], cwd: root },
  { name: "gateway", cmd: "npx", args: ["tsx", "apps/server/src/connectors/gateway-server.ts"], cwd: root },
  { name: "worker",  cmd: "npx", args: ["tsx", "apps/server/src/connectors/ingest-worker.ts"], cwd: root },
  { name: "web",     cmd: "npm", args: ["run", "dev"], cwd: join(root, "apps/web") },
];

const pad = Math.max(...PROCS.map((p) => p.name.length));
const children = [];
let shuttingDown = false;

function prefix(name, stream, out) {
  let buf = "";
  stream.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      out.write(`[${name.padEnd(pad)}] ${buf.slice(0, i)}\n`);
      buf = buf.slice(i + 1);
    }
  });
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const ch of children) ch.kill("SIGTERM");
  setTimeout(() => process.exit(code), 500).unref();
}

for (const p of PROCS) {
  const ch = spawn(p.cmd, p.args, { cwd: p.cwd, stdio: ["ignore", "pipe", "pipe"] });
  children.push(ch);
  prefix(p.name, ch.stdout, process.stdout);
  prefix(p.name, ch.stderr, process.stderr);
  ch.on("exit", (code) => {
    if (shuttingDown) return;
    console.error(`[dev] processo '${p.name}' saiu (código ${code}) — derrubando os demais.`);
    shutdown(code ?? 1);
  });
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
console.log("[dev] subindo: painel http://localhost:5173 · BFF :8789 · API pública :8790 · worker de ingestão");
console.log("[dev] pré-requisito: Postgres no ar (docker compose up -d)");
