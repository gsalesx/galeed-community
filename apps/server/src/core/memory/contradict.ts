/** Detecção de contradição (S4/M2) — candidatos determinísticos + pré-filtro de data + juiz LLM
 *  opcional. NUNCA auto-mutila a verdade: só REGISTRA em galeed_contradictions. TEMPO 2.
 *  A supersessão bitemporal só resolve o caso fácil (mesma entity+predicate em sequência no tempo);
 *  conflitos concorrentes (mesma data, valores diferentes) passavam batido — este slot os pega. */
import { createHash } from "node:crypto";
import { config } from "../platform/config.ts";
import { resolveProvider, prose } from "../../lib/llm.ts";
import { normalizeValue } from "../../lib/normalize.ts";
import { getEngine, type FactHit, type ContradictionRow } from "../platform/engine.ts";

export interface ContradictOpts {
  useLlm?: boolean;
  limit?: number;
}
export interface ContradictResult {
  candidates: number;
  judged: number;
  ignored: number; // candidatos além do teto (logados, nunca descartados em silêncio)
  found: ContradictionRow[];
  provider: string;
}

const JUDGE_SYS =
  "Você julga se dois fatos sobre a MESMA entidade se contradizem. Responda SOMENTE com JSON: " +
  '{"verdict":"contradiz|independente","severity":"alta|media|baixa","confidence":0..1}. ' +
  "Sem texto fora do JSON.";

function pairHash(entity: string, aKey: string, bKey: string): string {
  const sorted = [aKey, bKey].sort().join("::");
  return createHash("sha256").update(`${entity}|${sorted}|v1`).digest("hex").slice(0, 16);
}

function gapDays(a: string, b: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(a) || !/^\d{4}-\d{2}-\d{2}$/.test(b)) return null;
  const da = new Date(a + "T00:00:00Z").getTime();
  const db = new Date(b + "T00:00:00Z").getTime();
  if (isNaN(da) || isNaN(db)) return null;
  return Math.abs(Math.round((da - db) / 86400000));
}

const STOP = new Set(["a", "o", "as", "os", "de", "da", "do", "e", "em", "para", "com", "the", "of", "to"]);
function sigTokens(s: string): Set<string> {
  return new Set(
    s.toLowerCase().split(/[^a-zà-ú0-9]+/i).filter((t) => t.length > 3 && !STOP.has(t)),
  );
}
function shareToken(a: string, b: string): boolean {
  const ta = sigTokens(a);
  for (const t of sigTokens(b)) if (ta.has(t)) return true;
  return false;
}

interface Candidate {
  entity: string;
  a: FactHit;
  b: FactHit;
  rule: "concorrente" | "cross_predicado";
}

/** Detecta candidatos, aplica pré-filtro de data, julga (LLM opcional) e persiste. Idempotente por hash. */
export async function findContradictions(home: string, opts: ContradictOpts = {}): Promise<ContradictResult> {
  const limit = opts.limit ?? 50;
  const e = await getEngine(home);
  const facts = await e.currentFacts();

  // agrupa por entidade canônica
  const byEntity = new Map<string, FactHit[]>();
  for (const f of facts) (byEntity.get(f.entity!) ?? byEntity.set(f.entity!, []).get(f.entity!)!).push(f);

  const cands: Candidate[] = [];
  for (const [entity, group] of byEntity) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i], b = group[j];
        const va = normalizeValue(a.value || ""), vb = normalizeValue(b.value || "");
        if (va === vb) continue; // mesmo valor = não conflita
        if (a.predicate === b.predicate) {
          cands.push({ entity, a, b, rule: "concorrente" }); // mesma relação, valores divergentes, ambos vigentes
        } else if (shareToken(a.text || "", b.text || "")) {
          cands.push({ entity, a, b, rule: "cross_predicado" }); // relação distinta mas textos relacionados
        }
      }
    }
  }

  const cfg = config(home);
  const provider = resolveProvider(cfg.provider);
  const canJudge = opts.useLlm !== false && (provider === "cli" || provider === "api");
  const cache = await e.getContradictionCache();

  const found: ContradictionRow[] = [];
  let judged = 0;
  let sentToJudge = 0;
  let ignored = 0;

  for (const c of cands) {
    const aKey = `${c.a.source_slug}+${normalizeValue(c.a.value || "")}`;
    const bKey = `${c.b.source_slug}+${normalizeValue(c.b.value || "")}`;
    const hash = pairHash(c.entity, aKey, bKey);
    if (cache.has(hash)) continue; // já julgado antes

    const base: ContradictionRow = {
      hash,
      entity: c.entity,
      a_slug: c.a.source_slug,
      a_text: c.a.text || "",
      a_value: c.a.value || "",
      a_valid_from: c.a.valid_from || "",
      b_slug: c.b.source_slug,
      b_text: c.b.text || "",
      b_value: c.b.value || "",
      b_valid_from: c.b.valid_from || "",
      rule: c.rule,
      verdict: "suspeita",
      severity: c.rule === "concorrente" ? "media" : "baixa",
      confidence: 0.5,
    };

    // pré-filtro de data (SÓ p/ mesmo predicado): gap > 30d com ambas datadas → evolução, não contradição.
    // Em cross_predicado o gap não significa evolução (predicados diferentes), então não aplica.
    const gap = c.rule === "concorrente" ? gapDays(c.a.valid_from || "", c.b.valid_from || "") : null;
    if (gap !== null && gap > 30) {
      base.verdict = "evolucao";
      base.severity = "info";
      await e.putContradiction(base);
      found.push(base);
      continue;
    }

    // juiz LLM (respeitando o teto de custo)
    if (canJudge && sentToJudge < limit) {
      sentToJudge++;
      try {
        const out = await prose({
          provider,
          model: provider === "cli" ? cfg.cliModel : cfg.apiModel,
          system: JUDGE_SYS,
          prompt: `Entidade: ${c.entity}\nFato A (${c.a.predicate}=${c.a.value}): ${c.a.text}\nFato B (${c.b.predicate}=${c.b.value}): ${c.b.text}`,
        });
        const m = out.match(/\{[\s\S]*\}/);
        if (m) {
          const v = JSON.parse(m[0]);
          let verdict = v.verdict === "contradiz" ? "contradiz" : "independente";
          const confidence = typeof v.confidence === "number" ? v.confidence : 0.6;
          if (verdict === "contradiz" && confidence < 0.7) verdict = "independente"; // piso anti-ruído
          base.verdict = verdict as ContradictionRow["verdict"];
          base.severity = ["alta", "media", "baixa"].includes(v.severity) ? v.severity : base.severity;
          base.confidence = confidence;
          judged++;
        }
      } catch {
        /* mantém suspeita */
      }
    } else if (canJudge && sentToJudge >= limit) {
      ignored++; // além do teto: fica 'suspeita' (registrado), nunca descartado em silêncio
    }

    await e.putContradiction(base);
    found.push(base);
  }

  return { candidates: cands.length, judged, ignored, found, provider: canJudge ? provider : "none" };
}

export async function listContradictions(home: string): Promise<ContradictionRow[]> {
  return (await getEngine(home)).allContradictions();
}
