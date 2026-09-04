/** INGESTORES — o contrato que um aluno implementa pra criar um canal de entrada novo.
 *
 *  Conceito (a cadeia inteira):
 *    canal externo (webhook/poller) → Ingestor.normalize()  ← o "MIDDLEWARE": prepara o dado
 *    → seam único (deliverConnectorPayload: dedupe + fila)  ← nada entra por fora dele
 *    → extração de fatos → receita/regra de ouro → fatos com selo.
 *
 *  Um ingestor é UM módulo com duas funções:
 *    - sourceSeed(): a FONTE que o material desse canal cria no cérebro (auto-criada na 1ª entrega).
 *    - normalize(body, ctx): PURA (sem IO, sem fetch, sem env) — recebe o payload CRU do canal e
 *      devolve 0..n itens prontos pro seam. [] = evento ignorado (ack, mídia sem texto etc.).
 *      É aqui que se limpa, recorta, enriquece e formata o dado ANTES de ingerir de vez.
 *
 *  Todo ingestor registrado ganha automaticamente:
 *    - webhook público POST /v1/ingestors/<slug> (Bearer gld_ com can_ingest; ?token= como fallback
 *      pra ferramentas que não mandam header);
 *    - dedupe por externalRef + conteúdo (re-entrega do mesmo evento não duplica);
 *    - fila assíncrona com status (mesma da tela Adicionar).
 *
 *  Guia completo com template e teste: INGESTORES.md na raiz do repo. */
import type { ConnectorPayload, ConnectorSourceSeed } from "../connector-ingest.ts";

/** Contexto da entrega (preenchido pelo runtime — o normalize NÃO resolve fonte nem brain). */
export interface IngestorCtx {
  brain: string;
  sourceId: string; // fonte auto-criada/resolvida a partir do sourceSeed()
  slug: string; // slug do ingestor (o :slug da URL)
}

/** Canal de CONVERSA: declara a janela e a mensagem entra no buffer por chat em vez de
 *  ingerir na hora — a conversa inteira vira UMA página quando a janela fecha (silêncio de
 *  GALEED_JANELA_MIN min ou GALEED_JANELA_MAX_MSGS mensagens). Ver janela.ts. */
export interface JanelaInfo {
  chatId: string; // id estável do chat (ex.: remoteJid do WhatsApp)
  chatLabel: string; // rótulo legível ("grupo equipe", "Mariana Souza")
  quem: string; // quem falou nesta mensagem
  texto: string; // SÓ o texto da fala (a página da janela é montada no flush)
}

/** Um item normalizado — o ConnectorPayload do seam SEM o sourceId (o runtime preenche).
 *  `claims` opcionais ⇒ caminho determinístico zero-LLM (ver ConnectorClaim no seam).
 *  `janela` opcional ⇒ canal de conversa: acumula no buffer em vez de ingerir na hora. */
export type IngestorItem = Omit<ConnectorPayload, "sourceId"> & { janela?: JanelaInfo };

export interface Ingestor {
  /** slug estável da URL (kebab-case): POST /v1/ingestors/<slug>. */
  slug: string;
  /** nome legível (painel/docs). */
  nome: string;
  /** 1 frase: o que entra por aqui e de onde. */
  descricao: string;
  /** payload de exemplo (JSON string) pro curl dos docs/painel. */
  exemplo?: string;
  /** a fonte deste canal (auto-criada na 1ª entrega; recipe.fields [] = modo livre). */
  sourceSeed(): ConnectorSourceSeed;
  /** o MIDDLEWARE: payload cru do canal → itens prontos. PURA; [] = ignora o evento. */
  normalize(body: unknown, ctx: IngestorCtx): IngestorItem[];
}
