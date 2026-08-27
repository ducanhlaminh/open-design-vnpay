// MockupsPreview — khung nhìn bước "Mockup màn" (dr-mockup, docs-review, WP
// dr-mockup 2026-08-27) cho `docs-review/mockups/index.json`: rail trái liệt
// kê màn (tên, nền tảng, badge "đề xuất" khi màn sinh từ bản Cải thiện), khung
// phải là `<iframe sandbox="allow-scripts" srcdoc>` nạp HTML concept layout
// của màn đang chọn (tải lười, cache theo key + mtime của index).
//
// Điều hướng giữa màn: HTML của agent đánh `data-nav="<SCREEN-KEY>"` lên vùng
// dẫn sang màn khác. Host KHÔNG đọc DOM trong iframe (sandbox không có
// allow-same-origin nên cũng không đọc được) — thay vào đó chèn vào srcdoc một
// `<script>` nhỏ bắt click phần tử có `data-nav` rồi
// `parent.postMessage({type:'od-mockup-nav', key}, '*')`; host lắng nghe,
// chỉ nhận message từ đúng iframe của mình và key có trong index, rồi chọn
// màn đích + đẩy lịch sử để nút "Quay lại" hoạt động. HTML đã qua
// `validateMockups` của daemon (không script/link/img ngoài) nên script duy
// nhất chạy trong iframe là script điều hướng này.
//
// Toàn màn hình: overlay CSS `position:fixed` render qua `createPortal` lên
// document.body (cùng lý do containing-block như FlowUxReviewPreview — tổ tiên
// có transform/backdrop-filter neo sai inset:0), KHÔNG dùng Fullscreen API.

import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import type { ProjectFile } from '../types';

import { fetchProjectFileText, projectRawUrl } from '../providers/registry';
import styles from './MockupsPreview.module.css';

/** Một dòng trong `mockups/index.json[].screens` (contract WP dr-mockup). */
export interface MockupScreenEntry {
  key: string;
  name: string;
  /** Đường dẫn HTML — tương đối so với thư mục `mockups/` (vd `SCR-001.html`);
   *  daemon có thể ghi kèm tiền tố `mockups/`, preview chấp nhận cả hai. */
  file: string;
  platform?: string;
  provenance?: string;
  navOut?: string[];
  notes?: string;
}
export interface MockupsIndexDoc {
  schema_version: 1;
  generatedAt?: string;
  variant?: string;
  screens: MockupScreenEntry[];
}

/** Shape guard cho FileViewer: đúng `mockups/index.json` v1. Khoan dung với
 *  field lạ; mỗi màn tối thiểu phải có `key` + `file` (name thiếu → dùng key). */
export function isMockupsIndexDoc(value: unknown): value is MockupsIndexDoc {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const doc = value as Record<string, unknown>;
  if (doc.schema_version !== 1) return false;
  if (!Array.isArray(doc.screens)) return false;
  return doc.screens.every(
    (s) => !!s && typeof s === 'object' && typeof (s as MockupScreenEntry).key === 'string' && typeof (s as MockupScreenEntry).file === 'string',
  );
}

const INDEX_FILE_RE = /(^|\/)mockups\/index\.json$/i;

/** `<wf>/mockups/index.json` → mở MockupsPreview (FileViewer dispatch theo
 *  ĐƯỜNG DẪN, trước nhánh JSON chung). */
export function isMockupsIndexFile(file: Pick<ProjectFile, 'name'>): boolean {
  return INDEX_FILE_RE.test(file.name);
}

/** Thư mục `mockups/` (có dấu `/` cuối) của file index. */
export function mockupsDirOf(fileName: string): string {
  return fileName.replace(/index\.json$/i, '');
}

/** Đường dẫn HTML của một màn trong project: entry.file tương đối so với
 *  `mockups/`, hoặc đã mang tiền tố `mockups/` (bỏ tiền tố để không nhân đôi). */
export function mockupScreenPath(dir: string, entry: Pick<MockupScreenEntry, 'file'>): string {
  const rel = entry.file.replace(/^\.?\//, '').replace(/^mockups\//i, '');
  return `${dir}${rel}`;
}

export type MockupLayout = 'mobile' | 'web';

/** `data-layout` trên `<body>` của HTML thắng; không có thì suy từ
 *  `platform` của index (web → web, còn lại mobile). */
export function mockupLayoutOf(html: string | null, entry: Pick<MockupScreenEntry, 'platform'>): MockupLayout {
  const m = html ? /<body\b[^>]*\bdata-layout\s*=\s*["']?(mobile|web)\b/i.exec(html) : null;
  if (m) return m[1]!.toLowerCase() as MockupLayout;
  return /web|desktop/i.test(entry.platform ?? '') ? 'web' : 'mobile';
}

function platformLabel(platform: string | undefined): string | null {
  if (!platform) return null;
  if (/web|desktop|ib/i.test(platform)) return 'Web';
  if (/mobile|app|mb|ios|android/i.test(platform)) return 'App';
  return platform;
}

/** Script điều hướng chèn vào srcdoc — chạy trong sandbox `allow-scripts`
 *  (không same-origin), chỉ có thể postMessage ra host. */
export const NAV_SCRIPT =
  '<script>(function(){document.addEventListener("click",function(ev){var t=ev.target;' +
  'var el=t&&t.closest?t.closest("[data-nav]"):null;if(!el)return;ev.preventDefault();' +
  'var key=el.getAttribute("data-nav");if(key&&window.parent)window.parent.postMessage({type:"od-mockup-nav",key:key},"*");},true);})();</script>';

/** Ghép script điều hướng vào HTML màn (trước `</body>`, không có thì nối đuôi). */
export function withNavScript(html: string): string {
  const idx = html.search(/<\/body\s*>/i);
  return idx >= 0 ? html.slice(0, idx) + NAV_SCRIPT + html.slice(idx) : html + NAV_SCRIPT;
}

type Loaded = { doc: MockupsIndexDoc | null; error: string | null };

export function MockupsPreview({ projectId, file }: { projectId: string; file: ProjectFile }) {
  const dir = useMemo(() => mockupsDirOf(file.name), [file.name]);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  // Cache HTML theo `${key}@${mtime}` — chạy lại bước (mtime đổi) làm rỗng cache.
  const [htmlByKey, setHtmlByKey] = useState<Record<string, string | null>>({});
  const [fullscreen, setFullscreen] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const cacheTag = `${file.mtime ?? 0}`;

  // Tải index.
  useEffect(() => {
    let cancelled = false;
    setLoaded(null);
    setActiveKey(null);
    setHistory([]);
    setHtmlByKey({});
    void (async () => {
      const raw = await fetchProjectFileText(projectId, file.name, { cache: 'no-store', cacheBustKey: file.mtime });
      if (cancelled) return;
      if (raw == null) {
        setLoaded({ doc: null, error: 'Không đọc được mockups/index.json.' });
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        setLoaded({ doc: null, error: 'mockups/index.json không phải JSON hợp lệ.' });
        return;
      }
      if (!isMockupsIndexDoc(parsed)) {
        setLoaded({ doc: null, error: 'mockups/index.json không đúng định dạng (schema_version 1, screens[]).' });
        return;
      }
      setLoaded({ doc: parsed, error: null });
      setActiveKey(parsed.screens[0]?.key ?? null);
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, file.name, file.mtime]);

  const doc = loaded?.doc ?? null;
  const screens = doc?.screens ?? [];
  const byKey = useMemo(() => new Map(screens.map((s) => [s.key, s] as const)), [screens]);
  const active = activeKey ? byKey.get(activeKey) ?? null : null;
  const activeCacheKey = active ? `${active.key}@${cacheTag}` : null;
  const activeHtml = activeCacheKey ? htmlByKey[activeCacheKey] : undefined;

  // Tải lười HTML màn đang chọn (một lần / key / mtime).
  useEffect(() => {
    if (!active || !activeCacheKey || activeHtml !== undefined) return undefined;
    let cancelled = false;
    void (async () => {
      const raw = await fetchProjectFileText(projectId, mockupScreenPath(dir, active), { cache: 'no-store', cacheBustKey: file.mtime });
      if (cancelled) return;
      setHtmlByKey((prev) => (prev[activeCacheKey] !== undefined ? prev : { ...prev, [activeCacheKey]: raw }));
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, dir, active, activeCacheKey, activeHtml, file.mtime]);

  function go(key: string) {
    if (!byKey.has(key) || key === activeKey) return;
    setHistory((prev) => (activeKey ? [...prev, activeKey] : prev));
    setActiveKey(key);
  }
  function back() {
    setHistory((prev) => {
      if (prev.length === 0) return prev;
      const next = prev.slice(0, -1);
      setActiveKey(prev[prev.length - 1]!);
      return next;
    });
  }

  // Nhận điều hướng từ iframe. Chỉ tin message từ đúng iframe của mình (khi
  // trình duyệt gắn `source`) và key có trong index — HTML không thể ép host
  // mở thứ ngoài danh sách màn.
  useEffect(() => {
    const onMessage = (ev: MessageEvent) => {
      const data = ev.data as { type?: unknown; key?: unknown } | null;
      if (!data || data.type !== 'od-mockup-nav' || typeof data.key !== 'string') return;
      const frameWin = iframeRef.current?.contentWindow ?? null;
      if (ev.source && frameWin && ev.source !== frameWin) return;
      go(data.key);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [byKey, activeKey]);

  // Esc thoát toàn màn hình + khoá cuộn trang phía sau khi overlay mở.
  useEffect(() => {
    if (!fullscreen) return undefined;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') setFullscreen(false);
    };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [fullscreen]);

  const layout: MockupLayout = mockupLayoutOf(activeHtml ?? null, active ?? {});
  const srcDoc = activeHtml ? withNavScript(activeHtml) : null;
  const rawHref = active ? projectRawUrl(projectId, mockupScreenPath(dir, active)) : null;

  let stage: ReactElement;
  if (loaded === null) {
    stage = <div className={styles.message}>Đang tải…</div>;
  } else if (loaded.error) {
    stage = <div className={`${styles.message} ${styles.messageError}`}>{loaded.error}</div>;
  } else if (screens.length === 0) {
    stage = <div className={styles.message}>Chưa có màn nào trong mockups/index.json — chạy lại bước Mockup màn.</div>;
  } else if (!active) {
    stage = <div className={styles.message}>Chọn một màn ở danh sách bên trái.</div>;
  } else if (activeHtml === undefined) {
    stage = <div className={styles.message}>Đang tải màn {active.name || active.key}…</div>;
  } else if (activeHtml === null) {
    stage = (
      <div className={`${styles.message} ${styles.messageError}`} data-testid="mockup-missing">
        Thiếu file màn <code>{mockupScreenPath(dir, active)}</code> — chạy lại bước Mockup màn.
      </div>
    );
  } else {
    stage = (
      <iframe
        ref={iframeRef}
        key={activeCacheKey ?? 'frame'}
        title={`Mockup ${active.name || active.key}`}
        data-testid="mockup-frame"
        data-layout={layout}
        className={`${styles.frame} ${layout === 'mobile' ? styles.frameMobile : styles.frameWeb}`}
        sandbox="allow-scripts"
        srcDoc={srcDoc ?? ''}
      />
    );
  }

  const content = (
    <>
      <div className={styles.head}>
        <button type="button" className={styles.btn} onClick={back} disabled={history.length === 0} data-testid="mockup-back">
          ← Quay lại
        </button>
        <h3 className={styles.title} data-testid="mockup-title">
          {active ? active.name || active.key : 'Mockup màn'}
        </h3>
        {active?.provenance === 'proposed' ? <span className={`${styles.badge} ${styles.badgeProposed}`}>đề xuất</span> : null}
        {doc?.variant ? <span className={styles.meta}>Bản: {doc.variant === 'improved' ? 'Cải thiện' : doc.variant === 'original' ? 'Nguyên bản' : doc.variant}</span> : null}
        <div className={styles.headRight}>
          {rawHref ? (
            <a className={styles.btn} href={rawHref} target="_blank" rel="noreferrer" data-testid="mockup-open-html">
              Mở HTML
            </a>
          ) : null}
          <button type="button" className={styles.btn} onClick={() => setFullscreen((v) => !v)} data-testid="mockup-fullscreen">
            {fullscreen ? 'Thoát' : 'Toàn màn hình'}
          </button>
        </div>
      </div>
      <div className={styles.body}>
        <nav className={styles.rail} aria-label="Danh sách màn">
          <div className={styles.railHead}>Màn ({screens.length})</div>
          {screens.map((s) => {
            const pl = platformLabel(s.platform);
            return (
              <button
                key={s.key}
                type="button"
                className={`${styles.railItem}${s.key === activeKey ? ` ${styles.railItemActive}` : ''}`}
                aria-current={s.key === activeKey ? 'true' : undefined}
                onClick={() => go(s.key)}
                data-testid={`mockup-rail-${s.key}`}
              >
                <span className={styles.railName}>
                  {s.name || s.key}
                  {s.name ? (
                    <>
                      {' '}
                      <span className={styles.railKey}>{s.key}</span>
                    </>
                  ) : null}
                </span>
                {pl ? <span className={styles.badge}>{pl}</span> : null}
                {s.provenance === 'proposed' ? <span className={`${styles.badge} ${styles.badgeProposed}`}>đề xuất</span> : null}
              </button>
            );
          })}
        </nav>
        <div className={styles.stage}>{stage}</div>
      </div>
    </>
  );

  if (fullscreen) {
    return (
      <>
        <div className={styles.root}>
          <div className={styles.message}>Đang xem toàn màn hình…</div>
        </div>
        {createPortal(
          <div className={styles.fullscreen} data-testid="fs-overlay" role="dialog" aria-modal="true" aria-label="Mockup màn — toàn màn hình">
            {content}
          </div>,
          document.body,
        )}
      </>
    );
  }
  return <div className={styles.root}>{content}</div>;
}
