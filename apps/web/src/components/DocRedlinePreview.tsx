// DocRedlinePreview — docs-review's redline view for a page the `dr-review`
// stage edited (`docs-review/review/docs/**/*.md`).
//
// wp-doc-redline-nondestructive: tài liệu hiển thị ở đây là bản GỐC ĐÃ-ENRICH
// (bảng "Cấu thành màn hình" + sơ đồ vẫn nhúng inline — daemon dựng thẳng vào
// `file.name`), KHÔNG còn có chữ sửa nướng sẵn của agent hay của người dùng.
// Mọi Thêm/Sửa/Xóa (agent lẫn người dùng) chỉ là HIGHLIGHT MÀU neo trên chữ
// GỐC còn nguyên trong tài liệu:
//   - Sửa/Xóa neo theo `before` (đoạn gốc bị đề xuất đổi/bỏ, còn nguyên).
//   - Thêm neo theo `anchor` (điểm chèn, cũng là chữ gốc).
//   - `quote` (nội dung MỚI được đề xuất) không còn tồn tại trong tài liệu nên
//     KHÔNG neo được vào đâu — nó chỉ hiện trong panel chi tiết khi bấm vào
//     vùng bôi (xem `changeHighlightSource`/`AnnotationDetailPanel`).
// Bảng/sơ đồ do một bước enrichment tự động sinh (`kind: 'flow-diagram'`, hoặc
// `component` không `before` với `rule_id` bắt đầu `comp/`) là nội dung THẬT
// sự đã nằm trong tài liệu — không thuộc cơ chế đề xuất trên, nên vẫn neo theo
// `quote` (chữ đã render thật) như trước và KHÔNG mở panel khi bấm vào.
//
// Bấm một vùng bôi (hoặc một note) mở PANEL chi tiết dựng cạnh phải cột tài
// liệu, hiện nội dung (Thêm=chữ mới; Sửa=gốc→mới; Xóa=đoạn bị đề xuất bỏ;
// note=phát hiện) kèm lý do. Từng là modal giữa màn (đợt bỏ rail
// wp-doc-redline-nondestructive) nhưng modal che mất tài liệu — quay lại
// right panel để vừa đọc chi tiết vừa thấy vùng bôi trong ngữ cảnh.
//
// `<mark>` được chèn vào CHUỖI HTML đã render, trước khi React nhận (xem
// injectHighlights trong runtime/doc-highlight.ts). Không chèn vào mã nguồn
// markdown vì renderMarkdownToSafeHtml cố ý escape HTML thô — viết thẻ vào đó
// chỉ hiện ra thành chữ. Cũng KHÔNG mổ DOM sau khi render như bản trước: cách
// đó phụ thuộc ref đã gắn chưa và React có dựng lại nút hay không, cả hai đều
// đã thực sự làm vùng bôi biến mất.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
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
import { injectHighlights, quoteSegments, type HighlightBlockTarget } from '../runtime/doc-highlight';
import { wordDiff } from '../runtime/word-diff';
import { Icon } from './Icon';
import { MermaidDiagram } from './MermaidDiagram';
import { DrawioViewer } from './DrawioViewer';
import { DocRedlineModeControls } from './DocRedlineModeControls';
import { DocRedlineNavigation } from './DocRedlineNavigation';
import { createRedlineDocumentIndex } from './redline-document';
import { modeLabel, type PreviewMode } from './redline-mode';
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
  /** Nguyên văn đoạn trong bản GỐC bị đề xuất thay hoặc bị đề xuất bỏ — với
   *  phép Sửa/Xóa, đây LÀ nguồn neo vùng bôi (chữ còn nguyên trong tài liệu,
   *  xem `changeHighlightSource`), không phải chỉ hiện trong modal. */
  before?: string;
  /** Nguyên văn đoạn NỘI DUNG MỚI được đề xuất. KHÔNG tồn tại trong tài liệu
   *  (daemon không còn nướng nó vào `.md`), nên KHÔNG neo được vùng bôi nào —
   *  chỉ hiện trong modal chi tiết khi bấm vào vùng bôi của chỗ sửa/thêm đó.
   *  NGOẠI LỆ: change enrichment (`kind: 'flow-diagram'`, hoặc `component`
   *  không `before` với `rule_id` bắt đầu `comp/`) là nội dung THẬT đã nằm
   *  trong tài liệu — với hai loại đó, `quote` vẫn là nguồn neo như cũ. */
  quote?: string;
  /** Với phép Thêm: nguyên văn đoạn GỐC làm MỐC chèn (điểm sẽ chèn `quote`
   *  vào ngay sau) — đây LÀ nguồn neo vùng bôi của phép Thêm (chữ còn nguyên
   *  trong tài liệu, xem `changeHighlightSource`). */
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
  /** Nguyên văn một đoạn trong bản GỐC để neo nhận xét vào đúng chỗ. Khi note
   *  mang `tableCells`, đây là MỘT dòng mã nguồn duy nhất nằm trong bảng — chỉ
   *  dùng để ĐỊNH VỊ lại `<table>` khi render/reload, không phải chữ hiển thị. */
  anchor: string;
  /** wp-table-highlight.yaml: các ô CỤ THỂ trong bảng mà `anchor` định vị —
   *  người dùng kéo bôi ô trong bảng thay vì bôi một đoạn chữ liền mạch. `row`
   *  là chỉ số `<tr>` (kể cả các hàng trong `<thead>`) theo thứ tự DOM trong
   *  `<table>`; `col` là chỉ số ô trong hàng đó. Có field này thì note được
   *  tô bằng effect riêng (`useTableCellTint`), KHÔNG qua notePass injectHighlights
   *  (không cần `<mark>` chữ vì đã định vị bằng toạ độ ô). */
  tableCells?: { cells: Array<{ row: number; col: number }> };
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
}

/** wp-table-highlight.yaml (Q2): nháp của một note "tô ô bảng" — ĐƯỜNG MỚI,
 *  song song với `DraftAnnotation` chứ không dùng chung, vì thao tác này
 *  không có "nội dung mới"/không sửa markdown (`changedMd: false`), chỉ neo
 *  toạ độ ô + một lý do. `cells`/`anchor` đã chốt xong lúc mở composer
 *  (`startTableCellHighlight`); người dùng chỉ còn gõ `reason`. */
interface TableCellDraft {
  cells: Array<{ row: number; col: number }>;
  anchor: string;
  reason: string;
}

/** wp-text-highlight.yaml: nháp của một note "tô đoạn chọn" — ĐƯỜNG MỚI, song
 *  song với `DraftAnnotation`/`TableCellDraft` chứ không dùng chung. Khác
 *  `DraftAnnotation`: không sửa markdown (`changedMd: false`), không đòi đoạn
 *  khớp DUY NHẤT trong mã nguồn (neo khớp mờ như note thường). Khác
 *  `TableCellDraft`: neo bằng CHỮ (`selected`), không phải toạ độ ô.
 *  `sectionHeading` (best-effort) thu hẹp phạm vi neo về đúng section khi tìm
 *  được heading gần nhất đứng trước vùng chọn — xem `startTextHighlight`. */
interface TextHighlightDraft {
  selected: string;
  reason: string;
  sectionHeading?: string;
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
  if (out !== id) {
    // Từ 0.8.116, daemon tự namespace id theo section trước khi ghi file
    // (xem sectionAnnotationId/namespaceSectionAnnotations trong
    // docs-review.ts) nên trùng id KHÔNG còn xảy ra với file mới. Nhánh này
    // vẫn giữ làm fallback đọc file KẾT QUẢ CŨ (trước 0.8.116) — cảnh báo để
    // người đọc biết mình đang xem một file cũ đã bị đổi id, không phải im
    // lặng đổi rồi thôi.
    console.warn(`[redline] id trùng "${id}" trong file kết quả — file cũ trước 0.8.116, đã tự đổi thành "${out}"`);
  }
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

/** wp-table-highlight.yaml (Q2): kiểm nhẹ `tableCells` khi đọc note — `cells`
 *  phải là mảng KHÔNG RỖNG toàn {row,col} số nguyên ≥0; sai hình dạng ở BẤT KỲ
 *  phần tử nào (thiếu, không phải số, âm, lẻ) thì bỏ CẢ field (note vẫn giữ),
 *  không lọc riêng từng phần tử — dữ liệu toạ độ ô nửa vời còn nguy hiểm hơn là
 *  không có, vì nó tô nhầm ô. */
function parseTableCells(raw: unknown): DocRedlineNote['tableCells'] {
  if (!raw || typeof raw !== 'object') return undefined;
  const cellsRaw = (raw as { cells?: unknown }).cells;
  if (!Array.isArray(cellsRaw) || cellsRaw.length === 0) return undefined;
  const cells: Array<{ row: number; col: number }> = [];
  for (const item of cellsRaw) {
    if (!item || typeof item !== 'object') return undefined;
    const row = (item as Record<string, unknown>).row;
    const col = (item as Record<string, unknown>).col;
    if (typeof row !== 'number' || !Number.isInteger(row) || row < 0) return undefined;
    if (typeof col !== 'number' || !Number.isInteger(col) || col < 0) return undefined;
    cells.push({ row, col });
  }
  return { cells };
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
      tableCells: parseTableCells(n.tableCells),
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
function uniqueOccurrenceIndex(source: string, value: string): number | null {
  const first = source.indexOf(value);
  if (first < 0 || source.indexOf(value, first + value.length) >= 0) return null;
  return first;
}

/** wp-table-highlight.yaml (Q2): chọn dòng mã nguồn dùng làm `anchor` định vị
 *  một bảng — dòng ĐẦU TIÊN trong `candidates` (chỗ gọi truyền vào theo thứ tự
 *  ưu tiên: hàng người dùng đã bôi trước, hàng header sau) xuất hiện DUY NHẤT
 *  một lần trong `source` (cùng chuẩn "duy nhất" như mọi anchor khác trong file
 *  này, xem `uniqueOccurrenceIndex`). Không dòng nào duy nhất → `null` (bảng có
 *  dòng trùng, không định vị được). Tách riêng khỏi việc dựng `candidates` từ
 *  DOM để hàm này test được mà không cần jsdom dựng bảng. */
export function pickUniqueTableAnchorLine(source: string, candidates: readonly string[]): string | null {
  for (const line of candidates) {
    if (line && uniqueOccurrenceIndex(source, line) != null) return line;
  }
  return null;
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

function changeOp(c: Pick<DocRedlineChange, 'before' | 'quote'>): 'add' | 'del' | 'edit' {
  if (c.before && c.quote) return 'edit';
  if (c.quote) return 'add';
  return 'del';
}

/** wp-doc-redline-nondestructive: nguồn CHỮ GỐC để neo vùng bôi của một change
 *  THƯỜNG (không phải enrichment — xem docblock đầu file) theo đúng phép sửa —
 *  `quote` (nội dung mới) không còn tồn tại trong tài liệu nên không bao giờ
 *  được dùng làm nguồn neo nữa:
 *    - 'add'          → `anchor` (điểm chèn, chữ gốc).
 *    - 'edit' / 'del' → `before` (đoạn gốc, chữ gốc).
 *  Trả `null` khi phép sửa tương ứng không có chữ để neo (trắng/rỗng) — chỗ
 *  gọi bỏ qua, không tạo mark. Tách thành hàm thuần để test không cần dựng
 *  DOM (xem apps/web/tests/components/doc-redline-preview.nondestructive.test.tsx). */
export function changeHighlightSource(
  c: Pick<DocRedlineChange, 'before' | 'quote' | 'anchor'>,
): { op: 'add' | 'edit' | 'del'; text: string } | null {
  const op = changeOp(c);
  const raw = (op === 'add' ? c.anchor : c.before)?.trim();
  return raw ? { op, text: raw } : null;
}

/** Một "Bảng thành phần" là change `kind: 'component'` KHÔNG có `before` (chỉ
 *  thêm mới) mà `rule_id` bắt đầu bằng `comp/` — phân biệt với change
 *  `component` "thường" (một chỗ sửa chữ nói về component, có `before`). */
function isComponentTableChange(c: Pick<DocRedlineChange, 'kind' | 'before' | 'rule_id'>): boolean {
  return c.kind === 'component' && !c.before && !!c.rule_id?.startsWith('comp/');
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

type MermaidDocumentPart =
  | { kind: 'html'; html: string }
  | { kind: 'mermaid'; code: string; changeId: string | null };

function decodeEscapedHtmlText(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Tách fence Mermaid khỏi HTML an toàn để React render nó như component thật.
 *  Đây là đường render chính, không còn chèn host sau commit bằng effect/portal:
 *  nếu React đã hiện được HTML tài liệu thì Mermaid cũng chắc chắn có node.
 *  Các đoạn HTML còn lại vẫn là output đã sanitize của markdown renderer. */
function splitMermaidDocumentHtml(html: string, owners: DocRedlineChange[]): MermaidDocumentPart[] {
  const fenceRe = /<pre><code class="language-mermaid">([\s\S]*?)<\/code><\/pre>/gi;
  const headingRe = /<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/gi;
  const parts: MermaidDocumentPart[] = [];
  const headings: string[] = [];
  const consumedOwners = new Set<string>();
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = fenceRe.exec(html)) !== null) {
    const before = html.slice(cursor, match.index);
    if (before) parts.push({ kind: 'html', html: before });
    headingRe.lastIndex = 0;
    let headingMatch: RegExpExecArray | null;
    while ((headingMatch = headingRe.exec(before)) !== null) {
      headings.push(decodeEscapedHtmlText((headingMatch[1] ?? '').replace(/<[^>]+>/g, '')).trim());
    }

    const code = decodeEscapedHtmlText(match[1] ?? '');
    const ordinal = headings.length - 1;
    const candidates = owners.filter(
      (owner) => !consumedOwners.has(owner.id) && extractMermaidFenceBody(owner.quote)?.trim() === code.trim(),
    );
    const owner = candidates.find((candidate) => {
      const start = candidate.sectionStartHeadingOrdinal;
      const end = candidate.sectionEndHeadingOrdinalExclusive;
      if (start != null || end != null) return (start == null || ordinal >= start) && (end == null || ordinal < end);
      if (candidate.sectionHeading == null) return true;
      const expected = candidate.sectionHeading.trim().replace(/^#{1,6}\s*/, '');
      return (headings[ordinal] ?? '').localeCompare(expected, 'vi', { sensitivity: 'base' }) === 0;
    });
    if (owner) consumedOwners.add(owner.id);
    parts.push({ kind: 'mermaid', code, changeId: owner?.id ?? null });
    cursor = match.index + match[0].length;
  }
  const tail = html.slice(cursor);
  if (tail || parts.length === 0) parts.push({ kind: 'html', html: tail });
  return parts;
}

/** Đợi cột tài liệu gắn đủ host Mermaid và SVG trước khi chụp DOM để in.
 *  `window.print()` chụp đồng bộ tại thời điểm gọi; nếu dynamic import Mermaid
 *  chưa xong thì PDF sẽ giữ code thô hoặc khung rỗng. Timeout là fail-soft:
 *  bản in vẫn mở và giữ thông báo Mermaid error nếu renderer thật sự lỗi. */
async function waitForPrintableMermaid(article: HTMLElement, hostClass: string, timeoutMs = 3000): Promise<void> {
  const ready = () => {
    const fenceCount = article.querySelectorAll('pre > code.language-mermaid').length;
    const hosts = hostClass ? Array.from(article.getElementsByClassName(hostClass)) : [];
    return hosts.length >= fenceCount && hosts.every((host) => host.querySelector('svg') || host.textContent?.includes('Mermaid error'));
  };
  if (ready()) return;
  const startedAt = Date.now();
  await new Promise<void>((resolve) => {
    const check = () => {
      if (ready() || Date.now() - startedAt >= timeoutMs) {
        resolve();
        return;
      }
      window.setTimeout(check, 40);
    };
    check();
  });
}

/**
 * Mount sanitized document HTML without assigning `innerHTML` to a live
 * element in the React tree. Chromium can retain a stale caret anchor on a
 * React-managed `dangerouslySetInnerHTML` host after the redline re-renders;
 * dragging from the middle then selects from the beginning of the document.
 * Parsing through a detached template keeps the live wrapper's selection
 * state clean while preserving the same sanitized DOM.
 */
export function SelectionSafeHtmlChunk({ html, className }: { html: string; className: string }) {
  const hostRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const template = document.createElement('template');
    template.innerHTML = html;
    host.replaceChildren(template.content);
    return () => host.replaceChildren();
  }, [html]);

  return <div ref={hostRef} className={className} />;
}

/** Chụp article ĐÃ render để sheet in có SVG/Draw.io thật thay vì `docHtml`
 *  thô. Pan/zoom dùng wrapper absolute + transform theo viewport màn hình, nên
 *  bản clone chỉ giữ visual cuối (SVG/ảnh canvas), chuẩn hoá nó về width:100%,
 *  và bỏ toàn bộ control/source tương tác không có ý nghĩa trên giấy. */
function printableArticleHtml(
  source: HTMLElement,
  classes: { mermaidFrame: string; drawioFrame: string },
): string {
  const clone = source.cloneNode(true) as HTMLElement;

  const sourceCanvases = Array.from(source.querySelectorAll('canvas'));
  const clonedCanvases = Array.from(clone.querySelectorAll('canvas'));
  sourceCanvases.forEach((canvas, index) => {
    const clonedCanvas = clonedCanvases[index];
    if (!clonedCanvas) return;
    try {
      const image = document.createElement('img');
      image.src = canvas.toDataURL('image/png');
      image.alt = 'Sơ đồ';
      image.style.width = '100%';
      image.style.height = 'auto';
      clonedCanvas.replaceWith(image);
    } catch {
      // Canvas có resource cross-origin có thể bị taint; giữ node clone để bản
      // in không mất hẳn vị trí sơ đồ, còn SVG là đường chính của hai viewer.
    }
  });

  clone.querySelectorAll('details.md-mermaid__source, button').forEach((node) => node.remove());
  for (const frameClass of [classes.mermaidFrame, classes.drawioFrame].filter(Boolean)) {
    for (const frame of Array.from(clone.getElementsByClassName(frameClass))) {
      const visual = frame.querySelector<SVGElement | HTMLImageElement>('svg, img');
      if (!visual) continue;
      const printableVisual = visual.cloneNode(true) as SVGElement | HTMLImageElement;
      printableVisual.style.transform = 'none';
      printableVisual.style.width = '100%';
      printableVisual.style.height = 'auto';
      printableVisual.style.maxWidth = '100%';
      frame.replaceChildren(printableVisual);
    }
  }
  clone.removeAttribute('id');
  clone.removeAttribute('role');
  clone.removeAttribute('aria-labelledby');
  return clone.innerHTML;
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
/** Chỗ XOÁ bôi đỏ nhạt TẠI CHỖ trên chữ gốc (nó còn nguyên trong tài liệu —
 *  wp-doc-redline-nondestructive: không còn injectDeletedRuns chèn lại chữ
 *  cũ). Gạch ngang đặt thẳng trong style nội tuyến (không còn nhờ `<del>` lồng
 *  bên trong, vì mark bọc thẳng chữ gốc chứ không sinh node mới). */
const HL_DEL_INLINE_STYLE = 'background-color:rgba(239,68,68,.18);outline:1px solid rgba(239,68,68,.7);border-radius:3px;cursor:pointer;text-decoration:line-through';
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
/** Chỗ xoá khi tắt tô màu: bỏ nền đỏ nhưng GIỮ gạch ngang (nội tuyến, xem
 *  HL_DEL_INLINE_STYLE ở trên), vì gạch ngang là thứ duy nhất phân biệt chữ đã
 *  bị bỏ với chữ đang có thật. */
const HL_DEL_OFF_INLINE_STYLE = 'cursor:pointer;opacity:.65;text-decoration:line-through';
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

/** Kết quả tra cứu một id mark (`data-change-id`) về đúng change/note nó
 *  thuộc về, để mở panel chi tiết (xem `AnnotationDetailPanel`). */
export type AnnotationDetailTarget =
  | { kind: 'change'; change: DocRedlineChange }
  | { kind: 'note'; note: DocRedlineNote };

/** wp-doc-redline-nondestructive: tra id mark → change/note tương ứng, THUẦN
 *  (nhận `changes`/`notes` làm tham số thay vì đọc state, để test được không
 *  cần dựng React) — id tiền tố `ref:` (vùng viện dẫn) trả `null`: nó không
 *  có panel riêng, click vào nó mở LẠI `refModal` sẵn có (xem
 *  `openAnnotationDetail` trong component). */
export function resolveAnnotationDetail(
  id: string,
  changes: readonly DocRedlineChange[],
  notes: readonly DocRedlineNote[],
): AnnotationDetailTarget | null {
  if (id.startsWith(REF_ID_PREFIX)) return null;
  if (id.startsWith(NOTE_ID_PREFIX)) {
    const note = notes.find((n) => n.id === id.slice(NOTE_ID_PREFIX.length));
    return note ? { kind: 'note', note } : null;
  }
  const change = changes.find((c) => c.id === id);
  return change ? { kind: 'change', change } : null;
}

/** Một quote nhiều dòng mang ý nghĩa vùng, không chỉ một token. Table row và
 * list item được nhận diện từ block HTML; helper này bổ sung paragraph/heading
 * nhiều dòng để mọi block mà quote đi qua đều được tint. */
function annotationWantsFullBlock(annotation: Pick<DocRedlineChange, 'before' | 'quote' | 'anchor'>): boolean {
  // Ưu tiên đúng thứ tự nguồn chữ THẬT SỰ được bôi (xem changeHighlightSource):
  // sửa/xoá → `before`; thêm → `anchor`; bảng thành phần (không before/anchor)
  // → `quote` (đường cũ, không đổi).
  const raw = annotation.before?.trim() || annotation.anchor?.trim() || annotation.quote?.trim() || '';
  return raw.split(/\r?\n/).filter((line) => line.trim()).length > 1;
}

/** Mỗi dòng table chỉ cần một neo đủ đặc trưng để tìm đúng `<tr>`; tô cả row
 *  do block descriptor lo. Bôi mọi cell riêng lẻ vừa thừa vừa có thể kéo sang
 *  row khác khi một cell chung chung ("Có", "Không", "Input") bị lặp. Ngoài
 *  table vẫn giữ mọi segment để quote nhiều dòng bôi đủ từng block. */
function annotationHighlightSegments(raw: string): string[] {
  return raw.split(/\r?\n/).flatMap((line) => {
    const segments = quoteSegments(line);
    if (!line.includes('|') || segments.length <= 1) return segments;
    return [segments.reduce((best, segment) => segment.length > best.length ? segment : best)];
  });
}

/** wp-table-highlight.yaml (Q2): chuẩn hoá khoảng trắng của một chuỗi
 *  (`textContent` đã render gộp nhiều khoảng trắng/newline lại) trước khi so
 *  sánh — dùng ở `useTableCellTint`. */
function normalizeTableAnchorText(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

/** wp-table-highlight.yaml (Q2): `note.anchor` của một note tableCells là dòng
 *  NGUYÊN VĂN mã nguồn markdown (`| a | b |`, giữ pipe — cần thế để khớp
 *  `uniqueOccurrenceIndex` trên mã nguồn lúc tạo, xem `startTableCellHighlight`
 *  /`tableRowCandidateLine`). HTML đã render bỏ hết ký tự `|` (bảng markdown
 *  dựng thành `<table>` thật), nên `table.textContent` không bao giờ chứa
 *  pipe — phải bỏ pipe khỏi anchor rồi mới so khớp lúc tìm lại `<table>`. */
function tableAnchorPlainText(anchorLine: string): string {
  const inner = anchorLine.trim().replace(/^\|/, '').replace(/\|$/, '');
  return normalizeTableAnchorText(inner.split('|').map((cell) => cell.trim()).join(' '));
}

/** Cắt đúng phần văn bản của một rule ra khỏi một file `criteria/*.md`.
 *
 *  wp-doc-redline-nondestructive: chip/popover rule_id (RuleChip) từng dùng
 *  hàm này SỐNG trong thẻ rail — rail đã bị bỏ (xem docblock đầu file) nên
 *  UI đó không còn, nhưng hàm cắt đoạn thuần này vẫn giữ export vì có bộ test
 *  riêng khoá đúng quy ước anchor với daemon (xem test đi kèm) và không phụ
 *  thuộc gì vào rail.
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

// ── WP-drreview-drawio-preview mục D — sơ đồ draw.io trong cột tài liệu ─────
// Marker daemon chèn (replaceDrawioInSlice, docs-review-enrich.ts):
// `*flow-diagram-drawio — sơ đồ ĐỀ XUẤT sau rà soát UX (nguồn gốc: …; đề
// xuất: flows/<flowId>/proposed.drawio)*` — renderMarkdownToSafeHtml giữ
// `*…*` thành `<em>`. `flowId` (và do đó `changeId`) parse THẲNG từ text
// marker, không đối chiếu `changes` như mermaid — daemon LUÔN sinh marker
// kèm đúng một system change, không có sơ đồ "mồ côi" ở đây.
const DRAWIO_MARKER_RE = /^flow-diagram-drawio\s*—/;
const DRAWIO_FLOWID_RE = /flows\/([^/]+)\/proposed\.drawio/;

/** Portal vào host `<mark data-change-id>` đã chèn ở effect scan `<em>` (xem
 *  ngay trên): fetch `flows/<flowId>/proposed.drawio` MỘT LẦN, render bằng
 *  `<DrawioViewer>` trong khung cao cố định. Toggle/badge/chú giải TÁI DÙNG
 *  đúng markup + state `diagramView` của mermaid (WP-drreview-mmd-color-badge)
 *  — cùng `changeId` nên "chọn card ↔ highlight" (marksFor) chạy được ngay,
 *  không cần viết lại. daemon KHÔNG render draw.io server-side (xem "Đã tự
 *  chốt" trong wp-drreview-drawio-preview.yaml) nên XML thật CHỈ có ở đây,
 *  khác mermaid (mã nhúng sẵn trong tài liệu). Fetch lỗi (reject hoặc `null`)
 *  → giữ dòng marker chữ, chỉ thêm một dòng báo nhỏ — không crash. */
function DrawioDiagramHost({
  projectId,
  workflowPrefix,
  flowId,
  changeId,
  diagramView,
  setDiagramView,
}: {
  projectId: string;
  workflowPrefix: string;
  flowId: string;
  changeId: string;
  diagramView: Record<string, 'proposed' | 'original'>;
  setDiagramView: Dispatch<SetStateAction<Record<string, 'proposed' | 'original'>>>;
}) {
  const drawioPath = `${workflowPrefix}/flows/${flowId}/proposed.drawio`;
  const [state, setState] = useState<
    { status: 'loading' } | { status: 'ready'; xml: string; pageCount: number } | { status: 'error' }
  >({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    fetchProjectFileText(projectId, drawioPath)
      .then((raw) => {
        if (cancelled) return;
        if (raw == null) {
          setState({ status: 'error' });
          return;
        }
        // 1 trang → luôn 0 (không có gì để so sánh, cả hai nhánh toggle cùng
        // trỏ một trang) — pageCount đếm số thẻ `<diagram` trong XML.
        const pageCount = (raw.match(/<diagram\b/g) ?? []).length || 1;
        setState({ status: 'ready', xml: raw, pageCount });
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, drawioPath]);

  if (state.status === 'loading') return null; // giữ nguyên dòng marker chữ, chưa có gì thêm
  if (state.status === 'error') {
    return <p className={styles.drawioError ?? ''}>Không tải được sơ đồ đề xuất</p>;
  }

  const view = diagramView[changeId] ?? 'proposed';
  const page = view === 'original' ? 0 : Math.max(state.pageCount - 1, 0);

  return (
    <>
      <div className={styles.diagramToggle ?? ''} role="group" aria-label="Xem sơ đồ gốc hay đề xuất">
        {/* Tái dùng nguyên markup badge/chú giải của mermaid
            (WP-drreview-mmd-color-badge) — sơ đồ draw.io được thay cũng luôn
            có màu (patch.ts tô CHANGE_STYLE khi finalizeFlowUx sinh
            proposed.drawio), cùng 3 màu thêm/sửa/bỏ. */}
        <span className={styles.diagramBadge ?? ''}>Sơ đồ đề xuất</span>
        <span className={styles.diagramLegend ?? ''} aria-label="Chú giải màu thay đổi">
          <span className={`${styles.legendDot ?? ''} ${styles.legendDotAdded ?? ''}`} aria-hidden="true" />
          thêm
          <span className={`${styles.legendDot ?? ''} ${styles.legendDotModified ?? ''}`} aria-hidden="true" />
          sửa
          <span className={`${styles.legendDot ?? ''} ${styles.legendDotRemoved ?? ''}`} aria-hidden="true" />
          bỏ
        </span>
        <button
          type="button"
          className={view !== 'original' ? styles.diagramToggleOn ?? '' : undefined}
          onClick={(ev) => {
            ev.stopPropagation();
            setDiagramView((prev) => ({ ...prev, [changeId]: 'proposed' }));
          }}
        >
          ◉ Đề xuất
        </button>
        <button
          type="button"
          className={view === 'original' ? styles.diagramToggleOn ?? '' : undefined}
          onClick={(ev) => {
            ev.stopPropagation();
            setDiagramView((prev) => ({ ...prev, [changeId]: 'original' }));
          }}
        >
          ○ Gốc
        </button>
      </div>
      <div className={styles.drawioFrame ?? ''}>
        <DrawioViewer xml={state.xml} page={page} />
      </div>
    </>
  );
}

export function DocRedlinePreview({
  projectId,
  file,
}: { projectId: string; file: ProjectFile }) {
  // `file.name` có dạng `<stage>/review/docs/…/x.md` (xem popover rule ở
  // dưới) — phần trước `/review/` là thư mục stage, dùng để dựng đường dẫn
  // `flows/<flowId>/proposed.drawio` cho host sơ đồ draw.io (mục D
  // wp-drreview-drawio-preview.yaml).
  const workflowPrefix = file.name.split('/review/')[0] ?? '';
  const [editedText, setEditedText] = useState<string | null>(null);
  const [changesState, setChangesState] = useState<ChangesState>({ status: 'loading' });
  const [notesState, setNotes] = useState<DocRedlineNote[]>(NO_NOTES);
  const [notesRaw, setNotesRaw] = useState<string | null>(null);
  const [changesRaw, setChangesRaw] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errorById, setErrorById] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState<DraftAnnotation | null>(null);
  const [draftError, setDraftError] = useState('');
  // wp-table-highlight.yaml (Q2): nháp/lỗi/trạng-thái-bật-nút của đường "Tô ô
  // bảng" — tách hẳn khỏi `draft`/`draftError` (đường text cũ), đúng
  // `must_not`: không đổi `startUserAnnotation`/`createUserAnnotation`.
  const [tableCellDraft, setTableCellDraft] = useState<TableCellDraft | null>(null);
  const [tableCellError, setTableCellError] = useState('');
  const [selectionInTable, setSelectionInTable] = useState(false);
  const [tableCellAnchoredIds, setTableCellAnchoredIds] = useState<ReadonlySet<string>>(EMPTY_SET);
  // wp-text-highlight.yaml: nháp/lỗi/trạng-thái-bật-nút của đường "Tô đoạn
  // chọn" — tách hẳn khỏi `draft`/`draftError` (Sửa/Xoá/Thêm chữ) VÀ khỏi
  // `tableCellDraft`/`tableCellError` (Tô ô bảng): must_not cấm đụng cả hai.
  // `selectionNonEmpty` cập nhật trong CÙNG effect selectionchange bên dưới
  // vốn tính `selectionInTable` (Q2) — khác điều kiện: không cần trong <table>.
  const [textHighlightDraft, setTextHighlightDraft] = useState<TextHighlightDraft | null>(null);
  const [textHighlightError, setTextHighlightError] = useState('');
  const [selectionNonEmpty, setSelectionNonEmpty] = useState(false);
  // wp4.yaml mục 2: "Thêm sau mục…" — picker liệt kê heading của tài liệu,
  // tách khỏi `draft`/`draftError` vì nó là một bước CHỌN anchor, không phải
  // composer (composer mở SAU khi đã chọn xong, dùng lại y hệt `draft`).
  const [headingPickerOpen, setHeadingPickerOpen] = useState(false);
  const [headingPickerValue, setHeadingPickerValue] = useState('');
  // Session-only: các id đã "Bỏ" mà còn hoàn tác được TRONG PHIÊN NÀY. Không
  // còn snapshot text để hoàn tác (wp-doc-redline-nondestructive: dismiss chỉ
  // đổi `status`, không sửa `.md`) — hoàn tác chỉ cần set lại `status: 'active'`.
  const [undoableIds, setUndoableIds] = useState<Set<string>>(new Set());
  const [previewMode, setPreviewMode] = useState<PreviewMode>('changes');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const docColRef = useRef<HTMLDivElement | null>(null);
  // Bám thẳng vào <article> chứa `dangerouslySetInnerHTML`, không bám vào cột
  // cha. Ref của cột có thể commit trước subtree HTML; ở runtime production đã
  // ghi nhận fence có trong article nhưng effect không nhận được một dependency
  // mới để quét lại (host/source đều bằng 0). Callback-ref của chính article chỉ
  // được giao sau khi node đích đã commit, nên đây là lifecycle đáng tin cậy để
  // dựng Mermaid/Draw.io hosts.
  const [docArticleNode, setDocArticleNode] = useState<HTMLElement | null>(null);
  // Cửa sổ xem đoạn được viện dẫn: `markId` là mark cần cuộn tới trong BẢN SAO
  // tài liệu dựng riêng cho modal, `label` là nguyên văn đoạn đó (hiện ở đầu
  // cửa sổ để người đọc biết mình đang được chỉ tới cái gì).
  const [refModal, setRefModal] = useState<{ markId: string; label: string } | null>(null);
  const modalDocRef = useRef<HTMLDivElement | null>(null);
  // wp-doc-redline-nondestructive: chi tiết một CHANGE/NOTE (id mark), hiện
  // trong PANEL cạnh phải của cột tài liệu (không phải modal — tài liệu vẫn
  // đọc được trong lúc panel mở). Xem `openAnnotationDetail`/
  // `AnnotationDetailPanel`.
  const [detailPanel, setDetailPanel] = useState<{ id: string } | null>(null);
  const printArticleRef = useRef<HTMLElement | null>(null);
  const [printBusy, setPrintBusy] = useState(false);

  function changePreviewMode(mode: PreviewMode) {
    if (mode === previewMode) return;
    setSelectedId(null);
    setPreviewMode(mode);
  }
  // Bật/tắt tô màu THEO TỪNG LOẠI. Một công tắc chung là chưa đủ: việc thật của
  // người review là "cho tôi xem riêng chỗ bị xoá" hay "ẩn mấy chỗ thêm chữ đi",
  // chứ không phải bật/tắt toàn bộ màu. Mặc định bật hết — đó là lý do màn hình
  // này tồn tại.
  const [paint, setPaint] = useState<PaintFlags>(ALL_PAINTED);
  const setPaintKind = (kind: PaintKind, on: boolean) => setPaint((prev) => ({ ...prev, [kind]: on }));

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

  const documentIndex = useMemo(() => createRedlineDocumentIndex(editedText ?? ''), [editedText]);
  const changes = useMemo(
    () => documentIndex.sort(changesState.status === 'ok' ? changesState.changes : NO_CHANGES),
    [changesState, documentIndex],
  );
  const notes = useMemo(() => documentIndex.sort(notesState), [documentIndex, notesState]);
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
      // theo đoạn chữ), nên KHÔNG đưa segment chữ của change này vào
      // injectHighlights nữa. `isAnchored`/`selectFromList` phía dưới coi sơ
      // đồ có host là neo được, không cần dựa vào `matched` của lượt bôi này.
      if (c.kind === 'flow-diagram') return [];
      // Bảng thành phần: enrichment daemon sinh, KHÔNG đi qua hệ đề xuất
      // người dùng — vẫn neo trên `quote` như trước (bảng đã CÓ SẴN trong tài
      // liệu gốc, không phải một đề xuất chờ duyệt).
      if (isComponentTableChange(c)) {
        const raw = (c.quote ?? '').trim();
        if (!raw) return [];
        const on = paint.edit;
        const className = !on ? styles.hlOff ?? '' : styles.hl ?? '';
        const inlineStyle = !on ? HL_OFF_INLINE_STYLE : HL_INLINE_STYLE;
        return annotationHighlightSegments(raw).map((text) => ({ id: c.id, text, className, inlineStyle, scope: documentIndex.scopeFor(c) }));
      }
      // Mọi change khác (agent lẫn user): tài liệu KHÔNG BAO GIỜ bị sửa, nên
      // vùng bôi luôn neo trên CHỮ GỐC còn nguyên trong tài liệu —
      // `changeHighlightSource` chọn `anchor` (thêm) hay `before` (sửa/xoá).
      const source = changeHighlightSource(c);
      if (!source) return [];
      const { op, text: raw } = source;
      if (op === 'del') {
        // Tắt tô màu vẫn giữ gạch ngang: đó là thứ DUY NHẤT phân biệt "chữ đề
        // xuất xoá" với chữ thật đang có trong tài liệu (xem
        // HL_DEL_OFF_INLINE_STYLE).
        const on = paint.del;
        const className = on ? styles.hlDel ?? '' : styles.hlDelOff ?? '';
        const inlineStyle = on ? HL_DEL_INLINE_STYLE : HL_DEL_OFF_INLINE_STYLE;
        return annotationHighlightSegments(raw).map((text) => ({ id: c.id, text, className, inlineStyle, scope: documentIndex.scopeFor(c) }));
      }
      const add = op === 'add';
      // Tắt tô màu KHÔNG có nghĩa là bỏ chèn mark: mark vẫn phải nằm trong DOM
      // thì modal mới còn neo được (bấm để mở) và mới không bị tụt xuống nhóm
      // "không tìm thấy trong tài liệu". Chỉ phần SƠN bị gỡ.
      const on = add ? paint.add : paint.edit;
      const className = !on ? styles.hlOff ?? '' : add ? styles.hlAdd ?? '' : styles.hl ?? '';
      const inlineStyle = !on ? HL_OFF_INLINE_STYLE : add ? HL_ADD_INLINE_STYLE : HL_INLINE_STYLE;
      return annotationHighlightSegments(raw).map((text) => ({ id: c.id, text, className, inlineStyle, scope: documentIndex.scopeFor(c) }));
    });
    const changePass = injectHighlights(html, requests, styles.hl ?? '', HL_INLINE_STYLE);

    // Lượt thứ hai cho NOTE, trên HTML đã bôi change: `anchor` lấy từ bản GỐC
    // nên thường vẫn còn nguyên trong bản đã sửa (note không sửa gì). Id mang
    // tiền tố `note:` để không đụng id của change — cả hai loại mark dùng
    // chung `data-change-id`, chung cơ chế click/mở modal.
    const noteRequests = notes.flatMap((n) => {
      if (previewMode !== 'notes') return [];
      if (n.status === 'dismissed') return [];
      // wp-table-highlight.yaml (Q2): note có `tableCells` được định vị bằng
      // toạ độ ô qua `useTableCellTint` — `anchor` của nó chỉ là dòng nguồn
      // dùng để TÌM LẠI <table>, không phải chữ cần bọc <mark>. Bọc mark ở
      // đây sẽ tô thừa nguyên dòng đó như một note chữ bình thường.
      if (n.tableCells) return [];
      const raw = (n.anchor ?? '').trim();
      if (!raw) return [];
      return annotationHighlightSegments(raw).map((text) => ({
        id: `${NOTE_ID_PREFIX}${n.id}`,
        text,
        className: paint.note ? styles.hlNote ?? '' : styles.hlOff ?? '',
        inlineStyle: paint.note ? NOTE_HL_INLINE_STYLE : HL_OFF_INLINE_STYLE,
        scope: documentIndex.scopeFor(n),
      }));
    });
    const notePass = injectHighlights(changePass.html, noteRequests, styles.hlNote ?? '', NOTE_HL_INLINE_STYLE);

    // Lượt thứ BA: các đoạn được `reason`/`finding` VIỆN DẪN. Chạy sau cùng để
    // không tranh chỗ với hai loại trên — một đoạn vừa là chỗ sửa vừa được
    // viện dẫn thì nó phải hiện là chỗ sửa, vì đó mới là thông tin người đọc
    // cần trước. injectHighlights bỏ qua occurrence đã nằm trong mark, nên thứ
    // tự các pass này cũng là thứ tự ưu tiên.
    const refRequests = [
      ...(previewMode === 'changes' ? changes.filter((c) => c.status !== 'dismissed') : []).flatMap((c) =>
        (c.doc_refs ?? []).flatMap((ref, i) =>
          quoteSegments(ref.trim()).slice(0, 1).map((text) => ({
            id: `${REF_ID_PREFIX}${c.id}:${i}`,
            text,
            className: styles.hlRef ?? '',
            inlineStyle: HL_REF_INLINE_STYLE,
          })),
        ),
      ),
      ...(previewMode === 'notes' ? notes.filter((n) => n.status !== 'dismissed') : []).flatMap((n) =>
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
    const refPass = injectHighlights(notePass.html, refRequests, styles.hlRef ?? '', HL_REF_INLINE_STYLE);

    return {
      html: refPass.html,
      matched: new Set<string>([
        ...changePass.matched,
        ...notePass.matched,
        ...refPass.matched,
      ]),
      // `doc_refs` are evidence links, not changed/commented content. Keep
      // their inline dotted marks (and matched ids for jump/modal behavior),
      // but never promote their containing list item/table to a tinted block.
      blocks: [...changePass.blocks, ...notePass.blocks],
    };
  }, [editedText, projectId, file.name, changes, notes, paint, previewMode, documentIndex]);

  const docHtml = docRender?.html ?? null;
  const anchored = docRender?.matched ?? EMPTY_SET;
  const mermaidDocumentParts = useMemo(
    () => splitMermaidDocumentHtml(
      docHtml ?? '',
      previewMode === 'changes'
        ? changes.filter((change) => change.kind === 'flow-diagram' && change.status !== 'dismissed')
        : [],
    ),
    [docHtml, previewMode, changes],
  );
  const anchoredMermaidIds = useMemo(
    () => new Set(mermaidDocumentParts.flatMap((part) => part.kind === 'mermaid' && part.changeId ? [part.changeId] : [])),
    [mermaidDocumentParts],
  );
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
  const activeChangeCount = changes.filter((c) => c.status !== 'dismissed').length;
  const activeNoteCount = notes.filter((n) => n.status !== 'dismissed').length;

  // ── Sơ đồ mermaid trong cột tài liệu (mục 4 WP3) ──────────────────────────
  // `renderMarkdownToSafeHtml` (dùng chung với FileViewer) đã dựng fence
  // ```mermaid thành <pre><code class="language-mermaid">mã thô</code></pre>
  // — KHÔNG có sơ đồ sống. Mượn đúng khuôn `mountMarkdownMermaidHosts` của
  // 'proposed' (mặc định) render `quote`; 'original' render `before` — CHỈ đổi
  // những gì đang hiện, không ghi gì ra tài liệu (khác hẳn dismiss).
  const [diagramView, setDiagramView] = useState<Record<string, 'proposed' | 'original'>>({});
  // Host của change `flow-diagram` sinh từ .drawio (mục D wp-drreview-drawio-
  // preview.yaml) — KHÁC mermaid: marker chữ không mang mã nguồn, XML thật
  // phải fetch riêng (xem DrawioDiagramHost). Không có khái niệm "mồ côi" như
  // mermaid: một marker LUÔN sinh từ đúng một system change (replaceDrawioInSlice),
  // nên `changeId` luôn parse được thẳng từ text marker, không cần đối chiếu
  // `changes`.
  const [drawioMounts, setDrawioMounts] = useState<
    Array<{ host: HTMLElement; changeId: string; flowId: string }>
  >([]);

  useEffect(() => {
    const container = docArticleNode;
    if (!container) {
      setDrawioMounts([]);
      return;
    }
    // Sơ đồ draw.io (mục D wp-drreview-drawio-preview.yaml) — daemon chỉ để
    // lại MỘT dòng caption marker (renderMarkdownToSafeHtml giữ `*…*` thành
    // <em>, xem replaceDrawioInSlice trong docs-review-enrich.ts), không có
    // mã nguồn nhúng như mermaid nên không gập <pre> xuống <details> — chỉ
    // chèn một host <mark> NGAY SAU đoạn chứa marker (giữ nguyên dòng chữ đó)
    // để DrawioDiagramHost portal toggle/badge/DrawioViewer vào.
    const drawioHostClass = (styles.drawioHost ?? '').trim();
    const drawioMountsNext: Array<{ host: HTMLElement; changeId: string; flowId: string }> = [];
    const drawioMutations: Array<{ host: HTMLElement }> = [];
    const emEls = Array.from(container.querySelectorAll<HTMLElement>('em'));
    for (const em of emEls) {
      const text = (em.textContent ?? '').trim();
      if (!DRAWIO_MARKER_RE.test(text)) continue;
      const flowIdMatch = DRAWIO_FLOWID_RE.exec(text);
      if (!flowIdMatch) continue;
      const flowId = flowIdMatch[1]!;
      const changeId = `sys-flow-diagram-${flowId}`;
      const block = em.closest('p') ?? em.parentElement;
      const parent = block?.parentElement;
      if (!block || !parent) continue;
      const host = document.createElement('mark');
      const on = paint.edit;
      host.className = `${drawioHostClass} ${on ? styles.hl ?? '' : styles.hlOff ?? ''}`.trim();
      host.setAttribute('style', on ? HL_INLINE_STYLE : HL_OFF_INLINE_STYLE);
      host.dataset.changeId = changeId;
      parent.insertBefore(host, block.nextSibling);
      drawioMountsNext.push({ host, changeId, flowId });
      drawioMutations.push({ host });
    }
    setDrawioMounts(drawioMountsNext);
    return () => {
      for (const { host } of drawioMutations) host.remove();
    };
  }, [docArticleNode, docHtml, loading]);

  // Cùng lý do như effect ngay trên, cho host draw.io (mục D wp-drreview-
  // drawio-preview.yaml) — tách effect riêng vì `drawioMounts` là state khác,
  // không phải để đổi hành vi effect mermaid ở trên (giữ NGUYÊN).
  useEffect(() => {
    const drawioHostClass = (styles.drawioHost ?? '').trim();
    for (const m of drawioMounts) {
      const on = paint.edit;
      m.host.className = `${drawioHostClass} ${on ? styles.hl ?? '' : styles.hlOff ?? ''}`.trim();
      m.host.setAttribute('style', on ? HL_INLINE_STYLE : HL_OFF_INLINE_STYLE);
    }
  }, [drawioMounts, paint.edit]);

  /** Mã mermaid ĐANG hiện cho một host: `before` khi người dùng bật "○ Gốc",
   *  ngược lại (mặc định) là `quote` — đúng đoạn đã dựng sẵn trong `code`. */
  function activeDiagramCode(m: { changeId: string | null; code: string }): string {
    if (!m.changeId || diagramView[m.changeId] !== 'original') return m.code;
    const owner = changes.find((c) => c.id === m.changeId);
    return extractMermaidFenceBody(owner?.before) ?? m.code;
  }

  // Block descriptors do not alter the HTML structure. They identify the
  // owning p/li/table-row/table/heading so additions and multi-line matches can be
  // tinted as one safe block without ever wrapping a mark across block tags.
  useEffect(() => {
    const container = docColRef.current;
    if (!container || !docRender) return;
    const blocks = Array.from(container.querySelectorAll<HTMLElement>('p, li, table, tr, h1, h2, h3, h4, h5, h6'));
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
      const noteOwner = notes.find((note) => `${NOTE_ID_PREFIX}${note.id}` === target.id);
      const operation = owner ? changeOp(owner) : noteOwner ? 'note' : previewMode === 'notes' ? 'note' : 'edit';
      // wp-table-highlight.yaml (Q1): change/note `kind: 'component'` neo
      // trúng một hàng bảng phải tô CẢ <table>, không chỉ hàng đó — bảng
      // thành phần thường chỉ neo được vào dòng header (mỗi ô dữ liệu như
      // "Có"/"Input" không đủ đặc trưng để tự đứng làm anchor), nên chỉ tô
      // đúng hàng khớp thì phần thân bảng nhìn như chưa được đánh dấu. Loại
      // annotation khác trúng một hàng vẫn tô đúng một hàng như cũ. `table`
      // đã nằm trong tập `blocks` được quét (selector có 'table'), nên
      // `clearBlockTint` dọn sạch nó ở lượt sau mà không cần thêm gì.
      const isComponentOwner = (owner ?? noteOwner)?.kind === 'component';
      const tintTarget = (target.kind === 'table' || target.kind === 'table-row') && isComponentOwner
        ? block.closest('table') ?? block
        : block;
      tintTarget.dataset.redlineBlock = operation;
      tintTarget.dataset.redlineOwner = target.id;
      if (operation === 'add') tintTarget.classList.add(styles.blockTintAdd ?? '');
      if (
        target.kind === 'table'
        || target.kind === 'table-row'
        || target.kind === 'list-item'
        || annotationWantsFullBlock(owner ?? noteOwner ?? {})
      ) tintTarget.classList.add(styles.blockTintFull ?? '');
    }
    return clearBlockTint;
  }, [docHtml, docRender, changes, notes, previewMode]);

  // wp-table-highlight.yaml (Q2): tint CÁC Ô một note `tableCells` chỉ ra —
  // effect RIÊNG, không đi qua notePass injectHighlights (`noteRequests` ở
  // trên loại note này ra): định vị bằng anchor (đã tìm lại đúng <table>) +
  // toạ độ ô, không cần <mark> chữ. Cùng pattern hiệu ứng DOM-phụ-thuộc như
  // effect block-tint ngay trên (dọn sạch mọi lần trước khi tô lại).
  useEffect(() => {
    const container = docColRef.current;
    if (!container) return;
    const cellTintClass = styles.cellTint ?? '';
    const touchedCells: HTMLElement[] = [];
    const anchoredIds = new Set<string>();
    if (cellTintClass && previewMode === 'notes') {
      const tables = Array.from(container.querySelectorAll<HTMLTableElement>('table'));
      for (const note of notes) {
        if (!note.tableCells || note.tableCells.cells.length === 0) continue;
        if (note.status === 'dismissed') continue;
        const markId = `${NOTE_ID_PREFIX}${note.id}`;
        const wanted = tableAnchorPlainText(note.anchor ?? '');
        if (!wanted) continue;
        // Định vị bằng cách dựng lại text từng HÀNG từ DOM (ô ghép bằng dấu
        // cách) rồi so BẰNG — KHÔNG dùng `table.textContent` vì renderer nối
        // các ô không chèn khoảng trắng (`<th>a</th><th>b</th>` → "ab"), nên
        // "a b" ghép-dấu-cách sẽ không bao giờ `includes` được. Cùng cách
        // dựng chuỗi với `tableRowCandidateLine` lúc tạo, nên khớp nhất quán.
        const table = tables.find((t) =>
          Array.from(t.querySelectorAll<HTMLTableRowElement>('tr')).some(
            (tr) =>
              normalizeTableAnchorText(
                Array.from(tr.children)
                  .filter((el): el is HTMLTableCellElement => el instanceof HTMLTableCellElement)
                  .map((el) => (el.textContent ?? '').trim())
                  .join(' '),
              ) === wanted,
          ),
        );
        if (!table) continue;
        const rows = Array.from(table.querySelectorAll<HTMLTableRowElement>('tr'));
        let matchedAny = false;
        for (const { row, col } of note.tableCells.cells) {
          const cell = rows[row]?.children[col];
          if (!(cell instanceof HTMLElement)) continue;
          cell.classList.add(cellTintClass);
          cell.dataset.redlineOwner = markId;
          touchedCells.push(cell);
          matchedAny = true;
        }
        if (matchedAny) anchoredIds.add(markId);
      }
    }
    setTableCellAnchoredIds(anchoredIds);
    return () => {
      for (const cell of touchedCells) {
        cell.classList.remove(cellTintClass);
        delete cell.dataset.redlineOwner;
      }
    };
  }, [docHtml, docRender, notes, previewMode]);

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
      const ownerBlock = target?.closest?.('[data-redline-owner]') as HTMLElement | null;
      if (!mark && !ownerBlock) return; // bấm ngoài mọi vùng annotation
      // N6 (wp3b.yaml): host mermaid (chính LÀ <mark> này) chứa MermaidDiagram
      // portal thẳng vào, và các nút zoom/pan/reset của nó KHÔNG tự
      // stopPropagation (không được sửa MermaidDiagram.tsx — ngoài phạm vi
      // touches). Một cú bấm rơi trúng <button> bên trong mark không phải bấm
      // CHỌN change — nút "Gốc"/"Đề xuất" của khối sơ đồ đã tự stopPropagation
      // riêng nên không lọt tới đây; chỉ còn nút của MermaidDiagram mới rơi
      // vào nhánh này.
      if (target?.closest?.('button')) return;
      const id = mark?.dataset.changeId ?? ownerBlock?.dataset.redlineOwner;
      if (!id) return;
      openAnnotationDetail(id);
    };
    container.addEventListener('click', fn);
    return () => container.removeEventListener('click', fn);
    // `loading` là thứ quyết định cột có được render hay không; khi nó đổi
    // false thì ref mới trỏ tới phần tử thật. Sau đó cột giữ nguyên danh tính
    // dù HTML bên trong thay đổi bao nhiêu lần, nên không cần gắn lại theo
    // docHtml — đó chính là điểm lợi của uỷ quyền.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  /** Mọi `<mark data-change-id>` của MỘT change/note, truy vấn DOM TRỰC TIẾP
   *  tại THỜI ĐIỂM GỌI — không đọc qua một bản đồ được gom sẵn trong effect.
   *
   *  Vì sao: bản đồ gom sẵn (`marksByChangeRef`, đã bị xoá) chỉ được cập nhật
   *  TRONG một `useEffect` chạy SAU khi cột tài liệu render lại — có một cửa
   *  sổ giữa lúc DOM đã đổi (đổi tab mode, đổi trang) và lúc effect đó kịp
   *  chạy, nhất là ngay sau khi đổi mode. Bấm một mục ngay trong cửa sổ đó đọc
   *  phải bản đồ CŨ (mark của mode/trang trước), nên cuộn sai chỗ hoặc không
   *  cuộn được gì — đúng triệu chứng "bấm mục không cuộn tới tài liệu". Query
   *  DOM sống loại bỏ hẳn cửa sổ đó: không có bản đồ nào để lệch.
   *
   *  `opts.hostOnly` (B2, wp3b.yaml — trước đây là `hostMarksFor` riêng): lọc
   *  thêm class `mermaidHost` (mermaid) hoặc `drawioHost` (draw.io, mục D
   *  wp-drreview-drawio-preview.yaml — cùng `kind: 'flow-diagram'` nhưng host
   *  riêng, xem docblock DrawioDiagramHost) — cần cho sơ đồ, vì một mark chữ
   *  nào đó lỡ khớp trùng nhãn (ví dụ `doc_refs` của change khác trỏ vào đúng
   *  đoạn chữ trong khối sơ đồ) sẽ không đảm bảo phần tử ĐẦU TIÊN trả về luôn
   *  là host. Không truyền `opts` → hành vi y hệt bản đồ cũ (mọi mark cùng id,
   *  không lọc host). */
  function marksFor(id: string, opts?: { hostOnly?: boolean }): HTMLElement[] {
    const container = docColRef.current;
    if (!container) return [];
    const hostClasses = opts?.hostOnly
      ? [(styles.mermaidHost ?? '').trim(), (styles.drawioHost ?? '').trim()].filter(Boolean)
      : [];
    return Array.from(container.querySelectorAll<HTMLElement>('mark[data-change-id]')).filter(
      (el) => el.dataset.changeId === id && (!opts?.hostOnly || hostClasses.length === 0 || hostClasses.some((c) => el.classList.contains(c))),
    );
  }

  /** Bấm nút điều hướng (mục trước/sau) hoặc chọn từ `navigationItems`: cuộn
   *  tài liệu tới vùng bôi đầu tiên của change/note đó và nháy sáng mọi mark
   *  của nó. `navigationItems` luôn lấy từ CHÍNH `previewMode` hiện tại (xem
   *  khai báo phía trên), nên không còn tình huống lệch mode cần chờ. */
  function selectFromList(id: string) {
    setSelectedId(id);
    // Sơ đồ mermaid: cuộn tới HOST (hostOnly — đúng vế (2) của B2 trong
    // wp3b.yaml, xem docblock marksFor ngay trên).
    const change = changes.find((c) => c.id === id);
    const marks = marksFor(id, { hostOnly: change?.kind === 'flow-diagram' });
    if (marks.length === 0) return; // không neo được — không có gì để cuộn tới
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

  /** Mở cửa sổ xem đoạn được VIỆN DẪN.
   *
   *  Vì sao là modal chứ không cuộn cột chính: đoạn được viện dẫn thường nằm
   *  rất xa chỗ đang đọc (một lý do ở mục 5 dẫn tới bảng ở mục 2). Cuộn cột
   *  chính tới đó đồng nghĩa vứt mất vị trí người đọc đang đứng, và họ phải tự
   *  tìm đường quay lại. Modal cho họ liếc sang rồi đóng lại là về đúng chỗ cũ. */
  function openRefModal(markId: string, label: string) {
    setRefModal({ markId, label });
  }

  /** Bấm một vùng bôi trong tài liệu: mở panel chi tiết (cạnh phải) của
   *  change/note chủ. Vùng VIỆN DẪN (`ref:<ownerId>:<i>`) quy về chính thẻ đã
   *  viện dẫn nó — người đọc bấm vào một đoạn gạch chấm là đang hỏi "ai nhắc
   *  tới chỗ này?", nên câu trả lời là thẻ chủ, không phải một cửa sổ riêng
   *  cho tham chiếu. Enrichment (sơ đồ/bảng thành phần) không có panel — bấm
   *  vào đó không làm gì, vì nó không thuộc hệ đề xuất/duyệt. */
  function openAnnotationDetail(id: string) {
    const ownerId = id.startsWith(REF_ID_PREFIX)
      ? // bỏ tiền tố rồi cắt hậu tố `:<số>`. KHÔNG dùng split(':') — ownerId của
        // note tự nó đã chứa dấu hai chấm (`note:n1`).
        id.slice(REF_ID_PREFIX.length).replace(/:\d+$/, '')
      : id;
    const target = resolveAnnotationDetail(ownerId, changes, notes);
    if (!target) return;
    // Luôn CHỌN (nháy sáng/cuộn tới) mark được bấm, kể cả sơ đồ/bảng — chỉ
    // riêng PANEL chi tiết là không mở cho hai loại nội dung làm giàu này
    // (chúng đã có tương tác riêng: toggle Gốc/Đề xuất, bảng inline).
    setSelectedId(ownerId);
    if (target.kind === 'change' && (target.change.kind === 'flow-diagram' || isComponentTableChange(target.change))) return;
    setDetailPanel({ id: ownerId });
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

  // Escape đóng cả cửa sổ tham chiếu lẫn panel chi tiết. Gắn ở `document` chứ
  // không ở phần tử: tiêu điểm có thể đang nằm ở nút Đóng, ở vùng cuộn, hay
  // chưa ở đâu cả.
  useEffect(() => {
    if (!refModal && !detailPanel) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return;
      setRefModal(null);
      setDetailPanel(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [refModal, detailPanel]);

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
  // của các lượt bôi. Tài liệu hiển thị LUÔN là bản gốc đã enrich: mọi thao
  // tác change/note giờ chỉ sửa `changes.json`/`notes.json`, KHÔNG BAO GIỜ ghi
  // lại `file.name` — đây là bất biến bắt buộc của toàn bộ component.
  /** Trả `true` khi lưu thành công, `false` khi bị chặn (đang bận) hoặc lỗi. */
  async function saveAction(id: string, action: () => { changes?: DocRedlineChange[]; events?: DocReviewAnnotationEvent[]; notes?: DocRedlineNote[] }): Promise<boolean> {
    if (busyId) return false;
    setBusyId(id); setErrorById((prev) => ({ ...prev, [id]: '' }));
    const beforeChanges = changesState; const beforeNotes = notes;
    try {
      const result = action();
      const writes: Array<[string, string]> = [];
      if (result.changes) writes.push([
        file.name.replace(/\.md$/i, '.changes.json'),
        sidecarJson(result.changes, result.events ?? events),
      ]);
      if (result.notes) writes.push([file.name.replace(/\.md$/i, '.notes.json'), JSON.stringify(result.notes, null, 2)]);
      for (const [name, content] of writes) {
        const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/files`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, content }) });
        if (!response.ok) throw new Error('Không ghi được file');
      }
      if (result.changes) {
        const nextEvents = result.events ?? events;
        setChangesRaw(sidecarJson(result.changes, nextEvents));
        setChangesState({ status: 'ok', changes: result.changes, events: nextEvents });
      }
      if (result.notes) { setNotesRaw(JSON.stringify(result.notes)); setNotes(result.notes); }
      setDraft(null);
      return true;
    } catch (error) { setChangesState(beforeChanges); setNotes(beforeNotes); setErrorById((prev) => ({ ...prev, [id]: error instanceof Error ? error.message : 'Lỗi ghi file' })); return false; }
    finally { setBusyId(null); }
  }

  function updateChange(c: DocRedlineChange, next: Partial<DocRedlineChange>, eventType?: DocReviewAnnotationEvent['type']) {
    const list = changes.map((item) => item.id === c.id ? { ...item, ...next } : item);
    const changed = list.find((item) => item.id === c.id) ?? c;
    return {
      changes: list,
      events: eventType ? [...events, eventFor(c.id, eventType, changed)] : events,
    };
  }

  async function dismissChange(c: DocRedlineChange) {
    if (c.status === 'dismissed') {
      if (!undoableIds.has(c.id)) return;
      await saveAction(c.id, () => updateChange(c, { status: 'active' }, 'restore'));
      setUndoableIds((prev) => { const next = new Set(prev); next.delete(c.id); return next; });
      return;
    }
    await saveAction(c.id, () => updateChange(c, { status: 'dismissed' }, 'dismiss'));
    setUndoableIds((prev) => new Set(prev).add(c.id));
  }

  async function dismissNote(n: DocRedlineNote) {
    const id = `${NOTE_ID_PREFIX}${n.id}`;
    if (n.status === 'dismissed') {
      if (!undoableIds.has(id)) return;
      await saveAction(id, () => ({ notes: notes.map((item) => item.id === n.id ? { ...item, status: undefined } : item) }));
      setUndoableIds((prev) => { const next = new Set(prev); next.delete(id); return next; });
      return;
    }
    await saveAction(id, () => ({ notes: notes.map((item) => item.id === n.id ? { ...item, status: 'dismissed' } : item) }));
    setUndoableIds((prev) => new Set(prev).add(id));
  }

  // wp-table-highlight.yaml (Q2): theo dõi selection để bật/tắt nút "Tô ô
  // bảng" — khác cụm nút text (luôn bật, chỉ kiểm lúc bấm) vì thao tác này
  // CHỈ có nghĩa khi đang bôi trong một bảng; để nút luôn bật rồi báo lỗi
  // sau bấm sẽ mời bấm nhầm liên tục trên một tài liệu nhiều bảng dài.
  useEffect(() => {
    const check = () => {
      const selection = window.getSelection();
      const anchorNode = selection?.anchorNode ?? null;
      const container = docColRef.current;
      const anchorEl = anchorNode instanceof Element ? anchorNode : anchorNode?.parentElement ?? null;
      const inDocCol = !!(anchorNode && container?.contains(anchorNode));
      setSelectionInTable(!!(inDocCol && anchorEl?.closest('table')));
      // wp-text-highlight.yaml: bật nút "Tô đoạn chọn" — chỉ cần selection
      // không rỗng nằm trong docColRef, KHÔNG cần trong <table> (khác
      // selectionInTable ngay trên).
      setSelectionNonEmpty(!!(inDocCol && selection && selection.toString().trim()));
    };
    document.addEventListener('selectionchange', check);
    check();
    return () => document.removeEventListener('selectionchange', check);
  }, []);

  /** wp-table-highlight.yaml (Q2): dòng ứng viên cho `anchor` định vị bảng —
   *  ghép lại các ô của MỘT hàng theo đúng khuôn nguồn markdown
   *  (`| ô 1 | ô 2 | ô 3 |`, xem docblock đầu file WP3) để so khớp bằng
   *  `pickUniqueTableAnchorLine`. Không khớp tuyệt đối với mọi cách format
   *  markdown (đậm/nghiêng trong ô sẽ lệch), nhưng đủ cho khuôn bảng phổ biến
   *  daemon sinh ra; hàng không khớp dòng nào chỉ đơn giản không được chọn. */
  function tableRowCandidateLine(tr: HTMLTableRowElement): string | null {
    const cellTexts = Array.from(tr.children)
      .filter((el): el is HTMLTableCellElement => el instanceof HTMLTableCellElement)
      .map((el) => (el.textContent ?? '').trim());
    return cellTexts.length > 0 ? `| ${cellTexts.join(' | ')} |` : null;
  }

  /** wp-table-highlight.yaml (Q2): tạo nháp "tô ô bảng" từ vùng đang bôi —
   *  đường MỚI, song song với `startUserAnnotation` (không đụng hàm đó). */
  function startTableCellHighlight() {
    const selection = window.getSelection();
    const anchorNode = selection?.anchorNode ?? null;
    if (!selection || selection.rangeCount === 0 || !anchorNode || !docColRef.current?.contains(anchorNode)) {
      setTableCellError('Hãy bôi các ô trong một bảng.');
      return;
    }
    const anchorEl = anchorNode instanceof Element ? anchorNode : anchorNode.parentElement;
    const table = anchorEl?.closest('table') ?? null;
    if (!table) {
      setTableCellError('Chỉ dùng cho vùng trong bảng.');
      return;
    }
    const ranges = Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i));
    const rows = Array.from(table.querySelectorAll<HTMLTableRowElement>('tr'));
    const cells: Array<{ row: number; col: number }> = [];
    rows.forEach((tr, rowIndex) => {
      Array.from(tr.children).forEach((cellEl, colIndex) => {
        if (!(cellEl instanceof HTMLTableCellElement)) return;
        if (!ranges.some((range) => range.intersectsNode(cellEl))) return;
        cells.push({ row: rowIndex, col: colIndex });
      });
    });
    if (cells.length === 0) {
      setTableCellError('Hãy bôi các ô trong một bảng.');
      return;
    }
    // Ứng viên anchor theo thứ tự ưu tiên: các hàng đã chọn trước (thứ tự
    // xuất hiện trong bảng), rồi hàng đầu tiên (thường là header) sau cùng.
    const involvedRows = Array.from(new Set(cells.map((c) => c.row))).sort((a, b) => a - b);
    const candidateRows = rows.length > 0 ? Array.from(new Set([...involvedRows, 0])) : involvedRows;
    const candidateLines = candidateRows
      .map((rowIndex) => rows[rowIndex])
      .filter((tr): tr is HTMLTableRowElement => !!tr)
      .map(tableRowCandidateLine)
      .filter((line): line is string => line != null);
    const anchor = pickUniqueTableAnchorLine(editedText ?? '', candidateLines);
    if (anchor == null) {
      setTableCellError('Không định vị được bảng (bảng có dòng trùng).');
      return;
    }
    setTableCellError('');
    setTableCellDraft({ cells, anchor, reason: '' });
  }

  function startUserAnnotation(operation: DraftAnnotation['operation']) {
    const selection = window.getSelection();
    const selected = selection?.toString().trim() ?? '';
    const anchorNode = selection?.anchorNode;
    if (!selected || !anchorNode || !docColRef.current?.contains(anchorNode)) {
      setDraftError('Hãy bôi đen một đoạn trong tài liệu trước.');
      return;
    }
    // Tài liệu không còn bị sửa: chỗ neo chỉ cần đủ để `injectHighlights` dò
    // lại được (fuzzy, không cần xuất hiện đúng một lần) — cùng ngưỡng với
    // `startTextHighlight` ngay dưới.
    if (annotationHighlightSegments(selected).length === 0) {
      setDraftError('Đoạn quá ngắn để đánh dấu (chọn ít nhất 2 từ).');
      return;
    }
    setDraftError('');
    setDraft({ operation, selected, replacement: '', reason: '', kind: defaultUserKind(operation) });
  }

  /** wp4.yaml mục 2: "Thêm sau mục…" — cùng composer với "Thêm sau đoạn
   *  chọn" (`startUserAnnotation('add')`), chỉ khác nguồn `selected`: một dòng
   *  heading do người dùng CHỌN từ danh sách thay vì bôi đen. */
  function startHeadingAnnotation(heading: DocHeading) {
    if (uniqueHeadingLineOffset(editedText ?? '', heading.line) == null) {
      setDraftError('Đoạn đã chọn phải xuất hiện đúng một lần trong mã nguồn tài liệu.');
      return;
    }
    setDraftError('');
    setDraft({ operation: 'add', selected: heading.line, replacement: '', reason: '', kind: defaultUserKind('add') });
    setHeadingPickerOpen(false);
    setHeadingPickerValue('');
  }

  /** Non-destructive: tài liệu KHÔNG BAO GIỜ bị ghi lại. Mọi annotation người
   *  dùng tạo (add/edit/delete) chỉ neo trên chữ GỐC còn nguyên trong tài
   *  liệu — `before`/`anchor` giữ nguyên đoạn đã chọn, `quote` chỉ là nội dung
   *  ĐỀ XUẤT (hiện trong modal chi tiết), không đi vào tài liệu. */
  async function createUserAnnotation() {
    if (!draft) return;
    const replacement = draft.replacement.trim();
    if (draft.operation !== 'delete' && !replacement) {
      setDraftError('Nội dung mới không được để trống.');
      return;
    }
    let before: string | undefined;
    let quote: string | undefined;
    let anchor: string | undefined;
    if (draft.operation === 'edited') {
      before = draft.selected;
      quote = replacement;
    } else if (draft.operation === 'delete') {
      before = draft.selected;
    } else {
      quote = replacement;
      anchor = draft.selected;
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
      changes: [...changes, change],
      events: [...events, eventFor(id, 'create', change)],
    }));
  }

  /** wp-table-highlight.yaml (Q2): lưu nháp "tô ô bảng" thành MỘT note
   *  `kind: 'component'` trong `notes.json` — KHÔNG sửa markdown
   *  (`changedMd: false`), nên đường lưu này không đụng `changes.json` hay
   *  `events` như `createUserAnnotation`. */
  async function createTableCellAnnotation() {
    if (!tableCellDraft) return;
    const id = uid('user');
    const note: DocRedlineNote = {
      id,
      kind: 'component',
      severity: 'minor',
      anchor: tableCellDraft.anchor,
      tableCells: { cells: tableCellDraft.cells },
      finding: tableCellDraft.reason.trim() || 'Người dùng tự đánh dấu ô trong bảng.',
      suggestion: '',
    };
    const ok = await saveAction(id, () => ({ notes: [...notes, note] }));
    if (ok) setTableCellDraft(null);
  }

  /** wp-text-highlight.yaml: heading (h1..h6) gần nhất đứng TRƯỚC vùng chọn
   *  trong `container` — best-effort thu hẹp phạm vi neo (xem
   *  `startTextHighlight`). Không tìm được → `undefined` (neo toàn tài liệu
   *  như note thường). Logic dính DOM (`compareDocumentPosition` so vị trí
   *  node trong cây) nên KHÔNG tách được thành helper thuần test bằng jsdom
   *  dựng tay — xem "not_done" trong báo cáo WP: kiểm bằng test round-trip
   *  parseDocNotes (giữ `sectionHeading`) + đọc tay. */
  function findPrecedingHeadingText(container: HTMLElement, anchorNode: Node): string | undefined {
    const headings = Array.from(container.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6'));
    let best: HTMLElement | null = null;
    for (const heading of headings) {
      if (heading.compareDocumentPosition(anchorNode) & Node.DOCUMENT_POSITION_FOLLOWING) best = heading;
    }
    return best?.textContent?.trim() || undefined;
  }

  /** wp-text-highlight.yaml: tạo nháp "Tô đoạn chọn" từ vùng đang bôi — ĐƯỜNG
   *  MỚI song song với `startUserAnnotation`, KHÔNG gọi `uniqueOccurrenceIndex`.
   *  Đây là điểm mấu chốt của WP: đường này chỉ đánh dấu/ghi chú (không sửa
   *  markdown) nên không đòi đoạn khớp DUY NHẤT trong mã nguồn — nó neo bằng
   *  khớp mờ y hệt một note thường (`annotationHighlightSegments` →
   *  `injectHighlights`/`fuzzyRegex`), không cần `changes.json` cắt đúng đoạn
   *  nguồn để thay. */
  function startTextHighlight() {
    const selection = window.getSelection();
    const selected = selection?.toString().trim() ?? '';
    const anchorNode = selection?.anchorNode ?? null;
    const container = docColRef.current;
    if (!selected || !anchorNode || !container?.contains(anchorNode)) {
      setTextHighlightError('Hãy bôi một đoạn chữ trong tài liệu.');
      return;
    }
    // notePass injectHighlights cắt `anchor` qua đúng hàm này (xem docRender);
    // một đoạn quá ngắn (1 từ, hoặc toàn ký tự markdown bị quoteSegments lọc
    // sạch) sẽ ra mảng rỗng và không neo được gì — chặn ở đây thay vì lưu một
    // note chết không bao giờ hiện `<mark>`.
    if (annotationHighlightSegments(selected).length === 0) {
      setTextHighlightError('Đoạn quá ngắn để đánh dấu (chọn ít nhất 2 từ).');
      return;
    }
    const sectionHeading = findPrecedingHeadingText(container, anchorNode);
    setTextHighlightError('');
    setTextHighlightDraft({ selected, reason: '', sectionHeading });
  }

  /** wp-text-highlight.yaml: lưu nháp "Tô đoạn chọn" thành MỘT note trong
   *  `notes.json` — cùng khuôn `createTableCellAnnotation` (không sửa
   *  markdown, `changedMd: false`), khác ở chỗ `anchor` là chữ RENDER (không
   *  `tableCells`) nên note này tự đi qua notePass injectHighlights sẵn có,
   *  không cần effect render riêng. `kind: 'ux-writing'` — chọn MỘT kind hợp
   *  lệ cho một ghi chú tự do người dùng gắn vào một đoạn chữ (đường này
   *  không có "phép sửa" như `defaultUserKind` để suy loại theo). */
  async function createTextHighlightAnnotation() {
    if (!textHighlightDraft) return;
    const id = uid('user');
    const note: DocRedlineNote = {
      id,
      kind: 'ux-writing',
      severity: 'minor',
      anchor: textHighlightDraft.selected,
      finding: textHighlightDraft.reason.trim() || 'Người dùng tự đánh dấu đoạn này.',
      suggestion: '',
      ...(textHighlightDraft.sectionHeading ? { sectionHeading: textHighlightDraft.sectionHeading } : {}),
    };
    const ok = await saveAction(id, () => ({ notes: [...notes, note] }));
    if (ok) setTextHighlightDraft(null);
  }

  // Sơ đồ không đóng góp vào `anchored` qua text highlight. Mermaid lấy owner
  // trực tiếp từ phần React đã tách; Draw.io vẫn có host theo marker. Có một
  // trong hai thì change sơ đồ được coi là neo thành công.
  const isAnchored = (c: DocRedlineChange) =>
    c.kind === 'flow-diagram'
      ? anchoredMermaidIds.has(c.id) || drawioMounts.some((m) => m.changeId === c.id)
      : anchored.has(c.id);

  /** wp-table-highlight.yaml (Q2): note `tableCells` không tạo `<mark>` (xem
   *  `noteRequests`), nên không có mặt trong `anchored` (`docRender.matched`)
   *  dù nó ĐÃ định vị được bảng và đang tô ô thật — dùng thêm
   *  `tableCellAnchoredIds` (do `useTableCellTint` cập nhật) để rail coi nó là
   *  neo được như mọi note khác, thay vì rơi vào nhánh "không tìm thấy". */
  const isNoteAnchored = (n: DocRedlineNote) => {
    const markId = `${NOTE_ID_PREFIX}${n.id}`;
    return anchored.has(markId) || tableCellAnchoredIds.has(markId);
  };

  const navigationItems = useMemo<RedlineNavigationItem[]>(() => {
    if (previewMode === 'notes') {
      return notes.map((note) => ({
        id: `${NOTE_ID_PREFIX}${note.id}`,
        anchored: isNoteAnchored(note),
        dismissed: note.status === 'dismissed',
      }));
    }
    return changes.map((change) => ({ id: change.id, anchored: isAnchored(change), dismissed: change.status === 'dismissed' }));
  }, [previewMode, notes, changes, anchored, anchoredMermaidIds, drawioMounts, tableCellAnchoredIds]);
  const navigationPosition = getNavigationPosition(navigationItems, selectedId);
  function navigate(direction: 'previous' | 'next') {
    const id = getAdjacentNavigationId(navigationItems, selectedId, direction);
    if (id) selectFromList(id);
  }

  async function printDocument(): Promise<void> {
    if (printBusy) return;
    setPrintBusy(true);
    try {
      const sourceArticle = docColRef.current?.querySelector<HTMLElement>('#doc-redline-document-tabpanel');
      if (sourceArticle && printArticleRef.current) {
        await waitForPrintableMermaid(sourceArticle, (styles.mermaidHost ?? '').trim());
        // Safe by construction: sourceArticle bắt nguồn từ docHtml đã sanitize
        // và các renderer nội bộ; clone không nhận thêm HTML từ input ngoài.
        printArticleRef.current.innerHTML = printableArticleHtml(sourceArticle, {
          mermaidFrame: (styles.mermaidFrame ?? '').trim(),
          drawioFrame: (styles.drawioFrame ?? '').trim(),
        });
      }

      // Bật cờ trên <body> để CSS in chỉ hiện tấm sheet portal; dọn bằng
      // afterprint + timeout dự phòng (Safari cũ không bắn afterprint đều).
      const old = document.title;
      document.title = `review-${file.name.split('/').pop()?.replace(/\.md$/i, '') ?? 'document'}`;
      document.body.dataset.odPrint = 'redline';
      const cleanupPrint = () => {
        document.title = old;
        delete document.body.dataset.odPrint;
        window.removeEventListener('afterprint', cleanupPrint);
      };
      window.addEventListener('afterprint', cleanupPrint);
      window.print();
      window.setTimeout(cleanupPrint, 1500);
    } finally {
      setPrintBusy(false);
    }
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
                  disabled={printBusy}
                  aria-busy={printBusy}
                  onClick={() => void printDocument()}
                >
                  {printBusy ? 'Đang chuẩn bị PDF…' : 'Xuất PDF'}
                </button>
                {previewMode === 'changes' ? (
                  <HighlightFilters
                    paint={paint}
                    onChange={setPaintKind}
                    counts={{ add: opCounts.add, edit: opCounts.edit, del: opCounts.del, note: 0 }}
                    includeNote={notes.length === 0}
                  />
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
              {/* wp-table-highlight.yaml (Q2): kéo bôi các Ô trong một bảng —
                  đường MỚI song song với ba nút bôi-đen-chữ ở trên, chỉ bật
                  khi vùng đang chọn thật sự nằm trong một <table>. */}
              <button
                type="button"
                disabled={!selectionInTable}
                title={selectionInTable ? undefined : 'Bôi đen vài ô trong một bảng để bật nút này'}
                onClick={startTableCellHighlight}
              >
                Tô ô bảng
              </button>
              {/* wp-text-highlight.yaml: đánh dấu/ghi chú một đoạn CHỮ, neo
                  KHỚP MỜ — song song "Tô ô bảng", KHÔNG đòi đoạn duy nhất
                  trong mã nguồn (khác ba nút Sửa/Xoá/Thêm ở trên). */}
              <button
                type="button"
                disabled={!selectionNonEmpty}
                title={selectionNonEmpty ? undefined : 'Bôi đen một đoạn chữ trong tài liệu để bật'}
                onClick={startTextHighlight}
              >
                Tô đoạn chọn
              </button>
              {draftError && !draft ? <span className={styles.toolbarError}>{draftError}</span> : null}
              {tableCellError && !tableCellDraft ? <span className={styles.toolbarError}>{tableCellError}</span> : null}
              {textHighlightError && !textHighlightDraft ? <span className={styles.toolbarError}>{textHighlightError}</span> : null}
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
            {/* wp-table-highlight.yaml (Q2): composer riêng cho "Tô ô bảng" —
                không dùng chung `draft` (thao tác này không sửa markdown,
                không có nội dung mới/loại, chỉ cần một lý do). */}
            {tableCellDraft ? (
              <div className={styles.annotationComposer} role="group" aria-label="Tô ô trong bảng">
                <div className={styles.annotationComposerHead}>
                  <strong>Tô ô đã chọn trong bảng</strong>
                  <button type="button" onClick={() => { setTableCellDraft(null); setTableCellError(''); }}>Đóng</button>
                </div>
                <p className={styles.selectedQuote}>{tableCellDraft.cells.length} ô đã chọn</p>
                <input
                  aria-label="Lý do"
                  placeholder="Lý do (không bắt buộc)"
                  value={tableCellDraft.reason}
                  onChange={(event) => setTableCellDraft((current) => current ? { ...current, reason: event.target.value } : current)}
                />
                {tableCellError ? <p className={styles.error}>{tableCellError}</p> : null}
                <div className={styles.actions}>
                  <button type="button" disabled={busyId != null} onClick={() => void createTableCellAnnotation()}>
                    {busyId ? 'Đang lưu...' : 'Lưu thay đổi'}
                  </button>
                  <button type="button" disabled={busyId != null} onClick={() => { setTableCellDraft(null); setTableCellError(''); }}>Huỷ</button>
                </div>
              </div>
            ) : null}
            {/* wp-text-highlight.yaml: composer riêng cho "Tô đoạn chọn" —
                cùng khuôn composer "Tô ô bảng" ngay trên (không sửa markdown,
                chỉ một lý do), khác dữ liệu hiển thị: đoạn chữ đã chọn (cắt
                gọn qua `refLabel` chỉ để HIỂN THỊ — dữ liệu lưu là
                `textHighlightDraft.selected` nguyên vẹn) thay vì số ô. */}
            {textHighlightDraft ? (
              <div className={styles.annotationComposer} role="group" aria-label="Tô đoạn chọn">
                <div className={styles.annotationComposerHead}>
                  <strong>Tô đoạn đã chọn</strong>
                  <button type="button" onClick={() => { setTextHighlightDraft(null); setTextHighlightError(''); }}>Đóng</button>
                </div>
                <p className={styles.selectedQuote}>“{refLabel(textHighlightDraft.selected)}”</p>
                <input
                  aria-label="Lý do"
                  placeholder="Lý do (không bắt buộc)"
                  value={textHighlightDraft.reason}
                  onChange={(event) => setTextHighlightDraft((current) => current ? { ...current, reason: event.target.value } : current)}
                />
                {textHighlightError ? <p className={styles.error}>{textHighlightError}</p> : null}
                <div className={styles.actions}>
                  <button type="button" disabled={busyId != null} onClick={() => void createTextHighlightAnnotation()}>
                    {busyId ? 'Đang lưu...' : 'Lưu thay đổi'}
                  </button>
                  <button type="button" disabled={busyId != null} onClick={() => { setTextHighlightDraft(null); setTextHighlightError(''); }}>Huỷ</button>
                </div>
              </div>
            ) : null}
            <div className={styles.docRow ?? ''}>
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
                </div>
                {/* Safe by contract: renderMarkdownToSafeHtml escapes raw HTML
                    and rejects unsafe link protocols. */}
                <article
                  ref={setDocArticleNode}
                  id="doc-redline-document-tabpanel"
                  role="tabpanel"
                  aria-labelledby={`doc-redline-document-${previewMode}-tab`}
                  className="markdown-rendered"
                >
                  {mermaidDocumentParts.map((part, i) => {
                    if (part.kind === 'html') {
                      return <SelectionSafeHtmlChunk key={`html-${i}`} className={styles.htmlChunk ?? ''} html={part.html} />;
                    }
                    const Host = part.changeId ? 'mark' : 'div';
                    const hostClass = part.changeId
                      ? `${styles.mermaidHost ?? ''} ${paint.edit ? styles.hl ?? '' : styles.hlOff ?? ''}`.trim()
                      : styles.mermaidHost ?? '';
                    const hostStyle = part.changeId
                      ? paint.edit
                        ? { backgroundColor: 'rgba(245,158,11,.38)', outline: '1px solid rgba(245,158,11,.85)', borderRadius: 3, cursor: 'pointer' }
                        : { backgroundColor: 'transparent', color: 'inherit', cursor: 'pointer' }
                      : undefined;
                    return (
                      <div key={`mermaid-${i}`} className={styles.htmlChunk ?? ''}>
                        <Host
                          className={hostClass}
                          style={hostStyle}
                          {...(part.changeId ? { 'data-change-id': part.changeId } : {})}
                        >
                          {part.changeId ? (
                        <div className={styles.diagramToggle ?? ''} role="group" aria-label="Xem sơ đồ gốc hay đề xuất">
                          {/* WP-drreview-mmd-color-badge: badge "Sơ đồ đề
                              xuất" + chú giải 3 màu ở ĐẦU hàng — sơ đồ được
                              thay luôn có màu (daemon bù khi agent quên tô,
                              xem mermaid-highlight.ts), người xem cần biết
                              đây là bản có so sánh, không phải nguyên bản. */}
                          <span className={styles.diagramBadge ?? ''}>Sơ đồ đề xuất</span>
                          <span className={styles.diagramLegend ?? ''} aria-label="Chú giải màu thay đổi">
                            <span className={`${styles.legendDot ?? ''} ${styles.legendDotAdded ?? ''}`} aria-hidden="true" />
                            thêm
                            <span className={`${styles.legendDot ?? ''} ${styles.legendDotModified ?? ''}`} aria-hidden="true" />
                            sửa
                            <span className={`${styles.legendDot ?? ''} ${styles.legendDotRemoved ?? ''}`} aria-hidden="true" />
                            bỏ
                          </span>
                          <button
                            type="button"
                            className={diagramView[part.changeId] !== 'original' ? styles.diagramToggleOn ?? '' : undefined}
                            onClick={(ev) => {
                              ev.stopPropagation();
                              setDiagramView((prev) => ({ ...prev, [part.changeId as string]: 'proposed' }));
                            }}
                          >
                            ◉ Đề xuất
                          </button>
                          <button
                            type="button"
                            className={diagramView[part.changeId] === 'original' ? styles.diagramToggleOn ?? '' : undefined}
                            onClick={(ev) => {
                              ev.stopPropagation();
                              setDiagramView((prev) => ({ ...prev, [part.changeId as string]: 'original' }));
                            }}
                          >
                            ○ Gốc
                          </button>
                        </div>
                      ) : (
                        // Sơ đồ mồ côi (không change nào sở hữu, xem B1
                        // wp3b.yaml) — không có gì để so sánh, không toggle,
                        // không chú giải, chỉ một badge mờ báo "Nguyên bản".
                        <div className={styles.diagramBadgeRow ?? ''}>
                          <span className={styles.diagramBadgeOriginal ?? ''}>Nguyên bản</span>
                        </div>
                      )}
                      {/* Khung có CHIỀU CAO cố định: MermaidDiagram dựng viewport
                          pan/zoom bằng position:absolute inset:0, cần một tổ tiên
                          ĐÃ CÓ chiều cao mới hiện ra (giống .md-mermaid height:520px
                          của FileViewer). `.mermaidHost` không đặt height nên nếu
                          nhét thẳng MermaidDiagram vào, height:100% quy về auto → 0
                          → sơ đồ (kể cả node đã tô màu) tàng hình. Bọc trong khung
                          cao cố định như .drawioFrame để sơ đồ hiện đúng. */}
                      <div className={styles.mermaidFrame ?? ''}>
                        <MermaidDiagram code={activeDiagramCode(part)} initialFit="width" />
                      </div>
                        </Host>
                        <details className="md-mermaid__source">
                          <summary>Mermaid</summary>
                          <pre><code className="language-mermaid">{part.code}</code></pre>
                        </details>
                      </div>
                    );
                  })}
                </article>
                {/* Sơ đồ draw.io sống, portal vào host chèn NGAY SAU đoạn
                    marker (xem effect dựng drawioMounts + docblock
                    DrawioDiagramHost ở trên). */}
                {drawioMounts.map((m, i) =>
                  createPortal(
                    <DrawioDiagramHost
                      key={m.changeId}
                      projectId={projectId}
                      workflowPrefix={workflowPrefix}
                      flowId={m.flowId}
                      changeId={m.changeId}
                      diagramView={diagramView}
                      setDiagramView={setDiagramView}
                    />,
                    m.host,
                    `drawio-${i}`,
                  ),
                )}
              </div>
            {detailPanel ? (() => {
              const target = resolveAnnotationDetail(detailPanel.id, changes, notes);
              if (!target) return null;
              const isChange = target.kind === 'change';
              const id = isChange ? target.change.id : `${NOTE_ID_PREFIX}${target.note.id}`;
              const dismissed = isChange ? target.change.status === 'dismissed' : target.note.status === 'dismissed';
              return (
                <AnnotationDetailPanel
                  target={target}
                  busy={busyId === id}
                  error={errorById[id]}
                  undoable={undoableIds.has(id)}
                  dismissed={dismissed}
                  onClose={() => setDetailPanel(null)}
                  onDismiss={() => { if (isChange) void dismissChange(target.change); else void dismissNote(target.note); }}
                  onOpenRef={(ref, i) => openRefModal(`${REF_ID_PREFIX}${id}:${i}`, ref)}
                />
              );
            })() : null}
            </div>
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
              <article ref={printArticleRef} className="markdown-rendered" dangerouslySetInnerHTML={{ __html: docHtml ?? '' }} />
              <section className={styles.printAppendix}>
                <h2>Phụ lục — {modeLabel(previewMode).toLocaleLowerCase('vi')}</h2>
                <table><thead><tr><th>STT</th><th>Loại / rule</th><th>Mức độ</th><th>Thay đổi / nhận xét</th><th>Lý do</th></tr></thead><tbody>
                  {previewMode === 'changes' ? changes.map((c, i) => <tr key={`print-${c.id}`} className={c.status === 'dismissed' ? styles.printDismissed : undefined}><td>{i + 1}</td><td>{KIND_LABEL[c.kind]}{c.rule_id ? ` — ${c.rule_id}` : ''}</td><td>{SEV_LABEL[c.severity]}</td><td>{c.before ?? '—'} → {c.quote ?? '—'}{c.status === 'dismissed' ? ' (Đã bỏ)' : ''}</td><td>{c.reason}</td></tr>) : null}
                  {previewMode === 'notes' ? notes.map((n, i) => <tr key={`print-${NOTE_ID_PREFIX}${n.id}`} className={n.status === 'dismissed' ? styles.printDismissed : undefined}><td>N{i + 1}</td><td>Nhận xét — {KIND_LABEL[n.kind]}{n.rule_id ? ` — ${n.rule_id}` : ''}</td><td>{SEV_LABEL[n.severity]}</td><td>{n.finding}{n.status === 'dismissed' ? ' (Đã bỏ)' : ''}</td><td>{n.suggestion}</td></tr>) : null}
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



/** PANEL chi tiết của MỘT change/note, dựng cạnh phải cột tài liệu (không
 *  phải modal: tài liệu vẫn thấy được và giữ nguyên vị trí cuộn trong lúc đọc
 *  lý do/diff — đó là lý do quay lại right panel). Vẫn mang role="dialog"
 *  (dialog KHÔNG-modal theo ARIA) vì nó là cửa sổ nội dung đóng/mở theo cú
 *  bấm vùng bôi. Nội dung THEO PHÉP SỬA: Thêm hiện nội dung mới; Sửa hiện
 *  gốc→đề xuất; Xoá hiện đúng đoạn đề xuất bỏ (đoạn này vẫn CÒN NGUYÊN trong
 *  tài liệu, chỉ được tô/gạch ngang tại chỗ — không có văn bản nào bị ghi lại
 *  qua panel này). Note hiện phát hiện + đề xuất. `reason` (change) luôn hiện
 *  ở cuối; note không có trường lý do riêng nên không có khối này.
 *
 *  Chữ hiển thị NGUYÊN VĂN (`white-space: pre-wrap` qua class `detailPre`),
 *  KHÔNG dùng `dangerouslySetInnerHTML`: nội dung ở đây là markdown THÔ lấy
 *  thẳng từ `changes.json`/`notes.json`, chưa qua renderMarkdownToSafeHtml —
 *  dựng làm HTML sẽ vừa thừa bước vừa hiện sai cú pháp `**`/`#` còn nguyên. */
function AnnotationDetailPanel({
  target,
  busy,
  error,
  undoable,
  dismissed,
  onClose,
  onDismiss,
  onOpenRef,
}: {
  target: AnnotationDetailTarget;
  busy: boolean;
  error?: string;
  undoable: boolean;
  dismissed: boolean;
  onClose: () => void;
  onDismiss: () => void;
  /** Bấm một đoạn `doc_refs` (bằng chứng viện dẫn) trong modal — mở cửa sổ
   *  xem đoạn đó trong tài liệu (xem `openRefModal`/`refModal` ở component
   *  cha). `i` là chỉ số trong mảng `doc_refs`, khớp id mark `ref:<ownerId>:<i>`
   *  do docRender sinh ra (xem requests trong docRender). */
  onOpenRef?: (ref: string, i: number) => void;
}) {
  const c = target.kind === 'change' ? target.change : null;
  const n = target.kind === 'note' ? target.note : null;
  const op = c ? changeOp(c) : null;
  const title = c
    ? op === 'add' ? 'Thêm nội dung' : op === 'del' ? 'Đề xuất xoá' : 'Sửa nội dung'
    : 'Nhận xét';
  const ruleId = c?.rule_id ?? n?.rule_id;
  const docRefs = c?.doc_refs ?? n?.doc_refs ?? [];
  return (
    <aside className={styles.detailPanel ?? ''} role="dialog" aria-label={title}>
      <div className={styles.modalHead}>
        <div className={styles.modalTitleWrap}>
          <span className={styles.modalTitle}>{title}</span>
          {ruleId ? <span className={styles.modalQuote}>{ruleId}</span> : null}
        </div>
        <div className={styles.modalActions}>
          <button type="button" className={styles.modalClose} onClick={onClose}>
            Đóng
          </button>
        </div>
      </div>
      <div className={styles.modalBody}>
        {c ? (
          op === 'add' ? (
            <p className={styles.detailPre ?? ''}>{c.quote}</p>
          ) : op === 'del' ? (
            <p className={`${styles.detailPre ?? ''} ${styles.detailStrike ?? ''}`}>{c.before}</p>
          ) : (
            <EditDiffBlock before={c.before ?? ''} after={c.quote ?? ''} />
          )
        ) : (
          <>
            <p className={styles.detailPre ?? ''}>{n!.finding}</p>
            {n!.suggestion ? (
              <>
                <p className={styles.detailLabel ?? ''}>Đề xuất</p>
                <p className={styles.detailPre ?? ''}>{n!.suggestion}</p>
              </>
            ) : null}
          </>
        )}
        {c?.reason ? (
          <>
            <p className={styles.detailLabel ?? ''}>Lý do</p>
            <p className={styles.detailPre ?? ''}>{c.reason}</p>
          </>
        ) : null}
        {docRefs.length > 0 ? (
          <>
            <p className={styles.detailLabel ?? ''}>Bằng chứng viện dẫn</p>
            {docRefs.map((ref, i) => (
              <button key={i} type="button" onClick={() => onOpenRef?.(ref, i)}>
                {refLabel(ref)}
              </button>
            ))}
          </>
        ) : null}
        {error ? <p className={styles.error}>{error}</p> : null}
      </div>
      <div className={styles.modalActions}>
        <button type="button" disabled={busy} onClick={onDismiss}>
          {busy ? 'Đang lưu...' : dismissed ? 'Hoàn tác' : 'Bỏ'}
        </button>
      </div>
    </aside>
  );
}

/** Nguyên bản → đề xuất của một chỗ SỬA, tô riêng từ THẬT SỰ đổi (mức từ,
 *  `wordDiff`) thay vì hai khối nguyên văn — người đọc không phải tự so một
 *  câu 30 từ chỉ đổi hai từ. Cặp đoạn quá lớn (`wordDiff` trả null, xem
 *  docblock của nó) rơi về đúng hai khối cũ, vì thà xấu còn hơn không hiện
 *  được chữ nào. */
function EditDiffBlock({ before, after }: { before: string; after: string }) {
  const runs = useMemo(() => wordDiff(before, after), [before, after]);
  if (!runs) {
    return (
      <>
        <p className={styles.detailLabel ?? ''}>Nguyên bản</p>
        <p className={`${styles.detailPre ?? ''} ${styles.detailStrike ?? ''}`}>{before}</p>
        <p className={styles.detailLabel ?? ''}>Đề xuất</p>
        <p className={styles.detailPre ?? ''}>{after}</p>
      </>
    );
  }
  const RUN_CLASS = { same: styles.runSame ?? '', del: styles.runDel ?? '', add: styles.runAdd ?? '' };
  return (
    <p className={`${styles.detailPre ?? ''} ${styles.diffInline ?? ''}`}>
      {runs.map((run, i) => (
        <span key={i}>
          {i > 0 ? ' ' : null}
          <span className={RUN_CLASS[run.op]}>{run.text}</span>
        </span>
      ))}
    </p>
  );
}
