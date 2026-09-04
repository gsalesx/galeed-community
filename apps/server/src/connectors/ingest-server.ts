#!/usr/bin/env -S npx tsx
/** Conector universal de ingestão — endpoint HTTPS que engole eventos e chama `capture`.
 *  Todo canal que fala webhook (notetakers, Zapier/Make, WhatsApp Cloud, Twilio, Gmail) cai aqui.
 *  Roda na VPS da empresa (HTTPS via Traefik). Zero dependência npm (node:http).
 *
 *  POST /ingest   body JSON:
 *    { text?, doc_base64?, type?, title?, date?, people?[], external_id?, source?, area?, sensitivity? }
 *    - external_id         → idempotência (re-post não duplica)
 *    - area/sensitivity    → classificação de acesso explícita (M7/R16); se ausentes, resolvidas do canal (`source`)
 *    - doc_url/audio_url   → 410 até o M22 (SSRF): buscar URL arbitrária a partir do servidor é SSRF
 *  GET  /health
 *
 *  Auth: FAIL-CLOSED. Sem INGEST_TOKEN configurado → 503 (ingestão desabilitada). Com token,
 *    exige header `x-galeed-token`. Ausência de config NUNCA é escrita anônima aberta.
 *  Brain: GALEED_HOME (ou passe home em startIngestServer).
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { brainHome } from "../core/platform/brain.ts";
import { capture } from "../core/ingestion/capture.ts";
import { buildIndex } from "../core/retrieval/indexer.ts";
import { ingestDocument } from "../core/ingestion/ingest-doc.ts";
// P0 (#7) — scan pré-parse anti-DoS EXTRAÍDO p/ src/lib/json-safety.ts (era duplicado aqui). Lança
// HttpError, que carrega `httpCode` (=code) → o catch abaixo (`?? 500`) ainda resolve 400 (idêntico).
import { scanJsonDepthPreParse } from "../lib/json-safety.ts";

// Teto de body do /ingest — CONFIGURÁVEL via INGEST_MAX_BYTES; default 25MB (DoS de memória).
const MAX = Number(process.env.INGEST_MAX_BYTES) || 25 * 1024 * 1024;

/** Compara token recebido x esperado em TEMPO CONSTANTE (não vaza por timing). Iguala
 *  comprimentos via hash sha256 fixo de 32 bytes antes do timingSafeEqual. */
function safeTokenEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let d = "";
    req.on("data", (c) => {
      d += c;
      if (d.length > MAX) reject(new Error(`payload acima do teto de transporte (${MAX} bytes)`)); // conteúdo grande é FATIADO, não rejeitado
    });
    req.on("end", () => resolve(d));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, code: number, obj: unknown) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json" });
  res.end(body);
}

export function startIngestServer(home = brainHome()) {
  const port = Number(process.env.PORT || 8787);
  const token = process.env.INGEST_TOKEN;

  const server = createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/health") return json(res, 200, { ok: true, brain: home });
      if (req.method !== "POST" || req.url !== "/ingest") return json(res, 404, { error: "use POST /ingest ou GET /health" });
      // P0-B (mata A5a): sem INGEST_TOKEN configurado = ingestão DESABILITADA (fail-closed), nunca aberta.
      if (!token)
        return json(res, 503, { error: "INGEST_TOKEN não configurado — ingestão desabilitada (fail-closed). Configure INGEST_TOKEN no ambiente." });
      if (!safeTokenEqual(String(req.headers["x-galeed-token"] ?? ""), token)) return json(res, 401, { error: "token inválido" });

      const rawBody = (await readBody(req)) || "{}";
      scanJsonDepthPreParse(rawBody); // P0 — barra aninhamento absurdo ANTES do JSON.parse (anti-crash)
      const payload = JSON.parse(rawBody);

      // P0-B (mata o SSRF do A5a): buscar URL arbitrária a partir do servidor é SSRF. DESLIGADO até o
      // M22 (conectores), onde volta com allowlist. 410 = removido de propósito, não "ainda não existe".
      if (payload.doc_url)
        return json(res, 410, { error: "doc_url foi desligado (risco SSRF) — envie o arquivo como doc_base64. Ingestão por URL volta no M22 (conectores), com allowlist." });
      if (payload.audio_url)
        return json(res, 410, { error: "audio_url foi desligado (risco SSRF) — transcrição por URL volta no M22 (conectores), com allowlist." });

      // DOCUMENTO (PDF/CSV/TSV/MD/TXT): doc_base64 → extrai, FATIA e captura N páginas-slice
      if (payload.doc_base64) {
        const buffer = Buffer.from(payload.doc_base64, "base64");
        const r = await ingestDocument({
          home,
          buffer,
          contentType: payload.content_type,
          filename: payload.filename,
          title: payload.title,
          date: payload.date,
          source: payload.source || "upload",
          externalId: payload.external_id,
          type: payload.type,
        });
        if (r.total > r.skipped) await buildIndex(home);
        return json(res, 200, r);
      }

      const text: string = payload.text || "";
      if (!text.trim()) return json(res, 400, { error: "faltou text ou doc_base64 (audio_url/doc_url estão desligados até o M22)" });

      // INGESTÃO AUTÔNOMA: type/title são OPCIONAIS. Sem eles, o cérebro classifica sozinho
      // (TEMPO 1). "Só joga que a gente organiza" — o payload mínimo é { text } ou { doc_base64 }.
      // M-PAY-H (cobertura de débito): conector interno = NÃO COBRADO. Este endpoint é o conector
      // universal (auth por INGEST_TOKEN, tráfego de operação/integração, NÃO carteira de cliente) e
      // chama capture() do core DIRETO — de propósito SEM gateAndDebit. Ver CREDIT_COST.capture
      // (reservado) em core/platform/credits.ts. O débito de cliente é só na borda billada `/api/ingest`.
      const r = await capture({
        home,
        text,
        type: payload.type, // opcional
        title: payload.title, // opcional
        date: payload.date,
        people: payload.people,
        source: payload.source, // pista pro classificador (whatsapp, notetaker, email...)
        externalId: payload.external_id,
        // M7/R16 — classificação de acesso na entrada. Override explícito do cliente (opcional);
        // se ausente, o capture resolve a política do canal a partir de `source` (fail-closed → 'restrito').
        area: payload.area,
        sensitivity: payload.sensitivity,
      });
      if (!r.skipped) await buildIndex(home); // FTS imediato (sem embeddings; reconcile assíncrono à parte)
      return json(res, 200, r);
    } catch (e) {
      const code = (e as Error & { httpCode?: number }).httpCode ?? 500;
      return json(res, code, { error: (e as Error).message });
    }
  });

  server.listen(port, () => console.error(`🌐 galeed ingest no ar :${port}  (brain: ${home}, auth: ${token ? "on" : "FAIL-CLOSED (sem INGEST_TOKEN — POST /ingest 503)"})`));
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) startIngestServer();
