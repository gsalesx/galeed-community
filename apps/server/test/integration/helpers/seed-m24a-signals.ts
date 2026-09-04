/** M24-A · §4.0 — seed COMPARTILHADO do signal-engine (teste de integração §4.6).
 *  Derivado do corpus REAL (lido 2026-06-12): a série canônica de preço da Accelera
 *  (3k→5k→12k→18k→30k, mesma do golden e do seed M23-A), uma série de pedidos mensais de
 *  cliente-norte (cadência regular → D2), e um compromisso vencido do kelvin (shape M23-C:
 *  prazo/com_quem em meta). Brain SEMPRE descartável/sufixado `m24a-signals` — JAMAIS o
 *  Accelera (produção, só-leitura). Seed via engine REAL (upsertPage + putFacts). */
import { getEngine, type FactRow, type PageRow } from "../../../src/core/platform/engine.ts";
import { wipeBrain } from "./db.ts";

const SLUG = "chat-m24a-signals-1";

// página SEM data (datas dos eventos do D2 vêm dos FATOS — a página não polui).
const PAGE: PageRow = {
  slug: SLUG, type: "notas", title: "WhatsApp m24a", date: "", path: "", body: "fixture m24a-signals",
  content_hash: SLUG, tags: [], sensitivity: "publico",
};

function fact(p: Partial<FactRow> & { idx: number; entity: string; predicate: string; value: string; valid_from: string }): FactRow {
  return {
    type: "reunioes", dimension: "decisions", text: "", quote: "", meta: {},
    value_num: null, unit: "", period: "", tier: "", valid_to: "", confidence: 0.6, status: "fato",
    source_slug: SLUG,
    ...p,
  } as FactRow;
}

function seedRows(): FactRow[] {
  const rows: FactRow[] = [];
  let idx = 0;

  // 1) série de preço da Accelera (bitemporal, supersedida).
  const preco: Array<[string, number, string, string, number]> = [
    ["R$ 3 mil", 3000, "2023-08-10", "2024-01-15", 0.7],
    ["R$ 5 mil", 5000, "2024-01-15", "2024-03-20", 0.7],
    ["R$ 12 mil", 12000, "2024-03-20", "2024-06-05", 0.7],
    ["R$ 18 mil", 18000, "2024-06-05", "2025-01-10", 0.7],
    ["R$ 30 mil", 30000, "2025-01-10", "", 0.6],
  ];
  for (const [value, vn, vf, vt, conf] of preco)
    rows.push(fact({ idx: idx++, entity: "accelera", predicate: "preco", value, value_num: vn, valid_from: vf, valid_to: vt, confidence: conf }));

  // 2) pedidos mensais de cliente-norte (cadência regular → D2). Cada um fecha no seguinte;
  //    só o último é vigente. 7 eventos com gap 30 → mediana 30, mad 0.
  const datas = ["2024-06-05", "2024-07-05", "2024-08-04", "2024-09-03", "2024-10-03", "2024-11-02", "2024-12-02"];
  for (let i = 0; i < datas.length; i++) {
    const vt = i < datas.length - 1 ? datas[i + 1] : "";
    rows.push(fact({ idx: idx++, entity: "cliente-norte", predicate: "pedido", value: `pedido-${i + 1}`, valid_from: datas[i], valid_to: vt }));
  }

  // 3) compromisso vencido do kelvin (shape M23-C).
  rows.push(fact({
    idx: idx++, entity: "kelvin", predicate: "compromisso", value: "enviar a proposta do ERP",
    valid_from: "2024-12-10", valid_to: "", confidence: 0.6,
    meta: { prazo: "2025-01-15", com_quem: "time" },
  }));

  return rows;
}

/** wipe + seed via engine REAL. Idempotente. */
export async function seedM24aSignals(brain: string): Promise<void> {
  await wipeBrain(brain);
  const e = await getEngine(brain);
  await e.upsertPage(PAGE);
  await e.putFacts(seedRows());
}
