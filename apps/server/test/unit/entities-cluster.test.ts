/** Fix sobre-fusão de entidades (#R3) — clusterEntities: separação FORTE vs FRACO (PURA, sem banco).
 *  Matriz OBRIGATÓRIA da spec: joão/acme (ambíguo), silvia/banco (forte = anti-under-merge), a
 *  cadeia 2-token bridge (ambíguo, NÃO funde santos~souza direto) e isolamento entre clusters.
 *
 *  clusterEntities é 100% PURA (Map→ClusterResult) — não toca engine/LLM/config, então importa
 *  direto (sem mock). */
import { describe, it, expect } from "vitest";
import { clusterEntities, type ClusterResult } from "../../src/core/memory/entities.ts";

const freqOf = (o: Record<string, number>): Map<string, number> => new Map(Object.entries(o));

/** normaliza p/ comparação independente de ORDEM (a ordem de merges/ambiguous não é contratual). */
function norm(r: ClusterResult) {
  return {
    strong: r.strong
      .map((m) => ({ canonical: m.canonical, aliases: [...m.aliases].sort() }))
      .sort((a, b) => (a.canonical < b.canonical ? -1 : 1)),
    ambiguous: r.ambiguous.map((g) => [...g].sort()).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
  };
}

describe("clusterEntities — sinal FORTE vs FRACO (fix sobre-fusão)", () => {
  it("1. trio joão/joão silva/joão souza → AMBÍGUO (contenção do 1-token), strong=[]", () => {
    // sem aresta forte (tokenSim joão×joão-silva=0.5<0.6; silva×souza=1/3). Contenção de "joão" nos
    // dois → 1 componente fraco de 3 nomes → ambíguo. É EXATAMENTE o over-merge que o fix mata.
    const r = norm(clusterEntities(freqOf({ "joão": 3, "joão silva": 2, "joão souza": 1 })));
    expect(r.strong).toEqual([]);
    expect(r.ambiguous).toEqual([["joão", "joão silva", "joão souza"]]);
  });

  it("2. trio acme/acme corp/acme corporation → AMBÍGUO, strong=[]", () => {
    const r = norm(clusterEntities(freqOf({ "acme": 3, "acme corp": 2, "acme corporation": 1 })));
    expect(r.strong).toEqual([]);
    expect(r.ambiguous).toEqual([["acme", "acme corp", "acme corporation"]]);
  });

  it("3. silvia/sílvia → FORTE (anti-under-merge; fold de acento), ambiguous=[]", () => {
    // editSim CRU=0.833 (<0.85) e tokenSim=0 — SÓ funde por causa do fold de acento no sinal forte.
    const r = norm(clusterEntities(freqOf({ "silvia": 5, "sílvia": 2 })));
    expect(r.ambiguous).toEqual([]);
    expect(r.strong).toEqual([{ canonical: "silvia", aliases: ["sílvia"] }]);
  });

  it("4. banco brasil/banco do brasil → FORTE (tokenSim 2/3≥0.6; anti-under-merge)", () => {
    const r = norm(clusterEntities(freqOf({ "banco brasil": 4, "banco do brasil": 1 })));
    expect(r.ambiguous).toEqual([]);
    expect(r.strong).toEqual([{ canonical: "banco brasil", aliases: ["banco do brasil"] }]);
  });

  it("5. cadeia 2-token bridge (joão silva / …santos / …souza) → AMBÍGUO, NÃO funde santos~souza direto", () => {
    // "joão silva" é FORTE (tokenSim 2/3) com …santos E com …souza, mas …santos≁…souza. Um union-find
    // forte PURO fundiria os 3 em silêncio (a mesma ponte-transitiva do over-merge, agora no tokenSim).
    // A checagem de COERÊNCIA manda o componente incoerente pro desempate.
    const r = norm(clusterEntities(freqOf({ "joão silva": 3, "joão silva santos": 2, "joão silva souza": 1 })));
    expect(r.strong).toEqual([]);
    expect(r.ambiguous).toEqual([["joão silva", "joão silva santos", "joão silva souza"]]);
  });

  it("5b. sem o bare 'joão silva', …santos e …souza NÃO se tocam (nem forte nem ambíguo)", () => {
    // prova que santos~souza só entram no MESMO grupo via a ponte — nunca por aresta direta.
    const r = norm(clusterEntities(freqOf({ "joão silva santos": 1, "joão silva souza": 1 })));
    expect(r.strong).toEqual([]);
    expect(r.ambiguous).toEqual([]);
  });

  it("6. isolamento — entidades sem relação não se tocam", () => {
    const r = norm(clusterEntities(freqOf({ "maria": 1, "pedro": 1, "acme": 1 })));
    expect(r.strong).toEqual([]);
    expect(r.ambiguous).toEqual([]);
  });

  it("6b. dois clusters ambíguos independentes não se cruzam", () => {
    const r = norm(clusterEntities(freqOf({ "joão": 2, "joão silva": 1, "acme": 2, "acme corp": 1 })));
    expect(r.strong).toEqual([]);
    expect(r.ambiguous).toEqual([
      ["acme", "acme corp"],
      ["joão", "joão silva"],
    ]);
  });

  it("canônico determinístico: mais frequente vence (empate → mais curto)", () => {
    // par forte por contenção? não — "acme"/"acme" idênticos não; use um par forte real p/ o canônico.
    const r = clusterEntities(freqOf({ "sílvia": 1, "silvia": 9 }));
    expect(r.strong).toEqual([{ canonical: "silvia", aliases: ["sílvia"] }]);
    const r2 = clusterEntities(freqOf({ "sílvia": 9, "silvia": 1 }));
    expect(r2.strong).toEqual([{ canonical: "sílvia", aliases: ["silvia"] }]);
  });
});
