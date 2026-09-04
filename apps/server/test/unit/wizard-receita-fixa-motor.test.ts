/** FIX-A/BUG 1 (lado wizard): a receita NASCE das dims REAIS do tipo EFETIVO (mesmo funil
 *  resolveTipo da captura/extração), NUNCA do nome da fonte. A IA não inventa dim (vocabulário
 *  fechado): dim fora do vocabulário é DROPADA com rastro. Funções puras — sem DB, sem IA. */
// IA desligada + pack-env global isolado ANTES dos imports que cacheiam pack.
process.env.GALEED_PROVIDER = "";
process.env.GALEED_SCHEMA_PACK = "";

import { describe, it, expect, beforeEach } from "vitest";
import {
  effectiveExtractType,
  realRecipeDims,
  makeSourceDraft,
  mergeSourcesIntoDraft,
  type WizardDraft,
} from "../../src/connectors/bff/bff-wizard.ts";
import { resolveTipo } from "../../src/core/platform/brain.ts";
import { DEFAULT_EXTRACT_DIMS } from "../../src/core/extraction/extractable.ts";
import { clearSchemaPackCache } from "../../src/core/extraction/schema-pack.ts";

const PACK_FIXTURE = new URL("./fixtures/wizard-receita-pack-fixa-motor.json", import.meta.url).pathname;

function draft(over: Partial<WizardDraft> = {}): WizardDraft {
  return {
    name: "cerebro-fixa-motor",
    label: "Cérebro fixa-motor",
    purpose: "teste",
    selfSlug: "",
    selfLabel: "",
    areas: ["clientes", "financeiro"],
    sources: [],
    sensitivity: "",
    ...over,
  };
}

beforeEach(() => {
  clearSchemaPackCache();
  delete process.env.GALEED_SCHEMA_PACK_CEREBRO_FIXA_MOTOR;
});

describe("FIX-A/§6.2-a — effectiveExtractType = funil resolveTipo da captura", () => {
  const casos: Array<[string, string]> = [
    ["mensagens", "notas"],
    ["transcricoes", "notas"],
    ["video", "notas"],
    ["reunioes", "reunioes"],
    ["reuniao", "reunioes"],
    ["", "notas"],
  ];
  for (const [input, esperado] of casos) {
    it(`'${input}' → '${esperado}'`, () => {
      expect(effectiveExtractType(input)).toBe(esperado);
    });
  }
});

describe("FIX-A/§6.2-c — invariante anti-fork: effectiveExtractType === resolveTipo", () => {
  for (const t of ["mensagens", "transcricoes", "video", "reunioes", "reuniao", ""]) {
    it(`'${t}' acoplado ao funil da captura`, () => {
      expect(effectiveExtractType(t)).toBe(resolveTipo(t));
    });
  }
});

describe("FIX-A/§6.2-b — realRecipeDims resolve dims do tipo EFETIVO, nunca do nome", () => {
  it("sem pack: qualquer tipo → DEFAULT_EXTRACT_DIMS exatos", () => {
    clearSchemaPackCache();
    expect(realRecipeDims("cerebro-fixa-motor", "mensagens_whatsapp")).toEqual(DEFAULT_EXTRACT_DIMS);
    expect(realRecipeDims("cerebro-fixa-motor", "video")).toEqual(DEFAULT_EXTRACT_DIMS);
  });

  it("com pack: tipo 'mensagens' funila p/ 'notas' → dims do pack (relacoes/decisoes)", () => {
    process.env.GALEED_SCHEMA_PACK_CEREBRO_FIXA_MOTOR = PACK_FIXTURE;
    clearSchemaPackCache();
    expect(realRecipeDims("cerebro-fixa-motor", "mensagens")).toEqual(["relacoes", "decisoes"]);
    // o NOME da fonte (slug) é irrelevante — o funil sempre resolve por resolveTipo.
    expect(realRecipeDims("cerebro-fixa-motor", "mensagens-whatsapp-de-grupos")).toEqual(["relacoes", "decisoes"]);
  });
});

describe("FIX-A/§6.2-d/e — mergeSourcesIntoDraft com IA: dim inventada DROPADA, IA só enriquece", () => {
  it("(d) IA emite 'mensagens_whatsapp' (eco do nome) → DROPADA; receita = dims reais", () => {
    clearSchemaPackCache();
    const d = draft();
    const ai = {
      sources: [
        {
          name: "Mensagens WhatsApp",
          type: "mensagens",
          channel: "upload",
          fields: [{ dimension: "mensagens_whatsapp", label: "x", area: "" }],
        },
      ],
    };
    const added = mergeSourcesIntoDraft(d, "", ai);
    expect(added).toEqual(["Mensagens WhatsApp"]);
    const fields = d.sources[0].recipe.fields;
    expect(fields.map((f) => f.dimension)).toEqual(DEFAULT_EXTRACT_DIMS);
    expect(fields.some((f) => f.dimension === "mensagens_whatsapp")).toBe(false);
  });

  it("(e) IA enriquece label da dim REAL sem expandir; reais não citadas entram label=dimension", () => {
    clearSchemaPackCache();
    const d = draft();
    const ai = {
      sources: [
        {
          name: "Calls",
          type: "transcricoes",
          channel: "upload",
          fields: [{ dimension: "facts", label: "Fatos do negócio", area: "clientes" }],
        },
      ],
    };
    mergeSourcesIntoDraft(d, "", ai);
    const fields = d.sources[0].recipe.fields;
    expect(fields.map((f) => f.dimension)).toEqual(DEFAULT_EXTRACT_DIMS);
    const facts = fields.find((f) => f.dimension === "facts")!;
    expect(facts.label).toBe("Fatos do negócio");
    expect(facts.area).toBe("clientes");
    // dims reais NÃO citadas: label = dimension
    const decisions = fields.find((f) => f.dimension === "decisions")!;
    expect(decisions.label).toBe("decisions");
  });
});

describe("FIX-A/§6.2-f — degrade sem IA (toggle/free-text): makeSourceDraft", () => {
  it("makeSourceDraft('Calls de vendas') → recipe.fields = DEFAULT_EXTRACT_DIMS", () => {
    clearSchemaPackCache();
    const s = makeSourceDraft("Calls de vendas", draft());
    expect(s.recipe.fields.map((f) => f.dimension)).toEqual(DEFAULT_EXTRACT_DIMS);
  });

  it("mergeSourcesIntoDraft degrade (ai=null) parseia nome e usa dims reais", () => {
    clearSchemaPackCache();
    const d = draft();
    const added = mergeSourcesIntoDraft(d, "WhatsApp", null);
    expect(added).toContain("WhatsApp");
    expect(d.sources[0].recipe.fields.map((f) => f.dimension)).toEqual(DEFAULT_EXTRACT_DIMS);
  });
});
