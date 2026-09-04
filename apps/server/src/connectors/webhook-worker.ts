#!/usr/bin/env -S npx tsx
/** Galeed C1 — WORKER dedicado de ENTREGA de webhooks (idioma do ingest-worker.ts: loop + claim com
 *  lease + fail-soft + graceful shutdown). Entrega async, push por brain, isolada do caminho-quente.
 *
 *  LOOP (um ciclo):
 *   1. claim ATÔMICO da próxima entrega elegível (status='queued' & next_attempt_at<=now(), lease via
 *      skip-locked) — através do Engine por-brain. Como a fila é multi-tenant e o claim é escopado por
 *      brain, primeiro descubro QUAIS brains têm entrega elegível (1 SELECT tenant-neutro), depois
 *      claimo brain-a-brain. Dois workers nunca pegam a mesma entrega (for update skip locked no store).
 *   2. carrega o webhook de destino (getWebhook → COM secret, p/ assinar).
 *   3. validateOutboundUrl(url) DE NOVO (anti DNS-rebinding — o registro validou no passado; aqui,
 *      imediatamente antes do POST). Reprovou → entrega morta (dead) SEM tocar a rede. A guarda RETORNA
 *      o IP exato que aprovou ({ ip, family }).
 *   4. assina o body (signWebhookBody com a secret crua) → POST via deliverWebhook PINANDO o socket no
 *      IP que a guarda aprovou (node:https.request com lookup pinado — fecha o rebinding TOCTOU, sem
 *      re-resolução de DNS; sem auto-redirect; timeout 5s) com headers X-Galeed-Signature,
 *      X-Galeed-Timestamp, X-Galeed-Event, content-type json.
 *   5. classifica a resposta:
 *        2xx          → DONE.
 *        429          → RETRY (rate-limit do cliente é transitório) com backoff.
 *        3xx/4xx      → DEAD (erro de cliente definitivo; redirect não-seguido também = não-confirmado).
 *        5xx/timeout/erro de rede → RETRY com backoff exponencial até MAX_RETRIES → DEAD.
 *      Em DEAD por esgotar retries, o WEBHOOK vira status='failed' (o dono religa). Atualiza sempre
 *      last_delivery_at/last_error/failure_count no webhook.
 *
 *  FAIL-SOFT: um erro de uma entrega NUNCA derruba o loop (try/catch por entrega, igual ao ingest-worker).
 *  ENV: GALEED_WEBHOOK_MAX_RETRIES (default 5); GALEED_WEBHOOK_IDLE_MS (default 1000);
 *       GALEED_WEBHOOK_LEASE_MS (default 60000); GALEED_WEBHOOK_TIMEOUT_MS (default 5000).
 *  `npm run webhook:worker`. */
// Carrega .env (como o ingest-worker): a entrega não precisa de chave de LLM, mas precisa de
// DATABASE_URL — depender só do env exportado é frágil quando rodado solto.
try {
  process.loadEnvFile();
} catch {
  /* sem .env: usa process.env */
}
import { getEngine, closeEngines, type WebhookDeliveryRow, type WebhookRow } from "../core/platform/engine.ts";
import { getSharedSql, closeSharedSql } from "../core/platform/db-conn.ts";
import { validateOutboundUrl, deliverWebhook } from "../lib/ssrf-guard.ts";
import { signWebhookBody } from "../lib/webhook-signature.ts";

export interface WebhookWorkerOpts {
  idleMs?: number;       // espera quando a fila está vazia (default 1000)
  once?: boolean;        // processa no MÁX 1 entrega por brain elegível e retorna (testes). default false
  leaseMs?: number;      // lease do claim (default 60000)
  timeoutMs?: number;    // timeout do POST (default 5000)
  maxRetries?: number;   // tentativas antes de dead+failed (default GALEED_WEBHOOK_MAX_RETRIES ?? 5)
}

let draining = false; // setado pelo handler de sinal — para de claimar novas entregas

function maxRetries(opts: WebhookWorkerOpts): number {
  if (typeof opts.maxRetries === "number") return opts.maxRetries;
  return Number(process.env.GALEED_WEBHOOK_MAX_RETRIES ?? 5);
}

/** backoff exponencial em SEGUNDOS, com teto de 1h: min(3600, 60 * 2^attempt). `attempt` é o nº de
 *  tentativas JÁ feitas (o claim incrementou). attempt=1 → 120s; 2 → 240s; … saturando em 3600s. */
function backoffSeconds(attempt: number): number {
  const secs = 60 * Math.pow(2, Math.max(0, attempt));
  return Math.min(3600, secs);
}

/** Descobre os brains com ALGUMA entrega elegível AGORA (status='queued' & next_attempt_at<=now()).
 *  Tenant-neutro (idioma do ingest-queue): a conexão não carrega brain; a query escopa. Read-only —
 *  o claim real (atômico, com lease) acontece depois via Engine.claimNextWebhookDelivery por brain. */
async function brainsWithPendingDeliveries(): Promise<string[]> {
  const sql = await getSharedSql();
  const rows = (await sql`
    select distinct brain
      from galeed_webhook_deliveries
     where status = 'queued' and next_attempt_at <= now()`) as Array<{ brain: string }>;
  return rows.map((r) => r.brain).filter(Boolean);
}

/** Entrega UMA já-claimada (status já 'delivering', attempt já incrementado pelo claim). Decide
 *  done|dead|re-agenda e atualiza o webhook (last_delivery_at/last_error/failure_count/status). */
async function deliverOne(brain: string, d: WebhookDeliveryRow, opts: WebhookWorkerOpts): Promise<void> {
  const e = await getEngine(brain);
  const nowIso = new Date().toISOString();

  // (2) webhook de destino — COM secret (getWebhook). Sumiu (deletado entre enqueue e claim) → dead órfã.
  const hook = await e.getWebhook(d.webhook_id);
  if (!hook) {
    await e.markWebhookDelivery(d.id, {
      status: "dead",
      error: "webhook não existe mais (órfã)",
      response_status: null,
    });
    log("dead-orphan", { brain, deliveryId: d.id, webhookId: d.webhook_id });
    return;
  }

  // (3) ANTI-REBINDING: revalida a URL AGORA, imediatamente antes do POST. Um host público no registro
  // pode ter o DNS re-apontado p/ IP interno desde então. A guarda RETORNA o IP que aprovou; a entrega
  // CONECTA NESSE IP exato (pin via deliverWebhook), sem re-resolver o DNS — fecha a janela TOCTOU de
  // verdade (validar de novo sozinho não fechava: o fetch re-resolvia). Reprovou → dead SEM tocar a rede.
  const guard = await validateOutboundUrl(hook.url);
  if (!guard.ok || !guard.ip) {
    await markDead(brain, e, hook, d, `URL bloqueada na entrega (SSRF): ${guard.reason ?? ""}`, null, nowIso);
    log("dead-ssrf", { brain, deliveryId: d.id, webhookId: hook.id, reason: guard.reason });
    return;
  }

  // (4) assina o body EXATO enviado (JSON canônico da payload guardada) com a secret crua do webhook.
  const rawBody = JSON.stringify(d.payload ?? {});
  const signature = signWebhookBody(rawBody, hook.secret);
  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
    "x-galeed-signature": signature,
    "x-galeed-timestamp": nowIso,
    "x-galeed-event": d.event,
    "x-galeed-delivery": d.id,
  };

  let status = 0;
  try {
    // PIN anti-rebinding: conecta no IP que a guarda APROVOU (guard.ip), não numa re-resolução de DNS.
    const res = await deliverWebhook(hook.url, guard.ip, guard.family ?? 4, {
      method: "POST",
      headers,
      body: rawBody,
      timeoutMs: opts.timeoutMs ?? Number(process.env.GALEED_WEBHOOK_TIMEOUT_MS ?? 5000),
    });
    status = res.status;
  } catch (err) {
    // (5) timeout/erro de rede → RETRY com backoff (ou dead se esgotou). status=0 sinaliza "sem resposta".
    const message = err instanceof Error ? err.message : String(err);
    await retryOrDie(brain, e, hook, d, opts, 0, `erro de rede/timeout: ${message}`, nowIso);
    log("retry-network", { brain, deliveryId: d.id, attempt: d.attempt, message });
    return;
  }

  // (5) classificação por faixa de status HTTP.
  if (status >= 200 && status < 300) {
    await e.markWebhookDelivery(d.id, { status: "done", response_status: status, error: "" });
    // sucesso: zera o contador de falhas e o último erro; reativa se estava failed por falhas passadas.
    await e.setWebhookStatus(hook.id, "active", { failure_count: 0, last_error: "" });
    await touchLastDelivery(brain, hook.id, nowIso);
    log("done", { brain, deliveryId: d.id, status });
    return;
  }
  if (status === 429) {
    // rate-limit do cliente: transitório → retry com backoff (não conta como falha "do webhook" p/ dead,
    // mas consome uma tentativa — o teto de retries protege contra fila infinita).
    await retryOrDie(brain, e, hook, d, opts, status, `cliente respondeu 429 (rate-limited)`, nowIso);
    log("retry-429", { brain, deliveryId: d.id, attempt: d.attempt });
    return;
  }
  if (status >= 300 && status < 500) {
    // 3xx (redirect NÃO seguido — entrega não-confirmada) ou 4xx (erro de cliente definitivo) → DEAD.
    await markDead(brain, e, hook, d, `cliente respondeu ${status} (definitivo, sem retry)`, status, nowIso);
    log("dead-client", { brain, deliveryId: d.id, status });
    return;
  }
  // 5xx (ou qualquer outro ≥500) → RETRY com backoff (servidor do cliente instável é transitório).
  await retryOrDie(brain, e, hook, d, opts, status, `cliente respondeu ${status} (servidor instável)`, nowIso);
  log("retry-5xx", { brain, deliveryId: d.id, attempt: d.attempt, status });
}

/** RETRY se ainda há tentativa; senão DEAD + webhook='failed'. `attempt` da entrega já foi incrementado
 *  pelo claim → quando attempt >= maxRetries, esgotou. Re-agenda com next_attempt_at = now + backoff. */
async function retryOrDie(
  brain: string,
  e: Awaited<ReturnType<typeof getEngine>>,
  hook: WebhookRow,
  d: WebhookDeliveryRow,
  opts: WebhookWorkerOpts,
  responseStatus: number,
  reason: string,
  nowIso: string,
): Promise<void> {
  const max = maxRetries(opts);
  if (d.attempt >= max) {
    await markDead(brain, e, hook, d, `${reason} — esgotou ${max} tentativas`, responseStatus || null, nowIso);
    return;
  }
  const delaySecs = backoffSeconds(d.attempt);
  const nextAt = new Date(Date.now() + delaySecs * 1000).toISOString();
  // volta p/ 'queued' agendado no futuro (markWebhookDelivery limpa delivered_at fora de done|dead).
  await e.markWebhookDelivery(d.id, {
    status: "queued",
    response_status: responseStatus || null,
    error: reason,
    next_attempt_at: nextAt,
  });
  // o webhook segue active enquanto há retry pela frente; registra o erro e incrementa o contador.
  await e.setWebhookStatus(hook.id, "active", {
    failure_count: (hook.failure_count ?? 0) + 1,
    last_error: reason,
  });
  await touchLastDelivery(brain, hook.id, nowIso);
}

/** marca a entrega DEAD e desliga o webhook (status='failed') — o dono religa via DELETE+recriar/registro. */
async function markDead(
  brain: string,
  e: Awaited<ReturnType<typeof getEngine>>,
  hook: WebhookRow,
  d: WebhookDeliveryRow,
  reason: string,
  responseStatus: number | null,
  nowIso: string,
): Promise<void> {
  await e.markWebhookDelivery(d.id, { status: "dead", response_status: responseStatus, error: reason });
  await e.setWebhookStatus(hook.id, "failed", {
    failure_count: (hook.failure_count ?? 0) + 1,
    last_error: reason,
  });
  await touchLastDelivery(brain, hook.id, nowIso);
}

/** ACHADO 2 — terminação garantida no catch de erro INESPERADO de deliverOne. Um erro não-previsto
 *  (bug, exceção de infra) não derruba o worker (fail-soft), mas re-enfileirar SEM teto faria uma
 *  entrega-veneno (deliver que SEMPRE lança) girar pra sempre: queued→claim→lança→queued→… Aplica o
 *  MESMO teto do caminho normal (retryOrDie): o claim já incrementou d.attempt; quando d.attempt já
 *  atingiu maxRetries, marca DEAD (e best-effort desliga o webhook) em vez de re-enfileirar. Senão,
 *  re-agenda 'queued' com backoff. Exportado p/ teste (prova que uma entrega-veneno morre em <=maxRetries
 *  ciclos, não loopa). best-effort em todos os writes: marcar a falha NUNCA pode derrubar o loop. */
export async function handleUnexpectedDeliveryError(
  brain: string,
  e: Awaited<ReturnType<typeof getEngine>>,
  d: WebhookDeliveryRow,
  opts: WebhookWorkerOpts,
  err: unknown,
): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  const max = maxRetries(opts);
  if (d.attempt >= max) {
    log("deliver-error-dead", { brain, deliveryId: d.id, attempt: d.attempt, max, message });
    await e
      .markWebhookDelivery(d.id, {
        status: "dead",
        error: `erro inesperado na entrega: ${message} — esgotou ${max} tentativas`,
      })
      .catch(() => {});
    // best-effort: desliga o webhook (status='failed') se ainda existir — sem derrubar o loop.
    try {
      const hook = await e.getWebhook(d.webhook_id);
      if (hook) {
        await e.setWebhookStatus(hook.id, "failed", {
          failure_count: (hook.failure_count ?? 0) + 1,
          last_error: `erro inesperado na entrega: ${message}`,
        });
      }
    } catch {
      /* best-effort: marcar o webhook failed não pode derrubar o loop */
    }
    return;
  }
  log("deliver-error", { brain, deliveryId: d.id, attempt: d.attempt, message });
  await e
    .markWebhookDelivery(d.id, {
      status: "queued",
      error: `erro inesperado na entrega: ${message}`,
      next_attempt_at: new Date(Date.now() + backoffSeconds(d.attempt) * 1000).toISOString(),
    })
    .catch(() => {});
}

/** carimba last_delivery_at no webhook (sem mexer no status nem nos contadores). O store por-brain
 *  (setWebhookStatus) não toca last_delivery_at; aqui um UPDATE leve, tenant-neutro na conexão e
 *  ESCOPADO por brain na query (idioma do ingest-queue, ADR-002). best-effort: nunca derruba a entrega. */
async function touchLastDelivery(brain: string, webhookId: string, nowIso: string): Promise<void> {
  if (!brain) return;
  try {
    const sql = await getSharedSql();
    await sql`
      update galeed_webhooks
         set last_delivery_at = ${nowIso}
       where brain = ${brain} and id = ${webhookId}`;
  } catch {
    /* best-effort: o carimbo de last_delivery_at não pode derrubar a entrega */
  }
}

/** Roda o loop. Resolve quando `once` é true (1 ciclo por brain elegível) ou quando draining encerra. */
export async function runWebhookWorker(opts: WebhookWorkerOpts = {}): Promise<void> {
  const idleMs = opts.idleMs ?? Number(process.env.GALEED_WEBHOOK_IDLE_MS ?? 1000);
  const once = opts.once ?? false;
  const leaseMs = opts.leaseMs ?? Number(process.env.GALEED_WEBHOOK_LEASE_MS ?? 60_000);
  log("worker iniciado", { idleMs, once, leaseMs, maxRetries: maxRetries(opts) });

  do {
    if (draining) break;
    let didWork = false;
    let brains: string[] = [];
    try {
      brains = await brainsWithPendingDeliveries();
    } catch (err) {
      // descoberta de brains falhou (DB hiccup) → loga, espera, tenta de novo. NÃO derruba o loop.
      log("scan-error", { message: err instanceof Error ? err.message : String(err) });
    }
    for (const brain of brains) {
      if (draining) break;
      try {
        const e = await getEngine(brain);
        // drena TODAS as entregas elegíveis deste brain neste ciclo (em `once`, no máx 1 por brain).
        for (;;) {
          if (draining) break;
          const d = await e.claimNextWebhookDelivery(leaseMs);
          if (!d) break;
          didWork = true;
          try {
            await deliverOne(brain, d, opts);
          } catch (err) {
            await handleUnexpectedDeliveryError(brain, e, d, opts, err);
          }
          if (once) break; // em `once`, processa no máx 1 entrega por brain
        }
      } catch (err) {
        // erro ao abrir o engine do brain / claim → loga e segue p/ o próximo brain (isolamento).
        log("brain-error", { brain, message: err instanceof Error ? err.message : String(err) });
      }
    }
    if (once) return;
    if (!didWork) await sleep(idleMs);
  } while (!once);
}

/** Entrypoint: instala sinais de shutdown e roda o loop até drenar. */
async function main(): Promise<void> {
  const shutdownTimeoutMs = Number(process.env.WORKER_SHUTDOWN_MS ?? 30_000);
  let shuttingDown = false;
  const onSignal = (sig: string) => {
    if (shuttingDown) {
      log("segundo sinal — saindo já", { sig });
      process.exit(1);
    }
    shuttingDown = true;
    draining = true;
    log("shutdown solicitado — drenando", { sig, shutdownTimeoutMs });
    const t = setTimeout(() => {
      log("timeout de shutdown — saindo", {});
      process.exit(0);
    }, shutdownTimeoutMs);
    t.unref?.();
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));

  let exitCode = 0;
  try {
    await runWebhookWorker({});
  } catch (err) {
    exitCode = 1;
    console.error("[webhook-worker] crash fatal — encerrando com exit 1", err);
  } finally {
    await closeSharedSql().catch(() => {});
    await closeEngines().catch(() => {});
    log("worker encerrado", { exitCode });
    process.exit(exitCode);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function log(msg: string, meta: Record<string, unknown>): void {
  console.error(`[webhook-worker] ${msg}${Object.keys(meta).length ? " " + JSON.stringify(meta) : ""}`);
}

const isEntry = (() => {
  try {
    return import.meta.url === new URL(`file://${process.argv[1]}`).href;
  } catch {
    return false;
  }
})();
if (isEntry) {
  main();
}
