/** Pipeline de ingestão manual (upload / colar texto / fila).
 *  Extraído da tela Adicionar para o popup em Fontes — mesma API, sem duplicar o worker. */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Button, Card, Dropzone, Icon, StatusChip } from "../../ui";
import { useBrain } from "../../lib/auth";
import { relativeTime } from "../../lib/format";
import { ApiError, INGEST_NAO_TERMINAIS, api, getCurrentBrain } from "../../lib/api";
import type { IngestJob, IngestJobStatus } from "../../lib/api";
import { useQuery } from "../../lib/useQuery";
import { ConfirmDialog } from "../shared/ConfirmDialog";

export type ToastIngest = { msg: string; tone: "ok" | "neutral" | "warn" };

function primeiroSlug(resultJson: IngestJob["resultJson"]): string | undefined {
  const slugs = (resultJson as Record<string, unknown> | undefined)?.slugs;
  if (Array.isArray(slugs) && slugs.length && typeof slugs[0] === "string") return slugs[0];
  return undefined;
}

function mensagemDoJob(j: IngestJob, fallback: string): string {
  if (j.status === "error" || j.status === "dead") return j.errorMessage || j.message || "falhou ao processar.";
  if (typeof j.message === "string" && j.message) return j.message;
  const rjMsg = (j.resultJson as Record<string, unknown> | undefined)?.message;
  if (typeof rjMsg === "string" && rjMsg) return rjMsg;
  return fallback;
}

const TIPOS_PADRAO: { value: string; label: string }[] = [
  { value: "call", label: "Call de venda" },
  { value: "aula", label: "Aula" },
  { value: "reuniao", label: "Reunião" },
  { value: "conversa", label: "Conversa" },
  { value: "documento", label: "Documento" },
];

export interface FilaItem {
  id: string;
  jobId?: string;
  rotulo: string;
  origem: "arquivo" | "texto";
  bytes?: number;
  at: number;
  status: IngestJobStatus;
  progress: number;
  message: string;
  slug?: string;
  canDelete?: boolean;
}

let _seq = 0;
function novoId() {
  _seq += 1;
  return `ing-${Date.now()}-${_seq}`;
}

function previewTexto(t: string): string {
  const limpo = t.replace(/\s+/g, " ").trim();
  return limpo.length > 64 ? `${limpo.slice(0, 64)}…` : limpo;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(new Error("não consegui ler o arquivo."));
    reader.readAsDataURL(file);
  });
}

function jobToItem(j: IngestJob): FilaItem {
  return {
    id: `job-${j.id}`,
    jobId: j.id,
    rotulo: j.filename || (j.kind === "text" ? "texto colado" : "documento"),
    origem: j.kind === "file" ? "arquivo" : "texto",
    at: Date.parse(j.createdAt) || Date.now(),
    status: j.status,
    progress: typeof j.progress === "number" ? j.progress : 0,
    message: mensagemDoJob(j, ""),
    slug: primeiroSlug(j.resultJson),
    canDelete: j.canDelete === true,
  };
}

export function useIngestFila(opts?: { onToast?: (t: ToastIngest) => void }) {
  const { current } = useBrain();
  const onToast = opts?.onToast;
  const [fila, setFila] = useState<FilaItem[]>([]);
  const [engolindo, setEngolindo] = useState(false);
  const [tipo, setTipo] = useState<string>(TIPOS_PADRAO[0].value);
  const [textValue, setTextValue] = useState("");
  const engoleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fontesQ = useQuery("fontes-ativas", () => api.sources.list(), [current?.id]);
  const fontesAtivas = (fontesQ.data ?? []).filter((s) => s.status === "ativa");
  const [fonteId, setFonteId] = useState<string>("");
  useEffect(() => setFonteId(""), [current?.id]);

  const pushNaFila = useCallback((rotulo: string, origem: FilaItem["origem"], bytes?: number): string => {
    setEngolindo(true);
    if (engoleTimer.current) clearTimeout(engoleTimer.current);
    engoleTimer.current = setTimeout(() => setEngolindo(false), 420);
    const id = novoId();
    setFila((cur) => [
      { id, rotulo, origem, bytes, at: Date.now(), status: "queued", progress: 0, message: "na fila…", canDelete: true },
      ...cur,
    ]);
    return id;
  }, []);

  const ligaJob = useCallback((id: string, jobId: string, status: IngestJobStatus) => {
    setFila((cur) => cur.map((f) => (f.id === id ? { ...f, jobId, status } : f)));
  }, []);

  const aplicaErroEnvio = useCallback(
    (id: string, e: unknown) => {
      const msg = e instanceof ApiError ? e.message : (e as Error)?.message || "deu ruim no envio.";
      setFila((cur) => cur.map((f) => (f.id === id ? { ...f, status: "error", progress: 0, message: msg } : f)));
      onToast?.({ msg, tone: "warn" });
    },
    [onToast],
  );

  const enviarArquivo = useCallback(
    async (file: File) => {
      const id = pushNaFila(file.name, "arquivo", file.size);
      try {
        const base64 = await fileToBase64(file);
        const r = await api.ingest.upload({
          type: tipo,
          base64,
          filename: file.name,
          contentType: file.type || "application/octet-stream",
          sourceId: fonteId || undefined,
        });
        ligaJob(id, r.jobId, r.status);
        onToast?.({ msg: "Na fila — processando em background.", tone: "neutral" });
      } catch (e) {
        aplicaErroEnvio(id, e);
      }
    },
    [tipo, fonteId, pushNaFila, ligaJob, aplicaErroEnvio, onToast],
  );

  const enviarTexto = useCallback(
    async (text: string) => {
      const t = text.trim();
      if (!t) return;
      const id = pushNaFila(previewTexto(t), "texto", new Blob([t]).size);
      try {
        const r = await api.ingest.text({ type: tipo, text: t, sourceId: fonteId || undefined });
        ligaJob(id, r.jobId, r.status);
        onToast?.({ msg: "Na fila — processando em background.", tone: "neutral" });
      } catch (e) {
        aplicaErroEnvio(id, e);
      }
    },
    [tipo, fonteId, pushNaFila, ligaJob, aplicaErroEnvio, onToast],
  );

  const temPendente = fila.some((i) => INGEST_NAO_TERMINAIS.includes(i.status) && i.jobId);
  useEffect(() => {
    if (!temPendente) return;
    let vivo = true;
    const t = setInterval(async () => {
      let jobs: IngestJob[];
      try {
        jobs = await api.ingest.jobs();
      } catch {
        return;
      }
      if (!vivo) return;
      const byId = new Map(jobs.map((j) => [j.id, j]));
      setFila((prev) =>
        prev.map((item) => {
          if (!item.jobId) return item;
          const j = byId.get(item.jobId);
          if (!j) return item;
          return {
            ...item,
            status: j.status,
            progress: typeof j.progress === "number" ? j.progress : item.progress,
            message: mensagemDoJob(j, item.message),
            slug: primeiroSlug(j.resultJson) ?? item.slug,
            canDelete: typeof j.canDelete === "boolean" ? j.canDelete : item.canDelete,
          };
        }),
      );
    }, 1600);
    return () => {
      vivo = false;
      clearInterval(t);
    };
  }, [temPendente]);

  useEffect(() => {
    let vivo = true;
    (async () => {
      try {
        const jobs = await api.ingest.jobs();
        if (vivo) setFila(jobs.map(jobToItem));
      } catch {
        /* sem rede: mantém a fila como está */
      }
    })();
    return () => {
      vivo = false;
    };
  }, [current?.id]);

  function onDropFiles(files: File[]) {
    files.forEach((f) => void enviarArquivo(f));
  }
  function onText(text: string) {
    void enviarTexto(text);
  }
  function submitText() {
    const t = textValue.trim();
    if (!t) return;
    void enviarTexto(t);
    setTextValue("");
  }

  const organizando = fila.filter((i) => INGEST_NAO_TERMINAIS.includes(i.status)).length;

  const removerJob = useCallback(
    async (jobId: string) => {
      try {
        await api.ingest.remove(jobId);
        setFila((cur) => cur.filter((f) => f.jobId !== jobId));
        onToast?.({ msg: "Envio removido.", tone: "ok" });
      } catch (e) {
        const msg = e instanceof ApiError ? e.message : (e as Error)?.message || "Não deu pra remover.";
        onToast?.({ msg, tone: "warn" });
        throw e;
      }
    },
    [onToast],
  );

  return {
    fila,
    engolindo,
    tipo,
    setTipo,
    tipos: TIPOS_PADRAO,
    fonteId,
    setFonteId,
    fontesAtivas,
    textValue,
    setTextValue,
    onDropFiles,
    onText,
    submitText,
    organizando,
    removerJob,
    brainId: current?.id || getCurrentBrain(),
  };
}

function Secao({ titulo, hint, children }: { titulo: string; hint?: string; children: ReactNode }) {
  return (
    <section style={{ display: "grid", gap: 10 }}>
      <div>
        <h3
          className="mono"
          style={{
            margin: 0,
            fontSize: 11,
            fontWeight: 600,
            color: "var(--faint)",
            textTransform: "uppercase",
            letterSpacing: ".05em",
          }}
        >
          {titulo}
        </h3>
        {hint ? (
          <p style={{ margin: "3px 0 0", fontSize: 12.5, color: "var(--muted)", lineHeight: 1.45 }}>{hint}</p>
        ) : null}
      </div>
      {children}
    </section>
  );
}

const SELECT_STYLE = {
  height: 34,
  padding: "0 12px",
  borderRadius: 8,
  border: "1px solid var(--border-strong)",
  background: "var(--surface)",
  color: "var(--fg)",
  fontFamily: "var(--font)",
  fontSize: 14,
} as const;

export function IngestForm({ ingest }: { ingest: ReturnType<typeof useIngestFila> }) {
  const {
    engolindo,
    tipo,
    setTipo,
    tipos,
    fonteId,
    setFonteId,
    fontesAtivas,
    textValue,
    setTextValue,
    onDropFiles,
    onText,
    submitText,
  } = ingest;

  return (
    <div style={{ display: "grid", gap: 22 }}>
      <style>{KEYFRAMES}</style>

      <Secao titulo="Arquivo" hint="PDF, Markdown, TXT ou CSV. Entra na fila na hora.">
        <div style={{ position: "relative", animation: engolindo ? "galeed-swallow .42s ease" : undefined }}>
          <Dropzone
            title="Solte o arquivo aqui"
            hint="Arraste, cole ou clique para escolher."
            onDrop={onDropFiles}
            onText={onText}
            accept={[".pdf", ".md", ".markdown", ".txt", ".csv", ".tsv"]}
            kinds={[
              { label: "pdf", icon: <Icon name="pdf" size={12} /> },
              { label: "markdown", icon: <Icon name="info" size={12} /> },
              { label: "txt", icon: <Icon name="info" size={12} /> },
              { label: "csv", icon: <Icon name="info" size={12} /> },
            ]}
            style={{ padding: "28px 18px" }}
          />
          {engolindo && (
            <span
              aria-hidden
              className="mono"
              style={{
                position: "absolute",
                top: 10,
                right: 12,
                fontSize: 11,
                color: "var(--accent-ink)",
                background: "var(--accent-soft)",
                borderRadius: 99,
                padding: "3px 10px",
                fontWeight: 600,
              }}
            >
              engolindo…
            </span>
          )}
        </div>
      </Secao>

      <Secao titulo="Texto" hint="Cola uma conversa, anotação ou trecho.">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submitText();
          }}
          style={{ display: "grid", gap: 8 }}
        >
          <textarea
            value={textValue}
            onChange={(e) => setTextValue(e.target.value)}
            placeholder="Cole o texto aqui…"
            aria-label="Colar texto"
            rows={4}
            style={{
              width: "100%",
              padding: "10px 12px",
              borderRadius: 8,
              border: "1px solid var(--border-strong)",
              background: "var(--surface)",
              color: "var(--fg)",
              fontFamily: "var(--font)",
              fontSize: 14,
              resize: "vertical",
              minHeight: 88,
            }}
          />
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <Button type="submit" variant="secondary" disabled={!textValue.trim()} icon={<Icon name="plus" size={15} />}>
              Adicionar texto
            </Button>
          </div>
        </form>
      </Secao>

      <Secao
        titulo="Entra por qual fonte"
        hint="Com fonte, só o que as regras guardam vira fato — o resto vai pra revisar."
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <label htmlFor="ingest-fonte" className="mono" style={{ fontSize: 11, color: "var(--faint)", fontWeight: 600 }}>
            Fonte
          </label>
          <select
            id="ingest-fonte"
            value={fonteId}
            onChange={(e) => setFonteId(e.target.value)}
            aria-label="Fonte por onde o material entra"
            style={SELECT_STYLE}
          >
            <option value="">— sem fonte (modo livre)</option>
            {fontesAtivas.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <label htmlFor="ingest-tipo" className="mono" style={{ fontSize: 11, color: "var(--faint)", fontWeight: 600 }}>
            Tipo
          </label>
          <select
            id="ingest-tipo"
            value={tipo}
            onChange={(e) => setTipo(e.target.value)}
            aria-label="Tipo do que você vai adicionar"
            style={SELECT_STYLE}
          >
            {tipos.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
      </Secao>
    </div>
  );
}

export function FilaLista({ ingest }: { ingest: ReturnType<typeof useIngestFila> }) {
  const { fila, brainId, removerJob } = ingest;
  const [pedido, setPedido] = useState<FilaItem | null>(null);
  const [busy, setBusy] = useState(false);

  async function confirmarRemover() {
    if (!pedido?.jobId) return;
    setBusy(true);
    try {
      await removerJob(pedido.jobId);
      setPedido(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <style>{KEYFRAMES}</style>
      {fila.length === 0 ? (
        <Card padding="22px 20px">
          <p style={{ color: "var(--muted)", fontSize: 14, margin: 0 }}>
            Nada na fila ainda. Adicione um arquivo ou texto — entra na hora e o worker organiza em
            background.
          </p>
        </Card>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {fila.map((it) => (
            <FilaLinha
              key={it.id}
              item={it}
              brainId={brainId}
              onRemove={it.canDelete && it.jobId ? () => setPedido(it) : undefined}
            />
          ))}
        </div>
      )}
      <ConfirmDialog
        open={pedido != null}
        title="Remover este envio"
        text="Some este arquivo ou texto e os fatos que saíram só dele. O que veio do WhatsApp ou de outro envio fica. O cérebro não é relido — o resto permanece como está."
        confirmLabel="Remover"
        danger
        busy={busy}
        onConfirm={() => void confirmarRemover()}
        onCancel={() => {
          if (!busy) setPedido(null);
        }}
      />
    </div>
  );
}

const ORIGEM_ICON: Record<FilaItem["origem"], "pdf" | "info"> = {
  arquivo: "pdf",
  texto: "info",
};

function FilaLinha({
  item,
  brainId,
  onRemove,
}: {
  item: FilaItem;
  brainId: string;
  onRemove?: () => void;
}) {
  const queued = item.status === "queued";
  const processing = item.status === "processing";
  const buscavel =
    item.status === "findable" ||
    item.status === "digesting" ||
    item.status === "batch_submitted" ||
    item.status === "batch_harvesting";
  const pronto = item.status === "done" || item.status === "digested";
  const erro = item.status === "error" || item.status === "dead";
  const barra = processing || buscavel;
  const sourceHref =
    pronto && item.origem === "arquivo" && item.slug
      ? `/api/source?slug=${encodeURIComponent(item.slug)}${brainId ? `&brain=${encodeURIComponent(brainId)}` : ""}`
      : null;
  const pct = Math.max(0, Math.min(100, Math.round((item.progress || 0) * 100)));
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "11px 14px",
        borderRadius: 10,
        border: `1px solid ${erro ? "var(--st-hypo)" : "var(--border)"}`,
        background: "var(--surface)",
        animation: "galeed-rise .28s ease",
        opacity: queued ? 0.85 : 1,
      }}
    >
      <span
        aria-hidden
        style={{
          flexShrink: 0,
          width: 32,
          height: 32,
          borderRadius: 8,
          display: "grid",
          placeItems: "center",
          background: "var(--surface-2)",
          border: "1px solid var(--border)",
          color: "var(--faint)",
        }}
      >
        <Icon name={ORIGEM_ICON[item.origem]} size={16} />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 14,
            fontWeight: 500,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
          title={item.rotulo}
        >
          {item.rotulo}
        </div>
        <div className="mono" style={{ fontSize: 11, color: "var(--faint)", marginTop: 2 }}>
          {item.origem} · {relativeTime(item.at)}
          {item.message ? <> · {item.message}</> : null}
        </div>
        {barra && (
          <>
            {buscavel && (
              <div className="mono" style={{ fontSize: 11, color: "var(--faint)", marginTop: 4 }}>
                digerindo fatos {pct}%
              </div>
            )}
            <div
              aria-hidden
              style={{
                marginTop: 6,
                height: 5,
                borderRadius: 99,
                background: "var(--surface-2)",
                border: "1px solid var(--border)",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  width: `${pct}%`,
                  height: "100%",
                  background: "var(--accent)",
                  borderRadius: 99,
                  transition: "width .4s ease",
                }}
              />
            </div>
          </>
        )}
        {sourceHref && (
          <a
            href={sourceHref}
            target="_blank"
            rel="noreferrer"
            style={{
              fontSize: 11.5,
              color: "var(--accent-ink)",
              marginTop: 3,
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
            }}
          >
            <Icon name="arrow" size={12} /> de onde veio
          </a>
        )}
      </div>

      {onRemove ? (
        <Button
          size="sm"
          variant="ghost"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          style={{ color: "var(--danger)", flexShrink: 0 }}
        >
          Remover
        </Button>
      ) : null}

      {erro ? (
        <StatusChip variant="hypo" label="Erro" />
      ) : pronto ? (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span aria-hidden style={{ color: "var(--ok)", display: "inline-flex" }}>
            <Icon name="check" size={14} />
          </span>
          <StatusChip variant="ent" label="Pronto" />
        </span>
      ) : buscavel ? (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span aria-hidden style={{ color: "var(--ok)", display: "inline-flex" }}>
            <Icon name="check" size={14} />
          </span>
          <StatusChip variant="ent" label="Buscável" />
          <span
            aria-hidden
            style={{ display: "inline-flex", animation: "galeed-spin 1s linear infinite", color: "var(--accent)" }}
          >
            <Icon name="clock" size={14} />
          </span>
        </span>
      ) : processing ? (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span className="mono" style={{ fontSize: 11, color: "var(--faint)" }}>
            {pct}%
          </span>
          <span
            aria-hidden
            style={{ display: "inline-flex", animation: "galeed-spin 1s linear infinite", color: "var(--accent)" }}
          >
            <Icon name="clock" size={14} />
          </span>
          <StatusChip variant="reg" label="Processando" />
        </span>
      ) : (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span
            aria-hidden
            style={{ display: "inline-flex", animation: "galeed-spin 1s linear infinite", color: "var(--accent)" }}
          >
            <Icon name="clock" size={14} />
          </span>
          <StatusChip variant="reg" label="Na fila" />
        </span>
      )}
    </div>
  );
}

const KEYFRAMES = `
@keyframes galeed-swallow {
  0% { transform: scale(1); }
  40% { transform: scale(0.985); }
  100% { transform: scale(1); }
}
@keyframes galeed-rise {
  0% { opacity: 0; transform: translateY(-6px); }
  100% { opacity: 1; transform: translateY(0); }
}
@keyframes galeed-spin {
  to { transform: rotate(360deg); }
}
`;
