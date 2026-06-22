// Multi-screen React Flow canvas for the docs → HTML prototype workflow. Mirrors
// PipelineScreensCanvas, but each frame is a self-contained `prototype/*.html`
// page (output of the `html-interactive-prototype` / `ui-html` pipeline) loaded
// by URL — not screen.json through the design-v3 runtime. URL-loading (vs srcDoc)
// gives each iframe a real base URL, so the prototype's relative cross-screen
// links AND its inline JS (tabs / modals / navigation) work inside the frame.
//
// FileViewer shows this canvas when you open any `prototype/*.html` file.

import { useEffect, useMemo, useState } from 'react';
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
