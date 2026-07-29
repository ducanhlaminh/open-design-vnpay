// Confluence HTML → Markdown.
//
// This replaces a ~190-line chain of global regex passes over a flat string.
// That chain worked until structures nested: each pass rewrote the WHOLE
// document, so whichever pass ran first won. The bug that forced the rewrite is
// the canonical example — the table pass stripped tags to build its GFM row
// BEFORE the image pass ran, so every mockup embedded in a table cell was
// erased. The PNGs downloaded fine, the Markdown carried zero image refs, and
// the PRD Mockup Review stage dutifully reported "no mockups to review".
//
// Turndown walks the parsed DOM bottom-up instead: a node's children are
// already converted by the time its own rule runs, so "images inside table
// cells" is not a case anyone has to remember to handle. That entire class of
// ordering bug is gone by construction, and entity decoding, whitespace
// collapsing and block spacing come from a parser rather than from regexes.
//
// What stays custom, because it is Confluence-specific and not Markdown at all:
// image localization policy, cross-page link rewriting, and the table renderer
// (GFM has no rowspan/colspan and no newline inside a cell — Confluence specs
// lean on all three).
import TurndownService from 'turndown';

/** Rewrites a link that targets another FETCHED page into a path relative to
 *  the referring page's own folder; anything else is left alone. */
export type ResolveHref = (href: string) => string;

/** The DOM surface these rules touch. Declared structurally because the daemon
 *  compiles without the DOM lib — Turndown supplies the nodes (via domino), we
 *  only read them. */
interface DomNode {
  nodeName: string;
  tagName?: string;
  nodeType: number;
  textContent: string | null;
  innerHTML: string;
  parentNode: DomNode | null;
  children: ArrayLike<DomNode>;
  getAttribute(name: string): string | null;
  querySelectorAll(selector: string): ArrayLike<DomNode>;
}

/** A `<br>` inside a GFM cell must survive the cell's newline flattening; a
 *  literal `<br>` written early would be flattened with everything else. */
const CELL_BREAK = '';

const asEl = (node: unknown): DomNode => node as DomNode;

/** `<img>` → Markdown. The ONE place image policy lives: both the standalone
 *  and the in-table path reach it through the same rule. */
function imgToMd(node: DomNode, localizedImagePrefix?: string): string {
  // The REAL `src`, never `data-image-src`: Confluence's body.view emits both,
  // and localization rewrites only the real one. Reading the data attribute
  // leaves the image pointing at an authenticated URL that renders nowhere.
  const src = node.getAttribute('src') ?? '';
  const alt = node.getAttribute('alt') ?? '';
  // Escape `[` / `]` in the alt: a marker like `[flow-diagram]` closes the
  // `![...]` alt early and breaks the image (it renders as literal text while
  // the PNG sits unused on disk). Escaping keeps the image renderable and the
  // marker readable downstream.
  const safeAlt = alt.replace(/[[\]]/g, (m) => `\\${m}`);
  // An un-downloaded Confluence URL renders nowhere outside a logged-in
  // session, so anything not localized degrades to alt-text-only — the same as
  // before images were downloaded at all.
  if (src && localizedImagePrefix && src.startsWith(localizedImagePrefix)) return `![${safeAlt}](${src})`;
  return alt ? `(${alt})` : '';
}

/** The `<tr>`s belonging to THIS table — not to a nested one, whose rows were
 *  already converted into the parent cell's content. */
function ownRows(table: DomNode): DomNode[] {
  const nearestTable = (node: DomNode): DomNode | null => {
    for (let p = node.parentNode; p; p = p.parentNode) {
      if (p.nodeName === 'TABLE') return p;
    }
    return null;
  };
  return Array.from(table.querySelectorAll('tr')).filter((tr) => nearestTable(tr) === table);
}

/** Does this row read as a header even though it is made of `<td>`?
 *
 *  Measured on a real URD page: of 47 tables only 9 used `<th>`; 37 of the
 *  remaining 38 opened with a row of hand-bolded `<td>`s — an authored header —
 *  and the last one was the mockup grid, whose first row is screenshots.
 *  Promoting blindly deletes that row of mockups from the body; never promoting
 *  leaves 37 tables with an empty header. So: promote a row whose every cell is
 *  bold-only text, and no row that carries an image. */
function looksLikeHeaderRow(cells: DomNode[]): boolean {
  if (!cells.length) return false;
  let anyText = false;
  for (const cell of cells) {
    if (cell.querySelectorAll('img').length > 0) return false;
    const text = (cell.textContent ?? '').trim();
    if (!text) continue; // an empty corner cell is fine in a header
    anyText = true;
    const bold = Array.from(cell.querySelectorAll('strong, b'))
      .map((b) => (b.textContent ?? '').trim())
      .join('');
    // Every visible character of the cell must be inside a bold run.
    if (bold.replace(/\s+/g, '') !== text.replace(/\s+/g, '')) return false;
  }
  return anyText;
}

/** One `<table>` → a GFM table.
 *
 *  GFM is strictly rectangular, so spans are flattened onto an occupancy grid:
 *  a spanned cell keeps its content in the first slot it covers and leaves the
 *  rest empty. Alignment is what matters — a table whose columns shift reads
 *  worse, to a human and to an agent, than one with a few empty cells.
 *
 *  GFM requires a header row. A table that has neither `<th>` nor an authored
 *  bold header (see looksLikeHeaderRow) gets an EMPTY one rather than promoting
 *  its first data row: Confluence lays mockups out in bare `<td>` grids, and
 *  promoting row 1 silently deletes a row of screenshots from the body. */
function tableToMd(table: DomNode, cellToMd: (cell: DomNode) => string): string {
  const rows = ownRows(table);
  if (!rows.length) return '\n\n';

  const grid: string[][] = [];
  const headerFlags: boolean[] = [];
  // occupied[r][c] — slot already claimed by a span from an earlier cell/row.
  const occupied: boolean[][] = [];
  const claim = (r: number, c: number) => {
    (occupied[r] ??= [])[c] = true;
  };

  rows.forEach((tr, r) => {
    grid[r] ??= [];
    const cells = Array.from(tr.children).filter((c) => c.nodeName === 'TD' || c.nodeName === 'TH');
    headerFlags[r] =
      (cells.length > 0 && cells.every((c) => c.nodeName === 'TH')) ||
      (r === 0 && looksLikeHeaderRow(cells));
    let col = 0;
    for (const cell of cells) {
      while (occupied[r]?.[col]) col += 1;
      const colspan = Math.max(1, Number(cell.getAttribute('colspan') ?? '1') || 1);
      const rowspan = Math.max(1, Number(cell.getAttribute('rowspan') ?? '1') || 1);
      const text = cellToMd(cell);
      for (let dr = 0; dr < rowspan; dr += 1) {
        for (let dc = 0; dc < colspan; dc += 1) {
          claim(r + dr, col + dc);
          const target = (grid[r + dr] ??= []);
          target[col + dc] = dr === 0 && dc === 0 ? text : '';
        }
      }
      col += colspan;
    }
  });

  const width = Math.max(...grid.map((r) => r.length));
  const cellsOf = (r: string[]) =>
    Array.from({ length: width }, (_unused, i) => r[i] ?? '');
  const line = (r: string[]) => `| ${cellsOf(r).join(' | ')} |`;
  const sep = `| ${Array<string>(width).fill('---').join(' | ')} |`;
  const hasHeader = headerFlags[0] === true;
  const head = hasHeader ? line(grid[0]!) : line([]);
  const body = (hasHeader ? grid.slice(1) : grid).map(line);
  return `\n\n${head}\n${sep}\n${body.join('\n')}\n\n`;
}

/** Build the converter. One service per conversion keeps the rule closures
 *  (which capture the caller's link/image policy) from leaking between pages. */
function createService(resolveHref?: ResolveHref, localizedImagePrefix?: string): TurndownService {
  const service = new TurndownService({
    headingStyle: 'atx',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '*',
    strongDelimiter: '**',
    hr: '---',
    // Turndown appends the newline itself, so this is a plain line break rather
    // than Markdown's two-space hard break — the previous converter's behavior,
    // and the readable one in a requirements doc.
    br: '',
    linkStyle: 'inlined',
    // Blank inline elements (Confluence sprays `<strong> </strong>` mid-sentence)
    // need no special handling: Turndown hoists an element's surrounding
    // whitespace out before rules run, so the words stay separated and the
    // stray emphasis markers never reach the output.
  });
  // Turndown's default escaping backslash-escapes everything that COULD start
  // Markdown syntax ("5 \* 3", "a\_b\_c"). These docs are read by agents and by
  // the studio viewer, and that noise costs more than the rare ambiguity it
  // prevents — the previous converter escaped nothing at all and shipped for
  // months. Text stays verbatim; the two constructs that genuinely break
  // (alt brackets, cell pipes) are escaped explicitly at their own rule.
  service.escape = (str: string) => str;
  service.remove(['script', 'style']);

  // Turndown's stock list item is `-   item` with 4-space continuation indent.
  // Valid, but a requirements doc is mostly nested bullets, and at depth 3 the
  // padding dominates the line. Tighten to `- item` / 2-space indent.
  service.addRule('od-list-item', {
    filter: 'li',
    replacement: (content, node) => {
      const body = content.replace(/^\n+/, '').replace(/\n+$/, '\n').replace(/\n/gm, '\n  ');
      // An item that converted to nothing (an empty TOC entry, a spacer <li>)
      // would otherwise leave a bare "-" line in the doc.
      if (!body.trim()) return '';
      const parent = asEl(node).parentNode;
      let prefix = '- ';
      if (parent && parent.nodeName === 'OL') {
        const start = Number(parent.getAttribute('start') ?? '1') || 1;
        const index = Array.from(parent.children).filter((c) => c.nodeName === 'LI').indexOf(asEl(node));
        prefix = `${start + Math.max(0, index)}. `;
      }
      const trailing = (node as unknown as { nextSibling?: unknown }).nextSibling && !/\n$/.test(body) ? '\n' : '';
      return prefix + body + trailing;
    },
  });

  service.addRule('od-image', {
    filter: 'img',
    replacement: (_content, node) => imgToMd(asEl(node), localizedImagePrefix),
  });

  service.addRule('od-link', {
    filter: (node) => node.nodeName === 'A' && !!asEl(node).getAttribute('href'),
    replacement: (content, node) => {
      const href = asEl(node).getAttribute('href') ?? '';
      const label = content.trim();
      // Pure in-page anchors (`#id-…`) point at Confluence's generated heading
      // ids, which mean nothing once the page is a .md file — and the TOC macro
      // is a wall of them. Keep the text, drop the dead link.
      if (href.startsWith('#')) return label;
      const target = resolveHref ? resolveHref(href) : href;
      return `[${label || target}](${target})`;
    },
  });

  // Confluence writes code blocks as a bare `<pre>` (its code macro adds
  // classes, not a `<code>` child), which Turndown's fenced-code rule does not
  // match. Read the raw text so angle brackets inside the snippet survive
  // instead of being mistaken for markup.
  service.addRule('od-pre', {
    filter: (node) => node.nodeName === 'PRE',
    replacement: (_content, node) =>
      `\n\n\`\`\`\n${(asEl(node).textContent ?? '').replace(/\n+$/, '')}\n\`\`\`\n\n`,
  });

  service.addRule('od-table', {
    filter: (node) => node.nodeName === 'TABLE',
    replacement: (_content, node) =>
      tableToMd(asEl(node), (cell) => {
        // A GFM cell cannot contain a newline, so the cell's own block
        // boundaries become `<br>`. Collapsing them to spaces instead runs
        // separate items together, and a flow-step cell then reads as one
        // sentence spanning two opposite branches — the kind of silent
        // corruption a downstream agent inherits without noticing.
        return service
          .turndown(cell.innerHTML)
          .split(/\n+/)
          // A heading marker means nothing inside a cell — Confluence titles
          // each mockup with an <h4> in its own cell, and `#### ` there is
          // noise, not structure. A list marker becomes a bullet glyph: the
          // cell is one line, so `- ` no longer reads as a list, but `•` still
          // does.
          .map((part) => part.trim().replace(/^#{1,6}\s+/, '').replace(/^-\s+/, '• '))
          .filter(Boolean)
          .join(CELL_BREAK)
          .replace(/\|/g, '\\|');
      }),
  });

  return service;
}

/**
 * Convert one Confluence page body to Markdown.
 *
 * @param resolveHref cross-page link rewrite (see {@link ResolveHref}).
 * @param localizedImagePrefix folder-relative prefix a src must carry to count
 *   as downloaded — i.e. localizeConfluenceImages already ran.
 */
export function htmlToMarkdown(
  html: string,
  resolveHref?: ResolveHref,
  localizedImagePrefix?: string,
): string {
  const md = createService(resolveHref, localizedImagePrefix).turndown(html ?? '');
  return md
    .split(CELL_BREAK)
    .join('<br>')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
