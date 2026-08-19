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
 *  Vì vậy:
 *   - Sơ đồ mermaid: daemon TỰ THAY ở lát cắt trước khi agent chạy, khai một
 *     DocChange `origin: 'system'` (xem {@link replaceDiagramInSlice}).
 *   - Bảng "Cấu thành màn hình": daemon chỉ DỰNG NHÁP
 *     (`review/_composition/<KEY>.md`, xem {@link renderCompositionDraft});
 *     agent tự chèn bảng đó vào lát của mình rồi khai MỘT change kind
 *     `component` chỉ có `quote` (bổ sung thuần, không `before`).
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

/** Dựng nháp markdown bảng "Cấu thành màn hình (Design System)" cho MỘT màn
 *  từ `comp/<KEY>.screen.json` — daemon chỉ dựng nháp, agent chèn vào lát của
 *  mình rồi tự viết lại cột "Vai trò / dùng để" (xem docblock đầu file).
 *  `screenNames` map SCREEN-KEY → tên hiển thị, dùng để dịch `nav[].to`. */
export function renderCompositionDraft(
  screen: ScreenComponentsDoc,
  catalogue: Map<string, { name: string; description: string }>,
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
  lines.push(`**Cấu thành màn hình (Design System) — ${screen.name}**`);
  lines.push('');
  lines.push('| # | Thành phần | Component DS | Biến thể | Vai trò / dùng để | Mô tả component | Điều hướng tới | Ghi chú |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');

  screen.elements.forEach((el, i) => {
    const componentDs = el.ds?.component ? escapeCell(el.ds.component) : '— (DS không có)';
    const variant = el.ds?.variant ? escapeCell(el.ds.variant) : '—';
    const whyTrunc = (el.why ?? '').trim().slice(0, 120);
    const roleText = whyTrunc ? `${el.role} — ${whyTrunc}` : el.role;
    const catEntry = el.ds?.anchor ? catalogue.get(el.ds.anchor) : undefined;
    const desc = catEntry?.description ? escapeCell(catEntry.description) : '—';
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
  lines.push(
    `*Nguồn: comp/${screen.key}.screen.json (bước Màn hình → Component). Cột "Vai trò / dùng để" do agent hoàn thiện theo bảng field.*`,
  );

  return lines.join('\n');
}

/* ── 5. Kickoff bổ sung cho section agent ────────────────────────────────── */

/** Soạn đoạn kickoff (tiếng Việt) NỐI THÊM vào kickoff gốc của một section —
 *  server.ts gọi hàm này với đúng phần dữ liệu liên quan tới section đó (một
 *  section không dính gì tới flows/comp thì mọi trường đều `undefined` và hàm
 *  trả `''`, giữ hành vi y hệt trước khi có WP2). */
export function buildEnrichKickoff(input: {
  diagramInThisSlice?: { flowId: string };
  pageDiagramChanged?: Array<{ flowId: string }>;
  screensInThisSlice?: Array<{ key: string; insertAfterLineText: string }>;
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

  for (const { key, insertAfterLineText } of input.screensInThisSlice ?? []) {
    const anchorText = insertAfterLineText.slice(0, 80);
    parts.push(
      `Chèn bảng từ nháp review/_composition/${key}.md vào lát, NGAY SAU dòng «${anchorText}» và TRƯỚC bảng field; ` +
        `giữ nguyên số hàng và các cột DS/Biến thể/Mô tả; chỉ viết lại cột 'Vai trò / dùng để' cho khớp bảng field bên dưới; ` +
        `khai MỘT change kind component, rule_id comp/${key}.screen.json, chỉ quote (cả bảng, nguyên văn, kể cả dòng tiêu đề đậm và caption), ` +
        `KHÔNG before, reason 'Bổ sung cấu thành màn hình từ kết quả Màn hình → Component.'`,
    );
  }

  const unplaced = input.unplacedScreens ?? [];
  if (unplaced.length > 0) {
    parts.push(
      `Các màn sau có kết quả comp nhưng không định vị được mục trong tài liệu: ${unplaced.join(', ')} — ` +
        'nếu section của bạn mô tả màn đó thì ghi note gap (không chèn bảng).',
    );
  }

  return parts.join('\n\n');
}

// Giữ type-only re-export để server.ts (và test) không phải import kind/severity
// riêng từ docs-review.js khi chỉ cần đúng shape của change do file này tạo.
export type { DocChange, DocChangeKind, DocChangeSeverity };
