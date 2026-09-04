/** EVAL S2 — enriquece title/people das páginas a partir do frontmatter YAML + seção "Participantes"
 *  do corpo. UPDATE in-place (não muda slug → golden set continua válido). Determinístico, sem LLM. */
import { getEngine, closeEngines } from "../src/core/platform/engine.ts";

const HOME = "eval-a360";

function frontmatter(body: string): string {
  const m = body.match(/^---\n([\s\S]*?)\n---/);
  return m ? m[1] : "";
}
function realTitle(fm: string): string | null {
  const m = fm.match(/^title:\s*["']?(.+?)["']?\s*$/m);
  const t = m?.[1]?.trim();
  return t && !/^title$/i.test(t) ? t : null;
}
function people(fm: string, body: string): string[] {
  // 1) array YAML: participants:/people: [ "...", "..." ]
  const arr = fm.match(/^(?:participants|people):\s*\[([\s\S]*?)\]/m);
  if (arr && arr[1].trim()) {
    const names = arr[1].split(/","|','/).map((s) => s.replace(/^[\s"']+|[\s"']+$/g, "")).filter(Boolean);
    if (names.length) return [...new Set(names)].slice(0, 60);
  }
  // 2) seção "Participantes" no corpo (notetaker): pega a 1ª linha não-vazia após o cabeçalho
  const sec = body.match(/Participantes\**\s*\n+\s*\**([^\n*]+)/i);
  if (sec && sec[1]) {
    const names = sec[1].split(/,|;| e /).map((s) => s.replace(/[*_]/g, "").trim()).filter((s) => s.length > 1 && s.length < 60);
    if (names.length) return [...new Set(names)].slice(0, 20);
  }
  return [];
}

const e: any = await getEngine(HOME);
const pages = await e.allPages();
let tit = 0, ppl = 0;
for (const p of pages) {
  const fm = frontmatter(p.body || "");
  const t = realTitle(fm);
  const pp = people(fm, p.body || "");
  const newTitle = t || p.title;
  const newPeople = pp.length ? pp : p.people || [];
  if (t && t !== p.title) tit++;
  if (pp.length) ppl++;
  await e.sql`update galeed_pages set title = ${newTitle}, people = ${e.sql.json(newPeople)} where brain = ${HOME} and slug = ${p.slug}`;
}
console.log(JSON.stringify({ pages: pages.length, titlesFixed: tit, peoplePopulated: ppl }));
await closeEngines();
process.exit(0);
