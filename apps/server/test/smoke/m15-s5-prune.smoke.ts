/** M15/S5 (gap-S3-cut) — smoke do CONTRACT: prova o CORTE por-mensagem no CAMINHO REAL
 *  (`buildExtractionUnits`), o `triageText` sem scaffold/timestamp, e o recall (fato presente).
 *  SEM LLM, SEM IO — monta um PageRow real e roda `buildExtractionUnits(page)`.
 *
 *  Asserts (CONTRACT §2/§3):
 *   (a) um segmento INTEIRAMENTE social ("kkkk"/"bom dia"/emoji ×N) → 0 units (some);
 *   (b) numa unit MISTA: body NÃO contém "kkkk"/"bom dia" (mensagens-ruído podadas);
 *   (c) a unit com "R$ 30 mil" está PRESENTE (recall — salvaguarda number → worthy);
 *   (d) nenhuma `triageText` casa /\(\d{4}-\d{2}-\d{2}T/ nem contém "Bruno (" (sem scaffold Speaker/ISO).
 */
import { buildExtractionUnits } from "../../src/core/ingestion/segment.ts";
import type { PageRow } from "../../src/core/platform/engine.ts";

let failed = 0;
const check = (ok: boolean, label: string) => {
  console.log(`${ok ? "  ok  " : "FAIL  "} ${label}`);
  if (!ok) failed++;
};

// Forma 2 do parser (conversation.ts): "Nome (YYYY-MM-DD HH:MM): texto".
// Bloco 1 (mistura: fato de preço entre ruído). Bloco 2 (>30min depois → novo segmento, TODO social).
const lines = [
  // --- segmento misto (perto no tempo) ---
  "Bruno (2026-01-10 11:00): kkkk",
  "Ana (2026-01-10 11:01): bom dia",
  "Bruno (2026-01-10 11:02): fechamos o plano enterprise por R$ 30 mil por mês",
  "Ana (2026-01-10 11:03): 👍",
  "Bruno (2026-01-10 11:04): combinado, a Accelera assina o contrato amanhã",
  // --- gap > 30min → novo segmento, TODO social ---
  "Ana (2026-01-10 15:00): kkkkk",
  "Bruno (2026-01-10 15:01): haha",
  "Ana (2026-01-10 15:02): valeu",
  "Bruno (2026-01-10 15:03): 😂",
];

const page: PageRow = {
  slug: "smoke-s5",
  type: "conversa",
  title: "Call de venda Accelera",
  date: "2026-01-10",
  path: "",
  body: lines.join("\n"),
  content_hash: "smoke-s5",
};

const units = buildExtractionUnits(page);
console.log(`\nbuildExtractionUnits → ${units.length} unit(s) (de 2 segmentos no input)\n`);
for (const [i, u] of units.entries()) {
  console.log(`[unit ${i}] body=${JSON.stringify(u.body.slice(0, 120))} | triageText=${JSON.stringify(u.triageText.slice(0, 120))}`);
}
console.log("");

// (a) o segmento todo-social (bloco 2) sumiu: a única unit emitida é a do bloco misto.
check(units.length === 1, "(a) segmento inteiramente social → 0 units (1 unit total, não 2)");

const mixed = units[0];
const allBody = units.map((u) => u.body).join("\n");
const allTriage = units.map((u) => u.triageText).join("\n");

// (b) ruído podado da unit mista.
check(!!mixed && !/kkkk/i.test(mixed.body), "(b) body da unit mista NÃO contém 'kkkk' (ruído podado)");
check(!!mixed && !/bom dia/i.test(mixed.body), "(b) body da unit mista NÃO contém 'bom dia' (ruído podado)");

// (c) recall: o fato de preço sobrevive (number → worthy no nível da mensagem).
check(/R\$ 30 mil/.test(allBody), "(c) RECALL: 'R$ 30 mil' presente no body (salvaguarda number)");
check(/Accelera/.test(allBody), "(c) RECALL: msg de contrato 'Accelera' presente no body");

// (d) triageText sem scaffold/timestamp ISO.
check(!/\(\d{4}-\d{2}-\d{2}T/.test(allTriage), "(d) nenhuma triageText casa /\\(\\d{4}-\\d{2}-\\d{2}T/ (sem timestamp ISO)");
check(!/Bruno \(|Ana \(/.test(allTriage), "(d) triageText NÃO contém scaffold 'Speaker ('");
check(/R\$ 30 mil/.test(allTriage), "(d) triageText carrega o texto semântico do fato ('R$ 30 mil')");

// triageText presente em TODA unit.
check(units.every((u) => typeof u.triageText === "string"), "triageText presente (string) em TODA unit");

if (failed > 0) {
  console.error(`\n✗ SMOKE FALHOU: ${failed} assert(s).`);
  process.exit(1);
}
console.log("\n✓ SMOKE OK — corte por-mensagem materializa, triageText sem scaffold, recall do fato.");
