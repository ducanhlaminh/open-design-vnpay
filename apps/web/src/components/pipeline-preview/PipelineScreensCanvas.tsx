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

import { createContext, useContext, useEffect, useMemo, useState } from 'react';
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
        <div className={styles.panel}>
          <ThemeInspectorPanel workspaceId={workspaceId} onResolved={setResolved} onMode={setMode} />
        </div>
      </div>
    </ScreenThemeContext.Provider>
  );
}
