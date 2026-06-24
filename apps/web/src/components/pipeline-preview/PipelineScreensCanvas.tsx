// Multi-screen React Flow canvas for a pipeline UI project — mirrors design-v3's
// screen-library all-view (ui/preview screen-canvas.tsx): every `screen.json`
// under the opened screen's directory becomes one device frame rendered through
// the embedded design-v3 runtime (PipelinePreviewIframe), all sharing ONE theme
// resolve from the ThemeInspectorPanel (one resolve → every frame repaints).
//
// This is the canvas the FileViewer shows when you open a `screen.json`, instead
// of a single-screen tab. It deliberately renders each screen via the clean
// screen.json → runtime path (NOT the generated `shell.html`, which loads
// @babel/standalone in srcDoc and crashes the host preview), so all screens are
// browsable at once.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { captureElement, toFigmaClipboardHtml, type H2DDocument } from '@open-design/figma-h2d';
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { fetchProjectFiles, fetchProjectFileText } from '../../providers/registry';
import { PipelinePreviewIframe } from './PipelinePreviewIframe';
import { ThemeInspectorPanel } from './ThemeInspectorPanel';
import { adaptScreenSpec } from './screen-adapter';
import type { ThemeLabResolved } from './theme-lab-api';
import styles from './PipelineScreensCanvas.module.css';

interface ScreenEntry {
  /** Full project-relative path: `<dir>/<slug>/screen.json`. */
  name: string;
  slug: string;
  title: string;
  viewport: 'mobile' | 'web';
  /** Adapted runtime spec ({layout:{tree}}). */
  spec: unknown;
}

const DIMS = {
  mobile: { w: 392, h: 812 },
  web: { w: 1100, h: 720 },
} as const;

// One shared theme so all frames repaint together (design-v3's PreviewThemeProvider).
const ScreenThemeContext = createContext<{ resolved: ThemeLabResolved | null; mode: string }>({
  resolved: null,
  mode: 'light',
});

function ScreenFrameNode({ data }: NodeProps) {
  const { entry, active } = data as { entry: ScreenEntry; active: boolean };
  const { resolved, mode } = useContext(ScreenThemeContext);
  const dim = DIMS[entry.viewport];
  return (
    <div className={styles.frameWrap}>
      <div className={styles.frameLabel} title={entry.title}>
        <span className={styles.frameTitle}>{entry.title}</span>
        {active && <span className={styles.activeBadge}>open</span>}
      </div>
      <div
        className={active ? `${styles.frame} ${styles.frameActive}` : styles.frame}
        style={{ width: dim.w, height: dim.h }}
      >
        <PipelinePreviewIframe
          spec={entry.spec}
          cssVars={resolved?.cssVars}
          cssText={resolved?.cssText}
          resolved={
            resolved
              ? { tokens: resolved.tokens, cssVars: resolved.cssVars, cssText: resolved.cssText }
              : null
          }
          mode={mode}
        />
      </div>
    </div>
  );
}

const nodeTypes = { screenFrame: ScreenFrameNode };

interface Props {
  projectId: string;
  /** Directory holding the screen folders, e.g. `socchat-screens`. */
  dir: string;
  /** The opened screen.json (full path) — highlighted as `open`. */
  activeName: string;
  workspaceId?: string;
}

export function PipelineScreensCanvas({ projectId, dir, activeName, workspaceId }: Props) {
  const [entries, setEntries] = useState<ScreenEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resolved, setResolved] = useState<ThemeLabResolved | null>(null);
  const [mode, setMode] = useState<string>('light');
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const [copyAll, setCopyAll] = useState<'idle' | 'busy' | 'ok' | 'err'>('idle');
  const copyAllResetRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Copy all screens to Figma — serialize every rendered (same-origin) preview iframe to the
  // figh2d clipboard format and combine them into ONE payload (an array of documents). Pasting
  // once drops every screen into Figma as sibling frames. clipboard.write runs synchronously
  // inside the click gesture with a Promise-valued ClipboardItem so the async capture doesn't
  // expire the gesture. See apps/web/src/lib/html-to-h2d.ts for the single-artifact variant.
  const copyAllToFigma = useCallback(() => {
    if (copyAll === 'busy') return;
    if (copyAllResetRef.current) clearTimeout(copyAllResetRef.current);
    setCopyAll('busy');
    const payload = (async () => {
      const frames = Array.from(canvasRef.current?.querySelectorAll('iframe') ?? []);
      const docs: H2DDocument[] = [];
      for (const frame of frames) {
        try {
          const doc = frame.contentDocument;
          if (!doc?.body) continue;
          const root = doc.body.firstElementChild ?? doc.body;
          docs.push(await captureElement(root, { skipRemoteAssetSerialization: false }));
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn('[Copy all to Figma] bỏ qua một màn:', err);
        }
      }
      if (docs.length === 0) throw new Error('Không có màn nào để copy (preview chưa render?)');
      const { html } = await toFigmaClipboardHtml(docs, { source: 'open-design' });
      return new Blob([html], { type: 'text/html' });
    })();
    const done = (state: 'ok' | 'err', err?: unknown) => {
      if (err) {
        // eslint-disable-next-line no-console
        console.error('[Copy all to Figma]', err);
      }
      setCopyAll(state);
      copyAllResetRef.current = setTimeout(() => setCopyAll('idle'), 3200);
    };
    try {
      window.focus();
      navigator.clipboard
        .write([new ClipboardItem({ 'text/html': payload })])
        .then(() => done('ok'))
        .catch((err) => {
          payload
            .then((blob) => navigator.clipboard.write([new ClipboardItem({ 'text/html': blob })]))
            .then(() => done('ok'))
            .catch((err2) => done('err', err2 || err));
        });
    } catch (err) {
      payload.catch(() => {});
      done('err', err);
    }
  }, [copyAll]);
  useEffect(() => () => { if (copyAllResetRef.current) clearTimeout(copyAllResetRef.current); }, []);

  useEffect(() => {
    let cancelled = false;
    setEntries(null);
    setError(null);
    (async () => {
      try {
        const files = await fetchProjectFiles(projectId);
        // Direct `<dir>/<slug>/screen.json` siblings only (exactly one segment
        // between the dir and the file).
        const screenFiles = files
          .map((f) => f.name)
          .filter((n) => {
            if (!n.startsWith(`${dir}/`) || n.split('/').pop() !== 'screen.json') return false;
            return n.slice(dir.length + 1).split('/').length === 2;
          })
          .sort();
        const loaded = await Promise.all(
          screenFiles.map(async (name): Promise<ScreenEntry | null> => {
            const text = await fetchProjectFileText(projectId, name);
            let raw: unknown = null;
            try {
              raw = JSON.parse(text ?? 'null');
            } catch {
              return null;
            }
            const spec = adaptScreenSpec(raw);
            if (!spec) return null;
            const scr = ((raw as { screen?: Record<string, unknown> })?.screen ??
              (raw as Record<string, unknown>) ??
              {}) as Record<string, unknown>;
            const slug = name.slice(dir.length + 1).replace(/\/screen\.json$/, '');
            const vp = String(scr.viewport ?? '').toLowerCase();
            const viewport: 'mobile' | 'web' =
              vp.includes('web') || vp.includes('desktop') || vp.includes('tablet') ? 'web' : 'mobile';
            return { name, slug, title: String(scr.name ?? slug), viewport, spec };
          }),
        );
        if (cancelled) return;
        const ok = loaded.filter((e): e is ScreenEntry => e !== null);
        if (ok.length === 0) {
          setError(`No renderable screens found under ${dir}/`);
          return;
        }
        setEntries(ok);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, dir]);

  const nodes: Node[] = useMemo(() => {
    if (!entries) return [];
    let x = 0;
    return entries.map((entry) => {
      const dim = DIMS[entry.viewport];
      const node: Node = {
        id: entry.slug,
        type: 'screenFrame',
        position: { x, y: 0 },
        data: { entry, active: entry.name === activeName },
      };
      x += dim.w + 96;
      return node;
    });
  }, [entries, activeName]);

  if (error) {
    return (
      <div className={styles.msg} style={{ color: 'crimson' }}>
        Screens canvas: {error}
      </div>
    );
  }
  if (!entries) {
    return <div className={styles.msg}>Loading screens…</div>;
  }

  return (
    <ScreenThemeContext.Provider value={{ resolved, mode }}>
      <div className={styles.root}>
        <div className={styles.canvas} ref={canvasRef}>
          <button
            type="button"
            onClick={copyAllToFigma}
            disabled={copyAll === 'busy'}
            title="Copy tất cả màn sang Figma — paste một lần ra nhiều frame"
            style={{
              position: 'absolute',
              top: 12,
              right: 12,
              zIndex: 5,
              font: '600 13px system-ui',
              padding: '8px 14px',
              border: 0,
              borderRadius: 8,
              cursor: copyAll === 'busy' ? 'default' : 'pointer',
              color: '#fff',
              background:
                copyAll === 'ok' ? '#0c7a35' : copyAll === 'err' ? '#b91c1c' : '#0d99ff',
            }}
          >
            {copyAll === 'busy'
              ? 'Đang copy…'
              : copyAll === 'ok'
                ? '✓ Đã copy — Cmd+V vào Figma'
                : copyAll === 'err'
                  ? '✗ Copy lỗi'
                  : `⧉ Copy tất cả màn (${entries.length}) → Figma`}
          </button>
          <ReactFlowProvider>
            <ReactFlow
              nodes={nodes}
              edges={[]}
              nodeTypes={nodeTypes}
              fitView
              fitViewOptions={{ padding: 0.12 }}
              nodesConnectable={false}
              edgesFocusable={false}
              proOptions={{ hideAttribution: true }}
              panOnScroll
              zoomOnScroll
              zoomOnPinch
              minZoom={0.05}
              maxZoom={2}
            >
              <Background gap={32} size={1} color="var(--border, #e5e7eb)" />
              <Controls showInteractive={false} />
              <MiniMap pannable zoomable />
            </ReactFlow>
          </ReactFlowProvider>
        </div>
        <div className={styles.panel}>
          <ThemeInspectorPanel workspaceId={workspaceId} onResolved={setResolved} onMode={setMode} />
        </div>
      </div>
    </ScreenThemeContext.Provider>
  );
}
