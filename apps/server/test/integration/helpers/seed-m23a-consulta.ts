/** M23-A — seed COMPARTILHADO (teste de integração §4.5 + ANTES/DEPOIS via CLI §4.6). Estilo do
 *  corpus real (S0): 2 páginas WhatsApp com timestamps por mensagem + a série bitemporal de preço
 *  da Accelera (3k→5k→12k→18k→30k) + atributos não-numéricos (aluno_de, plano, clientes).
 *  Brain SEMPRE descartável/sufixado `m23a-consulta` — JAMAIS o Accelera (produção, só-leitura). */
import { getEngine, type FactRow, type PageRow } from "../../../src/core/platform/engine.ts";
import { wipeBrain } from "./db.ts";

const SLUG1 = "chat-m23a-consulta-1";
const SLUG2 = "chat-m23a-consulta-2";

const BODY1 =
  "[2024-03-20 10:02:11] Kelvin: o preço da Accelera agora é R$ 12 mil.\n" +
  "[2024-04-02 09:15:00] Teobaldo: Bom dia pessoal, acabei de entrar na Accelera 360!";
const BODY2 =
  "Eduardo Marinho - Aluno - Accelera 360\n" +
  "[2024-05-10 14:30:00] Eduardo Marinho: fechei o plano Pocket hoje, bora!";

function page(slug: string, title: string, date: string, body: string): PageRow {
  return { slug, type: "notas", title, date, path: "", body, content_hash: slug, tags: [], sensitivity: "publico" };
}

function fact(p: Partial<FactRow> & { idx: number; entity: string; predicate: string; value: string; valid_from: string; source_slug: string }): FactRow {
  return {
    type: "reunioes", dimension: "decisions", text: "", quote: "", meta: {},
    value_num: null, unit: "", period: "", tier: "", valid_to: "", confidence: 0.7, status: "fato",
    ...p,
  } as FactRow;
}

function seedRows(): FactRow[] {
  const rows: FactRow[] = [];
  let idx = 0;
  // série de preço (bitemporal, supersedida)
  const preco: Array<[string, number, string, string]> = [
    ["R$ 3 mil", 3000, "2023-08-10", "2024-01-15"],
    ["R$ 5 mil", 5000, "2024-01-15", "2024-03-20"],
    ["R$ 12 mil", 12000, "2024-03-20", "2024-06-05"],
    ["R$ 18 mil", 18000, "2024-06-05", "2025-01-10"],
    ["R$ 30 mil", 30000, "2025-01-10", ""],
  ];
  for (const [value, vn, vf, vt] of preco)
    rows.push(fact({ idx: idx++, entity: "accelera", predicate: "preco", value, value_num: vn, unit: "BRL", period: "monthly", valid_from: vf, valid_to: vt, source_slug: SLUG1, quote: `o preço da Accelera agora é ${value}.` }));
  // 10 fatos de clientes (ruído não-numérico)
  for (let i = 0; i < 10; i++)
    rows.push(fact({ idx: idx++, entity: "accelera", predicate: "clientes", value: `cliente-${i}`, valid_from: `2024-01-${String(i + 1).padStart(2, "0")}`, source_slug: SLUG1 }));
  // atributos das pessoas
  rows.push(fact({ idx: idx++, entity: "teobaldo", predicate: "aluno_de", value: "accelera 360", valid_from: "2024-04-02", source_slug: SLUG1, quote: "Bom dia pessoal, acabei de entrar na Accelera 360!" }));
  rows.push(fact({ idx: idx++, entity: "eduardo-marinho", predicate: "plano", value: "Pocket", valid_from: "2024-05-10", source_slug: SLUG2, quote: "fechei o plano Pocket hoje, bora!" }));
  rows.push(fact({ idx: idx++, entity: "eduardo-marinho", predicate: "aluno_de", value: "accelera 360", valid_from: "2024-05-10", source_slug: SLUG2, quote: "Eduardo Marinho - Aluno - Accelera 360" }));
  return rows;
}

/** wipe + seed via engine REAL. Idempotente. */
export async function seedM23aConsulta(brain: string): Promise<void> {
  await wipeBrain(brain);
  const e = await getEngine(brain);
  await e.upsertPage(page(SLUG1, "Chat Accelera 1", "2024-03-20", BODY1));
  await e.upsertPage(page(SLUG2, "Chat Accelera 2", "2024-05-10", BODY2));
  await e.putFacts(seedRows());
}
