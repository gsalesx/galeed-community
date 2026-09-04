/** Vocabulário de tipos + resolução do tenant (brain). DB-native: sem pastas, sem manifesto.
 *
 *  NOTA: por todo o core, o parâmetro `home: string` agora carrega o ID DO TENANT (brain),
 *  não um caminho de pasta. `brainHome()` o resolve do flag --brain ou da env GALEED_BRAIN. */

export const TYPES = ["pessoas", "clientes", "reunioes", "produtos", "decisoes", "conceitos", "notas"] as const;
export type Tipo = (typeof TYPES)[number];

/** singular informado pelo usuário -> rótulo plural canônico */
export const TYPE_ALIAS: Record<string, Tipo> = {
  pessoa: "pessoas",
  pessoas: "pessoas",
  cliente: "clientes",
  clientes: "clientes",
  reuniao: "reunioes",
  reunioes: "reunioes",
  produto: "produtos",
  produtos: "produtos",
  decisao: "decisoes",
  decisoes: "decisoes",
  conceito: "conceitos",
  conceitos: "conceitos",
  nota: "notas",
  notas: "notas",
};

export function resolveTipo(input?: string): Tipo {
  return TYPE_ALIAS[(input || "nota").toLowerCase()] ?? "notas";
}

/** Resolve o id do tenant (brain): flag --brain precede a env GALEED_BRAIN; default "galeed". */
export function brainHome(flag?: string): string {
  return flag || process.env.GALEED_BRAIN || "galeed";
}
