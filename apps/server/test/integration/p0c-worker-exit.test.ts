/** P0-C/C3c — PROVA do "worker que morre sai com exit ≠ 0 e loga a causa". Spawna o worker com DB
 *  INVÁLIDO (porta morta) → o warm-up/loop lança → o catch real loga "crash fatal" e sai com exit 1.
 *  É a prova de que DB caiu ≠ shutdown gracioso (antes do P0-C, o finally mascarava com exit(0)). */
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// caminho ABSOLUTO do worker (resolvido a partir do arquivo, não do cwd) — robusto após a reorg
// que desceu src/ para apps/server/src/. test/integration → ../../src/connectors/ingest-worker.ts.
const WORKER = fileURLToPath(new URL("../../src/connectors/ingest-worker.ts", import.meta.url));

describe("P0-C/C3c — worker morre com exit≠0 e loga a causa", () => {
  it("DB inválido → exitCode===1 e stderr casa /crash fatal/", async () => {
    const result = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
      const child = spawn("npx", ["tsx", WORKER], {
        env: {
          ...process.env,
          DATABASE_URL: "postgres://127.0.0.1:9/nope",
          GALEED_DB_URL: "",
          SUPABASE_DB_URL: "",
        },
      });
      let stderr = "";
      child.stderr.on("data", (d) => (stderr += d.toString()));
      child.stdout.on("data", () => {});
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve({ code: null, stderr: stderr + "\n[test] TIMEOUT" });
      }, 90_000);
      timer.unref?.();
      child.on("exit", (code) => {
        clearTimeout(timer);
        resolve({ code, stderr });
      });
    });

    expect(result.code, `esperava exit 1; stderr:\n${result.stderr}`).toBe(1);
    expect(result.stderr).toMatch(/crash fatal/);
  }, 95_000);
});
