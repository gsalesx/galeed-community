/** Markdown — renderiza markdown (ex.: a resposta da síntese do /perguntar) como elementos React
 *  ESTILIZADOS no design system. Usa react-markdown (vetado, seguro: NÃO renderiza HTML cru → sem XSS
 *  no output da LLM). Sem `dangerouslySetInnerHTML`. Tipografia compacta pra caber numa resposta. */
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { CSSProperties } from "react";

const fg: CSSProperties = { color: "var(--fg)" };
const muted: CSSProperties = { color: "var(--muted)" };

export function Markdown({ children }: { children: string }) {
  return (
    <div className="md" style={{ fontSize: 15, lineHeight: 1.6, ...fg }}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => (
            <h1 style={{ fontSize: 19, fontWeight: 650, letterSpacing: "-.01em", margin: "2px 0 8px", ...fg }}>{children}</h1>
          ),
          h2: ({ children }) => (
            <h2 style={{ fontSize: 16, fontWeight: 650, margin: "16px 0 6px", ...fg }}>{children}</h2>
          ),
          h3: ({ children }) => (
            <h3 style={{ fontSize: 14.5, fontWeight: 650, margin: "14px 0 4px", ...fg }}>{children}</h3>
          ),
          p: ({ children }) => <p style={{ margin: "0 0 10px" }}>{children}</p>,
          ul: ({ children }) => <ul style={{ margin: "0 0 10px", paddingLeft: 20 }}>{children}</ul>,
          ol: ({ children }) => <ol style={{ margin: "0 0 10px", paddingLeft: 20 }}>{children}</ol>,
          li: ({ children }) => <li style={{ margin: "3px 0" }}>{children}</li>,
          strong: ({ children }) => <strong style={{ fontWeight: 650 }}>{children}</strong>,
          em: ({ children }) => <em>{children}</em>,
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noreferrer" style={{ color: "var(--accent)", textDecoration: "underline", textUnderlineOffset: 2 }}>
              {children}
            </a>
          ),
          blockquote: ({ children }) => (
            <blockquote style={{ margin: "0 0 10px", paddingLeft: 12, borderLeft: "3px solid var(--line)", ...muted }}>
              {children}
            </blockquote>
          ),
          code: ({ children }) => (
            <code className="mono" style={{ fontSize: 13, background: "var(--surface-2, rgba(0,0,0,.05))", padding: "1px 5px", borderRadius: 4 }}>
              {children}
            </code>
          ),
          hr: () => <hr style={{ border: "none", borderTop: "1px solid var(--line)", margin: "14px 0" }} />,
          table: ({ children }) => (
            <div style={{ overflowX: "auto", margin: "0 0 10px" }}>
              <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13.5 }}>{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th style={{ textAlign: "left", padding: "6px 10px", borderBottom: "2px solid var(--line)", fontWeight: 650 }}>{children}</th>
          ),
          td: ({ children }) => <td style={{ padding: "6px 10px", borderBottom: "1px solid var(--line)" }}>{children}</td>,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

export default Markdown;
