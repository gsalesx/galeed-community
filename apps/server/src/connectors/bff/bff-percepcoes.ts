/** M24-E — leitura das PERCEPÇÕES do cérebro (saída do sono M24-A/C/D) pro front.
 *  Handler PURO (recebe home/params, devolve objeto serializável ou lança BffError) — espelha
 *  bff-m9.ts. Motor intocável: só importa engine. ZERO LLM. RBAC: o web-server valida sessão+
 *  membership via requireBrain ANTES de chamar (mesmo nível das demais leituras do dono). */
import { getEngine, type PercepcaoRow, type PercepcaoEstado } from "../../core/platform/engine.ts";
import { BffError } from "./bff-common.ts";

/** Percepção no shape que o front consome (reduz PercepcaoRow: cites → slugs únicos). */
export interface PercepcaoView {
  id: string;
  classe: string;
  severidade: "alta" | "media" | "baixa" | "info";
  entity: string;
  predicate: string;
  tier: string;
  texto: string;
  numbers: Record<string, number | string>;
  cites: { source_slugs: string[] };
  estado: PercepcaoEstado;
  created_at: string;
  validated_at: string;
}
export interface PercepcoesPage {
  items: PercepcaoView[];
  counts: { viva: number; stale: number; arquivada: number };
  limit: number;
  offset: number;
}

const ESTADO_OK = new Set(["viva", "stale", "arquivada", "todas"]);
const LIMIT_DEFAULT = 50;
const LIMIT_MAX = 200;

function toView(p: PercepcaoRow): PercepcaoView {
  return {
    id: p.id,
    classe: p.classe,
    severidade: p.severidade,
    entity: p.entity,
    predicate: p.predicate,
    tier: p.tier,
    texto: p.texto,
    numbers: p.numbers ?? {},
    cites: { source_slugs: [...new Set((p.cites ?? []).map((c) => c.source_slug).filter(Boolean))] },
    estado: p.estado,
    created_at: p.created_at ?? "",
    validated_at: p.validated_at ?? "",
  };
}

/** GET /api/percepcoes → PercepcoesPage. estado default "viva"; "todas" = sem filtro.
 *  Paginação simples (limit clampado 1..200, offset ≥0). Ordenação vem do engine (C):
 *  created_at desc, id asc. */
export async function percepcoesHandler(
  home: string,
  opts: { estado?: string; limit?: number; offset?: number } = {},
): Promise<PercepcoesPage> {
  const estado = opts.estado || "viva";
  if (!ESTADO_OK.has(estado)) {
    throw new BffError(400, 'estado inválido — use "viva", "stale", "arquivada" ou "todas".');
  }
  const limit = Math.max(1, Math.min(LIMIT_MAX, Math.floor(opts.limit || LIMIT_DEFAULT)));
  const offset = Math.max(0, Math.floor(opts.offset || 0));
  const e = await getEngine(home);
  const rows = await e.listPercepcoes({
    ...(estado === "todas" ? {} : { estado: estado as PercepcaoEstado }),
    limit,
    offset,
  });
  const counts = await e.percepcaoCounts();
  return { items: rows.map(toView), counts, limit, offset };
}
