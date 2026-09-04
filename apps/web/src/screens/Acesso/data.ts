/** Acesso (M8) — mapas canônicos e constantes locais da tela.
 *  Mapa de níveis §1 do _design/acesso.md (rank · M7 · UI label · classe CSS).
 *  As áreas vivem aqui: o cliente api.rbac não expõe /areas, então a lista de assuntos
 *  (nomes) é fixa no front. origin/dot são só apresentação (texto/cor por área). */
import type { LockLevel } from "../../ui";
import type { Sensitivity } from "../../lib/api";

/** rank → código de cadeado da UI. */
export const SENS_TO_CODE: Record<Sensitivity, LockLevel> = {
  publico: "open",
  interno: "int",
  sensivel: "conf",
  restrito: "secret",
};

export const CODE_TO_SENS: Record<LockLevel, Sensitivity> = {
  open: "publico",
  int: "interno",
  conf: "sensivel",
  secret: "restrito",
};

export const LEVEL_LABEL: Record<LockLevel, string> = {
  open: "Aberto",
  int: "Interno",
  conf: "Sigiloso",
  secret: "Secreto",
};

/** texto do cadeado na lista: aberto = "só Aberto", demais = "até <Nível>". */
export function lockText(code: LockLevel): string {
  return code === "open" ? "só Aberto" : `até ${LEVEL_LABEL[code]}`;
}

export const LEVEL_DOT: Record<LockLevel, string> = {
  open: "var(--sn-open)",
  int: "var(--sn-int)",
  conf: "var(--sn-conf)",
  secret: "var(--sn-secret)",
};

export const LEVEL_SOFT: Record<LockLevel, string> = {
  open: "var(--sn-open-soft)",
  int: "var(--sn-int-soft)",
  conf: "var(--sn-conf-soft)",
  secret: "var(--sn-secret-soft)",
};

/** Os 4 radios do passo 3 (passo "Até que nível de sigilo?"). */
export const LEVEL_OPTIONS: { code: LockLevel; title: string; hint: string }[] = [
  { code: "open", title: "Aberto", hint: "qualquer um pode ver" },
  { code: "int", title: "Interno", hint: "coisas do dia a dia da empresa" },
  { code: "conf", title: "Sigiloso", hint: "preço, contrato, estratégia" },
  { code: "secret", title: "Secreto", hint: "salário, dado pessoal, jurídico" },
];

/** Tipos negáveis do "Avançado" (passo 3). */
export const DENY_TYPES: { slug: string; label: string }[] = [
  { slug: "valores", label: "Valores e preços" },
  { slug: "pessoas", label: "Dados de pessoas (e-mail, telefone)" },
  { slug: "juridico", label: "Documentos jurídicos" },
];

/** cor do pontinho de uma área REAL (api.rbac.areas) — ciclo determinístico por posição.
 *  (A lista fixa de áreas inventadas que morava aqui morreu: a tela consome o endpoint.) */
const AREA_DOTS = ["var(--st-fact)", "var(--sn-int)", "var(--sn-conf)", "var(--sn-secret)", "var(--sn-open)"];
export function dotDeArea(index: number): string {
  return AREA_DOTS[index % AREA_DOTS.length];
}
