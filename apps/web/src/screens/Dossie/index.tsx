/** DOSSIÊ (/app/dossie/:entity) — "me conta tudo que a empresa sabe sobre X", em 10 segundos.
 *
 *  Desenho do PO (decisão do fundador: "empresa vai além de preço"): decisões e compromissos
 *  ACIMA de números. 100% determinístico — nada de resumo por LLM nesta tela (a assinatura
 *  dela é honestidade). Seções, nesta ordem:
 *    0 cabeçalho (tipo, relações-síntese, desde quando)   4 números que valem hoje
 *    1 decisões (com o porquê, superadas atrás)           5 aprendizados e pontos de atenção
 *    2 compromissos e pendências                          6 como mudou com o tempo
 *    3 relações (duas direções; cada entidade é link)     7 falas registradas · 8 de onde veio
 *  Vazios: seções 1–4 SEMPRE renderizam (linha discreta que ensina a alimentar o cérebro);
 *  5–7 só com conteúdo. Entidade sem nada → página honesta com CTAs reais.
 *  Dados: /api/timeline (dimension+status+história) + /api/entity (direções) + /api/graph (tipo). */
import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Button, Card, Chip, Icon, Skeleton } from "../../ui";
import { api, type EntityFact, type FactItem, type GraphData } from "../../lib/api";
import { entityMentioned } from "../../lib/entity-match";
import { useQuery } from "../../lib/useQuery";

const RELACIONAIS = ["cliente_de", "fornecedor_de", "concorrente_de", "parceiro_de", "responsavel_por"] as const;
const REL_LABEL: Record<string, string> = {
  cliente_de: "cliente de",
  fornecedor_de: "fornecedor de",
  concorrente_de: "concorrente de",
  parceiro_de: "parceiro de",
  responsavel_por: "responsável por",
};
const PISO_SUSPEITO = 0.2; // mesmo piso da tela Fatos (consistência, não invenção)
// padrão N+1 contra truncamento silencioso: o /api/timeline corta ordenado por (predicado,
// valid_from) — e o corte descarta as linhas MAIS NOVAS do predicado que cruza o teto. Pedimos
// TL_MAX+1: se vier mais que TL_MAX, sabemos que truncou e AVISAMOS (nada some em silêncio).
const TL_MAX = 1000;
// dimensões exibidas pelo dossiê que podem carregar fato 'registrado' SEM entidade (sem triple) —
// invisível no /api/timeline (que filtra por entity). O complemento client-side abaixo as resgata.
const DIMS_COMPLEMENTO = ["decisions", "action_items", "objections"] as const;

function pretty(slug: string): string {
  return slug.split(/[-_]+/).filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

function vigente(f: FactItem): boolean {
  return (f.valid_to ?? "") === "" && f.status !== "arquivado";
}

export default function Dossie() {
  const { entity = "" } = useParams();
  const navigate = useNavigate();
  const slug = decodeURIComponent(entity).toLowerCase().trim();

  const [comSuspeitos, setComSuspeitos] = useState(false);
  const [falasAbertas, setFalasAbertas] = useState(false);

  const tl = useQuery<FactItem[]>(`dossie:tl:${slug}`, () => api.timeline(slug, { limit: TL_MAX + 1 }), [slug]);
  const ef = useQuery<EntityFact[]>(`dossie:ef:${slug}`, () => api.entity(slug), [slug]);
  const graph = useQuery<GraphData>("dossie:graph", () => api.graph(), []);
  // COMPLEMENTO (achado "Dossiê cego a registrados sem triple"): fato 'registrado' sem entidade
  // nunca volta pelo /api/timeline. Buscamos as dims que o dossiê exibe e resgatamos, client-side,
  // os SEM entidade cujo texto menciona a entidade (mesma heurística word-boundary do motor).
  // Progressivo e fail-soft: erro numa dim não derruba a tela (o dossiê fica como era).
  const reg = useQuery<FactItem[]>(
    `dossie:reg:${slug}`,
    async () => {
      const listas = await Promise.all(
        DIMS_COMPLEMENTO.map((d) =>
          api.facts(d, { limit: 500 }).then(
            (fs) => fs.map((f) => ({ ...f, dimension: f.dimension || d })), // BFF antigo não devolve dimension
            () => [] as FactItem[],
          ),
        ),
      );
      return listas.flat();
    },
    [slug],
  );

  // N+1: veio mais que TL_MAX ⇒ o histórico truncou (avisamos no cabeçalho; nada some em silêncio).
  const tlTruncado = (tl.data?.length ?? 0) > TL_MAX;
  const tlData = useMemo(() => (tl.data ?? []).slice(0, TL_MAX), [tl.data]);

  // base do dossiê = timeline (fatos COM entidade) + registrados SEM entidade que mencionam a
  // entidade no texto (dedupe por fonte+conteúdo — se o motor um dia preservar a entidade no
  // registrado, ele chega pela timeline e o extra é descartado aqui).
  const fatosBase = useMemo(() => {
    const chave = (f: FactItem) => `${f.source_slug}|${f.text ?? ""}|${f.predicate ?? ""}|${f.value ?? ""}`;
    const vistos = new Set(tlData.map(chave));
    const extras = (reg.data ?? []).filter(
      (f) => !f.entity && !!(f.text ?? "").trim() && entityMentioned(slug, f.text ?? "") && !vistos.has(chave(f)),
    );
    return [...tlData, ...extras];
  }, [tlData, reg.data, slug]);

  const fatos = useMemo(() => {
    return comSuspeitos ? fatosBase : fatosBase.filter((f) => (f.confidence ?? 1) >= PISO_SUSPEITO);
  }, [fatosBase, comSuspeitos]);

  const node = graph.data?.nodes.find((n) => n.id === slug);
  const tipo = node?.role === "org" ? "Empresa" : node?.role === "pessoa" ? "Pessoa" : "Tema";

  // ── derivações por seção (client-side, determinístico) ─────────────────────
  const decisoes = fatos.filter((f) => f.dimension === "decisions");
  const compromissos = fatos.filter((f) => f.dimension === "action_items" || f.dimension === "follow_ups_pending");
  const relacoesOut = fatos.filter((f) => vigente(f) && RELACIONAIS.includes((f.predicate ?? "") as never));
  const relacoesIn = (ef.data ?? []).filter(
    (f) => f.direction === "in" && f.valid_to === "" && RELACIONAIS.includes((f.predicate ?? "") as never),
  );
  // "o que vale hoje": TODO claim vigente da entidade que não é relação nem aprendizado —
  // textual ("abriu unidade no centro", "status: em negociação") E numérico (preço, CPL).
  // Sem esta seção, fatos textuais ficavam órfãos (só apareciam em "De onde veio").
  const valeHoje = fatos.filter(
    (f) =>
      vigente(f) &&
      (f.dimension === "facts" || f.dimension === "claims") &&
      !!f.predicate &&
      !RELACIONAIS.includes((f.predicate ?? "") as never) &&
      !(f.predicate ?? "").startsWith("aprendizado"),
  );
  const aprendizados = fatos.filter((f) => (f.predicate ?? "").startsWith("aprendizado"));
  const atencao = fatos.filter((f) => f.dimension === "objections" || f.dimension === "open_questions");
  const falas = fatos.filter((f) => f.dimension === "quotes");
  // séries com história (predicado+tier com mais de um degrau) — "como mudou com o tempo"
  const series = useMemo(() => {
    const porChave = new Map<string, FactItem[]>();
    for (const f of tlData) {
      if (!f.predicate) continue;
      const k = `${f.predicate}${f.tier ? ` · ${f.tier}` : ""}`;
      porChave.set(k, [...(porChave.get(k) ?? []), f]);
    }
    return [...porChave.entries()].filter(([, fs]) => fs.length > 1);
  }, [tlData]);
  const fontes = useMemo(() => [...new Set(fatos.map((f) => f.source_slug).filter(Boolean))], [fatos]);
  const desde = useMemo(() => {
    const datas = tlData.map((f) => f.valid_from ?? "").filter(Boolean).sort();
    return datas[0] ?? "";
  }, [tlData]);

  const carregando = tl.loading || ef.loading;
  const vazio = !carregando && !tl.error && fatos.length === 0 && (ef.data ?? []).length === 0;

  return (
    <div style={{ maxWidth: 860 }}>
      {/* ── 0. cabeçalho ── */}
      <header style={{ marginBottom: 22 }}>
        <div className="mono" style={{ fontSize: 11.5, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--accent-ink)", marginBottom: 8 }}>
          Dossiê · {tipo}
        </div>
        <h1 style={{ fontSize: 32, fontWeight: 700, letterSpacing: "-.025em", margin: 0 }}>{pretty(slug)}</h1>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 10, flexWrap: "wrap" }}>
          {relacoesOut.slice(0, 3).map((r) => (
            <span key={`${r.predicate}-${r.value}`} className="mono" style={{ fontSize: 12, padding: "3px 10px", borderRadius: 99, background: "var(--accent-soft)", color: "var(--accent-ink)" }}>
              {REL_LABEL[r.predicate ?? ""] ?? r.predicate} {pretty(String(r.value ?? ""))}
            </span>
          ))}
          <span className="faint" style={{ fontSize: 12.5 }}>
            {carregando ? "…" : `${fatos.length} fato${fatos.length === 1 ? "" : "s"}${desde ? ` · desde ${desde}` : ""}`}
          </span>
          {!carregando && tlTruncado && (
            <span className="mono" style={{ fontSize: 11.5, color: "var(--st-reg)" }}>
              mostrando os {TL_MAX} primeiros — o histórico completo está na tela Fatos, filtrando por predicado
            </span>
          )}
          <span style={{ flex: 1 }} />
          <Chip active={comSuspeitos} onToggle={() => setComSuspeitos((v) => !v)}>
            Incluir fatos de baixa certeza
          </Chip>
        </div>
      </header>

      {tl.error ? (
        <Card padding="18px 20px">
          <p style={{ margin: 0, fontSize: 14 }}>Não consegui carregar o dossiê agora.</p>
          <div style={{ marginTop: 10 }}>
            <Button size="sm" onClick={() => { tl.refetch(); ef.refetch(); }}>Tentar de novo</Button>
          </div>
        </Card>
      ) : vazio ? (
        <Card padding="28px 26px">
          <div style={{ fontSize: 16, fontWeight: 600 }}>O cérebro ainda não tem fatos organizados sobre {pretty(slug)}.</div>
          <p className="muted" style={{ fontSize: 13.5, lineHeight: 1.55, margin: "8px 0 14px", maxWidth: "56ch" }}>
            Pode haver menções soltas em conversas e documentos — a busca encontra mesmo sem fato tipado.
          </p>
          <div style={{ display: "flex", gap: 10 }}>
            <Button variant="primary" onClick={() => navigate(`/app/buscar?q=${encodeURIComponent(pretty(slug))}`)}>
              Buscar na memória
            </Button>
            <Button onClick={() => navigate("/app/adicionar")}>Adicionar material</Button>
          </div>
        </Card>
      ) : (
        <div style={{ display: "grid", gap: 16 }}>
          {/* ── 1. decisões ── */}
          <Secao titulo="Decisões" hint="com o porquê" loading={carregando}>
            {decisoes.length === 0 ? (
              <Vazia texto={`Nenhuma decisão registrada sobre ${pretty(slug)} ainda. Quando uma call ou nota citar uma, ela aparece aqui.`} />
            ) : (
              <Lista>
                {decisoes.map((f, i) => (
                  <Fato key={i} f={f} riscado={!vigente(f)} />
                ))}
              </Lista>
            )}
          </Secao>

          {/* ── 2. compromissos ── */}
          <Secao titulo="Compromissos e pendências" hint="quem · o quê · pra quando" loading={carregando}>
            {compromissos.length === 0 ? (
              <Vazia texto="Nenhum compromisso em aberto registrado. Promessas feitas em reuniões e conversas aparecem aqui." />
            ) : (
              <Lista>
                {[...compromissos].sort((a, b) => Number(vigente(b)) - Number(vigente(a))).map((f, i) => (
                  <Fato key={i} f={f} riscado={!vigente(f)} />
                ))}
              </Lista>
            )}
          </Secao>

          {/* ── 3. relações ── */}
          <Secao titulo="Relações" hint="cada nome abre outro dossiê" loading={carregando}>
            {relacoesOut.length === 0 && relacoesIn.length === 0 ? (
              <Vazia texto="Nenhuma relação registrada (cliente de, fornecedor de, concorrente de…)." />
            ) : (
              <div style={{ display: "grid", gap: 8 }}>
                {relacoesOut.map((r, i) => (
                  <div key={`o${i}`} style={{ fontSize: 13.5 }}>
                    {pretty(slug)} é <b>{REL_LABEL[r.predicate ?? ""] ?? r.predicate}</b>{" "}
                    <LinkEntidade slug={String(r.value ?? "")} />
                  </div>
                ))}
                {relacoesIn.map((r, i) => (
                  <div key={`i${i}`} style={{ fontSize: 13.5 }}>
                    <LinkEntidade slug={r.entity} /> é <b>{REL_LABEL[r.predicate] ?? r.predicate}</b> {pretty(slug)}
                  </div>
                ))}
              </div>
            )}
          </Secao>

          {/* ── 4. o que vale hoje (claims vigentes: textuais E numéricos) ── */}
          <Secao titulo="O que vale hoje" hint="só vigentes; o histórico fica abaixo" loading={carregando}>
            {valeHoje.length === 0 ? (
              <Vazia texto="Nenhum fato vigente sobre esta entidade ainda." />
            ) : (
              <Lista>
                {valeHoje.map((f, i) => (
                  <div key={i} style={{ display: "flex", alignItems: "baseline", gap: 10, fontSize: 13.5, flexWrap: "wrap" }}>
                    <span className="mono" style={{ fontSize: 12, color: "var(--muted)", minWidth: 140 }}>
                      {f.predicate}{f.tier ? ` · ${f.tier}` : ""}
                    </span>
                    <b>{f.value || f.text}</b>
                    {f.period ? <span className="faint" style={{ fontSize: 12 }}>/{f.period === "monthly" ? "mês" : f.period}</span> : null}
                    {f.valid_from ? <span className="faint" style={{ fontSize: 12 }}>desde {f.valid_from}</span> : null}
                  </div>
                ))}
                {series.length === 0 && <div className="faint" style={{ fontSize: 12.5 }}>Nunca mudou de ideia sobre estes fatos.</div>}
              </Lista>
            )}
          </Secao>

          {/* ── 5. aprendizados e atenção (só com conteúdo) ── */}
          {(aprendizados.length > 0 || atencao.length > 0) && (
            <Secao titulo="Aprendizados e pontos de atenção" loading={carregando}>
              {aprendizados.length > 0 && (
                <>
                  <Sub titulo="O que aprendemos" />
                  <Lista>{aprendizados.map((f, i) => <Fato key={i} f={f} />)}</Lista>
                </>
              )}
              {atencao.length > 0 && (
                <>
                  <Sub titulo="Dúvidas e objeções no ar" />
                  <Lista>{atencao.map((f, i) => <Fato key={i} f={f} />)}</Lista>
                </>
              )}
            </Secao>
          )}

          {/* ── 6. como mudou com o tempo (só com história) ── */}
          {series.length > 0 && (
            <Secao titulo="Como mudou com o tempo" hint="o degrau riscado foi superado" loading={carregando}>
              <div style={{ display: "grid", gap: 14 }}>
                {series.map(([chave, fs]) => (
                  <div key={chave}>
                    <div className="mono" style={{ fontSize: 12, color: "var(--muted)", marginBottom: 6 }}>{chave}</div>
                    <Lista>
                      {[...fs].sort((a, b) => String(a.valid_from).localeCompare(String(b.valid_from))).map((f, i) => (
                        <div key={i} style={{ fontSize: 13.5, textDecoration: vigente(f) ? "none" : "line-through", color: vigente(f) ? "var(--fg)" : "var(--faint)" }}>
                          <span className="mono" style={{ fontSize: 12 }}>{f.valid_from}</span> — {f.value || f.text}
                        </div>
                      ))}
                    </Lista>
                  </div>
                ))}
              </div>
            </Secao>
          )}

          {/* ── 7. falas (só com conteúdo) ── */}
          {falas.length > 0 && (
            <Secao titulo="Falas registradas" hint="literais, sem parafrasear" loading={carregando}>
              <Lista>
                {(falasAbertas ? falas : falas.slice(0, 5)).map((f, i) => (
                  <div key={i} style={{ fontSize: 13.5, fontStyle: "italic", color: "var(--muted)" }}>“{f.text}”</div>
                ))}
              </Lista>
              {falas.length > 5 && !falasAbertas && (
                <button type="button" onClick={() => setFalasAbertas(true)} style={{ marginTop: 8, border: "none", background: "none", color: "var(--accent-ink)", fontSize: 12.5, cursor: "pointer", padding: 0 }}>
                  Ver todas as {falas.length} falas →
                </button>
              )}
            </Secao>
          )}

          {/* ── 8. de onde veio ── */}
          <Secao titulo="De onde veio" hint="nada aqui existe sem origem" loading={carregando}>
            {fontes.length === 0 ? (
              <Vazia texto="Sem fontes ainda." />
            ) : (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {fontes.map((s) => (
                  <a key={s} href={`/api/source?slug=${encodeURIComponent(s)}`} target="_blank" rel="noopener noreferrer" className="mono" style={{ fontSize: 12, padding: "4px 10px", borderRadius: 8, border: "1px solid var(--border)", color: "var(--muted)", textDecoration: "none" }}>
                    <Icon name="arrow" size={11} /> {s}
                  </a>
                ))}
              </div>
            )}
          </Secao>
        </div>
      )}
    </div>
  );
}

// ── blocos visuais (padrão das outras telas) ─────────────────────────────────

function Secao({ titulo, hint, loading, children }: { titulo: string; hint?: string; loading: boolean; children: React.ReactNode }) {
  return (
    <Card
      header={
        <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
          <span style={{ fontWeight: 600 }}>{titulo}</span>
          {hint && <span className="faint" style={{ fontSize: 12 }}>{hint}</span>}
        </div>
      }
    >
      {loading ? (
        <div style={{ display: "grid", gap: 8 }}>
          <Skeleton width="72%" height={9} />
          <Skeleton width="54%" height={9} />
        </div>
      ) : (
        children
      )}
    </Card>
  );
}

function Sub({ titulo }: { titulo: string }) {
  return <div className="mono" style={{ fontSize: 11.5, textTransform: "uppercase", letterSpacing: ".05em", color: "var(--faint)", margin: "10px 0 6px" }}>{titulo}</div>;
}

function Lista({ children }: { children: React.ReactNode }) {
  return <div style={{ display: "grid", gap: 8 }}>{children}</div>;
}

function Vazia({ texto }: { texto: string }) {
  return <p className="muted" style={{ margin: 0, fontSize: 13, lineHeight: 1.5 }}>{texto}</p>;
}

function Fato({ f, riscado }: { f: FactItem; riscado?: boolean }) {
  return (
    <div style={{ fontSize: 13.5, lineHeight: 1.55, textDecoration: riscado ? "line-through" : "none", color: riscado ? "var(--faint)" : "var(--fg)" }}>
      {f.text || `${f.predicate}: ${f.value}`}
      {f.valid_from ? <span className="faint mono" style={{ fontSize: 11.5 }}> · {f.valid_from}</span> : null}
    </div>
  );
}

function LinkEntidade({ slug }: { slug: string }) {
  const s = slug.toLowerCase().trim();
  if (!s) return null;
  return (
    <Link to={`/app/dossie/${encodeURIComponent(s)}`} style={{ color: "var(--accent-ink)", fontWeight: 600, textDecoration: "none" }}>
      {pretty(s)}
    </Link>
  );
}
