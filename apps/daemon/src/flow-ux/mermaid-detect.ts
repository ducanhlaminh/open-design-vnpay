// Find Mermaid flow diagrams inside ingested Markdown.
//
// Confluence's Mermaid macro is exported by third-party tools as the raw
// viewer call — one huge line `createViewer('<id>', '<title>', 'fit', 'bottom',
// \`&lt;svg …&gt;\`)` — while the diagram SOURCE lands as a page attachment
// named exactly like the title (no extension). Our own ingest drops <script>
// wholesale, so on that path the diagram vanishes. Either way the flow stage
// wants (a) the Mermaid text when it can be found and (b) the rendered SVG so
// the viewer can show the diagram exactly as the document did.

export interface EmbeddedMermaid {
  /** Diagram title as the document names it. */
  title: string;
  /** Mermaid source text, when found (fenced block or attachment). */
  code?: string;
  /** Rendered SVG markup, when the export carried it. */
  svg?: string;
  /** Path (relative to the page) of an SVG image the document shows right
   *  above the fenced block — our Confluence ingest writes the macro's
   *  rendered SVG that way. The caller reads it. */
  svgRef?: string;
  /** Where in the markdown it sits (line index of the first match), for the
   *  caller to link the flow to its source page. */
  line: number;
}

const MERMAID_HEAD = /^\s*(flowchart|graph|sequenceDiagram|stateDiagram(-v2)?|journey|classDiagram|erDiagram|gantt)\b/i;

function unescapeHtml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** True when `text` looks like Mermaid source. */
export function looksLikeMermaid(text: string): boolean {
  const first = text
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .map((l) => l.replace(/%%.*$/, '').trim())
    .find(Boolean);
  return !!first && MERMAID_HEAD.test(first);
}

/** True for a Mermaid FLOWCHART specifically (the only kind we turn into a
 *  flowchart.json). */
export function isMermaidFlowchart(text: string): boolean {
  const first = text
    .split(/\r?\n/)
    .map((l) => l.replace(/%%.*$/, '').trim())
    .find(Boolean);
  return !!first && /^(flowchart|graph)\b/i.test(first);
}

/** Parse the JS-string arguments of a `createViewer(...)` call starting at
 *  `start` (index of the `(`). Handles '…', "…" and `…` literals with `\`
 *  escapes. Returns the string args in order and the end index. */
function parseCallArgs(src: string, start: number): { args: string[]; end: number } | null {
  let i = start + 1;
  const args: string[] = [];
  const n = src.length;
  while (i < n) {
    while (i < n && /[\s,]/.test(src[i]!)) i += 1;
    if (i >= n) return null;
    let q = src[i]!;
    // Markdown exporters escape the template-literal backtick as `\`` — the
    // backslash then belongs to the DELIMITER, so the closing delimiter is
    // `\`` too (an unescaped backslash-quote inside SVG markup does not occur).
    let escapedDelim = false;
    if (q === '\\' && i + 1 < n && /['"`]/.test(src[i + 1]!)) {
      escapedDelim = true;
      i += 1;
      q = src[i]!;
    }
    if (q === ')') return { args, end: i + 1 };
    if (q !== "'" && q !== '"' && q !== '`') {
      // Non-string arg (number/identifier) — skip to next comma/paren.
      let j = i;
      while (j < n && src[j] !== ',' && src[j] !== ')') j += 1;
      args.push(src.slice(i, j).trim());
      i = j;
      continue;
    }
    let j = i + 1;
    let out = '';
    for (;;) {
      if (j >= n) return null;
      const ch = src[j]!;
      if (escapedDelim) {
        if (ch === '\\' && src[j + 1] === q) break; // closing `\q`
        out += ch;
        j += 1;
        continue;
      }
      if (ch === q) break;
      if (ch === '\\' && j + 1 < n) {
        out += src[j + 1];
        j += 2;
        continue;
      }
      out += ch;
      j += 1;
    }
    args.push(out);
    i = j + (escapedDelim ? 2 : 1);
  }
  return null;
}

/** Scan markdown text for embedded Mermaid diagrams. `attachments` lets the
 *  caller supply the page's attachment files (name → text) so a diagram whose
 *  source was exported as an extension-less attachment named after the title
 *  gets its Mermaid code. */
export function findEmbeddedMermaid(markdown: string, attachments?: Map<string, string>): EmbeddedMermaid[] {
  const out: EmbeddedMermaid[] = [];
  const lines = markdown.split('\n');
  const lineOfIndex = (idx: number) => markdown.slice(0, idx).split('\n').length - 1;

  // (a) createViewer(...) calls — the exported Confluence Mermaid macro.
  let cursor = 0;
  for (;;) {
    const at = markdown.indexOf('createViewer(', cursor);
    if (at === -1) break;
    const parsed = parseCallArgs(markdown, at + 'createViewer'.length);
    if (!parsed) {
      cursor = at + 1;
      continue;
    }
    cursor = parsed.end;
    const title = (parsed.args[1] ?? '').trim() || `Sơ đồ ${out.length + 1}`;
    const svgArg = parsed.args.find((a) => /^\s*(&lt;|<)svg\b/i.test(a));
    const svg = svgArg ? unescapeHtml(svgArg).trim() : undefined;
    const item: EmbeddedMermaid = { title, line: lineOfIndex(at) };
    if (svg && /^<svg\b/i.test(svg)) item.svg = svg;
    const code = attachments?.get(title) ?? attachments?.get(`${title}.mmd`);
    if (code && looksLikeMermaid(code)) item.code = code.trim();
    out.push(item);
  }

  // (b) fenced ```mermaid blocks.
  let inFence = false;
  let fenceStart = -1;
  let buf: string[] = [];
  lines.forEach((l, i) => {
    const open = /^\s*```\s*mermaid\b/i.test(l);
    if (!inFence && open) {
      inFence = true;
      fenceStart = i;
      buf = [];
      return;
    }
    if (inFence && /^\s*```\s*$/.test(l)) {
      inFence = false;
      const code = buf.join('\n').trim();
      if (code && looksLikeMermaid(code)) {
        // A heading right above the fence names the diagram; an SVG image
        // between the heading and the fence is its rendered picture.
        let title = '';
        let svgRef = '';
        for (let k = fenceStart - 1; k >= 0 && k >= fenceStart - 6; k -= 1) {
          const line = lines[k] ?? '';
          const img = /!\[[^\]]*\]\(([^)\s]+\.svg)\)/i.exec(line);
          if (img && !svgRef) svgRef = img[1]!;
          const h = /^\s*#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
          if (h) {
            title = h[1]!.trim();
            break;
          }
        }
        const item: EmbeddedMermaid = { title: title || `Sơ đồ ${out.length + 1}`, code, line: fenceStart };
        if (svgRef) item.svgRef = svgRef;
        out.push(item);
      }
      return;
    }
    if (inFence) buf.push(l);
  });

  return out;
}

/** Rewrite the raw `createViewer(...)` lines of a markdown page into image
 *  references, given the file names the caller saved the SVG/Mermaid under
 *  (`(item) => { svgRel?, codeRel? }`). Returns the new markdown; untouched
 *  when nothing matched. */
export function replaceCreateViewerCalls(
  markdown: string,
  resolve: (item: EmbeddedMermaid, index: number) => { svgRel?: string; codeRel?: string } | null,
): string {
  let out = '';
  let cursor = 0;
  let idx = 0;
  const lineOfIndex = (i: number) => markdown.slice(0, i).split('\n').length - 1;
  for (;;) {
    const at = markdown.indexOf('createViewer(', cursor);
    if (at === -1) break;
    const parsed = parseCallArgs(markdown, at + 'createViewer'.length);
    if (!parsed) {
      cursor = at + 1;
      continue;
    }
    const title = (parsed.args[1] ?? '').trim() || `Sơ đồ ${idx + 1}`;
    const item: EmbeddedMermaid = { title, line: lineOfIndex(at) };
    const target = resolve(item, idx);
    idx += 1;
    // Drop a trailing `;` and the statement's own line so the page reads clean.
    let end = parsed.end;
    if (markdown[end] === ';') end += 1;
    if (!target) {
      cursor = end;
      continue;
    }
    const parts: string[] = [];
    if (target.svgRel) parts.push(`![flow-diagram ${title}](${target.svgRel})`);
    if (target.codeRel) parts.push(`*flow-diagram — nguồn sơ đồ Mermaid (đọc file này để lấy luồng): [${target.codeRel}](${target.codeRel})*`);
    out += markdown.slice(cursor, at) + parts.join('\n\n');
    cursor = end;
  }
  if (cursor === 0) return markdown;
  return out + markdown.slice(cursor);
}
