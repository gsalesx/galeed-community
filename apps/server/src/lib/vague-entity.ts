/** M23-B — auto-contenção de entidade (LEI II: "fato sem dono claro NÃO é fato").
 *  Constante de LÍNGUA (PT), tenant-neutra (ADR-002): formas pronominais/dêiticas e
 *  substantivos genéricos SEM referente. É DADO, não lógica — ampliar = editar as listas
 *  (+ testes), nunca adicionar ramo. Match EXATO sobre a entidade normalizada (lowercase,
 *  trim, espaços colapsados); SEM folding de acento (variantes com/sem acento listadas —
 *  invariante #9: nenhum normalizador à mão). Compartilhada por derivePageFacts (indexer)
 *  e applyRecipeGate (golden-rule) — padrão quoteIsGrounded/valueIsAnchored. */

/** Formas pronominais/dêiticas — match EXATO. */
export const VAGUE_PRONOUNS: ReadonlySet<string> = new Set([
  "ele", "ela", "eles", "elas", "ele(a)", "ela(e)",
  "eu", "tu", "voce", "você", "voces", "vocês", "nos", "nós", "a gente", "gente",
  "alguem", "alguém", "ninguem", "ninguém", "todos", "todas", "todo mundo",
  "isso", "isto", "aquilo", "esse", "essa", "este", "esta", "aquele", "aquela",
  "o mesmo", "a mesma", "quem", "fulano", "sicrano", "beltrano",
  "o cara", "o pessoal", "pessoal", "a galera", "galera",
]);

/** Substantivos genéricos vazios de referente — match após remover UM artigo inicial opcional. */
export const VAGUE_GENERIC_NOUNS: ReadonlySet<string> = new Set([
  "cliente", "clientes", "empresa", "empresas", "produto", "produtos",
  "servico", "serviço", "servicos", "serviços",
  "fornecedor", "fornecedores", "usuario", "usuário", "usuarios", "usuários",
  "pessoa", "pessoas", "equipe", "time", "grupo", "projeto",
  "sistema", "plataforma", "ferramenta", "negocio", "negócio",
  "parceiro", "parceiros",
]);

const LEADING_ARTICLE = /^(o|a|os|as|um|uma|uns|umas)\s+/;

/** true ⇔ a entidade é uma forma VAZIA de referente (pronominal OU genérica).
 *  "" → false (entidade vazia não é "vaga" — é sem-triple, cai no caminho 'registrado').
 *  Forma vaga como PARTE de nome composto NÃO casa ("ela transportes", "o cliente acme" → false). */
export function entityIsVague(entity: string): boolean {
  const e = entity.toLowerCase().trim().replace(/\s+/g, " ");
  if (!e) return false;
  if (VAGUE_PRONOUNS.has(e)) return true;
  return VAGUE_GENERIC_NOUNS.has(e.replace(LEADING_ARTICLE, ""));
}
