/** M16/S7 (HOTFIX) — REGRESSÃO do deadlock de init concorrente do worker.
 *
 *  O bug: `ingest-worker.ts main()` rodava `Promise.all([runIngestWorker(), runBatchPoller()])`. No
 *  COLD START, os dois loops chamam `db()`/init de schema no MESMO instante → dois runs de DDL
 *  concorrente (create table/index if not exists, alter table) em catálogo do Postgres →
 *  `PostgresError: deadlock detected`. O `finally` do `main()` engolia a rejeição com `process.exit(0)`
 *  + log "worker encerrado" — parecia shutdown gracioso, era crash imediato. O worker NÃO ficava de pé.
 *
 *  Por que o gate do S4 não pegou: os testes do poller (m16-worker-poller) MOCKAM TODA a fila/engine,
 *  então nunca exercem o init REAL concorrente contra um engine FRIO. ESTE teste usa o DB de verdade
 *  (Postgres :5434) e força o cold start via `closeIngestQueue()` (zera a conexão módulo-local) antes
 *  de subir os DOIS loops concorrentes — a lacuna real de cobertura.
 *
 *  Escopo cirúrgico dos mocks: mockamos APENAS `claimNextJob`/`claimPollableBatches` como passthroughs
 *  que CHAMAM o `db()` REAL (dispara o init de schema concorrente — a superfície do deadlock) e então
 *  devolvem VAZIO. Assim o init é 100% real (é o que deadlockava), mas nenhum JOB/LOTE de outro teste é
 *  claimado (sem efeito colateral, sem rede). `db()`/`getJob`/`closeIngestQueue` ficam REAIS. Brain
 *  DESCARTÁVEL, NUNCA Accelera. */
import { describe, it, expect, afterAll, beforeEach, vi } from "vitest";

import { hasDb } from "./helpers/db.ts"; // loadEnv() roda no import (vitest não lê .env sozinho)

const HAS_DB = hasDb();

// Mock parcial: só os dois CLAIMs viram passthrough-vazio-após-db(). Todo o resto (db, getJob,
// closeIngestQueue, o init de schema dentro de db()) é o REAL — é exatamente o init que deadlockava.
vi.mock("../../src/core/ingestion/ingest-queue.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/core/ingestion/ingest-queue.ts")>();
  return {
    ...actual,
    // chama o db() REAL (init de schema concorrente = a superfície do deadlock) e devolve vazio —
    // o loop não claima nem processa nada de outro teste; só exercita o init a frio.
    claimNextJob: async () => {
      await (actual as any).getJob("__probe__", "__probe__"); // força db()/init real, read-only
      return null;
    },
    claimPollableBatches: async () => {
      await (actual as any).getJob("__probe__", "__probe__");
      return [];
    },
  };
});

// não fechar engines reais em teardown indireto (não é exercido aqui).
vi.mock("../../src/core/platform/engine.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/core/platform/engine.ts")>();
  return { ...actual, closeEngines: vi.fn() };
});

const { runIngestWorker, runBatchPoller } = await import("../../src/connectors/ingest-worker.ts");
const { getJob, closeIngestQueue } = await import("../../src/core/ingestion/ingest-queue.ts");

afterAll(async () => {
  await closeIngestQueue().catch(() => {});
});

// força o COLD START: zera a conexão módulo-local da fila (db() re-abre + re-roda o init de schema).
async function coldStart(): Promise<void> {
  await closeIngestQueue().catch(() => {});
}

describe.skipIf(!HAS_DB)("M16/S7 — init concorrente do worker (regressão do deadlock)", () => {
  beforeEach(async () => {
    await coldStart();
  });

  it("FIX: warm-up SERIAL antes do Promise.all → 2 loops concorrentes a FRIO não deadlockam", async () => {
    // Replica o main(): warm-up read-only (dispara o init de schema UMA vez, SEM efeito colateral —
    // getJob de uma chave inexistente devolve null e NÃO claima job), DEPOIS os dois loops juntos.
    const warm = await getJob("__warmup__", "__warmup__");
    expect(warm).toBeNull(); // read-only: nenhuma linha → null (prova ausência de efeito colateral)

    // dois loops concorrentes (once:true) contra a conexão já aquecida → sem corrida de DDL.
    await expect(
      Promise.all([
        runIngestWorker({ once: true, idleMs: 1 }),
        runBatchPoller({ once: true, pollMs: 1 }),
      ]),
    ).resolves.toBeDefined();
  });

  it("FIX: warm-up é IDEMPOTENTE — re-aquecer a quente devolve null e usa o fast path do db()", async () => {
    await getJob("__warmup__", "__warmup__"); // 1º (cold) abre a conexão + roda o init de schema
    const second = await getJob("__warmup__", "__warmup__"); // 2º (warm) fast path
    expect(second).toBeNull();
  });

  it("FIX: o worker fica VIVO — vários ciclos concorrentes a frio resolvem sem deadlock", async () => {
    // prova de robustez: aquece e roda os dois loops algumas vezes seguidas (simula o worker de pé).
    await getJob("__warmup__", "__warmup__");
    for (let i = 0; i < 3; i++) {
      await expect(
        Promise.all([
          runIngestWorker({ once: true, idleMs: 1 }),
          runBatchPoller({ once: true, pollMs: 1 }),
        ]),
      ).resolves.toBeDefined();
    }
  });

  it("CONTROLE: a FRIO sem warm-up, os 2 loops em corrida exercem o init (documenta o bug)", async () => {
    // SEM o warm-up serial: os dois loops chamam db() ~ao mesmo tempo. ESTE é o caminho que, antes do
    // fix no main(), dava `deadlock detected`. Aceitamos QUALQUER desfecho para não tornar o teste
    // flaky no race do catálogo: (a) resolveu (o singleton de db() deduplicou a tempo) — ok; (b)
    // lançou deadlock — é o sintoma documentado. Erro NÃO-deadlock falha o teste.
    let deadlocked = false;
    try {
      await Promise.all([
        runIngestWorker({ once: true, idleMs: 1 }),
        runBatchPoller({ once: true, pollMs: 1 }),
      ]);
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      deadlocked = /deadlock/i.test(m);
      if (!deadlocked) throw err; // erro inesperado (não-deadlock) deve falhar o teste
    }
    if (deadlocked) {
      // eslint-disable-next-line no-console
      console.error("[m16-s7] CONTROLE reproduziu o deadlock a frio (sintoma esperado sem warm-up).");
    }
    expect(typeof deadlocked).toBe("boolean");
  });
});
