// ScreenFlowPanelViewer — sơ đồ "Luồng màn hình" BẢN ĐÃ CHỌN
// (`flows/<SCREEN-FLOW-ID>/selection.json`; vắng = Nguyên bản) hiện trong
// right panel của DocRedlinePreview khi một change/note `kind: 'flow'` (hoặc
// gap/edge-case có `rule_id` trỏ `flows/<SCREEN-FLOW-ID>…`) được mở — WP
// dr-review-screen-flow (2026-08-27), quyết định sản phẩm 2 + 4: bản đã chọn
// là THƯỚC ĐO đối chiếu tài liệu, panel phải cho thấy đúng bản đó và tô cell
// liên quan tới chỗ sửa đang xem.
//
// WP screen-flow-platform-split (2026-08-28): tài liệu ≥2 nền tảng có HAI
// flow `SCREEN-FLOW--app` / `SCREEN-FLOW--web`, mỗi flow selection riêng —
// mọi hàm nhận `flowId` (mặc định `SCREEN-FLOW` = flow đơn, hành vi/URL fetch
// y hệt trước), cache theo flowId.
//
// Nguồn: `original` → `as-is.drawio` (1 trang, page 0); `improved` →
// `proposed.drawio` (2 trang Hiện trạng/Đề xuất, page 1). Fetch qua
// `fetchProjectFileText` như FlowUxReviewPreview, cache MỘT LẦN theo
// project + gốc workflow + flowId (`loadScreenFlowDoc`) — panel mở/đóng
// nhiều lần, và bản in (DocRedlinePreview B3) dùng lại cùng bản, không fetch lại.
//
// "Phóng to": overlay `position: fixed` qua `createPortal(document.body)`
// (cùng lý do containing-block như FlowUxReviewPreview wp18: overlay nằm
// trong khung có transform/overflow của panel sẽ lệch + tràn); viewer trong
// overlay remount bằng key sau 2 khung rAF để GraphViewer đo đúng kích thước
// (bug 0.8.78). Esc/nút Đóng thoát.
//
// Fail-soft: thiếu file → dòng "Chưa có Luồng màn hình", KHÔNG lỗi.
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { fetchProjectFileText } from '../providers/registry';
import { DrawioViewer, type HighlightKind, type HighlightSpec } from './DrawioViewer';
import { SCREEN_FLOW_ID, screenFlowPlatformLabel } from './screen-flow-ids';
import styles from './ScreenFlowPanelViewer.module.css';

export type ScreenFlowVariant = 'original' | 'improved';

export interface ScreenFlowDoc {
  variant: ScreenFlowVariant;
  /** Đường dẫn file draw.io đã dùng (project-root-relative) — bằng chứng/debug. */
  file: string;
  xml: string;
  /** Trang cần hiện: original → 0 (as-is 1 trang), improved → 1 (trang Đề xuất). */
  page: number;
}

export const SCREEN_FLOW_VARIANT_LABEL: Record<ScreenFlowVariant, string> = {
  original: 'Nguyên bản',
  improved: 'Cải thiện',
};

export interface ScreenFlowHighlight {
  cells: readonly string[];
  kind?: HighlightKind;
}

/** Cache theo `${projectId}\0${workflowPrefix}\0${flowId}` — giữ Promise (không
 *  phải kết quả) để hai caller mở cùng lúc (panel + viewer in) chỉ tốn một
 *  lượt fetch. Lỗi mạng → xoá khỏi cache để lần sau thử lại. */
const docCache = new Map<string, Promise<ScreenFlowDoc | null>>();

function cacheKey(projectId: string, workflowPrefix: string, flowId: string): string {
  return `${projectId}\u0000${workflowPrefix}\u0000${flowId}`;
}

/** Quên bản đã cache (chạy lại bước / đổi bản đang dùng). */
export function invalidateScreenFlowDoc(projectId: string, workflowPrefix: string, flowId: string = SCREEN_FLOW_ID): void {
  docCache.delete(cacheKey(projectId, workflowPrefix, flowId));
}

/** Nhận diện một file draw.io thật — mock/fetch trả nhầm nội dung khác (ví dụ
 *  markdown) thì coi như KHÔNG có sơ đồ, không đưa chuỗi rác cho GraphViewer. */
function looksLikeDrawio(raw: string): boolean {
  return /<mxfile\b|<mxGraphModel\b/i.test(raw);
}

/** Đọc `selection.json` khoan dung như daemon `readScreenFlowSelection`: thiếu
 *  file/hỏng/variant lạ → `original`. */
export function parseScreenFlowSelection(raw: string | null): ScreenFlowVariant {
  if (!raw) return 'original';
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && (parsed as { variant?: unknown }).variant === 'improved') return 'improved';
  } catch {
    /* hỏng → original */
  }
  return 'original';
}

/** Nạp sơ đồ Luồng màn hình bản đã chọn — MỘT LẦN theo project + gốc workflow
 *  + flowId (`SCREEN-FLOW` | `SCREEN-FLOW--app` | `SCREEN-FLOW--web`).
 *  `null` khi không có flow (thiếu `as-is.drawio`, hoặc improved mà thiếu
 *  `proposed.drawio` — không rơi về original: bản đã chọn là thước đo,
 *  hiện nhầm bản còn tệ hơn không hiện). */
export function loadScreenFlowDoc(projectId: string, workflowPrefix: string, flowId: string = SCREEN_FLOW_ID): Promise<ScreenFlowDoc | null> {
  const key = cacheKey(projectId, workflowPrefix, flowId);
  const hit = docCache.get(key);
  if (hit) return hit;
  const base = `${workflowPrefix}/flows/${flowId}`;
  const p = (async (): Promise<ScreenFlowDoc | null> => {
    let selectionRaw: string | null = null;
    try {
      selectionRaw = await fetchProjectFileText(projectId, `${base}/selection.json`);
    } catch {
      selectionRaw = null; // 404/lỗi → original
    }
    const variant = parseScreenFlowSelection(selectionRaw);
    const file = variant === 'improved' ? `${base}/proposed.drawio` : `${base}/as-is.drawio`;
    const page = variant === 'improved' ? 1 : 0;
    const raw = await fetchProjectFileText(projectId, file);
    if (!raw || !looksLikeDrawio(raw)) return null;
    return { variant, file, xml: raw, page };
  })().catch(() => {
    docCache.delete(key);
    return null;
  });
  docCache.set(key, p);
  return p;
}

/** Tìm id CẠNH nối `from → to` trên trang `page` của mxfile (mxCell
 *  `edge="1"` có `source`/`target` khớp). `null` khi không thấy — kể cả khi
 *  trang được nén (daemon luôn ghi XML thuần, nén chỉ gặp ở file BA tải lên
 *  và không đi qua đây); caller rơi về tô hai node. */
export function findEdgeCellId(xml: string, page: number, from: string, to: string): string | null {
  if (typeof DOMParser === 'undefined') return null;
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(xml, 'text/xml');
  } catch {
    return null;
  }
  const diagrams = Array.from(doc.getElementsByTagName('diagram'));
  // mxfile không có <diagram> (mxGraphModel trần) → quét cả tài liệu.
  const scope: Element | Document = diagrams.length > 0 ? (diagrams[page] ?? diagrams[0]!) : doc;
  const cells = Array.from(scope.getElementsByTagName('mxCell'));
  for (const cell of cells) {
    if (cell.getAttribute('edge') !== '1') continue;
    if (cell.getAttribute('source') === from && cell.getAttribute('target') === to) {
      const id = cell.getAttribute('id');
      if (id) return id;
    }
  }
  return null;
}

type LoadState = { status: 'loading' } | { status: 'ready'; doc: ScreenFlowDoc } | { status: 'missing' };

/** Hook dùng chung: panel viewer + viewer in offscreen của DocRedlinePreview. */
export function useScreenFlowDoc(projectId: string, workflowPrefix: string, flowId: string = SCREEN_FLOW_ID): LoadState {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    void loadScreenFlowDoc(projectId, workflowPrefix, flowId).then((doc) => {
      if (cancelled) return;
      setState(doc ? { status: 'ready', doc } : { status: 'missing' });
    });
    return () => {
      cancelled = true;
    };
  }, [projectId, workflowPrefix, flowId]);
  return state;
}

export interface ScreenFlowPanelViewerProps {
  projectId: string;
  workflowPrefix: string;
  /** Id thư mục flow (`SCREEN-FLOW` mặc định; `SCREEN-FLOW--app`/`--web` khi
   *  tài liệu tách nền tảng — ref `rule_id` cho biết flow nào). */
  flowId?: string;
  highlight?: ScreenFlowHighlight;
  title?: string;
  /** `true` = chỉ khung viewer (không badge/nút Phóng to) — dùng cho viewer
   *  in offscreen của DocRedlinePreview. */
  bare?: boolean;
  className?: string;
}

const NO_CELLS: readonly string[] = [];

export function ScreenFlowPanelViewer({
  projectId,
  workflowPrefix,
  flowId = SCREEN_FLOW_ID,
  highlight,
  title = 'Luồng màn hình',
  bare = false,
  className,
}: ScreenFlowPanelViewerProps) {
  const load = useScreenFlowDoc(projectId, workflowPrefix, flowId);
  // Badge nền tảng "App"/"Web" theo id thư mục — flow đơn không có badge.
  const platformLabel = screenFlowPlatformLabel(flowId);
  const cells = highlight?.cells ?? NO_CELLS;
  const kind = highlight?.kind;
  // Memo theo NỘI DUNG (id nối chuỗi) — DrawioViewer chạy lại effect highlight
  // theo identity của mảng; cha re-render (poll file) không được làm viền
  // nhấp nháy.
  const cellsKey = cells.join('\u0000');
  const highlightCells = useMemo<readonly HighlightSpec[] | undefined>(() => {
    if (!cellsKey) return undefined;
    const ids = cellsKey.split('\u0000');
    return kind ? ids.map((id) => ({ id, kind })) : ids;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cellsKey, kind]);

  const [fullscreen, setFullscreen] = useState(false);
  const [fsReady, setFsReady] = useState(false);
  useEffect(() => {
    if (!fullscreen) {
      setFsReady(false);
      return undefined;
    }
    if (typeof requestAnimationFrame !== 'function') {
      setFsReady(true);
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
  // Esc đóng overlay — chỉ lắng nghe khi đang mở để không nuốt Esc của UI khác.
  useEffect(() => {
    if (!fullscreen) return undefined;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') setFullscreen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [fullscreen]);
  // Khoá cuộn trang phía sau khi overlay mở (overlay là con của body) + cắm
  // cờ `data-od-screen-flow-fs` để UI chủ (DocRedlinePreview: Esc đóng panel
  // chi tiết) biết nhường Esc cho overlay — hai listener cùng gắn ở document,
  // thứ tự đăng ký không kiểm soát được nên không dựa vào stopPropagation.
  useEffect(() => {
    if (!fullscreen) return undefined;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    document.body.dataset.odScreenFlowFs = '1';
    return () => {
      document.body.style.overflow = prev;
      delete document.body.dataset.odScreenFlowFs;
    };
  }, [fullscreen]);

  if (load.status === 'loading') {
    return <p className={`${styles.hint ?? ''} ${className ?? ''}`.trim()}>Đang tải Luồng màn hình…</p>;
  }
  if (load.status === 'missing') {
    return (
      <p className={`${styles.hint ?? ''} ${className ?? ''}`.trim()} data-testid="screen-flow-missing">
        Chưa có Luồng màn hình
      </p>
    );
  }
  const { doc } = load;
  const variantLabel = SCREEN_FLOW_VARIANT_LABEL[doc.variant];

  const viewer = (key: string) => (
    <DrawioViewer key={key} xml={doc.xml} page={doc.page} highlightCells={highlightCells} className={styles.viewer ?? ''} />
  );

  const platformBadge = platformLabel ? (
    <span className={styles.badge ?? ''} data-testid="screen-flow-platform">
      {platformLabel}
    </span>
  ) : null;

  if (bare) {
    return (
      <div className={`${styles.frame ?? ''} ${className ?? ''}`.trim()} data-testid="screen-flow-viewer" data-variant={doc.variant} data-flow-id={flowId}>
        {viewer('bare')}
      </div>
    );
  }

  return (
    <div className={`${styles.root ?? ''} ${className ?? ''}`.trim()} data-testid="screen-flow-viewer" data-variant={doc.variant} data-flow-id={flowId}>
      <div className={styles.head ?? ''}>
        <span className={styles.title ?? ''}>{title}</span>
        {platformBadge}
        <span className={styles.badge ?? ''} data-testid="screen-flow-variant">
          Bản: {variantLabel}
        </span>
        <button
          type="button"
          className={styles.zoomBtn ?? ''}
          onClick={() => setFullscreen(true)}
          disabled={fullscreen}
          title="Xem sơ đồ toàn màn hình"
        >
          Phóng to
        </button>
      </div>
      <div className={styles.frame ?? ''}>
        {fullscreen ? <div className={styles.hint ?? ''}>Đang xem toàn màn hình…</div> : viewer('inline')}
      </div>
      {fullscreen && typeof document !== 'undefined'
        ? createPortal(
            <div
              className={styles.fullscreen ?? ''}
              data-testid="screen-flow-fs-overlay"
              role="dialog"
              aria-modal="true"
              aria-label={`${title} — toàn màn hình`}
            >
              <div className={styles.fsHead ?? ''}>
                <span className={styles.title ?? ''}>{title}</span>
                {platformBadge}
                <span className={styles.badge ?? ''}>Bản: {variantLabel}</span>
                <span className={styles.fsSpacer ?? ''} />
                <button type="button" className={styles.zoomBtn ?? ''} onClick={() => setFullscreen(false)}>
                  Đóng
                </button>
              </div>
              <div className={styles.fsBody ?? ''}>
                {fsReady ? viewer('fullscreen') : <div className={styles.hint ?? ''}>Đang tải…</div>}
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
