// Khung nhìn "Đánh giá luồng UX" (bước dr-flow bản mới của docs-review) cho
// các file dưới `flows/<FLOW-ID>/`: sơ đồ GỐC render bằng đúng viewer của
// draw.io (hoặc Mermaid), Hiện trạng và Đề xuất (phần sửa đã được daemon tô
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
// vậy mọi <DrawioViewer> ở đây đều truyền `options={{ toolbar: 'zoom' }}` để
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
// Hiện trạng | Đề xuất) hoặc `as-is.drawio`, `as-is.mmd` / `proposed.mmd` /
// `as-is.svg` cho Mermaid, và `flows/index.json` cho tiêu đề + patchSkipped.

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { ProjectFile } from '../types';

import { fetchProjectFileText } from '../providers/registry';
import { DrawioViewer } from './DrawioViewer';
import { MermaidDiagram } from './MermaidDiagram';
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

interface IndexEntry {
  id: string;
  title?: string;
  source?: string;
  kind?: 'drawio' | 'mermaid' | 'text';
  note?: string;
  hasProposal?: boolean;
  files?: { asIs?: string; proposed?: string; review?: string; flowchart?: string; svg?: string };
  patchSkipped?: { op: { op?: string; cell?: string; id?: string; edge?: string }; reason: string }[];
}

const SEVERITY_ORDER: UxSeverity[] = ['blocker', 'major', 'minor', 'note'];
const SEVERITY_LABEL: Record<UxSeverity, string> = { blocker: 'Chặn', major: 'Nặng', minor: 'Nhẹ', note: 'Ghi chú' };
const VERDICT_LABEL: Record<UxVerdict, string> = { good: 'Luồng tốt', 'needs-improvement': 'Cần cải thiện', poor: 'Chưa đạt' };
const CHANGE_LABEL: Record<Exclude<UxChange, 'none'>, string> = { added: 'Thêm mới', modified: 'Sửa đổi', removed: 'Đề nghị bỏ' };

const FLOW_FILE_RE = /^(.*?)flows\/([^/]+)\/(ux-review\.json|proposed\.drawio|as-is\.drawio|proposed\.mmd|as-is\.mmd|as-is\.svg|patch\.json|screens\.json|cells\.json)$/i;
/** `flows/<FLOW-ID>.flowchart.json` — the derived block diagram; opens the same
 *  view when the new-format folder exists, else the caller's `fallback`. */
const FLOWCHART_FILE_RE = /^(.*?)flows\/([^/]+)\.flowchart\.json$/i;

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
    const get = (rel: string) => fetchProjectFileText(projectId, rel);
    void (async () => {
      const [reviewRaw, indexRaw, proposedDrawio, asIsDrawio, mmdAsIs, mmdProposed, svg] = await Promise.all([
        get(`${loc.dir}ux-review.json`),
        get(`${loc.flowsDir}index.json`),
        get(`${loc.dir}proposed.drawio`),
        get(`${loc.dir}as-is.drawio`),
        get(`${loc.dir}as-is.mmd`),
        get(`${loc.dir}proposed.mmd`),
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
      // Mặc định mở "Đề xuất" khi có — đó là thứ người review cần xem trước.
      setMode(loaded.drawioHasProposal || loaded.mermaidProposed ? 'proposed' : 'as-is');
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, loc, file.mtime]);

  const findings = data?.review?.findings ?? [];
  const active = useMemo(() => findings.find((f) => f.id === activeId) ?? null, [findings, activeId]);
  const highlightCells = useMemo(() => {
    if (!active?.cells) return [] as string[];
    return mode === 'proposed' ? [...(active.cells.proposed ?? active.cells.asIs ?? [])] : [...(active.cells.asIs ?? [])];
  }, [active, mode]);
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
  const kind: IndexEntry['kind'] = data.index?.kind ?? (data.drawioXml ? 'drawio' : data.mermaidAsIs ? 'mermaid' : 'text');
  const hasProposal = kind === 'drawio' ? data.drawioHasProposal : kind === 'mermaid' ? !!data.mermaidProposed : false;
  // Không có bản đề xuất thì không có gì để đối chiếu — ép về 'single' bất kể
  // localStorage lưu gì (WP17a do mục 1).
  const effectiveLayout: LayoutMode = hasProposal ? layout : 'single';
  const counts = SEVERITY_ORDER.map((s) => [s, findings.filter((f) => f.severity === s).length] as const).filter(([, n]) => n > 0);

  const onCellClick = (cellId: string | null) => {
    if (!cellId) return;
    const hit = cellToFinding.get(`${mode === 'proposed' ? 'proposed' : 'as-is'}:${cellId}`) ?? cellToFinding.get(`as-is:${cellId}`) ?? cellToFinding.get(`proposed:${cellId}`);
    if (hit) setActiveId(hit);
  };
  // Bố cục cạnh nhau: khung trái highlight cells.asIs, khung phải highlight
  // cells.proposed — KHÔNG fallback chéo (cả 2 khung đang hiện cùng lúc, khác
  // với mode đơn ở single chỉ có một khung nên fallback mới hợp lý).
  const sideLeftHighlight = active?.cells?.asIs ? [...active.cells.asIs] : [];
  const sideRightHighlight = active?.cells?.proposed ? [...active.cells.proposed] : [];
  const onSideLeftCellClick = (cellId: string | null) => {
    if (!cellId) return;
    const hit = cellToFinding.get(`as-is:${cellId}`) ?? cellToFinding.get(`proposed:${cellId}`);
    if (hit) {
      setActiveId(hit);
      openPanel(); // bấm cell khi panel đang ẩn → mở panel + chọn finding.
    }
  };
  const onSideRightCellClick = (cellId: string | null) => {
    if (!cellId) return;
    const hit = cellToFinding.get(`proposed:${cellId}`) ?? cellToFinding.get(`as-is:${cellId}`);
    if (hit) {
      setActiveId(hit);
      openPanel();
    }
  };
  // Chip cell trên card finding: ở bố cục cạnh nhau ưu tiên cells.proposed
  // (như mode 'proposed' hôm nay), vì cả 2 khung đang hiện nên "bản mới" là
  // thứ đáng chỉ ra trước.
  const cardCellsFor = (f: UxFinding): string[] =>
    effectiveLayout === 'side' || mode === 'proposed' ? f.cells?.proposed ?? f.cells?.asIs ?? [] : f.cells?.asIs ?? [];

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

      <div className={`${styles.body} ${panelOpen ? '' : styles.bodyPanelHidden ?? ''}`}>
        <section className={styles.diagram} aria-label="Sơ đồ luồng">
          <div className={styles.diagramBar}>
            {effectiveLayout === 'single' ? (
              <div className={styles.modeBar} role="tablist" aria-label="Chế độ xem sơ đồ">
                <button type="button" role="tab" aria-selected={mode === 'as-is'} className={`${styles.modeBtn} ${mode === 'as-is' ? styles.modeBtnActive : ''}`} onClick={() => setMode('as-is')}>
                  Hiện trạng
                </button>
                {hasProposal ? (
                  <button type="button" role="tab" aria-selected={mode === 'proposed'} className={`${styles.modeBtn} ${mode === 'proposed' ? styles.modeBtnActive : ''}`} onClick={() => setMode('proposed')}>
                    Đề xuất
                  </button>
                ) : null}
                {kind === 'mermaid' && data.svg ? (
                  <button type="button" role="tab" aria-selected={mode === 'svg'} className={`${styles.modeBtn} ${mode === 'svg' ? styles.modeBtnActive : ''}`} onClick={() => setMode('svg')}>
                    Ảnh gốc
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
          <div className={`${styles.diagramBox} ${effectiveLayout === 'side' ? styles.diagramBoxSide ?? '' : ''}`}>
            {effectiveLayout === 'side' ? (
              // Hai khung ĐỘC LẬP (không đồng bộ pan/zoom — xem docblock đầu
              // file): mỗi bên tự nhận highlight + tự cuộn tới cell của mình
              // khi bấm một finding.
              <div className={styles.sideWrap}>
                <div className={styles.sidePane} data-testid="side-pane-left">
                  <div className={styles.sidePaneHead}>
                    <h3 className={styles.paneTitle}>Hiện trạng</h3>
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
                            options={{ toolbar: 'zoom' }}
                          />
                        ) : null}
                        {kind === 'mermaid' ? <MermaidDiagram code={data.mermaidAsIs ?? ''} initialFit="width" /> : null}
                      </>
                    )}
                  </div>
                </div>
                <div className={styles.sidePane} data-testid="side-pane-right">
                  <div className={styles.sidePaneHead}>
                    <h3 className={styles.paneTitle}>Đề xuất</h3>
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
                            onCellClick={onSideRightCellClick}
                            options={{ toolbar: 'zoom' }}
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
                {kind === 'drawio' && data.drawioXml ? (
                  <DrawioViewer
                    key={`single-${fullscreen}`}
                    className={styles.drawio}
                    xml={data.drawioXml}
                    page={mode === 'proposed' && data.drawioHasProposal ? 1 : 0}
                    highlightCells={highlightCells}
                    onCellClick={onCellClick}
                    options={{ toolbar: 'zoom' }}
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

        {panelOpen ? (
          <aside className={styles.panel} aria-label="Lý do UX">
            <div className={styles.panelHead}>
              <span>Phát hiện UX</span>
              <span className={styles.panelMeta}>{findings.length}</span>
              <button type="button" className={styles.panelToggleBtn ?? ''} aria-label="Ẩn chú giải" onClick={togglePanel}>
                Ẩn ]
              </button>
            </div>
            {!data.review ? (
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
                  const toggleSelect = () => setActiveId(isActive ? null : f.id);
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
