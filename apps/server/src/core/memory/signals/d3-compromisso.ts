/** M24-A · D3 — compromisso vencido (BRIEF §3-D3): join determinístico sobre a classe M23-C.
 *  Shape REAL (docs/M23-receitas-nao-numericas-CONVENCAO.md, verificado no gate
 *  test/integration/m23c-receitas-fila.test.ts): predicate FIXO "compromisso" (vem da
 *  RECEITA), entity = quem se comprometeu, value = o que prometeu, valid_from = quando
 *  COMBINOU, e o PRAZO viaja em meta.prazo (ISO, só quando ancorável no texto) — derivePageFacts
 *  grava o item cru inteiro em galeed_facts.meta. Os nomes "compromisso"/"prazo"/"concluido"
 *  são config com default (são convenção de DADO, não literal de core).
 *  "Sem fato de conclusão no grupo" (v1, determinístico): vencido = versão VIGENTE
 *  (valid_to === "") com prazo < hoje e sem marcador meta[metaConcluido] truthy. Compromisso
 *  SUPERSEDED (a cadeia ganhou versão mais nova) NÃO é flagado — a classe "conclusão" não
 *  existe no M23-C; tratar supersessão como resolução é a leitura conservadora (anotado;
 *  refinamento é decisão do M24-C/v1.1, não deste slot). Zero LLM. */
import {
  type Signal,
  type SignalConfig,
  type SignalInputs,
  severidade,
} from "./types.ts";
import { diaUtc } from "./d1-tendencia.ts";

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const ISO_DATE_EXATA = /^\d{4}-\d{2}-\d{2}$/;

export function detectCompromissoVencido(inputs: SignalInputs, cfg: SignalConfig): Signal[] {
  const out: Signal[] = [];
  const hojeDia = diaUtc(inputs.hoje);

  for (const g of inputs.grupos) {
    if (g.predicate !== cfg.d3.predicado) continue;
    for (const f of g.facts) {
      // 1) candidato: status fato, vigente, meta.prazo ISO exata, não concluído.
      if (f.status !== "fato") continue;
      if (f.valid_to !== "") continue;
      const prazo = f.meta?.[cfg.d3.metaPrazo];
      if (typeof prazo !== "string" || !ISO_DATE_EXATA.test(prazo)) continue;
      if (f.meta?.[cfg.d3.metaConcluido]) continue;

      // 2) vencido?
      const diasVencidos = hojeDia - diaUtc(prazo);
      if (diasVencidos <= 0) continue;

      // 3) efeito.
      const efeito = clamp01(diasVencidos / cfg.d3.refDias);

      // 4) numeros, baseFacts, janela.
      const numeros: Record<string, number> = { diasVencidos, refDias: cfg.d3.refDias };
      const vf = f.valid_from.slice(0, 10);

      // 5) resumo.
      const resumo = `${f.entity}: compromisso "${f.value}" combinado em ${vf}, prazo ${prazo} vencido há ${diasVencidos} dias, sem registro de conclusão`;

      out.push({
        detector: "d3_compromisso_vencido",
        classe: "compromisso_vencido",
        efeito,
        severidade: severidade(efeito, cfg),
        entities: [f.entity],
        baseFacts: [{ entity: f.entity, predicate: f.predicate, tier: f.tier, valid_from: f.valid_from, source_slug: f.source_slug }],
        minConfidence: f.confidence,
        numeros,
        janela: { de: vf, ate: prazo },
        resumo,
      });
    }
  }
  return out;
}
