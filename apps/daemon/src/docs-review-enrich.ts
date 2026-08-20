/** Docs → Review tài liệu — phần "enrich" tất định (WP2 của dr-review).
 *
 *  Toàn bộ file này THUẦN (pure): không đọc/ghi đĩa. server.ts (khối dr-review)
 *  là nơi duy nhất gọi các hàm ở đây với dữ liệu đã đọc sẵn từ `flows/`,
 *  `comp/`, `criteria/components.md` — xem docblock ở đầu mỗi hàm cho input
 *  thật (shape lấy từ `flow-ux/index.ts` và `screen-components.ts`, vốn đã
 *  ghi các file này ở bước dr-flow/dr-comp).
 *
 *  Vì sao tách riêng khỏi docs-review.ts: hai việc ("cắt lát trang" và "đối
 *  chiếu kết quả flows/comp rồi soạn kickoff bổ sung") không chia sẻ state —
 *  gộp chung sẽ chỉ làm file 1176 dòng kia dài thêm mà không có lợi gì.
 *
 *  Bối cảnh Phương án B (xem `skills/docs-spec-review/SKILL.md`): `validateChanges`
 *  (docs-review.ts) đòi `before` phải có nguyên văn trong bản GỐC — agent
 *  không thể "sửa" một bảng do daemon chèn sau (nó không tồn tại ở bản gốc).
 *  Vì vậy daemon TỰ CHÈN cả hai loại kết quả tất định vào lát cắt TRƯỚC khi
 *  agent chạy, mỗi loại khai một DocChange `origin: 'system'`:
 *   - Sơ đồ mermaid: daemon TỰ THAY thân fence + caption (xem
 *     {@link replaceDiagramInSlice}).
 *   - Bảng "Cấu thành màn hình": daemon TỰ CHÈN bảng ngay sau mockup của màn
 *     (KHÔNG còn thư mục nháp `review/_composition/` — xem {@link
 *     insertCompositionTable}). Agent chỉ được sửa TẠI CHỖ hai cột "Vai trò /
 *     dùng để" và "Ghi chú" của bảng đó, KHÔNG khai change cho việc sửa ô:
 *     daemon tự đối soát bảng agent sửa so với bảng nháp (xem {@link
 *     reconcileCompositionTable}, {@link parseCompositionBlock}) rồi cập nhật
 *     `quote` của system change thành bảng cuối cùng, và dùng {@link
 *     isCompositionOwnedChange} để bỏ mọi change agent lỡ tự khai cho việc
 *     sửa ô đó. {@link findToolOutputNoise} phát hiện rác output-của-tool
 *     agent lỡ dán vào lát (Codex/PowerShell). Việc nối các hàm này vào
 *     server.ts (fail-shut theo SECTION) là WP8b — file này chỉ cung cấp hàm
 *     thuần.
 */

import type { DocChange, DocChangeKind, DocChangeSeverity, DocSection } from './docs-review.js';
import { splitScreenKey, type RoleMapDoc, type ScreenComponentsDoc } from './screen-components.js';

/* ── 1. Sơ đồ mermaid ────────────────────────────────────────────────────── */

/** Chuẩn hoá thân một fence mermaid trước khi so khớp: CRLF→LF, bỏ khoảng
 *  trắng cuối mỗi dòng, trim hai đầu. KHÔNG động tới khoảng trắng ĐẦU dòng —
 *  thụt lề của sơ đồ mermaid có ý nghĩa với người đọc/công cụ render. */
function normalizeMermaidBody(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .trim();
}

const OPEN_FENCE_RE = /^\s*```mermaid\s*$/;
const CLOSE_FENCE_RE = /^\s*```\s*$/;

/** Tìm fence ```mermaid trong `sliceText` có thân KHỚP `asIsMmd` (sau
 *  {@link normalizeMermaidBody}). `sliceText` có thể chứa nhiều fence mermaid
 *  (nhiều sơ đồ khác nhau trong cùng một section) — hàm quét từng fence tới
 *  khi tìm đúng cái có thân khớp, bỏ qua những cái không khớp thay vì dừng ở
 *  fence đầu tiên.
 *
 *  Trả `{ start, end }` — chỉ số DÒNG 0-based trong `sliceText.split(/\r?\n/)`;
 *  `start` là dòng `` ```mermaid ``, `end` là dòng `` ``` `` đóng (bao gồm).
 *  Không tìm thấy fence nào khớp → `null`. */
export function findMermaidFence(sliceText: string, asIsMmd: string): { start: number; end: number } | null {
  const lines = sliceText.split(/\r?\n/);
  const wantBody = normalizeMermaidBody(asIsMmd);
  let i = 0;
  while (i < lines.length) {
    if (!OPEN_FENCE_RE.test(lines[i] ?? '')) {
      i += 1;
      continue;
    }
    let j = i + 1;
    while (j < lines.length && !CLOSE_FENCE_RE.test(lines[j] ?? '')) j += 1;
    if (j >= lines.length) return null; // fence mở nhưng không đóng — coi như không có fence hợp lệ
    const body = lines.slice(i + 1, j).join('\n');
    if (normalizeMermaidBody(body) === wantBody) return { start: i, end: j };
    i = j + 1;
  }
  return null;
}

const CAPTION_RE = /^\*flow-diagram — sơ đồ Mermaid "([^"]*)"; nguồn: (.+)\*$/;

/** Thay thân fence mermaid (bằng `proposedMmd`) và caption `*flow-diagram —
 *  …*` ngay dưới nó (nếu có) bằng caption "đã thay" — xem docblock đầu file
 *  cho lý do đây là DocChange `origin: 'system'` chứ không phải agent.
 *
 *  Trả `null` khi không tìm thấy fence khớp `opts.asIsMmd` trong `sliceText`
 *  (xem {@link findMermaidFence}) — gọi phía server.ts hiểu đây là "section
 *  này không chứa sơ đồ", không phải lỗi. */
export function replaceDiagramInSlice(
  sliceText: string,
  opts: {
    asIsMmd: string;
    proposedMmd: string;
    flowId: string;
    uxReview: { verdict?: string; summary?: string };
    /** Ghi đè phần "nguồn gốc" trong caption mới thay vì lấy lại từ caption
     *  cũ đã đọc được — dùng khi caller muốn kiểm soát chuỗi hiển thị (vd
     *  test) thay vì phụ thuộc regex parse caption cũ. */
    sourceLink?: string;
  },
): { text: string; change: DocChange } | null {
  const found = findMermaidFence(sliceText, opts.asIsMmd);
  if (!found) return null;
  const { start, end } = found;
  const eol = sliceText.includes('\r\n') ? '\r\n' : '\n';
  const lines = sliceText.split(/\r?\n/);

  // Caption nằm ngay dưới fence, bỏ qua các dòng trống xen giữa.
  let blankBetween = 0;
  let capIdx = end + 1;
  while (capIdx < lines.length && (lines[capIdx] ?? '').trim() === '') {
    capIdx += 1;
    blankBetween += 1;
  }
  const capMatch = capIdx < lines.length ? CAPTION_RE.exec((lines[capIdx] ?? '').trim()) : null;
  const oldEnd = capMatch ? capIdx : end;
  const beforeBlock = lines.slice(start, oldEnd + 1).join(eol);

  const proposedBody = opts.proposedMmd.replace(/\r\n/g, '\n').replace(/\n+$/, '');
  const newBlockLines: string[] = ['```mermaid', ...proposedBody.split('\n'), '```'];
  if (capMatch) {
    const nguonCu = opts.sourceLink ?? capMatch[2];
    for (let k = 0; k < blankBetween; k += 1) newBlockLines.push('');
    newBlockLines.push(
      `*flow-diagram — sơ đồ ĐỀ XUẤT sau rà soát UX (nguồn gốc: ${nguonCu}; đề xuất: flows/${opts.flowId}/proposed.mmd)*`,
    );
  }
  const quoteBlock = newBlockLines.join(eol);

  const newLines = [...lines.slice(0, start), ...newBlockLines, ...lines.slice(oldEnd + 1)];
  const text = newLines.join(eol);

  const verdict = opts.uxReview.verdict;
  const severity: DocChangeSeverity = verdict === 'needs-improvement' || verdict === 'fail' ? 'major' : 'minor';
  const reason = (opts.uxReview.summary ?? '').trim().slice(0, 160) || 'Thay sơ đồ luồng bằng bản đề xuất sau rà soát UX.';

  const change: DocChange = {
    id: `sys-flow-diagram-${opts.flowId}`,
    kind: 'flow-diagram',
    severity,
    rule_id: `flows/${opts.flowId}/ux-review.json`,
    origin: 'system',
    before: beforeBlock,
    quote: quoteBlock,
    reason,
  };
  return { text, change };
}

/* ── 2. Ánh xạ màn → section ─────────────────────────────────────────────── */

const HEADING_LINE_RE = /^#{1,6}\s/;
/** Dòng mở/đóng fenced code block (``` hoặc ~~~, ≥3 ký tự, cho phép thụt lề)
 *  — dùng để loại heading/dòng thường "giả" nằm trong ví dụ code khỏi
 *  {@link mapScreensToSections}. Đơn giản hoá so với {@link
 *  import('./docs-review.js').splitSections}: chỉ toggle theo SỐ LẦN gặp
 *  dòng fence, không đòi khớp marker mở/đóng (```/~~~) — đủ cho mục đích ở
 *  đây (loại dòng giả), không cần chẻ section chính xác như splitSections. */
const FENCE_LINE_RE = /^\s*(`{3,}|~{3,})/;

/** Bỏ tiền tố markdown (`#…`, `*…`, khoảng trắng) khỏi một dòng trước khi so
 *  khớp mã màn — xem {@link mapScreensToSections}. */
function stripLeadingDecoration(line: string): string {
  return line.replace(/^#{1,6}\s*/, '').replace(/^[\s*]+/, '').trim();
}

/** `text` bắt đầu bằng `code`, theo sau là `.`/khoảng trắng/hết chuỗi — CHẶN
 *  khớp nhầm số dài hơn (`6.1.1` không được khớp `6.1.10`). */
function startsWithCodeBoundary(text: string, code: string): boolean {
  if (!text.startsWith(code)) return false;
  const rest = text.slice(code.length);
  return rest === '' || /^[.\s]/.test(rest);
}

/** `code` xuất hiện trong `text` như một TOKEN (không phải phần của một số
 *  dài hơn) — dùng cho bậc ưu tiên cuối (iii), "heading chứa code ở giữa". */
function containsCodeToken(text: string, code: string): boolean {
  const escaped = code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|[^0-9.])${escaped}(?![0-9])`);
  return re.test(text);
}

const IMAGE_CLUSTER_LINE_RE = /^(!\[[^\]]*\]\([^)]+\))+$/;
const TABLE_ROW_LINE_RE = /^\|.*\|$/;

/** `line` (đã trim) là một hàng bảng markdown (`|…|`) — bao gồm cả hàng
 *  header/separator, không chỉ hàng dữ liệu. */
function isTableRowLine(line: string): boolean {
  return TABLE_ROW_LINE_RE.test(line);
}

/** dòng cuối (1-based) của "cụm mockup" liền ngay sau `matchedLine1` (bỏ qua
 *  dòng trống xen giữa các phần tử của cụm) — hoặc chính `matchedLine1` nếu
 *  không có gì để gom. Một phần tử của cụm là:
 *   (a) một dòng ảnh `![…](…)` (một hoặc nhiều ảnh liền nhau trên cùng dòng); hoặc
 *   (b) TRỌN một bảng markdown (các dòng `|…|` liên tiếp, không có dòng trống
 *       xen giữa các hàng — đúng cú pháp GFM) mà ÍT NHẤT một hàng của bảng đó
 *       chứa `![` (tức bảng mockup — nuốt cả hàng header/separator không ảnh).
 *  Một bảng KHÔNG có hàng nào chứa `![` (bảng field) làm cụm DỪNG NGAY TRƯỚC
 *  bảng đó — không nuốt một phần nào của nó, kể cả khi cụm đã gom được ảnh/
 *  bảng mockup trước đó. */
function computeInsertAfterLine(pageLines: string[], matchedLine1: number): number {
  const n = pageLines.length;
  let lastIncludedIdx0 = matchedLine1 - 1; // 0-based index của dòng cuối cụm đã gom — khởi tạo = chính matchedLine1 (chưa gom gì)
  let cursor = matchedLine1; // 0-based index của dòng kế tiếp cần xét (ngay sau matchedLine1, 1-based)

  for (;;) {
    let j = cursor;
    while (j < n && (pageLines[j] ?? '').trim() === '') j += 1;
    if (j >= n) break;
    const line = (pageLines[j] ?? '').trim();

    if (IMAGE_CLUSTER_LINE_RE.test(line)) {
      lastIncludedIdx0 = j;
      cursor = j + 1;
      continue;
    }

    if (isTableRowLine(line)) {
      let end = j;
      let hasImage = line.includes('![');
      while (end + 1 < n && isTableRowLine((pageLines[end + 1] ?? '').trim())) {
        end += 1;
        if ((pageLines[end] ?? '').includes('![')) hasImage = true;
      }
      if (!hasImage) break; // bảng field — dừng cụm trước bảng này, không nuốt
      lastIncludedIdx0 = end;
      cursor = end + 1;
      continue;
    }

    break;
  }

  return lastIncludedIdx0 + 1; // 0-based → 1-based
}

/** Ánh xạ mỗi SCREEN-KEY (`comp/index.json[].key`, dạng `<page>__<mã>`) vào
 *  section (kết quả {@link import('./docs-review.js').splitSections}) mô tả
 *  màn đó trong trang, cộng dòng (1-based, tuyệt đối trong trang) để chèn
 *  bảng "Cấu thành màn hình" ngay sau.
 *
 *  Ba bậc định vị, DỪNG Ở BẬC ĐẦU TIÊN khớp cho từng key (xem spec — trang
 *  mẫu có heading `#### 6.3.2. … (mô tả tương tự … 6.2.3. …)` chứa cả mã màn
 *  6.2.3 ở giữa, nên phải ưu tiên khớp-đầu-dòng trước khớp-chứa-ở-giữa, nếu
 *  không 6.2.3 sẽ bị gắn nhầm vào section của 6.3.2):
 *   (i)   heading mà phần chữ (sau khi bỏ `#`/`*`/khoảng trắng) BẮT ĐẦU bằng
 *         mã màn (ranh giới `.`/khoảng trắng/hết dòng);
 *   (ii)  dòng THƯỜNG (không phải heading) bắt đầu bằng mã màn — trang mẫu có
 *         mục "6.2.3. Màn hình Chi tiết gói cước" không phải heading;
 *   (iii) heading chứa mã màn như một TOKEN ở giữa câu.
 *
 *  Dòng nằm trong fenced code block (``` hoặc ~~~) KHÔNG được xét làm heading
 *  hay dòng thường — một sơ đồ mermaid/ví dụ code trích lại một dòng dạng
 *  `### 6.2.3 …` không được coi là heading thật của mã màn đó. */
export function mapScreensToSections(
  sections: ReadonlyArray<Pick<DocSection, 'index' | 'heading' | 'startLine' | 'endLine'>>,
  pageLines: string[],
  screenKeys: string[],
): { placed: Map<number, Array<{ key: string; code: string; insertAfterLine: number }>>; unplaced: string[] } {
  const placed = new Map<number, Array<{ key: string; code: string; insertAfterLine: number }>>();
  const unplaced: string[] = [];

  const headingLines: Array<{ line1: number; text: string }> = [];
  const plainLines: Array<{ line1: number; text: string }> = [];
  let inFence = false;
  pageLines.forEach((raw, idx0) => {
    const line1 = idx0 + 1;
    const trimmed = raw.trim();
    if (FENCE_LINE_RE.test(trimmed)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    if (HEADING_LINE_RE.test(raw)) {
      headingLines.push({ line1, text: stripLeadingDecoration(raw) });
    } else if (trimmed !== '') {
      plainLines.push({ line1, text: stripLeadingDecoration(raw) });
    }
  });

  for (const key of screenKeys) {
    const split = splitScreenKey(key);
    if (!split) {
      unplaced.push(key);
      continue;
    }
    const { code } = split;

    let matchedLine: number | null = null;
    for (const h of headingLines) {
      if (startsWithCodeBoundary(h.text, code)) {
        matchedLine = h.line1;
        break;
      }
    }
    if (matchedLine == null) {
      for (const p of plainLines) {
        if (startsWithCodeBoundary(p.text, code)) {
          matchedLine = p.line1;
          break;
        }
      }
    }
    if (matchedLine == null) {
      for (const h of headingLines) {
        if (containsCodeToken(h.text, code)) {
          matchedLine = h.line1;
          break;
        }
      }
    }

    if (matchedLine == null) {
      unplaced.push(key);
      continue;
    }
    const sec = sections.find((s) => matchedLine! >= s.startLine && matchedLine! <= s.endLine);
    if (!sec) {
      unplaced.push(key);
      continue;
    }

    const insertAfterLine = computeInsertAfterLine(pageLines, matchedLine);
    const arr = placed.get(sec.index) ?? [];
    arr.push({ key, code, insertAfterLine });
    placed.set(sec.index, arr);
  }

  return { placed, unplaced };
}

/* ── 3. Danh mục component (criteria/components.md) ─────────────────────── */

const CATALOGUE_HEADING_BACKTICK_RE = /^#{1,6}\s*`#([^`]+)`\s*(.*)$/;
const CATALOGUE_HEADING_BRACE_RE = /^#{1,6}\s*(.*?)\s*\{#([^}]+)\}\s*$/;
const CATALOGUE_DESC_RE = /^-?\s*Mô tả:\s*(.*)$/;

/** Đọc `criteria/components.md` thành `anchor` (KHÔNG có dấu `#`, khớp thẳng
 *  `ds.anchor` trong `comp/<KEY>.screen.json`) → `{ name, description }`.
 *  Hỗ trợ hai kiểu heading: `` ### `#figma-xxxx` Tên `` (thật trong repo mẫu)
 *  và `### Tên {#figma-xxxx}`. `description` lấy dòng `- Mô tả:`/`Mô tả:` ĐẦU
 *  TIÊN dưới heading đó — thiếu thì để rỗng, không phải lỗi. */
export function parseCatalogue(componentsMd: string): Map<string, { name: string; description: string }> {
  const map = new Map<string, { name: string; description: string }>();
  const lines = componentsMd.split(/\r?\n/);
  let currentAnchor: string | null = null;
  let descFound = false;

  for (const line of lines) {
    if (HEADING_LINE_RE.test(line)) {
      const backtick = CATALOGUE_HEADING_BACKTICK_RE.exec(line);
      const brace = backtick ? null : CATALOGUE_HEADING_BRACE_RE.exec(line);
      if (backtick) {
        currentAnchor = (backtick[1] ?? '').trim();
        const name = (backtick[2] ?? '').trim();
        if (currentAnchor && !map.has(currentAnchor)) map.set(currentAnchor, { name, description: '' });
      } else if (brace) {
        currentAnchor = (brace[2] ?? '').trim();
        const name = (brace[1] ?? '').trim();
        if (currentAnchor && !map.has(currentAnchor)) map.set(currentAnchor, { name, description: '' });
      } else {
        currentAnchor = null;
      }
      descFound = false;
      continue;
    }
    if (currentAnchor && !descFound) {
      const m = CATALOGUE_DESC_RE.exec(line.trim());
      if (m) {
        descFound = true;
        const entry = map.get(currentAnchor);
        if (entry) entry.description = (m[1] ?? '').trim();
      }
    }
  }

  return map;
}

/* ── 4. Nháp bảng "Cấu thành màn hình" ───────────────────────────────────── */

/** Tiền tố dòng tiêu đề đậm của bảng "Cấu thành màn hình" — dùng chung giữa
 *  {@link renderCompositionDraft} (sinh) và {@link parseCompositionBlock}
 *  (đọc lại) để hai bên không thể lệch chuỗi nhau. */
export const COMPOSITION_TITLE_PREFIX = '**Cấu thành màn hình (Design System) — ';

/** Dòng caption `*Nguồn: comp/<KEY>.screen.json…*` của bảng "Cấu thành màn
 *  hình" cho một SCREEN-KEY — dùng chung giữa {@link renderCompositionDraft}
 *  và {@link parseCompositionBlock}/{@link reconcileCompositionTable} (neo để
 *  tìm khối bảng trong lát, xem docblock các hàm đó). */
export function compositionCaptionFor(key: string): string {
  return `*Nguồn: comp/${key}.screen.json (bước Màn hình → Component). Cột "Vai trò / dùng để" do agent hoàn thiện theo bảng field.*`;
}

/** Dựng nháp markdown bảng "Cấu thành màn hình (Design System)" cho MỘT màn
 *  từ `comp/<KEY>.screen.json`. Daemon dùng nháp này với {@link
 *  insertCompositionTable} để tự chèn bảng vào lát TRƯỚC khi agent chạy —
 *  agent chỉ còn việc sửa tại chỗ cột "Vai trò / dùng để" (xem docblock đầu
 *  file). `screenNames` map SCREEN-KEY → tên hiển thị, dùng để dịch `nav[].to`. */
export function renderCompositionDraft(
  screen: ScreenComponentsDoc,
  // `fromGuide` (WP19a, tuỳ chọn): server.ts merge components.md với fallback
  // `criteria/components-guide.md` (xem figma-component-guide.ts,
  // mergeCatalogueWithGuide) trước khi gọi hàm này — cờ này đánh dấu mô tả
  // ĐẾN TỪ guide (AI sinh) chứ không phải từ Figma, để cột "Mô tả component"
  // gắn hậu tố cho người đọc biết xuất xứ (xem `desc` bên dưới).
  catalogue: Map<string, { name: string; description: string; fromGuide?: boolean }>,
  roleMap: RoleMapDoc | null,
  screenNames: Map<string, string>,
): string {
  const roleFallback = new Map<string, string | undefined>();
  for (const r of roleMap?.roles ?? []) roleFallback.set(r.role, r.fallback);

  const escapeCell = (s: string): string =>
    s
      .replace(/\r?\n/g, ' ')
      .replace(/\|/g, '\\|')
      .trim();

  const lines: string[] = [];
  lines.push(`${COMPOSITION_TITLE_PREFIX}${screen.name}**`);
  lines.push('');
  lines.push('| # | Thành phần | Component DS | Biến thể | Vai trò / dùng để | Mô tả component | Điều hướng tới | Ghi chú |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');

  screen.elements.forEach((el, i) => {
    const componentDs = el.ds?.component ? escapeCell(el.ds.component) : '— (DS không có)';
    const variant = el.ds?.variant ? escapeCell(el.ds.variant) : '—';
    const whyTrunc = (el.why ?? '').trim().slice(0, 120);
    const roleText = whyTrunc ? `${el.role} — ${whyTrunc}` : el.role;
    const catEntry = el.ds?.anchor ? catalogue.get(el.ds.anchor) : undefined;
    // Hậu tố " (AI sinh)" (WP19a) khi mô tả đến từ guide fallback thay vì
    // Figma — chỉ gắn SAU escape, không phải nội dung do agent/Figma cung
    // cấp nên không cần escape riêng.
    const desc = catEntry?.description
      ? `${escapeCell(catEntry.description)}${catEntry.fromGuide ? ' (AI sinh)' : ''}`
      : '—';
    const navTos = (screen.nav ?? [])
      .filter((n) => n.el === el.id)
      .map((n) => screenNames.get(n.to) ?? n.to);
    const navText = navTos.length > 0 ? escapeCell(navTos.join(', ')) : '—';

    const notes: string[] = [];
    if (el.confidence === 'low') notes.push('tin cậy thấp');
    if (!el.ds) {
      const fb = roleFallback.get(el.role);
      if (fb) notes.push(`fallback: ${fb}`);
    }
    const noteText = notes.length > 0 ? escapeCell(notes.join('; ')) : '—';

    const thanhPhan = escapeCell(el.label || el.id);
    lines.push(
      `| ${i + 1} | ${thanhPhan} | ${componentDs} | ${variant} | ${escapeCell(roleText)} | ${desc} | ${navText} | ${noteText} |`,
    );
  });

  lines.push('');
  lines.push(compositionCaptionFor(screen.key));

  return lines.join('\n');
}

/* ── 4b. Chèn/đọc/đối soát bảng "Cấu thành màn hình" trong lát ────────────── */

/** True nếu `line` (đã trim) là một hàng bảng markdown `|…|`. Dùng lại đúng
 *  quy ước `isTableRowLine` ở mục 2 (không định nghĩa lại regex). */
function isMarkdownTableRowLine(line: string): boolean {
  return /^\|.*\|$/.test(line);
}

/** Đối chiếu chỉ số dòng GỢI Ý `hintIdx0` (caller tính từ `insertAfterLine`
 *  của {@link mapScreensToSections} — vốn định vị trên bản trang TRƯỚC khi
 *  enrich sửa lát) với NỘI DUNG dòng neo thật `anchorText` (dòng của bản
 *  trang tại đúng chỉ số `insertAfterLine`) để tìm lại chỉ số ĐÚNG trong
 *  `sliceText` HIỆN TẠI (đã có thể bị dịch dòng do {@link replaceDiagramInSlice}
 *  đổi độ dài sơ đồ, hoặc do một bảng "Cấu thành màn hình" khác đã được chèn
 *  trước đó trong cùng lát — xem wp8d.yaml cho lỗi review chặn mà hàm này
 *  đóng lại).
 *
 *  `anchorText` rỗng sau trim (không có gì để đối chiếu — vd dòng neo nằm
 *  ngoài phạm vi bản trang gốc) → trả `hintIdx0` đã kẹp vào
 *  `[0, lines.length - 1]`, giữ đúng hành vi cũ (tin chỉ số, không có neo nào
 *  để dò lại).
 *
 *  Còn lại: dòng tại `hintIdx0` (nếu nằm trong phạm vi `sliceText`) trim khớp
 *  đúng `anchorText.trim()` → trả thẳng `hintIdx0` (chưa bị lệch, đường tắt).
 *  Không khớp → gom MỌI chỉ số dòng của `sliceText` có trim khớp `anchorText`,
 *  trả chỉ số GẦN `hintIdx0` nhất (hoà khoảng cách thì lấy chỉ số nhỏ hơn, vì
 *  mảng ứng viên được duyệt tăng dần và chỉ cập nhật khi khoảng cách NHỎ HƠN
 *  chứ không NHỎ HƠN-HOẶC-BẰNG). Không ứng viên nào → `null` — nghĩa là
 *  "không định vị được"; caller (server.ts) phải BỎ QUA việc chèn bảng này
 *  thay vì chèn theo chỉ số gợi ý đã có thể sai chỗ (thà bỏ qua còn hơn chèn
 *  bừa). */
export function resolveInsertAnchorIdx(sliceText: string, anchorText: string, hintIdx0: number): number | null {
  const lines = sliceText.split(/\r?\n/);
  const wantAnchor = anchorText.trim();

  if (wantAnchor === '') return Math.min(Math.max(hintIdx0, 0), lines.length - 1);
  if (hintIdx0 >= 0 && hintIdx0 < lines.length && (lines[hintIdx0] ?? '').trim() === wantAnchor) return hintIdx0;

  const candidates: number[] = [];
  lines.forEach((line, idx) => {
    if (line.trim() === wantAnchor) candidates.push(idx);
  });
  if (candidates.length === 0) return null;

  let best = candidates[0]!;
  let bestDist = Math.abs(best - hintIdx0);
  for (let i = 1; i < candidates.length; i += 1) {
    const dist = Math.abs(candidates[i]! - hintIdx0);
    if (dist < bestDist) {
      best = candidates[i]!;
      bestDist = dist;
    }
  }
  return best;
}

/** Chèn `draftMd` (nguyên văn {@link renderCompositionDraft} sinh ra, từ dòng
 *  tiêu đề đậm tới caption) vào `sliceText` NGAY SAU dòng chỉ số 0-based
 *  `afterLineIdx0` (caller tính `afterLineIdx0 = insertAfterLine - sec.startLine`
 *  từ kết quả {@link mapScreensToSections} — hoặc chỉ số đã dò lại bằng
 *  {@link resolveInsertAnchorIdx} khi lát có thể đã bị dịch dòng; vượt phạm vi
 *  lát thì kẹp về dòng cuối). Giữ đúng MỘT dòng trống giữa dòng neo và dòng tiêu đề đậm (luôn
 *  chèn mới — chỗ này chưa từng có khoảng trống vì bảng chưa tồn tại), và
 *  đúng MỘT dòng trống giữa caption và dòng không-trống kế tiếp: nếu phần lát
 *  còn lại sau điểm chèn đã bắt đầu bằng dòng trống thì dùng lại dòng đó
 *  (không chèn thêm — tránh 2 dòng trống liền), cuối lát thì không cần thêm.
 *  Dùng EOL của `sliceText` (CRLF/LF) cho toàn bộ nội dung chèn.
 *
 *  `change` mang shape DocChange `origin: 'system'`, chỉ có `quote` (KHÔNG
 *  `before` — đây là bổ sung thuần, bảng không tồn tại ở lát trước đó); xem
 *  docblock đầu file cho lý do đây là cách WP8a đóng lỗ "agent không thể sửa
 *  một bảng chưa tồn tại".
 *
 *  Nhiều bảng cùng lát: caller PHẢI chèn theo thứ tự `afterLineIdx0` GIẢM DẦN
 *  (từ dòng lớn nhất trước) — chèn tăng dần sẽ làm lệch chỉ số dòng của các
 *  điểm chèn còn lại phía sau (mỗi lần chèn làm lát dài thêm ra). */
export function insertCompositionTable(
  sliceText: string,
  afterLineIdx0: number,
  draftMd: string,
  key: string,
): { text: string; change: DocChange } {
  const eol = sliceText.includes('\r\n') ? '\r\n' : '\n';
  const lines = sliceText.split(/\r?\n/);
  const anchorIdx = Math.min(Math.max(afterLineIdx0, 0), lines.length - 1);

  const blockLines = draftMd.replace(/\r\n/g, '\n').split('\n');
  const head = lines.slice(0, anchorIdx + 1);
  const tail = lines.slice(anchorIdx + 1);

  const tailStartsBlank = tail.length > 0 && (tail[0] ?? '').trim() === '';
  const needTrailingBlank = tail.length > 0 && !tailStartsBlank;

  const insertion = ['', ...blockLines];
  if (needTrailingBlank) insertion.push('');

  const text = [...head, ...insertion, ...tail].join(eol);

  const change: DocChange = {
    id: `sys-comp-${key}`,
    kind: 'component',
    severity: 'minor',
    rule_id: `comp/${key}.screen.json`,
    origin: 'system',
    quote: blockLines.join(eol),
    reason: 'Bổ sung cấu thành màn hình từ kết quả Màn hình → Component.',
  };

  return { text, change };
}

/** Tìm khối bảng "Cấu thành màn hình" của `key` trong `text` (một lát cắt) và
 *  trả về cấu trúc đã tách — dùng bởi {@link reconcileCompositionTable} để so
 *  bảng agent sửa với bảng nháp daemon chèn.
 *
 *  Định vị bằng CAPTION trước (neo ổn định hơn tiêu đề vì tiêu đề còn lặp lại
 *  tên màn ở chỗ khác trong tài liệu): tìm đúng MỘT dòng (trim) ==
 *  {@link compositionCaptionFor}(key) — 0 hoặc nhiều hơn 1 là lỗi (bảng bị xoá
 *  hoặc agent copy-paste tạo trùng). Từ dòng caption đó đi NGƯỢC LÊN tìm dòng
 *  gần nhất bắt đầu bằng {@link COMPOSITION_TITLE_PREFIX}; mọi dòng nằm giữa
 *  hai mốc đó CHỈ được là dòng trống hoặc hàng bảng `|…|` — gặp dòng khác
 *  (agent chèn chữ vào giữa bảng) là lỗi.
 *
 *  `rows` chỉ tách CÁC HÀNG DỮ LIỆU (không phải header/separator) thành mảng
 *  ô — tách theo `|` KHÔNG escape nội dung (`\|` vẫn là ký tự `|` bên trong
 *  một ô, giữ nguyên để {@link reconcileCompositionTable} tự unescape khi so
 *  sánh), bỏ ô rỗng đầu/cuối sinh ra bởi `|` mép dòng. */
export function parseCompositionBlock(
  text: string,
  key: string,
): { start: number; end: number; title: string; header: string; separator: string; rows: string[][]; caption: string } | { error: string } {
  const lines = text.split(/\r?\n/);
  const wantCaption = compositionCaptionFor(key).trim();

  const captionIdxs: number[] = [];
  lines.forEach((raw, i) => {
    if (raw.trim() === wantCaption) captionIdxs.push(i);
  });
  if (captionIdxs.length === 0) {
    return { error: `Bảng thành phần ${key}: không tìm thấy dòng caption "*Nguồn: comp/${key}.screen.json…*".` };
  }
  if (captionIdxs.length > 1) {
    return { error: `Bảng thành phần ${key}: có ${captionIdxs.length} dòng caption trùng nhau, không định vị được đúng một bảng.` };
  }
  const captionIdx = captionIdxs[0]!;

  let titleIdx = -1;
  for (let i = captionIdx - 1; i >= 0; i -= 1) {
    const raw = lines[i] ?? '';
    if (raw.startsWith(COMPOSITION_TITLE_PREFIX)) {
      titleIdx = i;
      break;
    }
    const trimmed = raw.trim();
    if (trimmed === '' || isMarkdownTableRowLine(trimmed)) continue;
    return { error: `Bảng thành phần ${key}: dòng lạ "${trimmed}" xen giữa dòng tiêu đề và caption — bảng có thể đã bị chèn chữ.` };
  }
  if (titleIdx === -1) {
    return { error: `Bảng thành phần ${key}: không tìm thấy dòng tiêu đề đậm bắt đầu bằng "${COMPOSITION_TITLE_PREFIX}".` };
  }

  const tableRowsRaw: string[] = [];
  for (let i = titleIdx + 1; i < captionIdx; i += 1) {
    const trimmed = (lines[i] ?? '').trim();
    if (trimmed === '') continue;
    tableRowsRaw.push(trimmed);
  }
  if (tableRowsRaw.length < 2) {
    return { error: `Bảng thành phần ${key}: thiếu hàng header/phân cách của bảng.` };
  }
  const [header, separator, ...dataRowsRaw] = tableRowsRaw as [string, string, ...string[]];

  const splitRow = (row: string): string[] => {
    const cells: string[] = [];
    let cur = '';
    for (let i = 0; i < row.length; i += 1) {
      const ch = row[i]!;
      if (ch === '\\' && row[i + 1] === '|') {
        cur += '\\|';
        i += 1;
        continue;
      }
      if (ch === '|') {
        cells.push(cur);
        cur = '';
        continue;
      }
      cur += ch;
    }
    cells.push(cur);
    if (cells.length > 0 && cells[0]!.trim() === '') cells.shift();
    if (cells.length > 0 && cells[cells.length - 1]!.trim() === '') cells.pop();
    return cells.map((c) => c.trim());
  };

  return {
    start: titleIdx,
    end: captionIdx,
    title: (lines[titleIdx] ?? '').trim(),
    header,
    separator,
    rows: dataRowsRaw.map(splitRow),
    caption: (lines[captionIdx] ?? '').trim(),
  };
}

/** Tên 6 cột KHOÁ của bảng "Cấu thành màn hình" theo chỉ số ô 0-based (bảng 8
 *  cột: # | Thành phần | Component DS | Biến thể | Vai trò / dùng để | Mô tả
 *  component | Điều hướng tới | Ghi chú — chỉ số 4 và 7 là hai cột agent ĐƯỢC
 *  sửa, xem {@link reconcileCompositionTable}). */
const COMPOSITION_LOCKED_COLS: ReadonlyArray<{ idx: number; name: string }> = [
  { idx: 0, name: '#' },
  { idx: 1, name: 'Thành phần' },
  { idx: 2, name: 'Component DS' },
  { idx: 3, name: 'Biến thể' },
  { idx: 5, name: 'Mô tả component' },
  { idx: 6, name: 'Điều hướng tới' },
];

function unescapeCompositionCell(cell: string): string {
  return cell.trim().replace(/\\\|/g, '|');
}

/** Đối soát bảng "Cấu thành màn hình" của `key` giữa `baseSlice` (lát daemon
 *  đã chèn bảng nháp) và `revisedSlice` (lát sau khi agent chạy) — hàm THUẦN
 *  WP8b gọi để (a) xác nhận agent chỉ sửa hai cột được phép, (b) tính `block`
 *  cuối cùng để cập nhật `quote` của system change đã chèn ở
 *  {@link insertCompositionTable}.
 *
 *  Parse cả hai bên bằng {@link parseCompositionBlock}; lỗi parse phía
 *  `revisedSlice` (bảng bị xoá, chèn chữ vào giữa, trùng caption…) trả về
 *  thông báo bắt đầu bằng "Bảng thành phần <KEY> bị xoá/hỏng cấu trúc: …" —
 *  đúng khuôn `classifyValidationError` (error-reports.ts) nhận diện mã
 *  COMPOSITION_TABLE. Đạt yêu cầu: title/header/separator/caption trùng nhau
 *  (trim), số hàng dữ liệu bằng nhau, mỗi hàng đủ 8 ô cả hai bên, và 6 cột
 *  khoá ({@link COMPOSITION_LOCKED_COLS}) trùng nhau sau trim+unescape — sai
 *  chỗ nào trả lỗi nêu đúng số hàng (1-based) + tên cột. */
export function reconcileCompositionTable(
  baseSlice: string,
  revisedSlice: string,
  key: string,
): { ok: true; block: string; changedRows: number; baseWithFinal: string } | { ok: false; error: string } {
  const base = parseCompositionBlock(baseSlice, key);
  if ('error' in base) {
    return { ok: false, error: `Bảng thành phần ${key} bị xoá/hỏng cấu trúc ở bản gốc đã enrich: ${base.error}` };
  }
  const revised = parseCompositionBlock(revisedSlice, key);
  if ('error' in revised) {
    return { ok: false, error: `Bảng thành phần ${key} bị xoá/hỏng cấu trúc: ${revised.error}` };
  }

  if (base.title !== revised.title) {
    return { ok: false, error: `Bảng thành phần ${key}: dòng tiêu đề đậm bị sửa — chỉ được sửa cột "Vai trò / dùng để" và "Ghi chú".` };
  }
  if (base.header !== revised.header) {
    return { ok: false, error: `Bảng thành phần ${key}: hàng tiêu đề cột bị sửa — chỉ được sửa cột "Vai trò / dùng để" và "Ghi chú".` };
  }
  if (base.separator !== revised.separator) {
    return { ok: false, error: `Bảng thành phần ${key}: hàng phân cách bảng bị sửa — chỉ được sửa cột "Vai trò / dùng để" và "Ghi chú".` };
  }
  if (base.caption !== revised.caption) {
    return { ok: false, error: `Bảng thành phần ${key}: dòng caption bị sửa — chỉ được sửa cột "Vai trò / dùng để" và "Ghi chú".` };
  }
  if (base.rows.length !== revised.rows.length) {
    return {
      ok: false,
      error: `Bảng thành phần ${key}: số hàng đã đổi (${base.rows.length} → ${revised.rows.length}) — cấm thêm hoặc bớt hàng.`,
    };
  }

  let changedRows = 0;
  for (let r = 0; r < base.rows.length; r += 1) {
    const baseRow = base.rows[r] ?? [];
    const revRow = revised.rows[r] ?? [];
    if (baseRow.length !== 8 || revRow.length !== 8) {
      return { ok: false, error: `Bảng thành phần ${key}: hàng ${r + 1} bị sửa — chỉ được sửa cột "Vai trò / dùng để" và "Ghi chú".` };
    }
    for (const col of COMPOSITION_LOCKED_COLS) {
      if (unescapeCompositionCell(baseRow[col.idx] ?? '') !== unescapeCompositionCell(revRow[col.idx] ?? '')) {
        return {
          ok: false,
          error: `Bảng thành phần ${key}: hàng ${r + 1} cột "${col.name}" bị sửa — chỉ được sửa cột "Vai trò / dùng để" và "Ghi chú".`,
        };
      }
    }
    const roleChanged = unescapeCompositionCell(baseRow[4] ?? '') !== unescapeCompositionCell(revRow[4] ?? '');
    const noteChanged = unescapeCompositionCell(baseRow[7] ?? '') !== unescapeCompositionCell(revRow[7] ?? '');
    if (roleChanged || noteChanged) changedRows += 1;
  }

  const revisedLines = revisedSlice.split(/\r?\n/);
  const revisedEol = revisedSlice.includes('\r\n') ? '\r\n' : '\n';
  const finalBlockLines = revisedLines.slice(revised.start, revised.end + 1);
  const block = finalBlockLines.join(revisedEol);

  const baseLines = baseSlice.split(/\r?\n/);
  const baseEol = baseSlice.includes('\r\n') ? '\r\n' : '\n';
  const baseWithFinal = [
    ...baseLines.slice(0, base.start),
    ...finalBlockLines,
    ...baseLines.slice(base.end + 1),
  ].join(baseEol);

  return { ok: true, block, changedRows, baseWithFinal };
}

/** True khi `change` (agent tự khai trong changes.json) thực chất là việc sửa
 *  ô của bảng "Cấu thành màn hình" mà daemon đã tự đối soát ở
 *  {@link reconcileCompositionTable} — WP8b dùng để BỎ những change này khỏi
 *  danh sách validate (agent KHÔNG cần khai change cho việc sửa ô, xem
 *  docblock đầu file); daemon tự ghi nhận bằng system change đã cập nhật
 *  `quote`.
 *
 *  So theo DÒNG (không substring): true khi có ít nhất một dòng không-trống
 *  (trim) của `change.before` trùng NGUYÊN VĂN một dòng của `draftBlock`,
 *  HOẶC một dòng không-trống của `change.quote` trùng nguyên văn một dòng của
 *  `finalBlock`. So substring sẽ khiến một `quote` ngắn kiểu "Button" ở một
 *  chỗ hoàn toàn khác trong tài liệu bị nuốt nhầm vào bảng — so theo dòng
 *  tránh được việc đó. */
export function isCompositionOwnedChange(
  change: Pick<DocChange, 'before' | 'quote'>,
  draftBlock: string,
  finalBlock: string,
): boolean {
  const nonBlankTrimmedLines = (text: string): string[] =>
    text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l !== '');

  const draftLines = new Set(nonBlankTrimmedLines(draftBlock));
  const finalLines = new Set(nonBlankTrimmedLines(finalBlock));

  if (nonBlankTrimmedLines(change.before ?? '').some((l) => draftLines.has(l))) return true;
  if (nonBlankTrimmedLines(change.quote ?? '').some((l) => finalLines.has(l))) return true;
  return false;
}

/** Khuôn các dòng output-của-tool (Codex/PowerShell…) agent lỡ dán nhầm vào
 *  lát thay vì sửa nó bằng công cụ sửa file — đo trên sự cố thật (error report
 *  #465ee502): agent chạy shell rồi copy nguyên khối "Wall time / Total output
 *  lines / Output: / ---SLICE--- / ---DRAFT---" (+ bản sao nội dung) vào giữa
 *  lát. WP8b coi mọi lát có dòng khớp đây là section hỏng (fail-shut).
 *
 *  Regex neo ở ĐẦU DÒNG (sau trim) và đóng khung rõ (`$`/`\b`) — cố ý không
 *  dùng khuôn rộng như `/^Output/` không dấu hai chấm vì nó khớp cả câu văn
 *  thường bắt đầu bằng "Output" (vd tiêu đề một mục "Output của API…"). */
const TOOL_OUTPUT_NOISE_PATTERNS: ReadonlyArray<RegExp> = [
  /^Wall time:\s/,
  /^Total output lines:\s/,
  /^Output:$/,
  /^Exit code:\s/,
  /^---[A-Z][A-Z-]*---$/,
  /^\[Tool output\b/,
  /^Process exited with code\b/,
];

/** Trả các dòng (đã trim) của `text` khớp {@link TOOL_OUTPUT_NOISE_PATTERNS}.
 *  Mảng rỗng nghĩa là sạch. */
export function findToolOutputNoise(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (TOOL_OUTPUT_NOISE_PATTERNS.some((re) => re.test(line))) out.push(line);
  }
  return out;
}

/* ── 5. Kickoff bổ sung cho section agent ────────────────────────────────── */

/** Soạn đoạn kickoff (tiếng Việt) NỐI THÊM vào kickoff gốc của một section —
 *  server.ts gọi hàm này với đúng phần dữ liệu liên quan tới section đó (một
 *  section không dính gì tới flows/comp thì mọi trường đều `undefined` và hàm
 *  trả `''`, giữ hành vi y hệt trước khi có WP2).
 *
 *  `screensInThisSlice`: kể từ WP8a, bảng "Cấu thành màn hình" đã được daemon
 *  TỰ CHÈN vào lát bằng {@link insertCompositionTable} TRƯỚC khi section này
 *  chạy (không còn nháp `review/_composition/<KEY>.md` cho agent tự chèn) —
 *  đoạn kickoff vì vậy chỉ còn nói cho agent biết bảng đã ở đó và luật sửa ô,
 *  không còn dặn "chèn bảng" hay dẫn `insertAfterLineText` nữa.
 *
 *  Cảnh báo chung về cách sửa lát (KHÔNG shell, KHÔNG dán output tool) được
 *  nối thêm bất cứ khi nào có ít nhất một đoạn kickoff khác ở trên — không tự
 *  nó tạo ra nội dung cho một section không dính gì tới flows/comp (hàm vẫn
 *  trả `''` khi mọi trường input đều `undefined`/rỗng). */
export function buildEnrichKickoff(input: {
  diagramInThisSlice?: { flowId: string };
  pageDiagramChanged?: Array<{ flowId: string }>;
  screensInThisSlice?: Array<{ key: string; name: string }>;
  unplacedScreens?: string[];
}): string {
  const parts: string[] = [];

  if (input.diagramInThisSlice) {
    const { flowId } = input.diagramInThisSlice;
    parts.push(
      'Lát của bạn chứa sơ đồ luồng đã được daemon thay bằng bản ĐỀ XUẤT — TUYỆT ĐỐI không sửa fence ```mermaid và dòng caption; ' +
        `nếu chữ trong section mô tả luồng thì đối chiếu với sơ đồ mới (đọc flows/${flowId}/ux-review.json) và sửa cho khớp.`,
    );
  }

  for (const { flowId } of input.pageDiagramChanged ?? []) {
    parts.push(
      `Sơ đồ luồng của trang đã đổi (flows/${flowId}/proposed.mmd; findings: flows/${flowId}/ux-review.json); ` +
        `câu nào mô tả nhánh đã đổi thì sửa (kind flow, rule_id flows/${flowId}/ux-review.json).`,
    );
  }

  for (const { key, name } of input.screensInThisSlice ?? []) {
    parts.push(
      `Lát của bạn ĐÃ CÓ bảng «Cấu thành màn hình (Design System) — ${name}» (nguồn comp/${key}.screen.json) do daemon chèn sẵn ngay sau mockup của màn. ` +
        `Với bảng này bạn CHỈ được sửa ô của hai cột 'Vai trò / dùng để' và 'Ghi chú' — đối chiếu bảng field ngay dưới rồi viết lại ngắn gọn bằng tiếng Việt, Edit từng hàng một; ` +
        `KHÔNG thêm/xoá hàng, KHÔNG sửa các cột khác, KHÔNG sửa dòng tiêu đề đậm và dòng caption \`*Nguồn: comp/…*\`, KHÔNG dùng ký tự \`|\` trong ô (dùng '/' hoặc ';'). ` +
        `KHÔNG khai change cho việc sửa ô của bảng này — daemon tự đối soát và ghi nhận; nếu bảng và bảng field mâu thuẫn thì ghi note kind component, rule_id comp/${key}.screen.json.`,
    );
  }

  const unplaced = input.unplacedScreens ?? [];
  if (unplaced.length > 0) {
    parts.push(
      `Các màn sau có kết quả comp nhưng không định vị được mục trong tài liệu: ${unplaced.join(', ')} — ` +
        'nếu section của bạn mô tả màn đó thì ghi note gap (không chèn bảng).',
    );
  }

  if (parts.length > 0) {
    parts.push(
      "Sửa lát BẰNG công cụ sửa file (Edit/apply_patch) từng chỗ một — KHÔNG dùng lệnh shell (Set-Content, echo/cat >, heredoc) để ghi lại lát và KHÔNG dán output của lệnh vào lát; " +
        "daemon phát hiện các dòng kiểu 'Wall time:', 'Total output lines:', 'Output:', '---SLICE---' và huỷ kết quả section.",
    );
  }

  return parts.join('\n\n');
}

// Giữ type-only re-export để server.ts (và test) không phải import kind/severity
// riêng từ docs-review.js khi chỉ cần đúng shape của change do file này tạo.
export type { DocChange, DocChangeKind, DocChangeSeverity };
