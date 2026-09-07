// `_sections.md` — mục lục MỨC SECTION cơ học (0 LLM) cho một thư mục docs
// (`docs-app/` hoặc `docs-feature/`), sinh ra để agent grep KHÔNG DẤU tìm
// đúng `path:line` thay vì grep mù nội dung có dấu (trượt đồng nghĩa/không
// dấu) hoặc đoán từ tên trang. Xem wp-docs-review-section-index.md.
//
// Mỗi heading (`#`..`####`) trong mỗi file `.md` sinh MỘT dòng:
//   `<path>:<line> | <breadcrumb H1 › H2 › …> | <chuỗi tìm kiếm không dấu>`
// File không có heading nào → một dòng duy nhất (heading = dòng đầu hoặc tên
// file). Cột 1-2 giữ nguyên gốc (có dấu); CHỈ cột 3 bị strip dấu tiếng Việt
// (NFD bỏ combining mark + đ/Đ→d) để `grep -i` không trượt dấu.
//
// `writeDocsSectionIndex` tự "refresh rẻ": so mtime *.md mới nhất trong root
// với mtime `_sections.md` hiện có — lệch mới đọc lại nội dung + build lại;
// không lệch thì chỉ đếm nhanh từ file cũ (không re-parse nội dung).

import fs from 'node:fs';
import path from 'node:path';

export interface DocsSectionSourceFile {
  /** Đường dẫn tương đối (posix, dùng `/`) từ root dir đang quét. */
  rel: string;
  content: string;
}

const HEADING_RE = /^ {0,3}(#{1,4})\s+(.+?)\s*$/;

/** ~50 hư từ tiếng Việt phổ biến — loại khỏi từ khóa cột 3 (cùng từ ≤2 ký tự). */
const STOPWORDS = new Set(
  [
    'và', 'là', 'của', 'có', 'được', 'cho', 'trong', 'các', 'một', 'những',
    'này', 'đó', 'khi', 'để', 'với', 'không', 'hoặc', 'như', 'đã', 'sẽ',
    'bị', 'bởi', 'tại', 'về', 'theo', 'nếu', 'mà', 'thì', 'nên', 'vì',
    'do', 'nhưng', 'cũng', 'rất', 'còn', 'nào', 'ai', 'gì', 'sao', 'làm',
    'phải', 'cần', 'từ', 'ra', 'vào', 'lên', 'xuống', 'trên', 'dưới',
    'sau', 'trước', 'giữa', 'mỗi', 'tất', 'cả', 'chỉ', 'đây', 'kia',
    'đang', 'thêm', 'lại', 'cùng', 'hơn', 'nhất', 'nữa', 'ngay',
  ].map(stripDiacritics),
);

/** NFD bỏ combining mark + đ/Đ→d, lowercase. Chuẩn hoá dùng chung cho stopword
 *  và cột 3 (cả hai phải cùng bảng chữ để so khớp). */
export function stripDiacritics(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase();
}

function escapePipe(text: string): string {
  return text.replace(/\|/g, '/');
}

/** Bỏ nhấn mạnh markdown (`**`, `__`, `*`, `` ` ``) khỏi tiêu đề — trang
 *  Confluence hay xuất heading dạng `## **1. Tóm tắt**`. */
function cleanTitle(text: string): string {
  return text.replace(/[*_`]+/g, '').replace(/\s{2,}/g, ' ').trim();
}

/** Trang Confluence luôn mở đầu bằng YAML frontmatter (`title:`, `page_id`,
 *  `url`…). Nó KHÔNG phải nội dung: nếu tính vào title/từ khóa thì trang không
 *  heading nào cũng ra dòng `--- | --- page 90898 title url https wiki` vô
 *  dụng. Tách ra: title lấy từ `title:`, phần còn lại mới là body. */
function splitFrontmatter(content: string): { title: string | null; bodyOffset: number } {
  const lines = content.split(/\r\n|\r|\n/);
  if (lines[0]?.trim() !== '---') return { title: null, bodyOffset: 0 };
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (end < 0) return { title: null, bodyOffset: 0 };
  const titleLine = lines.slice(1, end).find((l) => /^title:\s*/i.test(l));
  const title = titleLine ? titleLine.replace(/^title:\s*/i, '').trim() : null;
  return { title: title && title.length > 0 ? title : null, bodyOffset: end + 1 };
}

function titleFromFirstLine(content: string, fallbackName: string): string {
  const { title, bodyOffset } = splitFrontmatter(content);
  if (title) return cleanTitle(title);
  const firstLine = content
    .split(/\r\n|\r|\n/)
    .slice(bodyOffset)
    .find((l) => l.trim().length > 0 && l.trim() !== '---');
  const trimmed = cleanTitle(firstLine?.replace(/^#+\s*/, '') ?? '');
  return trimmed.length > 0 ? trimmed : fallbackName;
}

interface HeadingHit {
  level: number;
  title: string;
  /** 1-based line index of the heading itself. */
  line: number;
}

/** Trích mọi heading `#`..`####` (kèm số dòng 1-based) theo thứ tự xuất hiện. */
function collectHeadings(lines: string[]): HeadingHit[] {
  const out: HeadingHit[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = HEADING_RE.exec(lines[i]!);
    if (!m) continue;
    const title = cleanTitle(m[2]!);
    if (title.length === 0) continue;
    out.push({ level: m[1]!.length, title, line: i + 1 });
  }
  return out;
}

/** top ~8 từ khóa (không dấu, đã lọc stopword + từ ≤2 ký tự) của một đoạn
 *  nội dung, xếp theo tần suất giảm dần rồi theo thứ tự xuất hiện đầu tiên
 *  (tie-break ổn định — cần cho tính deterministic). */
function topKeywords(bodyText: string, max = 8): string[] {
  const freq = new Map<string, number>();
  const firstSeen = new Map<string, number>();
  const tokens = bodyText.match(/[\p{L}\p{N}]+/gu) ?? [];
  tokens.forEach((raw, idx) => {
    const norm = stripDiacritics(raw);
    if (norm.length <= 2 || STOPWORDS.has(norm)) return;
    freq.set(norm, (freq.get(norm) ?? 0) + 1);
    if (!firstSeen.has(norm)) firstSeen.set(norm, idx);
  });
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || firstSeen.get(a[0])! - firstSeen.get(b[0])!)
    .slice(0, max)
    .map(([word]) => word);
}

/** Một "section" = một heading (hoặc, khi file không có heading nào, cả
 *  file). Đơn vị dùng chung giữa `_sections.md` (V1) và chunk embedding
 *  (`docs-embed-index.ts`, WP tìm ngữ nghĩa) — xem `collectDocsSections`. */
export interface DocsSection {
  /** Đường dẫn tương đối (posix) từ root dir đang quét. */
  rel: string;
  /** Số dòng 1-based của heading (hoặc 1 khi file không có heading). */
  line: number;
  /** Breadcrumb `H1 › H2 › …` (hoặc title suy ra khi không có heading) —
   *  ĐÃ escape `|`. Đây là cột 2 in ra `_sections.md`. */
  crumb: string;
  /** Nội dung từ ngay sau dòng heading tới ngay trước heading
   *  cùng-hoặc-nông-hơn kế tiếp. */
  body: string;
  /** Tên trang từ frontmatter Confluence (`title:`) — rỗng khi không có.
   *  Không in thành cột riêng, chỉ trộn vào cột tìm kiếm (cột 3). */
  pageTitle: string;
}

/** Tách MỌI section của một file (đã tách sẵn `rel`/`content`) — PURE, không
 *  fs. Logic gốc của `sectionLinesForFile` (V1), tách ra để
 *  `collectDocsSections` (fs, dùng cho cả `_sections.md` lẫn embedding) và
 *  `buildDocsSectionIndex` (pure, unit test trực tiếp bằng nội dung in-memory)
 *  cùng dùng — đảm bảo hai đường không thể lệch nhau. */
function sectionsForFile(rel: string, content: string): DocsSection[] {
  const lines = content.split(/\r\n|\r|\n/);
  const headings = collectHeadings(lines);
  if (headings.length === 0) {
    const title = escapePipe(titleFromFirstLine(content, path.posix.basename(rel).replace(/\.md$/i, '')));
    const { bodyOffset } = splitFrontmatter(content);
    const body = lines.slice(bodyOffset).join('\n');
    return [{ rel, line: 1, crumb: title, body, pageTitle: '' }];
  }
  const pageTitle = splitFrontmatter(content).title ?? '';
  const stack: HeadingHit[] = [];
  const out: DocsSection[] = [];
  for (let i = 0; i < headings.length; i += 1) {
    const h = headings[i]!;
    while (stack.length > 0 && stack[stack.length - 1]!.level >= h.level) stack.pop();
    stack.push(h);
    const breadcrumb = escapePipe(stack.map((s) => s.title).join(' › '));
    // Body: từ ngay sau dòng heading tới NGAY TRƯỚC heading cùng-hoặc-nông-hơn
    // kế tiếp (heading sâu hơn ở giữa vẫn thuộc body — mỗi heading vẫn có
    // dòng riêng của chính nó).
    let endLine = lines.length; // exclusive upper bound (0-based index)
    for (let j = i + 1; j < headings.length; j += 1) {
      if (headings[j]!.level <= h.level) {
        endLine = headings[j]!.line - 1; // 1-based line → 0-based exclusive end
        break;
      }
    }
    const body = lines.slice(h.line, endLine).join('\n'); // h.line is 1-based == index of line AFTER heading
    out.push({ rel, line: h.line, crumb: breadcrumb, body, pageTitle });
  }
  return out;
}

/** Cột 3 (`_sections.md`) từ một section: tên trang (frontmatter Confluence,
 *  rỗng khi không có) + breadcrumb → strip dấu, cộng top keyword của body.
 *  Khi `pageTitle` rỗng (file không heading, hoặc không frontmatter), công
 *  thức rút gọn về đúng hành vi V1 (`stripDiacritics(crumb)`) nhờ `.trim()`
 *  cắt khoảng trắng đầu chuỗi. */
function formatSectionLine(section: DocsSection): string {
  const search = `${stripDiacritics(`${section.pageTitle} ${section.crumb}`)} ${topKeywords(section.body).join(' ')}`.trim();
  return `${section.rel}:${section.line} | ${section.crumb} | ${search}`;
}

const HEADER_COMMENT = [
  '# Mục lục section (sinh cơ học — đừng sửa tay)',
  '',
  'Tìm bằng: grep -i "<chuỗi KHÔNG DẤU>" trên file này → mở đúng path:line.',
  'Cột 3 (chuỗi tìm kiếm) đã strip dấu tiếng Việt; 2 cột đầu giữ nguyên gốc.',
  'File tự regen khi tài liệu đổi — chỉnh tay sẽ bị ghi đè.',
  '',
].join('\n');

/** Hàm PURE — build toàn bộ nội dung `_sections.md` từ danh sách file đã đọc
 *  sẵn (đã lọc `_*`/`attachments/` từ trước, không cần fs). Deterministic:
 *  cùng input → cùng output byte (sort ổn định theo path rồi line). */
export function buildDocsSectionIndex(files: DocsSectionSourceFile[]): string {
  const sorted = [...files].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const dataLines = sorted.flatMap((f) => sectionsForFile(f.rel, f.content).map(formatSectionLine));
  return `${HEADER_COMMENT}${dataLines.join('\n')}\n`;
}

/** Sinh MỌI section (`{rel, line, crumb, body}` + `pageTitle` nội bộ) của
 *  MỌI file `.md` dưới `rootDir` (đệ quy, cùng bộ lọc `_*`/`attachments/`
 *  với `writeDocsSectionIndex`) — sort ổn định theo `rel` rồi thứ tự xuất
 *  hiện heading, khớp thứ tự `buildDocsSectionIndex`. Đây là điểm dùng
 *  chung DUY NHẤT giữa `_sections.md` (V1) và chunk embedding
 *  (`docs-embed-index.ts`) — không parse lại markdown ở nơi thứ hai.
 *  `rootDir` không tồn tại → trả `[]` (không ném lỗi). */
export async function collectDocsSections(rootDir: string): Promise<DocsSection[]> {
  const found: Array<{ rel: string; abs: string; mtimeMs: number }> = [];
  await walkMarkdown(rootDir, '', found);
  const sorted = [...found].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const out: DocsSection[] = [];
  for (const f of sorted) {
    const content = await fs.promises.readFile(f.abs, 'utf8');
    out.push(...sectionsForFile(f.rel, content));
  }
  return out;
}

const SECTIONS_FILENAME = '_sections.md';

function shouldSkip(rel: string): boolean {
  const segments = rel.split('/');
  if (segments.some((s) => s === 'attachments')) return true;
  const base = segments[segments.length - 1]!;
  return base.startsWith('_');
}

async function walkMarkdown(root: string, dir: string, out: Array<{ rel: string; abs: string; mtimeMs: number }>): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(path.join(root, dir), { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return;
    throw err;
  }
  for (const entry of entries) {
    const rel = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (entry.name === 'attachments') continue;
      await walkMarkdown(root, rel, out);
      continue;
    }
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue;
    if (shouldSkip(rel)) continue;
    const abs = path.join(root, rel);
    const stat = await fs.promises.stat(abs).catch(() => null);
    if (!stat) continue;
    out.push({ rel: rel.replace(/\\/g, '/'), abs, mtimeMs: stat.mtimeMs });
  }
}

/** Đếm nhanh (không re-parse markdown) số section/file từ một `_sections.md`
 *  đã có sẵn — dùng khi refresh xác định KHÔNG có gì đổi. */
function countExisting(text: string): { sections: number; files: number } {
  const paths = new Set<string>();
  let sections = 0;
  for (const line of text.split('\n')) {
    const m = /^(.+):\d+ \| /.exec(line);
    if (!m) continue;
    sections += 1;
    paths.add(m[1]!);
  }
  return { sections, files: paths.size };
}

/** Quét `rootDir` (mọi `*.md`, bỏ file bắt đầu `_` và mọi thứ dưới
 *  `attachments/`), build `_sections.md` cạnh nó — atomic (tmp+rename).
 *  "Refresh rẻ": nếu `_sections.md` đã mới hơn mọi *.md nguồn thì KHÔNG đọc
 *  lại nội dung, chỉ đếm nhanh từ file hiện có. `rootDir` không tồn tại → no-op
 *  (trả {sections:0, files:0}, không tạo file rỗng). */
export async function writeDocsSectionIndex(rootDir: string): Promise<{ sections: number; files: number }> {
  const found: Array<{ rel: string; abs: string; mtimeMs: number }> = [];
  await walkMarkdown(rootDir, '', found);
  if (found.length === 0) return { sections: 0, files: 0 };

  const target = path.join(rootDir, SECTIONS_FILENAME);
  const newestSourceMtime = Math.max(...found.map((f) => f.mtimeMs));
  const existingStat = await fs.promises.stat(target).catch(() => null);
  if (existingStat && existingStat.mtimeMs >= newestSourceMtime) {
    const existingText = await fs.promises.readFile(target, 'utf8').catch(() => null);
    // mtime một mình không bắt được XÓA file (còn lại không ai bị "mới hơn"
    // hơn) — cần khớp thêm số file hiện có với số file trong index cũ mới
    // được coi là fresh; lệch số file (thêm/bớt trang) vẫn build lại.
    if (existingText !== null) {
      const existing = countExisting(existingText);
      if (existing.files === found.length) return existing;
    }
  }

  // Không fresh → rebuild thật: dùng lại `collectDocsSections` (đọc content +
  // tách section) thay vì tự đọc file rồi gọi `buildDocsSectionIndex` — cùng
  // MỘT đường parse với phía embedding, tránh lệch hành vi giữa hai nơi.
  // (Đây là một lần `walkMarkdown` THỨ HAI so với lần lấy mtime ở trên; chấp
  // nhận được vì chỉ chạy khi tài liệu vừa đổi, không phải đường nóng.)
  const sections = await collectDocsSections(rootDir);
  const text = `${HEADER_COMMENT}${sections.map(formatSectionLine).join('\n')}\n`;
  const tmp = path.join(
    rootDir,
    `.${SECTIONS_FILENAME}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await fs.promises.writeFile(tmp, text, 'utf8');
  await fs.promises.rename(tmp, target);
  return countExisting(text);
}
