/** INVARIANTE DE INTEGRIDADE: o reconcile NUNCA funde predicados de papéis opostos (reconcile.ts).
 *  Por que importa: foi o bug crítico da AVALIACAO — o reconcile sem-LLM fundiu `ad_spend`→`ticket`,
 *  e o ticket médio da Inject (R$15k) virou o gasto de tráfego (R$2.700). A correção foi o HARD GATE
 *  de papel (roleConflict) + o default conservador. Travamos os dois e documentamos o "falha-aberto
 *  por ausência de pack" honestamente. */
import { describe, it, expect } from "vitest";
import { similar, roleConflict } from "../../src/core/memory/reconcile.ts";
import { EMPTY_PACK, type SchemaPack } from "../../src/core/extraction/schema-pack.ts";
import { readFileSync } from "node:fs";

/** o pack REAL que o produto shippa (PT-negócios). Testar contra ele, não contra um fake. */
const PT_NEGOCIOS: SchemaPack = JSON.parse(
  readFileSync(new URL("../../schema-packs/pt-negocios.example.json", import.meta.url), "utf8"),
);

describe("HARD GATE de papel — opostos NUNCA fundem (regressão ad_spend→ticket)", () => {
  it("gasto (trafego) e receita (ticket) têm papéis opostos no pack real", () => {
    expect(roleConflict("trafego_mensal", "ticket_medio", PT_NEGOCIOS)).toBe(true);
    expect(roleConflict("custo_ads", "faturamento", PT_NEGOCIOS)).toBe(true);
  });

  it("similar() veta o merge mesmo com o pack carregado", () => {
    expect(similar("trafego_mensal", "ticket_medio", PT_NEGOCIOS)).toBe(false);
    expect(similar("gasto_ads", "receita_mensal", PT_NEGOCIOS)).toBe(false);
  });

  it("o gate de papel tem PRECEDÊNCIA sobre uma sinonímia errada (defesa em profundidade)", () => {
    // pack mal-configurado: alguém listou ticket≡spend como sinônimos (errado). O hard gate
    // de papel roda ANTES e veta — a integridade não depende do pack estar perfeito.
    const packErrado: SchemaPack = {
      synonymClasses: [["ticket", "spend"]],
      roleTokens: { spend: ["spend"], revenue: ["ticket"] },
    };
    expect(similar("ticket_x", "spend_x", packErrado)).toBe(false);
  });
});

describe("merges LEGÍTIMOS continuam acontecendo (não viramos paranoicos)", () => {
  it("typo / variação de grafia funde (editSim alto)", () => {
    expect(similar("mensalidade", "mensalidde", EMPTY_PACK)).toBe(true); // typo
    expect(similar("preco_mensal", "preco_mensal", EMPTY_PACK)).toBe(true);
  });

  it("sinônimos do MESMO papel fundem via pack (preco ≡ valor ≡ mensalidade)", () => {
    expect(similar("preco_base", "valor_base", PT_NEGOCIOS)).toBe(true);
  });
});

describe("FALHA-ABERTO — limites do gate determinístico (documentado, não resolvido)", () => {
  it("sem pack, opostos só NÃO fundem porque os nomes diferem (proteção incidental, não semântica)", () => {
    // Sem pack, roleConflict é neutro (false). A não-fusão de ad_spend×ticket_medio aqui vem de os
    // NOMES serem dissimilares — não de uma garantia de papel. É o gap "falha-aberto por config":
    // a integridade forte depende de um pack que começa vazio.
    expect(roleConflict("ad_spend", "ticket_medio", EMPTY_PACK)).toBe(false); // sem pack → neutro
    expect(similar("ad_spend", "ticket_medio", EMPTY_PACK)).toBe(false); // salvo só pela dissimilaridade
  });

  it.fails("subconceitos do MESMO papel fundem por token-overlap — nem o pack separa (só o LLM-judge)", () => {
    // "ticket_medio" (geral) e "ticket_medio_b2b" (segmento) são MÉTRICAS DISTINTAS, mas tokenSim≥0.6
    // os funde. Ambos são 'revenue' no pack → roleConflict não ajuda. Só o LLM-judge (reconcile --llm)
    // pega isso. it.fails trava o comportamento atual: quando houver separação semântica default, vira
    // VERMELHO — troque por expect(...).toBe(false) de verdade.
    expect(similar("ticket_medio", "ticket_medio_b2b", PT_NEGOCIOS)).toBe(false);
  });
});
