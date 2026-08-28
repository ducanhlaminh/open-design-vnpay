// Khung nhìn "Đánh giá luồng UX" (bước dr-flow bản mới của docs-review) cho
// các file dưới `flows/<FLOW-ID>/`: sơ đồ GỐC render bằng đúng viewer của
// draw.io (hoặc Mermaid), Nguyên bản và Cải thiện (phần sửa đã được daemon tô
// màu theo chú giải cố định) hiện CẠNH NHAU mặc định để đối chiếu (chế độ
// "Từng bản" quay lại kiểu tab cũ khi cần phóng to một bản), và panel lý do
// UX bên phải — bấm một finding thì cell liên quan sáng lên trên sơ đồ, bấm
// một cell thì finding tương ứng được chọn.
//
// wp17a.yaml (2026-08-20): người dùng duyệt là phải đối chiếu 2 bản cùng lúc
// thay vì nhớ-rồi-bấm-qua-lại. Hai khung KHÔNG đồng bộ pan/zoom — layout 2
// bản lệch nhau vì node thêm/bớt (không có toạ độ chung để đồng bộ theo), và
// GraphViewer không lộ API pan/zoom ra ngoài để làm chuyện đó dù muốn; đồng bộ
// duy nhất là qua finding (mỗi khung tự highlight + tự cuộn tới cell của nó).
// Toàn màn hình dùng CSS overlay (position:fixed) tự làm, KHÔNG dùng
// Fullscreen API (jsdom không có, hay trục trặc khi phần tử nằm trong dialog)
// và KHÔNG dùng lightbox của GraphViewer (2 kiểu fullscreen cạnh tranh) — vì
// vậy mọi <DrawioViewer> ở đây đều truyền `options={VIEWER_OPTIONS}` để
// bỏ nút lightbox, qua đúng prop `options` sẵn có (không sửa DrawioViewer.tsx
// — nó còn được nơi khác dùng).
//
// wp18.yaml (fix bug 0.8.78): overlay TRƯỚC ĐÂY gắn class `fullscreen` tại
// chỗ lên root — root nằm sâu trong DOM workspace/modal, và nhiều tổ tiên có
// transform/backdrop-filter (pipelines.css) là CONTAINING BLOCK của
// position:fixed theo spec CSS ⇒ inset:0 neo theo tổ tiên đó chứ không theo
// viewport ⇒ overlay lệch + tràn. Sửa bằng `createPortal` lên
// `document.body`: portal thoát mọi tổ tiên transform nên fixed neo đúng
// viewport, giống hệt cách lightbox draw.io/hầu hết modal thật vẫn làm.
// GraphViewer đo kích thước container LÚC MOUNT để auto-fit; nếu mount cùng
// lúc với việc overlay vừa gắn (chưa kịp layout) thì đo sai (sơ đồ bé tí +
// khoảng trắng khổng lồ) — nên overlay hiện placeholder "Đang tải…" và chỉ
// mount viewer thật SAU một (hai, cho chắc) khung `requestAnimationFrame`
// (state `fsReady`), để browser kịp flush layout của overlay trước khi
// GraphViewer đo. Khoá `document.body.style.overflow` khi overlay mở (khôi
// phục khi đóng/unmount) vì overlay giờ là anh em của toàn bộ trang, không
// còn nằm trong khung cuộn cũ để tự nhiên chặn cuộn trang phía sau.
//
// Dữ liệu (đều là output của daemon `finalizeFlowUx`, KHÔNG phải của LLM
// trực tiếp): `ux-review.json` (đã chuẩn hoá), `proposed.drawio` (2 trang:
// Nguyên bản | Cải thiện) hoặc `as-is.drawio`, `as-is.mmd` / `proposed.mmd` /
// `as-is.svg` cho Mermaid, và `flows/index.json` cho tiêu đề + patchSkipped.
//
// WP dr-flow-improve (2026-08-27): bước "Cải thiện luồng" (dr-flow-improve)
// sinh bản cải thiện cho SCREEN-FLOW theo đúng cơ chế proposed.drawio 2 trang
// ở trên. Nhãn hai bản đổi thành "Nguyên bản" | "Cải thiện"; khối chọn bản ở
// đầu right panel (`Dùng bản để chạy tiếp`, PUT …/screen-flow/selection) quyết
// định bản nào các bước sau (dr-comp…) dùng — trạng thái ban đầu đọc từ
// `index.json[].selection` do daemon ghi; panel có thêm chế độ "Theo phần tử"
// (gom `<object od-change od-finding>` ở trang 1 thành Thêm mới / Sửa đổi /
// Đề nghị bỏ kèm lý do finding); và editor draw.io nhúng nay sửa được cả 2
// trang (draw.io embed tự có tab trang) — lưu như cũ, daemon tự nhận 2 trang.
//
// WP dr-flow-result-split (2026-08-27): chế độ theo FILE MỞ. Quick result của
// dr-flow mở `as-is.drawio` → `presentation = 'original'`: CHỈ sơ đồ nguyên bản
// (không tải proposed.drawio / ux-review.json — kể cả khi có trên đĩa, vì đó
// là file của bước dr-flow-improve), không tab Cải thiện, không chọn bản,
// không right panel; giữ Chỉnh sửa / Tải / Toàn màn hình / tab Danh sách màn.
// Mở `ux-review.json` (Quick result dr-flow-improve) → `'compare'` như cũ,
// cộng: mặc định (chưa chọn finding) khung Cải thiện viền mọi cell có
// `od-change` (tập `changed`, tái dùng parseProposedElements) và khung Nguyên
// bản viền hợp `findings[].cells.asIs`; nút "Chỉ xem thay đổi" làm mờ cell
// không đổi qua prop `dimCellsExcept` của DrawioViewer; badge "N thay đổi ·
// a thêm · b sửa · c bỏ" trên tab/tiêu đề khung Cải thiện.
//
// WP dr-flow-edit-highlight (2026-08-27): (1) "Chỉnh sửa" mở editor ĐÚNG trang
// đang xem (`page`/`pageName` của DrawioEditor, key theo trang → đổi tab
// Nguyên bản/Cải thiện trong lúc sửa thì remount đúng trang, bản chờ lưu được
// đẩy đi lúc unmount); sửa trang Cải thiện có dòng nhắc `.editHint`. (2) Viền
// thay đổi THEO LOẠI (`{ id, kind }` → HIGHLIGHT_KIND_STYLE, khớp CHANGE_STYLE
// daemon: viền màu riêng, không fill); "Chỉ xem thay đổi" mặc định BẬT khi có
// bản Cải thiện có thay đổi; legend CSS cùng màu viền.

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { ProjectFile } from '../types';

import { fetchProjectFileText } from '../providers/registry';
import { DrawioEditor } from './DrawioEditor';
import { DrawioViewer, type HighlightSpec } from './DrawioViewer';
import { MermaidDiagram } from './MermaidDiagram';
import { ScreensDiscoveredPreview, isScreensDiscoveredDoc, type ScreensDiscoveredDoc } from './ScreensDiscoveredPreview';
import { SCREEN_FLOW_ID, isScreenFlowId, screenFlowPlatformLabel, screenFlowPlatformOf, type ScreenFlowPlatform } from './screen-flow-ids';
import styles from './FlowUxReviewPreview.module.css';

export type UxSeverity = 'blocker' | 'major' | 'minor' | 'note';
export type UxVerdict = 'good' | 'needs-improvement' | 'poor';
export type UxChange = 'added' | 'modified' | 'removed' | 'none';

export interface UxFinding {
  id: string;
  severity: UxSeverity;
  heuristic?: string;
  title: string;
  reason: string;
  recommendation?: string;
  evidence?: string[];
  cells?: { asIs?: string[]; proposed?: string[] };
  change?: UxChange;
  conflictsWith?: string;
}
export interface UxReview {
  flowId: string;
  verdict: UxVerdict;
  summary: string;
  findings: UxFinding[];
}

/** Bản đang được chọn để chạy tiếp (WP dr-flow-improve, contract
 *  `selection.json`): `original` = Nguyên bản (mặc định khi không có file),
 *  `improved` = Cải thiện. */
export type FlowVariant = 'original' | 'improved';

interface IndexEntry {
  id: string;
  title?: string;
  source?: string;
  kind?: 'drawio' | 'mermaid' | 'text';
  note?: string;
  hasProposal?: boolean;
  files?: { asIs?: string; proposed?: string; review?: string; flowchart?: string; svg?: string };
  patchSkipped?: { op: { op?: string; cell?: string; id?: string; edge?: string }; reason: string }[];
  /** Daemon `finalizeFlowUx` ghi bản đang dùng vào entry (WP-B B3). */
  variant?: FlowVariant;
  selection?: { variant?: FlowVariant; source?: 'user' | 'run-all' };
  /** WP screen-flow-platform-split: flow tách theo nền tảng (`SCREEN-FLOW--app`
   *  / `--web`) mang `platform`; flow đơn không có field. Khai local — web
   *  không kéo type contract cho field này. */
  platform?: ScreenFlowPlatform;
}

/** Một phần tử (node/cạnh) của trang Cải thiện đã Thêm/Sửa/Bỏ — panel "Theo
 *  phần tử" (WP dr-flow-improve mục 3). */
export interface ProposedElement {
  id: string;
  label: string;
  change: Exclude<UxChange, 'none'>;
  kind: 'node' | 'edge';
  findingId: string | null;
}

const CHANGE_ORDER: Exclude<UxChange, 'none'>[] = ['added', 'modified', 'removed'];
const ELEMENT_KIND_LABEL: Record<ProposedElement['kind'], string> = { node: 'Node', edge: 'Cạnh' };

function isLegendCellId(id: string): boolean {
  return /^od-legend-/i.test(id);
}

/** Nhãn cell draw.io có thể là HTML (`<br>`, `<b>`) — lấy phần chữ thuần. */
function plainCellLabel(raw: string): string {
  return raw
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Gom phần tử đã Thêm/Sửa/Bỏ ở TRANG 1 (Cải thiện) của mxfile `proposed.drawio`:
 *  - `<object od-change od-finding>` (daemon `stampChange`/`addNode`/`addEdge`
 *    bọc) → đúng loại + finding gắn trên wrapper;
 *  - cell thường được `findings[].cells.proposed` nhắc mà chưa có wrapper →
 *    loại theo `finding.change` (mặc định Sửa đổi), finding = finding đó.
 *  Bỏ qua chú giải `od-legend-*`. `unreadable` = trang 1 không đọc được (XML
 *  hỏng hoặc nội dung nén — draw.io lưu nén thì không có DOM để duyệt). */
export function parseProposedElements(xml: string, findings: readonly UxFinding[]): { elements: ProposedElement[]; unreadable: boolean } {
  if (typeof DOMParser === 'undefined') return { elements: [], unreadable: true };
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(xml, 'text/xml');
  } catch {
    return { elements: [], unreadable: true };
  }
  if (doc.getElementsByTagName('parsererror').length) return { elements: [], unreadable: true };
  const page = Array.from(doc.getElementsByTagName('diagram'))[1];
  if (!page) return { elements: [], unreadable: false };
  const model = page.firstElementChild; // <mxGraphModel> — nén thì chỉ có text, không có con.
  if (!model) return { elements: [], unreadable: true };

  // id → phần tử đầu tiên mang id đó theo thứ tự tài liệu (wrapper <object>
  // đứng trước mxCell con của nó; mxCell trần thì chính nó).
  const byId = new Map<string, Element>();
  for (const el of Array.from(model.getElementsByTagName('*'))) {
    const id = el.getAttribute('id');
    if (id && !byId.has(id)) byId.set(id, el);
  }
  const cellOf = (el: Element): Element | null => (el.tagName === 'mxCell' ? el : el.getElementsByTagName('mxCell')[0] ?? null);
  const labelOf = (el: Element): string => {
    const wrapperLabel = el.tagName === 'mxCell' ? null : el.getAttribute('label');
    return plainCellLabel(wrapperLabel ?? cellOf(el)?.getAttribute('value') ?? '');
  };
  const kindOf = (el: Element): ProposedElement['kind'] => (cellOf(el)?.getAttribute('edge') === '1' ? 'edge' : 'node');
  const isChange = (v: string | null): v is Exclude<UxChange, 'none'> => v === 'added' || v === 'modified' || v === 'removed';

  const elements: ProposedElement[] = [];
  const seen = new Set<string>();
  for (const el of Array.from(model.querySelectorAll('[od-change]'))) {
    const id = el.getAttribute('id') ?? '';
    const change = el.getAttribute('od-change');
    if (!id || seen.has(id) || isLegendCellId(id) || !isChange(change)) continue;
    seen.add(id);
    elements.push({ id, label: labelOf(el) || id, change, kind: kindOf(el), findingId: el.getAttribute('od-finding') || null });
  }
  for (const f of findings) {
    for (const id of f.cells?.proposed ?? []) {
      if (seen.has(id) || isLegendCellId(id)) continue;
      const el = byId.get(id);
      if (!el) continue;
      seen.add(id);
      elements.push({ id, label: labelOf(el) || id, change: f.change && f.change !== 'none' ? f.change : 'modified', kind: kindOf(el), findingId: f.id });
    }
  }
  return { elements, unreadable: false };
}

// Một object ổn định cho mọi <DrawioViewer> (bỏ nút lightbox — xem docblock
// đầu file). Literal inline là object mới mỗi render → DrawioViewer recreate
// viewer → mất cuộn/zoom mỗi lần rail poll file (xem DrawioViewer optionsKey).
const VIEWER_OPTIONS = { toolbar: 'zoom' } as const;

const SEVERITY_ORDER: UxSeverity[] = ['blocker', 'major', 'minor', 'note'];
// SEVERITY_LABEL/CHANGE_LABEL export cho DocRedlinePreview: panel chi tiết của
// change sơ đồ (dr-review) liệt kê cùng các finding này — một bộ nhãn, hai chỗ
// hiện, không được lệch chữ.
export const SEVERITY_LABEL: Record<UxSeverity, string> = { blocker: 'Chặn', major: 'Nặng', minor: 'Nhẹ', note: 'Ghi chú' };
const VERDICT_LABEL: Record<UxVerdict, string> = { good: 'Luồng tốt', 'needs-improvement': 'Cần cải thiện', poor: 'Chưa đạt' };
export const CHANGE_LABEL: Record<Exclude<UxChange, 'none'>, string> = { added: 'Thêm mới', modified: 'Sửa đổi', removed: 'Đề nghị bỏ' };

const FLOW_FILE_RE = /^(.*?)flows\/([^/]+)\/(ux-review\.json|proposed\.drawio|as-is\.drawio|proposed\.mmd|as-is\.mmd|as-is\.svg|patch\.json|screens\.json|cells\.json)$/i;
/** `flows/<FLOW-ID>.flowchart.json` — the derived block diagram; opens the same
 *  view when the new-format folder exists, else the caller's `fallback`. */
const FLOWCHART_FILE_RE = /^(.*?)flows\/([^/]+)\.flowchart\.json$/i;

/** Chế độ khung theo file mở (WP dr-flow-result-split): `original` = chỉ sơ đồ
 *  nguyên bản (mở từ `as-is.drawio`), `compare` = Nguyên bản | Cải thiện + panel
 *  (mọi file khác: ux-review.json, proposed.drawio, …). */
export type FlowPresentation = 'original' | 'compare';
export function flowPresentationOf(fileName: string): FlowPresentation {
  return /as-is\.drawio$/i.test(fileName) ? 'original' : 'compare';
}

/** File thuộc `flows/<FLOW-ID>/…` (artefact của bước Đánh giá luồng UX). */
export function isFlowUxFile(file: Pick<ProjectFile, 'name'>): boolean {
  return FLOW_FILE_RE.test(file.name) || FLOWCHART_FILE_RE.test(file.name);
}

/** `flows/<id>/x.json` → `{ dir: '<prefix>flows/<id>/', flowsDir: '<prefix>flows/', flowId }`. */
export function flowUxLocationOf(fileName: string): { dir: string; flowsDir: string; flowId: string } | null {
  const m = FLOW_FILE_RE.exec(fileName) ?? FLOWCHART_FILE_RE.exec(fileName);
  if (!m) return null;
  return { dir: `${m[1]}flows/${m[2]}/`, flowsDir: `${m[1]}flows/`, flowId: m[2]! };
}

/** Đọc `ux-review.json` khoan dung: finding hỏng bị bỏ, không làm sập khung. */
export function parseUxReview(raw: string, flowId: string): UxReview | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const o = parsed as Record<string, unknown>;
  const findings: UxFinding[] = [];
  const list = Array.isArray(o.findings) ? o.findings : [];
  list.forEach((f, i) => {
    if (!f || typeof f !== 'object') return;
    const x = f as Record<string, unknown>;
    const title = typeof x.title === 'string' ? x.title : '';
    const reason = typeof x.reason === 'string' ? x.reason : '';
    if (!title && !reason) return;
    const strList = (v: unknown) => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : undefined);
    const cellsRaw = x.cells && typeof x.cells === 'object' ? (x.cells as Record<string, unknown>) : {};
    const asIs = strList(cellsRaw.asIs);
    const proposed = strList(cellsRaw.proposed);
    const finding: UxFinding = {
      id: typeof x.id === 'string' && x.id ? x.id : `UX-${String(i + 1).padStart(2, '0')}`,
      severity: SEVERITY_ORDER.includes(x.severity as UxSeverity) ? (x.severity as UxSeverity) : 'minor',
      title: title || reason.slice(0, 80),
      reason,
    };
    if (typeof x.heuristic === 'string') finding.heuristic = x.heuristic;
    if (typeof x.recommendation === 'string') finding.recommendation = x.recommendation;
    const ev = strList(x.evidence);
    if (ev?.length) finding.evidence = ev;
    if (asIs?.length || proposed?.length) finding.cells = { ...(asIs?.length ? { asIs } : {}), ...(proposed?.length ? { proposed } : {}) };
    if (typeof x.change === 'string' && ['added', 'modified', 'removed', 'none'].includes(x.change)) finding.change = x.change as UxChange;
    if (typeof x.conflictsWith === 'string') finding.conflictsWith = x.conflictsWith;
    findings.push(finding);
  });
  const verdict = (['good', 'needs-improvement', 'poor'] as UxVerdict[]).includes(o.verdict as UxVerdict)
    ? (o.verdict as UxVerdict)
    : findings.some((f) => f.severity === 'blocker')
      ? 'poor'
      : findings.length
        ? 'needs-improvement'
        : 'good';
  return {
    flowId: typeof o.flowId === 'string' && o.flowId ? o.flowId : flowId,
    verdict,
    summary: typeof o.summary === 'string' ? o.summary : '',
    findings,
  };
}

function parseIndexEntry(raw: string | null, flowId: string): IndexEntry | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    const list = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' && Array.isArray((parsed as { flows?: unknown }).flows) ? ((parsed as { flows: unknown[] }).flows) : [];
    const hit = list.find((e) => e && typeof e === 'object' && (e as { id?: unknown }).id === flowId);
    return (hit as IndexEntry | undefined) ?? null;
  } catch {
    return null;
  }
}

/** Số trang trong một mxfile (`<diagram …>` đếm được). */
export function drawioPageCount(xml: string): number {
  return (xml.match(/<diagram\b/gi) ?? []).length || 1;
}

/** Tên các trang (`<diagram name="…">`) theo thứ tự trong mxfile — trang không
 *  có `name` giữ chỗ bằng chuỗi rỗng (caller tự fallback). Regex thuần, không
 *  DOMParser: chỉ cần tên để hiện chip "Đang sửa: <trang>". */
export function drawioPageNames(xml: string): string[] {
  const out: string[] = [];
  const re = /<diagram\b([^>]*)>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const name = /\bname="([^"]*)"/i.exec(m[1] ?? '');
    out.push(name?.[1] ?? '');
  }
  return out;
}

/** Cắt `s` ở RANH GIỚI TỪ gần nhất ≤ `max` ký tự, nối thêm '…' khi có cắt —
 *  dùng cho dòng tóm tắt trên mặt thẻ finding (wp-flowux-panel-compact). */
function truncateAtWordBoundary(s: string, max: number): string {
  if (s.length <= max) return s;
  const slice = s.slice(0, max);
  const lastSpace = slice.lastIndexOf(' ');
  const cut = lastSpace > 0 ? slice.slice(0, lastSpace) : slice;
  return `${cut}…`;
}

/** Rút gọn một mục evidence để hiện trong khối "Chi tiết" (path docs-feature/
 *  ... thật dài không có chỗ trên mặt thẻ, và ngay cả trong Chi tiết vẫn nên
 *  gọn — bản đầy đủ luôn còn ở attr `title`):
 *  - `<đường/dẫn>/<file>.md#<mục>` → `<file> #<mục>` (bỏ thư mục, bỏ đuôi
 *    .md; phần mục giữ nguyên cả khoảng trắng).
 *  - Path có '/' không có '#' → basename (bỏ đuôi .md nếu có).
 *  - Chuỗi thường không có '/' (vd `cell G_Int`) → trả nguyên văn. */
export function evidenceLabel(e: string): string {
  if (!e.includes('/')) return e;
  const hashIdx = e.indexOf('#');
  if (hashIdx < 0) {
    const base = e.split('/').pop() ?? e;
    return base.replace(/\.md$/i, '');
  }
  const pathPart = e.slice(0, hashIdx);
  const anchor = e.slice(hashIdx + 1);
  const base = pathPart.split('/').pop() ?? pathPart;
  const fileName = base.replace(/\.md$/i, '');
  return `${fileName} #${anchor}`;
}

type ViewMode = 'as-is' | 'proposed' | 'svg';
/** Bố cục khung sơ đồ: 'side' = Hiện trạng/Đề xuất cạnh nhau (mặc định khi có
 *  đề xuất), 'single' = kiểu tab cũ (as-is/proposed/svg đổi qua lại). */
type LayoutMode = 'side' | 'single';

const LAYOUT_STORAGE_KEY = 'od.flowUx.layout';
/** Đọc bố cục đã lưu, khoan dung với localStorage bị chặn (chế độ riêng tư,
 *  iframe sandbox) — rơi về mặc định thay vì vỡ màn hình. */
function readStoredLayout(fallback: LayoutMode): LayoutMode {
  try {
    const saved = window.localStorage.getItem(LAYOUT_STORAGE_KEY);
    if (saved === 'side' || saved === 'single') return saved;
  } catch {
    // xem lý do ở trên.
  }
  return fallback;
}
function writeStoredLayout(v: LayoutMode): void {
  try {
    window.localStorage.setItem(LAYOUT_STORAGE_KEY, v);
  } catch {
    // Ghi thất bại thì layout vẫn đổi trong phiên này, chỉ không nhớ được qua
    // lần tải lại — cùng đánh đổi như panel bên dưới.
  }
}

const PANEL_STORAGE_KEY = 'od.flowUx.panel';
function readStoredPanelOpen(fallback: boolean): boolean {
  try {
    const saved = window.localStorage.getItem(PANEL_STORAGE_KEY);
    if (saved === '1') return true;
    if (saved === '0') return false;
  } catch {
    // xem lý do ở readStoredLayout.
  }
  return fallback;
}
function writeStoredPanelOpen(open: boolean): void {
  try {
    window.localStorage.setItem(PANEL_STORAGE_KEY, open ? '1' : '0');
  } catch {
    // xem lý do ở readStoredLayout.
  }
}

/** Trạng thái tải lười của tab "Danh sách màn" (SCREEN-FLOW). */
type ScreensLoad = { status: 'idle' } | { status: 'loading' } | { status: 'missing' } | { status: 'ok'; doc: ScreensDiscoveredDoc };

/** Tab "Danh sách màn" của flow tách nền tảng chỉ hiện màn của nền tảng đó
 *  (`screens-discovered.json` = HỢP các flow, mỗi màn mang `platform`). Màn
 *  KHÔNG có `platform` hiện ở cả hai; trang không còn màn nào bị bỏ. Flow đơn
 *  (`platform` null) → trả nguyên doc (byte-identical). */
export function filterScreensByPlatform(doc: ScreensDiscoveredDoc, platform: ScreenFlowPlatform | null): ScreensDiscoveredDoc {
  if (!platform) return doc;
  const pages = doc.pages
    .map((page) => ({ ...page, screens: page.screens.filter((s) => !s.platform || s.platform === platform) }))
    .filter((page) => page.screens.length > 0);
  return { ...doc, pages };
}

/** URL route daemon `…/docs-review/screen-flow[/selection]` cho flow: flow đơn
 *  `SCREEN-FLOW` giữ URL/body y hệt trước (daemon tự chọn flow duy nhất);
 *  flow tách gửi `?flowId=` + `flowId` trong body (hợp đồng WP screen-flow-
 *  platform-split — thiếu flowId khi có 2 flow daemon trả 400). */
export function screenFlowApiUrl(projectId: string, flowId: string, sub: '' | '/selection'): string {
  const base = `/api/projects/${encodeURIComponent(projectId)}/docs-review/screen-flow${sub}`;
  return flowId === SCREEN_FLOW_ID ? base : `${base}?flowId=${encodeURIComponent(flowId)}`;
}
function screenFlowApiBody(flowId: string, body: Record<string, unknown>): string {
  return JSON.stringify(flowId === SCREEN_FLOW_ID ? body : { ...body, flowId });
}

interface LoadedFlow {
  review: UxReview | null;
  index: IndexEntry | null;
  drawioXml: string | null; // proposed.drawio (2 trang) hoặc as-is.drawio (1 trang)
  drawioHasProposal: boolean;
  mermaidAsIs: string | null;
  mermaidProposed: string | null;
  svg: string | null;
}

export function FlowUxReviewPreview({
  projectId,
  file,
  fallback,
}: {
  projectId: string;
  file: ProjectFile;
  /** Rendered instead when the flow has no new-format data (legacy dr-flow run)
   *  and, for text-only flows, inside the diagram pane (there is no source
   *  diagram to show — the derived block diagram is the best view). */
  fallback?: ReactNode;
}) {
  const loc = useMemo(() => flowUxLocationOf(file.name), [file.name]);
  const presentation = flowPresentationOf(file.name);
  const [data, setData] = useState<LoadedFlow | null>(null);
  const [failed, setFailed] = useState(false);
  const [mode, setMode] = useState<ViewMode>('as-is');
  const [activeId, setActiveId] = useState<string | null>(null);
  // Thẻ finding nào đang mở "Chi tiết ▾" — cục bộ, KHÔNG liên quan tới
  // activeId (chọn thẻ để highlight cell trên sơ đồ là một chiều khác hẳn;
  // bấm "Chi tiết" không được đổi lựa chọn đó — wp-flowux-panel-compact).
  const [expandedFindingIds, setExpandedFindingIds] = useState<Set<string>>(() => new Set());
  function toggleFindingExpanded(id: string) {
    setExpandedFindingIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  // Bố cục thô đọc từ localStorage (mặc định 'side') — bị "ép" về 'single' ở
  // effectiveLayout bên dưới khi luồng không có bản đề xuất (không thể đối
  // chiếu 2 bản khi chỉ có 1).
  const [layout, setLayoutState] = useState<LayoutMode>(() => readStoredLayout('side'));
  function setLayout(next: LayoutMode) {
    setLayoutState(next);
    writeStoredLayout(next);
  }
  const [panelOpen, setPanelOpenState] = useState<boolean>(() => readStoredPanelOpen(true));
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
  // Toàn màn hình: overlay CSS tự làm (xem docblock đầu file lý do không dùng
  // Fullscreen API), không persist qua localStorage — mỗi lần mở lại trang là
  // một phiên xem mới, không có lý do giữ nguyên trạng thái phóng to.
  const [fullscreen, setFullscreen] = useState(false);
  function enterFullscreen() {
    setFullscreen(true);
    // Vào fullscreen: ẩn panel mặc định để sơ đồ chiếm trọn — đây là GHI ĐÈ
    // HIỂN THỊ tạm thời cho phiên fullscreen, KHÔNG ghi localStorage (không
    // gọi writeStoredPanelOpen) để không đánh mất lựa chọn thật của người
    // dùng; thoát fullscreen khôi phục đúng lựa chọn đó.
    setPanelOpenState(false);
  }
  function exitFullscreen() {
    setFullscreen(false);
    setPanelOpenState(readStoredPanelOpen(true));
  }
  // Phím Esc thoát fullscreen — chỉ lắng nghe khi đang bật để không nuốt Esc
  // của UI khác lúc màn hình bình thường.
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') exitFullscreen();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fullscreen]);
  // fsReady: GraphViewer (DrawioViewer/MermaidDiagram) đo kích thước container
  // NGAY LÚC MOUNT để auto-fit sơ đồ — nếu mount cùng render với lúc overlay
  // portal vừa gắn vào document.body (chưa layout xong: position:fixed +
  // inset:0 + height:100dvh chưa được trình duyệt tính ra kích thước cuối
  // cùng) thì đo sai (sơ đồ bé tí giữa khoảng trắng lớn, đúng bug 0.8.78
  // người dùng báo). Trễ mount viewer thật SAU 2 khung requestAnimationFrame
  // (khung đầu xếp sau lần paint đã có overlay, khung hai để chắc layout đã
  // ổn định — một rAF đôi khi chưa đủ trên một số trình duyệt/kịch bản đo).
  // Trước fsReady, overlay hiện placeholder "Đang tải…" thay viewer thật.
  // WP-screen-flow editor: sơ đồ SCREEN-FLOW (dr-flow mới sinh, không có bản
  // đề xuất) mặc định xem TĨNH (viewer, không cần embed.diagrams.net); bấm
  // "Chỉnh sửa" mới thay khung bằng editor draw.io nhúng tại chỗ (tự lưu),
  // bấm "Xong" quay về viewer với bản vừa sửa. editedXmlRef = bản mới nhất
  // editor phát ra (kể cả chưa kịp lưu) để remount (vào/thoát toàn màn hình)
  // nạp đúng bản đang sửa, và để viewer hiện ngay bản mới khi bấm Xong.
  const [editing, setEditing] = useState(false);
  const [editWarnings, setEditWarnings] = useState<string[]>([]);
  const editedXmlRef = useRef<string | null>(null);
  // WP dr-screens-merge (2026-08-27): bước Luồng màn hình (dr-flow, SCREEN-FLOW)
  // nay sinh luôn danh sách màn — `<gốc workflow>/screens-discovered.json`,
  // ĐÚNG contract cũ của dr-screens nên dùng lại ScreensDiscoveredPreview
  // nguyên xi. Tab "Danh sách màn" thay khung sơ đồ bằng preview đó; file
  // được tải LƯỜI (chỉ khi bấm tab, không chen vào Promise.all tải luồng) qua
  // cùng fetchProjectFileText, và tải lại khi file/mtime đổi (chạy lại bước).
  // screensKeyRef ghi key đã tải để bật/tắt tab không tải lại vô ích.
  // WP screen-flow-platform-split: `SCREEN-FLOW` | `SCREEN-FLOW--app` |
  // `SCREEN-FLOW--web` đều là luồng màn hình; nền tảng đọc từ id thư mục.
  const isScreenFlow = isScreenFlowId(loc?.flowId);
  const screenFlowId = loc?.flowId ?? SCREEN_FLOW_ID;
  const screenFlowPlatform = screenFlowPlatformOf(loc?.flowId);
  const [screensTab, setScreensTab] = useState(false);
  const screensOpen = isScreenFlow && screensTab;
  const [screensLoad, setScreensLoad] = useState<ScreensLoad>({ status: 'idle' });
  const screensKeyRef = useRef<string | null>(null);
  // screensGen tăng khi đổi bản đang dùng (PUT selection) — daemon dựng lại
  // danh sách màn theo bản mới nhưng mtime file luồng không đổi, nên phải tự
  // đổi key để tab Danh sách màn tải lại.
  const [screensGen, setScreensGen] = useState(0);
  // WP dr-flow-improve: bản đang dùng để chạy tiếp (chỉ SCREEN-FLOW có bản
  // Cải thiện). Trạng thái ban đầu từ `index.json[].selection` (daemon ghi khi
  // finalize); đổi qua radio → PUT route selection, đang lưu thì khoá radio;
  // daemon báo `downstreamStale` (comp/index.json đã có) → banner nhắc chạy lại.
  const [selVariant, setSelVariant] = useState<FlowVariant>('original');
  const [selSaving, setSelSaving] = useState(false);
  const [selError, setSelError] = useState<string | null>(null);
  const [downstreamStale, setDownstreamStale] = useState(false);
  const radioName = useId();
  // Panel phải: 'findings' = danh sách phát hiện (như cũ); 'elements' = "Theo
  // phần tử" — từng node/cạnh Thêm/Sửa/Bỏ ở trang Cải thiện kèm lý do.
  const [panelMode, setPanelMode] = useState<'findings' | 'elements'>('findings');
  // Cell đang được chỉ đích danh từ panel Theo phần tử — highlight ĐÚNG cell đó
  // trên trang Cải thiện (thay vì toàn bộ cells.proposed của finding). Xoá khi
  // người dùng chọn finding/cell theo đường khác.
  const [focusCell, setFocusCell] = useState<string | null>(null);
  // "Chỉ xem thay đổi" (B3): mờ cell không đổi ở khung Cải thiện.
  const [dimUnchanged, setDimUnchanged] = useState(false);
  // Gốc thư mục workflow = phần trước `flows/` trong loc.dir.
  const screensFile = loc ? `${loc.flowsDir.slice(0, -'flows/'.length)}screens-discovered.json` : null;
  const screensKey = screensFile ? `${projectId}\u0000${screensFile}\u0000${file.mtime}\u0000${screensGen}` : null;
  useEffect(() => {
    if (!screensOpen || !screensFile || !screensKey || screensKeyRef.current === screensKey) return undefined;
    screensKeyRef.current = screensKey;
    let cancelled = false;
    let done = false;
    setScreensLoad({ status: 'loading' });
    void (async () => {
      const raw = await fetchProjectFileText(projectId, screensFile);
      if (cancelled) return;
      done = true;
      let doc: ScreensDiscoveredDoc | null = null;
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as unknown;
          if (isScreensDiscoveredDoc(parsed)) doc = parsed;
        } catch {
          // File hỏng → coi như chưa có, thông báo chạy lại bước.
        }
      }
      setScreensLoad(doc ? { status: 'ok', doc } : { status: 'missing' });
    })();
    return () => {
      cancelled = true;
      // Bị huỷ giữa chừng (đổi file/tắt tab) → quên key để lần mở sau tải lại.
      if (!done) screensKeyRef.current = null;
    };
  }, [screensOpen, screensFile, screensKey, projectId]);
  const [fsReady, setFsReady] = useState(false);
  useEffect(() => {
    if (!fullscreen) {
      setFsReady(false);
      return undefined;
    }
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setFsReady(true));
    });
    return () => {
      cancelAnimationFrame(raf1);
      if (raf2) cancelAnimationFrame(raf2);
    };
  }, [fullscreen]);
  // Khoá cuộn trang phía sau khi overlay mở — overlay giờ là con của
  // document.body (portal) chứ không còn nằm trong khung cuộn nội bộ của
  // trang để tự nhiên chặn cuộn hộ. Nhớ giá trị overflow cũ để khôi phục
  // đúng, kể cả khi component unmount ngay giữa lúc đang fullscreen (cleanup
  // effect chạy cả hai trường hợp: fullscreen tắt lẫn unmount).
  useEffect(() => {
    if (!fullscreen) return undefined;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, [fullscreen]);
  // Phím tắt `]` ẩn/hiện panel — CHỈ khi tiêu điểm không nằm trong ô nhập, để
  // không nuốt dấu `]` người dùng gõ trong textarea khác của trang. Đăng ký
  // MỘT lần (deps rỗng) và dùng cập nhật hàm trong togglePanel để không phải
  // đăng ký lại mỗi lần panelOpen đổi (cùng khuôn với DocRedlinePreview).
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
    if (!loc) return;
    let cancelled = false;
    setData(null);
    setFailed(false);
    setActiveId(null);
    setFocusCell(null);
    editedXmlRef.current = null;
    setEditWarnings([]);
    setEditing(false);
    setSelError(null);
    setDownstreamStale(false);
    setDimUnchanged(false);
    const get = (rel: string) => fetchProjectFileText(projectId, rel);
    // 'original' (mở as-is.drawio): KHÔNG tải ux-review.json / proposed.* —
    // đó là file của bước Cải thiện luồng, Quick result dr-flow không được
    // hiện "ké" (kể cả khi có trên đĩa); 404 cũng im lặng vì không tải.
    const compare = presentation === 'compare';
    const none = Promise.resolve<string | null>(null);
    void (async () => {
      const [reviewRaw, indexRaw, proposedDrawio, asIsDrawio, mmdAsIs, mmdProposed, svg] = await Promise.all([
        compare ? get(`${loc.dir}ux-review.json`) : none,
        get(`${loc.flowsDir}index.json`),
        compare ? get(`${loc.dir}proposed.drawio`) : none,
        get(`${loc.dir}as-is.drawio`),
        get(`${loc.dir}as-is.mmd`),
        compare ? get(`${loc.dir}proposed.mmd`) : none,
        get(`${loc.dir}as-is.svg`),
      ]);
      if (cancelled) return;
      const review = reviewRaw ? parseUxReview(reviewRaw, loc.flowId) : null;
      const drawioXml = proposedDrawio ?? asIsDrawio;
      if (!review && !drawioXml && !mmdAsIs) {
        setFailed(true);
        return;
      }
      const loaded: LoadedFlow = {
        review,
        index: parseIndexEntry(indexRaw, loc.flowId),
        drawioXml,
        drawioHasProposal: !!proposedDrawio && drawioPageCount(proposedDrawio) >= 2,
        mermaidAsIs: mmdAsIs,
        mermaidProposed: mmdProposed,
        svg,
      };
      setData(loaded);
      // Mặc định mở "Cải thiện" khi có — đó là thứ người review cần xem trước.
      setMode(loaded.drawioHasProposal || loaded.mermaidProposed ? 'proposed' : 'as-is');
      // "Chỉ xem thay đổi" mặc định BẬT khi có bản Cải thiện draw.io (WP
      // dr-flow-edit-highlight) — trừ khi trang Cải thiện không có thay đổi
      // nào (tập changed rỗng → dim sẽ mờ TOÀN BỘ sơ đồ, vô nghĩa). Người
      // dùng tắt được; đổi file thì reset (đầu effect).
      setDimUnchanged(loaded.drawioHasProposal && parseProposedElements(loaded.drawioXml!, review?.findings ?? []).elements.length > 0);
      // Bản đang dùng: daemon ghi `entry.selection`/`entry.variant`; vắng = Nguyên bản.
      const sel = loaded.index?.selection?.variant ?? loaded.index?.variant;
      setSelVariant(sel === 'improved' ? 'improved' : 'original');
      setPanelMode('findings');
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, loc, file.mtime, presentation]);

  const findings = data?.review?.findings ?? [];
  const active = useMemo(() => findings.find((f) => f.id === activeId) ?? null, [findings, activeId]);
  // Panel "Theo phần tử": parse trang 1 của proposed.drawio (chỉ khi có bản
  // Cải thiện dạng draw.io). Memo theo xml + findings — xml chỉ đổi khi tải
  // lại file hoặc lưu bản sửa tay.
  const proposedElements = useMemo(
    () => (data?.drawioXml && data.drawioHasProposal ? parseProposedElements(data.drawioXml, findings) : null),
    [data?.drawioXml, data?.drawioHasProposal, findings],
  );
  // B3: tập cell đã Thêm/Sửa/Bỏ ở trang Cải thiện (= danh sách panel Theo phần
  // tử, để badge và panel cùng một con số) + tổng theo loại cho badge.
  const changedIds = useMemo(() => (proposedElements?.elements ?? []).map((e) => e.id), [proposedElements]);
  const changeCounts = useMemo(() => {
    const c = { added: 0, modified: 0, removed: 0 };
    for (const e of proposedElements?.elements ?? []) c[e.change] += 1;
    return c;
  }, [proposedElements]);
  // Mặc định (chưa chọn finding/phần tử) khung Nguyên bản viền hợp mọi
  // findings[].cells.asIs — cùng nhịp với khung Cải thiện viền mọi thay đổi.
  const allAsIsCells = useMemo(() => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const f of findings) for (const id of f.cells?.asIs ?? []) if (!seen.has(id)) (seen.add(id), out.push(id));
    return out;
  }, [findings]);
  // Chỉ có "mặc định = toàn bộ thay đổi" khi đang đối chiếu có bản Cải thiện
  // draw.io (proposedElements ≠ null); flow không có proposal thì như cũ (rỗng).
  // Khung Cải thiện viền THEO LOẠI (`{ id, kind }` → màu riêng, khớp
  // CHANGE_STYLE daemon); chọn finding/phần tử thì thu về id trần = viền accent.
  const defaultRightHighlight = useMemo<HighlightSpec[]>(
    () => (proposedElements ? proposedElements.elements.map((e) => ({ id: e.id, kind: e.change })) : []),
    [proposedElements],
  );
  const defaultLeftHighlight = proposedElements ? allAsIsCells : [];
  const highlightCells = useMemo<HighlightSpec[]>(() => {
    if (mode === 'proposed' && focusCell) return [focusCell];
    if (!active?.cells) return mode === 'proposed' ? defaultRightHighlight : defaultLeftHighlight;
    return mode === 'proposed' ? [...(active.cells.proposed ?? active.cells.asIs ?? [])] : [...(active.cells.asIs ?? [])];
  }, [active, mode, focusCell, defaultRightHighlight, defaultLeftHighlight]);
  // "Chỉ xem thay đổi" → khung Cải thiện mờ mọi cell ngoài tập changed.
  const dimCellsExcept = dimUnchanged && proposedElements ? changedIds : undefined;
  const cellToFinding = useMemo(() => {
    const map = new Map<string, string>();
    for (const f of findings) {
      for (const id of f.cells?.asIs ?? []) if (!map.has(`as-is:${id}`)) map.set(`as-is:${id}`, f.id);
      for (const id of f.cells?.proposed ?? []) if (!map.has(`proposed:${id}`)) map.set(`proposed:${id}`, f.id);
    }
    return map;
  }, [findings]);

  if (!loc) return <div className={styles.message}>File không thuộc thư mục flows/&lt;FLOW-ID&gt;/.</div>;
  if (failed) {
    if (fallback) return <>{fallback}</>;
    return <div className={styles.message}>Chưa có dữ liệu đánh giá cho luồng <code>{loc.flowId}</code> — chạy bước "Đánh giá luồng UX".</div>;
  }
  if (!data) return <div className={styles.message}>Đang tải…</div>;

  const title = data.index?.title ?? loc.flowId;
  // Badge nền tảng cạnh tiêu đề: theo id thư mục; index entry `platform` là
  // dự phòng (daemon ghi cho flow tách).
  const platformLabel = screenFlowPlatformLabel(loc.flowId) ?? (data.index?.platform === 'app' ? 'App' : data.index?.platform === 'web' ? 'Web' : null);
  const kind: IndexEntry['kind'] = data.index?.kind ?? (data.drawioXml ? 'drawio' : data.mermaidAsIs ? 'mermaid' : 'text');
  const hasProposal = kind === 'drawio' ? data.drawioHasProposal : kind === 'mermaid' ? !!data.mermaidProposed : false;
  // Không có bản đề xuất thì không có gì để đối chiếu — ép về 'single' bất kể
  // localStorage lưu gì (WP17a do mục 1). Đang CHỈNH SỬA cũng ép 'single':
  // editor draw.io nhúng chiếm trọn một khung và tự có tab trang (Nguyên bản
  // | Cải thiện) — không dựng 2 editor cạnh nhau.
  const effectiveLayout: LayoutMode = hasProposal && !editing ? layout : 'single';
  const counts = SEVERITY_ORDER.map((s) => [s, findings.filter((f) => f.severity === s).length] as const).filter(([, n]) => n > 0);
  // Khối chọn bản + badge "đang dùng": chỉ SCREEN-FLOW có bản Cải thiện (các
  // luồng khác không có selection.json — daemon không đọc).
  const showVariantSelect = isScreenFlow && hasProposal;
  // Right panel chỉ có ở chế độ đối chiếu (mở từ ux-review.json…); 'original'
  // (mở as-is.drawio) không tải review nên không có gì để hiện — cũng không
  // hiện tab dọc "Hiện chú giải".
  const showPanel = presentation === 'compare';
  const changeTotal = changeCounts.added + changeCounts.modified + changeCounts.removed;
  // Badge "N thay đổi · a thêm · b sửa · c bỏ" (B3) — chỉ khi có thay đổi.
  const changesBadge = (where: 'tab' | 'pane') =>
    proposedElements && changeTotal > 0 ? (
      <span className={styles.changesBadge ?? ''} data-testid={`changes-badge-${where}`}>
        {changeTotal} thay đổi · {changeCounts.added} thêm · {changeCounts.modified} sửa · {changeCounts.removed} bỏ
      </span>
    ) : null;
  const dimToggle = proposedElements ? (
    <button
      type="button"
      className={`${styles.dimBtn ?? ''} ${dimUnchanged ? styles.dimBtnActive ?? '' : ''}`}
      aria-pressed={dimUnchanged}
      onClick={() => setDimUnchanged((v) => !v)}
    >
      Chỉ xem thay đổi
    </button>
  ) : null;
  const usingBadge = (variant: FlowVariant) =>
    showVariantSelect && selVariant === variant ? (
      <span className={styles.usingBadge ?? ''} data-testid={`using-${variant}`}>
        đang dùng
      </span>
    ) : null;

  // Chọn finding/cell theo đường "thường" (card, bấm cell) xoá focusCell của
  // panel Theo phần tử — hai nguồn highlight không được giẫm nhau.
  const pickFinding = (id: string | null) => {
    setFocusCell(null);
    setActiveId(id);
  };
  const onCellClick = (cellId: string | null) => {
    if (!cellId) return;
    const hit = cellToFinding.get(`${mode === 'proposed' ? 'proposed' : 'as-is'}:${cellId}`) ?? cellToFinding.get(`as-is:${cellId}`) ?? cellToFinding.get(`proposed:${cellId}`);
    if (hit) pickFinding(hit);
  };
  // Bố cục cạnh nhau: khung trái highlight cells.asIs, khung phải highlight
  // cells.proposed — KHÔNG fallback chéo (cả 2 khung đang hiện cùng lúc, khác
  // với mode đơn ở single chỉ có một khung nên fallback mới hợp lý). focusCell
  // (panel Theo phần tử) thắng ở khung phải — nó CHỈ trỏ cell trang Cải thiện.
  // Chưa chọn gì → mặc định B3 (toàn bộ thay đổi / hợp cells.asIs); chọn →
  // thu về viền riêng; bỏ chọn → về mặc định.
  const sideLeftHighlight = active ? (active.cells?.asIs ? [...active.cells.asIs] : []) : defaultLeftHighlight;
  const sideRightHighlight: HighlightSpec[] = focusCell ? [focusCell] : active ? (active.cells?.proposed ? [...active.cells.proposed] : []) : defaultRightHighlight;
  const onSideLeftCellClick = (cellId: string | null) => {
    if (!cellId) return;
    const hit = cellToFinding.get(`as-is:${cellId}`) ?? cellToFinding.get(`proposed:${cellId}`);
    if (hit) {
      pickFinding(hit);
      openPanel(); // bấm cell khi panel đang ẩn → mở panel + chọn finding.
    }
  };
  const onSideRightCellClick = (cellId: string | null) => {
    if (!cellId) return;
    const hit = cellToFinding.get(`proposed:${cellId}`) ?? cellToFinding.get(`as-is:${cellId}`);
    if (hit) {
      pickFinding(hit);
      openPanel();
    }
  };
  // Panel Theo phần tử: bấm một dòng → chọn finding của nó (nếu có) + highlight
  // đúng cell đó trên trang Cải thiện; đang ở tab Danh sách màn / trang Nguyên
  // bản thì chuyển về sơ đồ trang Cải thiện để thấy được highlight.
  const pickElement = (el: ProposedElement) => {
    setActiveId(el.findingId);
    setFocusCell(el.id);
    setScreensTab(false);
    if (mode !== 'proposed') setMode('proposed');
  };
  // Đổi bản đang dùng → PUT selection (source:'user' do daemon gắn). Lạc quan
  // đổi radio trước, thất bại thì trả về bản cũ + báo lỗi. Thành công: tăng
  // screensGen để tab Danh sách màn tải lại danh sách theo bản mới.
  const changeVariant = async (variant: FlowVariant) => {
    if (variant === selVariant || selSaving) return;
    const prev = selVariant;
    setSelVariant(variant);
    setSelSaving(true);
    setSelError(null);
    try {
      const res = await fetch(screenFlowApiUrl(projectId, screenFlowId, '/selection'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: screenFlowApiBody(screenFlowId, { variant }),
      });
      const body = (await res.json().catch(() => null)) as { ok?: boolean; error?: string; variant?: string; downstreamStale?: boolean } | null;
      if (!res.ok || body?.ok === false) throw new Error(body?.error ?? `HTTP ${res.status}`);
      setSelVariant(body?.variant === 'improved' || body?.variant === 'original' ? body.variant : variant);
      setDownstreamStale(!!body?.downstreamStale);
      setScreensGen((g) => g + 1);
    } catch (err) {
      setSelVariant(prev);
      setSelError(err instanceof Error ? err.message : String(err));
    } finally {
      setSelSaving(false);
    }
  };
  // Chip cell trên card finding: ở bố cục cạnh nhau ưu tiên cells.proposed
  // (như mode 'proposed' hôm nay), vì cả 2 khung đang hiện nên "bản mới" là
  // thứ đáng chỉ ra trước.
  const cardCellsFor = (f: UxFinding): string[] =>
    effectiveLayout === 'side' || mode === 'proposed' ? f.cells?.proposed ?? f.cells?.asIs ?? [] : f.cells?.asIs ?? [];

  // WP-screen-flow editor: chỉ sơ đồ SINH RA bởi dr-flow mới (SCREEN-FLOW)
  // sửa được — sơ đồ nguồn từ tài liệu là bằng chứng gốc, không sửa ở đây.
  // WP dr-flow-improve: sửa được CẢ 2 trang khi có bản Cải thiện (editor nạp
  // nguyên mxfile 2 trang, draw.io embed tự có tab trang; daemon nhận mxfile
  // 1 hoặc 2 trang, tự ghi as-is/proposed + marker proposed.edited.json).
  // Lưu = POST daemon (validate mềm + ghi + re-finalize flowchart/index).
  // KHÔNG nạp lại file sau lưu (sẽ remount iframe, mất viewport/undo) — chỉ
  // cập nhật drawioXml tại chỗ cho link Tải + viewer; số trang tính lại từ
  // bản mới (người dùng xoá trang Cải thiện trong editor → hết proposal).
  const editable = isScreenFlow && kind === 'drawio' && !!data.drawioXml;
  const applyEditedXml = (xml: string) =>
    setData((prev) => (prev ? { ...prev, drawioXml: xml, drawioHasProposal: drawioPageCount(xml) >= 2 } : prev));
  const finishEditing = () => {
    // Viewer hiện NGAY bản mới nhất của editor (kể cả bản đang chờ debounce —
    // DrawioEditor unmount sẽ tự đẩy nốt bản đó về daemon).
    const latest = editedXmlRef.current;
    if (latest) applyEditedXml(latest);
    setEditing(false);
  };
  // WP dr-flow-edit-highlight: editor mở ĐÚNG trang đang xem (trang 1 = Cải
  // thiện khi có proposal) qua URL param `page` của embed; tên trang từ
  // `<diagram name>` (fallback Nguyên bản/Cải thiện) cho chip "Đang sửa: …".
  // Key editor theo trang → đổi tab Nguyên bản/Cải thiện trong lúc sửa thì
  // remount đúng trang (unmount đẩy bản chờ lưu, mount nạp editedXmlRef).
  const editorPage = mode === 'proposed' && data.drawioHasProposal ? 1 : 0;
  const editorPageName = (data.drawioXml ? drawioPageNames(data.drawioXml)[editorPage] : '') || (editorPage === 1 ? 'Cải thiện' : 'Nguyên bản');
  // Tab sơ đồ (Nguyên bản/Cải thiện/Ảnh gốc) đóng tab Danh sách màn — KHÔNG
  // tắt editing (đang sửa thì editor remount sang trang đó, xem editorPage);
  // chỉ tab Danh sách màn mới đóng editor (unmount DrawioEditor tự đẩy bản
  // chờ lưu).
  const selectMode = (next: ViewMode) => {
    setMode(next);
    setScreensTab(false);
  };
  const openScreensTab = () => {
    if (editing) finishEditing();
    setScreensTab(true);
  };
  const saveScreenFlow = async (editedXml: string) => {
    const res = await fetch(screenFlowApiUrl(projectId, screenFlowId, ''), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: screenFlowApiBody(screenFlowId, { xml: editedXml }),
    });
    const body = (await res.json().catch(() => null)) as { error?: string; warnings?: string[] } | null;
    if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
    setEditWarnings(body?.warnings ?? []);
    applyEditedXml(editedXml);
  };

  // Có viewer thật để render (thay vì placeholder "Đang tải…") khi: đang ở
  // chế độ thường (luôn sẵn — không có bug đo-sớm vì overlay không tồn tại),
  // HOẶC đang fullscreen và overlay portal đã layout xong (fsReady).
  const showViewer = !fullscreen || fsReady;
  // Thân dùng CHUNG cho cả 2 nơi render (tại chỗ khi thường, trong overlay
  // portal khi fullscreen) — do mục 1 wp18.yaml: không viết 2 bản markup.
  const content = (
    <>
      <header className={styles.head}>
        <div className={styles.headMain}>
          <h2 className={styles.title}>{title}</h2>
          {platformLabel ? (
            <span className={styles.platformBadge ?? ''} data-testid="platform-badge">
              {platformLabel}
            </span>
          ) : null}
          {data.review ? (
            <span className={`${styles.verdict} ${styles[`verdict_${data.review.verdict.replace('-', '_')}`] ?? ''}`} data-testid="verdict">
              {VERDICT_LABEL[data.review.verdict]}
            </span>
          ) : null}
          {counts.map(([s, n]) => (
            <span key={s} className={`${styles.count} ${styles[`sev_${s}`]}`}>
              {n} {SEVERITY_LABEL[s].toLowerCase()}
            </span>
          ))}
        </div>
        {data.index?.source ? (
          <div className={styles.source}>
            Nguồn: <code>{data.index.source}</code>
          </div>
        ) : null}
        {data.review?.summary ? <p className={styles.summary}>{data.review.summary}</p> : null}
      </header>

      <div className={`${styles.body} ${panelOpen && showPanel ? '' : styles.bodyPanelHidden ?? ''}`}>
        <section className={styles.diagram} aria-label="Sơ đồ luồng">
          <div className={styles.diagramBar}>
            {effectiveLayout === 'single' || isScreenFlow ? (
              <div className={styles.modeBar} role="tablist" aria-label="Chế độ xem sơ đồ">
                <button type="button" role="tab" aria-selected={!screensOpen && mode === 'as-is'} className={`${styles.modeBtn} ${!screensOpen && mode === 'as-is' ? styles.modeBtnActive : ''}`} onClick={() => selectMode('as-is')}>
                  Nguyên bản
                  {usingBadge('original')}
                </button>
                {hasProposal ? (
                  <button type="button" role="tab" aria-selected={!screensOpen && mode === 'proposed'} className={`${styles.modeBtn} ${!screensOpen && mode === 'proposed' ? styles.modeBtnActive : ''}`} onClick={() => selectMode('proposed')}>
                    Cải thiện
                    {usingBadge('improved')}
                    {changesBadge('tab')}
                  </button>
                ) : null}
                {kind === 'mermaid' && data.svg ? (
                  <button type="button" role="tab" aria-selected={!screensOpen && mode === 'svg'} className={`${styles.modeBtn} ${!screensOpen && mode === 'svg' ? styles.modeBtnActive : ''}`} onClick={() => selectMode('svg')}>
                    Ảnh gốc
                  </button>
                ) : null}
                {isScreenFlow ? (
                  // Danh sách màn sinh cùng luồng (WP dr-screens-merge) — xem
                  // ghi chú ở khai báo screensTab.
                  <button type="button" role="tab" aria-selected={screensOpen} className={`${styles.modeBtn} ${screensOpen ? styles.modeBtnActive : ''}`} onClick={openScreensTab}>
                    Danh sách màn
                  </button>
                ) : null}
              </div>
            ) : null}
            {hasProposal ? (
              // "Cạnh nhau" là mặc định để đối chiếu ngay (quyết định người
              // dùng 2026-08-20); "Từng bản" trả lại đúng khối tab cũ ở trên.
              <div className={styles.layoutBar} role="group" aria-label="Bố cục xem sơ đồ">
                <button
                  type="button"
                  aria-pressed={effectiveLayout === 'side'}
                  className={`${styles.layoutBtn} ${effectiveLayout === 'side' ? styles.layoutBtnActive : ''}`}
                  onClick={() => setLayout('side')}
                >
                  Cạnh nhau
                </button>
                <button
                  type="button"
                  aria-pressed={effectiveLayout === 'single'}
                  className={`${styles.layoutBtn} ${effectiveLayout === 'single' ? styles.layoutBtnActive : ''}`}
                  onClick={() => setLayout('single')}
                >
                  Từng bản
                </button>
              </div>
            ) : null}
            {hasProposal && effectiveLayout === 'single' ? (
              <div className={styles.legend} aria-label="Chú giải màu đề xuất">
                <span className={`${styles.legendItem} ${styles.legend_added}`}>Thêm mới</span>
                <span className={`${styles.legendItem} ${styles.legend_modified}`}>Sửa đổi</span>
                <span className={`${styles.legendItem} ${styles.legend_removed}`}>Đề nghị bỏ</span>
              </div>
            ) : null}
            {hasProposal && effectiveLayout === 'single' && !screensOpen && mode === 'proposed' ? dimToggle : null}
            {/* Cụm phải gom trong MỘT container margin-left:auto — trước đây
                mỗi nút tự margin-left:auto, flexbox chia đều khoảng trống cho
                từng auto-margin nên 3 nút bị rải ra giữa thanh thay vì nhóm
                sát mép phải. */}
            {screensOpen ? null : (
              <div className={styles.barRight}>
                {editable ? (
                  <button type="button" className={styles.editBtn ?? ''} aria-pressed={editing} onClick={editing ? finishEditing : () => setEditing(true)}>
                    {editing ? 'Xong' : 'Chỉnh sửa'}
                  </button>
                ) : null}
                {kind === 'drawio' && data.drawioXml ? (
                  <a
                    className={styles.download}
                    href={`data:application/xml;charset=utf-8,${encodeURIComponent(data.drawioXml)}`}
                    download={`${loc.flowId}${hasProposal ? '.proposed' : ''}.drawio`}
                  >
                    Tải .drawio
                  </a>
                ) : null}
                <button type="button" className={styles.fullscreenBtn ?? ''} onClick={fullscreen ? exitFullscreen : enterFullscreen}>
                  {fullscreen ? 'Thoát' : 'Toàn màn hình'}
                </button>
              </div>
            )}
          </div>
          {editable && editing && !screensOpen && editorPage === 1 ? (
            <div className={styles.editHint ?? ''} data-testid="edit-hint">
              Sửa tay bản Cải thiện → daemon giữ bản bạn sửa, không áp lại đề xuất của agent (<code>proposed.edited.json</code>)
            </div>
          ) : null}
          <div className={`${styles.diagramBox} ${!screensOpen && effectiveLayout === 'side' ? styles.diagramBoxSide ?? '' : ''}`}>
            {screensOpen ? (
              // Tab Danh sách màn: preview dùng chung với dr-screens cũ, thay
              // khung sơ đồ (không cần viewer nên không đợi fsReady).
              <div className={styles.screensPane} data-testid="screens-pane">
                {screensLoad.status === 'ok' ? (
                  <ScreensDiscoveredPreview doc={filterScreensByPlatform(screensLoad.doc, screenFlowPlatform)} />
                ) : screensLoad.status === 'missing' ? (
                  <div className={styles.message}>Chưa có danh sách màn — chạy lại bước Luồng màn hình.</div>
                ) : (
                  <div className={styles.message}>Đang tải…</div>
                )}
              </div>
            ) : effectiveLayout === 'side' ? (
              // Hai khung ĐỘC LẬP (không đồng bộ pan/zoom — xem docblock đầu
              // file): mỗi bên tự nhận highlight + tự cuộn tới cell của mình
              // khi bấm một finding.
              <div className={styles.sideWrap}>
                <div className={styles.sidePane} data-testid="side-pane-left">
                  <div className={styles.sidePaneHead}>
                    <h3 className={styles.paneTitle}>Nguyên bản</h3>
                    {usingBadge('original')}
                  </div>
                  <div className={styles.sidePaneBox}>
                    {!showViewer ? (
                      // Chờ overlay portal layout xong (fsReady) trước khi
                      // mount GraphViewer — xem effect fsReady phía trên.
                      <div className={styles.message}>Đang tải…</div>
                    ) : (
                      <>
                        {kind === 'drawio' && data.drawioXml ? (
                          <DrawioViewer
                            key={`side-left-${fullscreen}`}
                            className={styles.drawio}
                            xml={data.drawioXml}
                            page={0}
                            highlightCells={sideLeftHighlight}
                            onCellClick={onSideLeftCellClick}
                            // Bỏ nút lightbox (xem docblock đầu file) — chỉ còn
                            // một kiểu toàn màn hình: overlay CSS của khung này.
                            options={VIEWER_OPTIONS}
                          />
                        ) : null}
                        {kind === 'mermaid' ? <MermaidDiagram code={data.mermaidAsIs ?? ''} initialFit="width" /> : null}
                      </>
                    )}
                  </div>
                </div>
                <div className={styles.sidePane} data-testid="side-pane-right">
                  <div className={styles.sidePaneHead}>
                    <h3 className={styles.paneTitle}>Cải thiện</h3>
                    {usingBadge('improved')}
                    {changesBadge('pane')}
                    {dimToggle}
                    <div className={styles.legend} aria-label="Chú giải màu đề xuất">
                      <span className={`${styles.legendItem} ${styles.legend_added}`}>Thêm mới</span>
                      <span className={`${styles.legendItem} ${styles.legend_modified}`}>Sửa đổi</span>
                      <span className={`${styles.legendItem} ${styles.legend_removed}`}>Đề nghị bỏ</span>
                    </div>
                  </div>
                  <div className={styles.sidePaneBox}>
                    {!showViewer ? (
                      <div className={styles.message}>Đang tải…</div>
                    ) : (
                      <>
                        {kind === 'drawio' && data.drawioXml ? (
                          <DrawioViewer
                            key={`side-right-${fullscreen}`}
                            className={styles.drawio}
                            xml={data.drawioXml}
                            page={1}
                            highlightCells={sideRightHighlight}
                            dimCellsExcept={dimCellsExcept}
                            onCellClick={onSideRightCellClick}
                            options={VIEWER_OPTIONS}
                          />
                        ) : null}
                        {kind === 'mermaid' ? <MermaidDiagram code={data.mermaidProposed ?? data.mermaidAsIs ?? ''} initialFit="width" /> : null}
                      </>
                    )}
                  </div>
                </div>
              </div>
            ) : !showViewer ? (
              <div className={styles.message}>Đang tải…</div>
            ) : (
              <>
                {editable && editing ? (
                  // Đang chỉnh tay: editor tại chỗ thay viewer tĩnh. Mount lại
                  // khi vào/thoát toàn màn hình (portal) → nạp bản mới nhất.
                  <DrawioEditor
                    key={`editor-${fullscreen}-${editorPage}`}
                    xml={editedXmlRef.current ?? data.drawioXml!}
                    title={title}
                    page={editorPage}
                    pageName={editorPageName}
                    onSave={saveScreenFlow}
                    onChange={(xml) => {
                      editedXmlRef.current = xml;
                    }}
                  />
                ) : kind === 'drawio' && data.drawioXml ? (
                  <DrawioViewer
                    key={`single-${fullscreen}`}
                    className={styles.drawio}
                    xml={data.drawioXml}
                    page={mode === 'proposed' && data.drawioHasProposal ? 1 : 0}
                    highlightCells={highlightCells}
                    dimCellsExcept={mode === 'proposed' && data.drawioHasProposal ? dimCellsExcept : undefined}
                    onCellClick={onCellClick}
                    options={VIEWER_OPTIONS}
                  />
                ) : null}
                {kind === 'mermaid' ? (
                  // Vừa chiều RỘNG rồi đọc từ trên xuống (không co cả sơ đồ vào
                  // khung thành ảnh tí hon); cuộn/kéo/zoom như viewer draw.io.
                  mode === 'svg' && data.svg ? (
                    <MermaidDiagram code="" svg={data.svg} initialFit="width" />
                  ) : (
                    <MermaidDiagram code={(mode === 'proposed' ? data.mermaidProposed : null) ?? data.mermaidAsIs ?? ''} initialFit="width" />
                  )
                ) : null}
                {kind === 'text' && fallback ? <div className={styles.fallbackBox}>{fallback}</div> : null}
                {kind === 'text' && !fallback ? (
                  <div className={styles.message}>
                    Tài liệu không có sơ đồ nguồn — luồng được dựng từ chữ. Mở <code>{loc.flowsDir}{loc.flowId}.flowchart.json</code> để xem sơ đồ.
                  </div>
                ) : null}
              </>
            )}
          </div>
          {editWarnings.length ? (
            <div className={styles.warn}>
              Đã lưu bản sửa, kèm cảnh báo: {editWarnings.join(' · ')}
            </div>
          ) : null}
          {data.index?.patchSkipped?.length ? (
            <div className={styles.warn}>
              {data.index.patchSkipped.length} thao tác đề xuất không áp được lên sơ đồ:{' '}
              {data.index.patchSkipped.map((s, i) => (
                <span key={i}>
                  <code>{s.op?.op ?? '?'}</code> {s.op?.cell ?? s.op?.edge ?? s.op?.id ?? ''} — {s.reason}
                  {i < data.index!.patchSkipped!.length - 1 ? '; ' : ''}
                </span>
              ))}
            </div>
          ) : null}
        </section>

        {!showPanel ? null : panelOpen ? (
          <aside className={styles.panel} aria-label="Lý do UX">
            <div className={styles.panelHead}>
              {proposedElements ? (
                // Có bản Cải thiện draw.io → 2 chế độ panel: Phát hiện UX (theo
                // finding) | Theo phần tử (theo node/cạnh đã Thêm/Sửa/Bỏ).
                <div className={styles.panelModeBar} role="group" aria-label="Chế độ panel">
                  <button type="button" className={`${styles.panelModeBtn} ${panelMode === 'findings' ? styles.panelModeBtnActive : ''}`} aria-pressed={panelMode === 'findings'} onClick={() => setPanelMode('findings')}>
                    Phát hiện UX
                  </button>
                  <button type="button" className={`${styles.panelModeBtn} ${panelMode === 'elements' ? styles.panelModeBtnActive : ''}`} aria-pressed={panelMode === 'elements'} onClick={() => setPanelMode('elements')}>
                    Theo phần tử
                  </button>
                </div>
              ) : (
                <span>Phát hiện UX</span>
              )}
              <span className={styles.panelMeta}>{proposedElements && panelMode === 'elements' ? proposedElements.elements.length : findings.length}</span>
              <button type="button" className={styles.panelToggleBtn ?? ''} aria-label="Ẩn chú giải" onClick={togglePanel}>
                Ẩn ]
              </button>
            </div>
            {showVariantSelect ? (
              // Khối chọn bản chạy tiếp (WP dr-flow-improve mục 2) — ở ĐẦU panel,
              // trên cả danh sách finding: đây là quyết định của người duyệt.
              <div className={styles.selectBlock} data-testid="variant-select">
                <div className={styles.selectTitle} id={`${radioName}-label`}>
                  Dùng bản để chạy tiếp
                </div>
                <div role="radiogroup" aria-labelledby={`${radioName}-label`} className={styles.radioGroup}>
                  {(['original', 'improved'] as const).map((v) => (
                    <label key={v} className={`${styles.radioLabel} ${selVariant === v ? styles.radioLabelActive : ''}`}>
                      <input type="radio" name={radioName} value={v} checked={selVariant === v} disabled={selSaving} onChange={() => void changeVariant(v)} />
                      {v === 'original' ? 'Nguyên bản' : 'Cải thiện'}
                    </label>
                  ))}
                  {selSaving ? (
                    <span className={styles.selectMeta} role="status">
                      Đang lưu…
                    </span>
                  ) : null}
                </div>
                {selError ? <div className={styles.selectError}>Không lưu được lựa chọn: {selError}</div> : null}
                {downstreamStale ? (
                  <div className={styles.staleBanner} role="status">
                    Các bước sau (Màn hình → Component…) đang theo bản trước — Chạy lại để cập nhật.
                  </div>
                ) : null}
              </div>
            ) : null}
            {proposedElements && panelMode === 'elements' ? (
              proposedElements.unreadable ? (
                <div className={styles.message}>Không đọc được trang Cải thiện (XML hỏng hoặc lưu dạng nén) — tải .drawio về để xem.</div>
              ) : proposedElements.elements.length === 0 ? (
                <div className={styles.okBox}>Bản cải thiện không thay đổi phần tử nào.</div>
              ) : (
                <div className={styles.elemGroups} data-testid="elements-panel">
                  {CHANGE_ORDER.map((change) => {
                    const items = proposedElements.elements.filter((e) => e.change === change);
                    if (!items.length) return null;
                    return (
                      <section key={change} className={styles.elemGroup} aria-label={CHANGE_LABEL[change]}>
                        <h4 className={styles.elemGroupTitle}>
                          <span className={`${styles.change} ${styles[`legend_${change}`]}`}>{CHANGE_LABEL[change]}</span>
                          <span className={styles.panelMeta}>{items.length}</span>
                        </h4>
                        <ol className={styles.list}>
                          {items.map((el) => {
                            const f = el.findingId ? findings.find((x) => x.id === el.findingId) ?? null : null;
                            const isFocused = focusCell === el.id;
                            return (
                              <li key={el.id}>
                                <div
                                  role="button"
                                  tabIndex={0}
                                  className={`${styles.card} ${isFocused ? styles.cardActive : ''}`}
                                  aria-pressed={isFocused}
                                  onClick={() => pickElement(el)}
                                  onKeyDown={(ev) => {
                                    if (ev.key !== 'Enter' && ev.key !== ' ') return;
                                    ev.preventDefault();
                                    pickElement(el);
                                  }}
                                  data-testid={`element-${el.id}`}
                                >
                                  <div className={styles.cardTop}>
                                    <span className={styles.elemKind}>{ELEMENT_KIND_LABEL[el.kind]}</span>
                                    <span className={styles.fid}>{el.id}</span>
                                    {f ? <span className={styles.fid}>{f.id}</span> : null}
                                    <span className={`${styles.change} ${styles[`legend_${el.change}`]}`}>{CHANGE_LABEL[el.change]}</span>
                                  </div>
                                  <div className={styles.cardTitle}>{el.label}</div>
                                  {f ? (
                                    <>
                                      <p className={styles.reason}>{f.reason || f.title}</p>
                                      {f.evidence?.length ? (
                                        <ul className={styles.evidence}>
                                          {f.evidence.map((e, i) => (
                                            <li key={i} title={e}>
                                              <code>{evidenceLabel(e)}</code>
                                            </li>
                                          ))}
                                        </ul>
                                      ) : null}
                                    </>
                                  ) : (
                                    <p className={styles.summaryLine}>Không có finding giải thích cho phần tử này.</p>
                                  )}
                                </div>
                              </li>
                            );
                          })}
                        </ol>
                      </section>
                    );
                  })}
                </div>
              )
            ) : !data.review ? (
              <div className={styles.message}>Chưa có ux-review.json cho luồng này.</div>
            ) : findings.length === 0 ? (
              <div className={styles.okBox}>Không có phát hiện nào — luồng đạt checklist. {data.review.summary ? '' : 'Bước đánh giá không ghi thêm nhận xét.'}</div>
            ) : (
              <ol className={styles.list}>
                {SEVERITY_ORDER.flatMap((sev) => findings.filter((f) => f.severity === sev)).map((f) => {
                  const isActive = f.id === activeId;
                  const isExpanded = expandedFindingIds.has(f.id);
                  // Dòng tóm tắt: recommendation nếu có, không thì reason —
                  // bản đầy đủ luôn còn ở attr title và (nếu recommendation
                  // đã hiện ở đây) lặp lại đầy đủ trong Chi tiết.
                  const summarySource = f.recommendation || f.reason;
                  const toggleSelect = () => pickFinding(isActive ? null : f.id);
                  return (
                    <li key={f.id}>
                      {/* `div role="button"` chứ không phải <button> thật: thẻ
                          giờ chứa nút "Chi tiết" con, và <button> lồng <button>
                          là HTML không hợp lệ (trình duyệt tự gỡ lồng, mất nút
                          con). Bàn phím vẫn hoạt động nhờ tabIndex + Enter/Space
                          bên dưới — cùng khuôn DocRedlinePreview's `.item`. */}
                      <div
                        role="button"
                        tabIndex={0}
                        className={`${styles.card} ${isActive ? styles.cardActive : ''}`}
                        aria-pressed={isActive}
                        onClick={toggleSelect}
                        onKeyDown={(ev) => {
                          if (ev.key !== 'Enter' && ev.key !== ' ') return;
                          // Enter/Space bấm trên nút "Chi tiết" con nổi bọt lên
                          // đây — bỏ qua để không kích hoạt cả 2 hành động.
                          if (ev.target !== ev.currentTarget) return;
                          ev.preventDefault();
                          toggleSelect();
                        }}
                        data-testid={`finding-${f.id}`}
                      >
                        <div className={styles.cardTop}>
                          <span className={`${styles.sev} ${styles[`sev_${f.severity}`]}`}>{SEVERITY_LABEL[f.severity]}</span>
                          <span className={styles.fid}>{f.id}</span>
                          {f.change && f.change !== 'none' ? <span className={`${styles.change} ${styles[`legend_${f.change}`]}`}>{CHANGE_LABEL[f.change]}</span> : null}
                        </div>
                        <div className={styles.cardTitle}>{f.title}</div>
                        {summarySource ? (
                          <p className={styles.summaryLine} title={summarySource}>
                            {truncateAtWordBoundary(summarySource, 90)}
                          </p>
                        ) : null}
                        <div className={styles.cardFoot}>
                          <button
                            type="button"
                            className={styles.detailToggle ?? ''}
                            aria-expanded={isExpanded}
                            onClick={(ev) => {
                              ev.stopPropagation();
                              toggleFindingExpanded(f.id);
                            }}
                          >
                            {isExpanded ? 'Chi tiết ▴' : 'Chi tiết ▾'}
                          </button>
                        </div>
                        {isExpanded ? (
                          <div className={styles.cardDetail}>
                            {f.heuristic ? <div className={styles.heuristic}>{f.heuristic}</div> : null}
                            <p className={styles.reason}>{f.reason}</p>
                            {f.recommendation ? (
                              <p className={styles.reco}>
                                <strong>Đề xuất:</strong> {f.recommendation}
                              </p>
                            ) : null}
                            {f.conflictsWith ? <p className={styles.conflict}>Không đề xuất sửa vì vướng {f.conflictsWith}.</p> : null}
                            {f.evidence?.length ? (
                              <ul className={styles.evidence}>
                                {f.evidence.map((e, i) => (
                                  <li key={i} title={e}>
                                    <code>{evidenceLabel(e)}</code>
                                  </li>
                                ))}
                              </ul>
                            ) : null}
                            {f.cells?.asIs?.length || f.cells?.proposed?.length ? (
                              <div className={styles.cells}>
                                {cardCellsFor(f).map((c) => (
                                  <span key={c} className={styles.cellChip}>
                                    {c}
                                  </span>
                                ))}
                              </div>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
            {data.index?.note ? <div className={styles.note}>Ghi chú: {data.index.note}</div> : null}
          </aside>
        ) : (
          // Panel ẩn: tab dọc mỏng bám mép phải, hiện tổng số finding — bấm mở
          // lại. `position: absolute` bên trong `.body` (position: relative)
          // để không tràn ra ngoài khung component (cùng khuôn với
          // DocRedlinePreview's panelTab).
          <button type="button" className={styles.panelTab ?? ''} aria-label="Hiện chú giải" onClick={togglePanel}>
            {findings.length}
          </button>
        )}
      </div>
    </>
  );

  // Fullscreen bật: overlay thật render qua createPortal lên document.body
  // (lý do containing-block — xem docblock đầu file), root TẠI CHỖ chỉ còn
  // placeholder gọn để layout khung bao quanh (workspace/modal) không sập —
  // KHÔNG render `content` ở cả 2 nơi cùng lúc, viewer nặng (mục "LƯU Ý kỹ
  // thuật" wp18.yaml).
  if (fullscreen) {
    return (
      <>
        <div className={styles.root}>
          <div className={styles.message}>Đang xem toàn màn hình…</div>
        </div>
        {createPortal(
          <div className={styles.fullscreen} data-testid="fs-overlay" role="dialog" aria-modal="true" aria-label={`${title} — toàn màn hình`}>
            {content}
          </div>,
          document.body,
        )}
      </>
    );
  }

  return <div className={styles.root}>{content}</div>;
}
