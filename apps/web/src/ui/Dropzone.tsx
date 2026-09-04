/** Dropzone — "só joga aqui". Aceita arquivo (drop/click), texto e colar.
 *  Estado .over no drag-over (border accent + fundo accent-soft). */
import { useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";

export interface DropzoneKind {
  icon?: ReactNode;
  label: string;
}

export interface DropzoneProps {
  /** chamado com os arquivos soltos/escolhidos */
  onDrop?: (files: File[]) => void;
  /** chamado com texto colado/solto (drag de texto ou Ctrl+V quando focado) */
  onText?: (text: string) => void;
  accept?: string[];
  title?: string;
  hint?: string;
  /** tipos aceitos exibidos como chips mono */
  kinds?: DropzoneKind[];
  icon?: ReactNode;
  style?: CSSProperties;
}

export function Dropzone({
  onDrop,
  onText,
  accept,
  title = "Só joga aqui",
  hint = "Arraste um arquivo, cole um texto ou clique para escolher.",
  kinds,
  icon,
  style,
}: DropzoneProps) {
  const [over, setOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setOver(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length && onDrop) onDrop(files);
    const text = e.dataTransfer.getData("text");
    if (text && onText) onText(text);
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => inputRef.current?.click()}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") inputRef.current?.click();
      }}
      onPaste={(e) => {
        const text = e.clipboardData.getData("text");
        if (text && onText) onText(text);
        const files = Array.from(e.clipboardData.files);
        if (files.length && onDrop) onDrop(files);
      }}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={handleDrop}
      style={{
        border: `2px dashed ${over ? "var(--accent)" : "var(--border-strong)"}`,
        borderRadius: 16,
        background: over ? "var(--accent-soft)" : "var(--surface-2)",
        padding: "38px 24px",
        textAlign: "center",
        cursor: "pointer",
        transition: "border-color .12s, background .12s",
        ...style,
      }}
    >
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={accept?.join(",")}
        style={{ display: "none" }}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          if (files.length && onDrop) onDrop(files);
          e.target.value = "";
        }}
      />
      <div
        aria-hidden
        style={{
          width: 54,
          height: 54,
          borderRadius: 14,
          margin: "0 auto 14px",
          display: "grid",
          placeItems: "center",
          background: "var(--surface)",
          border: "1px solid var(--border)",
          color: "var(--accent-ink)",
        }}
      >
        {icon ?? (
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 16V4" />
            <path d="m7 9 5-5 5 5" />
            <path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />
          </svg>
        )}
      </div>
      <h3 style={{ fontSize: 19, fontWeight: 600 }}>{title}</h3>
      <p style={{ fontSize: 14, color: "var(--muted)", marginTop: 6 }}>{hint}</p>
      {kinds && kinds.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "center", marginTop: 16 }}>
          {kinds.map((k) => (
            <span
              key={k.label}
              className="mono"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                fontSize: 11,
                color: "var(--faint)",
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: 6,
                padding: "3px 8px",
              }}
            >
              {k.icon}
              {k.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export default Dropzone;
