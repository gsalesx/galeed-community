/** P0-C — SMOKE do LEASE + REAPER da fila (a fila sobrevive a crash, auditoria C3). Puro DB, sem LLM.
 *  Espelha o skipIf/wipeJobs de m16-job-batch-state.test.ts. Brain `lease-p0c-fila` (sufixo único — 3 devs
 *  no mesmo banco). Prova: (1) claim grava lease+attempts; (2) lease expirado → requeue com backoff →
 *  re-claim; (3) attempts=max → dead idempotente; (4) job legado preso → resgate; (5) claim concorrente
 *  preservado; (6) batch_submitted limpa o lease (reaper ignora); (7) mergeJobResult + markJobDone mergeia. */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { hasDb, rawConnect } from "./helpers/db.ts";
import {
  enqueueIngestJob,
  claimNextJob,
  reapExpiredJobs,
  markJobBatchSubmitted,
  markJobDone,
  mergeJobResult,
  getJob,
  closeIngestQueue,
  type IngestJobResult,
} from "../../src/core/ingestion/ingest-queue.ts";

const BRAIN = "lease-p0c-fila";

async function wipeJobs(): Promise<void> {
  const sql = await rawConnect();
  try {
    await sql.unsafe(`delete from galeed_ingest_jobs where brain = $1`, [BRAIN]).catch(() => {});
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** claimNextJob é GLOBAL (qualquer brain) — 3 devs no mesmo banco. Esta helper claima até pegar um job
 *  do MEU brain. Jobs de OUTRO brain claimados são "parqueados" (lease futuro) pra não serem re-claimados
 *  no loop nem disputados pelo dono, e ao final RESTAURADOS exatamente ao pré-claim (queued, lease null,
 *  started_at null, attempts-1). Devolve o job do meu brain ou null se só havia foreign/nada elegível. */
async function claimMine(leaseMs?: number): Promise<Awaited<ReturnType<typeof claimNextJob>>> {
  const parked: string[] = [];
  let mine: Awaited<ReturnType<typeof claimNextJob>> = null;
  const sql = await rawConnect();
  try {
    for (let i = 0; i < 50; i++) {
      const j = await (leaseMs === undefined ? claimNextJob() : claimNextJob(leaseMs));
      if (!j) break;
      if (j.brain === BRAIN) { mine = j; break; }
      // foreign: parqueia (lease 1h no futuro) pra sair da elegibilidade do claim no loop.
      parked.push(j.id);
      await sql.unsafe(`update galeed_ingest_jobs set lease_until = now() + interval '1 hour' where id = $1`, [j.id]);
    }
    // restaura os foreign exatamente ao pré-claim (não interfere no teste do outro dev).
    for (const id of parked)
      await sql.unsafe(
        `update galeed_ingest_jobs set status='queued', lease_until=null, started_at=null, attempts=greatest(attempts-1,0) where id=$1`,
        [id],
      );
  } finally {
    await sql.end({ timeout: 5 });
  }
  return mine;
}

describe.skipIf(!hasDb())("P0-C — lease + reaper (fila sobrevive a crash)", () => {
  beforeAll(wipeJobs);
  beforeEach(wipeJobs);
  afterAll(async () => {
    await wipeJobs();
    await closeIngestQueue();
  });

  it("(1) claimNextJob grava lease_until futuro e attempts=1", async () => {
    await enqueueIngestJob({ brain: BRAIN, kind: "text", type: "conversa", textBody: "a" });
    const job = await claimMine();
    expect(job).toBeTruthy();
    const got = await getJob(BRAIN, job!.id);
    expect(got?.status).toBe("processing");
    expect(got?.attempts).toBe(1);
    expect(got?.leaseUntil).toBeTruthy();
    expect(new Date(got!.leaseUntil!).getTime()).toBeGreaterThan(Date.now());
  });

  it("(2) lease expirado → requeue com backoff (tentativa 2 de 3) → não-claimável até backoff → re-claim attempts=2", async () => {
    await enqueueIngestJob({ brain: BRAIN, kind: "text", type: "conversa", textBody: "b" });
    const job = await claimMine();
    expect(job?.attempts).toBe(1);

    // simula crash: lease vencido (SQL direto — expressão de tempo, não dá pra parametrizar)
    const sql = await rawConnect();
    try {
      await sql.unsafe(`update galeed_ingest_jobs set lease_until = now() - interval '1 second' where id = $1`, [job!.id]);
    } finally {
      await sql.end({ timeout: 5 });
    }

    const reaped = await reapExpiredJobs();
    expect(reaped.requeued.map((r) => r.id)).toContain(job!.id);
    expect(reaped.dead.map((d) => d.id)).not.toContain(job!.id); // meu job não morreu (global → só checo o meu)

    const requeued = await getJob(BRAIN, job!.id);
    expect(requeued?.status).toBe("queued");
    expect(requeued?.message).toContain("voltou pra fila (tentativa 2 de 3)");
    expect(new Date(requeued!.leaseUntil!).getTime()).toBeGreaterThan(Date.now()); // backoff (inelegível)

    // backoff vigente → claimMine NÃO devolve o MEU job (restaura foreign sem disputar)
    const blocked = await claimMine();
    expect(blocked).toBeNull();

    // expira o backoff → claim devolve, attempts=2
    const sql2 = await rawConnect();
    try {
      await sql2.unsafe(`update galeed_ingest_jobs set lease_until = now() - interval '1 second' where id = $1`, [job!.id]);
    } finally {
      await sql2.end({ timeout: 5 });
    }
    const again = await claimMine();
    expect(again?.id).toBe(job!.id);
    expect(again?.attempts).toBe(2);
  });

  it("(3) attempts=max + lease expirado → dead com motivo; reaper idempotente; claim nunca devolve dead", async () => {
    const { jobId } = await enqueueIngestJob({ brain: BRAIN, kind: "text", type: "conversa", textBody: "c" });
    // força processing, attempts=3 (já claimado max), lease vencido
    const sql = await rawConnect();
    try {
      await sql.unsafe(
        `update galeed_ingest_jobs set status='processing', attempts=3, started_at=now(),
           lease_until = now() - interval '1 second' where id = $1`,
        [jobId],
      );
    } finally {
      await sql.end({ timeout: 5 });
    }

    const reaped = await reapExpiredJobs();
    expect(reaped.dead.map((d) => d.id)).toContain(jobId);
    expect(reaped.requeued.map((r) => r.id)).not.toContain(jobId); // meu job foi pra dead, não pra requeue

    const dead = await getJob(BRAIN, jobId);
    expect(dead?.status).toBe("dead");
    expect(dead?.errorMessage).toContain("marquei como morto");
    expect(dead?.errorMessage).toContain("processing"); // último estado
    expect(dead?.finishedAt).toBeTruthy();

    // idempotente: 2ª passada não toca o MEU job (global → só checo o meu)
    const again = await reapExpiredJobs();
    expect(again.dead.map((d) => d.id)).not.toContain(jobId);
    expect(again.requeued.map((r) => r.id)).not.toContain(jobId);

    // claim nunca devolve dead (claimMine restaura foreign; meu job dead nunca é claimável)
    const claimed = await claimMine();
    expect(claimed).toBeNull();
  });

  it("(4) job LEGADO preso (processing, lease null, started_at velho) → reaper re-enfileira (backlog C3a)", async () => {
    const { jobId } = await enqueueIngestJob({ brain: BRAIN, kind: "text", type: "conversa", textBody: "legado" });
    const sql = await rawConnect();
    try {
      // legado: nunca teve lease, started_at antigo, attempts=0
      await sql.unsafe(
        `update galeed_ingest_jobs set status='processing', attempts=0, lease_until=null,
           started_at = now() - interval '1 hour' where id = $1`,
        [jobId],
      );
    } finally {
      await sql.end({ timeout: 5 });
    }

    const reaped = await reapExpiredJobs({ leaseMs: 60_000 }); // lease 60s → started_at 1h atrás está velho
    expect(reaped.requeued.map((r) => r.id)).toContain(jobId);
    const requeued = await getJob(BRAIN, jobId);
    expect(requeued?.status).toBe("queued");
    expect(requeued?.message).toContain("tentativa 1 de 3"); // attempts=0 → "1 de 3"
  });

  it("(5) claim concorrente: 1 job MEU, dois claimNextJob() → no MÁX 1 claimer pega o MEU (skip-locked)", async () => {
    const { jobId } = await enqueueIngestJob({ brain: BRAIN, kind: "text", type: "conversa", textBody: "conc" });
    // claimNextJob é global; dois claims concorrentes nunca pegam o MESMO job (for update skip locked).
    const [a, b] = await Promise.all([claimNextJob(), claimNextJob()]);
    const mine = [a, b].filter((j) => j?.brain === BRAIN);
    expect(mine.length).toBeLessThanOrEqual(1); // meu único job vai p/ no máx 1 claimer
    // restaura qualquer foreign claimado (não disputa com o dono).
    const sql = await rawConnect();
    try {
      for (const j of [a, b]) {
        if (j && j.brain !== BRAIN)
          await sql.unsafe(
            `update galeed_ingest_jobs set status='queued', lease_until=null, started_at=null, attempts=greatest(attempts-1,0) where id=$1`,
            [j.id],
          );
      }
    } finally {
      await sql.end({ timeout: 5 });
    }
    // o MEU job foi claimado por exatamente um (não pode ter ficado em queued se ambos correram nele).
    const got = await getJob(BRAIN, jobId);
    expect(got?.status).toBe("processing");
    expect(got?.attempts).toBe(1); // claimado UMA vez (skip-locked impediu duplo claim)
  });

  it("(6) markJobBatchSubmitted limpa o lease → reaper IGNORA o job (lote não é governado por lease)", async () => {
    const { jobId } = await enqueueIngestJob({ brain: BRAIN, kind: "text", type: "conversa", textBody: "batch" });
    await claimMine(); // attempts=1, status processing
    await markJobBatchSubmitted(jobId, "msgbatch_lease", { slug__0: "slug" });

    const after = await getJob(BRAIN, jobId);
    expect(after?.status).toBe("batch_submitted");
    expect(after?.leaseUntil).toBeNull();

    const reaped = await reapExpiredJobs();
    expect(reaped.requeued.map((r) => r.id)).not.toContain(jobId);
    expect(reaped.dead.map((d) => d.id)).not.toContain(jobId);
  });

  it("(7) mergeJobResult({embeddings:'failed'}) + markJobDone(result) → result_json mergeia (flag + campos do done)", async () => {
    const { jobId } = await enqueueIngestJob({ brain: BRAIN, kind: "text", type: "conversa", textBody: "merge" });
    await mergeJobResult(jobId, { embeddings: "failed", embeddings_error: "sem chave" });
    const result: IngestJobResult = { total: 3, slugs: ["s1"], skipped: 0, message: "ok" };
    await markJobDone(jobId, result);

    const got = await getJob(BRAIN, jobId);
    expect(got?.status).toBe("done");
    expect((got?.resultJson as any).embeddings).toBe("failed"); // flag preservado
    expect((got?.resultJson as any).total).toBe(3); // campos do done presentes
    expect((got?.resultJson as any).message).toBe("ok");
  });
});
