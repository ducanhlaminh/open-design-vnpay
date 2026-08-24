// DocRedlinePreview — docs-review's redline view for a page the `dr-review`
// stage edited (`docs-review/review/docs/**/*.md`).
//
// The stage writes TWO files per page: the edited copy itself, and a sibling
// `<name>.changes.json` array of annotations (apps/daemon/src/docs-review.ts's
// `DocChange` shape) explaining WHY each spot changed. This renders ONE column —
// the EDITED doc — with every change highlighted (`quote` anchors the mark), and
// a rail of change cards beside it. Bản GỐC không còn được dựng thành cột riêng:
// khi review người dùng đọc bản mới, còn "đã đổi từ gì" chỉ cần ở mức từng chỗ
// sửa (`before → quote` trong thẻ lý do), không cần cả một tài liệu để đối
// chiếu — nửa màn hình làm bảng của tài liệu URD bị bó và xuống dòng liên tục.
//
// Điều hướng hai chiều: click một mục trong rail thì tài liệu cuộn tới vùng bôi
// của nó; click một vùng bôi thì rail cuộn tới mục tương ứng. Không còn panel
// đáy trượt lên — rail hiện sẵn nhóm/mức độ/rule_id/lý do/diff của MỌI chỗ sửa,
// nên panel chỉ là hiển thị cùng một thông tin ở nơi thứ hai.
//
// `<mark>` được chèn vào CHUỖI HTML đã render, trước khi React nhận (xem
// injectHighlights trong runtime/doc-highlight.ts). Không chèn vào mã nguồn
// markdown vì renderMarkdownToSafeHtml cố ý escape HTML thô — viết thẻ vào đó
// chỉ hiện ra thành chữ. Cũng KHÔNG mổ DOM sau khi render như bản trước: cách
// đó phụ thuộc ref đã gắn chưa và React có dựng lại nút hay không, cả hai đều
// đã thực sự làm vùng bôi biến mất.
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type {
  DocReviewAnnotationEvent,
  DocReviewAnnotationFileV2,
} from '@open-design/contracts';
import type { ProjectFile } from '../types';
import { fetchProjectFileText } from '../providers/registry';
import { renderMarkdownToSafeHtml } from '../artifacts/markdown';
// KHÔNG import từ './FileViewer' — FileViewer đã import component này để route
// file redline, nên chiều ngược lại tạo import vòng (xem markdown-images.ts).
import { inlineMarkdownImages } from '../runtime/markdown-images';
import { injectDeletedRuns, injectHighlights, quoteSegments, type HighlightBlockTarget, type HighlightScope } from '../runtime/doc-highlight';
import { wordDiff } from '../runtime/word-diff';
import { Icon } from './Icon';
import { MermaidDiagram } from './MermaidDiagram';
import { DocRedlineModeControls } from './DocRedlineModeControls';
import { DocRedlineNavigation } from './DocRedlineNavigation';
import { annotationMode, modeLabel, type PreviewMode } from './redline-mode';
import { getAdjacentNavigationId, getNavigationPosition, type RedlineNavigationItem } from './redline-navigation';
import styles from './DocRedlinePreview.module.css';

export type DocRedlineChangeKind = 'ux-writing' | 'flow' | 'gap' | 'edge-case' | 'component' | 'flow-diagram';
export type DocRedlineSeverity = 'blocker' | 'major' | 'minor';

/** Mirrors apps/daemon/src/docs-review.ts's `DocChange` — the web side reads
 *  the JSON the daemon wrote, it does not import the daemon module (apps/web
 *  must not import apps/daemon/src/**). */
export interface DocRedlineChange {
  id: string;
  kind: DocRedlineChangeKind;
  severity: DocRedlineSeverity;
  rule_id?: string;
  /** Nguyên văn đoạn trong bản GỐC bị thay hoặc bị xoá — chỉ hiện trong thẻ lý
   *  do ("chữ cũ → chữ mới"), không còn neo cột nào. */
  before?: string;
  /** Nguyên văn đoạn trong bản ĐÃ SỬA — neo vùng bôi trong cột tài liệu. */
  quote?: string;
  /** Nguyên văn một đoạn trong bản ĐÃ SỬA nằm CẠNH chỗ xoá. Chỉ có nghĩa với
   *  chỗ xoá thuần (`before` mà không `quote`): đoạn bị xoá không còn tồn tại
   *  trong bản đã sửa nên tự nó không neo được vào đâu, phải nhờ một đoạn còn
   *  sống bên cạnh (xem injectDeletedRuns). */
  anchor?: string;
  /** Các mục tài liệu/quy tắc mà chỗ sửa này dẫn ra. CHƯA render — giữ trong
   *  shape để không phải parse lại khi màn hình có chỗ hiển thị. */
  doc_refs?: string[];
  reason: string;
  /** `'system'` = sinh bởi một bước tự động KHÔNG phải LLM review (ví dụ
   *  `flows/<id>/ux-review.json` viết lại sơ đồ mermaid) — khác `'agent'`
   *  (LLM review) và `'user'` (người dùng tự sửa), nhưng dùng chung mọi cơ chế
   *  hiển thị/thao tác của `'agent'` trừ khi có nhánh riêng nói khác. */
  origin?: 'agent' | 'system' | 'user';
  operation?: 'add' | 'edited' | 'delete';
  initialBefore?: string;
  initialQuote?: string;
  status?: 'active' | 'dismissed' | 'edited';
  sectionIndex?: number;
  sectionHeading?: string;
  sectionStartHeadingOrdinal?: number;
  sectionEndHeadingOrdinalExclusive?: number;
}

/** Mirrors apps/daemon/src/docs-review.ts's `DocNote` — cùng lý do như
 *  DocRedlineChange ngay trên: web đọc JSON daemon ghi ra, KHÔNG import module
 *  của daemon. Note là phát hiện KHÔNG sửa được bằng cách sửa chữ (sai
 *  R-OVERLAY, component ngoài danh mục, thiếu cả một màn, sơ đồ rỗng), nên nó
 *  không có `before`/`quote` — chỉ có `anchor` để định vị vào tài liệu. */
export interface DocRedlineNote {
  id: string;
  kind: DocRedlineChangeKind;
  severity: DocRedlineSeverity;
  rule_id?: string;
  /** Nguyên văn một đoạn trong bản GỐC để neo nhận xét vào đúng chỗ. */
  anchor: string;
  /** Như `DocRedlineChange.doc_refs` nhưng nguyên văn lấy từ bản GỐC — note
   *  không sửa gì nên các đoạn nó viện dẫn còn nguyên ở cả hai bản, và neo
   *  được vào bản đã sửa y như vậy. */
  doc_refs?: string[];
  finding: string;
  suggestion: string;
  status?: 'dismissed' | 'edited';
  sectionIndex?: number;
  sectionHeading?: string;
  sectionStartHeadingOrdinal?: number;
  sectionEndHeadingOrdinalExclusive?: number;
}

/** Nội dung một rule đang hiện trong popover. `html` đã qua
 *  renderMarkdownToSafeHtml (an toàn theo hợp đồng của hàm đó); `text` là
 *  đường dành cho bộ mặc định — nó là một câu trơn, dựng markdown cho nó chỉ
 *  thêm bước mà không thêm gì. */
type RuleBody =
  | { status: 'loading' }
  | { status: 'missing' }
  | { status: 'text'; text: string }
  | { status: 'html'; html: string };

type ChangesState =
  | { status: 'loading' }
  /** `<page>.changes.json` fetch returned nothing (404/network) — no sidecar
   *  at all, e.g. a hand-uploaded page that never went through dr-review. */
  | { status: 'none' }
  /** File exists but is not a JSON array — render the doc without reasons
   *  rather than fail the whole preview. */
  | { status: 'malformed' }
  | { status: 'ok'; changes: DocRedlineChange[]; events: DocReviewAnnotationEvent[] };

interface DraftAnnotation {
  operation: 'add' | 'edited' | 'delete';
  selected: string;
  replacement: string;
  reason: string;
  /** wp4.yaml mục 3: loại của thay đổi tự tạo — chỉ có ý nghĩa (và chỉ hiện
   *  select) cho Sửa/Thêm; Xoá không có "nội dung mới" để phân loại nên giữ
   *  mặc định cũ (xem `defaultUserKind`). */
  kind: DocRedlineChangeKind;
  /** wp4.yaml mục 2, vá N1 (review attempt2): `true` khi `selected` đến từ
   *  một heading chọn trong danh sách (`startHeadingAnnotation`) thay vì bôi
   *  đen (`startUserAnnotation`) — `createUserAnnotation` cần biết để chèn
   *  bằng `insertAfterHeadingLine` (line-anchored) thay vì
   *  `insertAfterUniqueAnchor` (substring, đúng cho đoạn bôi đen nhưng SAI
   *  cho một dòng heading có thể là tiền tố của heading con). */
  viaHeading?: boolean;
}

// Nhãn thao tác đọc được với người không rành thuật ngữ review — thay cho mã
// kỹ thuật cũ ("UX writing", "Trường hợp biên"…). `gap`/`edge-case` đổi tên
// hẳn ("Thiếu sót" → "Thiếu mô tả", "Trường hợp biên" → "Thiếu ngoại lệ") theo
// đúng chốt của người dùng — không có test cũ nào khoá chuỗi cũ.
const KIND_LABEL: Record<DocRedlineChangeKind, string> = {
  'ux-writing': 'Sửa chữ',
  flow: 'Luồng',
  gap: 'Thiếu mô tả',
  'edge-case': 'Thiếu ngoại lệ',
  component: 'Component',
  'flow-diagram': 'Sơ đồ',
};
const SEV_LABEL: Record<DocRedlineSeverity, string> = {
  blocker: 'Nghiêm trọng',
  major: 'Nặng',
  minor: 'Nhẹ',
};
// `styles.*` types as `string | undefined` (CSS Modules' index-signature type
// widened by tsconfig's `noUncheckedIndexedAccess`) even though the class
// always exists at runtime — `?? ''` narrows without changing behavior.
const SEV_CLASS: Record<DocRedlineSeverity, string> = {
  blocker: styles.sevBlocker ?? '',
  major: styles.sevMajor ?? '',
  minor: styles.sevMinor ?? '',
};
const KIND_SET = new Set<string>(Object.keys(KIND_LABEL));
const SEV_SET = new Set<string>(Object.keys(SEV_LABEL));

/** wp4.yaml mục 3: các loại người dùng CHỌN được cho một thay đổi tự tạo —
 *  cố ý bỏ `flow-diagram` (chỉ hệ thống sinh, xem docblock
 *  `DocRedlineChange.origin`) khỏi danh sách chọn. Nhãn dùng lại `KIND_LABEL`
 *  y hệt spec liệt kê ("Sửa chữ"/"Luồng"/"Thiếu mô tả"/"Thiếu ngoại lệ"
 *  /"Component"), nên không cần một bảng nhãn thứ hai. */
const USER_KIND_OPTIONS: DocRedlineChangeKind[] = ['ux-writing', 'flow', 'gap', 'edge-case', 'component'];

/** Loại mặc định của một thay đổi tự tạo theo phép sửa: "Sửa chữ" cho thao
 *  tác SỬA, "Thiếu mô tả" (kind cũ `gap`, giữ nguyên hành vi trước wp4.yaml)
 *  cho THÊM và cho XOÁ — Xoá không hiện select "Loại" (mục 3 chỉ nói "cả
 *  Sửa/Thêm") nên giữ đúng mặc định cũ, không đổi số liệu của phép xoá. */
function defaultUserKind(operation: DraftAnnotation['operation']): DocRedlineChangeKind {
  return operation === 'edited' ? 'ux-writing' : 'gap';
}

/** wp4.yaml mục 2: một heading của tài liệu — `line` là NGUYÊN VĂN dòng
 *  markdown (dùng thẳng làm `anchor` để chèn ngay sau nó, cùng cơ chế
 *  `insertAfterUniqueAnchor` mà "Thêm sau đoạn chọn" đã dùng); `text`/`level`
 *  chỉ để hiện trong danh sách chọn. */
interface DocHeading {
  level: number;
  text: string;
  line: string;
}
/** Parse MỌI dòng bắt đầu `#` (1–6 cấp) từ `source` — không phân biệt heading
 *  nằm trong khối mã hay không (đơn giản nhất chạy được; tài liệu review
 *  hiếm khi có heading giả trong code fence, và spec không đòi phân biệt). */
function parseDocHeadings(source: string): DocHeading[] {
  const out: DocHeading[] = [];
  for (const line of source.split(/\r?\n/)) {
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    out.push({ level: m[1]!.length, text: m[2]!.trim(), line });
  }
  return out;
}

/** File do LLM sinh có thể lặp id (hai mục cùng "c1"). Id trùng làm key React
 *  đụng nhau và các map neo/scroll (`itemsByChangeRef`, `anchored`) đè lẫn —
 *  mục sau nuốt mục trước. Khử ngay lúc parse để mọi tầng sau cùng nhìn một id
 *  duy nhất: mục trùng thứ hai thành "c1#2", thứ ba "c1#3"… */
function claimUniqueId(id: string, seen: Set<string>): string {
  let out = id;
  for (let n = 2; seen.has(out); n += 1) out = `${id}#${n}`;
  seen.add(out);
  return out;
}

/** Parse a `*.changes.json` file's raw text into a change list. Tolerant of a
 *  PARTLY malformed array — a bad element is skipped, not fatal — because the
 *  point of this view is to show whatever reasons ARE readable, not to gate
 *  the whole preview behind a strict schema a hand-edited file could easily
 *  break. Returns null only when the file as a whole is unusable (not JSON,
 *  or not an array). */
export function parseDocChangesFile(raw: string): { changes: DocRedlineChange[]; events: DocReviewAnnotationEvent[] } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const source = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object'
      && (parsed as { schemaVersion?: unknown }).schemaVersion === 2
      && Array.isArray((parsed as { annotations?: unknown }).annotations)
      ? (parsed as { annotations: unknown[] }).annotations
      : null;
  if (!source) return null;
  const out: DocRedlineChange[] = [];
  const seenIds = new Set<string>();
  for (const item of source) {
    if (!item || typeof item !== 'object') continue;
    const c = item as Record<string, unknown>;
    if (typeof c.id !== 'string' || !c.id.trim()) continue;
    const before = typeof c.before === 'string' && c.before.trim() ? c.before : undefined;
    const quote = typeof c.quote === 'string' && c.quote.trim() ? c.quote : undefined;
    if (!before && !quote) continue;
    out.push({
      id: claimUniqueId(c.id, seenIds),
      kind: (typeof c.kind === 'string' && KIND_SET.has(c.kind) ? c.kind : 'gap') as DocRedlineChangeKind,
      severity: (typeof c.severity === 'string' && SEV_SET.has(c.severity)
        ? c.severity
        : 'minor') as DocRedlineSeverity,
      rule_id: typeof c.rule_id === 'string' && c.rule_id.trim() ? c.rule_id : undefined,
      before,
      quote,
      anchor: typeof c.anchor === 'string' && c.anchor.trim() ? c.anchor : undefined,
      doc_refs: Array.isArray(c.doc_refs)
        ? c.doc_refs.filter((ref): ref is string => typeof ref === 'string' && !!ref.trim())
        : undefined,
      reason: typeof c.reason === 'string' && c.reason.trim() ? c.reason : 'Người dùng tự chỉnh tài liệu.',
      origin: c.origin === 'user' ? 'user' : c.origin === 'system' ? 'system' : 'agent',
      operation: c.operation === 'add' || c.operation === 'edited' || c.operation === 'delete'
        ? c.operation
        : before && quote ? 'edited' : quote ? 'add' : 'delete',
      initialBefore: typeof c.initialBefore === 'string' ? c.initialBefore : before,
      initialQuote: typeof c.initialQuote === 'string' ? c.initialQuote : quote,
      status: c.status === 'dismissed' || c.status === 'edited' || c.status === 'active' ? c.status : undefined,
      sectionIndex: typeof c.sectionIndex === 'number' && Number.isInteger(c.sectionIndex) && c.sectionIndex >= 0 ? c.sectionIndex : undefined,
      sectionHeading: typeof c.sectionHeading === 'string' ? c.sectionHeading : undefined,
      sectionStartHeadingOrdinal: typeof c.sectionStartHeadingOrdinal === 'number' && Number.isInteger(c.sectionStartHeadingOrdinal) && c.sectionStartHeadingOrdinal >= 0 ? c.sectionStartHeadingOrdinal : undefined,
      sectionEndHeadingOrdinalExclusive: typeof c.sectionEndHeadingOrdinalExclusive === 'number' && Number.isInteger(c.sectionEndHeadingOrdinalExclusive) && c.sectionEndHeadingOrdinalExclusive >= 0 ? c.sectionEndHeadingOrdinalExclusive : undefined,
    });
  }
  const events = !Array.isArray(parsed) && Array.isArray((parsed as { events?: unknown }).events)
    ? (parsed as { events: unknown[] }).events.filter((event): event is DocReviewAnnotationEvent => {
        if (!event || typeof event !== 'object') return false;
        const value = event as Record<string, unknown>;
        return typeof value.id === 'string' && typeof value.annotationId === 'string'
          && (value.type === 'create' || value.type === 'edit' || value.type === 'dismiss' || value.type === 'restore')
          && (value.actor === 'agent' || value.actor === 'user') && typeof value.at === 'number';
      })
    : [];
  return { changes: out, events };
}

export function parseDocChanges(raw: string): DocRedlineChange[] | null {
  return parseDocChangesFile(raw)?.changes ?? null;
}

/** Cùng tinh thần khoan dung như parseDocChanges: phần tử hỏng bị bỏ qua chứ
 *  không đánh hỏng cả khung nhìn. Trả null khi file nói chung không dùng được. */
export function parseDocNotes(raw: string): DocRedlineNote[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const out: DocRedlineNote[] = [];
  const seenIds = new Set<string>();
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const n = item as Record<string, unknown>;
    if (typeof n.id !== 'string' || !n.id.trim()) continue;
    if (typeof n.finding !== 'string' || !n.finding.trim()) continue;
    out.push({
      id: claimUniqueId(n.id, seenIds),
      kind: (typeof n.kind === 'string' && KIND_SET.has(n.kind) ? n.kind : 'gap') as DocRedlineChangeKind,
      severity: (typeof n.severity === 'string' && SEV_SET.has(n.severity)
        ? n.severity
        : 'minor') as DocRedlineSeverity,
      rule_id: typeof n.rule_id === 'string' && n.rule_id.trim() ? n.rule_id : undefined,
      anchor: typeof n.anchor === 'string' ? n.anchor : '',
      doc_refs: Array.isArray(n.doc_refs)
        ? n.doc_refs.filter((ref): ref is string => typeof ref === 'string' && !!ref.trim())
        : undefined,
      finding: n.finding,
      suggestion: typeof n.suggestion === 'string' ? n.suggestion : '',
      status: n.status === 'dismissed' ? 'dismissed' : n.status === 'edited' ? 'edited' : undefined,
      sectionIndex: typeof n.sectionIndex === 'number' && Number.isInteger(n.sectionIndex) && n.sectionIndex >= 0 ? n.sectionIndex : undefined,
      sectionHeading: typeof n.sectionHeading === 'string' ? n.sectionHeading : undefined,
      sectionStartHeadingOrdinal: typeof n.sectionStartHeadingOrdinal === 'number' && Number.isInteger(n.sectionStartHeadingOrdinal) && n.sectionStartHeadingOrdinal >= 0 ? n.sectionStartHeadingOrdinal : undefined,
      sectionEndHeadingOrdinalExclusive: typeof n.sectionEndHeadingOrdinalExclusive === 'number' && Number.isInteger(n.sectionEndHeadingOrdinalExclusive) && n.sectionEndHeadingOrdinalExclusive >= 0 ? n.sectionEndHeadingOrdinalExclusive : undefined,
    });
  }
  return out;
}

/** Phép sửa của một change, suy ra từ đúng hai field `before`/`quote` — file
 *  `*.changes.json` không mang field loại nào, và thêm một field chỉ để lặp lại
 *  thứ hai field kia đã nói là mở đường cho dữ liệu tự mâu thuẫn.
 *  Có cả hai = viết lại (`edit`); chỉ `quote` = chữ mới xuất hiện (`add`); chỉ
 *  `before` = chữ cũ bị bỏ (`del`). */
/** Thay đúng lần xuất hiện đầu tiên, không đụng các đoạn trùng phía sau. */
export function replaceOneOccurrence(source: string, quote: string, replacement: string): string | null {
  const index = source.indexOf(quote);
  return index < 0 ? null : `${source.slice(0, index)}${replacement}${source.slice(index + quote.length)}`;
}

export function editDocText(source: string, quote: string, next: string): string | null {
  return replaceOneOccurrence(source, quote, next);
}

export function revertDocText(source: string, change: Pick<DocRedlineChange, 'before' | 'quote' | 'anchor'>): string | null {
  if (change.before && change.quote) return replaceOneOccurrence(source, change.quote, change.before);
  if (change.quote) return replaceOneOccurrence(source, change.quote, '');
  if (change.before && change.anchor) return insertAfterUniqueAnchor(source, change.anchor, change.before);
  return null;
}

export function insertAfterUniqueAnchor(source: string, anchor: string, insertion: string): string | null {
  const first = source.indexOf(anchor);
  if (first < 0 || source.indexOf(anchor, first + anchor.length) >= 0) return null;
  const end = first + anchor.length;
  return `${source.slice(0, end)}${insertion}${source.slice(end)}`;
}

function uniqueOccurrenceIndex(source: string, value: string): number | null {
  const first = source.indexOf(value);
  if (first < 0 || source.indexOf(value, first + value.length) >= 0) return null;
  return first;
}

/** Vá N1 (review attempt2): kiểm duy nhất của một dòng heading theo DÒNG,
 *  không phải substring như `uniqueOccurrenceIndex` — một heading cấp cha
 *  (`# Đăng ký`) LÀ substring của một heading cấp con cùng tiền tố
 *  (`## Đăng ký thành công`, ký tự `#` thứ hai + phần chữ trùng nhau), nên
 *  `source.indexOf("# Đăng ký")` tìm thấy nó ở CẢ HAI dòng và báo trùng giả.
 *  So khớp cả dòng (bằng đúng nội dung `headingLine`, không chứa ký tự xuống
 *  dòng) mới coi là một mục. Trả offset NGAY SAU nội dung dòng heading khớp
 *  (trước dấu xuống dòng theo sau nó) — cùng điểm chèn như
 *  `insertAfterUniqueAnchor` (`first + anchor.length`) để hai đường chèn cho
 *  cùng một kiểu kết quả.
 *
 *  Dùng `split(/(\r\n|\r|\n)/)` (giữ lại dấu xuống dòng ở các phần tử lẻ) để
 *  cộng dồn đúng độ dài từng dấu xuống dòng gốc (`\n` 1 ký tự, `\r\n` 2 ký
 *  tự) — không thể giả định đồng nhất kiểu `\r?\n` như khi chỉ ĐẾM dòng. */
function uniqueHeadingLineOffset(source: string, headingLine: string): number | null {
  const parts = source.split(/(\r\n|\r|\n)/);
  const matchedContentIndexes: number[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    if (parts[i] === headingLine) matchedContentIndexes.push(i);
  }
  if (matchedContentIndexes.length !== 1) return null;
  let offset = 0;
  for (let i = 0; i < matchedContentIndexes[0]!; i += 1) offset += parts[i]!.length;
  return offset + headingLine.length;
}

/** Chèn `insertion` ngay sau dòng heading duy nhất khớp `headingLine` (xem
 *  `uniqueHeadingLineOffset`) — dùng cho "Thêm sau mục…" (wp4.yaml mục 2)
 *  thay vì `insertAfterUniqueAnchor` (substring), giữ nguyên hành vi cũ của
 *  "Thêm sau đoạn chọn" (bôi đen) không đổi. */
function insertAfterHeadingLine(source: string, headingLine: string, insertion: string): string | null {
  const offset = uniqueHeadingLineOffset(source, headingLine);
  if (offset == null) return null;
  return `${source.slice(0, offset)}${insertion}${source.slice(offset)}`;
}

/** Pick a surviving, unique piece of text immediately before a deletion. It is
 * kept as the tombstone anchor so the deleted annotation remains visible. */
export function deletionAnchor(source: string, selected: string): string | null {
  const index = uniqueOccurrenceIndex(source, selected);
  if (index == null || index === 0) return null;
  const prefix = source.slice(0, index).trimEnd();
  for (const length of [120, 80, 48, 24]) {
    const candidate = prefix.slice(-length).trim();
    if (candidate && uniqueOccurrenceIndex(source, candidate) != null) return candidate;
  }
  const line = prefix.split(/\r?\n/).filter(Boolean).at(-1)?.trim();
  return line && uniqueOccurrenceIndex(source, line) != null ? line : null;
}

function uid(prefix: string): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return `${prefix}-${uuid ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
}

function eventFor(
  annotationId: string,
  type: DocReviewAnnotationEvent['type'],
  values: Pick<DocRedlineChange, 'before' | 'quote' | 'anchor'>,
): DocReviewAnnotationEvent {
  return {
    id: uid('event'),
    annotationId,
    type,
    actor: 'user',
    at: Date.now(),
    ...(values.before ? { before: values.before } : {}),
    ...(values.quote ? { quote: values.quote } : {}),
    ...(values.anchor ? { anchor: values.anchor } : {}),
  };
}

function sidecarJson(changes: DocRedlineChange[], events: DocReviewAnnotationEvent[]): string {
  // `change.origin` có thể là `'system'` (sơ đồ do một bước tự động sinh,
  // không phải LLM review) — `DocReviewAnnotationOrigin` trong
  // packages/contracts (KHÔNG được sửa ở WP này) nay đã khai `'agent'|'user'
  // |'system'` nên giá trị này gán thẳng được, không cần ép kiểu.
  const annotations: DocReviewAnnotationFileV2['annotations'] = changes.map((change) => ({
    ...change,
    origin: change.origin ?? 'agent',
    operation: change.operation ?? (change.before && change.quote ? 'edited' : change.quote ? 'add' : 'delete'),
    initialBefore: change.initialBefore ?? change.before,
    initialQuote: change.initialQuote ?? change.quote,
  }));
  const envelope: DocReviewAnnotationFileV2 = { schemaVersion: 2, annotations, events };
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

function changeOp(c: DocRedlineChange): 'add' | 'del' | 'edit' {
  if (c.before && c.quote) return 'edit';
  if (c.quote) return 'add';
  return 'del';
}

/** Một "Bảng thành phần" là change `kind: 'component'` KHÔNG có `before` (chỉ
 *  thêm mới) mà `rule_id` bắt đầu bằng `comp/` — phân biệt với change
 *  `component` "thường" (một chỗ sửa chữ nói về component, có `before`). */
function isComponentTableChange(c: Pick<DocRedlineChange, 'kind' | 'before' | 'rule_id'>): boolean {
  return c.kind === 'component' && !c.before && !!c.rule_id?.startsWith('comp/');
}

/** Cắt `text` còn tối đa `max` ký tự, thêm "…" khi có cắt — dùng cho tiêu đề
 *  thẻ (60 ký tự) và từng vế của dòng diff rút gọn (~40 ký tự). */
function truncateText(text: string, max: number): string {
  const flat = text.trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** Trích nội dung GIỮA cặp rào ```` ```mermaid ``` ```` của một change sơ đồ.
 *  `before`/`quote` của change `flow-diagram` là cả khối "rào + caption"
 *  (xem docblock đầu file WP3), nên phải cắt rào ra mới có mã mermaid thuần
 *  để đưa cho `MermaidDiagram`. Trả `null` khi không tìm thấy rào — dữ liệu
 *  không đúng khuôn thì không cố đoán, để chỗ gọi tự quyết định rơi về đâu. */
function extractMermaidFenceBody(text: string | undefined): string | null {
  if (!text) return null;
  const m = /```mermaid\r?\n([\s\S]*?)```/.exec(text);
  return m ? (m[1] ?? '').replace(/\s+$/, '') : null;
}

/** Một vế ngắn gọn cho dòng diff rút gọn của thẻ (dòng 2): với sơ đồ mermaid,
 *  chữ mermaid thô (`flowchart TD`, `A --> B`…) không đọc được ở dạng cắt 40
 *  ký tự, nên ưu tiên dòng caption ("Gốc"/"Đề xuất …") nếu `text` có rào
 *  mermaid; còn lại thì cắt thẳng, gộp khoảng trắng/xuống dòng thành một dòng. */
function diffPreviewSide(text: string | undefined, max = 40): string {
  if (!text) return '';
  const withoutFence = text.replace(/```mermaid\r?\n[\s\S]*?```/, '').trim();
  const flat = (withoutFence || text).replace(/\s+/g, ' ').replace(/^\*+|\*+$/g, '').trim();
  return truncateText(flat, max);
}

/** Vế caption RIÊNG cho thẻ sơ đồ (khác `diffPreviewSide` ở TRÊN, dùng cho mọi
 *  thẻ khác): khi không trích được caption (không có gì SAU rào ```mermaid```,
 *  xem docblock đầu file WP3) trả về `null` thay vì rơi về in nguyên mã mermaid
 *  thô — chỗ gọi (FlowDiagramCardBody) tự thay bằng chuỗi cố định (mục 0b, vá
 *  review WP3b: mã thô không đọc được ở dạng cắt 40 ký tự). */
function diagramCaption(text: string | undefined, max = 40): string | null {
  if (!text) return null;
  const withoutFence = text.replace(/```mermaid\r?\n[\s\S]*?```/, '').trim();
  if (!withoutFence) return null;
  const flat = withoutFence.replace(/\s+/g, ' ').replace(/^\*+|\*+$/g, '').trim();
  return flat ? truncateText(flat, max) : null;
}

/** Đúng 8 cột theo khuôn của bảng thành phần (xem docblock đầu file WP3):
 *  `# | Thành phần | Component DS | Biến thể | Vai trò / dùng để | Mô tả
 *  component | Điều hướng tới | Ghi chú`. Bỏ dòng heading và dòng gạch `---`,
 *  chỉ giữ các hàng DỮ LIỆU.
 *
 *  Vá B1 (review attempt2): tách theo dấu `|` CHƯA escape (lookbehind loại
 *  `\|`) rồi unescape `\|`→`|` trong từng ô — `buildComponentTableQuote` ghi
 *  `\|` khi một ô chứa dấu `|` thật (kể cả bảng do daemon sinh, xem
 *  `docs-review-enrich.ts`); tách thẳng theo `|` như trước sẽ xé một ô có
 *  `\|` thành hai, làm lệch cột và vỡ bảng khi lưu lại lần hai. */
function parseMarkdownTableDataRows(md: string): string[][] {
  const lines = md
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('|'));
  if (lines.length < 2) return [];
  return lines.slice(2).map((line) =>
    line
      .split(/(?<!\\)\|/)
      .slice(1, -1)
      .map((cell) => cell.trim().replace(/\\\|/g, '|')),
  );
}

/** Đếm N/M/K của một bảng thành phần từ nguyên văn `quote` (rào bảng nằm
 *  trong đó — xem docblock đầu file WP3): N = tổng hàng dữ liệu, K = hàng có
 *  cột "Component DS" đọc "— (DS không có)", M = N − K. */
function componentTableCounts(quote: string | undefined): { total: number; mapped: number; noDs: number } {
  const rows = parseMarkdownTableDataRows(quote ?? '');
  const noDs = rows.filter((row) => (row[2] ?? '').includes('DS không có')).length;
  return { total: rows.length, mapped: rows.length - noDs, noDs };
}

/** wp4.yaml mục 1: mọi PHẦN của một "Bảng thành phần" cần để sửa theo hàng rồi
 *  dựng lại nguyên văn — tiêu đề đậm, header, dòng gạch ngăn, các hàng dữ liệu
 *  (dùng lại `parseMarkdownTableDataRows`), và caption. `null` khi `quote`
 *  không đủ header+separator để coi là một bảng hợp lệ (không có gì sửa theo
 *  hàng được). */
interface ComponentTableParts {
  title: string;
  header: string;
  separator: string;
  rows: string[][];
  caption: string;
}
function parseComponentTableQuote(quote: string): ComponentTableParts | null {
  const trimmedLines = quote.split(/\r?\n/).map((line) => line.trim());
  const tableLines = trimmedLines.filter((line) => line.startsWith('|'));
  if (tableLines.length < 2) return null;
  const title = trimmedLines.find((line) => line.startsWith('**') && line.endsWith('**')) ?? '';
  // Caption: dòng nghiêng đơn `*...*` — KHÔNG phải tiêu đề đậm `**...**`. Lấy
  // dòng CUỐI khớp vì caption luôn đứng sau bảng (xem khuôn bảng ở docblock
  // đầu file WP3).
  const caption = [...trimmedLines].reverse().find((line) => line.startsWith('*') && !line.startsWith('**')) ?? '';
  return {
    title,
    header: tableLines[0]!,
    separator: tableLines[1]!,
    rows: parseMarkdownTableDataRows(quote),
    caption,
  };
}

/** Dựng lại nguyên văn `quote` từ các phần đã parse ở trên + danh sách hàng
 *  MỚI (đã sửa ô / gỡ hàng) — giữ nguyên tiêu đề đậm, header, dòng gạch ngăn,
 *  caption; escape `|` trong từng ô để không phá cú pháp bảng markdown khi
 *  người dùng gõ dấu `|` vào một ô. */
function buildComponentTableQuote(parts: ComponentTableParts, rows: string[][]): string {
  const escapeCell = (cell: string) => cell.replace(/\|/g, '\\|');
  const rowLines = rows.map((row) => `| ${row.map(escapeCell).join(' | ')} |`);
  const lines = [parts.title, '', parts.header, parts.separator, ...rowLines];
  if (parts.caption) lines.push('', parts.caption);
  return lines.join('\n');
}

/** N4 (non-blocking, review attempt2): tra chỉ số cột theo NHÃN header thay vì
 *  hard-code 4/7 — form "Sửa bảng" chỉ sửa được hai cột "Vai trò / dùng để" và
 *  "Ghi chú"; nếu bảng lệch thứ tự cột so với khuôn chuẩn thì vẫn tìm đúng cột
 *  qua tên thay vì đọc nhầm cột khác. `fallback` (4/7) giữ nguyên hành vi cũ
 *  khi header không khớp nhãn nào (dữ liệu không đúng khuôn). */
function tableColumnIndex(header: string | null, label: string, fallback: number): number {
  if (!header) return fallback;
  const cells = header
    .split(/(?<!\\)\|/)
    .slice(1, -1)
    .map((cell) => cell.trim().replace(/\\\|/g, '|'));
  const idx = cells.indexOf(label);
  return idx >= 0 ? idx : fallback;
}

/** Tiêu đề dòng 1 của thẻ (mặt thẻ, không phải Chi tiết): hai loại thẻ MỚI có
 *  tiêu đề CỐ ĐỊNH tả đúng hành động ("Thay sơ đồ…", "Chèn bảng N…") thay vì
 *  cắt `reason` — `reason` của chúng nói vì sao rà soát lại sơ đồ/bảng, không
 *  tả chỗ sửa này LÀM GÌ, nên cắt nó vào tiêu đề sẽ khó hiểu hơn câu cố định. */
function cardTitle(c: DocRedlineChange): string {
  if (c.kind === 'flow-diagram') return 'Thay sơ đồ bằng bản đề xuất';
  if (isComponentTableChange(c)) return `Chèn bảng ${componentTableCounts(c.quote).total} thành phần`;
  return truncateText(c.reason, 60);
}

/** Nền vùng bôi đặt thẳng trong thuộc tính style thay vì chỉ dựa vào class:
 *  vùng bôi là thông tin chính của màn hình này, không nên phụ thuộc vào việc
 *  CSS Module có tới nơi hay không. Class vẫn giữ để lo bo góc/con trỏ/trạng
 *  thái chọn. */
const HL_INLINE_STYLE = 'background-color:rgba(245,158,11,.38);outline:1px solid rgba(245,158,11,.85);border-radius:3px;cursor:pointer';
/** Vùng neo của một NOTE bôi khác vùng bôi của một change: change là "đã sửa"
 *  (vàng), note là "cần bàn" (tím) — hai loại thông tin khác nhau thì không
 *  được trông giống nhau, nếu không người đọc tưởng note cũng đã được sửa. */
const NOTE_HL_INLINE_STYLE = 'background-color:rgba(139,92,246,.30);outline:1px dashed rgba(139,92,246,.85);border-radius:3px;cursor:pointer';
/** Chỗ THÊM bôi xanh, không vàng như chỗ sửa: vàng nói "câu này đã bị đụng
 *  vào" — đọc một câu MỚI thì không có "chữ cũ" nào để đối chiếu, nên chú ý cần
 *  bỏ ra khác nhau. Class + style nội tuyến song song, cùng lý do như
 *  HL_INLINE_STYLE ngay trên. */
const HL_ADD_INLINE_STYLE = 'background-color:rgba(34,197,94,.28);outline:1px solid rgba(34,197,94,.85);border-radius:3px;cursor:pointer';
/** Chỗ XOÁ bôi đỏ nhạt. Nhạt hơn hai loại trên vì đây là chữ CHÈN THÊM vào bản
 *  đã sửa (nó không còn trong tài liệu) — nó phải đọc được nhưng không được
 *  tranh chỗ với bản mới. Gạch ngang do `<del>` bên trong lo (xem .hlDel). */
const HL_DEL_INLINE_STYLE = 'background-color:rgba(239,68,68,.18);outline:1px solid rgba(239,68,68,.7);border-radius:3px;cursor:pointer';
/** Bốn loại vùng bôi người dùng bật/tắt được, đúng bốn màu trên màn hình.
 *  `ref` (đoạn được viện dẫn) CỐ Ý không nằm ở đây: nó là phương tiện điều
 *  hướng chứ không phải một loại sửa đổi, và cửa sổ tham chiếu dựa vào nó để
 *  chỉ ra chỗ cần xem. */
export type PaintKind = 'add' | 'edit' | 'del' | 'note';
export type PaintFlags = Record<PaintKind, boolean>;
const ALL_PAINTED: PaintFlags = { add: true, edit: true, del: true, note: true };

/** Nhãn + class ô màu của từng bộ lọc, theo đúng thứ tự đọc: thêm → sửa → xoá
 *  → cần bàn. Giữ ở một chỗ để chú thích màu và bộ lọc không thể lệch nhau —
 *  chúng vốn LÀ một thứ (xem HighlightFilters). */
const PAINT_ITEMS: ReadonlyArray<{ kind: PaintKind; label: string; swatch: string }> = [
  { kind: 'add', label: 'Thêm', swatch: styles.legendSwatchAdd ?? '' },
  { kind: 'edit', label: 'Sửa', swatch: styles.legendSwatchChange ?? '' },
  { kind: 'del', label: 'Xoá', swatch: styles.legendSwatchDel ?? '' },
  { kind: 'note', label: 'Cần bàn', swatch: styles.legendSwatchNote ?? '' },
];

/** Kiểu vùng bôi khi người dùng TẮT tô màu: mark vẫn còn trong DOM (bấm được,
 *  vẫn neo được thẻ bên phải) nhưng không sơn gì — chỉ giữ con trỏ để người
 *  dùng biết chỗ đó bấm được. */
// Cùng lý do reset nền như HL_REF_INLINE_STYLE bên dưới: mark "tắt màu" mà
// không reset thì lại ăn nền vàng chói mặc định — tắt hoá ra bật.
const HL_OFF_INLINE_STYLE = 'background-color:transparent;color:inherit;cursor:pointer';
/** Chỗ xoá khi tắt tô màu: bỏ nền đỏ nhưng GIỮ gạch ngang (do `<del>` lo), vì
 *  gạch ngang là thứ duy nhất phân biệt chữ đã bị bỏ với chữ đang có thật. */
const HL_DEL_OFF_INLINE_STYLE = 'cursor:pointer;opacity:.65';
const NO_CHANGES: DocRedlineChange[] = [];
const NO_NOTES: DocRedlineNote[] = [];
/** Change và note dùng chung `data-change-id` (chung cơ chế click/cuộn/nháy
 *  sáng), nên id của note phải không đụng id của change — chúng đến từ hai file
 *  khác nhau và trùng "n1"/"c1" là chuyện hoàn toàn có thể. */
const NOTE_ID_PREFIX = 'note:';
/** Vùng ĐƯỢC VIỆN DẪN bởi một lý do (`doc_refs`) — id mark có dạng
 *  `ref:<ownerId>:<i>`, với ownerId là id của change hoặc `note:<id>`. */
const REF_ID_PREFIX = 'ref:';
/** Vùng viện dẫn KHÔNG có nền, chỉ gạch chấm dưới chữ: nó không phải chỗ sửa
 *  mà là bằng chứng cho một chỗ sửa ở nơi khác. Cho nó nền như ba loại kia thì
 *  người đọc đếm nhầm số chỗ đã đụng vào tài liệu. */
// PHẢI reset background: <mark> có nền VÀNG CHÓI mặc định của trình duyệt —
// không reset thì vùng tham chiếu (vốn chỉ là gạch chân chấm xanh) trông y hệt
// một vùng bôi lỗi, người đọc đi tìm số thứ tự không bao giờ có.
const HL_REF_INLINE_STYLE = 'background-color:transparent;color:inherit;border-bottom:1px dotted rgba(59,130,246,.85);cursor:pointer';
const EMPTY_SET: ReadonlySet<string> = new Set<string>();

function annotationScope(annotation: {
  sectionIndex?: number;
  sectionHeading?: string;
  sectionStartHeadingOrdinal?: number;
  sectionEndHeadingOrdinalExclusive?: number;
}): HighlightScope | undefined {
  if (
    annotation.sectionIndex == null
    && annotation.sectionHeading == null
    && annotation.sectionStartHeadingOrdinal == null
    && annotation.sectionEndHeadingOrdinalExclusive == null
  ) return undefined;
  return {
    sectionIndex: annotation.sectionIndex,
    sectionHeading: annotation.sectionHeading,
    sectionStartHeadingOrdinal: annotation.sectionStartHeadingOrdinal,
    sectionEndHeadingOrdinalExclusive: annotation.sectionEndHeadingOrdinalExclusive,
  };
}

/** Nhãn dễ hiểu + lời giải thích của một tiêu chí. Chip hiện `label`, rê chuột
 *  hiện `summary`, bấm vào mở popover hiện `detail`. Ba mức dài dần cho cùng
 *  một ý: liếc qua → hiểu đại khái → đọc đủ. */
interface RuleMeta {
  /** 2–4 chữ hiện trên chip — người không đọc tài liệu kỹ thuật vẫn hiểu. */
  label: string;
  /** MỘT câu cho tooltip khi rê chuột. */
  summary: string;
  /** Đoạn giải thích đầy đủ trong popover, viết theo giọng nói-cho-người-thường. */
  detail: string;
}

/** Bảy tiêu chí MẶC ĐỊNH của skill (khi dự án không có `criteria/`).
 *  Chép ý từ mục "Bộ tiêu chí mặc định" trong
 *  `skills/docs-spec-review/SKILL.md` — sửa bên đó thì sửa cả ở đây.
 *
 *  Vì sao chép chứ không đọc file skill: skill nằm trong repo, không nằm trong
 *  project của người dùng, nên trình duyệt không có đường nào lấy được nó. Bảy
 *  mục này ngắn và gần như không đổi; đánh đổi đó rẻ hơn việc thêm một endpoint
 *  chỉ để phục vụ một popover.
 *
 *  Chữ ở đây CỐ Ý không dùng từ nghề (state, validation, edge case): người đọc
 *  màn hình review là người viết tài liệu nghiệp vụ, không phải người viết mã.
 *  Nguyên văn rule kỹ thuật vẫn còn — nó nằm trong mã `rule_id` hiện ở popover. */
const DEFAULT_RULE_META: Record<string, RuleMeta> = {
  'ux-writing-chu-ngu': {
    label: 'Câu thiếu chủ ngữ',
    summary: 'Câu không nói rõ ai là người làm việc này.',
    detail:
      'Câu không cho biết ai thực hiện hành động — chủ ngữ bị lược đi, hoặc câu viết theo lối bị động nên không rõ người dùng, nhân viên hay hệ thống mới là bên làm. Người đọc phải tự đoán, và mỗi người đoán một kiểu.',
  },
  'ux-writing-thuat-ngu': {
    label: 'Thuật ngữ không nhất quán',
    summary: 'Cùng một thứ nhưng mỗi chỗ gọi một tên khác nhau.',
    detail:
      'Cùng một khái niệm được gọi bằng nhiều tên khác nhau trong cùng một trang — chỗ này "khách hàng", chỗ kia "người dùng", chỗ nữa "tài khoản". Người đọc không biết đó là ba thứ khác nhau hay chỉ là một thứ được gọi ba kiểu.',
  },
  'ux-writing-viet-tat': {
    label: 'Viết tắt không giải nghĩa',
    summary: 'Chữ viết tắt xuất hiện mà không nói nó là gì.',
    detail:
      'Một cụm viết tắt xuất hiện lần đầu mà không có chỗ nào nói nó là gì. Người mới đọc tài liệu không đoán ra, còn người quen việc thì mỗi người hiểu một nghĩa.',
  },
  'ux-writing-nhan-nut': {
    label: 'Nhãn nút mơ hồ',
    summary: 'Chữ trên nút hoặc thông báo không nói rõ chuyện gì xảy ra.',
    detail:
      'Chữ trên nút hoặc trong thông báo không cho biết bấm vào thì điều gì xảy ra, hoặc vừa có chuyện gì và bây giờ phải làm sao — ví dụ nút chỉ ghi "OK", hay báo "Thao tác thất bại" mà không nói hỏng ở đâu và cần làm gì tiếp.',
  },
  flow: {
    label: 'Luồng thiếu đầu/cuối',
    summary: 'Luồng không rõ bắt đầu từ đâu hoặc kết thúc thế nào.',
    detail:
      'Một luồng người dùng không nói rõ nó bắt đầu từ đâu và kết thúc ở đâu, hoặc có bước chỉ tả thao tác mà không cho biết sau đó màn hình hiện gì, người dùng đi tiếp tới đâu. Ai làm theo tài liệu sẽ dừng giữa chừng vì không biết bước sau là gì.',
  },
  gap: {
    label: 'Mô tả chưa đầy đủ',
    summary: 'Có nhắc tới nhưng không tả nó hoạt động ra sao.',
    detail:
      'Tài liệu có nhắc tới một tính năng, một màn hình hay một chỗ nối với hệ thống khác, nhưng không tả nó chạy thế nào — hoặc gọi tên rồi để đó, không có mục nào mô tả tiếp. Người đọc biết là có thứ đó, nhưng không đủ để làm ra nó.',
  },
  'edge-case': {
    label: 'Thiếu trường hợp biên',
    summary: 'Chưa nói điều gì xảy ra khi thao tác không suôn sẻ.',
    detail:
      'Tài liệu chưa nói điều gì xảy ra khi thao tác không suôn sẻ: gặp lỗi thì hiện gì, danh sách rỗng thì sao, đang tải hiển thị thế nào, và dữ liệu nhập có giới hạn gì (độ dài, số lượng, định dạng).',
  },
};

/** Nhãn + lời tóm tắt hiện trên CHIP của một `rule_id`.
 *
 *  Chip từng hiện nguyên mã (`default#edge-case`, `criteria/rules.md#R-OVERLAY`):
 *  đúng nhưng phải biết trước mã đó nghĩa gì mới đọc được, mà người review tài
 *  liệu thì không. Mã đầy đủ không mất đi — nó xuống dòng nhỏ trong popover để
 *  còn trace ngược về file criteria.
 *
 *  Rule của dự án chỉ hiện phần sau dấu `#`: tên file criteria là chuyện của
 *  người viết bộ tiêu chí, còn thứ nhận dạng được một rule là cái anchor. */
function ruleChipMeta(ruleId: string): { label: string; summary: string } {
  if (ruleId.startsWith('default#')) {
    const meta = DEFAULT_RULE_META[ruleId.slice('default#'.length)];
    if (meta) return { label: meta.label, summary: meta.summary };
  }
  const anchor = /^criteria\/[^#]+#(.+)$/.exec(ruleId)?.[1];
  if (anchor) return { label: anchor, summary: 'Tiêu chí riêng của dự án — bấm để xem nội dung' };
  // Sơ đồ mermaid được viết lại sau rà soát UX (WP1/WP2 ghi `rule_id` dạng
  // này, không có dấu `#`) — cùng lý do như hai nhánh trên: chip hiện nhãn dễ
  // hiểu, đường dẫn kỹ thuật đầy đủ chỉ còn trong popover.
  if (/^flows\/[^/]+\/ux-review\.json$/.test(ruleId)) {
    return { label: 'Đánh giá luồng', summary: 'Sơ đồ được cập nhật theo bản đề xuất sau rà soát UX' };
  }
  // Bảng thành phần đối chiếu Design System cho một màn hình.
  if (/^comp\/[^/]+\.screen\.json$/.test(ruleId)) {
    return { label: 'Màn hình → Component', summary: 'Bảng thành phần đối chiếu với Design System của màn hình' };
  }
  // Mã lạ (dữ liệu cũ, hoặc một skill khác ghi ra): hiện nguyên văn còn hơn
  // gán cho nó một nhãn bịa ra không ứng với gì.
  return { label: ruleId, summary: 'Bấm để xem nội dung tiêu chí' };
}

/** Cắt đúng phần văn bản của một rule ra khỏi một file `criteria/*.md`.
 *
 *  Quy ước anchor PHẢI trùng với `collectCriteriaAnchors` phía daemon
 *  (apps/daemon/src/docs-review.ts): mọi token trong dấu backtick trên một dòng
 *  heading là một anchor, dấu `#` đứng đầu token bị bỏ. Lệch quy ước ở đây
 *  nghĩa là daemon chấp nhận một `rule_id` mà popover lại báo không tìm thấy —
 *  cùng một dữ liệu cho hai câu trả lời khác nhau.
 *
 *  Phần cắt chạy từ dòng heading đó tới TRƯỚC heading tiếp theo có cấp bằng
 *  hoặc nông hơn, nên rule con nằm trong rule cha vẫn đi theo cha. */
export function extractRuleSection(md: string, anchor: string): string | null {
  const lines = md.split(/\r?\n/);
  const headingLevel = (line: string): number => /^(#{1,6})\s/.exec(line)?.[1]?.length ?? 0;
  let start = -1;
  let startLevel = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const level = headingLevel(line);
    if (level === 0) continue;
    const tokens: string[] = [];
    const tokenRe = /`([^`]+)`/g;
    for (let m = tokenRe.exec(line); m; m = tokenRe.exec(line)) {
      const token = (m[1] ?? '').trim().replace(/^#/, '');
      if (token) tokens.push(token);
    }
    if (tokens.includes(anchor)) {
      start = i;
      startLevel = level;
      break;
    }
  }
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    const level = headingLevel(lines[i]!);
    if (level > 0 && level <= startLevel) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n').trim() || null;
}

/** Nhãn ngắn cho nút tham chiếu — đoạn viện dẫn có thể dài cả ô bảng. */
function refLabel(ref: string): string {
  const flat = ref.replace(/\s+/g, ' ').trim();
  return flat.length > 40 ? `${flat.slice(0, 40)}…` : flat;
}

/** Bật/tắt một class CSS Module trên phần tử, BỎ QUA khi tên class rỗng.
 *
 *  Vì sao phải có: `styles.x` có kiểu `string | undefined`, nên khắp file này
 *  viết `styles.x ?? ''` để thoả kiểu — nhưng `classList.add('')` và
 *  `classList.toggle('', …)` KHÔNG phải no-op, chúng ném `SyntaxError`
 *  ("The token provided must not be empty"). Ném giữa chừng một trình xử lý
 *  click sẽ bỏ dở phần việc còn lại của cú click đó. Một class không tới nơi
 *  chỉ được phép làm mất phần trang trí, không được làm hỏng tương tác. */
function setClass(el: HTMLElement, className: string, on: boolean): void {
  if (!className) return;
  el.classList.toggle(className, on);
}

/** Key localStorage nhớ trạng thái right panel giữa các phiên (mục 6 WP3). */
const PANEL_STORAGE_KEY = 'od.docRedline.panel';
function readStoredPanelOpen(fallback: boolean): boolean {
  try {
    const saved = window.localStorage.getItem(PANEL_STORAGE_KEY);
    if (saved === 'open') return true;
    if (saved === 'closed') return false;
  } catch {
    // localStorage có thể bị chặn (chế độ riêng tư, iframe sandbox) — rơi về
    // mặc định thay vì vỡ màn hình.
  }
  return fallback;
}
function writeStoredPanelOpen(open: boolean): void {
  try {
    window.localStorage.setItem(PANEL_STORAGE_KEY, open ? 'open' : 'closed');
  } catch {
    // Cùng lý do như readStoredPanelOpen — ghi thất bại thì panel vẫn đổi
    // trong phiên này, chỉ không nhớ được qua lần tải lại.
  }
}

export function DocRedlinePreview({
  projectId,
  file,
  // Spec (wp3.yaml): "Quick result mặc định ẩn, workspace mặc định hiện — nếu
  // không xác định được nơi gọi thì mặc định hiện và ghi report." `FileViewer`
  // (nơi DUY NHẤT dựng component này) không mang prop nào phân biệt được nó
  // đang ở trong khung Quick result hay workspace — phân biệt được đòi dò
  // ngược MỌI nơi gọi `<FileViewer>` trong app, ngoài phạm vi `touches` của WP
  // này (chỉ được sửa bảng DocsSpecReviewIndex). Rơi về nhánh "không xác định
  // được": mặc định `true` (hiện) cho MỌI ngữ cảnh — xem `not_done` trong báo
  // cáo WP3.
  defaultPanelOpen = true,
}: { projectId: string; file: ProjectFile; defaultPanelOpen?: boolean }) {
  const [editedText, setEditedText] = useState<string | null>(null);
  const [changesState, setChangesState] = useState<ChangesState>({ status: 'loading' });
  const [notes, setNotes] = useState<DocRedlineNote[]>(NO_NOTES);
  const [notesRaw, setNotesRaw] = useState<string | null>(null);
  const [changesRaw, setChangesRaw] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [errorById, setErrorById] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState<DraftAnnotation | null>(null);
  const [draftError, setDraftError] = useState('');
  // wp4.yaml mục 2: "Thêm sau mục…" — picker liệt kê heading của tài liệu,
  // tách khỏi `draft`/`draftError` vì nó là một bước CHỌN anchor, không phải
  // composer (composer mở SAU khi đã chọn xong, dùng lại y hệt `draft`).
  const [headingPickerOpen, setHeadingPickerOpen] = useState(false);
  const [headingPickerValue, setHeadingPickerValue] = useState('');
  // Snapshot markdown trước khi bỏ cho phép hoàn tác an toàn trong phiên này;
  // reload sẽ xoá snapshot, tránh áp lại một bản tài liệu đã cũ.
  const [undoableIds, setUndoableIds] = useState<Set<string>>(new Set());
  const undoTextRef = useRef<Map<string, string>>(new Map());
  const [previewMode, setPreviewMode] = useState<PreviewMode>('changes');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const pendingSelectionRef = useRef<{ id: string; source: 'document' | 'rail' } | null>(null);
  const docColRef = useRef<HTMLDivElement | null>(null);
  // Mọi <mark> của một change: một quote trải trên nhiều text node (ví dụ băng
  // qua <strong>, hoặc hai ô bảng liền nhau) bọc thành nhiều <mark> cùng
  // `data-change-id`.
  const marksByChangeRef = useRef<Map<string, HTMLElement[]>>(new Map());
  // Phần tử mục trong rail, theo change id — dùng để cuộn rail tới mục tương
  // ứng khi người dùng bấm một vùng bôi trong tài liệu.
  const itemsByChangeRef = useRef<Map<string, HTMLElement>>(new Map());
  // Popover nội dung rule: mở tối đa MỘT cái, khoá theo id thẻ đang mở.
  const [openRule, setOpenRule] = useState<{ ownerId: string; ruleId: string } | null>(null);
  const [ruleBody, setRuleBody] = useState<RuleBody>({ status: 'loading' });
  // Một file criteria được nhiều rule dùng chung; đọc lại mỗi lần mở popover là
  // lãng phí và làm popover chớp. `null` trong cache = đã hỏi và không có file.
  const criteriaCacheRef = useRef<Map<string, string | null>>(new Map());
  // Cửa sổ xem đoạn được viện dẫn: `markId` là mark cần cuộn tới trong BẢN SAO
  // tài liệu dựng riêng cho modal, `label` là nguyên văn đoạn đó (hiện ở đầu
  // cửa sổ để người đọc biết mình đang được chỉ tới cái gì).
  const [refModal, setRefModal] = useState<{ markId: string; label: string } | null>(null);
  const modalDocRef = useRef<HTMLDivElement | null>(null);

  function changePreviewMode(mode: PreviewMode) {
    if (mode === previewMode) return;
    pendingSelectionRef.current = null;
    setSelectedId(null);
    setPreviewMode(mode);
  }
  // Bật/tắt tô màu THEO TỪNG LOẠI. Một công tắc chung là chưa đủ: việc thật của
  // người review là "cho tôi xem riêng chỗ bị xoá" hay "ẩn mấy chỗ thêm chữ đi",
  // chứ không phải bật/tắt toàn bộ màu. Mặc định bật hết — đó là lý do màn hình
  // này tồn tại.
  const [paint, setPaint] = useState<PaintFlags>(ALL_PAINTED);
  const setPaintKind = (kind: PaintKind, on: boolean) => setPaint((prev) => ({ ...prev, [kind]: on }));
  // Chip lọc RIÊNG cho "Sơ đồ"/"Bảng thành phần" (mục 7 WP3) — khác PaintFlags
  // ngay trên: đây là lọc THEO KIND (ẩn/hiện MỤC trong rail), không phải lọc
  // theo màu vùng bôi trong tài liệu (marks vẫn tô đúng theo add/edit như cũ,
  // xem docRender) — cách đơn giản nhất không phải mở rộng PaintKind/pipeline
  // bôi màu để phục vụ đúng hai chip mới.
  const [kindFilter, setKindFilterState] = useState<{ diagram: boolean; compTable: boolean }>({
    diagram: true,
    compTable: true,
  });
  // Trạng thái "mở Chi tiết" của thẻ sơ đồ / bảng thành phần (kiểu 3-dòng mới
  // — xem FlowDiagramCardBody/ComponentTableCardBody). Không tồn tại cho các
  // loại thẻ CŨ (chúng giữ nguyên hiển thị đầy đủ như trước WP này, xem
  // ChangeDetail), nên chỉ hai loại thẻ đó đọc map này.
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  function toggleExpanded(id: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  // "Chấp nhận" của thẻ sơ đồ/bảng thành phần: đánh dấu TRONG PHIÊN NÀY, không
  // ghi ra `*.changes.json` — `DocReviewAnnotationStatus` (packages/contracts,
  // KHÔNG được sửa ở WP này) chỉ biết 'active'|'edited'|'dismissed', không có
  // 'accepted'. "Không đổi text tài liệu" theo đúng yêu cầu; mất khi tải lại
  // trang là đánh đổi đã biết, ghi trong report.
  const [acceptedIds, setAcceptedIds] = useState<Set<string>>(new Set());
  function acceptChange(id: string) {
    setAcceptedIds((prev) => new Set(prev).add(id));
  }

  // ── Right panel ẩn/hiện (mục 6 WP3) ───────────────────────────────────────
  // localStorage NHỚ giữa các phiên; `defaultPanelOpen` (prop) chỉ có tác dụng
  // khi localStorage CHƯA có key này — người dùng đã tự chọn một lần thì nhớ
  // lựa chọn đó, kể cả khi trang gọi lại với default khác.
  const [panelOpen, setPanelOpenState] = useState<boolean>(() => readStoredPanelOpen(defaultPanelOpen));
  // `selectFromDoc` (đọc panelOpen để quyết định có tự mở panel không) được
  // GỌI TỪ MỘT CLOSURE CŨ: effect uỷ quyền click trên cột tài liệu chỉ đăng ký
  // MỘT lần (deps `[loading]`, xem effect đó) nên hàm `fn` nó giữ mãi bản
  // `selectFromDoc` của đúng LƯỢT RENDER lúc đăng ký — đọc thẳng biến
  // `panelOpen` ở đó sẽ luôn thấy giá trị CŨ dù panel đã đổi sau đó. Ref luôn
  // đọc được giá trị MỚI NHẤT bất kể closure nào giữ nó, cùng lý do
  // `itemsByChangeRef`/`marksByChangeRef` ở trên là ref chứ không phải state.
  const panelOpenRef = useRef(panelOpen);
  useEffect(() => {
    panelOpenRef.current = panelOpen;
  }, [panelOpen]);
  function togglePanel() {
    setPanelOpenState((prev) => {
      const next = !prev;
      writeStoredPanelOpen(next);
      return next;
    });
  }
  function openPanel() {
    setPanelOpenState((prev) => {
      if (prev) return prev;
      writeStoredPanelOpen(true);
      return true;
    });
  }
  // Phím tắt `]` — CHỈ khi tiêu điểm không nằm trong ô nhập, để không nuốt mất
  // dấu `]` người dùng gõ trong textarea lý do/nội dung sửa. Đăng ký MỘT lần
  // (deps rỗng) và dùng cập nhật hàm (setPanelOpenState(prev => …)) để không
  // phải đăng ký lại mỗi lần panelOpen đổi.
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== ']') return;
      const active = document.activeElement as HTMLElement | null;
      const tag = active?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || active?.isContentEditable) return;
      togglePanel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let cancelled = false;
    setEditedText(null);
    void fetchProjectFileText(projectId, file.name).then((next) => {
      if (!cancelled) setEditedText(next ?? '');
    });
    return () => {
      cancelled = true;
    };
  }, [projectId, file.name, file.mtime]);

  useEffect(() => {
    let cancelled = false;
    setChangesState({ status: 'loading' });
    // `file.name` is already project-root-relative (e.g.
    // `docs-review/review/docs/confluence/x.md`), so swapping the extension
    // is enough — no directory prefix to reconstruct.
    const changesName = file.name.replace(/\.md$/i, '.changes.json');
    void fetchProjectFileText(projectId, changesName).then((raw) => {
      if (cancelled) return;
      if (raw == null) {
        setChangesState({ status: 'none' });
        return;
      }
      const parsed = parseDocChangesFile(raw);
      setChangesRaw(raw);
      setChangesState(parsed == null
        ? { status: 'malformed' }
        : { status: 'ok', changes: parsed.changes, events: parsed.events });
    });
    return () => {
      cancelled = true;
    };
  }, [projectId, file.name, file.mtime]);

  const changes = useMemo(
    () => (changesState.status === 'ok' ? changesState.changes : NO_CHANGES),
    [changesState],
  );
  const events = useMemo(
    () => (changesState.status === 'ok' ? changesState.events : []),
    [changesState],
  );
  // wp4.yaml mục 2: danh sách heading cho "Thêm sau mục…" — theo `editedText`
  // (bản ĐÃ SỬA, giống mọi anchor khác trong file này).
  const headings = useMemo(() => parseDocHeadings(editedText ?? ''), [editedText]);

  // `<page>.notes.json` — nhận xét không sửa trực tiếp. Không có file thì bỏ
  // qua IM LẶNG (đúng khuôn 404 của ChangesState): một trang review từ trước
  // khi có notes, hay một trang không có nhận xét nào, đều không phải lỗi.
  useEffect(() => {
    let cancelled = false;
    setNotes(NO_NOTES);
    const notesName = file.name.replace(/\.md$/i, '.notes.json');
    void fetchProjectFileText(projectId, notesName).then((raw) => {
      if (cancelled || raw == null) return;
      const parsed = parseDocNotes(raw);
      setNotesRaw(raw); if (parsed && parsed.length > 0) setNotes(parsed);
    });
    return () => {
      cancelled = true;
    };
  }, [projectId, file.name, file.mtime]);

  // Nạp nội dung rule cho popover đang mở. Bộ mặc định (`default#…`) trả lời
  // ngay từ hằng trong file này; rule của dự án phải đọc file `criteria/…` nằm
  // cạnh thư mục `review/` — `file.name` có dạng
  // `<stage>/review/docs/…/x.md` nên phần trước `/review/` chính là thư mục
  // stage, không cần dựng lại đường dẫn từ đâu khác.
  useEffect(() => {
    if (!openRule) return;
    let cancelled = false;
    const { ruleId } = openRule;
    setRuleBody({ status: 'loading' });

    if (ruleId.startsWith('default#')) {
      const meta = DEFAULT_RULE_META[ruleId.slice('default#'.length)];
      setRuleBody(meta ? { status: 'text', text: meta.detail } : { status: 'missing' });
      return;
    }
    const m = /^criteria\/([^#]+)#(.+)$/.exec(ruleId);
    if (!m) {
      setRuleBody({ status: 'missing' });
      return;
    }
    const [, criteriaFile, anchor] = m as unknown as [string, string, string];
    const stagePrefix = file.name.split('/review/')[0] ?? '';
    const criteriaPath = `${stagePrefix}/criteria/${criteriaFile}`;

    const apply = (raw: string | null) => {
      if (cancelled) return;
      const section = raw == null ? null : extractRuleSection(raw, anchor);
      setRuleBody(section ? { status: 'html', html: renderMarkdownToSafeHtml(section) } : { status: 'missing' });
    };

    const cached = criteriaCacheRef.current;
    if (cached.has(criteriaPath)) {
      apply(cached.get(criteriaPath) ?? null);
      return;
    }
    void fetchProjectFileText(projectId, criteriaPath).then((raw) => {
      cached.set(criteriaPath, raw ?? null);
      apply(raw ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [openRule, projectId, file.name]);

  /** Mở/đóng popover của một thẻ. Bấm lại đúng thẻ đang mở là đóng — không cần
   *  nút đóng riêng cho một khối chữ ngắn. */
  function toggleRule(ownerId: string, ruleId: string) {
    setOpenRule((prev) => (prev && prev.ownerId === ownerId ? null : { ownerId, ruleId }));
  }

  // Bôi highlight NGAY TRONG chuỗi HTML, trước khi React nhận. Trước đây bước
  // này là một useEffect mổ DOM sau khi render; cách đó phụ thuộc ref đã gắn
  // chưa, thứ tự effect, và việc React có dựng lại nút hay không — ba đường
  // hỏng âm thầm đã thực sự xảy ra. Ở đây mark là một phần của HTML mà React
  // render ra, nên không có khoảnh khắc nào nó chưa tồn tại.
  const docRender = useMemo(() => {
    if (editedText === null) return null;
    // Ảnh nhúng (docs/confluence/*.md → ../attachments/*.png) phải trỏ về URL
    // raw của project, giống hệt MarkdownViewer, nếu không ảnh vỡ hết.
    const html = renderMarkdownToSafeHtml(inlineMarkdownImages(editedText, projectId, file.name));
    // `quote` là nguyên văn mã nguồn markdown còn HTML đã render không còn cú
    // pháp đó, nên phải cắt qua quoteSegments trước (xem chú thích hàm đó).
    // Màu đi THEO TỪNG request, không theo lượt: thêm (xanh) và sửa (vàng) phải
    // bôi trong CÙNG một lượt, vì lượt sau luôn dò trên HTML đã có mark của
    // lượt trước và một đoạn nằm sát chỗ đã bôi sẽ trượt.
    const requests = changes.flatMap((c) => {
      if (previewMode !== 'changes') return [];
      if (c.status === 'dismissed') return [];
      // B2 (wp3b.yaml): sơ đồ mermaid đã được neo bằng HOST MARK riêng (xem
      // effect chèn host bên dưới — khớp theo NGUYÊN VĂN mã mermaid, không
      // theo đoạn chữ), nên KHÔNG đưa segment chữ của `quote` vào injectHighlights
      // nữa. Dòng đầu của mọi flowchart thường giống hệt nhau ("flowchart
      // TD") — injectHighlights luôn dò lại từ ĐẦU tài liệu cho mỗi request
      // (không nhớ đã dùng tới đâu), nên hai sơ đồ cùng dòng đầu từng khiến
      // mark chữ của sơ đồ thứ hai khớp NHẦM vào khối của sơ đồ thứ nhất.
      // `isAnchored`/`selectFromList` phía dưới coi sơ đồ có host là neo được,
      // không cần dựa vào `matched` của lượt bôi này nữa.
      if (c.kind === 'flow-diagram') return [];
      const raw = (c.quote ?? '').trim();
      if (!raw) return [];
      const add = changeOp(c) === 'add';
      // Tắt tô màu KHÔNG có nghĩa là bỏ chèn mark: mark vẫn phải nằm trong DOM
      // thì thẻ bên phải mới còn neo được (bấm để nhảy) và mới không bị tụt
      // xuống nhóm "không tìm thấy trong tài liệu". Chỉ phần SƠN bị gỡ.
      const on = add ? paint.add : paint.edit;
      const className = !on ? styles.hlOff ?? '' : add ? styles.hlAdd ?? '' : styles.hl ?? '';
      const inlineStyle = !on ? HL_OFF_INLINE_STYLE : add ? HL_ADD_INLINE_STYLE : HL_INLINE_STYLE;
      return quoteSegments(raw).map((text) => ({ id: c.id, text, className, inlineStyle, scope: annotationScope(c) }));
    });
    const changePass = injectHighlights(html, requests, styles.hl ?? '', HL_INLINE_STYLE);

    // Lượt thứ hai cho NOTE, trên HTML đã bôi change: `anchor` lấy từ bản GỐC
    // nên thường vẫn còn nguyên trong bản đã sửa (note không sửa gì). Id mang
    // tiền tố `note:` để không đụng id của change — cả hai loại mark dùng
    // chung `data-change-id`, chung cơ chế click/cuộn.
    const noteRequests = notes.flatMap((n) => {
      if (previewMode !== 'notes') return [];
      if (n.status === 'dismissed') return [];
      const raw = (n.anchor ?? '').trim();
      if (!raw) return [];
      return quoteSegments(raw).map((text) => ({
        id: `${NOTE_ID_PREFIX}${n.id}`,
        text,
        className: paint.note ? styles.hlNote ?? '' : styles.hlOff ?? '',
        inlineStyle: paint.note ? NOTE_HL_INLINE_STYLE : HL_OFF_INLINE_STYLE,
        scope: annotationScope(n),
      }));
    });
    const notePass = injectHighlights(changePass.html, noteRequests, styles.hlNote ?? '', NOTE_HL_INLINE_STYLE);

    // Lượt thứ BA: chỗ xoá thuần. Chạy CUỐI cùng vì nó thêm chữ mới vào tài
    // liệu (đoạn đã bị xoá) — chạy trước thì hai lượt kia phải dò qua chữ không
    // thuộc bản đã sửa và có thể khớp bừa vào đó.
    const delRequests = changes.flatMap((c) => {
      if (previewMode !== 'changes') return [];
      if (c.status === 'dismissed') return [];
      if (changeOp(c) !== 'del') return [];
      // `anchor` là nguyên văn mã nguồn markdown, y như `quote`, nên phải cắt
      // qua quoteSegments. Lấy segment ĐẦU: một chỗ xoá chỉ cần một điểm neo,
      // và segment đầu là chỗ gần nhất với vị trí đoạn bị xoá.
      const seg = quoteSegments((c.anchor ?? '').trim())[0];
      if (!seg || !c.before) return [];
      return [{ id: c.id, anchor: seg, text: c.before, scope: annotationScope(c) }];
    });
    // Chỗ XOÁ giữ nguyên gạch ngang kể cả khi tắt tô màu: gạch ngang không
    // phải trang trí mà là thứ DUY NHẤT phân biệt "chữ đã bị bỏ" với "chữ đang
    // có trong tài liệu" — bỏ nó đi thì đoạn đã xoá đọc như nội dung thật.
    const delPass = injectDeletedRuns(
      notePass.html,
      delRequests,
      paint.del ? styles.hlDel ?? '' : styles.hlDelOff ?? '',
      paint.del ? HL_DEL_INLINE_STYLE : HL_DEL_OFF_INLINE_STYLE,
    );

    // Lượt thứ TƯ: các đoạn được `reason`/`finding` VIỆN DẪN. Chạy sau cùng để
    // không tranh chỗ với ba loại trên — một đoạn vừa là chỗ sửa vừa được viện
    // dẫn thì nó phải hiện là chỗ sửa, vì đó mới là thông tin người đọc cần
    // trước. injectHighlights bỏ qua request có id đã khớp, nên thứ tự này cũng
    // là thứ tự ưu tiên.
    const refRequests = [
      ...(previewMode === 'changes' ? changes : []).flatMap((c) =>
        (c.doc_refs ?? []).flatMap((ref, i) =>
          quoteSegments(ref.trim()).slice(0, 1).map((text) => ({
            id: `${REF_ID_PREFIX}${c.id}:${i}`,
            text,
            className: styles.hlRef ?? '',
            inlineStyle: HL_REF_INLINE_STYLE,
          })),
        ),
      ),
      ...(previewMode === 'notes' ? notes : []).flatMap((n) =>
        (n.doc_refs ?? []).flatMap((ref, i) =>
          quoteSegments(ref.trim()).slice(0, 1).map((text) => ({
            id: `${REF_ID_PREFIX}${NOTE_ID_PREFIX}${n.id}:${i}`,
            text,
            className: styles.hlRef ?? '',
            inlineStyle: HL_REF_INLINE_STYLE,
          })),
        ),
      ),
    ];
    const refPass = injectHighlights(delPass.html, refRequests, styles.hlRef ?? '', HL_REF_INLINE_STYLE);

    return {
      html: refPass.html,
      matched: new Set<string>([
        ...changePass.matched,
        ...notePass.matched,
        ...delPass.matched,
        ...refPass.matched,
      ]),
      // `doc_refs` are evidence links, not changed/commented content. Keep
      // their inline dotted marks (and matched ids for jump/modal behavior),
      // but never promote their containing list item/table to a tinted block.
      blocks: [...changePass.blocks, ...notePass.blocks, ...delPass.blocks],
    };
  }, [editedText, projectId, file.name, changes, notes, paint, previewMode]);

  const docHtml = docRender?.html ?? null;
  const anchored = docRender?.matched ?? EMPTY_SET;
  const markCount = docHtml?.match(/<mark /g)?.length ?? 0;
  // Đếm theo phép sửa, không đếm tổng: "12 chỗ sửa" không nói được rằng 9 trong
  // số đó chỉ là thêm chữ mới, mà đó chính là thứ quyết định người review phải
  // đọc kỹ tới đâu.
  const opCounts = useMemo(() => {
    const out = { add: 0, del: 0, edit: 0 };
    for (const c of changes) if (c.status !== 'dismissed') out[changeOp(c)] += 1;
    return out;
  }, [changes]);
  // Khai báo ở ĐÂY chứ không ở gần chỗ render, vì effect uỷ quyền click ở dưới
  // lấy `loading` làm dependency: mảng dependency được đánh giá trong lúc
  // render, nên một `const` khai báo sau useEffect sẽ vướng vùng chết (TDZ).
  const loading = editedText === null || changesState.status === 'loading';
  // Đếm cho dải trạng thái (mục 7 WP3) + chip lọc mới — chỉ đếm chỗ CÒN hiệu
  // lực, cùng quy ước với opCounts ngay trên.
  const diagramCount = useMemo(
    () => changes.filter((c) => c.kind === 'flow-diagram' && c.status !== 'dismissed').length,
    [changes],
  );
  const compTableCount = useMemo(
    () => changes.filter((c) => isComponentTableChange(c) && c.status !== 'dismissed').length,
    [changes],
  );
  // S · D · X của tab dọc khi panel ẩn (mục 6 WP3): S = change còn hiệu lực, D
  // = đã bỏ (change + note gộp — cùng định nghĩa "đã bỏ" của dải trạng thái
  // phía trên), X = nhận xét còn hiệu lực.
  const activeChangeCount = changes.filter((c) => c.status !== 'dismissed').length;
  const dismissedTotalCount =
    changes.filter((c) => c.status === 'dismissed').length + notes.filter((n) => n.status === 'dismissed').length;
  const activeNoteCount = notes.filter((n) => n.status !== 'dismissed').length;

  // ── Sơ đồ mermaid trong cột tài liệu (mục 4 WP3) ──────────────────────────
  // `renderMarkdownToSafeHtml` (dùng chung với FileViewer) đã dựng fence
  // ```mermaid thành <pre><code class="language-mermaid">mã thô</code></pre>
  // — KHÔNG có sơ đồ sống. Mượn đúng khuôn `mountMarkdownMermaidHosts` của
  // FileViewer.tsx (không import được — vòng import, xem docblock đầu file):
  // chèn một host trước block, gập mã nguồn vào <details>, rồi portal
  // <MermaidDiagram> vào host ở một lượt render kế tiếp.
  //
  // Host của change `flow-diagram` KHỚP ĐƯỢC là một <mark data-change-id> chứ
  // không phải <div> trơn: nhờ vậy toàn khối ăn theo MIỄN PHÍ mọi cơ chế mark
  // đã có (chọn/nổi/cuộn/uỷ quyền click ở effect dưới) — không phải thêm một
  // listener nào, không đổi injectHighlights.
  const [diagramMounts, setDiagramMounts] = useState<
    Array<{ host: HTMLElement; changeId: string | null; code: string }>
  >([]);
  // 'proposed' (mặc định) render `quote`; 'original' render `before` — CHỈ đổi
  // những gì đang hiện, không ghi gì ra tài liệu (khác hẳn dismiss).
  const [diagramView, setDiagramView] = useState<Record<string, 'proposed' | 'original'>>({});

  // Khai báo TRƯỚC effect gom marksByChangeRef ngay dưới: cả hai cùng chạy
  // theo `docHtml`, và effect chèn host này PHẢI chạy trước để marksByChangeRef
  // gom được luôn <mark> vừa chèn trong CÙNG một lượt hiệu ứng (React chạy các
  // effect của một lượt commit theo đúng thứ tự khai báo).
  useEffect(() => {
    const container = docColRef.current;
    if (!container) {
      setDiagramMounts([]);
      return;
    }
    const mermaidHostClass = (styles.mermaidHost ?? '').trim();
    const codes = Array.from(container.querySelectorAll<HTMLElement>('pre > code.language-mermaid'));
    const mounts: Array<{ host: HTMLElement; changeId: string | null; code: string }> = [];
    const mutations: Array<{ parent: HTMLElement; pre: HTMLElement; host: HTMLElement; details: HTMLDetailsElement }> = [];
    const consumedOwners = new Set<string>();
    const headings = Array.from(container.querySelectorAll<HTMLElement>('article h1, article h2, article h3, article h4, article h5, article h6'));
    const diagramOwners = previewMode === 'changes'
      ? changes.filter((c) => c.kind === 'flow-diagram' && c.status !== 'dismissed')
      : [];

    const headingOrdinalFor = (element: HTMLElement): number => {
      let ordinal = -1;
      for (let i = 0; i < headings.length; i += 1) {
        const heading = headings[i]!;
        if (heading.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING) ordinal = i;
        else break;
      }
      return ordinal;
    };

    const ownerContainsHeading = (owner: DocRedlineChange, ordinal: number): boolean => {
      const start = owner.sectionStartHeadingOrdinal;
      const end = owner.sectionEndHeadingOrdinalExclusive;
      if (start != null || end != null) {
        return (start == null || ordinal >= start) && (end == null || ordinal < end);
      }
      if (owner.sectionHeading == null) return true;
      const currentHeading = ordinal >= 0 ? headings[ordinal]?.textContent?.trim() ?? '' : '';
      const expectedHeading = owner.sectionHeading.trim().replace(/^#{1,6}\s*/, '');
      return currentHeading.localeCompare(expectedHeading, 'vi', { sensitivity: 'base' }) === 0;
    };

    for (const codeEl of codes) {
      const pre = codeEl.parentElement;
      const parent = pre?.parentElement;
      if (!pre || !parent) continue;
      const rawCode = codeEl.textContent ?? '';
      if (!rawCode.trim()) continue;
      const ordinal = headingOrdinalFor(pre);
      const matchingOwners = diagramOwners.filter(
        (c) => !consumedOwners.has(c.id) && extractMermaidFenceBody(c.quote)?.trim() === rawCode.trim(),
      );
      const owner = matchingOwners.find((candidate) => ownerContainsHeading(candidate, ordinal));
      if (owner) consumedOwners.add(owner.id);
      const host = document.createElement(owner ? 'mark' : 'div');
      // B1 (wp3b.yaml): CHỈ host có owner mới được sơn/bấm được — một sơ đồ
      // KHÔNG thuộc change nào (ví dụ ảnh minh hoạ có sẵn trong tài liệu, không
      // qua rà soát) không phải là một vùng bôi, nên không được ăn theo class
      // hl/hlOff, style nội tuyến (nền vàng + cursor pointer), hay
      // data-change-id — nó chỉ là khung hiển thị trơn (mermaidHostClass) cho
      // sơ đồ sống portal vào.
      if (owner) {
        const on = paint.edit;
        host.className = `${mermaidHostClass} ${on ? styles.hl ?? '' : styles.hlOff ?? ''}`.trim();
        host.setAttribute('style', on ? HL_INLINE_STYLE : HL_OFF_INLINE_STYLE);
        host.dataset.changeId = owner.id;
      } else {
        host.className = mermaidHostClass;
      }
      parent.insertBefore(host, pre);
      // Gập mã nguồn xuống dưới một <details>, cùng khuôn <mark>-trước-<pre>
      // với mountMarkdownMermaidHosts của FileViewer.tsx — khác một chỗ: cột
      // này không có nút copy-khối-code (MARKDOWN_CODE_BLOCK_ATTR) như
      // FileViewer, nên mã nguồn gập lại chỉ đọc/chọn tay được, không có nút
      // riêng. Không thêm nút đó ở đây — ngoài phạm vi `do` của WP3.
      const details = document.createElement('details');
      details.className = 'md-mermaid__source';
      const summary = document.createElement('summary');
      summary.textContent = 'Mermaid';
      details.appendChild(summary);
      parent.insertBefore(details, pre);
      details.appendChild(pre);
      mounts.push({ host, changeId: owner?.id ?? null, code: rawCode });
      mutations.push({ parent, pre, host, details });
    }
    setDiagramMounts(mounts);
    // N1 (wp3b.yaml): `loading` PHẢI có trong deps, không chỉ `docHtml`. Cột
    // tài liệu (nên cả `docColRef.current`) chỉ THỰC SỰ có mặt trong DOM khi
    // `!loading` (xem nhánh `{loading ? … : <div className={styles.wrap}>…}`
    // ở JSX bên dưới) — nhưng `docHtml` có thể đã đổi giá trị TỪ TRƯỚC lúc đó
    // (editedText resolve trước changes.json). Nếu giá trị CHUỖI của `docHtml`
    // ở lượt đó tình cờ TRÙNG HỆT lượt effect chạy lần đầu (== so sánh theo
    // GIÁ TRỊ chuỗi, không theo tham chiếu) — đúng trường hợp một tài liệu chỉ
    // có change sơ đồ, từ B2 không còn đưa segment chữ vào injectHighlights
    // nên changes.json về sau không đổi lấy một ký tự nào của docHtml — thì
    // effect bị React coi là "deps không đổi" và KHÔNG chạy lại đúng lúc
    // `docColRef.current` mới thực sự khác null, nên host chẳng bao giờ được
    // chèn. Thêm `loading` buộc effect chạy lại đúng lượt nó chuyển
    // true → false, bất kể `docHtml` có đổi ký tự nào hay không.
    return () => {
      for (const { parent, pre, host, details } of mutations) {
        if (details.parentElement === parent) parent.insertBefore(pre, details);
        details.remove();
        host.remove();
      }
    };
  }, [docHtml, loading, previewMode, changes]);

  // (d, review WP3b): effect RIÊNG chỉ đồng bộ class + style nội tuyến của
  // host ĐÃ CHÈN theo `paint.edit` — KHÔNG gộp vào effect chèn host phía
  // trên. Một tài liệu CHỈ có
  // change sơ đồ giữ `docHtml` NGUYÊN VĂN qua mọi lượt bật/tắt paint (B2:
  // sơ đồ không còn đóng góp mark chữ vào docHtml — xem N1 phía trên), nên
  // lượt bật/tắt paint không cần dựng lại host. Effect này chỉ SỬA host đã
  // tồn tại trong `diagramMounts`, không tạo/xoá gì, nên an toàn để chạy lại
  // theo `paint.edit`.
  useEffect(() => {
    const mermaidHostClass = (styles.mermaidHost ?? '').trim();
    for (const m of diagramMounts) {
      if (!m.changeId) continue; // sơ đồ mồ côi (B1) không được sơn
      const on = paint.edit;
      m.host.className = `${mermaidHostClass} ${on ? styles.hl ?? '' : styles.hlOff ?? ''}`.trim();
      m.host.setAttribute('style', on ? HL_INLINE_STYLE : HL_OFF_INLINE_STYLE);
    }
  }, [diagramMounts, paint.edit]);

  /** Mã mermaid ĐANG hiện cho một host: `before` khi người dùng bật "○ Gốc",
   *  ngược lại (mặc định) là `quote` — đúng đoạn đã dựng sẵn trong `code`. */
  function activeDiagramCode(m: { changeId: string | null; code: string }): string {
    if (!m.changeId || diagramView[m.changeId] !== 'original') return m.code;
    const owner = changes.find((c) => c.id === m.changeId);
    return extractMermaidFenceBody(owner?.before) ?? m.code;
  }

  // Sau khi cột tài liệu đã chạy xong pass bôi highlight, gom lại mark theo
  // change id — chạy lại mỗi khi HTML đổi vì đó là lúc DOM có mark mới. Bản đồ
  // này CHỈ dùng để cuộn tới mark khi bấm một mục trong rail; việc nhận click
  // trên mark KHÔNG đi qua nó (xem effect uỷ quyền ngay dưới).
  useEffect(() => {
    const container = docColRef.current;
    const marksByChange = new Map<string, HTMLElement[]>();
    if (container) {
      container.querySelectorAll<HTMLElement>('mark[data-change-id]').forEach((mark) => {
        const id = mark.dataset.changeId;
        if (!id) return;
        const list = marksByChange.get(id) ?? [];
        list.push(mark);
        marksByChange.set(id, list);
      });
    }
    marksByChangeRef.current = marksByChange;
  }, [docHtml, changesState, previewMode, diagramMounts]);

  // Block descriptors do not alter the HTML structure. They identify the
  // owning p/li/table/heading so additions and multi-cell/list matches can be
  // tinted as one safe block without ever wrapping a mark across block tags.
  useEffect(() => {
    const container = docColRef.current;
    if (!container || !docRender) return;
    const blocks = Array.from(container.querySelectorAll<HTMLElement>('p, li, table, h1, h2, h3, h4, h5, h6'));
    const tintClasses = [styles.blockTintAdd, styles.blockTintFull].filter((name): name is string => !!name);
    const clearBlockTint = () => {
      for (const block of blocks) {
        delete block.dataset.redlineBlock;
        delete block.dataset.redlineOwner;
        if (tintClasses.length > 0) block.classList.remove(...tintClasses);
      }
    };
    clearBlockTint();
    for (const target of docRender.blocks as HighlightBlockTarget[]) {
      const block = blocks[target.blockIndex];
      if (!block) continue;
      const owner = changes.find((change) => change.id === target.id);
      const operation = owner ? changeOp(owner) : previewMode === 'notes' ? 'note' : 'edit';
      block.dataset.redlineBlock = operation;
      block.dataset.redlineOwner = target.id;
      if (operation === 'add') block.classList.add(styles.blockTintAdd ?? '');
      if (target.kind === 'table' || target.kind === 'list-item') block.classList.add(styles.blockTintFull ?? '');
    }
    return clearBlockTint;
  }, [docHtml, docRender, changes, previewMode]);

  // MỘT listener trên CỘT tài liệu, không phải một listener trên mỗi <mark>.
  //
  // Vì sao: gắn theo từng mark buộc thời điểm gắn phải trùng thời điểm mark có
  // mặt trong DOM. Mỗi lần HTML của cột được dựng lại — đổi tài liệu, đổi danh
  // sách chỗ sửa, React thay nút — là một cơ hội để tập listener lệch khỏi tập
  // mark đang hiển thị, và khi lệch thì triệu chứng đúng là "bấm vùng bôi mà
  // không có gì xảy ra". Uỷ quyền cho phần tử cột thì cột luôn có mặt suốt vòng
  // đời khung nhìn, còn `closest()` tìm ra mark tại chính lúc bấm, nên không
  // còn khoảnh khắc nào một mark đang hiện mà chưa nhận được click.
  useEffect(() => {
    const container = docColRef.current;
    if (!container) return;
    const fn = (ev: Event) => {
      const target = ev.target as HTMLElement | null;
      const mark = target?.closest?.('mark[data-change-id]') as HTMLElement | null;
      if (!mark) return; // bấm vào chỗ trống trong cột — không phải vùng bôi
      // N6 (wp3b.yaml): host mermaid (chính LÀ <mark> này) chứa MermaidDiagram
      // portal thẳng vào, và các nút zoom/pan/reset của nó KHÔNG tự
      // stopPropagation (không được sửa MermaidDiagram.tsx — ngoài phạm vi
      // touches). Một cú bấm rơi trúng <button> bên trong mark không phải bấm
      // CHỌN change — nút "Gốc"/"Đề xuất" của khối sơ đồ đã tự stopPropagation
      // riêng nên không lọt tới đây; chỉ còn nút của MermaidDiagram mới rơi
      // vào nhánh này.
      if (target?.closest?.('button')) return;
      const id = mark.dataset.changeId;
      if (!id) return;
      selectFromDoc(id);
    };
    container.addEventListener('click', fn);
    return () => container.removeEventListener('click', fn);
    // `loading` là thứ quyết định cột có được render hay không; khi nó đổi
    // false thì ref mới trỏ tới phần tử thật. Sau đó cột giữ nguyên danh tính
    // dù HTML bên trong thay đổi bao nhiêu lần, nên không cần gắn lại theo
    // docHtml — đó chính là điểm lợi của uỷ quyền.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  /** B2 (wp3b.yaml): host mermaid CỦA ĐÚNG change `id`, lọc bằng `dataset`
   *  thay vì đi qua `marksByChangeRef` — bản đồ đó gom TẤT CẢ `<mark
   *  data-change-id>` trong cột (kể cả một mark chữ nào đó lỡ khớp trùng nhãn,
   *  ví dụ một `doc_refs` của change khác trỏ vào đúng đoạn chữ trong khối
   *  mermaid), nên không đảm bảo phần tử ĐẦU TIÊN trả về luôn là host. Đọc
   *  thẳng host qua đây thì chắc chắn cuộn tới đúng khối sơ đồ của change này,
   *  không phải một khối khác lỡ chứa chữ trùng. */
  function hostMarksFor(id: string): HTMLElement[] {
    const container = docColRef.current;
    if (!container) return [];
    const hostClass = (styles.mermaidHost ?? '').trim();
    return Array.from(container.querySelectorAll<HTMLElement>('mark[data-change-id]')).filter(
      (el) => el.dataset.changeId === id && (!hostClass || el.classList.contains(hostClass)),
    );
  }

  /** Bấm một mục trong rail: cuộn tài liệu tới vùng bôi đầu tiên của change đó
   *  và nháy sáng mọi mark của nó. */
  function selectFromList(id: string) {
    const ownerMode = annotationMode(id);
    if (ownerMode !== previewMode) {
      pendingSelectionRef.current = { id, source: 'rail' };
      setSelectedId(null);
      setPreviewMode(ownerMode);
      return;
    }
    setSelectedId(id);
    // Sơ đồ mermaid: cuộn tới HOST, không đi qua marksByChangeRef (xem
    // hostMarksFor ngay trên — đúng vế (2) của B2 trong wp3b.yaml).
    const change = changes.find((c) => c.id === id);
    const marks = change?.kind === 'flow-diagram' ? hostMarksFor(id) : marksByChangeRef.current.get(id);
    if (!marks || marks.length === 0) return; // không neo được — không có gì để cuộn tới
    // `behavior: 'auto'`, KHÔNG 'smooth'. Cuộn mượt kéo dài vài trăm ms, và
    // trong lúc đó tài liệu vẫn đang trôi dưới con trỏ. Người dùng bấm tiếp một
    // vùng bôi ngay lúc ấy thì mousedown và mouseup rơi vào hai phần tử khác
    // nhau, nên trình duyệt phát `click` lên tổ tiên chung chứ không lên
    // <mark> — đúng triệu chứng "bấm vùng bôi thứ hai không mở được lý do".
    // Nhảy tức thì thì không có cửa sổ thời gian nào để trượt.
    marks[0]!.scrollIntoView({ block: 'center', behavior: 'auto' });
    const flashClass = styles.hlFlash ?? '';
    for (const mark of marks) setClass(mark, flashClass, true);
    window.setTimeout(() => {
      for (const mark of marks) setClass(mark, flashClass, false);
    }, 1600);
  }

  /** Bấm một vùng bôi trong tài liệu: chọn change đó và cuộn rail tới mục
   *  tương ứng (chiều ngược của selectFromList). Vùng VIỆN DẪN
   *  (`ref:<ownerId>:<i>`) quy về chính thẻ đã viện dẫn nó — người đọc bấm vào
   *  một đoạn gạch chấm là đang hỏi "ai nhắc tới chỗ này?", nên câu trả lời là
   *  thẻ chủ, không phải một mục riêng cho tham chiếu. */
  function selectFromDoc(id: string) {
    const ownerId = id.startsWith(REF_ID_PREFIX)
      ? // bỏ tiền tố rồi cắt hậu tố `:<số>`. KHÔNG dùng split(':') — ownerId của
        // note tự nó đã chứa dấu hai chấm (`note:n1`).
        id.slice(REF_ID_PREFIX.length).replace(/:\d+$/, '')
      : id;
    const ownerMode = annotationMode(ownerId);
    if (ownerMode !== previewMode) {
      pendingSelectionRef.current = { id: ownerId, source: 'document' };
      setSelectedId(null);
      setPreviewMode(ownerMode);
      return;
    }
    setSelectedId(ownerId);
    if (!panelOpenRef.current) {
      // Panel đang ẩn: mở ra rồi mới cuộn. Rail VẪN Ở TRONG DOM khi ẩn (chỉ
      // `hidden`/`aria-hidden`, xem docblock panelOpen) nên mục đã có ref sẵn
      // — chỉ cần đợi một khung hình để `hidden` được gỡ trước khi
      // `scrollIntoView` có chỗ để cuộn tới (gọi ngay trong cùng lượt thì phần
      // tử vẫn `display: none`, trình duyệt không cuộn được).
      openPanel();
      window.requestAnimationFrame(() => {
        itemsByChangeRef.current.get(ownerId)?.scrollIntoView({ block: 'nearest', behavior: 'auto' });
      });
      return;
    }
    const item = itemsByChangeRef.current.get(ownerId);
    // `block: 'nearest'` để rail chỉ trượt tối thiểu — mục đã ở trong tầm nhìn
    // thì không nhảy. `behavior: 'auto'` cùng lý do như trên.
    item?.scrollIntoView({ block: 'nearest', behavior: 'auto' });
  }

  // Cross-mode selection is deliberately two-phase: switching mode rebuilds
  // docHtml and the mark/card maps. Only a later effect may consume the
  // pending id, so scroll never races the DOM that owns the destination.
  useEffect(() => {
    const pending = pendingSelectionRef.current;
    if (!pending || annotationMode(pending.id) !== previewMode) return;
    const marks = marksByChangeRef.current.get(pending.id);
    const item = itemsByChangeRef.current.get(pending.id);
    if ((!marks || marks.length === 0) && !item) return;
    pendingSelectionRef.current = null;
    if (pending.source === 'rail') selectFromList(pending.id);
    else selectFromDoc(pending.id);
    // docHtml is the commit boundary for the mode-specific mark tree.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docHtml, previewMode]);

  /** Mở cửa sổ xem đoạn được VIỆN DẪN.
   *
   *  Vì sao là modal chứ không cuộn cột chính: đoạn được viện dẫn thường nằm
   *  rất xa chỗ đang đọc (một lý do ở mục 5 dẫn tới bảng ở mục 2). Cuộn cột
   *  chính tới đó đồng nghĩa vứt mất vị trí người đọc đang đứng, và họ phải tự
   *  tìm đường quay lại. Modal cho họ liếc sang rồi đóng lại là về đúng chỗ cũ. */
  function openRefModal(markId: string, label: string) {
    setRefModal({ markId, label });
  }

  // Modal vừa mở: cuộn tới đoạn được viện dẫn trong BẢN SAO tài liệu của modal
  // và làm nổi nó. Phải chờ `refModal` đổi (modal đã render) mới tìm được mark
  // — trước đó phần tử chưa tồn tại.
  useEffect(() => {
    if (!refModal) return;
    const container = modalDocRef.current;
    if (!container) return;
    // Lọc bằng `dataset` thay vì nhét id vào selector: id chứa dấu hai chấm
    // (`ref:c1:0`) nên selector phải escape, mà `CSS.escape` KHÔNG phải lúc nào
    // cũng có (jsdom không cài nó — test của cửa sổ này đỏ ngay vì lý do đó, và
    // một môi trường trình duyệt cũ cũng có thể thiếu). So sánh chuỗi thẳng vừa
    // không cần escape vừa không thể sai.
    const marks = Array.from(container.querySelectorAll<HTMLElement>('mark[data-change-id]')).filter(
      (mark) => mark.dataset.changeId === refModal.markId,
    );
    if (marks.length === 0) return;
    // `block: 'center'` để đoạn được dẫn nằm giữa khung, có ngữ cảnh trên dưới
    // — đây là toàn bộ mục đích của cửa sổ này.
    marks[0]!.scrollIntoView({ block: 'center', behavior: 'auto' });
    const activeClass = styles.hlActive ?? '';
    for (const mark of marks) setClass(mark, activeClass, true);
  }, [refModal]);

  // Escape đóng modal. Gắn ở `document` chứ không ở phần tử modal: tiêu điểm có
  // thể đang nằm ở nút Đóng, ở vùng cuộn, hay chưa ở đâu cả.
  useEffect(() => {
    if (!refModal) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') setRefModal(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [refModal]);

  // Làm nổi tất cả mark của change đang được chọn. Chạy lại theo `docHtml` vì
  // HTML mới nghĩa là mark mới, chưa mang class nào.
  useEffect(() => {
    const container = docColRef.current;
    if (!container) return;
    const activeClass = styles.hlActive ?? '';
    container.querySelectorAll<HTMLElement>('mark[data-change-id]').forEach((mark) => {
      setClass(mark, activeClass, !!selectedId && mark.dataset.changeId === selectedId);
    });
  }, [selectedId, docHtml]);

  // Một change là "không neo được" khi id của nó không có trong `matched` — hợp
  // của cả ba lượt bôi. Chỗ xoá thuần CÓ `anchor` neo được qua lượt thứ ba
  // (injectDeletedRuns), nên thẻ của nó là button nhảy tới được như mọi thẻ
  // khác; chỗ xoá KHÔNG có `anchor` (dữ liệu từ trước khi có field này) thì
  // không có gì để neo vào — đó là đúng chứ không phải lỗi.
  /** Trả `true` khi lưu thành công, `false` khi bị chặn (đang bận) hoặc lỗi —
   *  chỗ gọi (`saveComponentTableEdit`, vá N2 review attempt2) cần biết kết
   *  quả để quyết định có đóng form nháp hay không: đóng SAU khi lưu xong,
   *  không đóng trước rồi mất nháp nếu lưu hỏng. Các chỗ gọi cũ (editChange,
   *  dismissChange…) không đọc giá trị trả về — thêm giá trị này không đổi
   *  hành vi của chúng. */
  async function saveAction(id: string, action: () => { text?: string; changes?: DocRedlineChange[]; events?: DocReviewAnnotationEvent[]; notes?: DocRedlineNote[]; changedMd: boolean }): Promise<boolean> {
    if (busyId) return false;
    setBusyId(id); setErrorById((prev) => ({ ...prev, [id]: '' }));
    const beforeChanges = changesState; const beforeNotes = notes; const beforeText = editedText;
    try {
      const result = action();
      const writes: Array<[string, string]> = [];
      if (result.changedMd && result.text != null) writes.push([file.name, result.text]);
      if (result.changes) writes.push([
        file.name.replace(/\.md$/i, '.changes.json'),
        sidecarJson(result.changes, result.events ?? events),
      ]);
      if (result.notes) writes.push([file.name.replace(/\.md$/i, '.notes.json'), JSON.stringify(result.notes, null, 2)]);
      for (const [name, content] of writes) {
        const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/files`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, content }) });
        if (!response.ok) throw new Error('Không ghi được file');
      }
      if (result.text != null) setEditedText(result.text);
      if (result.changes) {
        const nextEvents = result.events ?? events;
        setChangesRaw(sidecarJson(result.changes, nextEvents));
        setChangesState({ status: 'ok', changes: result.changes, events: nextEvents });
      }
      if (result.notes) { setNotesRaw(JSON.stringify(result.notes)); setNotes(result.notes); }
      setEditingId(null);
      setDraft(null);
      return true;
    } catch (error) { setChangesState(beforeChanges); setNotes(beforeNotes); setEditedText(beforeText); setErrorById((prev) => ({ ...prev, [id]: error instanceof Error ? error.message : 'Lỗi ghi file' })); return false; }
    finally { setBusyId(null); }
  }

  function updateChange(c: DocRedlineChange, next: Partial<DocRedlineChange>, changedMd: boolean, text?: string, eventType?: DocReviewAnnotationEvent['type']) {
    const list = changes.map((item) => item.id === c.id ? { ...item, ...next } : item);
    const changed = list.find((item) => item.id === c.id) ?? c;
    return {
      changes: list,
      events: eventType ? [...events, eventFor(c.id, eventType, changed)] : events,
      changedMd,
      text,
    };
  }

  async function editChange(c: DocRedlineChange) {
    const next = editDocText(editedText ?? '', c.quote ?? '', editText);
    if (next == null) throw new Error('Không tìm thấy vùng sửa trong tài liệu');
    await saveAction(c.id, () => updateChange(c, { quote: editText, status: 'edited' }, true, next, 'edit'));
  }

  /** wp4.yaml mục 1: "Sửa bảng" của một Bảng thành phần — cùng khuôn
   *  `editChange` ngay trên (thay-một-lần bằng `replaceOneOccurrence`,
   *  `updateChange(status 'edited')` + event 'edit', qua `saveAction` hiện
   *  có), chỉ khác nguồn văn bản mới đến từ form theo hàng
   *  (`ComponentTableCardBody`) thay vì ô `editText` chung.
   *
   *  Trả `true`/`false` (vá N2 review attempt2) — `ComponentTableCardBody`
   *  chỉ đóng form khi lưu thành công, giữ nguyên nháp + hiện lỗi khi hỏng. */
  async function saveComponentTableEdit(c: DocRedlineChange, newQuote: string): Promise<boolean> {
    const next = replaceOneOccurrence(editedText ?? '', c.quote ?? '', newQuote);
    if (next == null) {
      setErrorById((prev) => ({ ...prev, [c.id]: 'Không tìm thấy vùng sửa trong tài liệu' }));
      return false;
    }
    return saveAction(c.id, () => updateChange(c, { quote: newQuote, status: 'edited' }, true, next, 'edit'));
  }

  async function dismissChange(c: DocRedlineChange) {
    if (c.status === 'dismissed') {
      if (!undoableIds.has(c.id)) return;
      const restoreText = undoTextRef.current.get(c.id);
      await saveAction(c.id, () => updateChange(
        c,
        { status: 'active' },
        restoreText != null,
        restoreText ?? editedText ?? undefined,
        'restore',
      ));
      setUndoableIds((prev) => { const next = new Set(prev); next.delete(c.id); return next; });
      undoTextRef.current.delete(c.id);
      return;
    }
    const changedMd = Boolean(c.quote || c.before);
    const next = changedMd ? revertDocText(editedText ?? '', c) : editedText;
    if (changedMd && next == null) throw new Error(c.before && !c.quote ? 'Không tìm thấy anchor duy nhất để chèn lại.' : 'Không tìm thấy vùng sửa trong tài liệu');
    if (editedText != null) undoTextRef.current.set(c.id, editedText);
    await saveAction(c.id, () => updateChange(c, { status: 'dismissed' }, changedMd, next ?? undefined, 'dismiss'));
    setUndoableIds((prev) => new Set(prev).add(c.id));
  }

  async function dismissNote(n: DocRedlineNote) {
    const id = `${NOTE_ID_PREFIX}${n.id}`;
    if (n.status === 'dismissed') {
      if (!undoableIds.has(id)) return;
      await saveAction(id, () => ({ notes: notes.map((item) => item.id === n.id ? { ...item, status: undefined } : item), changedMd: false }));
      setUndoableIds((prev) => { const next = new Set(prev); next.delete(id); return next; });
      return;
    }
    await saveAction(id, () => ({ notes: notes.map((item) => item.id === n.id ? { ...item, status: 'dismissed' } : item), changedMd: false }));
    setUndoableIds((prev) => new Set(prev).add(id));
  }

  function startUserAnnotation(operation: DraftAnnotation['operation']) {
    const selection = window.getSelection();
    const selected = selection?.toString().trim() ?? '';
    const anchorNode = selection?.anchorNode;
    if (!selected || !anchorNode || !docColRef.current?.contains(anchorNode)) {
      setDraftError('Hãy bôi đen một đoạn trong tài liệu trước.');
      return;
    }
    if (uniqueOccurrenceIndex(editedText ?? '', selected) == null) {
      setDraftError('Đoạn đã chọn phải xuất hiện đúng một lần trong mã nguồn tài liệu.');
      return;
    }
    if (operation === 'delete' && !deletionAnchor(editedText ?? '', selected)) {
      setDraftError('Không tìm được đoạn neo duy nhất ngay trước phần cần xoá.');
      return;
    }
    setDraftError('');
    setDraft({ operation, selected, replacement: '', reason: '', kind: defaultUserKind(operation) });
  }

  /** wp4.yaml mục 2: "Thêm sau mục…" — cùng composer với "Thêm sau đoạn
   *  chọn" (`startUserAnnotation('add')`), chỉ khác nguồn `selected`: một dòng
   *  heading do người dùng CHỌN từ danh sách thay vì bôi đen. Cùng thông báo
   *  lỗi ("Đoạn đã chọn phải xuất hiện đúng một lần…") nhưng kiểm duy nhất
   *  theo DÒNG (`uniqueHeadingLineOffset`, vá N1 review attempt2) — không
   *  dùng `uniqueOccurrenceIndex` (substring): một heading cấp cha là
   *  substring của heading cấp con cùng tiền tố (`# Đăng ký` trong `##
   *  Đăng ký thành công`) nên sẽ báo trùng giả. `viaHeading: true` để
   *  `createUserAnnotation` chèn đúng bằng `insertAfterHeadingLine`. */
  function startHeadingAnnotation(heading: DocHeading) {
    if (uniqueHeadingLineOffset(editedText ?? '', heading.line) == null) {
      setDraftError('Đoạn đã chọn phải xuất hiện đúng một lần trong mã nguồn tài liệu.');
      return;
    }
    setDraftError('');
    setDraft({ operation: 'add', selected: heading.line, replacement: '', reason: '', kind: defaultUserKind('add'), viaHeading: true });
    setHeadingPickerOpen(false);
    setHeadingPickerValue('');
  }

  async function createUserAnnotation() {
    if (!draft || editedText == null) return;
    const replacement = draft.replacement.trim();
    if (draft.operation !== 'delete' && !replacement) {
      setDraftError('Nội dung mới không được để trống.');
      return;
    }
    let nextText: string | null = null;
    let before: string | undefined;
    let quote: string | undefined;
    let anchor: string | undefined;
    if (draft.operation === 'edited') {
      before = draft.selected;
      quote = replacement;
      nextText = replaceOneOccurrence(editedText, draft.selected, replacement);
    } else if (draft.operation === 'delete') {
      before = draft.selected;
      anchor = deletionAnchor(editedText, draft.selected) ?? undefined;
      nextText = replaceOneOccurrence(editedText, draft.selected, '');
    } else {
      quote = replacement;
      anchor = draft.selected;
      // Vá N1 (review attempt2): nguồn từ "Thêm sau mục…" chèn theo DÒNG
      // heading (`insertAfterHeadingLine`), không theo substring
      // (`insertAfterUniqueAnchor`) — nguồn từ bôi đen ("Thêm sau đoạn
      // chọn") giữ nguyên hành vi cũ, không đổi.
      nextText = draft.viaHeading
        ? insertAfterHeadingLine(editedText, draft.selected, `\n\n${replacement}`)
        : insertAfterUniqueAnchor(editedText, draft.selected, `\n\n${replacement}`);
    }
    if (nextText == null) {
      setDraftError('Tài liệu đã thay đổi. Hãy chọn lại đoạn cần thao tác.');
      return;
    }
    const id = uid('user');
    const change: DocRedlineChange = {
      id,
      // wp4.yaml mục 3: `draft.kind` — mặc định theo phép sửa (xem
      // `defaultUserKind`), người dùng đổi được qua select "Loại" (chỉ hiện
      // cho Sửa/Thêm; Xoá giữ mặc định `gap` như trước).
      kind: draft.kind,
      severity: 'minor',
      reason: draft.reason.trim() || 'Người dùng tự chỉnh tài liệu.',
      origin: 'user',
      operation: draft.operation,
      status: 'active',
      ...(before ? { before, initialBefore: before } : {}),
      ...(quote ? { quote, initialQuote: quote } : {}),
      ...(anchor ? { anchor } : {}),
    };
    await saveAction(id, () => ({
      text: nextText,
      changes: [...changes, change],
      events: [...events, eventFor(id, 'create', change)],
      changedMd: true,
    }));
  }

  // B2 (wp3b.yaml), vế (1): sơ đồ mermaid không còn đóng góp vào `anchored`
  // (bỏ segment chữ khỏi injectHighlights — xem `requests` phía trên), nên
  // phải tự xét riêng: có HOST khớp được với change này (diagramMounts) thì
  // coi là neo được, dù `anchored.has(c.id)` giờ luôn false với loại này.
  const isAnchored = (c: DocRedlineChange) =>
    c.kind === 'flow-diagram' ? diagramMounts.some((m) => m.changeId === c.id) : anchored.has(c.id);

  const navigationItems = useMemo<RedlineNavigationItem[]>(() => {
    if (previewMode === 'notes') {
      return notes.map((note) => ({
        id: `${NOTE_ID_PREFIX}${note.id}`,
        anchored: anchored.has(`${NOTE_ID_PREFIX}${note.id}`),
        dismissed: note.status === 'dismissed',
      }));
    }
    return changes
      .filter((change) => change.kind !== 'flow-diagram' || kindFilter.diagram)
      .filter((change) => !isComponentTableChange(change) || kindFilter.compTable)
      .map((change) => ({ id: change.id, anchored: isAnchored(change), dismissed: change.status === 'dismissed' }));
  }, [previewMode, notes, changes, anchored, diagramMounts, kindFilter]);
  const navigationPosition = getNavigationPosition(navigationItems, selectedId);
  function navigate(direction: 'previous' | 'next') {
    const id = getAdjacentNavigationId(navigationItems, selectedId, direction);
    if (id) selectFromList(id);
  }

  // Số thứ tự map LỖI ↔ VÙNG BÔI: chỗ sửa đánh 1..N theo thứ tự rail, nhận xét
  // đánh N1..Nk (namespace riêng để không lẫn với chỗ sửa). Cùng một map dùng
  // cho badge trên thẻ, con số trên vùng bôi, và cột STT trong phụ lục in.
  const idxById = useMemo(() => {
    const map = new Map<string, string>();
    changes.forEach((c, i) => map.set(c.id, String(i + 1)));
    notes.forEach((n, i) => map.set(`${NOTE_ID_PREFIX}${n.id}`, `N${i + 1}`));
    return map;
  }, [changes, notes]);

  // Dán số lên MỌI vùng bôi đang có trong DOM (cột chính + modal tham chiếu +
  // sheet in đều render mark[data-change-id]); CSS ::after đọc data-od-idx ra
  // badge. Chạy mỗi render — đếm mark là việc rẻ, còn deps-chính-xác thì phải
  // đuổi theo cả docHtml lẫn thời điểm modal/portal mount.
  useEffect(() => {
    document.querySelectorAll<HTMLElement>('mark[data-change-id]').forEach((m) => {
      const idx = idxById.get(m.dataset.changeId ?? '');
      if (idx) m.dataset.odIdx = idx;
      else delete m.dataset.odIdx;
    });
  });

  return (
    <div className="viewer">
      <div className={`viewer-body ${styles.viewerBody}`}>
        {loading ? (
          <div className="viewer-empty">Đang tải…</div>
        ) : (
          <div className={styles.wrap}>
            {changesState.status === 'ok' ? (
              <div className={styles.strip}>
                <span>
                  {previewMode === 'changes'
                    ? `${opCounts.edit} sửa · ${opCounts.add} thêm · ${opCounts.del} xoá${notes.length === 0 ? ' · 0 nhận xét' : ''}`
                    : `${activeNoteCount} nhận xét`}{' · '}
                  {(previewMode === 'changes' ? changes : notes).filter((item) => item.status === 'dismissed').length} đã bỏ ·{' '}
                  {markCount} vùng bôi
                  {previewMode === 'changes' && diagramCount > 0 ? ` · ${diagramCount} sơ đồ` : ''}
                  {previewMode === 'changes' && compTableCount > 0 ? ` · ${compTableCount} bảng` : ''}
                </span>
                <button
                  type="button"
                  className={styles.printButton}
                  onClick={() => {
                    // Bật cờ trên <body> để CSS in chỉ hiện tấm sheet portal;
                    // dọn bằng afterprint + timeout dự phòng (Safari cũ không
                    // bắn afterprint đều).
                    const old = document.title;
                    document.title = `review-${file.name.split('/').pop()?.replace(/\.md$/i, '') ?? 'document'}`;
                    document.body.dataset.odPrint = 'redline';
                    const cleanup = () => {
                      document.title = old;
                      delete document.body.dataset.odPrint;
                      window.removeEventListener('afterprint', cleanup);
                    };
                    window.addEventListener('afterprint', cleanup);
                    window.print();
                    window.setTimeout(cleanup, 1500);
                  }}
                >
                  Xuất PDF
                </button>
                {previewMode === 'changes' ? (
                  <HighlightFilters
                    paint={paint}
                    onChange={setPaintKind}
                    counts={{ add: opCounts.add, edit: opCounts.edit, del: opCounts.del, note: 0 }}
                    includeNote={notes.length === 0}
                  />
                ) : null}
                {/* Hai chip lọc MỚI của WP3 — chỉ hiện khi có ÍT NHẤT một
                    change tương ứng, cùng khuôn .chip/.chipSwatch với bốn chip
                    màu ở trên nhưng lọc THEO KIND (ẩn/hiện mục rail), không
                    lọc màu vùng bôi (xem kindFilter). */}
                {previewMode === 'changes' && (diagramCount > 0 || compTableCount > 0) ? (
                  <div className={styles.filters} role="group" aria-label="Lọc theo loại">
                    {diagramCount > 0 ? (
                      <label className={`${styles.chip} ${kindFilter.diagram ? '' : styles.chipOff ?? ''}`}>
                        <input
                          type="checkbox"
                          className={styles.chipInput}
                          checked={kindFilter.diagram}
                          onChange={(ev) => setKindFilterState((prev) => ({ ...prev, diagram: ev.target.checked }))}
                        />
                        Sơ đồ<span className={styles.chipCount}>{diagramCount}</span>
                      </label>
                    ) : null}
                    {compTableCount > 0 ? (
                      <label className={`${styles.chip} ${kindFilter.compTable ? '' : styles.chipOff ?? ''}`}>
                        <input
                          type="checkbox"
                          className={styles.chipInput}
                          checked={kindFilter.compTable}
                          onChange={(ev) => setKindFilterState((prev) => ({ ...prev, compTable: ev.target.checked }))}
                        />
                        Bảng thành phần<span className={styles.chipCount}>{compTableCount}</span>
                      </label>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : (
              <div className={styles.strip}>
                <Icon name="info" size={13} />
                <span>
                  {changesState.status === 'malformed'
                    ? 'Không đọc được chú giải (*.changes.json hỏng) — chỉ hiện tài liệu.'
                    : 'Không có chú giải cho tài liệu này.'}
                </span>
              </div>
            )}
            <div className={styles.userToolbar}>
              <span className={styles.userToolbarHint}>Bôi đen một đoạn để tự chỉnh:</span>
              <button type="button" onClick={() => startUserAnnotation('edited')}>Sửa đoạn chọn</button>
              <button type="button" onClick={() => startUserAnnotation('delete')}>Xoá đoạn chọn</button>
              <button type="button" onClick={() => startUserAnnotation('add')}>Thêm sau đoạn chọn</button>
              {/* wp4.yaml mục 2: bắt đầu từ một heading thay vì bôi đen — cùng
                  composer "Thêm sau đoạn chọn" (`startHeadingAnnotation` chỉ
                  đổi nguồn `selected`). */}
              <button
                type="button"
                disabled={headings.length === 0}
                title={headings.length === 0 ? 'Tài liệu không có mục nào (dòng bắt đầu #)' : undefined}
                onClick={() => setHeadingPickerOpen((open) => !open)}
              >
                Thêm sau mục…
              </button>
              {draftError && !draft ? <span className={styles.toolbarError}>{draftError}</span> : null}
            </div>
            {headingPickerOpen ? (
              <div className={styles.headingPicker ?? ''} role="group" aria-label="Chọn mục để thêm sau">
                <select
                  aria-label="Chọn mục"
                  value={headingPickerValue}
                  onChange={(event) => setHeadingPickerValue(event.target.value)}
                >
                  <option value="">— Chọn mục —</option>
                  {headings.map((h, i) => (
                    <option key={i} value={String(i)}>{`${'#'.repeat(h.level)} ${h.text}`}</option>
                  ))}
                </select>
                <button
                  type="button"
                  disabled={headingPickerValue === ''}
                  onClick={() => {
                    const heading = headings[Number(headingPickerValue)];
                    if (heading) startHeadingAnnotation(heading);
                  }}
                >
                  Thêm
                </button>
                <button type="button" onClick={() => { setHeadingPickerOpen(false); setHeadingPickerValue(''); }}>Đóng</button>
              </div>
            ) : null}
            {draft ? (
              <div className={styles.annotationComposer} role="group" aria-label="Tạo thay đổi của người dùng">
                <div className={styles.annotationComposerHead}>
                  <strong>{draft.operation === 'edited' ? 'Sửa đoạn đã chọn' : draft.operation === 'delete' ? 'Xoá đoạn đã chọn' : 'Thêm sau đoạn đã chọn'}</strong>
                  <button type="button" onClick={() => { setDraft(null); setDraftError(''); }}>Đóng</button>
                </div>
                <p className={styles.selectedQuote}>“{refLabel(draft.selected)}”</p>
                {draft.operation !== 'delete' ? (
                  <>
                    {/* wp4.yaml mục 3: chỉ Sửa/Thêm mới phân loại được — Xoá
                        không có "nội dung mới" nào để gắn một loại cho nó. */}
                    <select
                      aria-label="Loại"
                      value={draft.kind}
                      onChange={(event) =>
                        setDraft((current) => (current ? { ...current, kind: event.target.value as DocRedlineChangeKind } : current))
                      }
                    >
                      {USER_KIND_OPTIONS.map((k) => (
                        <option key={k} value={k}>{KIND_LABEL[k]}</option>
                      ))}
                    </select>
                    <textarea
                      aria-label="Nội dung mới"
                      placeholder={draft.operation === 'add' ? 'Nội dung cần thêm' : 'Nội dung thay thế'}
                      value={draft.replacement}
                      onChange={(event) => setDraft((current) => current ? { ...current, replacement: event.target.value } : current)}
                    />
                  </>
                ) : null}
                <input
                  aria-label="Lý do thay đổi"
                  placeholder="Lý do (không bắt buộc)"
                  value={draft.reason}
                  onChange={(event) => setDraft((current) => current ? { ...current, reason: event.target.value } : current)}
                />
                {draftError ? <p className={styles.error}>{draftError}</p> : null}
                <div className={styles.actions}>
                  <button type="button" disabled={busyId != null} onClick={() => void createUserAnnotation()}>
                    {busyId ? 'Đang lưu...' : 'Lưu thay đổi'}
                  </button>
                  <button type="button" disabled={busyId != null} onClick={() => { setDraft(null); setDraftError(''); }}>Huỷ</button>
                </div>
              </div>
            ) : null}
            <div className={`${styles.grid} ${panelOpen ? '' : styles.gridFull ?? ''}`}>
              <div className={styles.docCol} ref={docColRef}>
                <div className={`${styles.docToolbarWp3 ?? ''} ${styles.modeToolbar ?? ''}`}>
                  <DocRedlineModeControls
                    mode={previewMode}
                    changeCount={activeChangeCount}
                    noteCount={activeNoteCount}
                    onModeChange={changePreviewMode}
                    placement="document"
                  />
                  <DocRedlineNavigation
                    mode={previewMode}
                    current={navigationPosition.current}
                    total={navigationPosition.total}
                    onPrevious={() => navigate('previous')}
                    onNext={() => navigate('next')}
                  />
                  <button
                    type="button"
                    className={styles.panelToggleBtn ?? ''}
                    aria-label="Ẩn/Hiện chú giải"
                    aria-pressed={panelOpen}
                    onClick={togglePanel}
                  >
                    {panelOpen ? 'Ẩn chú giải ]' : 'Hiện chú giải ]'}
                  </button>
                </div>
                {/* Safe by contract: renderMarkdownToSafeHtml escapes raw HTML
                    and rejects unsafe link protocols. */}
                <article
                  id="doc-redline-document-tabpanel"
                  role="tabpanel"
                  aria-labelledby={`doc-redline-document-${previewMode}-tab`}
                  className="markdown-rendered"
                  dangerouslySetInnerHTML={{ __html: docHtml ?? '' }}
                />
                {/* Sơ đồ mermaid sống, portal vào các host đã chèn trong
                    docHtml (xem effect dựng diagramMounts ở trên). */}
                {diagramMounts.map((m, i) =>
                  createPortal(
                    <>
                      {m.changeId ? (
                        <div className={styles.diagramToggle ?? ''} role="group" aria-label="Xem sơ đồ gốc hay đề xuất">
                          <button
                            type="button"
                            className={diagramView[m.changeId] !== 'original' ? styles.diagramToggleOn ?? '' : undefined}
                            onClick={(ev) => {
                              ev.stopPropagation();
                              setDiagramView((prev) => ({ ...prev, [m.changeId as string]: 'proposed' }));
                            }}
                          >
                            ◉ Đề xuất
                          </button>
                          <button
                            type="button"
                            className={diagramView[m.changeId] === 'original' ? styles.diagramToggleOn ?? '' : undefined}
                            onClick={(ev) => {
                              ev.stopPropagation();
                              setDiagramView((prev) => ({ ...prev, [m.changeId as string]: 'original' }));
                            }}
                          >
                            ○ Gốc
                          </button>
                        </div>
                      ) : null}
                      <MermaidDiagram code={activeDiagramCode(m)} initialFit="width" />
                    </>,
                    m.host,
                    `diagram-${i}`,
                  ),
                )}
              </div>
              {/* Panel ẩn: rail giữ NGUYÊN trong DOM (mục vẫn ref được để cuộn
                  khi mở lại — xem selectFromDoc) nhưng `hidden` + aria-hidden,
                  cùng lúc `.gridFull` ở trên trả hết bề rộng cho tài liệu. */}
              <div
                className={`${styles.rail} ${panelOpen ? '' : styles.railHidden ?? ''}`}
                hidden={!panelOpen}
                aria-hidden={!panelOpen}
              >
                <div className={styles.railToolbar ?? ''}>
                  <DocRedlineModeControls
                    mode={previewMode}
                    changeCount={activeChangeCount}
                    noteCount={activeNoteCount}
                    onModeChange={changePreviewMode}
                    placement="rail"
                  />
                </div>
                <div
                  id="doc-redline-rail-tabpanel"
                  role="tabpanel"
                  aria-labelledby={`doc-redline-rail-${previewMode}-tab`}
                  className={styles.railPanel ?? ''}
                >
                {(previewMode === 'changes' ? changes.length : notes.length) === 0 ? (
                  <p className={styles.empty}>{previewMode === 'changes' ? 'Không có thay đổi nào.' : 'Không có nhận xét nào.'}</p>
                ) : (
                  <>
                    {previewMode === 'changes' ? changes.map((c, changeIdx) => {
                    // Chip "Sơ đồ"/"Bảng thành phần" tắt: ẩn MỤC khỏi rail
                    // nhưng KHÔNG bỏ khỏi mảng `changes` — giữ số thứ tự
                    // (STT/idxById) ổn định khi bật lại, đúng như bốn chip màu
                    // (add/edit/del/note) ẩn mark chứ không xoá mark.
                    if (c.kind === 'flow-diagram' && !kindFilter.diagram) return null;
                    if (isComponentTableChange(c) && !kindFilter.compTable) return null;
                    const setItemRef = (el: HTMLElement | null) => {
                      if (el) itemsByChangeRef.current.set(c.id, el);
                      else itemsByChangeRef.current.delete(c.id);
                    };
                    const activeClass = selectedId === c.id ? styles.itemActive ?? '' : '';
                    const detail = (
                      <ChangeDetail
                        idx={String(changeIdx + 1)}
                        change={c}
                        ruleOpen={openRule?.ownerId === c.id}
                        ruleBody={ruleBody}
                        onToggleRule={() => c.rule_id && toggleRule(c.id, c.rule_id)}
                        isRefAnchored={(i) => anchored.has(`${REF_ID_PREFIX}${c.id}:${i}`)}
                        onJumpRef={(i) =>
                          openRefModal(`${REF_ID_PREFIX}${c.id}:${i}`, (c.doc_refs ?? [])[i] ?? '')
                        }
                        busy={busyId === c.id} error={errorById[c.id]} showActions={isAnchored(c) || c.status === 'dismissed'} undoable={undoableIds.has(c.id)} editing={editingId === c.id} editText={editText} onEditText={setEditText} onEdit={() => { setEditingId(c.id); setEditText(c.quote ?? ''); }} onSaveEdit={() => { if (!editText.trim()) { setErrorById((p) => ({ ...p, [c.id]: 'Nội dung sửa không được để trống' })); return; } void editChange(c); }} onCancelEdit={() => setEditingId(null)} onDismiss={() => { if (c.status === 'dismissed') { void dismissChange(c); } else if (window.confirm('Bỏ thay đổi này khỏi tài liệu? Bạn có thể hoàn tác trong phiên hiện tại.')) void dismissChange(c); }}
                        expanded={expandedIds.has(c.id)}
                        onToggleExpand={() => toggleExpanded(c.id)}
                        accepted={acceptedIds.has(c.id)}
                        onAccept={() => acceptChange(c.id)}
                        onSaveTable={(newQuote) => saveComponentTableEdit(c, newQuote)}
                      />
                    );
                    // `div role="button"` chứ không phải `<button>` thật: thẻ
                    // giờ chứa các nút con (chip rule, nút tham chiếu) và
                    // `<button>` lồng `<button>` là HTML không hợp lệ — trình
                    // duyệt tự gỡ lồng, làm mất luôn nút con. Bàn phím vẫn dùng
                    // được nhờ tabIndex + xử lý Enter/Space bên dưới.
                    if (isAnchored(c)) {
                      return (
                        <div
                          key={c.id}
                          role="button"
                          tabIndex={0}
                          ref={setItemRef}
                          data-change-item={c.id}
                          className={`${styles.item} ${activeClass}`}
                          onClick={() => selectFromList(c.id)}
                          onKeyDown={(ev) => {
                            if (ev.key !== 'Enter' && ev.key !== ' ') return;
                            // Bấm phím trên một nút CON (chip rule / tham chiếu)
                            // nổi bọt lên đây; xử lý tiếp sẽ chạy hai hành động
                            // cho một lần bấm.
                            if (ev.target !== ev.currentTarget) return;
                            ev.preventDefault();
                            selectFromList(c.id);
                          }}
                        >
                          {detail}
                        </div>
                      );
                    }
                    return (
                      <div
                        key={c.id}
                        ref={setItemRef}
                        data-change-item={c.id}
                        className={`${styles.item} ${styles.itemDead}`}
                      >
                        {detail}
                        <p className={styles.itemDeadNote}>
                          <Icon name="info" size={12} />
                          Không tìm thấy trong tài liệu — không nhảy tới được.
                        </p>
                      </div>
                    );
                  }) : null}
                    {previewMode === 'notes' && notes.length > 0 ? (
                      <>
                        <h3 className={styles.railHeading}>Nhận xét (không sửa trực tiếp)</h3>
                        {notes.map((n, noteIdx) => {
                          const markId = `${NOTE_ID_PREFIX}${n.id}`;
                          const setItemRef = (el: HTMLElement | null) => {
                            if (el) itemsByChangeRef.current.set(markId, el);
                            else itemsByChangeRef.current.delete(markId);
                          };
                          const activeClass = selectedId === markId ? styles.itemActive ?? '' : '';
                          const detail = (
                            <NoteDetail
                            idx={`N${noteIdx + 1}`}
                              note={n}
                              ruleOpen={openRule?.ownerId === markId}
                              ruleBody={ruleBody}
                              onToggleRule={() => n.rule_id && toggleRule(markId, n.rule_id)}
                              isRefAnchored={(i) => anchored.has(`${REF_ID_PREFIX}${markId}:${i}`)}
                              onJumpRef={(i) =>
                                openRefModal(`${REF_ID_PREFIX}${markId}:${i}`, (n.doc_refs ?? [])[i] ?? '')
                              }
                              busy={busyId === markId} error={errorById[markId]} undoable={undoableIds.has(markId)} onDismiss={() => void dismissNote(n)}
                            />
                          );
                          if (anchored.has(markId)) {
                            return (
                              <div
                                key={markId}
                                role="button"
                                tabIndex={0}
                                ref={setItemRef}
                                data-change-item={markId}
                                className={`${styles.item} ${activeClass}`}
                                onClick={() => selectFromList(markId)}
                                onKeyDown={(ev) => {
                                  if (ev.key !== 'Enter' && ev.key !== ' ') return;
                                  if (ev.target !== ev.currentTarget) return;
                                  ev.preventDefault();
                                  selectFromList(markId);
                                }}
                              >
                                {detail}
                              </div>
                            );
                          }
                          return (
                            <div
                              key={markId}
                              ref={setItemRef}
                              data-change-item={markId}
                              className={`${styles.item} ${styles.itemDead}`}
                            >
                              {detail}
                              <p className={styles.itemDeadNote}>
                                <Icon name="info" size={12} />
                                Không tìm thấy trong tài liệu — không nhảy tới được.
                              </p>
                            </div>
                          );
                        })}
                      </>
                    ) : null}
                  </>
                )}
                </div>
              </div>
            </div>
            {/* Tab dọc mỏng ở mép phải — chỉ hiện khi panel ẩn, bấm mở lại. */}
            {!panelOpen ? (
              <button
                type="button"
                className={styles.panelTab ?? ''}
                aria-label="Hiện chú giải"
                onClick={togglePanel}
              >
                {activeChangeCount} · {dismissedTotalCount} · {activeNoteCount}
              </button>
            ) : null}
          </div>
        )}
      </div>

      {/* BẢN IN qua portal thẳng vào <body>: cây app bọc viewer trong nhiều
          container cao-cố-định + overflow hidden (khung Quick result, panel,
          entry-main…), in tại chỗ là bị cắt còn đúng một trang khung rỗng.
          Portal là lối thoát duy nhất khỏi mọi clipping đó; khi in, CSS ẩn hết
          body > * trừ tấm sheet này (gate bằng data-od-print để không phá lệnh
          in của màn khác). */}
      {typeof document === 'undefined'
        ? null
        : createPortal(
            <div className={styles.printSheet} data-od-print-sheet="true" aria-hidden="true">
              <section className={styles.printCover}>
                <h1>Báo cáo review tài liệu</h1>
                <p><strong>{file.name.split('/').pop()?.replace(/\.md$/i, '') ?? 'Tài liệu'}</strong></p>
                <p>{file.name}</p>
                <p>{new Date().toLocaleString('vi-VN')}</p>
                <p><strong>Chế độ: {modeLabel(previewMode)}</strong></p>
                <p>{previewMode === 'changes' ? `${activeChangeCount} chỗ sửa còn hiệu lực` : `${activeNoteCount} nhận xét còn hiệu lực`}</p>
              </section>
              {/* Safe by contract: renderMarkdownToSafeHtml escapes raw HTML. */}
              <article className="markdown-rendered" dangerouslySetInnerHTML={{ __html: docHtml ?? '' }} />
              <section className={styles.printAppendix}>
                <h2>Phụ lục — {modeLabel(previewMode).toLocaleLowerCase('vi')}</h2>
                <table><thead><tr><th>STT</th><th>Loại / rule</th><th>Mức độ</th><th>Thay đổi / nhận xét</th><th>Lý do</th></tr></thead><tbody>
                  {previewMode === 'changes' ? changes.map((c, i) => <tr key={`print-${c.id}`} className={c.status === 'dismissed' ? styles.printDismissed : undefined}><td>{i + 1}</td><td>{KIND_LABEL[c.kind]}{c.rule_id ? ` — ${ruleChipMeta(c.rule_id).label}` : ''}</td><td>{SEV_LABEL[c.severity]}</td><td>{c.before ?? '—'} → {c.quote ?? '—'}{c.status === 'dismissed' ? ' (Đã bỏ)' : ''}</td><td>{c.reason}</td></tr>) : null}
                  {previewMode === 'notes' ? notes.map((n, i) => <tr key={`print-${NOTE_ID_PREFIX}${n.id}`} className={n.status === 'dismissed' ? styles.printDismissed : undefined}><td>N{i + 1}</td><td>Nhận xét — {KIND_LABEL[n.kind]}{n.rule_id ? ` — ${ruleChipMeta(n.rule_id).label}` : ''}</td><td>{SEV_LABEL[n.severity]}</td><td>{n.finding}{n.status === 'dismissed' ? ' (Đã bỏ)' : ''}</td><td>{n.suggestion}</td></tr>) : null}
                </tbody></table>
              </section>
            </div>,
            document.body,
          )}

      {refModal ? (
        <div
          className={styles.modalBackdrop}
          role="presentation"
          // Bấm nền để đóng, nhưng CHỈ khi cú bấm rơi đúng vào nền: không kiểm
          // `ev.target` thì mọi cú bấm bên trong khung (kể cả bôi đen chữ) đều
          // nổi bọt lên đây và đóng mất cửa sổ.
          onClick={(ev) => {
            if (ev.target === ev.currentTarget) setRefModal(null);
          }}
        >
          <div className={styles.modal} role="dialog" aria-modal="true" aria-label="Đoạn được tham chiếu">
            <div className={styles.modalHead}>
              <div className={styles.modalTitleWrap}>
                <span className={styles.modalTitle}>Đoạn được tham chiếu</span>
                {refModal.label ? <span className={styles.modalQuote}>“{refLabel(refModal.label)}”</span> : null}
              </div>
              <div className={styles.modalActions}>
                {previewMode === 'changes' ? <HighlightFilters paint={paint} onChange={setPaintKind} includeNote={notes.length === 0} /> : null}
                <button type="button" className={styles.modalClose} onClick={() => setRefModal(null)}>
                  Đóng
                </button>
              </div>
            </div>
            {/* BẢN SAO tài liệu riêng cho modal, không dùng lại cột chính: cột
                chính phải giữ nguyên vị trí cuộn của người đọc — đó là lý do
                cửa sổ này tồn tại thay vì nhảy tại chỗ. Mark ở đây nằm ngoài
                `docColRef` nên không lọt vào bản đồ mark của cột chính. */}
            <div className={styles.modalBody} ref={modalDocRef}>
              {/* Safe by contract: renderMarkdownToSafeHtml escapes raw HTML. */}
              <article className="markdown-rendered" dangerouslySetInnerHTML={{ __html: docHtml ?? '' }} />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Bộ lọc màu — CHÍNH LÀ chú thích màu, không phải một hàng điều khiển thứ hai.
 *
 *  Vì sao gộp: chú thích ("ô vuông vàng nghĩa là sửa") và bộ lọc ("ẩn chỗ sửa
 *  đi") nói về cùng bốn thứ. Tách thành hai hàng thì màn hình có hai chỗ liệt kê
 *  cùng một danh sách, và người dùng phải đối chiếu chúng với nhau mới biết ô
 *  nào ứng với màu nào.
 *
 *  Dùng ở HAI nơi (thanh tóm tắt và đầu cửa sổ tham chiếu) nhưng chung MỘT state
 *  ở component cha — tắt ở đâu thì cả hai chỗ cùng tắt. Hai bộ công tắc độc lập
 *  cho cùng một thứ là cách chắc chắn để người dùng tưởng đã tắt rồi mà màn hình
 *  vẫn còn màu.
 *
 *  Tắt CHỈ gỡ phần sơn, không gỡ mark: chỗ sửa vẫn bấm được, thẻ bên phải vẫn
 *  nhảy tới được, và chỗ xoá vẫn còn gạch ngang (xem HL_DEL_OFF_INLINE_STYLE). */
function HighlightFilters({
  paint,
  onChange,
  counts,
  includeNote = true,
}: {
  paint: PaintFlags;
  onChange: (kind: PaintKind, next: boolean) => void;
  counts?: Partial<Record<PaintKind, number>>;
  includeNote?: boolean;
}) {
  return (
    <div className={styles.filters} role="group" aria-label="Hiện tô màu theo loại">
      {/* Không có dòng này thì bốn chip màu đọc như một chú thích tĩnh — người
          dùng không có lý do nào để thử bấm vào chúng. */}
      <span className={styles.filtersHint}>Bấm để ẩn/hiện:</span>
      {PAINT_ITEMS.filter(({ kind }) => includeNote || kind !== 'note').map(({ kind, label, swatch }) => {
        const on = paint[kind];
        const n = counts?.[kind];
        return (
          <label
            key={kind}
            className={`${styles.chip} ${on ? '' : styles.chipOff ?? ''}`}
            title={on ? `Ẩn vùng bôi "${label}"` : `Hiện vùng bôi "${label}"`}
            onClick={(ev) => ev.stopPropagation()}
          >
            <input
              type="checkbox"
              className={styles.chipInput}
              checked={on}
              onChange={(ev) => onChange(kind, ev.target.checked)}
            />
            {/* Dấu tick nằm TRONG ô màu: một ô vuông có tick là hình ảnh ai
                cũng đọc ra ngay là checkbox, mà vẫn không phải thêm một hộp
                vuông thứ hai bên cạnh ô màu. */}
            <span className={`${styles.chipSwatch} ${swatch}`}>
              <span className={styles.chipCheck} aria-hidden="true">
                ✓
              </span>
            </span>
            {label}
            {typeof n === 'number' ? <span className={styles.chipCount}>{n}</span> : null}
          </label>
        );
      })}
    </div>
  );
}

/** Props chung cho phần tham chiếu của cả hai loại thẻ — change và note hiển
 *  thị khác nhau ở phần diff, nhưng cơ chế trace (rule + doc_refs) giống hệt. */
interface RefProps {
  ruleOpen: boolean;
  ruleBody: RuleBody;
  onToggleRule: () => void;
  isRefAnchored: (index: number) => boolean;
  onJumpRef: (index: number) => void;
  busy?: boolean;
  error?: string;
  undoable?: boolean;
}

/** Chip `rule_id` bấm được: nhãn dễ hiểu ngoài, mã kỹ thuật + giải thích trong.
 *
 *  Vì sao không hiện thẳng mã: `criteria/rules.md#R-OVERLAY` chỉ nói cho người
 *  đọc biết có một luật tên vậy tồn tại ở đâu đó — muốn biết luật nói gì phải
 *  tự mở file criteria trong một tab khác. Ba mức dài dần: chip là nhãn ngắn,
 *  rê chuột ra một câu, bấm vào ra cả đoạn kèm mã đầy đủ để trace ngược.
 *
 *  Tooltip dùng `title` chứ không phải pseudo-element như `[data-tooltip]` ở
 *  styles/viewer/core.css: hai chỗ đó tooltip nằm trên nút icon vuông cỡ cố
 *  định (`white-space: nowrap`, canh giữa theo bề ngang nút), còn chip ở đây
 *  dài ngắn tuỳ nhãn và nằm trong rail có cuộn riêng — tooltip vẽ bằng CSS sẽ
 *  bị chính rail cắt mất.
 *
 *  `stopPropagation` ở mọi nút con: thẻ bao ngoài cũng bắt click (để nhảy tới
 *  vùng bôi), nên nếu không chặn thì một cú bấm chạy hai việc. */
function RuleChip({ ruleId, open, body, onToggle }: { ruleId: string; open: boolean; body: RuleBody; onToggle: () => void }) {
  const { label, summary } = ruleChipMeta(ruleId);
  return (
    <span className={styles.ruleWrap}>
      {/* Badge là nhãn thuần — phần bấm được là dấu "?" đứng cạnh: affordance
          rõ ràng hơn một cái chip trông như chữ thường. */}
      <span className={styles.ruleId} title={summary}>
        {label}
      </span>
      <button
        type="button"
        className={styles.ruleHelpBtn}
        aria-expanded={open}
        aria-label={`Giải thích rule ${label}`}
        title={summary}
        onClick={(ev) => {
          ev.stopPropagation();
          onToggle();
        }}
      >
        ?
      </button>
      {open ? (
        <span className={styles.rulePop} role="note" onClick={(ev) => ev.stopPropagation()}>
          <span className={styles.rulePopHead}>
            <span className={styles.rulePopLabel}>{label}</span>
            {/* Mã kỹ thuật vẫn phải còn: nó là đường duy nhất đi ngược từ một
                chỗ sửa về đúng mục trong file criteria. */}
            <span className={styles.rulePopCode}>{ruleId}</span>
          </span>
          <span className={styles.rulePopBody}>
            {body.status === 'loading' ? (
              'Đang tải…'
            ) : body.status === 'missing' ? (
              'Không tìm thấy nội dung rule trong criteria/.'
            ) : body.status === 'text' ? (
              body.text
            ) : (
              // Safe by contract: renderMarkdownToSafeHtml escapes raw HTML and
              // rejects unsafe link protocols (cùng lý do như cột tài liệu).
              <span className="markdown-rendered" dangerouslySetInnerHTML={{ __html: body.html }} />
            )}
          </span>
        </span>
      ) : null}
    </span>
  );
}

/** Hàng nút "Tham chiếu": mỗi `doc_refs` một nút nhảy tới đoạn được viện dẫn.
 *  Ref không neo được vào tài liệu thì nút mờ đi thay vì biến mất — biến mất
 *  làm người đọc tưởng lý do không hề viện dẫn gì. */
function RefRow({ refs, isRefAnchored, onJumpRef }: { refs: string[] } & Pick<RefProps, 'isRefAnchored' | 'onJumpRef'>) {
  if (refs.length === 0) return null;
  return (
    <p className={styles.refRow}>
      <span className={styles.refLabel}>Tham chiếu</span>
      {refs.map((ref, i) => {
        const ok = isRefAnchored(i);
        return (
          <button
            key={i}
            type="button"
            className={styles.refBtn}
            disabled={!ok}
            title={ok ? ref : 'Không tìm thấy đoạn tham chiếu trong tài liệu'}
            onClick={(ev) => {
              ev.stopPropagation();
              onJumpRef(i);
            }}
          >
            ↳ {refLabel(ref)}
          </button>
        );
      })}
    </p>
  );
}

/** Một khối chi tiết của một NOTE: nhóm, mức độ, rule_id, phát hiện, đề xuất.
 *  Không có `before → quote` vì note không sửa gì — đó là điểm phân biệt với
 *  ChangeDetail, và cũng là lý do thẻ mang nhãn riêng. */
function NoteDetail({ note: n, idx, ruleOpen, ruleBody, onToggleRule, isRefAnchored, onJumpRef, busy, error, undoable, onDismiss }: { note: DocRedlineNote; idx?: string; onDismiss: () => void } & RefProps) {
  return (
    <div className={`${styles.card} ${styles.noteCard} ${SEV_CLASS[n.severity]} ${n.status === 'dismissed' ? styles.dismissed : ''}`}>
      <div className={styles.cardHead}>
        {idx ? <span className={styles.cardIdx}>{idx}</span> : null}
        <span className={styles.cardKind}>{KIND_LABEL[n.kind]}</span>
        <span className={styles.sevBadge}>{SEV_LABEL[n.severity]}</span>
      </div>
      {n.rule_id ? <RuleChip ruleId={n.rule_id} open={ruleOpen} body={ruleBody} onToggle={onToggleRule} /> : null}
      <p className={styles.reason}>{n.finding}</p>
      {n.suggestion ? (
        <p className={styles.suggestion}>
          <span className={styles.suggestionLabel}>Đề xuất</span> {n.suggestion}
        </p>
      ) : null}
      <RefRow refs={n.doc_refs ?? []} isRefAnchored={isRefAnchored} onJumpRef={onJumpRef} />
      <div className={styles.actions}><button type="button" disabled={busy} onClick={(ev) => { ev.stopPropagation(); onDismiss(); }}>{n.status === 'dismissed' && undoable ? 'Hoàn tác' : 'Bỏ'}</button>{n.status === 'dismissed' ? <span className={styles.badgeDeleted}>Đã bỏ</span> : null}</div>
      {error ? <p className={styles.error}>{error}</p> : null}
    </div>
  );
}

/** Props chung của "Chi tiết ▾" — chỉ hai loại thẻ MỚI (sơ đồ, bảng thành
 *  phần) có nút này (xem docblock trên `ChangeDetail`); mở/đóng theo id, "Chấp
 *  nhận" đánh dấu TRONG PHIÊN (không ghi file — xem `acceptedIds` ở component
 *  cha, lý do không có status 'accepted' trong contracts). */
interface CompactCardProps {
  expanded: boolean;
  onToggleExpand: () => void;
  accepted: boolean;
  onAccept: () => void;
}

/** Một khối chi tiết của một change: nhóm, mức độ, rule_id, lý do, và phần
 *  chữ cũ/chữ mới tuỳ theo phép sửa. Đây là nơi trường `before` (chữ cũ) tiếp
 *  tục sống sau khi cột tài liệu gốc bị bỏ.
 *
 *  Hai loại MỚI của WP3 (sơ đồ `flow-diagram`, bảng thành phần — change
 *  `component` không `before` với `rule_id` bắt đầu `comp/`) render theo
 *  khuôn thẻ-3-dòng riêng (`FlowDiagramCardBody`/`ComponentTableCardBody`).
 *
 *  wp3b.yaml mục D mở khuôn 3-dòng đó cho MỌI thẻ, kể cả các loại CŨ
 *  (`ux-writing`/`flow`/`gap`/`edge-case`/`component` có `before`, và change
 *  `origin: 'user'`) — nhánh dưới đây. `rule_id` VẪN hiện trên mặt thẻ (chip
 *  RuleChip, giữ nguyên như trước) vì đó là nhãn thân thiện chứ không phải mã
 *  thô; `reason` đầy đủ/RefRow/diff đầy đủ chuyển vào sau "Chi tiết ▾" — mặt
 *  thẻ chỉ còn tiêu đề (reason cắt 60 ký tự) + một dòng diff rút gọn. Các
 *  test cũ (doc-redline-preview/.ops/.refs/.rule-chip.test.tsx — nay đều nằm
 *  trong `touches` của wp3b.yaml) đã được cập nhật để mở "Chi tiết" trước khi
 *  assert phần đã gập; class DOM của phần diff đầy đủ (EditDiff/blockAdd/
 *  blockDel/diffBefore/diffAfter) giữ NGUYÊN để những test đó không phải đổi
 *  cách tìm phần tử, chỉ đổi thời điểm tìm. */
function ChangeDetail(
  props: {
    change: DocRedlineChange;
    idx?: string;
    showActions: boolean;
    undoable?: boolean;
    editing: boolean;
    editText: string;
    onEditText: (value: string) => void;
    onEdit: () => void;
    onSaveEdit: () => void;
    onCancelEdit: () => void;
    onDismiss: () => void;
    /** wp4.yaml mục 1 — chỉ `ComponentTableCardBody` đọc prop này; các nhánh
     *  khác của `ChangeDetail` nhận nó qua spread nhưng bỏ qua, cùng khuôn với
     *  `onEdit`/`onSaveEdit`… (chỉ nhánh mặc định dùng). Trả `Promise<boolean>`
     *  (vá N2 review attempt2): `ComponentTableCardBody` chờ kết quả trước khi
     *  quyết định đóng form. */
    onSaveTable: (newQuote: string) => Promise<boolean>;
  } & RefProps & CompactCardProps,
) {
  const { change: c } = props;
  if (c.kind === 'flow-diagram') return <FlowDiagramCardBody {...props} />;
  if (isComponentTableChange(c)) return <ComponentTableCardBody {...props} />;
  const { idx, ruleOpen, ruleBody, onToggleRule, isRefAnchored, onJumpRef, busy, error, showActions, undoable, editing, editText, onEditText, onEdit, onSaveEdit, onCancelEdit, onDismiss, expanded, onToggleExpand } = props;
  const op = changeOp(c);
  const beforePreview = diffPreviewSide(c.before);
  const afterPreview = diffPreviewSide(c.quote);
  return (
    <div className={`${styles.card} ${styles.cardCompact ?? ''} ${SEV_CLASS[c.severity]} ${c.status === 'dismissed' ? styles.dismissed : ''}`}>
      <div className={styles.cardHead}>
        {idx ? <span className={styles.cardIdx}>{idx}</span> : null}
        <span className={styles.cardKind}>{KIND_LABEL[c.kind]}</span>
        <span className={styles.sevBadge}>{SEV_LABEL[c.severity]}</span>
        <span className={c.origin === 'user' ? styles.originUser : styles.originAgent}>
          {c.origin === 'user' ? 'Người dùng' : 'Agent'}
        </span>
        {c.status === 'dismissed' ? <span className={styles.badgeDeleted}>Đã bỏ</span> : c.status === 'edited' ? <span className={styles.badgeEdited}>Đã sửa tay</span> : null}
      </div>
      {/* Dòng 1 (tiếp): tiêu đề = reason cắt 60 ký tự; title = reason đầy đủ để
          rê chuột đọc được ngay cả khi chưa mở "Chi tiết". */}
      <p className={styles.cardTitle ?? ''} title={c.reason}>{cardTitle(c)}</p>
      {/* Dòng 2: diff rút gọn MỘT dòng — sửa "cũ → mới", thêm "+ mới", xoá
          "− cũ" (mỗi vế ≤ 40 ký tự, xem diffPreviewSide).
          `diffPreviewBefore`/`diffPreviewAfter` — KHÔNG dùng lại
          `diffBefore`/`diffAfter`: đó là hai class của layout-hai-khối-cũ bên
          trong "Chi tiết" (EditDiff rơi về khi cặp quá lớn), và test cũ
          (doc-redline-preview.ops.test.tsx) dùng chính sự CÓ MẶT của chúng để
          khẳng định "đã/chưa rơi về layout cũ". Dòng rút gọn này LUÔN hiện
          (không phụ thuộc cặp lớn hay nhỏ), nên phải là class khác để không
          làm sai lệch phép đo đó. */}
      <p className={styles.diffCompact ?? styles.diff}>
        {op === 'edit' ? (
          <>
            <span className={styles.diffPreviewBefore ?? ''}>{beforePreview}</span>
            <span aria-hidden="true"> → </span>
            <span className={styles.diffPreviewAfter ?? ''}>{afterPreview}</span>
          </>
        ) : op === 'add' ? (
          <span className={styles.diffPreviewAfter ?? ''}>+ {afterPreview}</span>
        ) : (
          <span className={styles.diffPreviewBefore ?? ''}>− {beforePreview}</span>
        )}
      </p>
      {/* Dòng 3: sửa tay thay thế hẳn hàng hành động khi đang mở (giữ nguyên
          hành vi/aria-label cũ) — RuleChip + "Chi tiết ▾" nằm ở hàng dưới,
          KHÔNG phụ thuộc `showActions`: một chỗ sửa không neo được vẫn phải
          xem được lý do đầy đủ của nó (xem `isAnchored`/"không neo được"). */}
      {showActions && editing ? (
        <div className={styles.editBox}>
          <textarea value={editText} onChange={(ev) => onEditText(ev.target.value)} aria-label="Nội dung sửa" />
          <div className={styles.actions}>
            <button type="button" disabled={busy} onClick={(ev) => { ev.stopPropagation(); onSaveEdit(); }}>Lưu</button>
            <button type="button" disabled={busy} onClick={(ev) => { ev.stopPropagation(); onCancelEdit(); }}>Hủy</button>
          </div>
        </div>
      ) : null}
      <div className={styles.actions}>
        {showActions && !editing ? (
          <>
            <button type="button" disabled={busy || c.status === 'dismissed'} onClick={(ev) => { ev.stopPropagation(); onEdit(); }}>Sửa</button>
            <button type="button" disabled={busy || (c.status !== 'dismissed' && c.before != null && c.quote == null && !c.anchor)} title={c.status !== 'dismissed' && c.before != null && c.quote == null && !c.anchor ? 'Không có anchor duy nhất để chèn lại' : undefined} onClick={(ev) => { ev.stopPropagation(); onDismiss(); }}>{c.status === 'dismissed' && undoable ? 'Hoàn tác' : 'Bỏ chỗ sửa'}</button>
            {c.status === 'dismissed' ? <span className={styles.badgeDeleted}>Đã bỏ</span> : null}
          </>
        ) : null}
        {c.rule_id ? <RuleChip ruleId={c.rule_id} open={ruleOpen} body={ruleBody} onToggle={onToggleRule} /> : null}
        <button type="button" aria-expanded={expanded} onClick={(ev) => { ev.stopPropagation(); onToggleExpand(); }}>
          {expanded ? 'Chi tiết ▴' : 'Chi tiết ▾'}
        </button>
      </div>
      {expanded ? (
        <div className={styles.cardDetail ?? ''}>
          <p className={styles.reason}>{c.reason}</p>
          <RefRow refs={c.doc_refs ?? []} isRefAnchored={isRefAnchored} onJumpRef={onJumpRef} />
          {op === 'edit' && c.before && c.quote ? (
            <EditDiff before={c.before} after={c.quote} />
          ) : op === 'add' && c.quote ? (
            <p className={styles.diff}>
              <span className={styles.blockAdd}>{c.quote}</span>
              <span className={styles.badgeAdded}>Đã thêm</span>
            </p>
          ) : c.before ? (
            <p className={styles.diff}>
              <span className={styles.blockDel}>{c.before}</span>
              <span className={styles.badgeDeleted}>Đã xoá</span>
            </p>
          ) : null}
        </div>
      ) : null}
      {showActions && (error ? <p className={styles.error}>{error}</p> : null)}
    </div>
  );
}

/** Thẻ 3-dòng của change `flow-diagram`: dòng 1 nhóm/mức/tiêu đề cố định,
 *  dòng 2 diff rút gọn (caption Gốc → caption Đề xuất), dòng 3 hành động +
 *  "Chi tiết ▾". `rule_id`/kind kỹ thuật/id/lý do đầy đủ/before-quote đầy đủ
 *  chỉ hiện khi mở Chi tiết. */
function FlowDiagramCardBody({
  change: c,
  idx,
  isRefAnchored,
  onJumpRef,
  busy,
  error,
  showActions,
  undoable,
  onDismiss,
  expanded,
  onToggleExpand,
  accepted,
  onAccept,
}: {
  change: DocRedlineChange;
  idx?: string;
  showActions: boolean;
  undoable?: boolean;
  onDismiss: () => void;
} & Pick<RefProps, 'isRefAnchored' | 'onJumpRef' | 'busy' | 'error'> & CompactCardProps) {
  // (b, review WP3b): caption RIÊNG cho sơ đồ, KHÔNG dùng lại `diffPreviewSide`
  // — text `null` (không trích được caption) rơi về chuỗi cố định thay vì in
  // mã mermaid thô; `diffPreviewBefore`/`diffPreviewAfter` (không phải
  // `diffBefore`/`diffAfter` — hai class đó thuộc layout-hai-khối-cũ của
  // EditDiff/nhánh mặc định `ChangeDetail`, dùng lại ở đây là một chỗ trộn
  // nghĩa class đã lọt qua review).
  const beforeCaption = diagramCaption(c.before);
  const afterCaption = diagramCaption(c.quote);
  return (
    <div className={`${styles.card} ${styles.cardCompact ?? ''} ${SEV_CLASS[c.severity]} ${c.status === 'dismissed' ? styles.dismissed : ''}`}>
      <div className={styles.cardHead}>
        {idx ? <span className={styles.cardIdx}>{idx}</span> : null}
        <span className={styles.cardKind}>{KIND_LABEL[c.kind]}</span>
        <span className={styles.sevBadge}>{SEV_LABEL[c.severity]}</span>
        {accepted ? <span className={styles.badgeAccepted ?? ''}>Đã chấp nhận</span> : null}
        {c.status === 'dismissed' ? <span className={styles.badgeDeleted}>Đã bỏ</span> : null}
      </div>
      <p className={styles.cardTitle ?? ''}>{cardTitle(c)}</p>
      <p className={styles.diffCompact ?? styles.diff}>
        {afterCaption == null ? (
          'Sơ đồ đề xuất thay sơ đồ gốc'
        ) : (
          <>
            {beforeCaption ? <span className={styles.diffPreviewBefore ?? ''}>{beforeCaption}</span> : null}
            {beforeCaption ? <span aria-hidden="true"> → </span> : null}
            <span className={styles.diffPreviewAfter ?? ''}>{afterCaption}</span>
          </>
        )}
      </p>
      <div className={styles.actions}>
        {showActions ? (
          <>
            <button type="button" disabled={busy || accepted || c.status === 'dismissed'} onClick={(ev) => { ev.stopPropagation(); onAccept(); }}>
              {accepted ? 'Đã chấp nhận' : 'Chấp nhận'}
            </button>
            <button type="button" disabled={busy} onClick={(ev) => { ev.stopPropagation(); onDismiss(); }}>
              {c.status === 'dismissed' && undoable ? 'Hoàn tác' : 'Giữ sơ đồ gốc'}
            </button>
          </>
        ) : null}
        {/* (a, review WP3b): nút "Chi tiết ▾" ra NGOÀI gate `showActions` —
            một sơ đồ không neo được (quote không khớp fence nào trong tài
            liệu) trước đây MẤT LUÔN nút này, không có cách nào mở ra xem
            reason/rule_id. Cùng khuôn với nhánh mặc định của `ChangeDetail`
            (RuleChip + Chi tiết luôn hiện, chỉ Sửa/Bỏ mới theo showActions). */}
        <button type="button" aria-expanded={expanded} onClick={(ev) => { ev.stopPropagation(); onToggleExpand(); }}>
          {expanded ? 'Chi tiết ▴' : 'Chi tiết ▾'}
        </button>
      </div>
      {expanded ? (
        <div className={styles.cardDetail ?? ''}>
          <p className={styles.detailRow ?? ''}>
            <span className={styles.detailLabel ?? ''}>Đường dẫn</span> {c.rule_id ?? '—'}
          </p>
          <p className={styles.reason}>{c.reason}</p>
          <RefRow refs={c.doc_refs ?? []} isRefAnchored={isRefAnchored} onJumpRef={onJumpRef} />
          <p className={styles.detailRow ?? ''}>
            <span className={styles.detailLabel ?? ''}>Gốc</span>
          </p>
          <pre className={styles.detailPre ?? ''}>{c.before ?? '—'}</pre>
          <p className={styles.detailRow ?? ''}>
            <span className={styles.detailLabel ?? ''}>Đề xuất</span>
          </p>
          <pre className={styles.detailPre ?? ''}>{c.quote ?? '—'}</pre>
        </div>
      ) : null}
      {showActions && (error ? <p className={styles.error}>{error}</p> : null)}
    </div>
  );
}

/** Thẻ 3-dòng của một "Bảng thành phần" (change `component` không `before`,
 *  `rule_id` bắt đầu `comp/`): dòng 2 LÀ chính đếm N/M/K, không phải diff chữ
 *  — bảng không có "chữ cũ" để so. */
function ComponentTableCardBody({
  change: c,
  idx,
  isRefAnchored,
  onJumpRef,
  busy,
  error,
  showActions,
  undoable,
  onDismiss,
  expanded,
  onToggleExpand,
  accepted,
  onAccept,
  onSaveTable,
}: {
  change: DocRedlineChange;
  idx?: string;
  showActions: boolean;
  undoable?: boolean;
  onDismiss: () => void;
  /** wp4.yaml mục 1: "Sửa bảng" — chỗ gọi (DocRedlinePreview) đóng gói sẵn
   *  change này, hàm chỉ cần đưa `quote` MỚI đã dựng lại. Trả `true`/`false`
   *  (vá N2 review attempt2) để form biết có đóng được không. */
  onSaveTable: (newQuote: string) => Promise<boolean>;
} & Pick<RefProps, 'isRefAnchored' | 'onJumpRef' | 'busy' | 'error'> & CompactCardProps) {
  const counts = componentTableCounts(c.quote);
  // wp4.yaml mục 1: form theo hàng, tách khỏi "Chi tiết" — sửa được NGAY trên
  // thẻ, không đòi bôi đen một ô ngắn (vấp luật "đoạn phải duy nhất", xem
  // intent). Giữ state cục bộ trong thẻ này (không đẩy lên component cha):
  // đây là một khung soạn thảo tạm, chỉ thẻ này cần biết nó đang mở hay đóng.
  const [tableEditOpen, setTableEditOpen] = useState(false);
  const [draftRows, setDraftRows] = useState<string[][] | null>(null);
  // N4 (non-blocking, review attempt2): header của bảng ĐANG sửa, giữ lại
  // cùng lúc mở form — tra chỉ số cột "Vai trò / dùng để"/"Ghi chú" theo NHÃN
  // thay vì hard-code 4/7 (xem `tableColumnIndex`).
  const [draftHeader, setDraftHeader] = useState<string | null>(null);
  function openTableEdit() {
    const parsed = parseComponentTableQuote(c.quote ?? '');
    if (!parsed) return; // dữ liệu không đúng khuôn bảng — không có gì để sửa theo hàng
    setDraftRows(parsed.rows.map((row) => [...row]));
    setDraftHeader(parsed.header);
    setTableEditOpen(true);
  }
  function closeTableEdit() {
    setTableEditOpen(false);
    setDraftRows(null);
    setDraftHeader(null);
  }
  function setCell(rowIndex: number, colIndex: number, value: string) {
    setDraftRows((prev) =>
      prev ? prev.map((row, i) => (i === rowIndex ? row.map((cell, j) => (j === colIndex ? value : cell)) : row)) : prev,
    );
  }
  function removeRow(rowIndex: number) {
    setDraftRows((prev) => (prev ? prev.filter((_, i) => i !== rowIndex) : prev));
  }
  // N2 (phải vá, review attempt2): chỉ đóng form SAU KHI lưu thành công — lưu
  // hỏng (POST lỗi) thì giữ nguyên form + nháp, người dùng không mất chỗ đã
  // gõ. `onSaveTable` (qua `saveComponentTableEdit`/`saveAction`) trả
  // `true`/`false` cho đúng mục đích này.
  async function handleSaveTable() {
    const parsed = parseComponentTableQuote(c.quote ?? '');
    if (!parsed || !draftRows) return;
    const newQuote = buildComponentTableQuote(parsed, draftRows);
    const saved = await onSaveTable(newQuote);
    if (saved) closeTableEdit();
  }
  return (
    <div className={`${styles.card} ${styles.cardCompact ?? ''} ${SEV_CLASS[c.severity]} ${c.status === 'dismissed' ? styles.dismissed : ''}`}>
      <div className={styles.cardHead}>
        {idx ? <span className={styles.cardIdx}>{idx}</span> : null}
        {/* Nhãn CỐ ĐỊNH "Bảng thành phần", không phải KIND_LABEL.component
            ("Component") — đây là điểm phân biệt với change component "sửa
            chữ nói về component" thường (có `before`). */}
        <span className={styles.cardKind}>Bảng thành phần</span>
        <span className={styles.sevBadge}>{SEV_LABEL[c.severity]}</span>
        {accepted ? <span className={styles.badgeAccepted ?? ''}>Đã chấp nhận</span> : null}
        {c.status === 'dismissed' ? <span className={styles.badgeDeleted}>Đã bỏ</span> : null}
      </div>
      <p className={styles.cardTitle ?? ''}>{cardTitle(c)}</p>
      <p className={styles.diffCompact ?? styles.diff}>
        {counts.total} thành phần · {counts.mapped} map DS · {counts.noDs} DS không có
      </p>
      <div className={styles.actions}>
        {showActions ? (
          <>
            <button type="button" disabled={busy || accepted || c.status === 'dismissed'} onClick={(ev) => { ev.stopPropagation(); onAccept(); }}>
              {accepted ? 'Đã chấp nhận' : 'Chấp nhận'}
            </button>
            <button type="button" disabled={busy} onClick={(ev) => { ev.stopPropagation(); onDismiss(); }}>
              {c.status === 'dismissed' && undoable ? 'Hoàn tác' : 'Gỡ bảng'}
            </button>
            <button type="button" disabled={busy || c.status === 'dismissed'} onClick={(ev) => { ev.stopPropagation(); openTableEdit(); }}>
              Sửa bảng
            </button>
          </>
        ) : null}
        {/* (a, review WP3b): nút "Chi tiết ▾" ra NGOÀI gate `showActions`,
            cùng lý do như FlowDiagramCardBody ngay trên. */}
        <button type="button" aria-expanded={expanded} onClick={(ev) => { ev.stopPropagation(); onToggleExpand(); }}>
          {expanded ? 'Chi tiết ▴' : 'Chi tiết ▾'}
        </button>
      </div>
      {tableEditOpen && draftRows ? (
        <div className={styles.tableEditForm ?? ''} role="group" aria-label="Sửa bảng thành phần">
          {(() => {
            // N4 (non-blocking, review attempt2): tra cột theo nhãn header
            // thật của bảng đang sửa, không hard-code 4/7 — fallback 4/7 khi
            // header không khớp (dữ liệu không đúng khuôn).
            const roleCol = tableColumnIndex(draftHeader, 'Vai trò / dùng để', 4);
            const noteCol = tableColumnIndex(draftHeader, 'Ghi chú', 7);
            return draftRows.map((row, i) => {
              const rowLabel = row[1] || `hàng ${i + 1}`;
              return (
                <div key={i} className={styles.tableEditRow ?? ''} data-table-edit-row={i}>
                  <span className={styles.tableEditCellLabel ?? ''}>{rowLabel}</span>
                  <input
                    aria-label={`Vai trò / dùng để — ${rowLabel}`}
                    value={row[roleCol] ?? ''}
                    onChange={(ev) => setCell(i, roleCol, ev.target.value)}
                  />
                  <input
                    aria-label={`Ghi chú — ${rowLabel}`}
                    value={row[noteCol] ?? ''}
                    onChange={(ev) => setCell(i, noteCol, ev.target.value)}
                  />
                  <button type="button" onClick={(ev) => { ev.stopPropagation(); removeRow(i); }}>Gỡ hàng</button>
                </div>
              );
            });
          })()}
          <div className={styles.actions}>
            {/* N6 (non-blocking, review attempt2): gỡ hết hàng → chặn Lưu —
                lưu một bảng rỗng không có ý nghĩa, và không có gì để dựng lại
                `buildComponentTableQuote`. */}
            <button type="button" disabled={busy || draftRows.length === 0} onClick={(ev) => { ev.stopPropagation(); void handleSaveTable(); }}>
              {busy ? 'Đang lưu...' : 'Lưu'}
            </button>
            <button type="button" disabled={busy} onClick={(ev) => { ev.stopPropagation(); closeTableEdit(); }}>Hủy</button>
          </div>
          {/* N2 (phải vá, review attempt2): lỗi lưu hiện NGAY TRONG form, không
              phụ thuộc `showActions` — mất `showActions` không được kéo theo
              mất luôn thông báo lỗi khi nháp vẫn còn mở. */}
          {error ? <p className={styles.error}>{error}</p> : null}
        </div>
      ) : null}
      {expanded ? (
        <div className={styles.cardDetail ?? ''}>
          <p className={styles.detailRow ?? ''}>
            <span className={styles.detailLabel ?? ''}>Đường dẫn</span> {c.rule_id ?? '—'}
          </p>
          <p className={styles.reason}>{c.reason}</p>
          <RefRow refs={c.doc_refs ?? []} isRefAnchored={isRefAnchored} onJumpRef={onJumpRef} />
          {/* Bảng đầy đủ, dựng lại bằng renderer markdown sẵn có của cột tài
              liệu (an toàn theo hợp đồng của renderMarkdownToSafeHtml — xem
              cột tài liệu ở trên). */}
          <div className="markdown-rendered" dangerouslySetInnerHTML={{ __html: renderMarkdownToSafeHtml(c.quote ?? '') }} />
        </div>
      ) : null}
      {/* Form đang mở đã tự hiện lỗi ngay bên trong nó (N2 ở trên) — tránh lặp
          lại cùng một thông báo hai lần trên một thẻ. */}
      {!tableEditOpen && showActions && (error ? <p className={styles.error}>{error}</p> : null)}
    </div>
  );
}

/** Chữ cũ → chữ mới của một chỗ VIẾT LẠI, dưới dạng MỘT đoạn liền: chỉ chữ bị
 *  bỏ và chữ mới được tô, phần không đổi để nguyên. Hai khối nguyên văn (cách
 *  cũ) buộc người đọc tự so từng từ khi câu dài mà chỉ đổi vài từ.
 *
 *  `wordDiff` trả null với cặp đoạn quá lớn (bảng DP vượt trần) — khi đó rơi về
 *  đúng layout hai khối cũ, vì thà xấu còn hơn không hiện được chữ nào. */
function EditDiff({ before, after }: { before: string; after: string }) {
  const runs = useMemo(() => wordDiff(before, after), [before, after]);
  if (!runs) {
    return (
      <p className={styles.diff}>
        <span className={styles.diffBefore}>{before}</span>
        <span aria-hidden="true">→</span>
        <span className={styles.diffAfter}>{after}</span>
      </p>
    );
  }
  const RUN_CLASS = { same: styles.runSame ?? '', del: styles.runDel ?? '', add: styles.runAdd ?? '' };
  return (
    <p className={styles.diffInline}>
      {runs.map((run, i) => (
        // Nối bằng khoảng trắng GIỮA các run: `text` của một run chỉ chứa
        // khoảng trắng nội bộ, nên không có nó thì hai run dính liền thành một
        // từ sai. `key` theo chỉ số là đúng ở đây — danh sách này chỉ được dựng
        // lại toàn bộ, không bao giờ chèn/xoá phần tử giữa.
        <span key={i}>
          {i > 0 ? ' ' : null}
          <span className={RUN_CLASS[run.op]}>{run.text}</span>
        </span>
      ))}
    </p>
  );
}
