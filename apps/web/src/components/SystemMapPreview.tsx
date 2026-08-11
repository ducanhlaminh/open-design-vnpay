// SystemMapPreview — render the `docs-map` stage's `docs/system-map.json` as an
// actual MAP instead of raw JSON.
//
// The file's whole point is that the docs describe ONE system made of several
// apps, and that responsibility passes between them at named hand-offs. Reading
// that as text means rebuilding the graph in your head; the three things worth
// seeing at a glance are:
//   1. who is in the system (including the apps this project does NOT build),
//   2. where responsibility crosses between them (the hand-offs), and
//   3. which document taught the agent what — with how sure it was.
// So: a hand-off graph on top, the hand-off details under it, then the document
// classification grouped by app. Read-only, open-design theme tokens.
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  Background,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  Handle,
  MarkerType,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  getSmoothStepPath,
  useEdgesState,
  useNodesState,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

export interface SystemMapSystem {
  name?: string;
  summary?: string;
}
export interface SystemMapApp {
  id?: string;
  name?: string;
  /** "user" | "backoffice" — omitted for apps outside this project. */
  audience?: string;
  /** true when the system depends on it but this project does not build it. */
  external?: boolean;
  responsibility?: string;
}
export interface SystemMapDocument {
  file?: string;
  /** MAY name several apps; `[]` means the agent could not place the doc. */
  apps?: string[];
  why?: string;
  confidence?: string; // high | medium | low
}
export interface SystemMapHandoff {
  from?: string;
  to?: string;
  trigger?: string;
  data?: string;
  /** How the result comes back to `from`, when it does. */
  back?: string;
  sources?: string[];
}
export interface SystemMapDoc {
  system?: SystemMapSystem;
  apps?: SystemMapApp[];
  documents?: SystemMapDocument[];
  handoffs?: SystemMapHandoff[];
}

/** Shape sniff used by SpecFileViewer. `apps[]` alone is too weak (a ux-spec
 * could carry one), so require the pairing that only a system map has: apps
 * carrying an id, plus documents-with-file or hand-offs-with-from/to. */
export function isSystemMapDoc(v: unknown): v is SystemMapDoc {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const m = v as SystemMapDoc;
  const hasApps =
    Array.isArray(m.apps) && m.apps.length > 0 && m.apps.every((a) => a && typeof a === 'object') &&
    m.apps.some((a) => typeof a.id === 'string');
  if (!hasApps) return false;
  const hasDocuments =
    Array.isArray(m.documents) && m.documents.some((d) => d && typeof d.file === 'string');
  const hasHandoffs =
    Array.isArray(m.handoffs) &&
    m.handoffs.some((h) => h && typeof h.from === 'string' && typeof h.to === 'string');
  return hasDocuments || hasHandoffs;
}

const T = {
  ink: 'var(--text, #1a1a1a)',
  soft: 'var(--text-soft, #4b5563)',
  muted: 'var(--text-muted, #6b7280)',
  faint: 'var(--text-faint, #9ca3af)',
  border: 'var(--border, #e1e5eb)',
  paper: 'var(--bg-panel, #fff)',
  /* --bg-panel is TRANSLUCENT (glassmorphism) — canvas surfaces must be
     OPAQUE or the page text bleeds through nodes/labels/the fullscreen
     overlay and nothing is readable. */
  paperSolid: 'var(--bg, #faf9f7)',
  subtle: 'var(--bg-subtle, #f5f6f8)',
  accent: 'var(--accent, #0066b3)',
  red: 'var(--red, #dc2626)',
  amber: 'var(--amber, #b45309)',
  green: 'var(--green, #16a34a)',
};

const APP_W = 248;
const APP_H = 150;
const COL_W = APP_W + 240;
const ROW_GAP = 84;

const AUDIENCE_LABEL: Record<string, string> = {
  user: 'Người dùng',
  backoffice: 'Backoffice',
};
const CONFIDENCE_LABEL: Record<string, string> = {
  high: 'chắc chắn',
  medium: 'tạm ổn',
  low: 'chưa chắc',
};
const confidenceColor = (c?: string) => (c === 'high' ? T.green : c === 'medium' ? T.amber : T.red);

function Chip({
  text,
  color,
  dashed,
  title,
}: {
  text: string;
  color?: string;
  dashed?: boolean;
  title?: string;
}) {
  return (
    <span
      title={title}
      style={{
        fontSize: 11,
        fontWeight: 600,
        padding: '1px 8px',
        borderRadius: 999,
        whiteSpace: 'nowrap',
        border: `1px ${dashed ? 'dashed' : 'solid'} ${color ?? T.border}`,
        color: color ?? T.soft,
        background: color ? `color-mix(in srgb, ${color} 10%, transparent)` : T.subtle,
      }}
    >
      {text}
    </span>
  );
}

// ── Canvas ──────────────────────────────────────────────────────────────────

type AppNodeData = {
  app: SystemMapApp;
  docCount: number;
  /** Quick-hide from the node itself (the panel chip un-hides). */
  onHide?: (id: string) => void;
};

function AppNode({ data }: NodeProps) {
  const { app, docCount, onHide } = data as AppNodeData;
  const external = app.external === true;
  const wrap: CSSProperties = {
    width: APP_W,
    height: APP_H,
    borderRadius: 12,
    // External apps are part of the system but not of the build — dashed and
    // desaturated so "what we own" is readable without reading a legend.
    border: `1.5px ${external ? 'dashed' : 'solid'} ${external ? T.border : T.accent}`,
    background: external ? T.subtle : T.paperSolid,
    boxShadow: external ? 'none' : '0 1px 3px rgba(0,0,0,.07)',
    padding: '10px 12px',
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    overflow: 'hidden',
  };
  return (
    <div style={wrap}>
      {/* Hidden handles on BOTH sides, in TWO LANES per side — edges attach to
          whichever side FACES the other node (handlesFor), and the forward
          edge rides the upper lane (38%) while the return edge rides the lower
          lane (62%): two parallel lines instead of one line drawn over the
          other. */}
      <Handle id="tgt-left-out" type="target" position={Position.Left} style={{ top: '38%', opacity: 0 }} />
      <Handle id="tgt-left-back" type="target" position={Position.Left} style={{ top: '62%', opacity: 0 }} />
      <Handle id="tgt-right-out" type="target" position={Position.Right} style={{ top: '38%', opacity: 0 }} />
      <Handle id="tgt-right-back" type="target" position={Position.Right} style={{ top: '62%', opacity: 0 }} />
      <Handle id="src-left-out" type="source" position={Position.Left} style={{ top: '38%', opacity: 0 }} />
      <Handle id="src-left-back" type="source" position={Position.Left} style={{ top: '62%', opacity: 0 }} />
      <Handle id="src-right-out" type="source" position={Position.Right} style={{ top: '38%', opacity: 0 }} />
      <Handle id="src-right-back" type="source" position={Position.Right} style={{ top: '62%', opacity: 0 }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'space-between' }}>
        <strong
          style={{
            fontSize: 14.5,
            color: T.ink,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
          title={app.name ?? app.id}
        >
          {app.name ?? app.id}
        </strong>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flex: 'none' }}>
          {external ? (
            <Chip text="ngoài phạm vi" dashed title="Hệ thống phụ thuộc app này nhưng dự án không build nó" />
          ) : app.audience ? (
            <Chip text={AUDIENCE_LABEL[app.audience] ?? app.audience} color={T.accent} />
          ) : null}
          {onHide && app.id ? (
            <button
              type="button"
              className="nodrag nopan"
              onClick={() => onHide(String(app.id))}
              title="Ẩn app này (và mọi đường nối vào nó) — bật lại ở panel góc trái"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 22,
                height: 22,
                padding: 0,
                border: `1px solid ${T.border}`,
                borderRadius: 6,
                background: 'transparent',
                color: T.soft,
                cursor: 'pointer',
                fontSize: 12,
                lineHeight: 1,
              }}
            >
              👁
            </button>
          ) : null}
        </span>
      </div>
      <code style={{ fontSize: 12, color: T.soft }}>{app.id}</code>
      <span
        style={{
          fontSize: 13,
          color: T.ink,
          lineHeight: 1.45,
          display: '-webkit-box',
          WebkitLineClamp: 3,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
        }}
        title={app.responsibility}
      >
        {app.responsibility || '(chưa ghi trách nhiệm)'}
      </span>
      <span style={{ marginTop: 'auto', fontSize: 12.5, color: T.soft }}>
        {docCount ? `${docCount} tài liệu` : 'chưa có tài liệu nào gán vào'}
      </span>
    </div>
  );
}

const NODE_TYPES = { app: AppNode };

/** One hand-off inside a merged edge — the tooltip lists the full exchange. */
type HandoffEdgeDetail = { trigger?: string; data?: string; back?: string };

function HandoffEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style,
  markerEnd,
  data,
}: EdgeProps) {
  const d = data as
    | { label?: string; extra?: number; details?: HandoffEdgeDetail[]; shift?: number; back?: boolean }
    | undefined;
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    borderRadius: 10,
    // Per-lane turn distance: on long L-shaped routes the VERTICAL run sits at
    // `node edge + offset` — with one shared offset the out and back lanes
    // collapse onto the same x there. The return lane turns 26px further out,
    // so the two verticals stay parallel just like the horizontals.
    offset: d?.back ? 46 : 20,
  });
  // Hover mở tooltip THẬT (title native không bao giờ hiện được khi label
  // pointer-events: none) và highlight đúng đường của label — mắt nối được
  // chip ↔ line giữa nhiều mũi tên.
  const [hover, setHover] = useState(false);
  const details = d?.details ?? [];
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        style={{
          ...style,
          ...(hover ? { stroke: T.accent, strokeWidth: 2.4, strokeDasharray: d?.back ? '6 4' : undefined } : {}),
        }}
        markerEnd={markerEnd as string | undefined}
      />
      {d?.label ? (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan"
            onMouseEnter={() => setHover(true)}
            onMouseLeave={() => setHover(false)}
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY + (d.shift ?? 0)}px)`,
              zIndex: hover ? 20 : 1,
              pointerEvents: 'all',
              cursor: 'default',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                maxWidth: 280,
                padding: '4px 10px',
                borderRadius: 8,
                border: `1.5px ${d.back ? 'dashed' : 'solid'} ${hover ? T.accent : T.soft}`,
                background: T.paperSolid,
                boxShadow: '0 1px 3px rgba(0,0,0,.1)',
                fontSize: 13,
                fontWeight: 600,
                color: T.ink,
                lineHeight: 1.35,
              }}
            >
              <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {d.label}
              </span>
              {d.extra ? (
                <span
                  style={{
                    flex: 'none',
                    padding: '0 7px',
                    borderRadius: 999,
                    background: `color-mix(in srgb, ${T.accent} 16%, transparent)`,
                    color: T.accent,
                    fontSize: 12,
                    fontWeight: 700,
                  }}
                >
                  +{d.extra}
                </span>
              ) : null}
            </div>
            {/* Tooltip: TOÀN BỘ trao đổi của cặp app này, không cắt chữ. */}
            {hover && details.length > 0 ? (
              <div
                style={{
                  position: 'absolute',
                  top: 'calc(100% + 6px)',
                  left: '50%',
                  transform: 'translateX(-50%)',
                  width: 380,
                  maxWidth: '80vw',
                  padding: '12px 14px',
                  borderRadius: 10,
                  border: `1px solid ${T.soft}`,
                  background: T.paperSolid,
                  boxShadow: '0 12px 32px rgba(0,0,0,.16)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                  pointerEvents: 'none',
                  textAlign: 'left',
                }}
              >
                {details.map((item, i) => (
                  <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                    <span style={{ fontSize: 13.5, fontWeight: 700, color: T.ink, lineHeight: 1.45 }}>
                      {details.length > 1 ? `${i + 1}. ` : ''}
                      {item.trigger ?? '—'}
                    </span>
                    {item.data ? (
                      <span style={{ fontSize: 12.5, color: T.ink, lineHeight: 1.45 }}>{item.data}</span>
                    ) : null}
                    {item.back ? (
                      <span style={{ fontSize: 12.5, color: T.soft, fontStyle: 'italic', lineHeight: 1.45 }}>
                        ↩ {item.back}
                      </span>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}

const EDGE_TYPES = { handoff: HandoffEdge };

/** Left→right layering by BFS depth over the hand-off graph (roots = apps
 * nothing hands off to), siblings stacked and ordered by the average row of
 * their predecessors so edges stay near-horizontal. Apps with no hand-off at
 * all still get placed — an unconnected app is a real finding, not a reason to
 * drop it from the map. */
function layoutApps(
  apps: SystemMapApp[],
  handoffs: SystemMapHandoff[],
): Map<string, { x: number; y: number }> {
  const ids = apps.map((a) => String(a.id ?? '')).filter(Boolean);
  const known = new Set(ids);
  const edges = handoffs
    .map((h) => ({ from: String(h.from ?? ''), to: String(h.to ?? '') }))
    .filter((e) => known.has(e.from) && known.has(e.to) && e.from !== e.to);

  const out = new Map<string, string[]>();
  const indeg = new Map<string, number>(ids.map((id) => [id, 0]));
  for (const e of edges) {
    out.set(e.from, [...(out.get(e.from) ?? []), e.to]);
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  }
  const roots = ids.filter((id) => (indeg.get(id) ?? 0) === 0);
  const depth = new Map<string, number>();
  const queue = (roots.length ? roots : ids.slice(0, 1)).map((id) => ({ id, d: 0 }));
  while (queue.length) {
    const { id, d } = queue.shift()!;
    if (depth.has(id)) continue;
    depth.set(id, d);
    for (const to of out.get(id) ?? []) queue.push({ id: to, d: d + 1 });
  }
  for (const id of ids) if (!depth.has(id)) depth.set(id, 0);

  const byCol = new Map<number, string[]>();
  for (const [id, d] of depth) byCol.set(d, [...(byCol.get(d) ?? []), id]);
  const preds = new Map<string, string[]>();
  for (const e of edges) preds.set(e.to, [...(preds.get(e.to) ?? []), e.from]);

  const cols = [...byCol.keys()].sort((a, b) => a - b);
  const rowIndex = new Map<string, number>();
  for (const c of cols) {
    const col = byCol.get(c)!;
    if (c !== cols[0]) {
      const bary = (id: string) => {
        const rows = (preds.get(id) ?? [])
          .map((p) => rowIndex.get(p))
          .filter((r): r is number => r !== undefined);
        return rows.length ? rows.reduce((a, b) => a + b, 0) / rows.length : Number.MAX_SAFE_INTEGER;
      };
      col.sort((a, b) => bary(a) - bary(b));
    }
    col.forEach((id, i) => rowIndex.set(id, i));
  }

  const colHeight = (c: number) => byCol.get(c)!.length * (APP_H + ROW_GAP) - ROW_GAP;
  const maxH = Math.max(...cols.map(colHeight));
  const pos = new Map<string, { x: number; y: number }>();
  for (const c of cols) {
    let y = (maxH - colHeight(c)) / 2;
    for (const id of byCol.get(c)!) {
      pos.set(id, { x: c * COL_W, y });
      y += APP_H + ROW_GAP;
    }
  }
  return pos;
}

function SystemMapCanvas({
  apps,
  handoffs,
  docCounts,
}: {
  apps: SystemMapApp[];
  handoffs: SystemMapHandoff[];
  docCounts: Map<string, number>;
}) {
  // Ẩn/hiện app: node ẩn kéo theo MỌI edge chạm nó (đỡ rối khi soi một
  // nhánh); bật lại bằng chip trong panel góc trái.
  const [hiddenApps, setHiddenApps] = useState<Set<string>>(new Set());
  const built = useMemo(() => {
    const pos = layoutApps(apps, handoffs);
    const known = new Set(apps.map((a) => String(a.id ?? '')));
    const nodes: Node[] = apps
      .filter((a) => a.id)
      .map((a) => ({
        id: String(a.id),
        type: 'app',
        position: pos.get(String(a.id)) ?? { x: 0, y: 0 },
        draggable: true,
        data: {
          app: a,
          docCount: docCounts.get(String(a.id)) ?? 0,
          onHide: (id: string) => setHiddenApps((cur) => new Set(cur).add(id)),
        } satisfies AppNodeData,
      }));

    // MERGE per (from, to): several hand-offs between the same pair used to be
    // several near-identical smoothstep paths with label chips staggered by a
    // GLOBAL per-column slot — chips detached from their own line and still
    // piling up. One forward edge per pair now carries them all (first trigger
    // + a "+N" badge; the full numbered exchange lives in the hover tooltip),
    // plus ONE dashed return edge when any of them answers back — the way home
    // is a different fact from the way out.
    const drawn = handoffs.filter(
      (h) => h.from && h.to && known.has(String(h.from)) && known.has(String(h.to)),
    );
    const pairs = new Map<string, SystemMapHandoff[]>();
    const pairOrder: string[] = [];
    for (const h of drawn) {
      const key = `${String(h.from)}\u0000${String(h.to)}`;
      if (!pairs.has(key)) {
        pairs.set(key, []);
        pairOrder.push(key);
      }
      pairs.get(key)!.push(h);
    }
    // Attach each edge to the sides of the two cards that FACE each other —
    // a fixed right→left convention sent every right-to-left hand-off (and
    // every return edge) on a lap around the whole map, crossing other cards.
    const handlesFor = (sourceId: string, targetId: string, lane: 'out' | 'back') => {
      const sx = pos.get(sourceId)?.x ?? 0;
      const tx = pos.get(targetId)?.x ?? 0;
      return sx <= tx
        ? { sourceHandle: `src-right-${lane}`, targetHandle: `tgt-left-${lane}` }
        : { sourceHandle: `src-left-${lane}`, targetHandle: `tgt-right-${lane}` };
    };
    const edges: Edge[] = [];
    for (const [i, key] of pairOrder.entries()) {
      const group = pairs.get(key)!;
      const [from, to] = key.split('\u0000') as [string, string];
      const details = group.map((h) => ({
        ...(h.trigger ? { trigger: h.trigger } : {}),
        ...(h.data ? { data: h.data } : {}),
        ...(h.back ? { back: h.back } : {}),
      }));
      const firstLabel = group.find((h) => h.trigger)?.trigger ?? `${group.length} bàn giao`;
      edges.push({
        id: `h${i}`,
        source: from,
        target: to,
        type: 'handoff',
        ...handlesFor(from, to, 'out'),
        // Forward chip sits just ABOVE its own midpoint, return chip just
        // BELOW — always visually attached to their line.
        data: { label: firstLabel, extra: group.length - 1, details, shift: -16 },
        style: { stroke: T.ink, strokeWidth: 1.6 },
        markerEnd: { type: MarkerType.ArrowClosed, color: T.ink },
      });
      const backs = group.filter((h) => h.back);
      if (backs.length > 0) {
        edges.push({
          id: `h${i}-back`,
          source: to,
          target: from,
          type: 'handoff',
          ...handlesFor(to, from, 'back'),
          data: {
            label: backs[0]!.back,
            extra: backs.length - 1,
            details,
            shift: 16,
            back: true,
          },
          style: { stroke: T.soft, strokeWidth: 1.5, strokeDasharray: '6 4' },
          markerEnd: { type: MarkerType.ArrowClosed, color: T.soft },
        });
      }
    }
    return { nodes, edges };
  }, [apps, handoffs, docCounts]);

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  useEffect(() => {
    setNodes(built.nodes.map((n) => ({ ...n, hidden: hiddenApps.has(n.id) })));
    setEdges(
      built.edges.map((e) => ({
        ...e,
        hidden: hiddenApps.has(e.source) || hiddenApps.has(e.target),
      })),
    );
  }, [built, hiddenApps, setNodes, setEdges]);

  // Fullscreen: phóng canvas ra overlay toàn màn hình (Esc / nút để thoát).
  // Sau khi đổi kích thước phải fitView lại — React Flow không tự re-fit.
  const [fullscreen, setFullscreen] = useState(false);
  const flowRef = useRef<ReactFlowInstance | null>(null);
  useEffect(() => {
    if (!fullscreen) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFullscreen(false);
    };
    document.addEventListener('keydown', onKey);
    // Trang phía sau không được cuộn khi overlay đang mở.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [fullscreen]);
  useEffect(() => {
    const id = window.setTimeout(
      () => flowRef.current?.fitView({ padding: 0.16, maxZoom: 1 }),
      60,
    );
    return () => window.clearTimeout(id);
  }, [fullscreen]);

  return (
    <div
      style={
        fullscreen
          ? {
              position: 'fixed',
              inset: 0,
              zIndex: 1300,
              background: T.paperSolid,
              display: 'flex',
              flexDirection: 'column',
            }
          : { height: 520, border: `1px solid ${T.border}`, borderRadius: 12, overflow: 'hidden', background: T.paperSolid }
      }
    >
      <ReactFlowProvider>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onInit={(instance) => {
            flowRef.current = instance;
          }}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          fitView
          fitViewOptions={{ padding: 0.16, maxZoom: 1 }}
          minZoom={0.2}
          proOptions={{ hideAttribution: true }}
          nodesConnectable={false}
          nodesDraggable
          elementsSelectable
          panOnDrag
          // The canvas is embedded in a SCROLLING report — grabbing the wheel
          // here would trap the page scroll. Zoom lives on the Controls.
          // Fullscreen has no page behind it, so the wheel is safe to take.
          zoomOnScroll={fullscreen}
          panOnScroll={false}
          preventScrolling={fullscreen}
        >
          <Background gap={22} size={1.4} />
          <Controls showInteractive={false} />
          {hiddenApps.size > 0 ? (
            <Panel position="top-left">
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  flexWrap: 'wrap',
                  maxWidth: 460,
                  padding: '6px 8px',
                  borderRadius: 8,
                  border: `1px solid ${T.border}`,
                  background: T.paperSolid,
                  boxShadow: '0 1px 3px rgba(0,0,0,.1)',
                }}
              >
                <span style={{ fontSize: 11.5, fontWeight: 700, color: T.soft }}>Đang ẩn:</span>
                {[...hiddenApps].map((id) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() =>
                      setHiddenApps((cur) => {
                        const next = new Set(cur);
                        next.delete(id);
                        return next;
                      })
                    }
                    title="Hiện lại app này"
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 4,
                      padding: '2px 8px',
                      borderRadius: 999,
                      border: `1px dashed ${T.soft}`,
                      background: 'transparent',
                      color: T.ink,
                      fontSize: 11.5,
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                  >
                    {apps.find((a) => String(a.id) === id)?.name ?? id}
                    <span aria-hidden="true">✕</span>
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => setHiddenApps(new Set())}
                  style={{
                    padding: '2px 8px',
                    borderRadius: 999,
                    border: 0,
                    background: 'transparent',
                    color: T.accent,
                    fontSize: 11.5,
                    fontWeight: 700,
                    cursor: 'pointer',
                  }}
                >
                  Hiện tất cả
                </button>
              </div>
            </Panel>
          ) : null}
          <Panel position="top-right">
            <button
              type="button"
              onClick={() => setFullscreen((v) => !v)}
              title={fullscreen ? 'Thoát toàn màn hình (Esc)' : 'Xem toàn màn hình'}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '6px 12px',
                borderRadius: 8,
                border: `1px solid ${T.soft}`,
                background: T.paperSolid,
                color: T.ink,
                fontSize: 12.5,
                fontWeight: 600,
                cursor: 'pointer',
                boxShadow: '0 1px 3px rgba(0,0,0,.12)',
              }}
            >
              {fullscreen ? '✕ Thoát (Esc)' : '⛶ Toàn màn hình'}
            </button>
          </Panel>
        </ReactFlow>
      </ReactFlowProvider>
    </div>
  );
}

// ── Report ──────────────────────────────────────────────────────────────────

function baseName(path: string): string {
  const i = path.lastIndexOf('/');
  return i >= 0 ? path.slice(i + 1) : path;
}

// Sequence/swimlane của các bàn giao: lifeline dọc cho từng app tham gia,
// mỗi handoff một mũi tên NGANG theo đúng thứ tự khai trong system-map.json
// (mũi tên liền = trigger + data; mũi tên đứt quay về = `back`). SVG thuần —
// bố cục cột đều nhau nên không cần thư viện đồ thị.
function HandoffSequence({ apps, handoffs }: { apps: SystemMapApp[]; handoffs: SystemMapHandoff[] }) {
  // Lanes: chỉ app THAM GIA bàn giao, app trong dự án trước, external sau.
  const laneIds = useMemo(() => {
    const involved = new Set<string>();
    for (const h of handoffs) {
      if (h.from) involved.add(String(h.from));
      if (h.to) involved.add(String(h.to));
    }
    const ordered = apps.map((a) => String(a.id)).filter((id) => involved.has(id));
    const known = new Set(ordered);
    for (const id of involved) if (!known.has(id)) ordered.push(id);
    return ordered.sort((a, b) => {
      const ea = apps.find((x) => String(x.id) === a)?.external ? 1 : 0;
      const eb = apps.find((x) => String(x.id) === b)?.external ? 1 : 0;
      return ea - eb;
    });
  }, [apps, handoffs]);
  const nameOf = (id: string) => apps.find((a) => String(a.id) === id)?.name ?? id;
  if (laneIds.length < 2) return null;

  const LANE_W = Math.max(210, Math.min(320, 960 / laneIds.length));
  const HEAD_H = 52;
  const ROW_H = 78;
  const BACK_H = 42;
  const laneX = (id: string) => laneIds.indexOf(id) * LANE_W + LANE_W / 2;
  // y tăng dần theo thứ tự handoff; handoff có `back` chiếm thêm một hàng phụ.
  const rows: Array<{ h: SystemMapHandoff; y: number; backY: number | null }> = [];
  let y = HEAD_H + 28;
  for (const h of handoffs) {
    if (!h.from || !h.to) continue;
    const backY = h.back ? y + BACK_H : null;
    rows.push({ h, y, backY });
    y += ROW_H + (h.back ? BACK_H : 0);
  }
  const totalH = y + 16;
  const totalW = laneIds.length * LANE_W;
  const trim = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

  return (
    <div style={{ border: `1px solid ${T.border}`, borderRadius: 12, background: T.paperSolid, overflowX: 'auto' }}>
      <svg width={totalW} height={totalH} style={{ display: 'block', margin: '0 auto', maxWidth: '100%' }} role="img" aria-label="Trình tự bàn giao giữa các app">
        <defs>
          <marker id="seq-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill={T.ink} />
          </marker>
          <marker id="seq-arrow-back" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill={T.soft} />
          </marker>
        </defs>
        {laneIds.map((id) => {
          const x = laneX(id);
          const external = apps.find((a) => String(a.id) === id)?.external === true;
          return (
            <g key={id}>
              <rect x={x - LANE_W / 2 + 10} y={8} width={LANE_W - 20} height={HEAD_H - 14} rx={8} fill={T.subtle} stroke={T.soft} strokeDasharray={external ? '4 3' : undefined} />
              <text x={x} y={8 + (HEAD_H - 14) / 2 + 5} textAnchor="middle" fontSize={14} fontWeight={700} fill={T.ink}>
                {trim(nameOf(id), Math.floor(LANE_W / 8))}
              </text>
              <line x1={x} y1={HEAD_H} x2={x} y2={totalH - 8} stroke={T.soft} strokeDasharray="3 4" opacity={0.5} />
            </g>
          );
        })}
        {rows.map(({ h, y: rowY, backY }, i) => {
          const x1 = laneX(String(h.from));
          const x2 = laneX(String(h.to));
          const mid = (x1 + x2) / 2;
          return (
            <g key={i}>
              <line x1={x1} y1={rowY} x2={x2} y2={rowY} stroke={T.ink} strokeWidth={1.8} markerEnd="url(#seq-arrow)" />
              {h.trigger ? (
                <text x={mid} y={rowY - 22} textAnchor="middle" fontSize={13.5} fontWeight={700} fill={T.ink}>
                  {trim(`${i + 1}. ${h.trigger}`, Math.floor(Math.abs(x2 - x1) / 7) + 24)}
                </text>
              ) : null}
              {h.data ? (
                <text x={mid} y={rowY - 6} textAnchor="middle" fontSize={12.5} fill={T.ink}>
                  {trim(h.data, Math.floor(Math.abs(x2 - x1) / 6.5) + 20)}
                </text>
              ) : null}
              {backY !== null ? (
                <g>
                  <line x1={x2} y1={backY} x2={x1} y2={backY} stroke={T.soft} strokeWidth={1.5} strokeDasharray="5 4" markerEnd="url(#seq-arrow-back)" />
                  {h.back ? (
                    <text x={mid} y={backY - 6} textAnchor="middle" fontSize={12.5} fill={T.soft} fontStyle="italic">
                      {trim(h.back, Math.floor(Math.abs(x2 - x1) / 6.5) + 20)}
                    </text>
                  ) : null}
                </g>
              ) : null}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export function SystemMapPreview({ doc }: { doc: SystemMapDoc }) {
  const apps = useMemo(() => (doc.apps ?? []).filter((a) => a && a.id), [doc.apps]);
  const documents = useMemo(() => (doc.documents ?? []).filter((d) => d && d.file), [doc.documents]);
  const handoffs = useMemo(
    () => (doc.handoffs ?? []).filter((h) => h && h.from && h.to),
    [doc.handoffs],
  );
  const appById = useMemo(
    () => new Map(apps.map((a) => [String(a.id), a])),
    [apps],
  );
  const nameOf = (id: string) => appById.get(id)?.name ?? id;

  const docCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const d of documents) {
      for (const id of d.apps ?? []) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return counts;
  }, [documents]);

  const unplaced = useMemo(() => documents.filter((d) => !(d.apps ?? []).length), [documents]);

  // Validation the downstream stages rely on (see the skill's schema.md). A
  // dangling id silently drops a document or a hand-off from every later stage,
  // so surface it here rather than letting it fail three stages downstream.
  const danglingIds = useMemo(() => {
    const bad = new Set<string>();
    for (const d of documents) for (const id of d.apps ?? []) if (!appById.has(id)) bad.add(id);
    for (const h of handoffs) {
      if (!appById.has(String(h.from))) bad.add(String(h.from));
      if (!appById.has(String(h.to))) bad.add(String(h.to));
    }
    return [...bad];
  }, [documents, handoffs, appById]);

  const byApp = useMemo(() => {
    const map = new Map<string, SystemMapDocument[]>();
    for (const a of apps) map.set(String(a.id), []);
    for (const d of documents) {
      for (const id of d.apps ?? []) map.set(id, [...(map.get(id) ?? []), d]);
    }
    return [...map.entries()].filter(([, list]) => list.length > 0);
  }, [apps, documents]);

  const [openApp, setOpenApp] = useState<string | null>(null);

  return (
    <div style={{ padding: '16px 20px 32px', display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 1000, margin: '0 auto' }}>
      <header style={{ border: `1px solid ${T.border}`, borderRadius: 12, background: T.paper, padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        <strong style={{ fontSize: 17, color: T.ink }}>
          Bản đồ hệ thống{doc.system?.name ? ` · ${doc.system.name}` : ''}
        </strong>
        {doc.system?.summary ? (
          <p style={{ margin: 0, fontSize: 13, color: T.soft, lineHeight: 1.55 }}>{doc.system.summary}</p>
        ) : null}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Chip text={`${apps.length} app`} />
          <Chip text={`${apps.filter((a) => a.external).length} ngoài phạm vi`} />
          <Chip text={`${handoffs.length} điểm bàn giao`} />
          <Chip text={`${documents.length} tài liệu`} />
          {unplaced.length ? <Chip text={`${unplaced.length} chưa phân loại`} color={T.amber} /> : null}
        </div>
      </header>

      {danglingIds.length ? (
        <div style={{ fontSize: 12.5, color: T.amber, border: `1px solid ${T.border}`, borderRadius: 8, padding: '10px 14px', background: T.subtle, lineHeight: 1.5 }}>
          <strong>Id app không tồn tại trong <code>apps[]</code>:</strong> {danglingIds.join(', ')}. Các
          bước sau khớp theo id nên tài liệu / bàn giao trỏ vào đó sẽ bị bỏ qua — sửa trực tiếp trong{' '}
          <code>docs/system-map.json</code> hoặc chạy lại bước Bản đồ hệ thống.
        </div>
      ) : null}

      {apps.length ? (
        <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <h3 style={{ margin: 0, fontSize: 13, fontWeight: 700, color: T.muted, textTransform: 'uppercase', letterSpacing: 0.4 }}>
            Sơ đồ bàn giao
          </h3>
          <SystemMapCanvas apps={apps} handoffs={handoffs} docCounts={docCounts} />
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 11.5, color: T.muted }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 22, height: 0, borderTop: `2px solid ${T.ink}` }} />
              Bàn giao đi
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 22, height: 0, borderTop: `2px dashed ${T.muted}` }} />
              Kết quả trả về
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 14, height: 10, border: `1.5px dashed ${T.border}`, borderRadius: 3 }} />
              App ngoài phạm vi dự án
            </span>
            <span>Kéo để di chuyển · zoom bằng nút góc dưới</span>
          </div>
        </section>
      ) : null}

      {/* Trình tự phối hợp (swimlane/sequence): mỗi app một lifeline, các bàn
          giao vẽ THEO THỨ TỰ khai trong system-map — đây là cái nhìn "use case
          chạy xuyên app" (mobile gửi → BO duyệt → mobile nhận) mà sơ đồ graph
          phía trên không thể hiện được thứ tự. */}
      {handoffs.length >= 1 && apps.filter((a) => !a.external).length >= 2 ? (
        <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <h3 style={{ margin: 0, fontSize: 13, fontWeight: 700, color: T.muted, textTransform: 'uppercase', letterSpacing: 0.4 }}>
            Trình tự phối hợp giữa các app
          </h3>
          <HandoffSequence apps={apps} handoffs={handoffs} />
        </section>
      ) : null}

      {handoffs.length ? (
        <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <h3 style={{ margin: 0, fontSize: 13, fontWeight: 700, color: T.muted, textTransform: 'uppercase', letterSpacing: 0.4 }}>
            Chi tiết bàn giao ({handoffs.length})
          </h3>
          {handoffs.map((h, i) => (
            <article
              key={`${h.from}-${h.to}-${i}`}
              style={{ border: `1px solid ${T.border}`, borderRadius: 10, background: T.paper, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 13, fontWeight: 700, color: T.ink }}>
                <span>{nameOf(String(h.from))}</span>
                <span style={{ color: T.accent }}>→</span>
                <span>{nameOf(String(h.to))}</span>
              </div>
              <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '4px 12px', fontSize: 12.5, lineHeight: 1.5 }}>
                {h.trigger ? (
                  <>
                    <dt style={{ color: T.muted }}>Kích hoạt</dt>
                    <dd style={{ margin: 0, color: T.soft }}>{h.trigger}</dd>
                  </>
                ) : null}
                {h.data ? (
                  <>
                    <dt style={{ color: T.muted }}>Dữ liệu</dt>
                    <dd style={{ margin: 0, color: T.soft }}>{h.data}</dd>
                  </>
                ) : null}
                {h.back ? (
                  <>
                    <dt style={{ color: T.muted }}>Trả về</dt>
                    <dd style={{ margin: 0, color: T.soft }}>{h.back}</dd>
                  </>
                ) : null}
              </dl>
              {h.sources?.length ? (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {h.sources.map((s) => (
                    <Chip key={s} text={baseName(s)} title={s} />
                  ))}
                </div>
              ) : null}
            </article>
          ))}
        </section>
      ) : null}

      {byApp.length ? (
        <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <h3 style={{ margin: 0, fontSize: 13, fontWeight: 700, color: T.muted, textTransform: 'uppercase', letterSpacing: 0.4 }}>
            Tài liệu theo app
          </h3>
          {byApp.map(([id, list]) => {
            const open = openApp === id;
            return (
              <div key={id} style={{ border: `1px solid ${T.border}`, borderRadius: 10, background: T.paper, overflow: 'hidden' }}>
                <button
                  type="button"
                  onClick={() => setOpenApp(open ? null : id)}
                  style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', background: 'none', border: 0, cursor: 'pointer', textAlign: 'left' }}
                >
                  <strong style={{ fontSize: 13, color: T.ink }}>{nameOf(id)}</strong>
                  <code style={{ fontSize: 10.5, color: T.faint }}>{id}</code>
                  <span style={{ marginLeft: 'auto', fontSize: 12, color: T.muted }}>
                    {list.length} tài liệu {open ? '▾' : '▸'}
                  </span>
                </button>
                {open ? (
                  <ul style={{ margin: 0, padding: '0 14px 12px', listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {list.map((d) => (
                      <li key={d.file} style={{ display: 'flex', flexDirection: 'column', gap: 3, borderTop: `1px solid ${T.border}`, paddingTop: 8 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                          <code style={{ fontSize: 12, color: T.ink }} title={d.file}>{baseName(String(d.file))}</code>
                          <Chip
                            text={CONFIDENCE_LABEL[d.confidence ?? ''] ?? d.confidence ?? '—'}
                            color={confidenceColor(d.confidence)}
                            title="Mức tự tin của agent khi xếp tài liệu này vào app"
                          />
                          {(d.apps ?? []).length > 1 ? (
                            <Chip text={`dùng chung ${d.apps!.length} app`} title={d.apps!.join(', ')} />
                          ) : null}
                        </div>
                        {d.why ? (
                          <span style={{ fontSize: 12, color: T.muted, lineHeight: 1.5 }}>{d.why}</span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            );
          })}
        </section>
      ) : null}

      {unplaced.length ? (
        <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <h3 style={{ margin: 0, fontSize: 13, fontWeight: 700, color: T.amber, textTransform: 'uppercase', letterSpacing: 0.4 }}>
            Chưa xếp được vào app nào ({unplaced.length})
          </h3>
          <p style={{ margin: 0, fontSize: 12.5, color: T.muted, lineHeight: 1.5 }}>
            Các bước sau đọc tài liệu theo app, nên những file này sẽ không được stage nào lấy. Sửa
            <code> apps[]</code> của chúng trong <code>docs/system-map.json</code> nếu chúng thật sự
            thuộc về một app.
          </p>
          <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {unplaced.map((d) => (
              <li key={d.file} style={{ fontSize: 12.5, color: T.soft }}>
                <code title={d.file}>{baseName(String(d.file))}</code>
                {d.why ? <span style={{ color: T.muted }}> — {d.why}</span> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
