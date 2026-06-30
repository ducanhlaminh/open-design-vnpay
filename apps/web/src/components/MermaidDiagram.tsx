// Renders a Mermaid diagram source to SVG. Mermaid is dynamically imported so
// it never runs during SSR and stays out of the main bundle until used.
//
// The diagram is wrapped in a zoom/pan viewport so large flow/journey specs are
// actually readable: wheel zooms toward the cursor, drag pans, and the toolbar
// exposes zoom in/out/reset-fit. The rendered SVG is positioned by a single
// transform on an inner layer (translate + scale, origin 0 0) — no scrollbars,
// no layout thrash per frame.
import { useCallback, useEffect, useRef, useState } from 'react';

let initialized: string | null = null;
let seq = 0;

const MIN_SCALE = 0.1;
const MAX_SCALE = 8;
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

function prefersDark(): boolean {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return false;
  }
}

export function MermaidDiagram({ code }: { code: string }) {
  const hostRef = useRef<HTMLDivElement>(null); // clipped viewport + wheel/pan target
  const innerRef = useRef<HTMLDivElement>(null); // transformed layer holding the SVG
  const [error, setError] = useState<string | null>(null);
  const [scaleLabel, setScaleLabel] = useState(100);

  // Mutable view state — kept in a ref so wheel/pointer handlers never read a
  // stale closure and panning does not trigger React re-renders per frame.
  const view = useRef({ scale: 1, x: 0, y: 0 });

  const applyTransform = useCallback(() => {
    const inner = innerRef.current;
    if (!inner) return;
    const v = view.current;
    inner.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.scale})`;
  }, []);

  const setScale = useCallback(
    (next: number) => {
      view.current.scale = clamp(next, MIN_SCALE, MAX_SCALE);
      applyTransform();
      setScaleLabel(Math.round(view.current.scale * 100));
    },
    [applyTransform],
  );

  // Fit the diagram into the viewport and center it (used on first render and
  // by the reset button). Measures the SVG at natural size.
  const fit = useCallback(() => {
    const host = hostRef.current;
    const inner = innerRef.current;
    const svg = inner?.querySelector('svg');
    if (!host || !inner || !svg) return;
    // Neutralise mermaid's max-width clamp so the SVG reports its natural size,
    // and reset the transform before measuring.
    svg.style.maxWidth = 'none';
    view.current = { scale: 1, x: 0, y: 0 };
    applyTransform();
    const sb = svg.getBoundingClientRect();
    const hb = host.getBoundingClientRect();
    if (sb.width === 0 || sb.height === 0) return;
    const pad = 32;
    const scale = clamp(
      Math.min((hb.width - pad) / sb.width, (hb.height - pad) / sb.height, 1),
      MIN_SCALE,
      MAX_SCALE,
    );
    view.current = {
      scale,
      x: (hb.width - sb.width * scale) / 2,
      y: (hb.height - sb.height * scale) / 2,
    };
    applyTransform();
    setScaleLabel(Math.round(scale * 100));
  }, [applyTransform]);

  // Render mermaid → SVG, then fit.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const mermaid = (await import('mermaid')).default;
        const theme = prefersDark() ? 'dark' : 'neutral';
        if (initialized !== theme) {
          mermaid.initialize({ startOnLoad: false, theme, securityLevel: 'loose', fontFamily: 'inherit' });
          initialized = theme;
        }
        seq += 1;
        const { svg } = await mermaid.render(`mmd-${seq}`, code);
        if (cancelled || !innerRef.current) return;
        innerRef.current.innerHTML = svg;
        setError(null);
        // Pin the SVG to its intrinsic pixel size. Mermaid emits `width:100%` +
        // an inline `max-width`, which makes the diagram collapse/stretch inside
        // a shrink-wrapped zoom layer (the "broken on zoom" symptom). Locking it
        // to the viewBox size keeps it self-contained and crisp while scaled.
        const el = innerRef.current.querySelector('svg');
        if (el) {
          const vb = el.viewBox.baseVal;
          const w = vb && vb.width ? vb.width : el.getBoundingClientRect().width;
          const h = vb && vb.height ? vb.height : el.getBoundingClientRect().height;
          el.style.maxWidth = 'none';
          el.style.width = `${w}px`;
          el.style.height = `${h}px`;
          el.style.display = 'block';
        }
        // Wait one frame so the SVG is laid out before measuring for fit.
        requestAnimationFrame(() => {
          if (!cancelled) fit();
        });
      } catch (e: unknown) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code, fit]);

  // Wheel-to-zoom toward the cursor. Attached as a non-passive listener so we
  // can preventDefault (React's onWheel is passive and cannot block page zoom).
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = host.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const v = view.current;
      const factor = Math.exp(-e.deltaY * 0.0015);
      const next = clamp(v.scale * factor, MIN_SCALE, MAX_SCALE);
      if (next === v.scale) return;
      // Keep the content point under the cursor fixed on screen.
      v.x = cx - ((cx - v.x) / v.scale) * next;
      v.y = cy - ((cy - v.y) / v.scale) * next;
      v.scale = next;
      applyTransform();
      setScaleLabel(Math.round(next * 100));
    };
    host.addEventListener('wheel', onWheel, { passive: false });
    return () => host.removeEventListener('wheel', onWheel);
  }, [applyTransform]);

  // Drag to pan.
  const drag = useRef<{ id: number; x: number; y: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    view.current.x += e.clientX - d.x;
    view.current.y += e.clientY - d.y;
    d.x = e.clientX;
    d.y = e.clientY;
    applyTransform();
  };
  const endPan = (e: React.PointerEvent<HTMLDivElement>) => {
    if (drag.current?.id === e.pointerId) drag.current = null;
  };

  const zoomFromCenter = useCallback(
    (factor: number) => {
      const host = hostRef.current;
      if (!host) return setScale(view.current.scale * factor);
      const hb = host.getBoundingClientRect();
      const cx = hb.width / 2;
      const cy = hb.height / 2;
      const v = view.current;
      const next = clamp(v.scale * factor, MIN_SCALE, MAX_SCALE);
      if (next === v.scale) return;
      v.x = cx - ((cx - v.x) / v.scale) * next;
      v.y = cy - ((cy - v.y) / v.scale) * next;
      v.scale = next;
      applyTransform();
      setScaleLabel(Math.round(next * 100));
    },
    [applyTransform, setScale],
  );

  if (error) {
    return (
      <div style={{ padding: 12, fontSize: 12, color: 'var(--red, #dc2626)' }}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>Mermaid error: {error}</div>
        <pre
          style={{
            whiteSpace: 'pre-wrap',
            fontFamily: 'var(--mono, monospace)',
            opacity: 0.8,
            margin: 0,
          }}
        >
          {code}
        </pre>
      </div>
    );
  }

  const btn: React.CSSProperties = {
    width: 28,
    height: 28,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: '1px solid var(--border, #e2e8f0)',
    background: 'var(--bg, #fff)',
    color: 'var(--fg, #1f2430)',
    borderRadius: 6,
    cursor: 'pointer',
    fontSize: 15,
    lineHeight: 1,
    padding: 0,
  };

  return (
    <div ref={hostRef} style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden' }}>
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPan}
        onPointerCancel={endPan}
        onDoubleClick={fit}
        style={{ position: 'absolute', inset: 0, cursor: 'grab', touchAction: 'none' }}
      >
        <div ref={innerRef} style={{ transformOrigin: '0 0', willChange: 'transform' }} />
      </div>
      <div
        style={{
          position: 'absolute',
          top: 12,
          right: 12,
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          padding: 4,
          borderRadius: 8,
          background: 'var(--bg, #fff)',
          border: '1px solid var(--border, #e2e8f0)',
          boxShadow: '0 2px 8px rgba(15,23,42,0.08)',
        }}
      >
        <button type="button" style={btn} title="Zoom out" aria-label="Zoom out" onClick={() => zoomFromCenter(1 / 1.2)}>
          −
        </button>
        <button
          type="button"
          style={{ ...btn, width: 'auto', minWidth: 48, padding: '0 8px', fontSize: 12, fontVariantNumeric: 'tabular-nums' }}
          title="Reset / fit"
          aria-label="Reset zoom and fit"
          onClick={fit}
        >
          {scaleLabel}%
        </button>
        <button type="button" style={btn} title="Zoom in" aria-label="Zoom in" onClick={() => zoomFromCenter(1.2)}>
          +
        </button>
      </div>
    </div>
  );
}
