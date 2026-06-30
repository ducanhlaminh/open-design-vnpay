// Multi-screen React Flow canvas for the docs → HTML prototype workflow. Mirrors
// PipelineScreensCanvas, but each frame is a self-contained `prototype/*.html`
// page (output of the `html-interactive-prototype` / `ui-html` pipeline) loaded
// by URL — not screen.json through the design-v3 runtime. URL-loading (vs srcDoc)
// gives each iframe a real base URL, so the prototype's relative cross-screen
// links AND its inline JS (tabs / modals / navigation) work inside the frame.
//
// FileViewer shows this canvas when you open any `prototype/*.html` file.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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

import { fetchProjectFiles, projectFileUrl } from '../../providers/registry';
import type { H2DRecipeState, ScreenSpec } from '../../lib/html-to-h2d';
import styles from './PipelinePrototypeCanvas.module.css';

interface PrototypeEntry {
  /** Full project-relative path: `<dir>/<slug>.html`. */
  name: string;
  /** Readable label derived from the file name. */
  title: string;
}

// One frame size for every prototype page. Phone-ish (the skill is mobile-first);
// web pages just scroll inside the iframe.
const FRAME = { w: 375, h: 812 } as const;
// Capture viewport height — matches the CLI's default so a `min-height:100vh`
// screen resolves to a mobile height instead of an inflated frame.
const CAPTURE_H = 932;

function prettyTitle(fileName: string): string {
  const base = fileName.split('/').pop() ?? fileName;
  const stem = base.replace(/\.html?$/i, '');
  if (stem === 'index') return 'Overview';
  return stem.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function HtmlFrameNode({ data }: NodeProps) {
  const { entry, projectId, active } = data as {
    entry: PrototypeEntry;
    projectId: string;
    active: boolean;
  };
  return (
    <div className={styles.frameWrap}>
      <div className={styles.frameLabel} title={entry.title}>
        <span className={styles.frameTitle}>{entry.title}</span>
        {active && <span className={styles.activeBadge}>open</span>}
      </div>
      <div
        className={active ? `${styles.frame} ${styles.frameActive}` : styles.frame}
        style={{ width: FRAME.w, height: FRAME.h }}
      >
        <iframe
          src={projectFileUrl(projectId, entry.name)}
          title={entry.title}
          className={styles.iframe}
          style={{ width: FRAME.w, height: FRAME.h }}
        />
      </div>
    </div>
  );
}

const nodeTypes = { htmlFrame: HtmlFrameNode };

interface Props {
  projectId: string;
  /** Directory holding the prototype html files, e.g. `prototype`. */
  dir: string;
  /** The opened file (full path) — highlighted as `open`. */
  activeName: string;
}

export function PipelinePrototypeCanvas({ projectId, dir, activeName }: Props) {
  const [entries, setEntries] = useState<PrototypeEntry[] | null>(null);
  // The `<stem>.states.json` recipes present under `dir` — a multistep screen
  // expands into one frame per state on copy-all (parity with the CLI).
  const [statesSet, setStatesSet] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const [copyAll, setCopyAll] = useState<'idle' | 'busy' | 'ok' | 'err'>('idle');
  const copyAllResetRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (copyAllResetRef.current) clearTimeout(copyAllResetRef.current); }, []);

  // Copy ALL screens to Figma in one payload — the in-browser equivalent of the CLI
  // `copy-figma-h2d.mjs <screens>`: each screen is re-rendered offscreen with its demo-player
  // frozen, driven through its `<stem>.states.json` recipe (one frame per state), and combined.
  // Pasting once drops every screen — and every state of a multistep screen — into Figma as sibling
  // frames. clipboard.write runs synchronously inside the click gesture with a Promise-valued
  // ClipboardItem so the async fetch+capture chain doesn't expire the gesture.
  const copyAllToFigma = useCallback(() => {
    if (copyAll === 'busy') return;
    if (copyAllResetRef.current) clearTimeout(copyAllResetRef.current);
    setCopyAll('busy');
    const list = entries ?? [];
    const payload = (async () => {
      const specs: ScreenSpec[] = [];
      for (const entry of list) {
        const resp = await fetch(projectFileUrl(projectId, entry.name));
        if (!resp.ok) {
          // eslint-disable-next-line no-console
          console.warn(`[Copy all to Figma] bỏ qua ${entry.name} (${resp.status})`);
          continue;
        }
        const html = await resp.text();
        // Optional multistep recipe sitting beside the html, e.g. `foo.states.json`.
        const statesName = entry.name.replace(/\.html?$/i, '') + '.states.json';
        let states: H2DRecipeState[] | null = null;
        if (statesSet.has(statesName)) {
          try {
            const sr = await fetch(projectFileUrl(projectId, statesName));
            if (sr.ok) {
              const parsed = JSON.parse(await sr.text());
              if (Array.isArray(parsed) && parsed.length) states = parsed as H2DRecipeState[];
            }
          } catch {
            /* no/!invalid recipe → single capture */
          }
        }
        specs.push({ html, width: FRAME.w, height: CAPTURE_H, states });
      }
      if (specs.length === 0) throw new Error('Không có màn nào để copy');
      const { screensToFigmaClipboard } = await import('../../lib/html-to-h2d');
      const html = await screensToFigmaClipboard(specs, FRAME.w, CAPTURE_H);
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
  }, [copyAll, entries, projectId, statesSet]);

  useEffect(() => {
    let cancelled = false;
    setEntries(null);
    setError(null);
    void (async () => {
      try {
        const files = await fetchProjectFiles(projectId);
        const names = files.map((f) => f.name);
        // Direct `<dir>/<file>.html` children only (one segment under dir).
        const htmlFiles = names
          .filter((n) => {
            if (!n.startsWith(`${dir}/`) || !/\.html?$/i.test(n)) return false;
            return n.slice(dir.length + 1).split('/').length === 1;
          })
          // index.html first, then alphabetical.
          .sort((a, b) => {
            const ai = /(^|\/)index\.html?$/i.test(a) ? 0 : 1;
            const bi = /(^|\/)index\.html?$/i.test(b) ? 0 : 1;
            return ai - bi || a.localeCompare(b);
          });
        // `<stem>.states.json` recipes under dir, for multistep copy-all.
        const states = new Set(
          names.filter((n) => n.startsWith(`${dir}/`) && /\.states\.json$/i.test(n)),
        );
        if (cancelled) return;
        setStatesSet(states);
        if (htmlFiles.length === 0) {
          setError(`No prototype HTML found under ${dir}/ — run the “UI (HTML prototype)” pipeline first.`);
          setEntries([]);
          return;
        }
        setEntries(htmlFiles.map((name) => ({ name, title: prettyTitle(name) })));
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
      const node: Node = {
        id: entry.name,
        type: 'htmlFrame',
        position: { x, y: 0 },
        data: { entry, projectId, active: entry.name === activeName },
      };
      x += FRAME.w + 80;
      return node;
    });
  }, [entries, activeName, projectId]);

  if (error && (!entries || entries.length === 0)) {
    return <div className={styles.msg}>{error}</div>;
  }
  if (!entries) {
    return <div className={styles.msg}>Loading prototype…</div>;
  }

  return (
    <div className={styles.root}>
      <div className={styles.canvas}>
        {entries.length > 0 && (
          <button
            type="button"
            data-testid="canvas-copy-all-figma"
            onClick={copyAllToFigma}
            disabled={copyAll === 'busy'}
            title="Copy tất cả màn sang Figma — paste một lần ra nhiều frame (gồm cả multistep)"
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
                  ? '✗ Lỗi — xem console'
                  : '⧉ Copy tất cả màn sang Figma'}
          </button>
        )}
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
    </div>
  );
}
