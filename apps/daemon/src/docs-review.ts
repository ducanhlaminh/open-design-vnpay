// Docs → Review tài liệu — per-page PARALLEL fan-out helpers (pipeline
// `dr-review`, workflow `docs-review`).
//
// The dr-review stage clones every ingested doc page into `review/docs/…`
// (one agent run PER PAGE, bounded concurrency) and edits the CLONE against
// an optional `criteria/` folder, leaving `docs/` untouched. Each run also
// writes `review/docs/<...>.changes.json`; the daemon deterministically
// validates that report against the clone (no LLM needed) and merges every
// page into `review/index.json` + `review/summary.md`.
//
// This module holds the PURE, unit-testable pieces: which pages exist, the
// stable page slug, cloning the whole docs/ tree, change validation, and the
// merge. The run-lifecycle orchestration lives in server.ts (it needs the
// design.runs machinery) — same split as prd-review-fanout.ts.

import { promises as fs } from 'node:fs';
import path from 'node:path';

// `truncateAtWordBoundary` sống ở docs-review-enrich.ts (mục 3b) — import
// CHIỀU NÀY không tạo vòng: docs-review-enrich.ts chỉ `import type` từ file
// này (xoá hẳn lúc build, không phải import runtime thật), nên docs-review.ts
// import GIÁ TRỊ ngược lại từ đó là an toàn. Không định nghĩa lại logic cắt
// ranh giới từ ở đây — một bản sao thứ hai chỉ tổ lệch nhau theo thời gian.
import { truncateAtWordBoundary } from './docs-review-enrich.js';

/** A doc page under `docs/` → one fan-out unit. */
export interface DocPage {
  /** Page md path relative to the run cwd, e.g. docs/confluence/i-tai-khoan/1.md */
  mdPath: string;
  /** Stable slug: 'docs/confluence/' or 'docs/' prefix stripped, '/'→'__', '.md' dropped. */
  slug: string;
  /** Page title (from the md frontmatter `title:`), fallback to the file stem. */
  page: string;
}

/** Stable per-page slug — same convention as prd-review-fanout's pageSlug,
 *  extended to also strip a bare `docs/` prefix (this stage's inputs are not
 *  always Confluence — a user can upload a plain .md under docs/). */
export function pageSlug(mdRelPath: string): string {
  const norm = mdRelPath.replace(/\\/g, '/').replace(/^\.\//, '');
  const noPrefix = norm.replace(/^docs\/confluence\//, '').replace(/^docs\//, '');
  return noPrefix.replace(/\.md$/i, '').replace(/\//g, '__');
}

function titleFromFrontmatter(md: string, fallback: string): string {
  const m = /^---\n([\s\S]*?)\n---/.exec(md);
  if (m) {
    const t = /^title:\s*(.+)$/m.exec(m[1]!);
    if (t?.[1]) return t[1].trim();
  }
  return fallback;
}

/** Recursively list every markdown page under `docs/` (excluding the
 *  `_index.md` companion and anything under an `attachments/` folder).
 *  Unlike listMockupPages, EVERY page counts — not just pages carrying a
 *  mockup image, because this stage reviews text/flow/gap issues too. */
export async function listDocPages(cwd: string): Promise<DocPage[]> {
  const featureRoot = path.join(cwd, 'docs-feature');
  const root = (await hasMarkdown(featureRoot)) ? featureRoot : path.join(cwd, 'docs');
  const out: DocPage[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'attachments') continue;
        await walk(abs);
        continue;
      }
      if (!e.name.toLowerCase().endsWith('.md') || e.name.toLowerCase() === '_index.md') continue;
      const md = await fs.readFile(abs, 'utf8').catch(() => '');
      const mdPath = path.relative(cwd, abs).replace(/\\/g, '/');
      out.push({
        mdPath,
        slug: pageSlug(mdPath),
        page: titleFromFrontmatter(md, path.basename(e.name, path.extname(e.name))),
      });
    }
  };
  await walk(root);
  // Deterministic order (path) so re-runs and the index are stable.
  out.sort((a, b) => a.mdPath.localeCompare(b.mdPath));
  return out;
}

async function hasMarkdown(root: string): Promise<boolean> {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => [] as import('node:fs').Dirent[]);
  for (const entry of entries) {
    if (entry.name === 'attachments') continue;
    const abs = path.join(root, entry.name);
    if (entry.isDirectory() && await hasMarkdown(abs)) return true;
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.md') && entry.name.toLowerCase() !== '_index.md') return true;
  }
  return false;
}

// NO rewriteImagePaths here — this stage clones the ENTIRE docs/ tree
// (including attachments/ and every binary image, see cloneDocsForReview
// below) instead of rewriting image refs with a regex. The earlier design
// copied only the .md files and rewrote each `![alt](path)` to point back at
// the original attachments/ folder; that required parsing markdown image
// destination syntax, and it broke in practice because Confluence attachment
// file names can contain spaces (sanitizeImageFileName, bas-client.ts:648,
// strips \/:*?"<>| but never touches whitespace) — a regex anchored on the
// first `)` (or worse, the first whitespace) silently truncated the path.
// Copying the whole tree sidesteps parsing markdown entirely: any relative
// ref in the original still resolves correctly from the clone's mirrored
// location, byte-for-byte, with zero markdown edits. Traded off deliberately:
// images are now duplicated on disk (and in the media store on push) — not
// worked around here, out of scope for this stage.

/** Clone the ENTIRE `docs/` tree (markdown + attachments/ + every binary
 *  image, INCLUDING `_index.md`) into `review/docs/`, byte-for-byte,
 *  mirroring the directory structure — no file's contents are touched, not
 *  even the markdown, and NOTHING is excluded from the copy. The clone must
 *  be a faithful full copy of the original tree so `review/` alone (e.g.
 *  zipped) is self-contained. `_index.md` is a table-of-contents companion,
 *  not a page to review, but that only means it is excluded from the
 *  REVIEWABLE PAGE LIST — `listDocPages` already does that filtering above.
 *  Filtering it out of the copy too would be double-filtering and would make
 *  `review/docs/` a lossy mirror. Overwrites any previous clone so a re-run
 *  always starts from a clean copy of the current original. Returns the
 *  cwd-relative clone paths of the reviewable .md pages (i.e. `listDocPages`'s
 *  pages mapped into `review/docs/…`) — NOT `_index.md` and NOT the copied
 *  image files. */
export async function cloneDocsForReview(cwd: string): Promise<string[]> {
  const pages = await listDocPages(cwd);
  const rootName = pages[0]?.mdPath.startsWith('docs-feature/') ? 'docs-feature' : 'docs';
  const src = path.join(cwd, rootName);
  const dest = path.join(cwd, 'review', rootName);
  await fs.rm(dest, { recursive: true, force: true });
  try {
    await fs.cp(src, dest, { recursive: true, force: true });
  } catch (error) {
    // No docs/ at all (stage never ran) — nothing to clone; listDocPages
    // above already returned [] in that case, so callers see an empty result.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return pages.map((p) => path.posix.join('review', p.mdPath));
}

/** Delete a single page's clone (`review/docs/<mdPath>`), its companion
 *  `.changes.json` / `.notes.json`, AND every per-section temp file the
 *  section fan-out staged for that page (`<stem>.s<NN>.changes.json` /
 *  `<stem>.s<NN>.notes.json`). Idempotent — a missing file is not an error.
 *  This is the ONE fail-shut primitive server.ts must call from EVERY
 *  not-fully-successful exit of the fan-out — validation failure, a page run
 *  that failed, a missing/corrupt changes.json, a worker exception, the
 *  fan-out's own OUTER catch (the whole stage blowing up after the clone was
 *  already staged — e.g. insertConversation throwing, disk full while
 *  writing index.json/summary.md), or a cancel — see the block comment above
 *  runDocsReviewFanout in server.ts for why leaving a stray clone behind is a
 *  silent failure, not a cosmetic one.
 *
 *  Các file tạm theo SECTION cũng phải bị xoá ở đây, vì cùng một lý do:
 *  chúng nằm dưới `review/` nên chỉ cần một file sót lại là
 *  `deriveStateFromLocalFiles` suy ra stage đã 'succeeded' và thắng trạng
 *  thái 'failed' vừa ghi vào DB. Số section KHÔNG được đoán — hàm liệt kê
 *  thư mục chứa bản clone rồi lọc theo tiền tố tên file, nên một lần chạy
 *  hỏng giữa chừng (số file tạm không khớp số section dự kiến) vẫn được dọn
 *  sạch. */
export async function removePageOutputs(cwd: string, mdPath: string): Promise<void> {
  const reviewRel = path.posix.join('review', mdPath);
  const changesRel = reviewRel.replace(/\.md$/i, '.changes.json');
  const notesRel = reviewRel.replace(/\.md$/i, '.notes.json');
  const sysChangesRel = systemChangesPath(reviewRel);
  await fs.rm(path.join(cwd, reviewRel), { force: true }).catch(() => null);
  await fs.rm(path.join(cwd, changesRel), { force: true }).catch(() => null);
  await fs.rm(path.join(cwd, notesRel), { force: true }).catch(() => null);
  await fs.rm(path.join(cwd, sysChangesRel), { force: true }).catch(() => null);

  const dirAbs = path.dirname(path.join(cwd, reviewRel));
  const stem = path.basename(reviewRel).replace(/\.md$/i, '');
  const escaped = stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Lát cắt `.s<NN>.slice.md` cũng là file tạm dưới `review/` nên phải bị dọn ở
  // đây, cùng lý do với changes/notes: một file sót lại đủ để
  // `deriveStateFromLocalFiles` suy ra stage đã 'succeeded'. `.sys.changes.json`
  // đã bị xoá trực tiếp ở trên (đường dẫn xác định, không cần liệt kê thư mục)
  // nhưng vẫn được nhận trong regex này để chống sót nếu một biến thể nào đó
  // sau này ghi thêm hậu tố `.s<NN>` trước `.sys.changes.json`.
  const tempRe = new RegExp(`^${escaped}\\.(s\\d+\\.((changes|notes)\\.json|slice\\.md)|sys\\.changes\\.json)$`);
  const entries = await fs.readdir(dirAbs).catch(() => [] as string[]);
  for (const name of entries) {
    if (tempRe.test(name)) await fs.rm(path.join(dirAbs, name), { force: true }).catch(() => null);
  }
}

/** Per-section output file name for a page's clone, e.g.
 *  `review/docs/confluence/a.md` + section 3 → `review/docs/confluence/a.s03.changes.json`.
 *  `NN` is the section index zero-padded to two digits. Shared by server.ts
 *  (kickoff text + read-back) and removePageOutputs's cleanup regex above so
 *  the two cannot drift. */
export function sectionOutputPath(reviewRel: string, index: number, what: 'changes' | 'notes'): string {
  const nn = String(index).padStart(2, '0');
  return reviewRel.replace(/\.md$/i, `.s${nn}.${what}.json`);
}

/** File LÁT CẮT của một section — nơi DUY NHẤT agent của section đó được sửa,
 *  ví dụ `review/docs/confluence/a.md` + section 3 → `…/a.s03.slice.md`.
 *
 *  Vì sao có: trước đây mọi section của một trang cùng Edit MỘT bản clone, nên
 *  chúng buộc phải chạy tuần tự — hai agent sửa một file là hỏng dữ liệu. Với
 *  một trang 9 section thì "fan-out" thực chất là xếp hàng, và mức song song
 *  của cả stage tụt về 1 dù pool cho phép 4. Cắt mỗi section ra file riêng làm
 *  chúng độc lập thật sự; daemon ghép lại sau (xem {@link rebuildPageFromSlices}). */
export function sectionSlicePath(reviewRel: string, index: number): string {
  const nn = String(index).padStart(2, '0');
  return reviewRel.replace(/\.md$/i, `.s${nn}.slice.md`);
}

/** File MỤC LỤC của một trang — một file cho cả trang, nằm cạnh các lát cắt,
 *  ví dụ `review/docs/confluence/a.md` → `…/a.outline.md`.
 *
 *  Vì sao có (đo 2026-08 trên transcript thật): mỗi lượt section đọc lại CẢ
 *  trang gốc (~190 KB ≈ 60k token) rồi cả bản clone, dù nó chỉ được sửa một
 *  lát ~100–200 dòng — với 8 section là 8 lần đọc cùng một trang. Mục lục cho
 *  agent biết trang có những phần nào, phần của mình nằm ở đâu, và cần ngữ
 *  cảnh ngoài section thì Read đúng khoảng dòng nào của bản gốc thay vì đọc
 *  hết. Được ghi cùng lúc với các lát và xoá cùng lúc với chúng. */
export function pageOutlinePath(reviewRel: string): string {
  return reviewRel.replace(/\.md$/i, '.outline.md');
}

/** File change do DAEMON tự ghi cho một trang (nguồn `system`, không phải
 *  agent) — ví dụ WP2 đối chiếu lại `flows/…` rồi tự đánh dấu sơ đồ nào vừa
 *  đổi, không cần một lượt agent riêng cho việc đó. Cùng convention với
 *  {@link sectionOutputPath}/{@link pageOutlinePath}: `reviewRel` là đường dẫn
 *  bản clone (`review/docs/…/a.md`), ví dụ `review/docs/confluence/a.md` →
 *  `review/docs/confluence/a.sys.changes.json`. */
export function systemChangesPath(reviewRel: string): string {
  return reviewRel.replace(/\.md$/i, '.sys.changes.json');
}

/** Đếm số dấu `#` dẫn đầu một dòng heading NGUYÊN VĂN (`sec.heading`) — chuỗi
 *  rỗng (phần mở đầu trước heading đầu tiên) hoặc không bắt đầu bằng `#` trả
 *  về `0`. Dùng bởi {@link isParentHeadingSection} để so cấp heading giữa hai
 *  section liền nhau. */
export function headingLevel(heading: string): number {
  const m = /^(#{1,6})\s/.exec(heading);
  return m ? m[1]!.length : 0;
}

/** `sections[index]` là một heading RỖNG nhưng là MỤC CHA của các mục con
 *  ngay dưới nó (nội dung nằm ở mục con, không phải một gap thật) — ĐÚNG khi
 *  VÀ CHỈ KHI: section rỗng (`bodyLines === 0`), có heading thật (`level >
 *  0`), có section kế tiếp, và heading của section kế tiếp SÂU HƠN (cấp `#`
 *  nhiều hơn) heading của section này.
 *
 *  Bằng chứng cần hàm này (dự án dich-vu-mua-sim, run thật): 5 note "Nặng"
 *  (gap `major`) bị ghi oan cho các heading CHA thuần tuý gom nhóm (`6.1`,
 *  `6.2`, `6.3` — không có "nội dung" nào khác ngoài các mục con `6.1.1`,
 *  `6.1.2`… đứng ngay dưới) — trong khi nội dung THẬT nằm đầy đủ ở các mục
 *  con đó, không hề thiếu. Section rỗng nhưng section kế tiếp CÙNG cấp (hoặc
 *  nông hơn) thì đây KHÔNG phải mục cha — heading đó thật sự rỗng (gap). */
export function isParentHeadingSection(sections: readonly DocSection[], index: number): boolean {
  const sec = sections[index];
  if (!sec || sec.bodyLines !== 0) return false;
  const level = headingLevel(sec.heading);
  if (level === 0) return false;
  const next = sections[index + 1];
  if (!next) return false;
  return headingLevel(next.heading) > level;
}

/** Nội dung file mục lục (xem {@link pageOutlinePath}). Chỉ chứa cấu trúc —
 *  heading nguyên văn + khoảng dòng + cờ rỗng/ảnh — không chép nội dung. */
export function renderPageOutline(input: {
  page: string;
  mdPath: string;
  reviewRel: string;
  totalLines: number;
  sections: ReadonlyArray<DocSection>;
}): string {
  const lines: string[] = [];
  lines.push(`# Mục lục trang: ${input.page}`);
  lines.push('');
  lines.push(`Bản gốc (CHỈ ĐỌC): \`${input.mdPath}\` — ${input.totalLines} dòng, ${input.sections.length} section.`);
  lines.push(`Lát cắt của section NN: \`${sectionSlicePath(input.reviewRel, 0).replace(/\.s00\.slice\.md$/, '.s<NN>.slice.md')}\` — chứa ĐÚNG nội dung section đó.`);
  lines.push('');
  lines.push('Chỉ đọc LÁT CẮT của bạn. Cần ngữ cảnh ngoài section (thuật ngữ, luồng nhắc ở phần khác): Read bản gốc với `offset`/`limit` theo khoảng dòng dưới đây — KHÔNG đọc cả trang, KHÔNG đọc bản clone cả trang.');
  lines.push('');
  input.sections.forEach((sec, idx) => {
    const nn = String(sec.index).padStart(2, '0');
    const heading = sec.heading || '(phần mở đầu, trước heading đầu tiên)';
    const flags: string[] = [];
    if (sec.bodyLines === 0) {
      flags.push(
        isParentHeadingSection(input.sections, idx)
          ? 'MỤC CHA — nội dung ở mục con'
          : 'RỖNG — chỉ có tiêu đề',
      );
    }
    if (sec.imageRefs.length > 0) flags.push(`${sec.imageRefs.length} ảnh`);
    const range = `dòng ${sec.startLine}–${sec.endLine}`;
    lines.push(`- s${nn}  ${range}  ${heading}${flags.length ? `  [${flags.join('; ')}]` : ''}`);
  });
  lines.push('');
  return lines.join('\n');
}

/** Kiểu xuống dòng của một văn bản — giữ nguyên khi ghép lại để bản clone
 *  không bị đổi hàng loạt chỉ vì đi qua vòng cắt/ghép. */
export function detectEol(text: string): '\r\n' | '\n' {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

/** Cắt `md` thành đúng một lát cho MỖI section, theo khoảng dòng của chúng.
 *
 *  Điều kiện đúng đắn (đã khoá bằng test): các section do splitSections sinh ra
 *  phủ KÍN và KHÔNG chồng lấn toàn bộ trang, nên nối các lát theo thứ tự index
 *  dựng lại đúng nguyên văn trang ban đầu. Nếu điều đó vỡ, việc ghép sẽ làm mất
 *  hoặc nhân đôi nội dung — nên hàm này không tự "sửa" khoảng dòng lệch mà cứ
 *  cắt đúng như được bảo, còn phép kiểm tra phủ kín nằm ở test. */
export function sliceSections(md: string, sections: DocSection[]): string[] {
  const eol = detectEol(md);
  const lines = md.split(/\r?\n/);
  return sections.map((s) => lines.slice(s.startLine - 1, s.endLine).join(eol));
}

/** Ghép các lát (đã sửa) trở lại thành nguyên trang, theo đúng thứ tự đã cắt. */
export function rebuildPageFromSlices(slices: string[], eol: '\r\n' | '\n'): string {
  return slices.join(eol);
}

/** cwd-relative path of the "run didn't produce a review" note — see
 *  {@link writeDocsReviewFailureNote}. Exported so server.ts can delete a
 *  stale one at the start of a run without hardcoding the string twice. */
export const DOCS_REVIEW_FAILURE_NOTE = 'review-khong-chay-duoc.md';

/** Wipe `review/` COMPLETELY, then write `body` to
 *  `<cwd>/review-khong-chay-duoc.md` — a path deliberately NGANG HÀNG (a
 *  sibling of) `review/`, not under it, so it never matches dr-review's
 *  declared output pattern (`outputs: ['review/']` in pipelines.ts —
 *  `stagesForOutput('docs-review/review-khong-chay-duoc.md')` returns `[]`).
 *
 *  Call this from every runDocsReviewFanout exit that returns something
 *  other than 'succeeded' with NO page confirmed successful. The FAIL-SHUT
 *  INVARIANT above runDocsReviewFanout (server.ts) already deletes a failed
 *  PAGE's own clone; this is the stage-level counterpart — it deletes
 *  review/index.json, review/summary.md, and anything cloneDocsForReview
 *  staged (e.g. `_index.md`/`attachments/` copied even when there is no
 *  REVIEWABLE page — see cloneDocsForReview's docblock), because file
 *  presence under `review/` — ANY file, not just a page clone — is what
 *  `mergePipelineState` reads as "stage succeeded" (disk signal wins over
 *  DB status). Leaving even review/summary.md behind after declaring
 *  'failed' is exactly the bug this helper exists to prevent: the stage
 *  shows green from file signal alone while the DB says it just failed. */
export async function writeDocsReviewFailureNote(cwd: string, body: string): Promise<void> {
  await fs.rm(path.join(cwd, 'review'), { recursive: true, force: true }).catch(() => null);
  await fs.writeFile(path.join(cwd, DOCS_REVIEW_FAILURE_NOTE), body, 'utf8');
}

export type DocChangeKind = 'ux-writing' | 'flow' | 'gap' | 'edge-case' | 'component' | 'flow-diagram';
export type DocChangeSeverity = 'blocker' | 'major' | 'minor';

/** Một lát cắt của MỘT trang tài liệu → một lượt chạy agent.
 *
 *  Vì sao cắt nhỏ hơn trang: đơn vị fan-out cũ là cả trang, mà một trang URD
 *  thật có thể 584 dòng / 71KB. Một lượt agent phải vừa đọc hết, vừa soi 5
 *  nhóm tiêu chí, vừa mở ảnh — kết quả đo được là nó bỏ sót đúng những mục
 *  RỖNG (chỉ có heading, không có nội dung), tức gap lớn nhất của tài liệu.
 *  Cắt theo heading giảm tải chú ý cho mỗi lượt; nó KHÔNG nhằm tăng tốc (các
 *  section của cùng một trang vẫn chạy tuần tự vì chung một file clone). */
export interface DocSection {
  /** Chỉ số liên tục từ 0 trong phạm vi một trang; cũng là NN trong tên file
   *  tạm `<clone>.s<NN>.changes.json`. */
  index: number;
  /** Dòng heading NGUYÊN VĂN mở đầu section (kể cả dấu `#`). Chuỗi rỗng =
   *  phần trước heading đầu tiên (frontmatter + mở đầu). */
  heading: string;
  /** 1-based. */
  startLine: number;
  /** 1-based, INCLUSIVE. */
  endLine: number;
  /** Số dòng KHÔNG rỗng, KHÔNG tính chính các dòng heading. `0` nghĩa là
   *  heading tồn tại nhưng không có nội dung — tín hiệu gap mức major. */
  bodyLines: number;
  /** Mọi đường dẫn ảnh trong phạm vi section, giữ NGUYÊN VĂN (không resolve,
   *  không sửa) — bản clone copy nguyên cây `docs/` nên ref tương đối vẫn
   *  đúng, agent chỉ việc Read thẳng. */
  imageRefs: string[];
}

const HEADING_RE = /^#{1,6}\s/;
const IMAGE_REF_RE = /!\[[^\]]*\]\(([^)]+)\)/g;

/** Cắt một trang markdown thành các section theo dòng heading.
 *
 *  Ba điểm dễ làm sai, đã khoá bằng test:
 *   - Heading nằm trong fenced code block (``` hoặc ~~~) KHÔNG phải heading.
 *     Tài liệu kỹ thuật hay dán ví dụ markdown vào code block; cắt theo đó sẽ
 *     đẻ ra section giả và làm lệch khoảng dòng của mọi section sau nó.
 *   - Gộp tham lam tới ngưỡng `minLines` (mặc định 120) để không sinh hàng
 *     chục section tí hon — mỗi section là một lượt agent, section 3 dòng chỉ
 *     tốn lượt chạy mà không đổi chất lượng.
 *   - NHƯNG không bao giờ gộp qua một block có `bodyLines === 0`. Chính những
 *     mục rỗng đó (vd "2.1 Sơ đồ luồng" chỉ có heading) là phát hiện đáng giá
 *     nhất; gộp nó vào section hàng xóm là làm nó biến mất khỏi kickoff. */
export function splitSections(md: string, opts?: { minLines?: number }): DocSection[] {
  const minLines = opts?.minLines ?? 120;
  const lines = md.split(/\r?\n/);

  // Bước 1 — cắt thô thành block: phần mở đầu (nếu có) + mỗi heading một block.
  type Block = { heading: string; startLine: number; endLine: number; bodyLines: number };
  const blocks: Block[] = [];
  let fence: string | null = null;
  let cur: Block | null = null;
  const flushBlock = () => {
    if (cur) blocks.push(cur);
    cur = null;
  };
  lines.forEach((line, i) => {
    const lineNo = i + 1;
    const fenceMatch = /^\s*(```|~~~)/.exec(line);
    const isHeading = fence === null && HEADING_RE.test(line);
    if (isHeading) {
      flushBlock();
      cur = { heading: line, startLine: lineNo, endLine: lineNo, bodyLines: 0 };
    } else {
      if (!cur) cur = { heading: '', startLine: lineNo, endLine: lineNo, bodyLines: 0 };
      cur.endLine = lineNo;
      if (line.trim() !== '') cur.bodyLines += 1;
    }
    if (cur) cur.endLine = lineNo;
    if (fenceMatch) {
      const marker = fenceMatch[1]!;
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
    }
  });
  flushBlock();
  if (blocks.length === 0) {
    return [{ index: 0, heading: '', startLine: 1, endLine: lines.length, bodyLines: 0, imageRefs: [] }];
  }

  // Bước 2 — gộp tham lam tới ngưỡng, không gộp qua block rỗng.
  const merged: Block[] = [];
  let acc: Block | null = null;
  const flushAcc = () => {
    if (acc) merged.push(acc);
    acc = null;
  };
  for (const b of blocks) {
    if (b.bodyLines === 0) {
      flushAcc();
      merged.push(b);
      continue;
    }
    if (!acc) acc = { ...b };
    else {
      acc.endLine = b.endLine;
      acc.bodyLines += b.bodyLines;
    }
    if (acc.bodyLines >= minLines) flushAcc();
  }
  flushAcc();

  return merged.map((b, index) => {
    const body = lines.slice(b.startLine - 1, b.endLine).join('\n');
    const imageRefs: string[] = [];
    IMAGE_REF_RE.lastIndex = 0;
    for (let m = IMAGE_REF_RE.exec(body); m; m = IMAGE_REF_RE.exec(body)) {
      if (m[1]) imageRefs.push(m[1]);
    }
    return {
      index,
      heading: b.heading,
      startLine: b.startLine,
      endLine: b.endLine,
      bodyLines: b.bodyLines,
      imageRefs,
    };
  });
}

/** Một nhận xét KHÔNG sửa được bằng cách sửa chữ trong tài liệu.
 *
 *  Vì sao cần loại thứ hai bên cạnh DocChange: cơ chế sửa-in-place +
 *  validateChanges ép agent chỉ đi tìm thứ nó sửa được bằng text. Đo trên một
 *  run thật, agent lách bằng cách chèn "[Rà soát — …]" vào giữa ô bảng
 *  markdown chỉ để có chỗ gắn `quote` — vừa làm vỡ bảng của tài liệu gốc, vừa
 *  biến một nhận xét kiến trúc thành một "chỗ sửa" giả. Những phát hiện thật
 *  sự đáng giá — sai R-OVERLAY, dùng component ngoài danh mục, thiếu cả một
 *  màn hình, sơ đồ rỗng — không có bản sửa bằng chữ, nên chúng cần đường ra
 *  riêng. `anchor` chỉ để ĐỊNH VỊ trong bản gốc, không phải để đối chiếu sửa
 *  đổi (xem validateNotes). */
export interface DocNote {
  id: string;
  kind: DocChangeKind;
  severity: DocChangeSeverity;
  rule_id?: string;
  /** Nguyên văn một đoạn trong bản GỐC để neo nhận xét vào đúng chỗ. */
  anchor: string;
  /** Như {@link DocChange.doc_refs} nhưng nguyên văn lấy từ bản GỐC (note
   *  không sửa gì nên gốc và bản đã sửa như nhau tại các đoạn nó viện dẫn). */
  doc_refs?: string[];
  finding: string;
  suggestion: string;
  /** Daemon gắn khi `anchor` không tìm thấy trong bản gốc (xem
   *  {@link partitionNotesByAnchor}): note vẫn giữ để đọc trong danh sách,
   *  chỉ không bôi được vào tài liệu. */
  anchor_unresolved?: true;
}

export interface DocChange {
  id: string;
  kind: DocChangeKind;
  severity: DocChangeSeverity;
  rule_id?: string;
  /** Ai tạo ra change này. `'system'` = daemon tự ghi (vd sơ đồ luồng
   *  `flow-diagram` do WP2 dựng lại từ `flows/…`), `'agent'` = agent review
   *  viết trong lượt chạy skill như mọi change khác. Tuỳ chọn — không có nghĩa
   *  là agent (giá trị mặc định ngầm định), parser giữ nguyên nếu file có gửi
   *  trường này, không tự gán khi thiếu. */
  origin?: 'agent' | 'system';
  /** Nguyên văn đoạn trong bản GỐC bị thay hoặc bị xoá. */
  before?: string;
  /** Nguyên văn đoạn trong bản ĐÃ SỬA. */
  quote?: string;
  /** BẮT BUỘC với change XOÁ THUẦN (chỉ có `before`): nguyên văn một đoạn
   *  trong bản ĐÃ SỬA nằm NGAY CẠNH vị trí xoá (câu liền trước hoặc liền sau),
   *  để UI chèn hiển thị "chữ đã xoá" vào đúng chỗ trong tài liệu. Một change
   *  xoá thuần không có `quote` nào để neo, nên nếu thiếu cả `anchor` thì chỗ
   *  xoá KHÔNG định vị được vào bản đã sửa và UI không thể hiện được nó. */
  anchor?: string;
  /** Tham chiếu máy đọc được: mỗi phần tử là NGUYÊN VĂN một đoạn KHÁC trong
   *  bản ĐÃ SỬA mà `reason` viện dẫn (vd đoạn định nghĩa thuật ngữ, dòng luồng
   *  F-009). Tối đa 3. UI dựng thành nút nhảy tới đoạn đó — viện dẫn suông
   *  bằng lời ("như luồng F-009 mô tả") thì người đọc phải tự đi tìm. */
  doc_refs?: string[];
  reason: string;
}
// GHI CHÚ THIẾT KẾ (sửa sau vòng review 2 — bắt buộc đọc trước khi đổi lại):
// Một change phải mang được CẢ HAI phía — `before` (nguyên văn ở bản GỐC) và
// `quote` (nguyên văn ở bản ĐÃ SỬA). Bản chỉ có `quote` là SAI: `quote` theo
// hợp đồng lấy từ bản đã sửa, nên nó không bao giờ khớp nổi dòng gốc đã biến
// mất. Với một lần sửa chữ bình thường — gốc 'Người dùng nhập OTP.' thành
// 'Người dùng nhập mã OTP gồm 6 chữ số.' — dòng gốc bị coi là xoá-không-khai-
// báo, trang bị đánh hỏng và bản clone bị xoá, tức validator từ chối gần như
// MỌI lần chạy thật dù test vẫn xanh (đúng lỗi pass này sửa).
// Quy ước theo loại thay đổi: sửa/thay => có cả `before` và `quote`;
// bổ sung thuần => chỉ `quote`; xoá thuần => chỉ `before` + BẮT BUỘC `anchor`.
// Cả hai rỗng là lỗi.

const DOC_CHANGE_KINDS: readonly DocChangeKind[] = ['ux-writing', 'flow', 'gap', 'edge-case', 'component', 'flow-diagram'];
const DOC_CHANGE_SEVERITIES: readonly DocChangeSeverity[] = ['blocker', 'major', 'minor'];

/** Số tham chiếu tối đa cho `doc_refs`. Không phải con số tuỳ ý: mỗi ref là
 *  một nút nhảy trong UI, và một `reason` một-câu viện dẫn quá 3 chỗ khác
 *  trong tài liệu thì nó đã không còn là một nhận xét định vị được nữa. */
const DOC_REFS_MAX = 3;

/** rule_id hợp lệ khi agent áp bộ tiêu chí MẶC ĐỊNH của skill (dự án không có
 *  `criteria/`). Khớp 1-1 với mục "Bộ tiêu chí mặc định" trong SKILL.md.
 *
 *  Vì sao cần bộ này: trước đây skill dặn BỎ TRỐNG `rule_id` khi dùng bộ mặc
 *  định, nên đo trên một run thật 16/27 change không có rule_id nào — tức phần
 *  lớn phát hiện mất hẳn khả năng trace về tiêu chí. Bộ mặc định là một bộ
 *  tiêu chí có thật, chỉ là không nằm trong file, nên nó xứng đáng có định
 *  danh riêng. Nhóm `component` KHÔNG có id mặc định: nó bị bỏ qua hoàn toàn
 *  khi thiếu `criteria/` (không có danh mục thì không có gì để đối chiếu). */
export const DEFAULT_RULE_IDS: ReadonlySet<string> = new Set([
  'default#ux-writing-chu-ngu', // câu mơ hồ ai làm gì
  'default#ux-writing-thuat-ngu', // thuật ngữ không nhất quán trong cùng trang
  'default#ux-writing-viet-tat', // viết tắt lần đầu không giải nghĩa
  'default#ux-writing-nhan-nut', // nhãn nút/thông báo không rõ hành động/hậu quả
  'default#flow',
  'default#gap',
  'default#edge-case',
]);

/** Kiểm SHAPE của `doc_refs` cho một phần tử changes.json/notes.json — dùng
 *  chung cho cả hai parser để luật không thể lệch nhau. Trả mảng lỗi tiếng
 *  Việt (rỗng = đạt); `undefined` là hợp lệ (trường tuỳ chọn). */
function docRefsShapeErrors(value: unknown, index: number): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    return [`Phần tử thứ ${index}: 'doc_refs' phải là mảng chuỗi khi có mặt, nhận được ${JSON.stringify(value)}.`];
  }
  const errors: string[] = [];
  if (value.length > DOC_REFS_MAX) {
    errors.push(`Phần tử thứ ${index}: 'doc_refs' tối đa ${DOC_REFS_MAX} tham chiếu, nhận được ${value.length}.`);
  }
  value.forEach((ref, j) => {
    if (typeof ref !== 'string' || ref.trim() === '') {
      errors.push(
        `Phần tử thứ ${index}: 'doc_refs[${j}]' phải là chuỗi không rỗng, nhận được ${JSON.stringify(ref)}.`,
      );
    }
  });
  return errors;
}

/** Parse + validate the SHAPE of a page's `changes.json` (raw file text).
 *  `JSON.parse` + `Array.isArray` + `as DocChange[]` does NOT check anything
 *  at runtime — a cast is a compile-time-only assertion — so a malformed
 *  element like `{"quote":"..."}`  (missing id/kind/severity/reason) used to
 *  sail straight through: `validateChanges` only reads `quote`/`before`, so
 *  the page was marked succeeded, and `mergeChangeReports` then counted an
 *  `undefined` severity, corrupting the blocker/major/minor totals in
 *  summary.md with no rule_id to trace the bad entry back to. This function
 *  is the runtime check that cast was pretending to be. It is pure and
 *  test-only-reachable (no fs, no fetch) so shape validation has the same
 *  unit-testability as everything else in this module. Returns `{ changes }`
 *  on success or `{ errors }` (Vietnamese, one message per offending element
 *  naming its index and the bad field) on any shape violation — the caller
 *  (server.ts) treats `errors` as page-failed, same as a validateChanges
 *  failure. */
export function parseChangesFile(raw: string): { changes: DocChange[] } | { errors: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { errors: [`changes.json không phải JSON hợp lệ: ${error instanceof Error ? error.message : String(error)}`] };
  }
  if (!Array.isArray(parsed)) {
    return { errors: ["changes.json không phải một mảng."] };
  }

  const errors: string[] = [];
  const changes: DocChange[] = [];
  parsed.forEach((raw, i) => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      errors.push(`Phần tử thứ ${i} không phải một object.`);
      return;
    }
    const item = raw as Record<string, unknown>;
    if (typeof item.id !== 'string' || item.id.trim() === '') {
      errors.push(`Phần tử thứ ${i}: 'id' phải là chuỗi không rỗng, nhận được ${JSON.stringify(item.id)}.`);
    }
    if (typeof item.reason !== 'string' || item.reason.trim() === '') {
      errors.push(`Phần tử thứ ${i}: 'reason' phải là chuỗi không rỗng, nhận được ${JSON.stringify(item.reason)}.`);
    }
    if (!DOC_CHANGE_KINDS.includes(item.kind as DocChangeKind)) {
      errors.push(
        `Phần tử thứ ${i}: 'kind' phải là một trong (${DOC_CHANGE_KINDS.join(', ')}), nhận được ${JSON.stringify(item.kind)}.`,
      );
    }
    if (!DOC_CHANGE_SEVERITIES.includes(item.severity as DocChangeSeverity)) {
      errors.push(
        `Phần tử thứ ${i}: 'severity' phải là một trong (${DOC_CHANGE_SEVERITIES.join(', ')}), nhận được ${JSON.stringify(item.severity)}.`,
      );
    }
    if (item.before !== undefined && typeof item.before !== 'string') {
      errors.push(`Phần tử thứ ${i}: 'before' phải là chuỗi khi có mặt, nhận được ${JSON.stringify(item.before)}.`);
    }
    if (item.quote !== undefined && typeof item.quote !== 'string') {
      errors.push(`Phần tử thứ ${i}: 'quote' phải là chuỗi khi có mặt, nhận được ${JSON.stringify(item.quote)}.`);
    }
    if (item.anchor !== undefined && typeof item.anchor !== 'string') {
      errors.push(`Phần tử thứ ${i}: 'anchor' phải là chuỗi khi có mặt, nhận được ${JSON.stringify(item.anchor)}.`);
    }
    errors.push(...docRefsShapeErrors(item.doc_refs, i));
    changes.push(item as unknown as DocChange);
  });

  if (errors.length > 0) return { errors };
  return { changes };
}

/** Turn `text` into a whitespace-tolerant RegExp source: each `\s+`-separated
 *  token is regex-escaped, tokens are re-joined with `\s+` so a quote spanning
 *  a line break / re-wrapped whitespace in the revised copy still matches.
 *  Same idea as SpecPreview.tsx's fuzzyRegex. */
function fuzzyPattern(text: string): string {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  return tokens.map((tok) => tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
}

/** Đưa về NFC trước khi so. Tài liệu Confluence nạp về hay là bản TRỘN NFC/NFD
 *  (tiếng Việt gõ bằng bộ gõ khác nhau) còn agent luôn viết NFC → anchor/quote
 *  đúng từng chữ mà `includes` vẫn trượt. Đo thật trên PRD "Mua SIM du lịch":
 *  2/2 note trượt vì "Điểm Đến" trong bảng ở dạng NFD, làm hỏng cả trang. */
function nfc(text: string): string {
  return text.normalize('NFC');
}

export function fuzzyIncludes(haystack: string, needle: string): boolean {
  const pattern = fuzzyPattern(nfc(needle));
  if (!pattern) return false;
  return new RegExp(pattern).test(nfc(haystack));
}

/** Cắt một đoạn trích tài liệu (`quote`/`before`/`anchor`/`doc_ref`) trước khi
 *  nhúng nó vào một CHUỖI LỖI/CẢNH BÁO — gộp whitespace thành một dấu cách rồi
 *  {@link truncateAtWordBoundary} về `max` ký tự (mặc định 80, đủ để người đọc
 *  nhận ra CHỖ nào trong tài liệu mà không phải cuộn qua một khối trích dẫn).
 *
 *  Bằng chứng cần hàm này (dự án dich-vu-mua-sim): trước đây các lỗi
 *  validateChanges/validateNotes nhúng NGUYÊN VĂN dòng/anchor vào thông báo —
 *  một hàng bảng markdown dài cỡ 1.500 ký tự lọt thẳng vào `summary.md`, biến
 *  mục "Section không đạt" thành một khối dump khó đọc thay vì một danh sách
 *  lỗi. Hàm này KHÔNG đổi PHẦN CHỮ MÔ TẢ của thông báo, chỉ cắt phần trích
 *  dẫn nhúng vào nó — logic đối chiếu (fuzzyIncludes…) vẫn dùng bản đầy đủ,
 *  chỉ hiển thị mới đi qua đây. */
export function clipQuote(s: string, max = 80): string {
  return truncateAtWordBoundary(s.replace(/\s+/g, ' ').trim(), max);
}

/** Multiset of non-blank lines (trimmed) → count, in original order of first
 *  appearance (order doesn't matter for the multiset math, only for stable
 *  iteration when reporting). */
function lineMultiset(text: string): Map<string, number> {
  const map = new Map<string, number>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    map.set(line, (map.get(line) ?? 0) + 1);
  }
  return map;
}

/** Đối chiếu changes đã khai báo của một trang với cặp (original, revised).
 *  Trả về mảng lỗi tiếng Việt — mảng rỗng nghĩa là trang đạt. Ba kiểm tra,
 *  KHÔNG cài thuật toán diff/LCS:
 *
 *   (a) NEO HỎNG — với mỗi change: có `quote` thì `quote` phải fuzzy-tìm thấy
 *       trong `revised`; có `before` thì `before` phải fuzzy-tìm thấy trong
 *       `original`. Change mà cả `before` lẫn `quote` đều rỗng/chỉ khoảng
 *       trắng là lỗi (không có gì để đối chiếu với bản nào).
 *
 *   (b) SỬA KHÔNG KHAI — so multiset dòng của `original` và `revised` theo
 *       CẢ HAI CHIỀU:
 *       - dòng xuất hiện ở `revised` NHIỀU HƠN `original` => dòng ĐƯỢC
 *         THÊM/ĐỔI, chỉ được phủ bởi trường `quote` của một change (quote lấy
 *         nguyên văn từ bản đã sửa nên chỉ nó mới có thể khớp dòng mới).
 *       - dòng xuất hiện ở `original` NHIỀU HƠN `revised` => dòng BỊ XOÁ, chỉ
 *         được phủ bởi trường `before` của một change (before lấy nguyên văn
 *         từ bản gốc nên chỉ nó mới có thể khớp dòng đã biến mất).
 *       BẮT BUỘC xét cả chiều xoá — chỉ duyệt revisedLines bỏ lọt hoàn toàn
 *       trường hợp agent xoá nội dung mà không khai báo (đúng thứ nguy hiểm
 *       nhất validator này sinh ra để chặn).
 *       TUYỆT ĐỐI không cho `quote` phủ dòng bị xoá, và không cho `before`
 *       phủ dòng được thêm/đổi: `quote` lấy từ bản ĐÃ SỬA nên với một lần sửa
 *       chữ bình thường nó không bao giờ khớp nổi dòng gốc đã biến mất — nếu
 *       cho phép, validator sẽ từ chối gần như MỌI lần chạy thật (đây chính
 *       là lỗi bản chất mà pass này sửa). Phép khớp vẫn dùng lại fuzzyIncludes
 *       ở (a), xét cả hai chiều (trường chứa dòng, hoặc dòng chứa trường).
 *
 *   (c) ĐỊNH VỊ ĐƯỢC VÀO BẢN ĐÃ SỬA — `anchor` và mọi phần tử `doc_refs` phải
 *       fuzzy-tìm thấy trong `revised`, và change XOÁ THUẦN (có `before`,
 *       không có `quote`) BẮT BUỘC phải có `anchor`. Vì sao đây là lỗi cứng
 *       chứ không phải khuyết điểm cosmetic: một change xoá thuần không có
 *       `quote` nào để neo, nên UI không có toạ độ nào trong bản đã sửa để
 *       hiển thị "chỗ này đã bị xoá chữ" — chỗ xoá biến mất khỏi tài liệu
 *       người đọc nhìn thấy, đúng triệu chứng đo được trên run thật.
 *
 *       `anchor`/`doc_refs` CHỈ là neo định vị và TUYỆT ĐỐI không tham gia
 *       phép phủ ở (b) (xem isCoveredByField bên dưới — nó chỉ đọc
 *       `quote`/`before`). Cho chúng phủ dòng thêm/xoá sẽ mở lại đúng cái lỗ
 *       (b) sinh ra để bịt: agent chỉ cần trích một câu lân cận vào `anchor`
 *       là mọi sửa đổi không khai báo quanh đó lọt hết.
 *
 *  `opts.locateIn` (WP8b — validate theo LÁT, không phải theo TRANG): mặc
 *  định `anchor`/`doc_refs` ở mục (c) được tìm trong `revised`, đúng bằng lát
 *  agent vừa sửa. Nhưng WP8b gọi hàm này với `original`/`revised` là LÁT
 *  (baseline đã enrich / lát sau agent) trong khi `anchor`/`doc_refs` của
 *  agent có thể trỏ sang một đoạn khác của TRANG (ngoài lát của section này) —
 *  ví dụ một nhận xét về section 6.1 viện dẫn một câu ở section 6.3. Không có
 *  `locateIn`, validator sẽ báo "anchor không tìm thấy" oan dù agent viện dẫn
 *  đúng, chỉ là đúng ở CHỖ KHÁC trong trang. Truyền `opts.locateIn` = cả
 *  trang đã sửa để mục (c) tìm ở phạm vi rộng hơn; `quote` (vẫn tìm trong
 *  `revised`) và `before` (vẫn tìm trong `original`) — cùng phép phủ (b) trên
 *  cặp (original, revised) — GIỮ NGUYÊN vì chúng đối chiếu đúng những gì agent
 *  sửa TRONG lát này, không phải toàn trang. Không truyền `opts` → hành vi
 *  y hệt trước khi có WP8a (locateIn ngầm định = revised). */
export function validateChanges(
  original: string,
  revised: string,
  changes: DocChange[],
  opts?: { locateIn?: string },
): string[] {
  const errors: string[] = [];
  const locateIn = opts?.locateIn ?? revised;

  for (const change of changes) {
    const quote = (change.quote ?? '').trim();
    const before = (change.before ?? '').trim();
    if (!quote && !before) {
      errors.push(`Change "${change.id}" không có cả 'quote' lẫn 'before' — không có gì để đối chiếu.`);
      continue;
    }
    if (quote && !fuzzyIncludes(revised, quote)) {
      errors.push(`Change "${change.id}" có quote không tìm thấy trong bản đã sửa: "${clipQuote(quote)}"`);
    }
    if (before && !fuzzyIncludes(original, before)) {
      errors.push(`Change "${change.id}" có before không tìm thấy trong bản gốc: "${clipQuote(before)}"`);
    }

    // XOÁ THUẦN phải có neo — không có `quote` thì `anchor` là toạ độ DUY NHẤT
    // để UI đặt chỗ xoá vào đúng vị trí trong bản đã sửa.
    const anchor = (change.anchor ?? '').trim();
    if (before && !quote && !anchor) {
      errors.push(
        `Change "${change.id}" xoá thuần nhưng thiếu 'anchor' — cần một đoạn nguyên văn trong bản đã sửa nằm cạnh chỗ xoá để định vị.`,
      );
    }
    if (anchor && !fuzzyIncludes(locateIn, anchor)) {
      errors.push(`Change "${change.id}" có anchor không tìm thấy trong bản đã sửa: "${clipQuote(anchor)}"`);
    }

    for (const raw of change.doc_refs ?? []) {
      const ref = (raw ?? '').trim();
      if (!ref) continue;
      if (!fuzzyIncludes(locateIn, ref)) {
        errors.push(`Change "${change.id}" có doc_ref không tìm thấy trong bản đã sửa: "${clipQuote(ref)}"`);
      }
    }
  }

  // Phủ ĐÚNG PHÍA — xem docblock ở trên: `quote` chỉ phủ dòng thêm/đổi (phía
  // revised), `before` chỉ phủ dòng bị xoá (phía original). Không trộn hai
  // trường cho nhau, và KHÔNG đọc `anchor`/`doc_refs`: chúng là neo định vị,
  // cho chúng phủ dòng thêm/xoá là mở lại đúng cái lỗ kiểm tra này bịt.
  const isCoveredByField = (line: string, field: 'quote' | 'before'): boolean =>
    changes.some((c) => {
      const v = (field === 'quote' ? c.quote : c.before)?.trim() ?? '';
      if (!v) return false;
      return fuzzyIncludes(v, line) || fuzzyIncludes(line, v);
    });

  const originalLines = lineMultiset(original);
  const revisedLines = lineMultiset(revised);

  const addedOrChanged: string[] = [];
  for (const [line, count] of revisedLines) {
    const before = originalLines.get(line) ?? 0;
    if (count > before && !isCoveredByField(line, 'quote')) addedOrChanged.push(line);
  }
  for (const line of addedOrChanged) {
    errors.push(`Dòng đã đổi/thêm nhưng không có change.quote nào khai báo: "${clipQuote(line)}"`);
  }

  const deleted: string[] = [];
  for (const [line, count] of originalLines) {
    const after = revisedLines.get(line) ?? 0;
    if (count > after && !isCoveredByField(line, 'before')) deleted.push(line);
  }
  for (const line of deleted) {
    errors.push(`Dòng đã bị xoá nhưng không có change.before nào khai báo: "${clipQuote(line)}"`);
  }

  return errors;
}

/** Parse + validate the SHAPE of a section's `notes.json` (raw file text) —
 *  cùng khuôn với {@link parseChangesFile} ngay trên, cùng lý do: một cast
 *  `as DocNote[]` không kiểm gì lúc chạy, mà `severity` sai sẽ lặng lẽ làm
 *  hỏng số đếm trong summary.md. Trả `{ notes }` khi đạt, `{ errors }` (tiếng
 *  Việt, mỗi phần tử sai một dòng, nêu chỉ số và tên trường) khi hỏng — phía
 *  gọi (server.ts) coi `errors` là TRANG hỏng, y như validateChanges hỏng. */
export function parseNotesFile(raw: string): { notes: DocNote[] } | { errors: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { errors: [`notes.json không phải JSON hợp lệ: ${error instanceof Error ? error.message : String(error)}`] };
  }
  if (!Array.isArray(parsed)) {
    return { errors: ['notes.json không phải một mảng.'] };
  }

  const errors: string[] = [];
  const notes: DocNote[] = [];
  parsed.forEach((rawItem, i) => {
    if (typeof rawItem !== 'object' || rawItem === null || Array.isArray(rawItem)) {
      errors.push(`Phần tử thứ ${i} không phải một object.`);
      return;
    }
    const item = rawItem as Record<string, unknown>;
    for (const field of ['id', 'anchor', 'finding', 'suggestion'] as const) {
      const value = item[field];
      if (typeof value !== 'string' || value.trim() === '') {
        errors.push(`Phần tử thứ ${i}: '${field}' phải là chuỗi không rỗng, nhận được ${JSON.stringify(value)}.`);
      }
    }
    if (!DOC_CHANGE_KINDS.includes(item.kind as DocChangeKind)) {
      errors.push(
        `Phần tử thứ ${i}: 'kind' phải là một trong (${DOC_CHANGE_KINDS.join(', ')}), nhận được ${JSON.stringify(item.kind)}.`,
      );
    }
    if (!DOC_CHANGE_SEVERITIES.includes(item.severity as DocChangeSeverity)) {
      errors.push(
        `Phần tử thứ ${i}: 'severity' phải là một trong (${DOC_CHANGE_SEVERITIES.join(', ')}), nhận được ${JSON.stringify(item.severity)}.`,
      );
    }
    if (item.rule_id !== undefined && typeof item.rule_id !== 'string') {
      errors.push(`Phần tử thứ ${i}: 'rule_id' phải là chuỗi khi có mặt, nhận được ${JSON.stringify(item.rule_id)}.`);
    }
    errors.push(...docRefsShapeErrors(item.doc_refs, i));
    notes.push(item as unknown as DocNote);
  });

  if (errors.length > 0) return { errors };
  return { notes };
}

/** Đối chiếu notes của một trang với bản GỐC. Trả mảng lỗi tiếng Việt — rỗng
 *  là đạt.
 *
 *  CỐ Ý chỉ kiểm đúng MỘT thứ: `anchor` phải fuzzy-tìm thấy trong `original`
 *  (dùng lại fuzzyIncludes của validateChanges nên chịu được khác biệt khoảng
 *  trắng/xuống dòng). KHÔNG chạy line-multiset như validateChanges: note theo
 *  định nghĩa KHÔNG sửa gì trong tài liệu, nên không có "dòng thêm/xoá" nào để
 *  quy trách nhiệm. Bắt note phải phủ dòng đổi sẽ đúng bằng việc ép agent quay
 *  lại thói quen chèn chú giải vào bản clone — thứ đang bị cấm cứng (xem
 *  findReviewMarkers). anchor sai/không tồn tại vẫn là lỗi vì một nhận xét
 *  không định vị được vào tài liệu thì người đọc không dùng được. */
export function validateNotes(original: string, notes: DocNote[]): string[] {
  const errors: string[] = [];
  for (const note of notes) {
    const anchor = (note.anchor ?? '').trim();
    if (!anchor) {
      errors.push(`Note "${note.id}" không có 'anchor' — không định vị được vào tài liệu.`);
      continue;
    }
    if (!fuzzyIncludes(original, anchor)) {
      errors.push(`Note "${note.id}" có anchor không tìm thấy trong bản gốc: "${clipQuote(anchor)}"`);
    }
    // doc_refs của NOTE đối chiếu với bản GỐC, không phải bản đã sửa: note theo
    // định nghĩa không sửa gì, nên tại mọi đoạn nó viện dẫn hai bản như nhau —
    // và bản gốc là thứ duy nhất validateNotes được cấp.
    for (const raw of note.doc_refs ?? []) {
      const ref = (raw ?? '').trim();
      if (!ref) continue;
      if (!fuzzyIncludes(original, ref)) {
        errors.push(`Note "${note.id}" có doc_ref không tìm thấy trong bản gốc: "${clipQuote(ref)}"`);
      }
    }
  }
  return errors;
}

/** Bản KHOAN DUNG của {@link validateNotes} cho luồng chạy thật: note có
 *  anchor/doc_ref không tìm thấy KHÔNG làm hỏng trang nữa — note theo định
 *  nghĩa không sửa gì trong tài liệu, nên một neo lệch chỉ làm mất chỗ bôi
 *  vàng chứ không làm sai tài liệu; còn fail-shut thì xoá sạch output của
 *  MỌI section (đo thật: 13 section chạy xong bị vứt vì 2 note neo trượt).
 *  Note trượt được giữ lại, gắn `anchor_unresolved: true`, doc_ref trượt bị
 *  bỏ khỏi note; mỗi trường hợp thành một dòng cảnh báo (tiếng Việt) để ghi
 *  vào summary. Note KHÔNG có anchor vẫn là lỗi cứng — không có gì để đọc. */
export function partitionNotesByAnchor(
  original: string,
  notes: DocNote[],
): { notes: DocNote[]; warnings: string[]; errors: string[] } {
  const warnings: string[] = [];
  const errors: string[] = [];
  const out: DocNote[] = [];
  for (const note of notes) {
    const anchor = (note.anchor ?? '').trim();
    if (!anchor) {
      errors.push(`Note "${note.id}" không có 'anchor' — không định vị được vào tài liệu.`);
      continue;
    }
    let next: DocNote = note;
    if (!fuzzyIncludes(original, anchor)) {
      warnings.push(`Note "${note.id}" có anchor không tìm thấy trong bản gốc — giữ lại nhưng không bôi được vào tài liệu: "${clipQuote(anchor)}"`);
      next = { ...next, anchor_unresolved: true };
    }
    if (note.doc_refs && note.doc_refs.length > 0) {
      const kept: string[] = [];
      for (const raw of note.doc_refs) {
        const ref = (raw ?? '').trim();
        if (!ref) continue;
        if (fuzzyIncludes(original, ref)) kept.push(raw);
        else warnings.push(`Note "${note.id}" có doc_ref không tìm thấy trong bản gốc — đã bỏ tham chiếu: "${clipQuote(ref)}"`);
      }
      if (kept.length !== note.doc_refs.length) {
        const { doc_refs: _drop, ...rest } = next;
        next = kept.length > 0 ? { ...rest, doc_refs: kept } : rest;
      }
    }
    out.push(next);
  }
  return { notes: out, warnings, errors };
}

/** Gộp note TRÙNG NHAU ở cấp TRANG — daemon tự dedupe TẤT ĐỊNH (không LLM),
 *  vì skill (Bước 1 nhóm 5, `skills/docs-spec-review/SKILL.md`) chỉ gộp được
 *  trong phạm vi MỘT section; hai section khác nhau của cùng trang review
 *  cùng một element/nhóm element (comp/<KEY>.screen.json không thuộc riêng
 *  section nào) vẫn có thể ra hai note giống hệt nhau.
 *
 *  Bằng chứng cần hàm này (dự án dich-vu-mua-sim, run thật): 44/57 note của
 *  một trang là note `component` TRÙNG NHAU, trong đó 8 note giống hệt từng
 *  chữ "Dùng Text Field State=Default" — vì trước đây quy tắc là "một note
 *  mỗi element" nên nhiều element cùng thiếu cùng một component sinh ra nhiều
 *  bản sao của cùng một nhận xét.
 *
 *  Hai note được coi là TRÙNG khi cùng bộ bốn `(kind, rule_id ?? '',
 *  finding.trim(), suggestion.trim())` — `rule_id` thiếu (`undefined`) và
 *  `rule_id` rỗng (`''`) coi là NHƯ NHAU (cùng chuẩn hoá về `''`) vì cả hai
 *  đều nghĩa là "không trace vào rule nào", không phải hai giá trị khác nhau.
 *  Giữ note ĐẦU TIÊN của mỗi nhóm trùng (anchor/doc_refs của nó — note đầu
 *  luôn ở vị trí sớm nhất trong tài liệu nên là lựa chọn ổn định), bỏ các bản
 *  sau. Trả về `droppedCount` để caller (server.ts) ghi cảnh báo "Đã gộp N
 *  note trùng lặp." vào summary — không âm thầm bớt số. */
export function dedupeNotes(notes: DocNote[]): { notes: DocNote[]; droppedCount: number } {
  const seen = new Set<string>();
  const out: DocNote[] = [];
  let droppedCount = 0;
  for (const note of notes) {
    const key = JSON.stringify([note.kind, note.rule_id ?? '', note.finding.trim(), note.suggestion.trim()]);
    if (seen.has(key)) {
      droppedCount += 1;
      continue;
    }
    seen.add(key);
    out.push(note);
  }
  return { notes: out, droppedCount };
}

/** Chuỗi chú giải BỊ CẤM trong bản clone. Xem {@link findReviewMarkers}. */
export const REVIEW_MARKER_RE = /\[\s*Rà soát/i;

/** Trả về mọi dòng (đã trim) trong bản ĐÃ SỬA có chứa chú giải "[Rà soát …]".
 *  Mảng rỗng = đạt.
 *
 *  Vì sao đây là LỖI CỨNG làm hỏng cả trang, không phải cảnh báo: đo trên một
 *  run thật, 3/8 change là agent chèn "[Rà soát — …]" vào GIỮA MỘT Ô BẢNG
 *  markdown chỉ để có chỗ gắn `quote` cho một nhận xét vốn không sửa được bằng
 *  chữ. Việc đó vừa làm vỡ bảng của tài liệu người dùng, vừa biến bản review
 *  thành thứ không dùng lại được. Giờ đã có notes.json làm đường ra hợp lệ cho
 *  đúng loại phát hiện đó, nên nếu không cấm cứng thì agent vẫn tiếp tục lách
 *  theo đường cũ. */
export function findReviewMarkers(revised: string): string[] {
  const out: string[] = [];
  for (const raw of revised.split(/\r?\n/)) {
    if (REVIEW_MARKER_RE.test(raw)) out.push(raw.trim());
  }
  return out;
}

/** Thu tập hợp anchor rule HỢP LỆ từ các file `criteria/*.md`.
 *
 *  Quy ước trích: với mỗi dòng heading (`#`…`######`), mọi token nằm trong dấu
 *  backtick là một anchor; dấu `#` đứng đầu token bị bỏ. Khoá sinh ra có dạng
 *  `criteria/<name>#<anchor>` — đúng dạng agent phải ghi vào `rule_id`.
 *  Thực tế repo: rules.md có "## `R-OVERLAY` Khi nào dùng…" →
 *  `criteria/rules.md#R-OVERLAY`; components.md có "### `#button` Button" →
 *  `criteria/components.md#button`. */
export function collectCriteriaAnchors(files: Array<{ name: string; text: string }>): Set<string> {
  const out = new Set<string>();
  for (const file of files) {
    for (const line of file.text.split(/\r?\n/)) {
      if (!HEADING_RE.test(line)) continue;
      const tokenRe = /`([^`]+)`/g;
      for (let m = tokenRe.exec(line); m; m = tokenRe.exec(line)) {
        const anchor = (m[1] ?? '').trim().replace(/^#/, '');
        if (anchor) out.add(`criteria/${file.name}#${anchor}`);
      }
    }
  }
  return out;
}

/** Kiểm `rule_id` của mọi change/note của một trang. Trả mảng lỗi tiếng Việt.
 *
 *  Chỉ kiểm được ba thứ bằng máy, và cố ý dừng ở đó:
 *   (a) CÚ PHÁP — rule_id phải là một anchor CÓ THẬT trong `criteria/`. Đo
 *       trên run thật: agent gán `criteria/rules.md#R-WCAG` (rule tương phản
 *       màu / AA) cho một vấn đề thuật ngữ, và `criteria/components.md#empty-state`
 *       trong khi components.md không hề có mục đó. rule_id bịa làm cả cơ chế
 *       trace mất giá trị.
 *   (b) MỘT luật ngữ nghĩa duy nhất máy quyết được: components.md là DANH MỤC
 *       component hợp lệ, không phải bộ rule — nên nó chỉ được làm rule_id cho
 *       `kind: 'component'`.
 *   (c) BỘ MẶC ĐỊNH — rule_id mở đầu bằng `default#` phải thuộc
 *       {@link DEFAULT_RULE_IDS}. Kiểm tra này chạy CẢ KHI `anchors` rỗng, vì
 *       bộ mặc định nằm trong SKILL.md chứ không nằm trong `criteria/` — nó
 *       hoàn toàn không phụ thuộc việc dự án có upload criteria hay không.
 *  Sai ngữ nghĩa sâu hơn (rule tồn tại nhưng không liên quan tới phát hiện)
 *  không kiểm bằng máy được; luật đó nằm trong SKILL.md.
 *
 *  `anchors` rỗng nghĩa là dự án không có `criteria/` — mọi rule_id dạng
 *  `criteria/…` được bỏ qua hoàn toàn, không có gì để đối chiếu thì không được
 *  đánh hỏng trang. CHỈ nhóm (a)+(b) hưởng ngoại lệ đó, KHÔNG phải (c).
 *
 *  (d) NGUỒN KẾT QUẢ NỘI BỘ — rule_id mở đầu bằng `flows/` hoặc `comp/` không
 *      trỏ vào `criteria/` mà trỏ vào một file kết quả daemon tự dựng (sơ đồ
 *      luồng, bảng thành phần — xem WP2): KHÔNG đối chiếu với `anchors` dù
 *      dự án có `criteria/` hay không. Vẫn kiểm được hai thứ bằng máy:
 *        - kind đúng chỗ — `flows/…` chỉ hợp lệ cho kind `flow` hoặc
 *          `flow-diagram`; `comp/…` chỉ hợp lệ cho kind `component` (cùng tinh
 *          thần với luật `criteria/components.md#…` ở (b) trên).
 *        - tồn tại thật — nếu gọi kèm `internalRefs` (tập rule_id có file thật
 *          trên đĩa) thì rule_id phải nằm trong tập đó; không truyền
 *          `internalRefs` thì bỏ qua kiểm tra tồn tại (giữ hàm này pure, không
 *          tự đọc đĩa). */
export function validateRuleIds(
  entries: Array<{ id: string; kind: DocChangeKind; rule_id?: string }>,
  anchors: Set<string>,
  internalRefs?: Set<string>,
): string[] {
  const errors: string[] = [];

  // (c) trước early-return: bộ mặc định không đọc `criteria/` nên không được
  // hưởng ngoại lệ "thiếu criteria/ thì bỏ qua" bên dưới.
  for (const entry of entries) {
    const ruleId = (entry.rule_id ?? '').trim();
    if (!ruleId.startsWith('default#')) continue;
    if (!DEFAULT_RULE_IDS.has(ruleId)) {
      errors.push(
        `"${entry.id}" có rule_id mặc định không tồn tại: "${ruleId}" — bộ hợp lệ: ${[...DEFAULT_RULE_IDS].join(', ')}.`,
      );
    }
  }

  // (d) cũng trước early-return: nguồn kết quả nội bộ không đọc `criteria/`
  // nên không phụ thuộc dự án có `criteria/` hay không, giống (c).
  for (const entry of entries) {
    const ruleId = (entry.rule_id ?? '').trim();
    const isFlowsRef = ruleId.startsWith('flows/');
    const isCompRef = ruleId.startsWith('comp/');
    if (!isFlowsRef && !isCompRef) continue;

    if (isFlowsRef && entry.kind !== 'flow' && entry.kind !== 'flow-diagram') {
      errors.push(
        `"${entry.id}" dùng rule_id "${ruleId}" cho kind "${entry.kind}": rule_id "flows/…" là nguồn kết quả nội bộ, chỉ được làm rule_id cho kind 'flow' hoặc 'flow-diagram'.`,
      );
    }
    if (isCompRef && entry.kind !== 'component') {
      errors.push(
        `"${entry.id}" dùng rule_id "${ruleId}" cho kind "${entry.kind}": rule_id "comp/…" là nguồn kết quả nội bộ, chỉ được làm rule_id cho kind 'component'.`,
      );
    }
    if (internalRefs && !internalRefs.has(ruleId)) {
      errors.push(`"${entry.id}" có rule_id không tồn tại trong nguồn kết quả nội bộ: "${ruleId}"`);
    }
  }

  if (anchors.size === 0) return errors;

  for (const entry of entries) {
    const ruleId = (entry.rule_id ?? '').trim();
    if (!ruleId) continue; // dùng bộ tiêu chí mặc định của skill — hợp lệ
    if (ruleId.startsWith('default#')) continue; // đã kiểm ở (c) ngay trên
    if (ruleId.startsWith('flows/') || ruleId.startsWith('comp/')) continue; // đã kiểm ở (d) ngay trên
    if (!anchors.has(ruleId)) {
      errors.push(`"${entry.id}" có rule_id không tồn tại trong criteria/: "${ruleId}"`);
      continue;
    }
    if (ruleId.startsWith('criteria/components.md#') && entry.kind !== 'component') {
      errors.push(
        `"${entry.id}" dùng rule_id "${ruleId}" cho kind "${entry.kind}": components.md là DANH MỤC component hợp lệ, không phải bộ rule — chỉ được làm rule_id cho kind 'component'.`,
      );
    }
  }
  return errors;
}

export interface DocPageResult {
  slug: string;
  page: string;
  docPath: string;
  reviewPath: string;
  changes: DocChange[];
  /** Nhận xét không sửa trực tiếp — đường ra thứ hai bên cạnh `changes`. */
  notes: DocNote[];
  status: 'succeeded' | 'failed';
  errors?: string[];
  /** Trang vẫn đạt nhưng có chỗ daemon phải châm chước (note neo trượt…). */
  warnings?: string[];
  /** Tổng số section của trang — CHỈ có mặt khi trang chạy fail-shut theo
   *  SECTION (WP8b): một section hỏng thì daemon khôi phục lát về baseline đã
   *  enrich, bỏ changes/notes của section đó, còn TRANG vẫn `succeeded`. Trang
   *  không dùng đường fail-shut theo section (hoặc chưa nâng cấp) thì bỏ
   *  trường này — {@link mergeChangeReports} chỉ ghi `sections_total`/
   *  `sections_failed` vào index.json khi trường này có mặt, để không đổi
   *  shape của những trang cũ. */
  sectionsTotal?: number;
  /** Danh sách section bị fail-shut của trang (đi kèm `sectionsTotal`) — mỗi
   *  phần tử là MỘT section, giữ tối đa các lỗi khiến nó bị khôi phục về
   *  baseline, để {@link mergeChangeReports} in vào summary.md. */
  sectionsFailed?: Array<{ index: number; heading: string; errors: string[] }>;
}

/** Merge per-page results into the index.json manifest + a human summary.md,
 *  in Vietnamese — same shape/spirit as prd-review-fanout's mergePageReports
 *  but keyed by change kind/severity instead of image verdicts. */
export function mergeChangeReports(results: DocPageResult[]): { index: unknown; summaryMd: string } {
  // Sơ đồ luồng do DAEMON tự dựng lại (kind 'flow-diagram', origin 'system') —
  // xem systemChangesPath. DocChange không có trường trạng thái riêng
  // (dismissed/…), nên "còn hiệu lực" ở đây = có mặt trong `r.changes`; không
  // có gì để phân biệt thì đếm tất cả, đúng quy ước "nếu không phân biệt thì
  // đếm tất cả" của spec WP1.
  const diagramsUpdatedFor = (r: DocPageResult): number =>
    r.changes.filter((c) => c.kind === 'flow-diagram' && c.origin === 'system').length;
  // Bảng thành phần agent CHÈN MỚI (rule_id trỏ file kết quả nội bộ comp/…,
  // không phải sửa/xoá một bảng đã có — before rỗng/undefined mới tính là
  // "chèn").
  const compositionTablesFor = (r: DocPageResult): number =>
    r.changes.filter(
      (c) => c.kind === 'component' && (c.rule_id ?? '').startsWith('comp/') && !(c.before ?? '').trim(),
    ).length;

  const pages = results.map((r) => ({
    slug: r.slug,
    page: r.page,
    doc_path: r.docPath,
    review_path: r.reviewPath,
    changes: r.changes.length,
    notes: r.notes.length,
    diagrams_updated: diagramsUpdatedFor(r),
    composition_tables: compositionTablesFor(r),
    status: r.status,
    // CHỈ ghi khi trang dùng đường fail-shut theo SECTION (WP8b) — file
    // index.json của trang chưa nâng cấp giữ nguyên shape cũ, không có 2
    // trường này (xem docblock DocPageResult.sectionsTotal).
    ...(r.sectionsTotal !== undefined
      ? { sections_total: r.sectionsTotal, sections_failed: r.sectionsFailed?.length ?? 0 }
      : {}),
    ...(r.warnings && r.warnings.length > 0 ? { warnings: r.warnings } : {}),
  }));
  const changed_pages = results.filter((r) => r.status === 'succeeded' && r.changes.length > 0).length;
  const changes = results.reduce((n, r) => n + r.changes.length, 0);
  const notes = results.reduce((n, r) => n + r.notes.length, 0);
  const blockers = results.reduce((n, r) => n + r.changes.filter((c) => c.severity === 'blocker').length, 0);
  const majors = results.reduce((n, r) => n + r.changes.filter((c) => c.severity === 'major').length, 0);
  const minors = results.reduce((n, r) => n + r.changes.filter((c) => c.severity === 'minor').length, 0);
  const diagrams_updated = results.reduce((n, r) => n + diagramsUpdatedFor(r), 0);
  const composition_tables = results.reduce((n, r) => n + compositionTablesFor(r), 0);

  const index = {
    schema_version: '1.0',
    kind: 'docs-spec-review-index',
    summary: { pages: results.length, changed_pages, changes, notes, diagrams_updated, composition_tables, blockers, majors, minors },
    pages,
  };

  const kindLabel: Record<DocChangeKind, string> = {
    'ux-writing': 'UX writing',
    flow: 'Luồng',
    gap: 'Thiếu sót',
    'edge-case': 'Trường hợp biên',
    component: 'Component',
    'flow-diagram': 'Sơ đồ luồng',
  };
  const sevLabel: Record<DocChangeSeverity, string> = {
    blocker: 'Nghiêm trọng',
    major: 'Nặng',
    minor: 'Nhẹ',
  };

  let summaryMd = `# Docs → Review tài liệu\n\n`;
  summaryMd += `${results.length} trang · ${changed_pages} trang có chỗ sửa · ${changes} chỗ sửa · ${notes} nhận xét · ${blockers} nghiêm trọng · ${majors} nặng · ${minors} nhẹ\n`;
  summaryMd += `Sơ đồ đã thay: ${diagrams_updated} · Bảng thành phần đã chèn: ${composition_tables}\n\n`;

  const failed = results.filter((r) => r.status === 'failed');
  if (failed.length > 0) {
    summaryMd += `## Trang chạy hỏng\n\n`;
    for (const r of failed) {
      const reasons = r.errors && r.errors.length > 0 ? r.errors.join('; ') : 'không rõ lý do';
      summaryMd += `- **${r.page}** (\`${r.docPath}\`): ${reasons}\n`;
    }
    summaryMd += `\n`;
  }

  const warned = results.filter((r) => r.status === 'succeeded' && r.warnings && r.warnings.length > 0);
  if (warned.length > 0) {
    summaryMd += `## Cảnh báo (trang vẫn đạt)\n\n`;
    for (const r of warned) {
      for (const w of r.warnings ?? []) summaryMd += `- **${r.page}**: ${w}\n`;
    }
    summaryMd += `\n`;
  }

  // Section fail-shut (WP8b): trang vẫn `succeeded` (nội dung của mọi section
  // đạt được giữ nguyên) nhưng một vài section bị khôi phục về baseline đã
  // enrich — liệt kê từng section hỏng kèm tối đa 3 lỗi để người đọc tự đối
  // chiếu, không phải lần theo log chạy.
  const sectionsFailedPages = results.filter((r) => r.sectionsFailed && r.sectionsFailed.length > 0);
  if (sectionsFailedPages.length > 0) {
    summaryMd += `## Section không đạt (đã giữ nguyên nội dung gốc đã enrich)\n\n`;
    for (const r of sectionsFailedPages) {
      for (const f of r.sectionsFailed ?? []) {
        const nn = String(f.index).padStart(2, '0');
        const heading = f.heading.trim() || 'Mở đầu';
        // Cap mỗi lỗi ở 240 ký tự (ranh giới từ) TRƯỚC khi join — một dòng lỗi
        // dump nguyên hàng bảng markdown ~1.500 ký tự từng biến mục này thành
        // một khối khó đọc thay vì danh sách lỗi (xem clipQuote ở trên cho lý
        // do chung; ở đây riêng vì lỗi cấp section có thể dài hơn 80 ký tự).
        const errs = f.errors.slice(0, 3).map((e) => truncateAtWordBoundary(e, 240)).join('; ');
        summaryMd += `- **${r.page}** · s${nn} "${heading}": ${errs}\n`;
      }
    }
    summaryMd += `\n`;
  }

  summaryMd += `## Từng trang\n\n`;
  summaryMd += `| Trang | Trạng thái | Số chỗ sửa | Nhận xét | Theo nhóm | NT | Nặng | Nhẹ |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n`;
  for (const r of results) {
    const byKind = (Object.keys(kindLabel) as DocChangeKind[])
      .map((k) => ({ k, n: r.changes.filter((c) => c.kind === k).length }))
      .filter((x) => x.n > 0)
      .map((x) => `${kindLabel[x.k]}: ${x.n}`)
      .join(', ');
    const b = r.changes.filter((c) => c.severity === 'blocker').length;
    const m = r.changes.filter((c) => c.severity === 'major').length;
    const mi = r.changes.filter((c) => c.severity === 'minor').length;
    let statusLabel: string;
    if (r.status === 'succeeded' && r.sectionsTotal !== undefined && r.sectionsFailed && r.sectionsFailed.length > 0) {
      const ok = r.sectionsTotal - r.sectionsFailed.length;
      statusLabel = `Đã sửa (${ok}/${r.sectionsTotal} section)`;
    } else {
      statusLabel = r.status === 'succeeded' ? 'Đã sửa' : 'Chạy hỏng';
    }
    summaryMd += `| ${r.page} | ${statusLabel} | ${r.changes.length} | ${r.notes.length} | ${byKind || '—'} | ${b} | ${m} | ${mi} |\n`;
  }

  // Nhận xét in ĐỦ nội dung ngay trong summary.md — chủ ý, không phải thừa:
  // người đọc bản review mở đúng một file này là hiểu hết, không phải lần theo
  // từng `<clone>.notes.json`. Đây cũng là nhóm phát hiện trước nay rơi về 0.
  const withNotes = results.filter((r) => r.notes.length > 0);
  if (withNotes.length > 0) {
    summaryMd += `\n## Nhận xét (không sửa trực tiếp)\n\n`;
    for (const r of withNotes) {
      summaryMd += `### ${r.page}\n\n`;
      for (const n of r.notes) {
        const rule = n.rule_id ? ` · \`${n.rule_id}\`` : '';
        summaryMd += `- **${kindLabel[n.kind] ?? n.kind}** · ${sevLabel[n.severity] ?? n.severity}${rule}\n`;
        summaryMd += `  - Neo: "${n.anchor}"${n.anchor_unresolved ? ' _(không tìm thấy trong bản gốc — không bôi được)_' : ''}\n`;
        summaryMd += `  - Phát hiện: ${n.finding}\n`;
        summaryMd += `  - Đề xuất: ${n.suggestion}\n`;
      }
      summaryMd += `\n`;
    }
  }

  return { index, summaryMd };
}
