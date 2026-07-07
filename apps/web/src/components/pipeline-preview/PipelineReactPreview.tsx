import { useEffect, useRef, useState } from 'react';
import { projectFileUrl } from '../../providers/registry';
import styles from './PipelineReactPreview.module.css';

// Preview for the docs → React workflow's built app: a single URL-loaded iframe of
// the self-contained `react/dist/index.html`, in a FREELY RESIZABLE frame — no
// hardcoded device bezel. The user drags the corner handle to resize to any size,
// or picks a width preset; a live W×H readout tracks the current size. HashRouter
// navigation inside the app works because the iframe loads from a real file URL.
//
// A custom corner handle (not CSS `resize: both`) is required: an iframe fills the
// frame and would swallow the native resize grip, so we drag via pointer events and
// disable the iframe's pointer-events mid-drag.

const WIDTH_PRESETS: Array<{ label: string; w: number | 'full' }> = [
  { label: 'Mobile', w: 390 },
  { label: 'Tablet', w: 768 },
  { label: 'Desktop', w: 1280 },
  { label: 'Full', w: 'full' },
];

const MIN_W = 320;
const MIN_H = 240;

export function PipelineReactPreview({
  projectId,
  fileName,
  mtime,
}: {
  projectId: string;
  fileName: string;
  mtime?: number;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  // null → frame fills the pane (responsive default); an explicit {w,h} pins it.
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [measured, setMeasured] = useState<{ w: number; h: number } | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
  const url = projectFileUrl(projectId, fileName);

  // Live W×H readout — observe the actual rendered frame (covers both the "fill"
  // default and pinned sizes).
  useEffect(() => {
    const el = frameRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      setMeasured({ w: Math.round(el.clientWidth), h: Math.round(el.clientHeight) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      setSize({
        w: Math.max(MIN_W, d.w + (e.clientX - d.x)),
        h: Math.max(MIN_H, d.h + (e.clientY - d.y)),
      });
    };
    const onUp = () => {
      setDragging(false);
      dragRef.current = null;
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [dragging]);

  const startDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    const cur = size ?? measured ?? { w: 1024, h: 720 };
    dragRef.current = { x: e.clientX, y: e.clientY, w: cur.w, h: cur.h };
    setDragging(true);
  };

  const applyWidth = (w: number | 'full') => {
    const cur = size ?? measured ?? { w: 1024, h: 720 };
    if (w === 'full') {
      const avail = (scrollRef.current?.clientWidth ?? cur.w) - 32; // minus padding
      setSize({ w: Math.max(MIN_W, avail), h: cur.h });
    } else {
      setSize({ w, h: cur.h });
    }
  };

  const dims = size ?? measured;

  return (
    <div className={styles.root}>
      <div className={styles.toolbar}>
        <div className={styles.presets}>
          {WIDTH_PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              className={styles.btn}
              onClick={() => applyWidth(p.w)}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className={styles.spacer} />
        {dims && (
          <span className={styles.dims}>
            {dims.w} × {dims.h}
          </span>
        )}
        <button
          type="button"
          className={styles.btn}
          title="Reload"
          onClick={() => setReloadKey((k) => k + 1)}
        >
          Reload
        </button>
        <a className={styles.btn} href={url} target="_blank" rel="noreferrer" title="Open in new tab">
          Open ↗
        </a>
      </div>
      <div className={styles.scroll} ref={scrollRef}>
        <div
          ref={frameRef}
          className={styles.frame}
          style={size ? { width: size.w, height: size.h } : { width: '100%', height: '100%' }}
        >
          <iframe
            key={`${mtime ?? 0}:${reloadKey}`}
            src={url}
            title="React app preview"
            className={styles.iframe}
            style={{ pointerEvents: dragging ? 'none' : 'auto' }}
          />
          <div
            className={styles.handle}
            onPointerDown={startDrag}
            title="Kéo để resize"
            role="separator"
            aria-label="Resize preview"
          />
        </div>
      </div>
      {dragging && <div className={styles.dragShield} />}
    </div>
  );
}
