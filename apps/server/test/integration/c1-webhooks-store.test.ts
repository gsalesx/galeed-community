/** INTEGRAÇÃO C1 — WebhookStore (galeed_webhooks / galeed_webhook_deliveries, migrações 34/35).
 *  Cobre o contrato que os endpoints/worker (C1) e a emissão (C2) consomem:
 *   - registro: put/get/list/delete/setStatus escopados por brain; unique(brain,url);
 *   - secret: getWebhook expõe (worker assina), listWebhooks NUNCA devolve (segredo só uma vez);
 *   - filtros de list: por event (gin sobre events[]) e por status;
 *   - fila de entrega: enqueue → claim atômico (lease, attempt+1) → mark done/dead/re-agenda;
 *   - claim respeita next_attempt_at (entrega no futuro não é elegível);
 *   - coluna galeed_facts.webhook_notified_superseded existe e default false (migração 35);
 *   - migrações 34/35 idempotentes (abrir o engine 2× não erra).
 *  No-op sem DATABASE_URL/GALEED_DB_URL/SUPABASE_DB_URL (padrão ADR-014). */
import { describe, it, expect, afterAll } from "vitest";
import { hasDb, rawConnect, wipeBrain } from "./helpers/db.ts";
import {
  getEngine,
  closeEngines,
  type WebhookRow,
  type WebhookEvent,
} from "../../src/core/platform/engine.ts";

const A = "__c1wh_a";
const B = "__c1wh_b";

const webhook = (id: string, extra: Partial<WebhookRow> = {}): WebhookRow => ({
  id,
  url: `https://example.com/hook/${id}`,
  events: ["ingest.organized", "fact.superseded"] as WebhookEvent[],
  secret: `secret-${id}`,
  label: `Hook ${id}`,
  status: "active",
  created_by: "demo@galeed.app",
  ...extra,
});

let dbOk: Promise<boolean> | null = null;

async function dbAvailable(): Promise<boolean> {
  if (!hasDb()) return false;
  dbOk ??= (async () => {
    let sql: any;
    try {
      sql = await rawConnect();
      await Promise.race([
        sql`select 1`,
        new Promise((_, reject) => setTimeout(() => reject(new Error("db ping timeout")), 7000)),
      ]);
      return true;
    } catch {
      return false;
    } finally {
      if (sql) await sql.end({ timeout: 5 }).catch(() => {});
    }
  })();
  return dbOk;
}

async function resetBrains(): Promise<void> {
  await wipeBrain(A);
  await wipeBrain(B);
  await closeEngines();
}

async function runWithDb(fn: () => Promise<void>): Promise<void> {
  if (!hasDb()) return;
  const ok = await dbAvailable();
  expect(
    ok,
    "DATABASE_URL/GALEED_DB_URL/SUPABASE_DB_URL está definido, mas o Postgres de integração não respondeu.",
  ).toBe(true);
  if (!ok) return;
  await resetBrains();
  try {
    await fn();
  } finally {
    await resetBrains();
  }
}

describe("C1 — WebhookStore (registro + fila de entrega)", () => {
  afterAll(async () => {
    if (await dbAvailable()) {
      await wipeBrain(A);
      await wipeBrain(B);
    }
    await closeEngines();
  });

  it("registro: put + get (COM secret) + list (SEM secret); isolamento entre brains", async () => {
    await runWithDb(async () => {
      const ea = await getEngine(A);
      const eb = await getEngine(B);
      await ea.putWebhook(webhook("w1"));

      // get devolve o secret (é a leitura do worker p/ assinar)
      const got = await ea.getWebhook("w1");
      expect(got).toBeDefined();
      expect(got!.url).toBe("https://example.com/hook/w1");
      expect(got!.events).toEqual(["ingest.organized", "fact.superseded"]);
      expect(got!.secret).toBe("secret-w1");
      expect(got!.status).toBe("active");
      expect(got!.created_by).toBe("demo@galeed.app");
      expect(got!.failure_count).toBe(0);

      // list NUNCA devolve o secret
      const list = await ea.listWebhooks();
      expect(list).toHaveLength(1);
      expect(list[0].id).toBe("w1");
      expect(list[0].secret).toBe("");

      // brain B não vê o webhook de A
      expect(await eb.getWebhook("w1")).toBeUndefined();
      expect(await eb.listWebhooks()).toEqual([]);
    });
  });

  it("putWebhook é INSERT PURO por (brain,id): id repetido NÃO sobrescreve secret/url (anti-sequestro)", async () => {
    await runWithDb(async () => {
      const e = await getEngine(A);
      await e.putWebhook(webhook("w1", { url: "https://a.test/x", secret: "secret-original" }));

      // ACHADO 4: re-put do MESMO id com url/secret DIFERENTES é um NO-OP (on conflict do nothing) —
      // um caller futuro que controlasse o id NÃO pode SEQUESTRAR o secret/url do webhook existente.
      await e.putWebhook(
        webhook("w1", { url: "https://atacante.test/roubo", secret: "secret-do-atacante", label: "v2", events: ["review.pending"] }),
      );
      const after = await e.getWebhook("w1");
      expect(after!.url).toBe("https://a.test/x");        // url ORIGINAL intacta (não sobrescrita)
      expect(after!.secret).toBe("secret-original");      // secret ORIGINAL intacto (sem sequestro)
      expect(after!.events).toEqual(["ingest.organized", "fact.superseded"]); // events originais
      expect(after!.label).toBe("Hook w1");               // label original

      // url duplicada em OUTRO id → o unique(brain,url) estoura (registro self-serve trata na borda como 409)
      await expect(e.putWebhook(webhook("w2", { url: "https://a.test/x" }))).rejects.toThrow();
    });
  });

  it("list filtra por event (gin) e por status", async () => {
    await runWithDb(async () => {
      const e = await getEngine(A);
      await e.putWebhook(webhook("w-org", { url: "https://a/1", events: ["ingest.organized"] }));
      await e.putWebhook(webhook("w-sup", { url: "https://a/2", events: ["fact.superseded"] }));
      await e.putWebhook(webhook("w-both", { url: "https://a/3", events: ["ingest.organized", "fact.superseded"] }));
      await e.setWebhookStatus("w-sup", "disabled");

      const org = await e.listWebhooks({ event: "ingest.organized" });
      expect(org.map((w) => w.id).sort()).toEqual(["w-both", "w-org"]);

      const sup = await e.listWebhooks({ event: "fact.superseded" });
      expect(sup.map((w) => w.id).sort()).toEqual(["w-both", "w-sup"]);

      const active = await e.listWebhooks({ status: "active" });
      expect(active.map((w) => w.id).sort()).toEqual(["w-both", "w-org"]);

      // combinação event + status
      const orgActive = await e.listWebhooks({ event: "fact.superseded", status: "active" });
      expect(orgActive.map((w) => w.id)).toEqual(["w-both"]);
    });
  });

  it("setWebhookStatus muda status e (opcional) failure_count/last_error; delete remove", async () => {
    await runWithDb(async () => {
      const e = await getEngine(A);
      await e.putWebhook(webhook("w1"));

      await e.setWebhookStatus("w1", "failed", { failure_count: 5, last_error: "connect ECONNREFUSED" });
      const failed = await e.getWebhook("w1");
      expect(failed!.status).toBe("failed");
      expect(failed!.failure_count).toBe(5);
      expect(failed!.last_error).toBe("connect ECONNREFUSED");

      // sem opts → status muda, failure_count/last_error PRESERVADOS (coalesce)
      await e.setWebhookStatus("w1", "active");
      const reactivated = await e.getWebhook("w1");
      expect(reactivated!.status).toBe("active");
      expect(reactivated!.failure_count).toBe(5);
      expect(reactivated!.last_error).toBe("connect ECONNREFUSED");

      await e.deleteWebhook("w1");
      expect(await e.getWebhook("w1")).toBeUndefined();
    });
  });

  it("fila: enqueue → claim (lease, attempt+1) → markDone; FIFO por next_attempt_at", async () => {
    await runWithDb(async () => {
      const e = await getEngine(A);
      await e.putWebhook(webhook("w1"));

      const id1 = await e.enqueueWebhookDelivery({
        webhook_id: "w1",
        event: "ingest.organized",
        payload: { brain: A, n: 1 },
      });
      const id2 = await e.enqueueWebhookDelivery({
        webhook_id: "w1",
        event: "fact.superseded",
        payload: { brain: A, n: 2 },
      });
      expect(id1).not.toBe(id2);

      // claim pega a mais antiga; marca delivering + attempt=1
      const d1 = await e.claimNextWebhookDelivery();
      expect(d1).toBeDefined();
      expect(d1!.id).toBe(id1);
      expect(d1!.status).toBe("delivering");
      expect(d1!.attempt).toBe(1);
      expect(d1!.event).toBe("ingest.organized");
      expect(d1!.payload).toEqual({ brain: A, n: 1 });

      // a primeira está em lease (next_attempt_at empurrado) → o próximo claim pega a SEGUNDA
      const d2 = await e.claimNextWebhookDelivery();
      expect(d2!.id).toBe(id2);
      expect(d2!.attempt).toBe(1);

      // nada mais elegível agora
      expect(await e.claimNextWebhookDelivery()).toBeNull();

      // fecha em done
      await e.markWebhookDelivery(id1, { status: "done", response_status: 200 });
      // fecha em dead
      await e.markWebhookDelivery(id2, { status: "dead", response_status: 500, error: "5xx repetido" });

      // ambas terminais → claim não pega nenhuma
      expect(await e.claimNextWebhookDelivery()).toBeNull();
    });
  });

  it("markWebhookDelivery re-agenda (queued, backoff) → re-claim só após next_attempt_at", async () => {
    await runWithDb(async () => {
      const e = await getEngine(A);
      await e.putWebhook(webhook("w1"));
      const id = await e.enqueueWebhookDelivery({ webhook_id: "w1", event: "review.pending", payload: {} });

      const claimed = await e.claimNextWebhookDelivery();
      expect(claimed!.id).toBe(id);
      expect(claimed!.attempt).toBe(1);

      // falhou: re-agenda pro FUTURO (backoff) — não elegível agora
      const future = new Date(Date.now() + 60_000).toISOString();
      await e.markWebhookDelivery(id, {
        status: "queued",
        response_status: 503,
        error: "indisponível",
        next_attempt_at: future,
      });
      expect(await e.claimNextWebhookDelivery()).toBeNull();

      // re-agenda pro PASSADO → elegível, attempt incrementa de novo (2)
      await e.markWebhookDelivery(id, { status: "queued", next_attempt_at: new Date(Date.now() - 1000).toISOString() });
      const reclaimed = await e.claimNextWebhookDelivery();
      expect(reclaimed!.id).toBe(id);
      expect(reclaimed!.attempt).toBe(2);
      expect(reclaimed!.response_status).toBe(503); // erro da tentativa anterior preservado
    });
  });

  it("claim respeita next_attempt_at no enqueue (entrega agendada pro futuro não é elegível)", async () => {
    await runWithDb(async () => {
      const e = await getEngine(A);
      await e.putWebhook(webhook("w1"));
      const future = new Date(Date.now() + 60_000).toISOString();
      await e.enqueueWebhookDelivery({
        webhook_id: "w1",
        event: "ingest.organized",
        payload: {},
        nextAttemptAt: future,
      });
      expect(await e.claimNextWebhookDelivery()).toBeNull();
    });
  });

  it("galeed_facts.webhook_notified_superseded existe e default false (migração 35)", async () => {
    await runWithDb(async () => {
      await getEngine(A); // ensureSchema aplica migrações 34/35
      const sql = await rawConnect();
      try {
        await sql.unsafe(
          `insert into galeed_facts (brain, source_slug, dimension, idx, entity, predicate, value, valid_from, valid_to, confidence, status)
           values ($1, 'p1', 'decisoes', 0, '', '', '', '2026-01-01', '', 0.9, 'fato')`,
          [A],
        );
        const rows = (await sql.unsafe(
          `select webhook_notified_superseded from galeed_facts where brain = $1 limit 1`,
          [A],
        )) as any[];
        expect(rows[0].webhook_notified_superseded).toBe(false);
      } finally {
        await sql.end({ timeout: 5 });
      }
    });
  });

  it("migrações 34/35 idempotentes: abrir o engine 2× não erra", async () => {
    await runWithDb(async () => {
      await getEngine(A);
      await closeEngines();
      const e = await getEngine(A); // ensureSchema + migrações rodam de novo
      await e.putWebhook(webhook("w-mig"));
      expect((await e.getWebhook("w-mig"))!.id).toBe("w-mig");
    });
  });
});
