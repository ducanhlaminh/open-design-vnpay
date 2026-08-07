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
import type { ProjectFile } from '../types';
import { fetchProjectFileText } from '../providers/registry';
import { renderMarkdownToSafeHtml } from '../artifacts/markdown';
// KHÔNG import từ './FileViewer' — FileViewer đã import component này để route
// file redline, nên chiều ngược lại tạo import vòng (xem markdown-images.ts).
import { inlineMarkdownImages } from '../runtime/markdown-images';
import { injectDeletedRuns, injectHighlights, quoteSegments } from '../runtime/doc-highlight';
import { wordDiff } from '../runtime/word-diff';
import { Icon } from './Icon';
import styles from './DocRedlinePreview.module.css';

export type DocRedlineChangeKind = 'ux-writing' | 'flow' | 'gap' | 'edge-case' | 'component';
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
  status?: 'dismissed' | 'edited';
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
  | { status: 'ok'; changes: DocRedlineChange[] };

const KIND_LABEL: Record<DocRedlineChangeKind, string> = {
  'ux-writing': 'UX writing',
  flow: 'Luồng',
  gap: 'Thiếu sót',
  'edge-case': 'Trường hợp biên',
  component: 'Component',
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
export function parseDocChanges(raw: string): DocRedlineChange[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const out: DocRedlineChange[] = [];
  const seenIds = new Set<string>();
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const c = item as Record<string, unknown>;
    if (typeof c.id !== 'string' || !c.id.trim()) continue;
    if (typeof c.reason !== 'string' || !c.reason.trim()) continue;
    out.push({
      id: claimUniqueId(c.id, seenIds),
      kind: (typeof c.kind === 'string' && KIND_SET.has(c.kind) ? c.kind : 'gap') as DocRedlineChangeKind,
      severity: (typeof c.severity === 'string' && SEV_SET.has(c.severity)
        ? c.severity
        : 'minor') as DocRedlineSeverity,
      rule_id: typeof c.rule_id === 'string' && c.rule_id.trim() ? c.rule_id : undefined,
      before: typeof c.before === 'string' && c.before.trim() ? c.before : undefined,
      quote: typeof c.quote === 'string' && c.quote.trim() ? c.quote : undefined,
      anchor: typeof c.anchor === 'string' && c.anchor.trim() ? c.anchor : undefined,
      doc_refs: Array.isArray(c.doc_refs)
        ? c.doc_refs.filter((ref): ref is string => typeof ref === 'string' && !!ref.trim())
        : undefined,
      reason: c.reason,
      status: c.status === 'dismissed' || c.status === 'edited' ? c.status : undefined,
    });
  }
  return out;
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

function changeOp(c: DocRedlineChange): 'add' | 'del' | 'edit' {
  if (c.before && c.quote) return 'edit';
  if (c.quote) return 'add';
  return 'del';
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

export function DocRedlinePreview({ projectId, file }: { projectId: string; file: ProjectFile }) {
  const [editedText, setEditedText] = useState<string | null>(null);
  const [changesState, setChangesState] = useState<ChangesState>({ status: 'loading' });
  const [notes, setNotes] = useState<DocRedlineNote[]>(NO_NOTES);
  const [notesRaw, setNotesRaw] = useState<string | null>(null);
  const [changesRaw, setChangesRaw] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [errorById, setErrorById] = useState<Record<string, string>>({});
  // Chỉ những lần bỏ không đụng markdown mới được hoàn tác trong phiên này.
  const [undoableIds, setUndoableIds] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
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
      const parsed = parseDocChanges(raw);
      setChangesState(parsed == null ? { status: 'malformed' } : { status: 'ok', changes: parsed });
    });
    return () => {
      cancelled = true;
    };
  }, [projectId, file.name, file.mtime]);

  const changes = useMemo(
    () => (changesState.status === 'ok' ? changesState.changes : NO_CHANGES),
    [changesState],
  );

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
      if (c.status === 'dismissed') return [];
      const raw = (c.quote ?? '').trim();
      if (!raw) return [];
      const add = changeOp(c) === 'add';
      // Tắt tô màu KHÔNG có nghĩa là bỏ chèn mark: mark vẫn phải nằm trong DOM
      // thì thẻ bên phải mới còn neo được (bấm để nhảy) và mới không bị tụt
      // xuống nhóm "không tìm thấy trong tài liệu". Chỉ phần SƠN bị gỡ.
      const on = add ? paint.add : paint.edit;
      const className = !on ? styles.hlOff ?? '' : add ? styles.hlAdd ?? '' : styles.hl ?? '';
      const inlineStyle = !on ? HL_OFF_INLINE_STYLE : add ? HL_ADD_INLINE_STYLE : HL_INLINE_STYLE;
      return quoteSegments(raw).map((text) => ({ id: c.id, text, className, inlineStyle }));
    });
    const changePass = injectHighlights(html, requests, styles.hl ?? '', HL_INLINE_STYLE);

    // Lượt thứ hai cho NOTE, trên HTML đã bôi change: `anchor` lấy từ bản GỐC
    // nên thường vẫn còn nguyên trong bản đã sửa (note không sửa gì). Id mang
    // tiền tố `note:` để không đụng id của change — cả hai loại mark dùng
    // chung `data-change-id`, chung cơ chế click/cuộn.
    const noteRequests = notes.flatMap((n) => {
      if (n.status === 'dismissed') return [];
      const raw = (n.anchor ?? '').trim();
      if (!raw) return [];
      return quoteSegments(raw).map((text) => ({
        id: `${NOTE_ID_PREFIX}${n.id}`,
        text,
        className: paint.note ? styles.hlNote ?? '' : styles.hlOff ?? '',
        inlineStyle: paint.note ? NOTE_HL_INLINE_STYLE : HL_OFF_INLINE_STYLE,
      }));
    });
    const notePass = injectHighlights(changePass.html, noteRequests, styles.hlNote ?? '', NOTE_HL_INLINE_STYLE);

    // Lượt thứ BA: chỗ xoá thuần. Chạy CUỐI cùng vì nó thêm chữ mới vào tài
    // liệu (đoạn đã bị xoá) — chạy trước thì hai lượt kia phải dò qua chữ không
    // thuộc bản đã sửa và có thể khớp bừa vào đó.
    const delRequests = changes.flatMap((c) => {
      if (c.status === 'dismissed') return [];
      if (changeOp(c) !== 'del') return [];
      // `anchor` là nguyên văn mã nguồn markdown, y như `quote`, nên phải cắt
      // qua quoteSegments. Lấy segment ĐẦU: một chỗ xoá chỉ cần một điểm neo,
      // và segment đầu là chỗ gần nhất với vị trí đoạn bị xoá.
      const seg = quoteSegments((c.anchor ?? '').trim())[0];
      if (!seg || !c.before) return [];
      return [{ id: c.id, anchor: seg, text: c.before }];
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
      ...changes.flatMap((c) =>
        (c.doc_refs ?? []).flatMap((ref, i) =>
          quoteSegments(ref.trim()).slice(0, 1).map((text) => ({
            id: `${REF_ID_PREFIX}${c.id}:${i}`,
            text,
            className: styles.hlRef ?? '',
            inlineStyle: HL_REF_INLINE_STYLE,
          })),
        ),
      ),
      ...notes.flatMap((n) =>
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
    };
  }, [editedText, projectId, file.name, changes, notes, paint]);

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
  }, [docHtml, changesState]);

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

  /** Bấm một mục trong rail: cuộn tài liệu tới vùng bôi đầu tiên của change đó
   *  và nháy sáng mọi mark của nó. */
  function selectFromList(id: string) {
    setSelectedId(id);
    const marks = marksByChangeRef.current.get(id);
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
    setSelectedId(ownerId);
    const item = itemsByChangeRef.current.get(ownerId);
    // `block: 'nearest'` để rail chỉ trượt tối thiểu — mục đã ở trong tầm nhìn
    // thì không nhảy. `behavior: 'auto'` cùng lý do như trên.
    item?.scrollIntoView({ block: 'nearest', behavior: 'auto' });
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
  async function saveAction(id: string, action: () => { text?: string; changes?: DocRedlineChange[]; notes?: DocRedlineNote[]; changedMd: boolean }) {
    if (busyId) return;
    setBusyId(id); setErrorById((prev) => ({ ...prev, [id]: '' }));
    const beforeChanges = changesState; const beforeNotes = notes; const beforeText = editedText;
    try {
      const result = action();
      const writes: Array<[string, string]> = [];
      if (result.changedMd && result.text != null) writes.push([file.name, result.text]);
      if (result.changes) writes.push([file.name.replace(/\.md$/i, '.changes.json'), JSON.stringify(result.changes, null, 2)]);
      if (result.notes) writes.push([file.name.replace(/\.md$/i, '.notes.json'), JSON.stringify(result.notes, null, 2)]);
      for (const [name, content] of writes) {
        const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/files`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, content }) });
        if (!response.ok) throw new Error('Không ghi được file');
      }
      if (result.text != null) setEditedText(result.text);
      if (result.changes) { setChangesRaw(JSON.stringify(result.changes)); setChangesState({ status: 'ok', changes: result.changes }); }
      if (result.notes) { setNotesRaw(JSON.stringify(result.notes)); setNotes(result.notes); }
      setEditingId(null);
    } catch (error) { setChangesState(beforeChanges); setNotes(beforeNotes); setEditedText(beforeText); setErrorById((prev) => ({ ...prev, [id]: error instanceof Error ? error.message : 'Lỗi ghi file' })); }
    finally { setBusyId(null); }
  }

  function updateChange(c: DocRedlineChange, next: Partial<DocRedlineChange>, changedMd: boolean, text?: string) {
    const list = changes.map((item) => item.id === c.id ? { ...item, ...next } : item);
    return { changes: list, changedMd, text };
  }

  async function editChange(c: DocRedlineChange) {
    const next = editDocText(editedText ?? '', c.quote ?? '', editText);
    if (next == null) throw new Error('Không tìm thấy vùng sửa trong tài liệu');
    await saveAction(c.id, () => updateChange(c, { quote: editText, status: 'edited' }, true, next));
  }

  async function dismissChange(c: DocRedlineChange) {
    if (c.status === 'dismissed') {
      if (!undoableIds.has(c.id)) return;
      await saveAction(c.id, () => updateChange(c, { status: undefined }, false, editedText ?? undefined));
      setUndoableIds((prev) => { const next = new Set(prev); next.delete(c.id); return next; });
      return;
    }
    const changedMd = Boolean(c.quote || c.before);
    const next = changedMd ? revertDocText(editedText ?? '', c) : editedText;
    if (changedMd && next == null) throw new Error(c.before && !c.quote ? 'Không tìm thấy anchor duy nhất để chèn lại.' : 'Không tìm thấy vùng sửa trong tài liệu');
    await saveAction(c.id, () => updateChange(c, { status: 'dismissed' }, changedMd, next ?? undefined));
    if (!changedMd) setUndoableIds((prev) => new Set(prev).add(c.id));
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

  const isAnchored = (c: DocRedlineChange) => anchored.has(c.id);

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
                  {opCounts.edit} sửa · {opCounts.add} thêm · {opCounts.del} xoá · {notes.filter((n) => n.status !== 'dismissed').length} nhận xét · {changes.filter((c) => c.status === 'dismissed').length + notes.filter((n) => n.status === 'dismissed').length} đã bỏ ·{' '}
                  {markCount} vùng bôi
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
                <HighlightFilters
                  paint={paint}
                  onChange={setPaintKind}
                  counts={{ add: opCounts.add, edit: opCounts.edit, del: opCounts.del, note: notes.filter((n) => n.status !== 'dismissed').length }}
                />
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
            <div className={styles.grid}>
              <div className={styles.docCol} ref={docColRef}>
                {/* Safe by contract: renderMarkdownToSafeHtml escapes raw HTML
                    and rejects unsafe link protocols. */}
                <article className="markdown-rendered" dangerouslySetInnerHTML={{ __html: docHtml ?? '' }} />
              </div>
              <div className={styles.rail}>
                {changes.length === 0 && notes.length === 0 ? (
                  <p className={styles.empty}>Không có chỗ sửa nào.</p>
                ) : (
                  <>
                    {changes.map((c, changeIdx) => {
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
                        busy={busyId === c.id} error={errorById[c.id]} showActions={isAnchored(c)} undoable={undoableIds.has(c.id)} editing={editingId === c.id} editText={editText} onEditText={setEditText} onEdit={() => { setEditingId(c.id); setEditText(c.quote ?? ''); }} onSaveEdit={() => { if (!editText.trim()) { setErrorById((p) => ({ ...p, [c.id]: 'Nội dung sửa không được để trống' })); return; } void editChange(c); }} onCancelEdit={() => setEditingId(null)} onDismiss={() => { if (c.status === 'dismissed') { void dismissChange(c); } else if (window.confirm('Hành động này sẽ sửa tài liệu và không thể hoàn tác trong phiên. Tiếp tục?')) void dismissChange(c); }}
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
                  })}
                    {notes.length > 0 ? (
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
                <p>{opCounts.edit + opCounts.add + opCounts.del} chỗ sửa còn hiệu lực · {notes.filter((n) => n.status !== 'dismissed').length} nhận xét còn hiệu lực · {changes.filter((c) => c.status === 'dismissed').length + notes.filter((n) => n.status === 'dismissed').length} đã bỏ</p>
              </section>
              {/* Safe by contract: renderMarkdownToSafeHtml escapes raw HTML. */}
              <article className="markdown-rendered" dangerouslySetInnerHTML={{ __html: docHtml ?? '' }} />
              <section className={styles.printAppendix}>
                <h2>Phụ lục — các chỗ review</h2>
                <table><thead><tr><th>STT</th><th>Loại / rule</th><th>Mức độ</th><th>Thay đổi / nhận xét</th><th>Lý do</th></tr></thead><tbody>
                  {changes.map((c, i) => <tr key={`print-${c.id}`} className={c.status === 'dismissed' ? styles.printDismissed : undefined}><td>{i + 1}</td><td>{KIND_LABEL[c.kind]}{c.rule_id ? ` — ${ruleChipMeta(c.rule_id).label}` : ''}</td><td>{SEV_LABEL[c.severity]}</td><td>{c.before ?? '—'} → {c.quote ?? '—'}{c.status === 'dismissed' ? ' (Đã bỏ)' : ''}</td><td>{c.reason}</td></tr>)}
                  {notes.map((n, i) => <tr key={`print-${NOTE_ID_PREFIX}${n.id}`} className={n.status === 'dismissed' ? styles.printDismissed : undefined}><td>N{i + 1}</td><td>Nhận xét — {KIND_LABEL[n.kind]}{n.rule_id ? ` — ${ruleChipMeta(n.rule_id).label}` : ''}</td><td>{SEV_LABEL[n.severity]}</td><td>{n.finding}{n.status === 'dismissed' ? ' (Đã bỏ)' : ''}</td><td>{n.suggestion}</td></tr>)}
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
                <HighlightFilters paint={paint} onChange={setPaintKind} />
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
}: {
  paint: PaintFlags;
  onChange: (kind: PaintKind, next: boolean) => void;
  counts?: Partial<Record<PaintKind, number>>;
}) {
  return (
    <div className={styles.filters} role="group" aria-label="Hiện tô màu theo loại">
      {/* Không có dòng này thì bốn chip màu đọc như một chú thích tĩnh — người
          dùng không có lý do nào để thử bấm vào chúng. */}
      <span className={styles.filtersHint}>Bấm để ẩn/hiện:</span>
      {PAINT_ITEMS.map(({ kind, label, swatch }) => {
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

/** Một khối chi tiết của một change: nhóm, mức độ, rule_id, lý do, và phần
 *  chữ cũ/chữ mới tuỳ theo phép sửa. Đây là nơi trường `before` (chữ cũ) tiếp
 *  tục sống sau khi cột tài liệu gốc bị bỏ. */
function ChangeDetail({ change: c, idx, ruleOpen, ruleBody, onToggleRule, isRefAnchored, onJumpRef, busy, error, showActions, undoable, editing, editText, onEditText, onEdit, onSaveEdit, onCancelEdit, onDismiss }: { change: DocRedlineChange; idx?: string; showActions: boolean; undoable?: boolean; editing: boolean; editText: string; onEditText: (value: string) => void; onEdit: () => void; onSaveEdit: () => void; onCancelEdit: () => void; onDismiss: () => void } & RefProps) {
  const op = changeOp(c);
  return (
    <div className={`${styles.card} ${SEV_CLASS[c.severity]} ${c.status === 'dismissed' ? styles.dismissed : ''}`}>
      <div className={styles.cardHead}>
        {idx ? <span className={styles.cardIdx}>{idx}</span> : null}
        <span className={styles.cardKind}>{KIND_LABEL[c.kind]}</span>
        <span className={styles.sevBadge}>{SEV_LABEL[c.severity]}</span>{c.status === 'dismissed' ? <span className={styles.badgeDeleted}>Đã bỏ</span> : c.status === 'edited' ? <span className={styles.badgeEdited}>Đã sửa tay</span> : null}
      </div>
      {c.rule_id ? <RuleChip ruleId={c.rule_id} open={ruleOpen} body={ruleBody} onToggle={onToggleRule} /> : null}
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
      {showActions && (editing ? <div className={styles.editBox}><textarea value={editText} onChange={(ev) => onEditText(ev.target.value)} aria-label="Nội dung sửa" /><div className={styles.actions}><button type="button" disabled={busy} onClick={(ev) => { ev.stopPropagation(); onSaveEdit(); }}>Lưu</button><button type="button" disabled={busy} onClick={(ev) => { ev.stopPropagation(); onCancelEdit(); }}>Hủy</button></div></div> : <div className={styles.actions}><button type="button" disabled={busy || c.status === 'dismissed'} onClick={(ev) => { ev.stopPropagation(); onEdit(); }}>Sửa</button><button type="button" disabled={busy || (c.status !== 'dismissed' && c.before != null && c.quote == null && !c.anchor)} title={c.status !== 'dismissed' && c.before != null && c.quote == null && !c.anchor ? 'Không có anchor duy nhất để chèn lại' : undefined} onClick={(ev) => { ev.stopPropagation(); onDismiss(); }}>{c.status === 'dismissed' && undoable ? 'Hoàn tác' : 'Bỏ chỗ sửa'}</button>{c.status === 'dismissed' ? <span className={styles.badgeDeleted}>Đã bỏ</span> : null}</div>)}
      {showActions && (error ? <p className={styles.error}>{error}</p> : null)}
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
