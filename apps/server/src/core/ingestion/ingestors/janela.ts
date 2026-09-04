/** JANELA DE CONVERSA — o "ingest inteligente" dos canais de mensagem (WhatsApp e afins).
 *
 *  Uma mensagem sozinha não carrega contexto ("Consegue remarcar?" sem o "claro, sexta 15h"
 *  que vem depois). Então canais de conversa NÃO ingerem mensagem a mensagem: cada mensagem
 *  entra num BUFFER por chat (esta tabela) e a conversa inteira vira UMA página quando a
 *  janela fecha:
 *    - o chat fica GALEED_JANELA_MIN minutos em silêncio (default 30 — a conversa "acabou"), OU
 *    - a janela junta GALEED_JANELA_MAX_MSGS mensagens (default 100 — teto de segurança).
 *  GALEED_JANELA_MIN=0 desliga o buffer (cada mensagem ingere na hora, como antes) E DRENA o
 *  que já estava bufferizado (flushJanelas trata toda janela existente como vencida — desligar
 *  o buffer nunca encalha mensagem).
 *
 *  Quem flusha é o INGEST-WORKER (que já roda em loop): flushJanelas() reivindica janelas
 *  vencidas (flush_claim + SKIP LOCKED — vários workers não brigam), monta a página da
 *  conversa e entrega no seam único (dedupe + fila + extração). Só apaga o buffer DEPOIS
 *  da entrega dar certo — falha de entrega devolve a janela pra próxima rodada — e SÓ se
 *  nada chegou durante a entrega (senão APARA só o que foi entregue; a sobra fecha depois). */
import { getSharedSql, sharedSqlGeneration } from "../../platform/db-conn.ts";
import { deliverConnectorPayload } from "../connector-ingest.ts";
import { getIngestor } from "./registry.ts";
import { resolveIngestorSource } from "./deliver.ts";
import type { JanelaInfo } from "./types.ts";

export interface JanelaMsg {
  quem: string;
  texto: string;
  quando: string; // ISO-8601 da mensagem
  ref: string; // externalRef da mensagem (dedupe DENTRO da janela — webhook re-entregue não duplica)
}

export interface JanelaConfig {
  silencioMin: number; // minutos de silêncio pra fechar (0 = buffer desligado)
  maxMsgs: number; // teto de mensagens por janela
}

export function janelaConfig(): JanelaConfig {
  const silencioMin = Number(process.env.GALEED_JANELA_MIN ?? 30);
  const maxMsgs = Math.max(1, Number(process.env.GALEED_JANELA_MAX_MSGS ?? 100));
  return { silencioMin: Number.isFinite(silencioMin) && silencioMin >= 0 ? silencioMin : 30, maxMsgs };
}

// ---------- schema (DDL idempotente no boot lazy — mesmo padrão da ingest-queue) ----------

let _ready: Promise<void> | null = null;
let _readyGeneration = -1;

async function db(): Promise<any> {
  const sql = await getSharedSql();
  const gen = sharedSqlGeneration();
  if (_ready && _readyGeneration === gen) {
    await _ready;
    return sql;
  }
  _readyGeneration = gen;
  _ready = (async () => {
    await sql.unsafe(`
      create table if not exists galeed_chat_janela (
        brain text not null,
        ingestor text not null,
        chat_id text not null,
        chat_label text not null default '',
        mensagens jsonb not null default '[]'::jsonb,
        refs jsonb not null default '[]'::jsonb,
        msg_count int not null default 0,
        first_at timestamptz not null default now(),
        last_at timestamptz not null default now(),
        flush_claim timestamptz,
        primary key (brain, ingestor, chat_id)
      )`);
  })();
  await _ready;
  return sql;
}

// ---------- escrita (chamada pelo deliver a cada webhook — precisa ser RÁPIDA) ----------

/** Acrescenta uma mensagem à janela do chat (upsert atômico; dedupe por ref dentro da janela). */
export async function appendToJanela(
  brain: string,
  ingestor: string,
  info: JanelaInfo,
  msg: JanelaMsg,
): Promise<void> {
  const sql = await db();
  // sql.json(...) = serialização ÚNICA da lib (padrão da ingest-queue). Interpolar
  // JSON.stringify(...) com ::jsonb dupla-serializa: o array vira array de STRINGS.
  await sql`
    insert into galeed_chat_janela (brain, ingestor, chat_id, chat_label, mensagens, refs, msg_count, first_at, last_at)
    values (${brain}, ${ingestor}, ${info.chatId}, ${info.chatLabel},
            jsonb_build_array(${sql.json(msg as any)}), jsonb_build_array(${msg.ref}::text), 1, now(), now())
    on conflict (brain, ingestor, chat_id) do update set
      mensagens = case when galeed_chat_janela.refs ? ${msg.ref}
                       then galeed_chat_janela.mensagens
                       else galeed_chat_janela.mensagens || jsonb_build_array(${sql.json(msg as any)}) end,
      refs = case when galeed_chat_janela.refs ? ${msg.ref}
                  then galeed_chat_janela.refs
                  else galeed_chat_janela.refs || jsonb_build_array(${msg.ref}::text) end,
      msg_count = case when galeed_chat_janela.refs ? ${msg.ref}
                       then galeed_chat_janela.msg_count else galeed_chat_janela.msg_count + 1 end,
      chat_label = coalesce(nullif(${info.chatLabel}, ''), galeed_chat_janela.chat_label),
      last_at = now()`;
}

// ---------- flush (worker) ----------

/** Renderiza a página da conversa — PURA (testável): uma linha por mensagem, em ordem. */
export function renderJanela(chatLabel: string, msgs: JanelaMsg[]): { content: string; title: string } {
  const ordenadas = [...msgs].sort((a, b) => a.quando.localeCompare(b.quando));
  const dia = ordenadas[0]?.quando.slice(0, 10) ?? "";
  const hora = (iso: string): string => {
    try {
      return new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" });
    } catch {
      return iso.slice(11, 16);
    }
  };
  const linhas = ordenadas.map((m) => `[${hora(m.quando)}] ${m.quem}: ${m.texto}`);
  const title = `Conversa — ${chatLabel} (${dia})`;
  const content = `# ${title}\n\n${linhas.join("\n")}`;
  return { content, title };
}

export interface FlushResult {
  janelas: number; // janelas fechadas nesta rodada
  mensagens: number; // mensagens ingeridas (somadas)
  jobs: string[]; // jobs criados na fila
  erros: string[];
}

/** Fecha as janelas vencidas: silêncio > config OU msg_count >= teto. Claim com flush_claim
 *  (+ SKIP LOCKED) pra vários workers não brigarem; claim velho (>5min) é considerado morto
 *  e re-reivindicável (worker que caiu no meio do flush não prende a janela pra sempre). */
export async function flushJanelas(cfg: JanelaConfig = janelaConfig()): Promise<FlushResult> {
  const out: FlushResult = { janelas: 0, mensagens: 0, jobs: [], erros: [] };
  // silencioMin=0 NÃO retorna cedo: o buffer está desligado pra mensagens NOVAS (o deliver desvia
  // da janela), mas o que JÁ estava bufferizado precisa drenar — com secs=0 o filtro abaixo vira
  // `last_at < now()` e toda janela existente é tratada como vencida. Seguro: nada novo entra com
  // o buffer desligado, então a tabela só esvazia (sem risco de flushar conversa quente no meio).
  const sql = await db();

  const vencidas = (await sql`
    update galeed_chat_janela j
       set flush_claim = now()
     where (j.brain, j.ingestor, j.chat_id) in (
       select brain, ingestor, chat_id from galeed_chat_janela
        where (last_at < now() - make_interval(secs => ${Math.round(cfg.silencioMin * 60)}) or msg_count >= ${cfg.maxMsgs})
          and (flush_claim is null or flush_claim < now() - interval '5 minutes')
        for update skip locked
        limit 20)
     returning brain, ingestor, chat_id, chat_label, mensagens, first_at, msg_count`) as any[];

  for (const row of vencidas) {
    const brain = row.brain as string;
    const slug = row.ingestor as string;
    try {
      const ing = getIngestor(slug);
      if (!ing) throw new Error(`ingestor "${slug}" não está mais registrado`);
      const msgs = (Array.isArray(row.mensagens) ? row.mensagens : JSON.parse(String(row.mensagens))) as JanelaMsg[];
      const { content, title } = renderJanela(String(row.chat_label || row.chat_id), msgs);
      const sourceId = await resolveIngestorSource(brain, ing);
      const firstIso = new Date(row.first_at).toISOString();
      const r = await deliverConnectorPayload(brain, {
        sourceId,
        content,
        contentType: "text/markdown",
        timestamp: firstIso,
        // ISO COMPLETO (não slice(0,16)): o dedupe de re-flush pós-erro depende do first_at
        // INALTERADO (mesmo valor ⇒ mesmo ref), não da granularidade — e o minuto colidia num
        // burst que fecha duas janelas do mesmo chat dentro do mesmo minuto (teto de msgs).
        externalRef: `janela:${slug}:${row.chat_id}:${firstIso}`,
        title,
      });
      // Só apaga o buffer com a entrega feita — e SÓ se ninguém escreveu durante a entrega. O claim
      // acima é UPDATE autocommit (o row lock morre no fim do statement) e o gateway é OUTRO processo:
      // appendToJanela pode acrescentar a msg N+1 à MESMA linha enquanto o deliver roda (centenas de
      // ms). DELETE incondicional apagaria a N+1 sem nunca ingerir (o canal já recebeu 202 — não
      // reentrega). Condição de versão barata: msg_count igual ao do snapshot ⇒ linha intocada.
      const del = await sql`
        delete from galeed_chat_janela
         where brain = ${brain} and ingestor = ${slug} and chat_id = ${row.chat_id}
           and msg_count = ${Number(row.msg_count)}`;
      if (Number(del.count ?? 0) === 0) {
        // Chegou mensagem durante o flush: APARA só o que foi entregue (refs do snapshot) e devolve
        // a janela (flush_claim=null) — a sobra fecha numa rodada futura por silêncio ou teto.
        // first_at PRECISA resetar pro menor `quando` restante (ou now()): o externalRef deriva do
        // first_at; mantê-lo faria o flush da sobra gerar o MESMO ref e o dedupe do seam engolir a
        // página nova — as mensagens se perderiam uma segunda vez. O dedupe legítimo de re-flush
        // pós-ERRO não passa por aqui (erro não apaga nem apara — first_at segue inalterado lá).
        // Janela residual aceita: se ESTE update falhar (raro — o catch devolve o claim), o próximo
        // flush re-entrega com o MESMO ref e a sobra pode ser engolida — dupla-falha documentada.
        const refsEntregues = msgs.map((m) => m.ref);
        await sql`
          update galeed_chat_janela set
            mensagens = (select coalesce(jsonb_agg(m), '[]'::jsonb)
                           from jsonb_array_elements(mensagens) m
                          where not (${sql.json(refsEntregues as any)}::jsonb ? (m->>'ref'))),
            refs = (select coalesce(jsonb_agg(r2), '[]'::jsonb)
                      from jsonb_array_elements_text(refs) r2
                     where not (${sql.json(refsEntregues as any)}::jsonb ? r2)),
            msg_count = (select count(*)::int
                           from jsonb_array_elements_text(refs) r2
                          where not (${sql.json(refsEntregues as any)}::jsonb ? r2)),
            first_at = coalesce((select min((m->>'quando')::timestamptz)
                                   from jsonb_array_elements(mensagens) m
                                  where not (${sql.json(refsEntregues as any)}::jsonb ? (m->>'ref'))), now()),
            flush_claim = null
          where brain = ${brain} and ingestor = ${slug} and chat_id = ${row.chat_id}`;
      }
      out.janelas++;
      out.mensagens += msgs.length;
      if (r.outcome === "enqueued" && r.jobId) out.jobs.push(r.jobId);
    } catch (err) {
      out.erros.push(`${brain}/${row.chat_id}: ${err instanceof Error ? err.message : err}`);
      await sql`
        update galeed_chat_janela set flush_claim = null
         where brain = ${brain} and ingestor = ${slug} and chat_id = ${row.chat_id}`.catch(() => {});
    }
  }
  return out;
}

/** Visão do buffer (painel/CLI futura): janelas abertas do brain. */
export async function janelasAbertas(brain: string): Promise<{ chatLabel: string; msgs: number; lastAt: string }[]> {
  const sql = await db();
  const rows = (await sql`
    select chat_label, chat_id, msg_count, last_at from galeed_chat_janela
     where brain = ${brain} order by last_at desc limit 50`) as any[];
  return rows.map((r) => ({
    chatLabel: String(r.chat_label || r.chat_id),
    msgs: Number(r.msg_count),
    lastAt: new Date(r.last_at).toISOString(),
  }));
}
