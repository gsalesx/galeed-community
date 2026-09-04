/** Transcrição de áudio via OpenAI Whisper (para ingestão de voz: WhatsApp, ligações).
 *  Usa fetch/FormData/Blob globais (Node 18+). Precisa de OPENAI_API_KEY. */

function extFromUrl(url: string): string {
  const m = url.split("?")[0].match(/\.(mp3|m4a|wav|ogg|oga|webm|mp4|mpga|flac)$/i);
  return m ? m[1].toLowerCase() : "mp3";
}

/** Baixa o áudio de uma URL e transcreve. Retorna o texto. */
export async function transcribeUrl(url: string, model = "whisper-1"): Promise<string> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY necessária para transcrever áudio.");

  const audio = await fetch(url);
  if (!audio.ok) throw new Error(`falha ao baixar áudio (${audio.status})`);
  const buf = Buffer.from(await audio.arrayBuffer());

  const fd = new FormData();
  fd.append("file", new Blob([buf]), `audio.${extFromUrl(url)}`);
  fd.append("model", model);

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { authorization: `Bearer ${key}` },
    body: fd,
  });
  if (!res.ok) throw new Error(`Whisper ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data: any = await res.json();
  return data.text || "";
}
