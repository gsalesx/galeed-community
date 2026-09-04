/** Ingestor "notetaker" — transcrições de reunião de QUALQUER notetaker (Fireflies, tl;dv,
 *  MeetGeek, Otter…) via automação (Zapier/Make/n8n) ou webhook próprio que consiga mandar o
 *  TEXTO da transcrição no corpo.
 *
 *  Por que não "Fireflies nativo": o webhook do Fireflies manda só { meetingId, eventType } — o
 *  transcript precisa ser BUSCADO na API GraphQL deles com chave. Aqui é o contrário: quem chama
 *  já manda o texto (a automação busca), e este ingestor vira universal.
 *
 *  Aceita: { title?, transcript | text | summary, occurred_at? | date?, participants?, ref? | meeting_id? } */
import { createHash } from "node:crypto";
import type { Ingestor, IngestorItem } from "./types.ts";

function sha16(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function participantes(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((p) => str(p)).filter(Boolean);
  const s = str(v);
  return s ? s.split(/[,;]+/).map((p) => p.trim()).filter(Boolean) : [];
}

export const notetakerIngestor: Ingestor = {
  slug: "notetaker",
  nome: "Reuniões (notetaker)",
  descricao: "Transcrições de reunião de qualquer notetaker — mande o texto via Zapier/Make/n8n ou webhook próprio.",
  exemplo: `{ "title": "Reunião comercial — Acme", "transcript": "Kelvin: fechamos em R$ 2.500/mês...", "participants": ["Kelvin", "Mariana"], "occurred_at": "2026-07-01T14:00:00Z" }`,

  sourceSeed() {
    return {
      name: "Reuniões",
      channel: "reuniao",
      // 'reuniao' (não 'call'): resolveTipo conhece o alias → page.type = 'reunioes', o que liga o
      // grafo de falantes (indexer) e o decay de reunião (recency). 'call' colapsava pra 'notas'.
      // Instalação antiga mantém a fonte com type 'call' (deliver só cria na 1ª entrega) — data-fix:
      // UPDATE de 1 linha no type da fonte.
      type: "reuniao",
      recipe: { fields: [] },
    };
  },

  normalize(body): IngestorItem[] {
    const b = (body ?? {}) as Record<string, unknown>;
    const transcript = str(b.transcript) || str(b.text) || str(b.summary);
    if (!transcript) return []; // ping sem transcript (ex.: webhook cru do Fireflies) → ignora

    const title = str(b.title) || "Reunião";
    const quem = participantes(b.participants);
    const occurred = str(b.occurred_at) || str(b.date);
    const timestamp = occurred && !Number.isNaN(Date.parse(occurred))
      ? new Date(occurred).toISOString()
      : new Date().toISOString();
    const externalRef =
      str(b.ref) || str(b.meeting_id) || `reuniao:${sha16(`${title}\n${timestamp.slice(0, 10)}\n${transcript.slice(0, 400)}`)}`;

    // Rótulos com TRAVESSÃO (não "Rótulo: valor"): o segmentador de conversa lê "Palavra: texto"
    // como FALANTE — "Data: 2026-07-02" virava a pessoa "Data" abrindo a reunião (baseline A/B).
    const cabecalho = [
      `# ${title}`,
      quem.length ? `Participantes — ${quem.join(", ")}` : "",
      `Data — ${timestamp.slice(0, 10)}`,
    ].filter(Boolean).join("\n");

    return [{
      content: `${cabecalho}\n\n${transcript}`,
      contentType: "text/markdown",
      timestamp,
      externalRef,
      title,
    }];
  },
};
