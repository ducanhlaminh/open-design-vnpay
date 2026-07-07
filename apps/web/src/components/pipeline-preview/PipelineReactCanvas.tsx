// All-screens React Flow canvas for the docs → React workflow. Each frame is a
// built `react/dist/screens/<slug>.html` page (one per authored screen) loaded by
// URL — so its shared ./assets/* chunks resolve and it runs as a real app. Frames
// are freely resizable (NodeResizer) and the canvas pans/zooms. Navigation edges
// are read from the agent-authored `react/flow.json` (screen→screen from the
// customer journey) and drawn between the matching frames.
//
// FileViewer shows this canvas when you open any `react/dist/screens/*.html` file.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  Controls,
  Handle,
  MiniMap,
  MarkerType,
  NodeResizer,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { fetchProjectFiles, fetchProjectFileText, projectFileUrl } from '../../providers/registry';
import { PipelineReactSimulator } from './PipelineReactSimulator';
import styles from './PipelineReactCanvas.module.css';

interface ScreenEntry {
  /** Full project-relative path: `<dir>/<slug>.html`. */
  name: string;
  slug: string;
  title: string;
}

const DEFAULT_W = 420;
const DEFAULT_H = 760;
// Distinct anchor slots per node edge-side so parallel edges fan out instead
// of stacking on one center point.
const ANCHOR_SLOTS = 5;

function prettyTitle(slug: string): string {
  return slug.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function ScreenFrameNode({ data, selected }: NodeProps) {
  const { entry, projectId, moveMode } = data as {
    entry: ScreenEntry;
    projectId: string;
    moveMode?: boolean;
  };
  return (
    <div className={styles.node}>
      <NodeResizer minWidth={280} minHeight={220} isVisible={Boolean(selected)} />
      {/* React Flow only renders an edge when BOTH endpoints resolve to a
          handle — a custom node without handles silently drops every
          flow.json arrow. These are invisible anchors, never connect targets
          (nodesConnectable is off). Multiple slots per side let parallel
          edges fan out; the left-source / right-target / bottom / top pairs
          give backward and same-column edges their own lanes instead of
          looping over the frames. */}
      {Array.from({ length: ANCHOR_SLOTS }, (_, k) => (
        <Handle
          key={`sr-${k}`}
          id={`sr-${k}`}
          type="source"
          position={Position.Right}
          className={styles.edgeAnchor}
          style={{ top: `${12 + k * 19}%` }}
        />
      ))}
      {Array.from({ length: ANCHOR_SLOTS }, (_, k) => (
        <Handle
          key={`tl-${k}`}
          id={`tl-${k}`}
          type="target"
          position={Position.Left}
          className={styles.edgeAnchor}
          style={{ top: `${12 + k * 19}%` }}
        />
      ))}
      <Handle id="sl" type="source" position={Position.Left} className={styles.edgeAnchor} style={{ top: '94%' }} />
      <Handle id="tr" type="target" position={Position.Right} className={styles.edgeAnchor} style={{ top: '94%' }} />
      <Handle id="sb" type="source" position={Position.Bottom} className={styles.edgeAnchor} />
      <Handle id="tt" type="target" position={Position.Top} className={styles.edgeAnchor} />
      <div className={styles.label} title={entry.title}>
        <span className={styles.grip}>⠿</span>
        {entry.title}
      </div>
      <div className={styles.frame}>
        <iframe
          src={projectFileUrl(projectId, entry.name)}
          title={entry.title}
          className={styles.iframe}
        />
        {/* Move mode: a transparent overlay swallows pointer events so the
            drag starts on the NODE instead of dying inside the iframe (an
            iframe captures the mouse and React Flow never sees it). Interact
            mode removes it so the app inside the frame is clickable — the
            title bar always stays a drag handle. */}
        {moveMode ? <div className={styles.dragOverlay} /> : null}
      </div>
    </div>
  );
}

const nodeTypes = { screenFrame: ScreenFrameNode };

interface Props {
  projectId: string;
  /** Directory holding the built per-screen html, e.g. `docs-to-react/react/dist/screens`. */
  dir: string;
  /** The opened file (full path) — highlighted as `open`. */
  activeName: string;
}

interface FlowEdge {
  from: string;
  to: string;
  label?: string;
}

export function PipelineReactCanvas({ projectId, dir, activeName }: Props) {
  const [entries, setEntries] = useState<ScreenEntry[] | null>(null);
  const [flow, setFlow] = useState<FlowEdge[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Move mode (default): frames are draggable from anywhere — an overlay
  // keeps the iframes from eating the pointer. Interact mode: the app inside
  // each frame is clickable; dragging still works via the title bar.
  const [moveMode, setMoveMode] = useState(true);
  const moveModeRef = useRef(moveMode);
  moveModeRef.current = moveMode;
  // 'canvas' = all-screens map; 'sim' = use-case walkthrough (one device
  // frame, stepped along a flow.json path).
  const [view, setView] = useState<'canvas' | 'sim'>('canvas');

  // Copy ALL built screens to Figma in one payload (H2D). Screens load
  // offscreen BY URL (relative ./assets/* chunks must resolve — srcdoc can't),
  // the real app renders, then each frame is captured and combined. Pasting
  // once drops every screen into Figma as sibling frames. clipboard.write runs
  // synchronously inside the click gesture with a Promise-valued ClipboardItem
  // so the async load+capture chain doesn't expire the gesture.
  const [copyAll, setCopyAll] = useState<'idle' | 'busy' | 'ok' | 'err'>('idle');
  const copyResetRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (copyResetRef.current) clearTimeout(copyResetRef.current); }, []);
  const copyAllToFigma = useCallback(() => {
    if (copyAll === 'busy' || !entries || entries.length === 0) return;
    if (copyResetRef.current) clearTimeout(copyResetRef.current);
    setCopyAll('busy');
    const payload = (async () => {
      const { urlsToFigmaClipboard } = await import('../../lib/html-to-h2d');
      const html = await urlsToFigmaClipboard(
        entries.map((e) => ({ url: projectFileUrl(projectId, e.name) })),
        DEFAULT_W,
        DEFAULT_H,
      );
      return new Blob([html], { type: 'text/html' });
    })();
    const done = (state: 'ok' | 'err', err?: unknown) => {
      if (err) {
        // eslint-disable-next-line no-console
        console.error('[Copy to Figma — React]', err);
      }
      setCopyAll(state);
      copyResetRef.current = setTimeout(() => setCopyAll('idle'), 3200);
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
  }, [copyAll, entries, projectId]);

  useEffect(() => {
    let cancelled = false;
    setEntries(null);
    setError(null);
    setFlow([]);
    void (async () => {
      try {
        const files = await fetchProjectFiles(projectId);
        const names = files.map((f) => f.name);
        const htmlFiles = names
          .filter((n) => {
            if (!n.startsWith(`${dir}/`) || !/\.html?$/i.test(n)) return false;
            return n.slice(dir.length + 1).split('/').length === 1; // direct children
          })
          .sort((a, b) => a.localeCompare(b));
        if (cancelled) return;
        if (htmlFiles.length === 0) {
          setError(`No built screens under ${dir}/ — run the “UI (React app)” pipeline first.`);
          setEntries([]);
          return;
        }
        setEntries(
          htmlFiles.map((name) => {
            const slug = (name.split('/').pop() ?? name).replace(/\.html?$/i, '');
            return { name, slug, title: prettyTitle(slug) };
          }),
        );
        // Optional agent-authored navigation manifest at `<reactRoot>/flow.json`.
        const reactRoot = dir.replace(/\/dist\/screens$/, '');
        try {
          const txt = await fetchProjectFileText(projectId, `${reactRoot}/flow.json`);
          const parsed = JSON.parse(txt ?? 'null');
          if (Array.isArray(parsed)) {
            setFlow(
              parsed.filter(
                (e): e is FlowEdge =>
                  e && typeof e.from === 'string' && typeof e.to === 'string',
              ),
            );
          }
        } catch {
          /* no/invalid flow.json → frames only */
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, dir]);

  // Flow-aware layered layout, shared by nodes AND edges:
  //   column = navigation depth (longest path from a root screen),
  //   row    = barycenter-ordered index within the column (each screen sits
  //            near the average row of its predecessors, which is what kills
  //            most edge crossings).
  // Screens absent from flow.json park in one trailing column.
  const layout = useMemo(() => {
    if (!entries || entries.length === 0) return null;
    const slugs = new Set(entries.map((e) => e.slug));
    const inFlow = flow.filter((e) => slugs.has(e.from) && slugs.has(e.to) && e.from !== e.to);
    const depth = new Map<string, number>();
    if (inFlow.length > 0) {
      // Column depth = BFS SHORTEST path from the roots. Real flows have
      // cycles ("quay lại", purchased → home) — the old longest-path
      // relaxation inflated depths around a cycle every pass (a 13-screen
      // flow ended up at column ~100, one frame ~63.000px from the rest) and
      // a `→ home` edge disqualified home from being a root. BFS visits each
      // screen once, so cycles cannot inflate anything.
      // Roots: màn "trang chủ" theo tên trước, rồi màn không là đích của
      // cạnh nào; đồ thị toàn vòng → màn có nhiều cạnh đi ra nhất.
      const targets = new Set(inFlow.map((e) => e.to));
      const named = entries
        .filter((e) => /^(home|index|main|entry|dashboard)$/i.test(e.slug))
        .map((e) => e.slug);
      const structural = [...new Set(inFlow.map((e) => e.from))].filter((s) => !targets.has(s));
      let roots = [...new Set([...named, ...structural])];
      if (roots.length === 0) {
        const outDeg = new Map<string, number>();
        for (const e of inFlow) outDeg.set(e.from, (outDeg.get(e.from) ?? 0) + 1);
        const best = [...outDeg.entries()].sort((a, b) => b[1] - a[1])[0];
        roots = best ? [best[0]] : [inFlow[0]!.from];
      }
      const adj = new Map<string, string[]>();
      for (const e of inFlow) {
        const arr = adj.get(e.from) ?? [];
        arr.push(e.to);
        adj.set(e.from, arr);
      }
      const bfs = (seeds: string[]) => {
        let queue = seeds.filter((s) => !depth.has(s));
        for (const s of queue) depth.set(s, 0);
        while (queue.length > 0) {
          const next: string[] = [];
          for (const u of queue) {
            for (const v of adj.get(u) ?? []) {
              if (!depth.has(v)) {
                depth.set(v, depth.get(u)! + 1);
                next.push(v);
              }
            }
          }
          queue = next;
        }
      };
      bfs(roots);
      // Cụm vòng lặp không với tới được từ roots — seed dần đến khi mọi màn
      // trong flow có depth.
      for (;;) {
        const missing = [...new Set(inFlow.flatMap((e) => [e.from, e.to]))].filter(
          (s) => !depth.has(s),
        );
        if (missing.length === 0) break;
        bfs([missing[0]!]);
      }
    }
    const maxDepth = depth.size > 0 ? Math.max(...depth.values()) : -1;
    const colOf = new Map<string, number>();
    for (const e of entries) colOf.set(e.slug, depth.get(e.slug) ?? maxDepth + 1);

    // Group per column (stable alphabetical start), then 3 barycenter sweeps.
    const colSlugs = new Map<number, string[]>();
    for (const e of entries.slice().sort((a, b) => a.slug.localeCompare(b.slug))) {
      const c = colOf.get(e.slug)!;
      const arr = colSlugs.get(c) ?? [];
      arr.push(e.slug);
      colSlugs.set(c, arr);
    }
    const colsSorted = [...colSlugs.keys()].sort((a, b) => a - b);
    const preds = new Map<string, string[]>();
    for (const e of inFlow) {
      const arr = preds.get(e.to) ?? [];
      arr.push(e.from);
      preds.set(e.to, arr);
    }
    const rowOf = new Map<string, number>();
    for (const c of colsSorted) colSlugs.get(c)!.forEach((s, i) => rowOf.set(s, i));
    for (let sweep = 0; sweep < 3; sweep += 1) {
      for (const c of colsSorted) {
        const arr = colSlugs.get(c)!;
        const scored = arr.map((s, i) => {
          const ps = (preds.get(s) ?? []).filter((p) => rowOf.has(p));
          const score = ps.length > 0
            ? ps.reduce((sum, p) => sum + rowOf.get(p)!, 0) / ps.length
            : rowOf.get(s)!;
          return { s, score, i };
        });
        scored.sort((a, b) => a.score - b.score || a.i - b.i);
        scored.forEach((x, i) => rowOf.set(x.s, i));
        colSlugs.set(c, scored.map((x) => x.s));
      }
    }
    return { colOf, rowOf };
  }, [entries, flow]);

  const layoutNodes: Node[] = useMemo(() => {
    if (!entries || !layout) return [];
    const GAP_X = 260;
    const GAP_Y = 150;
    return entries.map((entry) => ({
      id: entry.name,
      type: 'screenFrame',
      position: {
        x: (layout.colOf.get(entry.slug) ?? 0) * (DEFAULT_W + GAP_X),
        y: (layout.rowOf.get(entry.slug) ?? 0) * (DEFAULT_H + GAP_Y),
      },
      style: { width: DEFAULT_W, height: DEFAULT_H },
      data: { entry, projectId, active: entry.name === activeName },
    }));
  }, [entries, layout, activeName, projectId]);

  // Controlled-but-mutable nodes: without onNodesChange React Flow treats the
  // nodes prop as immutable state and silently ignores every drag/resize.
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);

  // Fresh layout (new build / different project) → reset positions.
  useEffect(() => {
    setNodes(
      layoutNodes.map((n) => ({
        ...n,
        data: { ...n.data, moveMode: moveModeRef.current },
      })),
    );
  }, [layoutNodes, setNodes]);

  // Mode toggle only patches node data — user-dragged positions survive.
  useEffect(() => {
    setNodes((ns) => ns.map((n) => ({ ...n, data: { ...n.data, moveMode } })));
  }, [moveMode, setNodes]);

  const edges: Edge[] = useMemo(() => {
    if (!entries || !layout || flow.length === 0) return [];
    const bySlug = new Map(entries.map((e) => [e.slug, e.name]));
    // Deterministic fan-out: edges leave/enter through per-node anchor slots
    // (sorted by the counterpart's row so lanes don't swap arbitrarily).
    const sorted = flow
      .filter((e) => bySlug.has(e.from) && bySlug.has(e.to) && e.from !== e.to)
      .slice()
      .sort(
        (a, b) =>
          (layout.rowOf.get(a.to) ?? 0) - (layout.rowOf.get(b.to) ?? 0) ||
          a.to.localeCompare(b.to),
      );
    const outCount = new Map<string, number>();
    const inCount = new Map<string, number>();
    const nextSlot = (m: Map<string, number>, key: string) => {
      const k = m.get(key) ?? 0;
      m.set(key, k + 1);
      return Math.min(ANCHOR_SLOTS - 1, k);
    };
    const out: Edge[] = [];
    for (const e of sorted) {
      const cs = layout.colOf.get(e.from) ?? 0;
      const ct = layout.colOf.get(e.to) ?? 0;
      const backward = ct < cs;
      const sameColumn = ct === cs;
      // Forward edges run left→right through the column gutter on fanned
      // slots. Same-column edges take the vertical bottom→top lane. Backward
      // edges (e.g. result → inquiry list) exit LEFT and enter RIGHT — the
      // short reverse path through the gutters — instead of looping over the
      // frames, and are dashed so the direction reads instantly.
      const sourceHandle = backward ? 'sl' : sameColumn ? 'sb' : `sr-${nextSlot(outCount, e.from)}`;
      const targetHandle = backward ? 'tr' : sameColumn ? 'tt' : `tl-${nextSlot(inCount, e.to)}`;
      out.push({
        id: `${e.from}->${e.to}`,
        source: bySlug.get(e.from)!,
        target: bySlug.get(e.to)!,
        sourceHandle,
        targetHandle,
        label: e.label,
        animated: !backward,
        type: 'smoothstep',
        pathOptions: { borderRadius: 14 },
        zIndex: 1000,
        markerEnd: { type: MarkerType.ArrowClosed },
        style: backward
          ? { stroke: 'var(--muted-foreground, #6b7280)', strokeWidth: 1.25, strokeDasharray: '6 4' }
          : { stroke: 'var(--primary, #2563eb)', strokeWidth: 1.5 },
        labelBgPadding: [6, 3],
        labelBgBorderRadius: 6,
      } as Edge);
    }
    return out;
  }, [entries, layout, flow]);

  if (error && (!entries || entries.length === 0)) {
    return <div className={styles.msg}>{error}</div>;
  }
  if (!entries) {
    return <div className={styles.msg}>Loading screens…</div>;
  }

  if (view === 'sim') {
    return (
      <PipelineReactSimulator
        projectId={projectId}
        entries={entries}
        flow={flow}
        onExit={() => setView('canvas')}
      />
    );
  }

  return (
    <div className={styles.root}>
      <ReactFlowProvider>
        <ReactFlow
          nodes={nodes}
          onNodesChange={onNodesChange}
          edges={edges}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ padding: 0.12 }}
          nodesConnectable={false}
          proOptions={{ hideAttribution: true }}
          panOnScroll
          zoomOnScroll
          zoomOnPinch
          minZoom={0.05}
          maxZoom={2}
        >
          <Panel position="top-left" className={styles.modeBar}>
            <button
              type="button"
              className={moveMode ? styles.modeBtnActive : styles.modeBtn}
              onClick={() => setMoveMode(true)}
              title="Kéo thả / pan tự do (chuột không tương tác vào app trong frame)"
            >
              ✥ Di chuyển
            </button>
            <button
              type="button"
              className={!moveMode ? styles.modeBtnActive : styles.modeBtn}
              onClick={() => setMoveMode(false)}
              title="Click vào app trong frame; kéo frame bằng thanh tiêu đề"
            >
              ⇖ Tương tác
            </button>
            <button
              type="button"
              className={styles.modeBtn}
              onClick={() => setView('sim')}
              title="Mô phỏng action flow theo từng use case (đi từng bước qua các màn hình)"
            >
              ▶ Mô phỏng
            </button>
            <button
              type="button"
              className={styles.modeBtn}
              onClick={copyAllToFigma}
              disabled={copyAll === 'busy'}
              title="Copy TẤT CẢ màn hình thành frame Figma (H2D) — dán vào Figma bằng Cmd+V"
            >
              {copyAll === 'busy'
                ? '⧉ Đang trích xuất…'
                : copyAll === 'ok'
                  ? '✓ Đã copy — dán vào Figma'
                  : copyAll === 'err'
                    ? '⚠ Lỗi — thử lại'
                    : '⧉ Copy Figma'}
            </button>
          </Panel>
          <Background gap={32} size={1} color="var(--border, #e5e7eb)" />
          <Controls showInteractive={false} />
          <MiniMap pannable zoomable />
        </ReactFlow>
      </ReactFlowProvider>
    </div>
  );
}
