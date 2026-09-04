/** Tela ADICIONAR (M8 → M11/S5 → M12/S6) — Fontes / Ingestão: "só joga que a gente organiza".
 *
 *  A TESE DOS DOIS TEMPOS, agora ASSÍNCRONA (M12/S6):
 *   • Tempo 1 — ENGOLIR: a Dropzone aceita arquivo (PDF/MD/TXT/CSV) ou texto colado.
 *     O upload NÃO trava: `POST /api/ingest` responde 202 `{ jobId, status:"queued" }` na hora.
 *   • Tempo 2 — ORGANIZAR: um WORKER em background processa o job (fatia → extrai COM contexto →
 *     indexa → guarda o original). A tela acompanha por POLLING de `api.ingest.jobs()` e mostra
 *     a FILA com status/progresso: na fila → processando (barra) → pronto | erro.
 *
 *  Honesto: a extração roda no worker dedicado (`npm run worker`). Se ele não estiver de pé, os
 *  jobs ficam "na fila" — a tela mostra isso, não finge que já organizou.
 *
 *  Estrutura (dentro do <main> do AppShell):
 *   1. page-head   — h1 + subtítulo + tese curta (Tempo 1 / Tempo 2)
 *   2. seletor tipo + dropzone — escolhe o tipo, depois solta arquivo/texto
 *   3. fila        — itens reais → na fila / processando (progresso) / pronto / erro + "de onde veio"
 *   4. automática  — card discreto que aponta pra Conectar (fonte única de verdade da API/webhook)
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Button, Card, Dropzone, Icon, StatusChip, Toast } from "../../ui";
import { useBrain } from "../../lib/auth";
import { relativeTime } from "../../lib/format";
import { ApiError, INGEST_NAO_TERMINAIS, api, getCurrentBrain } from "../../lib/api";
import type { IngestJob, IngestJobStatus } from "../../lib/api";
import { useQuery } from "../../lib/useQuery";

/** Extrai com segurança o 1º slug de resultJson (que é Record<string,unknown> em api.ts). */
function primeiroSlug(resultJson: IngestJob["resultJson"]): string | undefined {
  const slugs = (resultJson as Record<string, unknown> | undefined)?.slugs;
  if (Array.isArray(slugs) && slugs.length && typeof slugs[0] === "string") return slugs[0];
  return undefined;
}

/** Mensagem legível a partir do job — nunca expõe JSON cru. */
function mensagemDoJob(j: IngestJob, fallback: string): string {
  if (j.status === "error" || j.status === "dead") return j.errorMessage || j.message || "falhou ao processar.";
  if (typeof j.message === "string" && j.message) return j.message;
  const rjMsg = (j.resultJson as Record<string, unknown> | undefined)?.message;
  if (typeof rjMsg === "string" && rjMsg) return rjMsg;
  return fallback;
}

/** Tipos DECLARADOS (D4) — lista padrão curta enquanto o contexto (S6) não traz `sourceTypes`. */
const TIPOS_PADRAO: { value: string; label: string }[] = [
  { value: "call", label: "Call de venda" },
  { value: "aula", label: "Aula" },
  { value: "reuniao", label: "Reunião" },
  { value: "conversa", label: "Conversa" },
  { value: "documento", label: "Documento" },
];

/** Item da fila atrelado a um JOB (M12). Estado/progresso vêm do polling de api.ingest.jobs(). */
interface FilaItem {
  id: string;                 // id local (estável p/ a key da lista, mesmo antes do enqueue voltar)
  jobId?: string;             // setado quando o enqueue (202) retorna; é a chave do polling
  rotulo: string;
  origem: "arquivo" | "texto";
  bytes?: number;
  at: number;
  status: IngestJobStatus;    // queued | processing | findable | digesting | digested | done | error
  progress: number;           // 0..1
  message: string;            // legível (job.message / resultJson.message / errorMessage)
  slug?: string;              // 1º slug de resultJson.slugs → link "de onde veio" (só uploads done)
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

/** Lê um File → base64 puro (sem o prefixo `data:...;base64,`). */
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

/** Converte um job persistido (api.ingest.jobs) num item da fila — usado pra HIDRATAR a tela no
 *  mount/refresh, pra um job em andamento (ou recém-concluído) NÃO sumir ao recarregar a página. */
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
  };
}

export default function Adicionar() {
  const { current } = useBrain();
  const [fila, setFila] = useState<FilaItem[]>([]);
  const [engolindo, setEngolindo] = useState(false);
  const [tipo, setTipo] = useState<string>(TIPOS_PADRAO[0].value);
  const [toast, setToast] = useState<{ msg: string; tone: "ok" | "neutral" | "warn" } | null>(null);
  const [textValue, setTextValue] = useState("");
  const engoleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // M21/S5 — o material ENTRA por uma fonte (HTC #3): só fontes ATIVAS aparecem;
  // "" = sem fonte (modo livre, comportamento pré-M21). Pausada some da lista.
  const fontesQ = useQuery("fontes-ativas", () => api.sources.list(), [current?.id]);
  const fontesAtivas = (fontesQ.data ?? []).filter((s) => s.status === "ativa");
  const [fonteId, setFonteId] = useState<string>("");
  useEffect(() => setFonteId(""), [current?.id]); // trocou de brain → volta pro modo livre

  /** Anima o "engole" (Tempo 1) e devolve o id do item recém-criado na fila (status queued). */
  const pushNaFila = useCallback((rotulo: string, origem: FilaItem["origem"], bytes?: number): string => {
    setEngolindo(true);
    if (engoleTimer.current) clearTimeout(engoleTimer.current);
    engoleTimer.current = setTimeout(() => setEngolindo(false), 420);
    const id = novoId();
    setFila((cur) => [
      { id, rotulo, origem, bytes, at: Date.now(), status: "queued", progress: 0, message: "na fila…" },
      ...cur,
    ]);
    return id;
  }, []);

  /** Liga o item local ao jobId devolvido pelo enqueue (202). NÃO espera o processamento. */
  const ligaJob = useCallback((id: string, jobId: string, status: IngestJobStatus) => {
    setFila((cur) => cur.map((f) => (f.id === id ? { ...f, jobId, status } : f)));
  }, []);

  /** Falha no PRÓPRIO enqueue (rede / 4xx) — vira erro local imediato. */
  const aplicaErroEnvio = useCallback((id: string, e: unknown) => {
    const msg = e instanceof ApiError ? e.message : (e as Error)?.message || "deu ruim no envio.";
    setFila((cur) => cur.map((f) => (f.id === id ? { ...f, status: "error", progress: 0, message: msg } : f)));
    setToast({ msg, tone: "warn" });
  }, []);

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
          sourceId: fonteId || undefined, // M21/S5: entra sob o contrato da fonte escolhida
        });
        ligaJob(id, r.jobId, r.status);
        setToast({ msg: "Na fila — organizando em background.", tone: "neutral" });
      } catch (e) {
        aplicaErroEnvio(id, e);
      }
    },
    [tipo, fonteId, pushNaFila, ligaJob, aplicaErroEnvio],
  );

  const enviarTexto = useCallback(
    async (text: string) => {
      const t = text.trim();
      if (!t) return;
      const id = pushNaFila(previewTexto(t), "texto", new Blob([t]).size);
      try {
        const r = await api.ingest.text({ type: tipo, text: t, sourceId: fonteId || undefined });
        ligaJob(id, r.jobId, r.status);
        setToast({ msg: "Na fila — organizando em background.", tone: "neutral" });
      } catch (e) {
        aplicaErroEnvio(id, e);
      }
    },
    [tipo, fonteId, pushNaFila, ligaJob, aplicaErroEnvio],
  );

  /* ---- POLLING (o coração do S6) -------------------------------------------
   * Enquanto houver item não-terminal (queued/processing) com jobId, bate em
   * api.ingest.jobs() a cada ~1.6s e atualiza status/progress/message por jobId.
   * Para quando todos terminam (early-return → sem intervalo). Limpa no unmount.
   * Resiliente a erro de rede (catch silencioso — não derruba a tela).
   * -------------------------------------------------------------------------- */
  // Lista CANÔNICA importada de lib/api.ts (fim da lista duplicada à mão): inclui batch_submitted/
  // batch_harvesting — antes, quando o job roteava pra Batch API, o polling morria e o item congelava
  // no último status visto até um F5. Segue polling até o terminal (done | digested | error | dead).
  const temPendente = fila.some((i) => INGEST_NAO_TERMINAIS.includes(i.status) && i.jobId);
  useEffect(() => {
    if (!temPendente) return;
    let vivo = true;
    const t = setInterval(async () => {
      let jobs: IngestJob[];
      try {
        jobs = await api.ingest.jobs();
      } catch {
        return; // rede instável: tenta de novo no próximo tick, sem quebrar a tela
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
          };
        }),
      );
    }, 1600);
    return () => {
      vivo = false;
      clearInterval(t);
    };
  }, [temPendente]);

  /* HIDRATA a fila no mount (e ao trocar de brain): carrega os jobs persistidos (api.ingest.jobs) pra
   * um job em andamento NÃO sumir ao recarregar a página. O polling acima assume a partir daí. */
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

  const brainId = current?.id || getCurrentBrain();

  return (
    <div style={{ maxWidth: 880, margin: "0 auto", padding: "8px 0 64px" }}>
      <style>{KEYFRAMES}</style>

      {/* 1. page-head + tese dos dois tempos */}
      <header style={{ marginBottom: 22 }}>
        <h1 style={{ fontSize: 26, fontWeight: 700, letterSpacing: "-0.01em" }}>Adicionar</h1>
        <p style={{ color: "var(--muted)", marginTop: 6, fontSize: 15, maxWidth: "60ch" }}>
          Só joga que a gente organiza{current ? <> — no cérebro <strong>{current.name}</strong></> : null}. Você
          escolhe só o que é (pra ancorar no contexto) e solta. O cérebro extrai e guarda o original.
        </p>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 14 }}>
          <TeseTempo n={1} titulo="Engolir" desc="Arquivo (PDF/MD/TXT/CSV) ou texto colado — entra na fila na hora, sem travar." />
          <TeseTempo n={2} titulo="Organizar" desc="Buscável na hora — você já pode perguntar — enquanto o cérebro digere os fatos em background." />
        </div>
      </header>

      {/* 2. Seletor de TIPO (D4) + Dropzone gigante */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
        <label htmlFor="ingest-tipo" className="mono" style={{ fontSize: 11, color: "var(--faint)", fontWeight: 600, textTransform: "uppercase", letterSpacing: ".05em" }}>
          O que é isso?
        </label>
        <select
          id="ingest-tipo"
          value={tipo}
          onChange={(e) => setTipo(e.target.value)}
          aria-label="Tipo do que você vai adicionar"
          style={{
            height: 34,
            padding: "0 12px",
            borderRadius: 8,
            border: "1px solid var(--border-strong)",
            background: "var(--surface)",
            color: "var(--fg)",
            fontFamily: "var(--font)",
            fontSize: 14,
          }}
        >
          {TIPOS_PADRAO.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
        <span style={{ fontSize: 12.5, color: "var(--faint)" }}>
          ancora no contexto do cérebro (você diz o tipo no ato).
        </span>
      </div>

      {/* M21/S5 — seletor de FONTE: o material entra pelo contrato (receita) de uma fonte */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
        <label
          htmlFor="ingest-fonte"
          className="mono"
          style={{ fontSize: 11, color: "var(--faint)", fontWeight: 600, textTransform: "uppercase", letterSpacing: ".05em" }}
        >
          Entra pela fonte:
        </label>
        <select
          id="ingest-fonte"
          value={fonteId}
          onChange={(e) => setFonteId(e.target.value)}
          aria-label="Fonte por onde o material entra"
          style={{
            height: 34,
            padding: "0 12px",
            borderRadius: 8,
            border: "1px solid var(--border-strong)",
            background: "var(--surface)",
            color: "var(--fg)",
            fontFamily: "var(--font)",
            fontSize: 14,
          }}
        >
          <option value="">— sem fonte (modo livre)</option>
          {fontesAtivas.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <span style={{ fontSize: 12.5, color: "var(--faint)" }}>
          com fonte, só a receita dela vira fato — o resto vai pra fila de revisão.
        </span>
      </div>

      <div
        style={{
          position: "relative",
          animation: engolindo ? "galeed-swallow .42s ease" : undefined,
        }}
      >
        <Dropzone
          title="Só joga aqui"
          hint="Arraste um arquivo (PDF, Markdown, TXT ou CSV), cole um texto, ou clique para escolher."
          onDrop={onDropFiles}
          onText={onText}
          accept={[".pdf", ".md", ".markdown", ".txt", ".csv", ".tsv"]}
          kinds={[
            { label: "pdf", icon: <Icon name="pdf" size={12} /> },
            { label: "markdown", icon: <Icon name="info" size={12} /> },
            { label: "txt", icon: <Icon name="info" size={12} /> },
            { label: "csv", icon: <Icon name="info" size={12} /> },
          ]}
          style={{ padding: "52px 24px" }}
        />
        {engolindo && (
          <span
            aria-hidden
            style={{
              position: "absolute",
              top: 14,
              right: 16,
              fontSize: 11,
              color: "var(--accent-ink)",
              background: "var(--accent-soft)",
              borderRadius: 99,
              padding: "3px 10px",
              fontWeight: 600,
            }}
            className="mono"
          >
            engolindo…
          </span>
        )}
      </div>

      {/* atalho colar-texto explícito (acessível) */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submitText();
        }}
        style={{ display: "flex", gap: 8, marginTop: 12 }}
      >
        <input
          type="text"
          value={textValue}
          onChange={(e) => setTextValue(e.target.value)}
          placeholder="…ou cole um texto aqui e dê Enter"
          aria-label="Colar texto"
          style={{
            flex: 1,
            height: 38,
            padding: "0 14px",
            borderRadius: 8,
            border: "1px solid var(--border-strong)",
            background: "var(--surface)",
            color: "var(--fg)",
            fontFamily: "var(--font)",
            fontSize: 14,
          }}
        />
        <Button type="submit" variant="secondary" disabled={!textValue.trim()} icon={<Icon name="plus" size={15} />}>
          Adicionar
        </Button>
      </form>

      {/* 3. Fila "Organizando" (REAL) */}
      <section style={{ marginTop: 28 }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 12 }}>
          <h2 style={{ fontSize: 16, fontWeight: 600 }}>
            Organizando{" "}
            <span className="mono" style={{ color: "var(--faint)", fontSize: 12, fontWeight: 500 }}>
              {fila.length > 0 ? `(${fila.length})` : ""}
            </span>
          </h2>
        </div>

        {fila.length === 0 ? (
          <Card padding="22px 20px">
            <p style={{ color: "var(--muted)", fontSize: 14 }}>
              Nada na fila ainda. Escolha o tipo lá em cima e solte um arquivo ou cole um texto — entra
              na fila na hora e um worker organiza em background (você acompanha o progresso aqui).
            </p>
          </Card>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {fila.map((it) => (
              <FilaLinha key={it.id} item={it} brainId={brainId} />
            ))}
          </div>
        )}
      </section>

      {/* 4. Ingestão automática — discreto, aponta pra Conectar (fonte única de verdade) */}
      <section style={{ marginTop: 36 }}>
        <Card padding="14px 18px" style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <span
            aria-hidden
            style={{ display: "grid", placeItems: "center", width: 36, height: 36, borderRadius: 10, background: "var(--surface-2)", border: "1px solid var(--border)", color: "var(--muted)", flexShrink: 0 }}
          >
            <Icon name="arrow" size={16} />
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 600 }}>Ingestão automática</div>
            <p style={{ margin: "3px 0 0", fontSize: 12.5, color: "var(--muted)", lineHeight: 1.5 }}>
              Notetaker, e-mail, WhatsApp ou automações (Zapier/Make) podem mandar cada evento direto pro
              cérebro pela API. As instruções completas estão em Conectar.
            </p>
          </div>
          <Link
            to="/app/conectar"
            style={{ flexShrink: 0, fontSize: 13, fontWeight: 600, color: "var(--accent-ink)", textDecoration: "none", whiteSpace: "nowrap" }}
          >
            Abrir Conectar →
          </Link>
        </Card>
      </section>

      {/* toasts */}
      {toast && (
        <div style={{ position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)", zIndex: 50 }}>
          <Toast tone={toast.tone} onClose={() => setToast(null)}>
            {toast.msg}
          </Toast>
        </div>
      )}
    </div>
  );
}

/* ---------- subcomponentes locais ---------- */

function TeseTempo({ n, titulo, desc }: { n: number; titulo: string; desc: string }) {
  return (
    <div
      style={{
        flex: "1 1 240px",
        display: "flex",
        gap: 10,
        alignItems: "flex-start",
        padding: "10px 12px",
        borderRadius: 10,
        border: "1px solid var(--border)",
        background: "var(--surface-2)",
      }}
    >
      <span
        className="mono"
        aria-hidden
        style={{
          flexShrink: 0,
          width: 22,
          height: 22,
          borderRadius: 6,
          display: "grid",
          placeItems: "center",
          background: "var(--accent-soft)",
          color: "var(--accent-ink)",
          fontSize: 12,
          fontWeight: 700,
        }}
      >
        {n}
      </span>
      <div>
        <div style={{ fontSize: 13.5, fontWeight: 600 }}>
          Tempo {n} — {titulo}
        </div>
        <div style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 2 }}>{desc}</div>
      </div>
    </div>
  );
}

const ORIGEM_ICON: Record<FilaItem["origem"], "pdf" | "info"> = {
  arquivo: "pdf",
  texto: "info",
};

function FilaLinha({ item, brainId }: { item: FilaItem; brainId: string }) {
  const queued = item.status === "queued";
  const processing = item.status === "processing";
  // M15/S2 — duas fases: `findable`/`digesting` = "Buscável já · digerindo fatos X%".
  // batch_* entra aqui também: a Fase A concluiu (cérebro JÁ buscável), a digestão roda em lote na
  // Anthropic (minutos/horas) — sem este branch o item caía num limbo visual (nem pronto, nem erro).
  const buscavel =
    item.status === "findable" ||
    item.status === "digesting" ||
    item.status === "batch_submitted" ||
    item.status === "batch_harvesting";
  // `digested` é o terminal de sucesso novo (M15); `done` (M12–M14) segue aceito. Ambos → "Pronto".
  const pronto = item.status === "done" || item.status === "digested";
  const erro = item.status === "error" || item.status === "dead"; // P0-C — dead é falha visível (reaper desistiu)
  // a barra de digestão aparece tanto no legado (`processing`) quanto nas 2 fases novas (`buscavel`).
  const barra = processing || buscavel;
  // link "de onde veio": só uploads (texto colado não tem original), só quando pronto + tem slug
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
            style={{ fontSize: 11.5, color: "var(--accent-ink)", marginTop: 3, display: "inline-flex", alignItems: "center", gap: 4 }}
          >
            <Icon name="arrow" size={12} /> de onde veio
          </a>
        )}
      </div>

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
        // M15: cérebro JÁ buscável (Fase A reportada) — "Buscável" + spinner de digestão em background.
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span aria-hidden style={{ color: "var(--ok)", display: "inline-flex" }}>
            <Icon name="check" size={14} />
          </span>
          <StatusChip variant="ent" label="Buscável" />
          <span aria-hidden style={{ display: "inline-flex", animation: "galeed-spin 1s linear infinite", color: "var(--accent)" }}>
            <Icon name="clock" size={14} />
          </span>
        </span>
      ) : processing ? (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span className="mono" style={{ fontSize: 11, color: "var(--faint)" }}>{pct}%</span>
          <span aria-hidden style={{ display: "inline-flex", animation: "galeed-spin 1s linear infinite", color: "var(--accent)" }}>
            <Icon name="clock" size={14} />
          </span>
          <StatusChip variant="reg" label="Processando" />
        </span>
      ) : (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span aria-hidden style={{ display: "inline-flex", animation: "galeed-spin 1s linear infinite", color: "var(--accent)" }}>
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
