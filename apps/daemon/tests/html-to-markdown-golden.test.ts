// GOLDEN harness for the Confluence HTML → Markdown converter.
//
// Why a golden suite and not more example-based asserts: the converter is the
// single funnel every ingested doc passes through, and its failures are SILENT
// — a dropped image, a flattened outline or a table run together produces a
// perfectly valid .md that simply lost information, and the damage only shows
// up several stages downstream (the PRD Mockup Review reviewing zero mockups
// because every screenshot lived in a table cell). Example asserts pin the
// handful of shapes someone thought to write down; a golden file pins the
// WHOLE output, so any change to any structure shows up as a reviewable diff.
//
// This is what makes swapping the conversion engine a measurable change rather
// than a leap of faith: run the suite before, swap, run again, read the diff.
//
// Fixtures: tests/fixtures/confluence-html/*.html — each one models a real
// wiki.servicehub.vn structure class (see the comment at the top of each).
// Goldens: tests/fixtures/confluence-html/__golden__/*.md
//
// Updating a golden is a DELIBERATE act: run `npx vitest run
// html-to-markdown-golden -u` and read every line of the diff before
// committing. An unexplained golden change means the converter lost something.
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from 'vitest';

import { htmlToMarkdown } from '../src/bas/bas-client.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(HERE, 'fixtures', 'confluence-html');

// The two caller-supplied hooks, fixed here so goldens are deterministic:
// `attachments` is the prefix fetchConfluencePages passes for a page sitting
// directly under docs/confluence/, and resolveHref is its cross-page link
// rewrite (a link to a FETCHED page becomes a local .md path).
const LOCALIZED_PREFIX = 'attachments';
const resolveHref = (href: string): string =>
  /\/pages\/991334362/.test(href) ? './BO-spec.md' : href;

const fixtures = (await readdir(FIXTURE_DIR)).filter((f) => f.endsWith('.html')).sort();

// A guard on the guard: an empty (or accidentally emptied) fixture directory
// would make every golden test vacuously pass.
test('golden fixture set is present', () => {
  expect(fixtures.length).toBeGreaterThanOrEqual(6);
});

for (const file of fixtures) {
  test(`golden: ${file}`, async () => {
    const html = await readFile(join(FIXTURE_DIR, file), 'utf8');
    const md = htmlToMarkdown(html, resolveHref, LOCALIZED_PREFIX);
    await expect(md).toMatchFileSnapshot(join(FIXTURE_DIR, '__golden__', file.replace(/\.html$/, '.md')));
  });
}

// OPT-IN pass over REAL pages, which never live in this repo (they are customer
// documents). Point OD_CONFLUENCE_GOLDEN_DIR at a folder of raw `.html` bodies
// — e.g. saved with `?expand=body.export_view` — and this converts each one and
// writes `<name>.actual.md` beside it for eyeballing, while asserting the loss
// that matters: an `<img>` in, an image ref out. That is the check no synthetic
// fixture can make, because only real pages carry the full macro zoo.
const realDir = process.env.OD_CONFLUENCE_GOLDEN_DIR;
test.skipIf(!realDir)('real pages: every embedded image survives conversion', async () => {
  const files = (await readdir(realDir!)).filter((f) => f.endsWith('.html'));
  expect(files.length).toBeGreaterThan(0);
  for (const f of files) {
    const raw = await readFile(join(realDir!, f), 'utf8');
    // Stand in for localizeConfluenceImages: point every src at attachments/.
    let n = 0;
    const html = raw.replace(
      /(<img\b[^>]*?(?<![-\w])src=["'])([^"']+)(["'])/gi,
      (_m, a: string, _s: string, b: string) => `${a}attachments/img-${n++}.png${b}`,
    );
    const md = htmlToMarkdown(html, resolveHref, LOCALIZED_PREFIX);
    await (await import('node:fs/promises')).writeFile(join(realDir!, `${f}.actual.md`), md, 'utf8');
    const refs = (md.match(/!\[[^\]]*\]\(attachments\//g) ?? []).length;
    expect(refs, `${f}: ${n} <img> in, ${refs} image ref(s) out`).toBe(n);
  }
});

// Structural invariants that must hold no matter which engine renders them.
// The goldens above catch ANY change; these name the changes that are bugs, so
// a careless `-u` cannot quietly bless them.
test('golden invariants: nothing structural is lost', async () => {
  const read = (f: string) => readFile(join(FIXTURE_DIR, f), 'utf8');

  // Every mockup in a table cell survives as a real Markdown image (the prod
  // bug: PNGs downloaded, zero refs emitted, review stage found no pages).
  const mockups = htmlToMarkdown(await read('mockup-table.html'), resolveHref, LOCALIZED_PREFIX);
  expect(mockups.match(/!\[[^\]]*\]\(attachments\/[^)]+\)/g) ?? []).toHaveLength(3);
  // …and the row stays ONE line: an image must not break the GFM row.
  for (const line of mockups.split('\n')) {
    if (line.includes('![')) expect(line.startsWith('|') && line.endsWith('|')).toBe(true);
  }

  // Outline depth survives (a flat converter collapses the TOC to one line).
  const toc = htmlToMarkdown(await read('nested-list-toc.html'), resolveHref, LOCALIZED_PREFIX);
  expect(toc).toMatch(/\n {2,}- .*SCR-001/);

  // Highlight spans vanish WITHOUT splitting the word they sit inside.
  const inline = htmlToMarkdown(await read('inline-formatting.html'), resolveHref, LOCALIZED_PREFIX);
  expect(inline).toContain('toàn bộ hồ sơ NCC');
  expect(inline).toContain('Phiên bản tài liệu ế ế & mô tả'); // entities decoded
  expect(inline).not.toMatch(/\*\* \*\*/); // blank emphasis never leaks markers

  // In-cell block boundaries stay separate branches, not one run-on sentence.
  const table = htmlToMarkdown(await read('table-complex.html'), resolveHref, LOCALIZED_PREFIX);
  expect(table).toContain('Hoàn tất xác thực trên webview<br>ĐÓNG webview giữa chừng');
  expect(table).toContain('\\|'); // a literal pipe in cell text is escaped
  expect(table).toMatch(/\|\s*---\s*\|/); // real GFM separator row

  // Only localized images become images; the rest degrade to alt text.
  const images = htmlToMarkdown(await read('images.html'), resolveHref, LOCALIZED_PREFIX);
  expect(images).toContain('![màn hình chính](attachments/shot.png)');
  expect(images).toContain('![ảnh nhúng](attachments/embed.png)'); // real src, not data-image-src
  expect(images).toContain('(ảnh ngoài)'); // unlocalized → alt only
  expect(images).not.toContain('remote.png');
  expect(images).toContain('\\[flow-diagram\\]'); // brackets escaped, image stays renderable

  // Cross-page links rewritten, external links untouched, script/style gone.
  const page = htmlToMarkdown(await read('page-structure.html'), resolveHref, LOCALIZED_PREFIX);
  expect(page).toContain('[BO spec](./BO-spec.md)');
  expect(page).toContain('https://jira.example.com/browse/PRJ-1');
  expect(page).not.toContain('phải bị loại bỏ');
  expect(page).not.toContain('color: red');
});
