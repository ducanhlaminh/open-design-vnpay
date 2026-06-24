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
import { useT } from '../../i18n';
import { RemixIcon } from '../RemixIcon';
import styles from './PipelinePrototypeCanvas.module.css';

interface PrototypeEntry {
  /** Full project-relative path: `<dir>/<slug>.html`. */
  name: string;
  /** Readable label derived from the file name. */
  title: string;
}

// One frame size for every prototype page. Phone-ish (the skill is mobile-first);
// web pages just scroll inside the iframe.
const FRAME = { w: 430, h: 840 } as const;

function prettyTitle(fileName: string): string {
  const base = fileName.split('/').pop() ?? fileName;
  const stem = base.replace(/\.html?$/i, '');
  if (stem === 'index') return 'Overview';
  return stem.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

type CopyState = 'idle' | 'busy' | 'ready' | 'ok' | 'err';

// Per-frame "Copy to Figma": fetch THIS screen's prototype HTML source and serialize it to a
// Figma "HTML to Design" (figh2d) clipboard payload fully client-side via @open-design/figma-h2d
// (no daemon round-trip — Figma builds editable nodes from the JSON on paste). Same engine as the
// single-file viewer's toolbar button (htmlToFigmaClipboard), but reachable directly from the
// docs→HTML prototype canvas — one button per screen.
//
// Reliability: the payload is built from a long async chain (fetch → extract → daemon). Doing that
// chain INSIDE the click and writing a Promise-valued ClipboardItem is fragile — if the gesture
// loses focus mid-chain the browser rejects the write and the OS clipboard silently keeps its
// PREVIOUS content, so every paste shows whichever screen last copied successfully. We instead
// PREFETCH the payload Blob on hover/focus (cached per screen) and, on click, write the already
// RESOLVED Blob synchronously — the dependable clipboard path. Cold clicks (no prefetch yet) fall
// back to building first, then flip to a "ready — click again" state so the second click writes the
// cached Blob instantly.
function FrameCopyToFigma({ projectId, entry }: { projectId: string; entry: PrototypeEntry }) {
  const t = useT();
  const [state, setState] = useState<CopyState>('idle');
  const [err, setErr] = useState<string | null>(null);
  const resetRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const blobRef = useRef<Blob | null>(null); // prepared payload for THIS screen
  const prepRef = useRef<Promise<Blob> | null>(null); // in-flight prepare (dedupe)
  useEffect(() => () => { if (resetRef.current) clearTimeout(resetRef.current); }, []);

  // Build (and cache) the Figma clipboard Blob for this screen. Deduped: concurrent calls share one
  // in-flight promise; a failure clears the cache so a later attempt retries.
  const buildPayload = useCallback((): Promise<Blob> => {
    if (blobRef.current) return Promise.resolve(blobRef.current);
    if (prepRef.current) return prepRef.current;
    const p = (async () => {
      const resp = await fetch(projectFileUrl(projectId, entry.name));
      if (!resp.ok) throw new Error(`Không đọc được HTML màn (${resp.status})`);
      const html = await resp.text();
      const { htmlToFigmaClipboard } = await import('../../lib/html-to-h2d');
      const payloadHtml = await htmlToFigmaClipboard(html, FRAME.w);
      const blob = new Blob([payloadHtml], { type: 'text/html' });
      blobRef.current = blob;
      return blob;
    })();
    prepRef.current = p;
    p.catch(() => { prepRef.current = null; }); // allow retry after failure
    return p;
  }, [projectId, entry.name]);

  // Prefetch on hover/focus so the click can write an already-resolved Blob.
  const prefetch = useCallback(() => {
    if (!blobRef.current && !prepRef.current) void buildPayload().catch(() => {});
  }, [buildPayload]);

  const finish = useCallback((next: 'ok' | 'err' | 'ready', e?: unknown) => {
    if (e) {
      // eslint-disable-next-line no-console
      console.error('[Copy to Figma]', e);
      setErr(e instanceof Error ? e.message : String(e));
    }
    setState(next);
    if (resetRef.current) clearTimeout(resetRef.current);
    // 'ready' is a persistent prompt to click again — don't auto-reset it.
    if (next !== 'ready') resetRef.current = setTimeout(() => setState('idle'), 3200);
  }, []);

  const writeBlob = useCallback((blob: Blob) => {
    navigator.clipboard
      .write([new ClipboardItem({ 'text/html': blob })])
      .then(() => finish('ok'))
      .catch((e) => finish('err', e));
  }, [finish]);

  const copy = useCallback(() => {
    if (state === 'busy') return;
    setErr(null);
    // Fast path: payload already prepared (hover prefetch, or a prior cold click) → write the
    // RESOLVED Blob synchronously inside this gesture. This is the reliable path.
    if (blobRef.current) {
      writeBlob(blobRef.current);
      return;
    }
    // Cold path: not prepared yet. Keep the gesture alive with a Promise-valued ClipboardItem; if
    // the browser rejects that, the Blob is cached by then — prompt the user to click once more.
    setState('busy');
    const payload = buildPayload();
    try {
      navigator.clipboard
        .write([new ClipboardItem({ 'text/html': payload })])
        .then(() => finish('ok'))
        .catch(() => {
          payload
            .then(() => finish('ready')) // Blob is cached now → next click hits the fast path
            .catch((e2) => finish('err', e2));
        });
    } catch (e) {
      payload.then(() => finish('ready')).catch((e2) => finish('err', e2 || e));
    }
  }, [state, buildPayload, writeBlob, finish]);

  const label =
    state === 'ok'
      ? t('fileViewer.copyToFigmaDone')
      : state === 'err'
        ? err || t('fileViewer.copyToFigmaError')
        : state === 'busy'
          ? t('fileViewer.copyToFigmaBusy')
          : state === 'ready'
            ? 'Đã chuẩn bị xong — bấm lần nữa để chép'
            : t('fileViewer.copyToFigma');

  return (
    <button
      type="button"
      data-testid="canvas-copy-figma"
      // nodrag/nopan: keep the click from starting a React Flow node drag / canvas pan.
      className={
        `nodrag nopan ${styles.copyFigmaBtn}` +
        (state === 'ok' ? ` ${styles.copyFigmaOk}` : '') +
        (state === 'err' ? ` ${styles.copyFigmaErr}` : '') +
        (state === 'ready' ? ` ${styles.copyFigmaReady}` : '')
      }
      title={label}
      aria-label={label}
      disabled={state === 'busy'}
      onPointerEnter={prefetch}
      onFocus={prefetch}
      onClick={copy}
    >
      <RemixIcon
        name={
          state === 'ok'
            ? 'check-line'
            : state === 'err'
              ? 'error-warning-line'
              : state === 'ready'
                ? 'clipboard-fill'
                : 'clipboard-line'
        }
        size={13}
      />
    </button>
  );
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
        <FrameCopyToFigma projectId={projectId} entry={entry} />
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
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setEntries(null);
    setError(null);
    void (async () => {
      try {
        const files = await fetchProjectFiles(projectId);
        // Direct `<dir>/<file>.html` children only (one segment under dir).
        const htmlFiles = files
          .map((f) => f.name)
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
        if (cancelled) return;
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
