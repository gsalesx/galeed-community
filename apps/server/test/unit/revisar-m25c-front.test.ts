/** M25-C — testes PUROS da lógica da tela Revisar em escala (zero IO).
 *
 *  Fixtures DERIVADAS DO CORPUS REAL (M25-C-DESIGN-SPEC §3.0 — lido por SQL no banco docker
 *  galeed-db :5434, brain `accelera360-mentoria`, em 2026-06-12). Os números abaixo são a fila
 *  REAL que a tela vai encarar:
 *    1.086 pendentes · 11 grupos (reason × dimension × source_id):
 *      fora_da_receita × claims       × Calls e reuniões transcritas   832  ← o grupão
 *      fora_da_receita × objecoes     × Calls e reuniões transcritas   130
 *      fora_da_receita × precos       × Calls e reuniões transcritas    41
 *      nao_ancorado    × facts        × Grupos de WhatsApp              36
 *      fora_da_receita × relacoes     × Vídeos do YouTube               13
 *      conexao_sugerida× conexao      × (source_id = "")                10  ← SEM fonte (sonho)
 *      nao_ancorado    × decisoes     × Calls e reuniões transcritas     7
 *      nao_ancorado    × facts        × Vídeos do YouTube                7
 *      fora_da_receita × compromissos × Vídeos do YouTube                4
 *      nao_ancorado    × relacoes     × Grupos de WhatsApp               4
 *      nao_ancorado    × decisoes     × Grupos de WhatsApp               2
 *  fontes: a43a3687 "Grupos de WhatsApp" · c7347150 "Vídeos do YouTube"
 *          · c8575e79 "Calls e reuniões transcritas".
 *
 *  ADENDO DO ÁRBITRO (§9): calibração usa `decididos`/`acerto` (não `n`/`taxa`).
 */
import { describe, it, expect } from "vitest";
import {
  abaInicial,
  acoesDoGrupo,
  decisaoDoGrupo,
  ordenaGrupos,
  separaPrecisaDeVoce,
  filtraGrupo,
  resumoLote,
  rotuloRecomendacao,
  segmentoDoGrupo,
  rotuloAcerto,
  fmtCustoUsd,
  juizNuncaRodou,
  triagemEmAndamento,
} from "../../../web/src/screens/Revisar/logic.ts";
import type {
  Hypothesis, HypothesisGroup, JudgeCalibration, JudgeCalibrationSegment, JudgeRun,
} from "../../../web/src/lib/api.ts";

// ids reais das fontes (§3.0)
const SRC_CALLS = "c8575e79";
const SRC_WHATS = "a43a3687";
const SRC_YT = "c7347150";

// --- helpers de fixture ---
function grupo(over: Partial<HypothesisGroup> = {}): HypothesisGroup {
  return {
    reason: "fora_da_receita",
    dimension: "claims",
    source_id: SRC_CALLS,
    source_name: "Calls e reuniões transcritas",
    count: 832,
    decisao: "",
    amostra: [],
    ...over,
  };
}
function hip(over: Partial<Hypothesis> = {}): Hypothesis {
  return {
    id: "x".repeat(40),
    source_id: SRC_CALLS,
    source_name: "Calls e reuniões transcritas",
    source_slug: "calls",
    dimension: "claims",
    text: "André está no ramo de clínicas",
    quote: "Eh, eu tenho brevemente assim lembrança…",
    reason: "fora_da_receita",
    status: "pendente",
    decided_by: "",
    ...over,
  };
}

/** Os 11 grupos reais do corpus (§3.0), counts carimbados. */
function gruposReais(): HypothesisGroup[] {
  return [
    grupo({ reason: "fora_da_receita", dimension: "claims", source_id: SRC_CALLS, count: 832 }),
    grupo({ reason: "fora_da_receita", dimension: "objecoes", source_id: SRC_CALLS, count: 130 }),
    grupo({ reason: "fora_da_receita", dimension: "precos", source_id: SRC_CALLS, count: 41 }),
    grupo({ reason: "nao_ancorado", dimension: "facts", source_id: SRC_WHATS, source_name: "Grupos de WhatsApp", count: 36 }),
    grupo({ reason: "fora_da_receita", dimension: "relacoes", source_id: SRC_YT, source_name: "Vídeos do YouTube", count: 13 }),
    grupo({ reason: "conexao_sugerida", dimension: "conexao", source_id: "", source_name: "", count: 10 }),
    grupo({ reason: "nao_ancorado", dimension: "decisoes", source_id: SRC_CALLS, count: 7 }),
    grupo({ reason: "nao_ancorado", dimension: "facts", source_id: SRC_YT, source_name: "Vídeos do YouTube", count: 7 }),
    grupo({ reason: "fora_da_receita", dimension: "compromissos", source_id: SRC_YT, source_name: "Vídeos do YouTube", count: 4 }),
    grupo({ reason: "nao_ancorado", dimension: "relacoes", source_id: SRC_WHATS, source_name: "Grupos de WhatsApp", count: 4 }),
    grupo({ reason: "nao_ancorado", dimension: "decisoes", source_id: SRC_WHATS, source_name: "Grupos de WhatsApp", count: 2 }),
  ];
}

// ---------------------------------------------------------------------------
// 1. abaInicial
// ---------------------------------------------------------------------------
describe("abaInicial", () => {
  it("null (carregando) → pendente", () => expect(abaInicial(null)).toBe("pendente"));
  it("0 → pendente", () => expect(abaInicial(0)).toBe("pendente"));
  it("30 (no limite) → pendente", () => expect(abaInicial(30)).toBe("pendente"));
  it("31 → grupos", () => expect(abaInicial(31)).toBe("grupos"));
  it("1086 (corpus real) → grupos", () => expect(abaInicial(1086)).toBe("grupos"));
});

// ---------------------------------------------------------------------------
// 2. acoesDoGrupo — tabela de verdade completa
// ---------------------------------------------------------------------------
describe("acoesDoGrupo", () => {
  it("grupão real (fora_da_receita, sem recomendacoes) → receita, descartar, um_a_um", () => {
    const g = grupo({ reason: "fora_da_receita", dimension: "claims", source_id: SRC_CALLS, count: 832 });
    expect(acoesDoGrupo(g)).toEqual(["receita", "descartar", "um_a_um"]);
  });
  it("grupão com recomendacoes.aprovar>0 → + aprovar_recomendados", () => {
    const g = grupo({
      reason: "fora_da_receita", dimension: "claims", source_id: SRC_CALLS, count: 832,
      recomendacoes: { aprovar: 230, descartar: 500, humano: 102, sem_recomendacao: 0 },
    });
    expect(acoesDoGrupo(g)).toEqual(["receita", "aprovar_recomendados", "descartar", "um_a_um"]);
  });
  it("nao_ancorado (facts × WhatsApp) sem rec → descartar, um_a_um", () => {
    const g = grupo({ reason: "nao_ancorado", dimension: "facts", source_id: SRC_WHATS, count: 36 });
    expect(acoesDoGrupo(g)).toEqual(["descartar", "um_a_um"]);
  });
  it("nao_ancorado com aprovar:5 → aprovar_recomendados, descartar, um_a_um", () => {
    const g = grupo({
      reason: "nao_ancorado", dimension: "facts", source_id: SRC_WHATS, count: 36,
      recomendacoes: { aprovar: 5, descartar: 10, humano: 1, sem_recomendacao: 20 },
    });
    expect(acoesDoGrupo(g)).toEqual(["aprovar_recomendados", "descartar", "um_a_um"]);
  });
  it("conexao_sugerida (source_id='') → SEMPRE um_a_um, descartar — mesmo com aprovar>0", () => {
    const g = grupo({
      reason: "conexao_sugerida", dimension: "conexao", source_id: "", source_name: "", count: 10,
      recomendacoes: { aprovar: 8, descartar: 0, humano: 2, sem_recomendacao: 0 },
    });
    expect(acoesDoGrupo(g)).toEqual(["um_a_um", "descartar"]);
  });
  it("fora_da_receita com source_id='' (defensivo) → SEM receita (cai no caminho sem fonte)", () => {
    const g = grupo({ reason: "fora_da_receita", dimension: "claims", source_id: "", source_name: "", count: 5 });
    expect(acoesDoGrupo(g)).toEqual(["um_a_um", "descartar"]);
  });
});

// ---------------------------------------------------------------------------
// 3. decisaoDoGrupo
// ---------------------------------------------------------------------------
describe("decisaoDoGrupo", () => {
  it("decisao não-vazia vence o fallback", () => {
    const g = grupo({ decisao: "frase pronta do A" });
    expect(decisaoDoGrupo(g)).toBe("frase pronta do A");
  });
  it("fora_da_receita → fallback com source_name e dimension", () => {
    const g = grupo({ reason: "fora_da_receita", dimension: "claims", source_name: "Calls e reuniões transcritas", decisao: "" });
    expect(decisaoDoGrupo(g)).toBe('A receita da fonte "Calls e reuniões transcritas" não tem a dimensão "claims".');
  });
  it("nao_ancorado → fallback EXATO", () => {
    expect(decisaoDoGrupo(grupo({ reason: "nao_ancorado", decisao: "" }))).toBe(
      "O número ou a citação destes itens não confere com o texto original.",
    );
  });
  it("entidade_vaga → fallback EXATO", () => {
    expect(decisaoDoGrupo(grupo({ reason: "entidade_vaga", decisao: "" }))).toBe(
      "Nestes itens não dá pra saber de quem ou do quê se fala.",
    );
  });
  it("conexao_sugerida → fallback EXATO", () => {
    expect(decisaoDoGrupo(grupo({ reason: "conexao_sugerida", decisao: "" }))).toBe(
      "O sono do cérebro sugeriu estas conexões entre entidades do mapa.",
    );
  });
});

// ---------------------------------------------------------------------------
// 4. ordenaGrupos
// ---------------------------------------------------------------------------
describe("ordenaGrupos", () => {
  it("os 11 grupos reais em ordem 832→…→2; empate 7/7 por dimension asc; determinístico", () => {
    const gs = gruposReais();
    const counts1 = ordenaGrupos(gs).map((g) => g.count);
    expect(counts1).toEqual([832, 130, 41, 36, 13, 10, 7, 7, 4, 4, 2]);
    // empate 7/7: nao_ancorado×decisoes×Calls vs nao_ancorado×facts×YouTube → dimension asc (decisoes < facts)
    const sorted = ordenaGrupos(gs);
    const sete = sorted.filter((g) => g.count === 7);
    expect(sete.map((g) => g.dimension)).toEqual(["decisoes", "facts"]);
    // 2 chamadas = mesma ordem (determinístico)
    const counts2 = ordenaGrupos(gs).map((g) => g.count);
    expect(counts2).toEqual(counts1);
    // não muta o array original
    expect(gs[0].count).toBe(832);
  });
});

// ---------------------------------------------------------------------------
// 5. separaPrecisaDeVoce
// ---------------------------------------------------------------------------
describe("separaPrecisaDeVoce", () => {
  it("2 humano, 1 aprovar, 1 sem campo → precisamDeVoce só os humano, ordem preservada", () => {
    const a = hip({ id: "a", recomendacao: "humano" });
    const b = hip({ id: "b", recomendacao: "aprovar" });
    const c = hip({ id: "c", recomendacao: "humano" });
    const d = hip({ id: "d" }); // sem campo
    const { precisamDeVoce, demais } = separaPrecisaDeVoce([a, b, c, d]);
    expect(precisamDeVoce.map((h) => h.id)).toEqual(["a", "c"]);
    expect(demais.map((h) => h.id)).toEqual(["b", "d"]);
  });
});

// ---------------------------------------------------------------------------
// 6. filtraGrupo
// ---------------------------------------------------------------------------
describe("filtraGrupo", () => {
  it("null → identidade", () => {
    const itens = [hip({ id: "a" }), hip({ id: "b" })];
    expect(filtraGrupo(itens, null)).toBe(itens);
  });
  it("filtro do grupão → só itens com a tripla exata", () => {
    const dentro = hip({ id: "in", reason: "fora_da_receita", dimension: "claims", source_id: SRC_CALLS });
    const foraDim = hip({ id: "d2", reason: "fora_da_receita", dimension: "objecoes", source_id: SRC_CALLS });
    const foraSrc = hip({ id: "s2", reason: "fora_da_receita", dimension: "claims", source_id: SRC_WHATS });
    const out = filtraGrupo([dentro, foraDim, foraSrc], {
      reason: "fora_da_receita", dimension: "claims", source_id: SRC_CALLS,
    });
    expect(out.map((h) => h.id)).toEqual(["in"]);
  });
});

// ---------------------------------------------------------------------------
// 7. resumoLote
// ---------------------------------------------------------------------------
describe("resumoLote", () => {
  const retidos = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `r${i}`, porque: "sem âncora" }));
  it("790 aprovados, 42 retidos", () => {
    expect(resumoLote({ aprovados: 790, retidos: retidos(42) })).toBe("Aprovados 790, retidos 42 — ver porquês.");
  });
  it("790 aprovados, 0 retidos", () => {
    expect(resumoLote({ aprovados: 790, retidos: [] })).toBe("Aprovados 790. Nenhum retido.");
  });
  it("0 aprovados, 3 retidos", () => {
    expect(resumoLote({ aprovados: 0, retidos: retidos(3) })).toBe("Nenhum aprovado — 3 retidos pelo gate. Ver porquês.");
  });
  it("1086 aprovados → milhar pt-BR '1.086'", () => {
    expect(resumoLote({ aprovados: 1086, retidos: retidos(2) })).toContain("1.086");
  });
});

// ---------------------------------------------------------------------------
// 8. rotuloRecomendacao
// ---------------------------------------------------------------------------
describe("rotuloRecomendacao", () => {
  it("aprovar", () => expect(rotuloRecomendacao(hip({ recomendacao: "aprovar" }))).toBe("o juiz recomenda aprovar"));
  it("descartar", () => expect(rotuloRecomendacao(hip({ recomendacao: "descartar" }))).toBe("o juiz recomenda descartar"));
  it("humano", () => expect(rotuloRecomendacao(hip({ recomendacao: "humano" }))).toBe("o juiz quer você aqui"));
  it("sem recomendação → ''", () => expect(rotuloRecomendacao(hip({}))).toBe(""));
});

// ---------------------------------------------------------------------------
// 9. rotuloAcerto (§9 — decididos/acerto)
// ---------------------------------------------------------------------------
describe("rotuloAcerto", () => {
  const seg = (over: Partial<JudgeCalibrationSegment>): JudgeCalibrationSegment => ({
    dimension: "claims", source_id: SRC_CALLS, reason: "fora_da_receita",
    decididos: 0, acertos: 0, acerto: 0, ...over,
  });
  it("undefined → ''", () => expect(rotuloAcerto(undefined)).toBe(""));
  it("decididos=0 → ''", () => expect(rotuloAcerto(seg({ decididos: 0 }))).toBe(""));
  it("decididos=3 (n<5) → ainda aprendendo", () => {
    expect(rotuloAcerto(seg({ decididos: 3, acerto: 1 }))).toBe("ainda aprendendo seu critério aqui (n=3)");
  });
  it("decididos=140, acerto=0.97 → acerta 97%", () => {
    expect(rotuloAcerto(seg({ decididos: 140, acertos: 136, acerto: 0.97 }))).toBe("o juiz acerta 97% aqui (n=140)");
  });
});

// ---------------------------------------------------------------------------
// 10. segmentoDoGrupo
// ---------------------------------------------------------------------------
describe("segmentoDoGrupo", () => {
  const cal: JudgeCalibration = {
    segmentos: [
      { dimension: "claims", source_id: SRC_CALLS, reason: "fora_da_receita", decididos: 140, acertos: 136, acerto: 0.97 },
      { dimension: "objecoes", source_id: SRC_CALLS, reason: "fora_da_receita", decididos: 10, acertos: 8, acerto: 0.8 },
    ],
    total: { decididos: 150, acertos: 144, acerto: 0.96 },
  };
  it("match pela tripla", () => {
    const g = grupo({ dimension: "claims", source_id: SRC_CALLS, reason: "fora_da_receita" });
    expect(segmentoDoGrupo(cal, g)?.decididos).toBe(140);
  });
  it("sem match → undefined", () => {
    const g = grupo({ dimension: "precos", source_id: SRC_CALLS, reason: "fora_da_receita" });
    expect(segmentoDoGrupo(cal, g)).toBeUndefined();
  });
  it("calibração null → undefined", () => {
    expect(segmentoDoGrupo(null, grupo())).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 11. fmtCustoUsd
// ---------------------------------------------------------------------------
describe("fmtCustoUsd", () => {
  it("0.87 → ~US$ 0,87", () => expect(fmtCustoUsd(0.87)).toBe("~US$ 0,87"));
  it("0.005 → menos de US$ 0,01", () => expect(fmtCustoUsd(0.005)).toBe("menos de US$ 0,01"));
  it("12.5 → ~US$ 12,50", () => expect(fmtCustoUsd(12.5)).toBe("~US$ 12,50"));
  it("0 → ~US$ 0,00 (não é >0, não cai no 'menos de')", () => expect(fmtCustoUsd(0)).toBe("~US$ 0,00"));
});

// ---------------------------------------------------------------------------
// 12. juizNuncaRodou
// ---------------------------------------------------------------------------
describe("juizNuncaRodou", () => {
  it("grupos sem campo recomendacoes → true", () => {
    expect(juizNuncaRodou(gruposReais())).toBe(true);
  });
  it("um grupo com recomendacoes todas 0 (só sem_recomendacao) → true", () => {
    const gs = [grupo({ recomendacoes: { aprovar: 0, descartar: 0, humano: 0, sem_recomendacao: 832 } })];
    expect(juizNuncaRodou(gs)).toBe(true);
  });
  it("um grupo com aprovar:1 → false", () => {
    const gs = [grupo({ recomendacoes: { aprovar: 1, descartar: 0, humano: 0, sem_recomendacao: 831 } })];
    expect(juizNuncaRodou(gs)).toBe(false);
  });
  it("[] → false (fila vazia tem outro estado)", () => {
    expect(juizNuncaRodou([])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 13. triagemEmAndamento (§9.2.3)
// ---------------------------------------------------------------------------
describe("triagemEmAndamento", () => {
  const run = (status: JudgeRun["status"]): JudgeRun => ({
    status, julgados: 0, distribuicao: { aprovar: 0, descartar: 0, humano: 0 },
    pendentes_sem_recomendacao: 0, erros: 0, pulados: 0, custo_usd: 0, mensagem: "",
  });
  it("null → false", () => expect(triagemEmAndamento(null)).toBe(false));
  it("batch_submetido → true", () => expect(triagemEmAndamento(run("batch_submetido"))).toBe(true));
  it("batch_em_andamento → true", () => expect(triagemEmAndamento(run("batch_em_andamento"))).toBe(true));
  it("concluido → false", () => expect(triagemEmAndamento(run("concluido"))).toBe(false));
  it("nada_a_julgar → false", () => expect(triagemEmAndamento(run("nada_a_julgar"))).toBe(false));
});
