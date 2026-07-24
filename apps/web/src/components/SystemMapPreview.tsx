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
import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import {
  Background,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  Handle,
  MarkerType,
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
  subtle: 'var(--bg-subtle, #f5f6f8)',
  accent: 'var(--accent, #0066b3)',
  red: 'var(--red, #dc2626)',
  amber: 'var(--amber, #b45309)',
  green: 'var(--green, #16a34a)',
};

const APP_W = 224;
const APP_H = 132;
const COL_W = APP_W + 190;
const ROW_GAP = 44;

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
};

function AppNode({ data }: NodeProps) {
  const { app, docCount } = data as AppNodeData;
  const external = app.external === true;
  const wrap: CSSProperties = {
    width: APP_W,
    height: APP_H,
    borderRadius: 12,
    // External apps are part of the system but not of the build — dashed and
    // desaturated so "what we own" is readable without reading a legend.
    border: `1.5px ${external ? 'dashed' : 'solid'} ${external ? T.border : T.accent}`,
    background: external ? T.subtle : T.paper,
    boxShadow: external ? 'none' : '0 1px 3px rgba(0,0,0,.07)',
    padding: '10px 12px',
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    overflow: 'hidden',
  };
  return (
    <div style={wrap}>
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'space-between' }}>
        <strong
          style={{
            fontSize: 13,
            color: external ? T.soft : T.ink,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
          title={app.name ?? app.id}
        >
          {app.name ?? app.id}
        </strong>
        {external ? (
          <Chip text="ngoài phạm vi" dashed title="Hệ thống phụ thuộc app này nhưng dự án không build nó" />
        ) : app.audience ? (
          <Chip text={AUDIENCE_LABEL[app.audience] ?? app.audience} color={T.accent} />
        ) : null}
      </div>
      <code style={{ fontSize: 10.5, color: T.faint }}>{app.id}</code>
      <span
        style={{
          fontSize: 11.5,
          color: T.muted,
          lineHeight: 1.4,
          display: '-webkit-box',
          WebkitLineClamp: 3,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
        }}
        title={app.responsibility}
      >
        {app.responsibility || '(chưa ghi trách nhiệm)'}
      </span>
      <span style={{ marginTop: 'auto', fontSize: 11, color: docCount ? T.soft : T.faint }}>
        {docCount ? `${docCount} tài liệu` : 'chưa có tài liệu nào gán vào'}
      </span>
    </div>
  );
}

const NODE_TYPES = { app: AppNode };

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
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    borderRadius: 10,
  });
  const d = data as { label?: string; shift?: number; back?: boolean } | undefined;
  return (
    <>
      <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd as string | undefined} />
      {d?.label ? (
        <EdgeLabelRenderer>
          <div
            title={d.label}
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY + (d.shift ?? 0)}px)`,
              maxWidth: 165,
              padding: '2px 8px',
              borderRadius: 7,
              border: `1px ${d.back ? 'dashed' : 'solid'} ${T.border}`,
              background: T.paper,
              boxShadow: '0 1px 2px rgba(0,0,0,.06)',
              fontSize: 10.5,
              fontWeight: 600,
              color: d.back ? T.muted : T.ink,
              lineHeight: 1.3,
              textAlign: 'center',
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
              pointerEvents: 'none',
            }}
          >
            {d.label}
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
        data: { app: a, docCount: docCounts.get(String(a.id)) ?? 0 } satisfies AppNodeData,
      }));

    // One edge per hand-off, plus a dashed return edge when `back` is filled —
    // the way home is a different fact from the way out and hiding it inside a
    // tooltip is how a two-way integration reads as one-way.
    const drawn = handoffs.filter(
      (h) => h.from && h.to && known.has(String(h.from)) && known.has(String(h.to)),
    );
    const slots = new Map<number, number>();
    const gutterOf = (id: string) => Math.round((pos.get(id)?.x ?? 0) / COL_W);
    const edges: Edge[] = [];
    for (const [i, h] of drawn.entries()) {
      const from = String(h.from);
      const gutter = gutterOf(from);
      const slot = slots.get(gutter) ?? 0;
      slots.set(gutter, slot + 1);
      edges.push({
        id: `h${i}`,
        source: from,
        target: String(h.to),
        type: 'handoff',
        data: { label: h.trigger, slot, gutter },
        style: { stroke: T.ink, strokeWidth: 1.6 },
        markerEnd: { type: MarkerType.ArrowClosed, color: T.ink },
      });
      if (h.back) {
        edges.push({
          id: `h${i}-back`,
          source: String(h.to),
          target: from,
          type: 'handoff',
          data: { label: h.back, slot: slot + 1, gutter, back: true },
          style: { stroke: T.muted, strokeWidth: 1.3, strokeDasharray: '6 4' },
          markerEnd: { type: MarkerType.ArrowClosed, color: T.muted },
        });
      }
    }
    // Stagger label chips sharing a gutter so they never stack on one midpoint.
    const LABEL_SLOT = 38;
    const totals = new Map<number, number>();
    for (const e of edges) {
      const g = (e.data as { gutter: number }).gutter;
      totals.set(g, Math.max(totals.get(g) ?? 0, ((e.data as { slot: number }).slot ?? 0) + 1));
    }
    for (const e of edges) {
      const d = e.data as { slot: number; gutter: number; shift?: number };
      const total = totals.get(d.gutter) ?? 1;
      d.shift = total > 1 ? (d.slot - (total - 1) / 2) * LABEL_SLOT : 0;
    }
    return { nodes, edges };
  }, [apps, handoffs, docCounts]);

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  useEffect(() => {
    setNodes(built.nodes);
    setEdges(built.edges);
  }, [built, setNodes, setEdges]);

  return (
    <div style={{ height: 460, border: `1px solid ${T.border}`, borderRadius: 12, overflow: 'hidden', background: T.paper }}>
      <ReactFlowProvider>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
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
          zoomOnScroll={false}
          panOnScroll={false}
          preventScrolling={false}
        >
          <Background gap={22} size={1.4} />
          <Controls showInteractive={false} />
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
