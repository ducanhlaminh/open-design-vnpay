// Interactive draw.io viewer for `.drawio` XML — the same GraphViewer
// (jgraph/drawio `viewer-static.min.js`, Apache-2.0) Confluence embeds, so a
// diagram renders exactly as the document showed it.
//
// The ~4 MB script is loaded lazily and once: first from the daemon
// (`/api/vendor/drawio-viewer.js`, cached on disk there), falling back to the
// official CDN when the daemon cannot fetch it. Nothing renders during SSR.
//
// Beyond plain viewing this exposes what the flow-UX panel needs: which cell
// was clicked (`onCellClick`) and a set of cell ids to highlight
// (`highlightCells`), so the findings list and the diagram select each other.

import { useEffect, useRef, useState } from 'react';

declare global {
  interface Window {
    GraphViewer?: {
      createViewerForElement: (el: HTMLElement, cb?: (viewer: DrawioGraphViewer) => void) => void;
      processElements?: () => void;
    };
    mxCellHighlight?: new (graph: unknown, color: string, strokeWidth: number, dashed?: boolean) => {
      highlight: (state: unknown) => void;
      destroy: () => void;
    };
    STENCIL_PATH?: string;
    SHAPES_PATH?: string;
    STYLE_PATH?: string;
    GRAPH_IMAGE_PATH?: string;
    mxImageBasePath?: string;
    mxBasePath?: string;
    DRAW_MATH_URL?: string;
    PROXY_URL?: string;
  }
}

/** The subset of GraphViewer / mxGraph we touch. */
export interface DrawioMouseEvent {
  getCell: () => { id?: string; getId?: () => string } | null;
  getGraphX: () => number;
  getGraphY: () => number;
}

export interface DrawioGraphViewer {
  graph: {
    addListener: (name: string, fn: (sender: unknown, evt: { getProperty: (k: string) => unknown }) => void) => void;
    /** mxGraph mouse-listener contract (all three handlers required). */
    addMouseListener: (l: { mouseDown: (s: unknown, me: DrawioMouseEvent) => void; mouseMove: (s: unknown, me: DrawioMouseEvent) => void; mouseUp: (s: unknown, me: DrawioMouseEvent) => void }) => void;
    getModel: () => { getCell: (id: string) => unknown };
    view: { getState: (cell: unknown) => unknown };
    scrollCellToVisible?: (cell: unknown, center?: boolean) => void;
    setEnabled?: (v: boolean) => void;
  };
  selectPage?: (index: number) => void;
  currentPage?: number;
}

export const DRAWIO_VIEWER_LOCAL_URL = '/api/vendor/drawio-viewer.js';
export const DRAWIO_VIEWER_CDN_URL = 'https://viewer.diagrams.net/js/viewer-static.min.js';

let scriptPromise: Promise<void> | null = null;

function injectScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      s.remove();
      reject(new Error(`cannot load ${src}`));
    };
    document.head.appendChild(s);
  });
}

/** Load the viewer script once (daemon cache → CDN). Resolves when
 *  `window.GraphViewer` exists. */
export function loadDrawioViewer(): Promise<void> {
  if (typeof window === 'undefined') return Promise.reject(new Error('no window'));
  if (window.GraphViewer) return Promise.resolve();
  if (scriptPromise) return scriptPromise;
  // The static viewer's shape/stencil/image assets default to the CDN; keep
  // them there (only exotic shapes need them) — nothing else leaves the machine.
  scriptPromise = injectScript(DRAWIO_VIEWER_LOCAL_URL)
    .catch(() => injectScript(DRAWIO_VIEWER_CDN_URL))
    .then(() => {
      if (!window.GraphViewer) throw new Error('GraphViewer missing after load');
    })
    .catch((err) => {
      scriptPromise = null;
      throw err;
    });
  return scriptPromise;
}

export interface DrawioViewerProps {
  /** Full mxfile XML (may hold several `<diagram>` pages). */
  xml: string;
  /** Which page to show (0-based). */
  page?: number;
  /** Cell ids to outline. */
  highlightCells?: readonly string[];
  /** Fired with the clicked cell id, or null when the background was clicked. */
  onCellClick?: (cellId: string | null) => void;
  className?: string;
  /** Extra GraphViewer options (`toolbar`, `nav`, `zoom`…). */
  options?: Record<string, unknown>;
}

const HIGHLIGHT_COLOR = '#0066b3';

export function DrawioViewer({ xml, page = 0, highlightCells, onCellClick, className, options }: DrawioViewerProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<DrawioGraphViewer | null>(null);
  const highlightsRef = useRef<{ destroy: () => void }[]>([]);
  const clickRef = useRef(onCellClick);
  clickRef.current = onCellClick;
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);

  // (Re)create the viewer whenever the XML or the page changes. GraphViewer
  // owns the DOM under `host`; a fresh mount is cheaper and safer than driving
  // its internal page state.
  useEffect(() => {
    let cancelled = false;
    const host = hostRef.current;
    if (!host) return;
    setStatus('loading');
    setError(null);
    viewerRef.current = null;
    for (const h of highlightsRef.current.splice(0)) h.destroy();
    host.innerHTML = '';
    loadDrawioViewer()
      .then(() => {
        if (cancelled || !hostRef.current || !window.GraphViewer) return;
        const el = document.createElement('div');
        el.className = 'mxgraph';
        el.style.maxWidth = '100%';
        el.setAttribute(
          'data-mxgraph',
          JSON.stringify({
            xml,
            page,
            // No lightbox-on-click (it would swallow the cell clicks we use for
            // finding ↔ cell sync); full-screen stays reachable via the toolbar.
            lightbox: false,
            toolbar: 'zoom lightbox',
            'toolbar-nohide': true,
            'toolbar-position': 'top',
            nav: true,
            resize: false,
            'auto-fit': true,
            border: 16,
            'check-visible-state': false,
            ...(options ?? {}),
          }),
        );
        hostRef.current.appendChild(el);
        try {
          window.GraphViewer.createViewerForElement(el, (viewer) => {
            if (cancelled) return;
            viewerRef.current = viewer;
            // GraphViewer stubs `graph.click` out (it handles links itself), so
            // mxEvent.CLICK never fires here — detect a click as down+up on the
            // same spot through the mouse-listener API instead.
            try {
              let down: { x: number; y: number; id: string | null } | null = null;
              const idOf = (me: DrawioMouseEvent): string | null => {
                const cell = me.getCell();
                if (!cell) return null;
                return (typeof cell.getId === 'function' ? cell.getId() : cell.id) ?? null;
              };
              viewer.graph.addMouseListener({
                mouseDown: (_s, me) => {
                  down = { x: me.getGraphX(), y: me.getGraphY(), id: idOf(me) };
                },
                mouseMove: () => {},
                mouseUp: (_s, me) => {
                  const d = down;
                  down = null;
                  if (!d) return;
                  if (Math.abs(me.getGraphX() - d.x) > 4 || Math.abs(me.getGraphY() - d.y) > 4) return; // a drag/pan, not a click
                  clickRef.current?.(idOf(me) ?? d.id);
                },
              });
            } catch {
              /* click sync is best-effort */
            }
            setStatus('ready');
          });
        } catch (err) {
          setStatus('error');
          setError(String((err as Error)?.message ?? err));
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setStatus('error');
        setError(String((err as Error)?.message ?? err));
      });
    return () => {
      cancelled = true;
      for (const h of highlightsRef.current.splice(0)) h.destroy();
      viewerRef.current = null;
      if (host) host.innerHTML = '';
    };
  }, [xml, page, options]);

  // Highlight the requested cells (outline in accent colour, scroll to the first).
  useEffect(() => {
    const viewer = viewerRef.current;
    for (const h of highlightsRef.current.splice(0)) h.destroy();
    if (!viewer || status !== 'ready' || !highlightCells?.length || !window.mxCellHighlight) return;
    const graph = viewer.graph;
    let first: unknown = null;
    for (const id of highlightCells) {
      const cell = graph.getModel().getCell(id);
      if (!cell) continue;
      const state = graph.view.getState(cell);
      if (!state) continue;
      try {
        const hl = new window.mxCellHighlight(graph, HIGHLIGHT_COLOR, 3);
        hl.highlight(state);
        highlightsRef.current.push(hl);
        if (!first) first = cell;
      } catch {
        /* ignore */
      }
    }
    if (first && typeof graph.scrollCellToVisible === 'function') {
      try {
        graph.scrollCellToVisible(first, true);
      } catch {
        /* ignore */
      }
    }
  }, [highlightCells, status, page, xml]);

  return (
    <div className={className} style={{ position: 'relative', minHeight: 240 }}>
      <div ref={hostRef} data-testid="drawio-host" style={{ width: '100%', height: '100%' }} />
      {status === 'loading' ? (
        <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', fontSize: 12.5, color: 'var(--text-muted, #57544e)', pointerEvents: 'none' }}>
          Đang tải viewer draw.io…
        </div>
      ) : null}
      {status === 'error' ? (
        <div style={{ padding: 16, fontSize: 12.5, color: 'var(--text-muted, #57544e)' }}>
          Không tải được viewer draw.io ({error}). Tải file <code>.drawio</code> về và mở bằng draw.io / diagrams.net.
        </div>
      ) : null}
    </div>
  );
}
