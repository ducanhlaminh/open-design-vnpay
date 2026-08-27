// Editor draw.io nhúng TẠI CHỖ cho sơ đồ "Luồng màn hình" (dr-flow mới):
// iframe https://embed.diagrams.net (?embed=1&proto=json — giao thức
// postMessage chính chủ của draw.io, cùng cơ chế next-ai-draw-io) lấp đầy
// khung sơ đồ của FlowUxReviewPreview KHI người dùng bật "Chỉnh sửa" (mặc
// định vẫn là viewer tĩnh — không cần mạng tới embed). Kéo node, sửa
// nhãn, nối/uốn lại cạnh bằng chính UI draw.io thật; thay đổi TỰ LƯU về daemon
// (debounce sau lần sửa cuối) — không cần bấm gì, Ctrl+S trong editor lưu ngay.
//
// Giao thức (kiểm chứng ở PoC 2026-08-27):
//   editor → {event:'init'}           → ta post {action:'load', xml, autosave:1}
//   editor → {event:'autosave', xml}  → onChange(xml) + hẹn giờ lưu (AUTOSAVE_DELAY_MS)
//   editor → {event:'save', xml}      → lưu ngay
//
// `xml` chỉ được đọc MỘT lần lúc mount (nạp vào editor) — cha thay prop sau đó
// không nạp lại (sẽ đè bản đang sửa); muốn nạp bản khác thì remount bằng key.
// Cần mạng tới embed.diagrams.net — cùng giả định online như DrawioViewer
// (fallback CDN). Node id KHÔNG đổi khi kéo/sửa nhãn nên mapping màn
// (screens.json cells) sống sót qua mọi lần sửa tay.
//
// WP dr-flow-edit-highlight (2026-08-27) — mở ĐÚNG trang đang xem: mxfile 2
// trang (Nguyên bản | Cải thiện) nạp qua `{action:'load'}` luôn mở trang 0,
// thanh tab trang của `ui=min` nằm sát đáy nên người dùng tưởng "không sửa được
// bản Cải thiện". PoC (Playwright, embed.diagrams.net thật): URL param `page=N`
// CÓ hiệu lực với `{action:'load', xml}` — `page=1` → currentPage 1, export
// SVG là nội dung trang Đề xuất — nên chỉ cần nối `&page=${page}` vào src.
// LƯU Ý: mxfile gửi về daemon (`onSave`) PHẢI GIỮ NGUYÊN THỨ TỰ TRANG — daemon
// `saveScreenFlowEdit` map theo index (`pages[0]` = as-is, `pages[1]` =
// proposed); editor chỉ đổi trang đang hiện, không sắp lại `<diagram>`.
import { useCallback, useEffect, useRef, useState } from 'react';

import styles from './DrawioEditor.module.css';

export const EMBED_URL = 'https://embed.diagrams.net/?embed=1&proto=json&spin=1&libraries=0&noExitBtn=1&ui=min';
const AUTOSAVE_DELAY_MS = 1500;

export type DrawioEditorSaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

export function DrawioEditor({
  xml,
  title,
  onSave,
  onChange,
  className,
  page = 0,
  pageName,
}: {
  /** mxfile XML nạp vào editor lúc mount. */
  xml: string;
  title: string;
  /** Trang mở sẵn trong editor (0-based, mặc định 0) — qua URL param `page`
   *  của embed (xem docblock). Đổi trang = remount bằng key. */
  page?: number;
  /** Tên trang đang sửa (vd "Cải thiện") → chip trạng thái có tiền tố
   *  `Đang sửa: <tên> · …`. */
  pageName?: string;
  /** Ném lỗi (message hiển thị được) khi lưu thất bại — editor giữ nguyên bản đang sửa. */
  onSave: (editedXml: string) => Promise<void>;
  /** Mỗi lần editor autosave (chưa chắc đã lưu về daemon) — cha giữ bản mới
   *  nhất để remount (toàn màn hình) không rơi về bản cũ. */
  onChange?: (editedXml: string) => void;
  className?: string;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const initialXmlRef = useRef(xml);
  const pendingRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [saveState, setSaveState] = useState<DrawioEditorSaveState>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const doSave = useCallback(async (editedXml: string) => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    pendingRef.current = null;
    setSaveState('saving');
    setSaveError(null);
    try {
      await onSaveRef.current(editedXml);
      // Có sửa tiếp trong lúc đang lưu → vẫn là dirty, đừng báo "Đã lưu".
      setSaveState(pendingRef.current ? 'dirty' : 'saved');
    } catch (err) {
      pendingRef.current = editedXml; // thử lại ở lần autosave kế / Ctrl+S
      setSaveState('error');
      setSaveError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    const onMessage = (ev: MessageEvent) => {
      if (!frameRef.current || ev.source !== frameRef.current.contentWindow) return;
      if (typeof ev.data !== 'string' || !ev.data.length) return;
      let msg: { event?: string; xml?: string };
      try {
        msg = JSON.parse(ev.data) as { event?: string; xml?: string };
      } catch {
        return;
      }
      if (msg.event === 'init') {
        frameRef.current.contentWindow?.postMessage(JSON.stringify({ action: 'load', xml: initialXmlRef.current, autosave: 1 }), '*');
        setReady(true);
      } else if (msg.event === 'autosave' && typeof msg.xml === 'string') {
        pendingRef.current = msg.xml;
        onChangeRef.current?.(msg.xml);
        setSaveState((prev) => (prev === 'saving' ? prev : 'dirty'));
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => {
          timerRef.current = null;
          if (pendingRef.current) void doSave(pendingRef.current);
        }, AUTOSAVE_DELAY_MS);
      } else if (msg.event === 'save' && typeof msg.xml === 'string') {
        void doSave(msg.xml);
      }
    };
    window.addEventListener('message', onMessage);
    return () => {
      window.removeEventListener('message', onMessage);
      // Unmount (đổi file / thoát toàn màn hình) giữa lúc còn hẹn giờ: đẩy
      // bản đang chờ về daemon luôn, không để mất sửa đổi cuối.
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      if (pendingRef.current) void onSaveRef.current(pendingRef.current).catch(() => {});
    };
  }, [doSave]);

  const stateText =
    saveState === 'saving'
      ? 'Đang lưu…'
      : saveState === 'saved'
        ? 'Đã lưu ✓'
        : saveState === 'dirty'
          ? 'Có thay đổi — tự lưu…'
          : saveState === 'error'
            ? `Lưu thất bại: ${saveError ?? ''}`
            : ready
              ? pageName
                ? 'tự lưu'
                : 'Sửa trực tiếp trên sơ đồ — tự lưu'
              : 'Đang mở editor…';
  // Có tên trang → "Đang sửa: Cải thiện · tự lưu" / "Đang sửa: Cải thiện · Đã lưu ✓".
  const stateLabel = pageName ? `Đang sửa: ${pageName} · ${stateText}` : stateText;
  // `page` chỉ đọc lúc mount (như `xml`) — cha đổi trang thì remount bằng key.
  const srcRef = useRef(`${EMBED_URL}&page=${Math.max(0, Math.floor(page))}`);

  return (
    <div className={`${styles.host} ${className ?? ''}`} data-testid="drawio-editor" data-page={page}>
      <span className={styles.state} data-state={saveState} role="status">
        {stateLabel}
      </span>
      <iframe ref={frameRef} className={styles.frame} src={srcRef.current} title={`draw.io editor — ${title}`} />
    </div>
  );
}
