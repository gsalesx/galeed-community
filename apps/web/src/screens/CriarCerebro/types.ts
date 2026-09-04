/** M21/S6 — Tipos locais do wizard "Criar um cérebro".
 *
 *  Espelham EXATAMENTE os shapes do S4 (src/connectors/bff/bff-wizard.ts), que o
 *  reconciler também publicou em web/src/lib/api.ts (bloco M21). São estruturalmente
 *  idênticos aos de api.ts — o TypeScript os trata como intercambiáveis; a cópia local
 *  existe porque o slot é dono só de screens/CriarCerebro/** (DESIGN-SPEC §1).
 *
 *  INVARIANTE: `draft` é OPACO pro front — viaja de volta intacto a cada reply
 *  (servidor stateless, padrão M11-S4). NUNCA é lido nem renderizado aqui.
 */

export type WizardStep = "purpose" | "areas" | "sources" | "sensitivity" | "review" | "done";

export interface WizardPanel {
  name: string;
  status: string;
  purpose: string;
  areas: string[];
  sources: { name: string; fields: string[]; areas: string[] }[];
  rules: string[];
}

export interface WizardState {
  step: WizardStep;
  draft: unknown;
  asked: string[];
}

/** chip RICO do passo `sources` (M21/fix-2): toggle multi-seleção (`.sel` se `selected`) + chip
 *  `go` ("Pronto →", único que avança). Demais passos: `chips` vem [] e o front usa `suggestions`. */
export interface WizardChip {
  label: string;
  kind?: "toggle" | "go";
  selected?: boolean;
}

export interface WizardTurn {
  state: WizardState;
  question: string;
  card: string;
  suggestions: string[];
  chips: WizardChip[];
  panel: WizardPanel;
  done: boolean;
}
