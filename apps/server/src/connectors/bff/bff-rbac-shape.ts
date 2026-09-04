/** M10/S3 (extraído de web-server.ts no reconcile) — SHAPE de leitura do front para principais RBAC.
 *  Campos COSMÉTICOS derivados do M7 real (PrincipalRow + GrantRow); NÃO inventam acesso. Vive aqui
 *  (e não inline no web-server.ts) pra os handlers de ESCRITA (bff-rbac-write.ts) devolverem o MESMO
 *  shape que /api/rbac/principals — sem duplicar a função. Zona neutra do Integrador. */
import { sensitivityRank, type GrantRow, type PrincipalRow, type TokenRow } from "../../core/platform/engine.ts";

/** Capitaliza um slug de área p/ label legível ("vendas" → "Vendas", "pessoas-rh" → "Pessoas Rh"). */
export function labelOfArea(slug: string): string {
  if (slug === "*") return "Todas as áreas"; // acesso total (scope.ts/AREA_TOTAL)
  return slug
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Mapeia o teto de sensibilidade do grant → UiLevel {code,label,rank} que o selo do front consome.
 *  rank = rank ordinal do nível (0=publico…3=restrito); code/label espelham o componente LockChip. */
export function uiLevelOf(sensitivityMax: string): { code: string; label: string; rank: number } {
  const rank = sensitivityRank(sensitivityMax); // 0..3, fail-closed
  const map: Record<number, { code: string; label: string }> = {
    0: { code: "open", label: "Público" },
    1: { code: "int", label: "Interno" },
    2: { code: "conf", label: "Sigiloso" },
    3: { code: "secret", label: "Secreto" },
  };
  const m = map[rank] ?? map[3];
  return { ...m, rank };
}

/** Monta o shape `Principal` (web/src/lib/api.ts) a partir do PrincipalRow + GrantRow + TokenRow[]
 *  reais do M7. Campos COSMÉTICOS derivados (não inventam acesso): subline (do kind), areas_labels
 *  (capitalize das áreas do grant), ui_level (do teto), tokens (hash truncado + metadados). */
export function toPrincipalShape(p: PrincipalRow, grant: GrantRow | undefined, tokens: TokenRow[] = []): unknown {
  const areas = grant?.areas ?? [];
  const sensitivityMax = grant?.sensitivity_max ?? "publico";
  return {
    id: p.id,
    kind: p.kind,
    label: p.label,
    email: p.email ?? "",
    status: p.status ?? "active",
    subline: p.kind === "agent" ? "agente · acessa por token" : "pessoa · acessa por login",
    grant: {
      areas,
      sensitivity_max: sensitivityMax,
      deny_types: grant?.deny_types ?? [],
      scope: grant?.scope ?? "read",
      can_ingest: grant?.can_ingest === true, // capacidade de escrita; fail-closed (ausente = false)
    },
    tokens: tokens.map((t) => ({
      label: t.label ?? "",
      last4: t.token_hash.slice(-4), // id cosmético estável (hash, não a chave crua)
      revoked: !!t.revoked,
      last_used_at: t.last_used_at ?? null,
    })),
    ui_level: uiLevelOf(sensitivityMax),
    areas_labels: areas.map(labelOfArea),
  };
}
