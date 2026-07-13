// SpecFlowCanvas — the UX Spec "user flow" view: wireframes + RULE FLOWCHART.
// Renders the ux stage's `flows/<FLOW-ID>.flow.json` (decision/end nodes +
// labeled edges between screen ids) as a React Flow chart whose screen nodes
// are the screens' own wireframe thumbnails (WireFrameView, scaled down) —
// replacing the retired Mermaid view. Screens are implicit nodes: any edge
// endpoint matching a spec screen id renders as that screen; `nodes[]` in the
// flow file lists only decisions/ends. With no flow files (older ux runs) one
// implicit flow is derived from the components' `navigates_to` edges so the
// tab still shows the navigation graph.
import { useMemo, useState, type CSSProperties } from 'react';
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
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { WireFrameView, DEVICES, type WireDoc } from './WireFrameView';
import type { SpecDoc } from './SpecPreview';

export interface FlowDocNode {
  id: string;
  kind: 'decision' | 'end' | 'screen';
  label?: string;
  screen?: string;
}
export interface FlowDoc {
  id: string;
  name?: string;
  entry?: string;
  nodes?: FlowDocNode[];
  edges?: Array<{ from?: string; to?: string; label?: string }>;
}

export function isFlowDoc(v: unknown): v is FlowDoc {
  if (!v || typeof v !== 'object') return false;
  const f = v as FlowDoc;
  return typeof f.id === 'string' && Array.isArray(f.edges);
}

/** Old ux runs have no flow files — derive one implicit flow from the spec's
 * `navigates_to` edges so the Flow tab still shows the screen graph. */
export function deriveFlowFromSpec(spec: SpecDoc): FlowDoc | null {
  const screens = (spec as { screens?: Array<Record<string, any>> }).screens ?? [];
  const ids = new Set(screens.map((s) => String(s.id ?? '')));
  const edges: FlowDoc['edges'] = [];
  for (const s of screens) {
    for (const c of (s.components ?? []) as Array<Record<string, any>>) {
      const to = typeof c.navigates_to === 'string' ? c.navigates_to : '';
      if (to && ids.has(to)) {
        edges.push({ from: String(s.id), to, label: String(c.label ?? '') });
      }
    }
  }
  if (!edges.length) return null;
  return { id: 'FLOW-NAV', name: 'Điều hướng (từ navigates_to)', edges };
}

const T = {
  ink: 'var(--text, #1a1a1a)',
  muted: 'var(--text-muted, #6b7280)',
  border: 'var(--border, #e1e5eb)',
  paper: 'var(--bg-panel, #fff)',
  accent: 'var(--accent, #0066b3)',
};

// Node box sizes (layout uses these; React Flow nodes are absolutely placed).
const SCREEN_W = 210;
const SCREEN_H = 300;
const DECISION_W = 170;
const DECISION_H = 150;
const END_W = 170;
const END_H = 56;
const NODE_GAP = 48;
// Wide gutters so smoothstep edges + their labels have room between columns.
const COL_W = SCREEN_W + 190;

// Edge with an HTML label chip: React Flow's default SVG labels are single-line
// (no wrapping), so long agent-authored labels overflow across the chart. The
// chip wraps to 2 lines, ellipsizes, carries the full text as a hover tooltip,
// and neighbouring labels are staggered vertically (data.shift) so parallel
// edges don't stack their chips on the same midpoint.
function LabeledEdge({
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
  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    borderRadius: 10,
  });
  const label = (data as { label?: string } | undefined)?.label;
  const shift = (data as { shift?: number } | undefined)?.shift ?? 0;
  return (
    <>
      <BaseEdge id={id} path={edgePath} style={style} markerEnd={markerEnd as string | undefined} />
      {label ? (
        <EdgeLabelRenderer>
          <div
            title={label}
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY + shift}px)`,
              maxWidth: 170,
              padding: '2px 8px',
              borderRadius: 7,
              border: `1px solid ${T.border}`,
              background: 'var(--bg-panel, #fff)',
              boxShadow: '0 1px 2px rgba(0,0,0,.06)',
              fontSize: 10.5,
              fontWeight: 600,
              color: T.ink,
              lineHeight: 1.3,
              textAlign: 'center',
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
              pointerEvents: 'all',
            }}
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}

const EDGE_TYPES = { labeled: LabeledEdge };

type FlowNodeData = {
  title: string;
  wire?: WireDoc | null;
  platform?: string;
};

function ScreenFlowNode({ data }: NodeProps) {
  const d = data as FlowNodeData;
  const isWeb = d.platform === 'web';
  const natural = isWeb ? DEVICES.desktop.w : DEVICES.mobile.w;
  const scale = (SCREEN_W - 18) / natural;
  const wrap: CSSProperties = {
    width: SCREEN_W,
    height: SCREEN_H,
    borderRadius: 10,
    border: `1px solid ${T.border}`,
    background: T.paper,
    boxShadow: '0 1px 3px rgba(0,0,0,.07)',
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
  };
  return (
    <div style={wrap}>
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
      <div style={{ padding: '6px 10px', fontSize: 11.5, fontWeight: 700, color: T.ink, borderBottom: `1px solid ${T.border}`, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {d.title}
      </div>
      <div style={{ flex: 1, overflow: 'hidden', position: 'relative', background: 'var(--bg-subtle, #f5f6f8)' }}>
        {d.wire ? (
          <div
            style={{
              width: natural,
              transform: `scale(${scale})`,
              transformOrigin: 'top left',
              pointerEvents: 'none',
              position: 'absolute',
              inset: 0,
            }}
          >
            <WireFrameView doc={d.wire} platform={d.platform} />
          </div>
        ) : (
          <div style={{ display: 'grid', placeItems: 'center', height: '100%', fontSize: 11, color: T.muted, padding: 10, textAlign: 'center' }}>
            (chưa có wireframe cho màn này)
          </div>
        )}
      </div>
    </div>
  );
}

function DecisionFlowNode({ data }: NodeProps) {
  const d = data as FlowNodeData;
  const side = Math.min(DECISION_W, DECISION_H) - 26;
  return (
    <div style={{ width: DECISION_W, height: DECISION_H, position: 'relative', display: 'grid', placeItems: 'center' }}>
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
      <div
        style={{
          width: side,
          height: side,
          transform: 'rotate(45deg)',
          background: 'var(--warn-weak, #fff8dc)',
          border: '1.5px solid var(--warn, #b45309)',
          borderRadius: 8,
        }}
      />
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'grid',
          placeItems: 'center',
          padding: 20,
          textAlign: 'center',
          fontSize: 11,
          fontWeight: 700,
          color: T.ink,
          lineHeight: 1.25,
        }}
      >
        {/* Clamp: a long question must not spill outside the diamond. */}
        <span
          style={{
            display: '-webkit-box',
            WebkitLineClamp: 5,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}
          title={d.title}
        >
          {d.title}
        </span>
      </div>
    </div>
  );
}

function EndFlowNode({ data }: NodeProps) {
  const d = data as FlowNodeData;
  return (
    <div
      style={{
        width: END_W,
        minHeight: END_H,
        borderRadius: 999,
        border: '1.5px solid var(--green, #16a34a)',
        background: 'var(--ok-weak, #e8f7ee)',
        display: 'grid',
        placeItems: 'center',
        padding: '10px 16px',
        fontSize: 12,
        fontWeight: 700,
        color: T.ink,
        textAlign: 'center',
      }}
    >
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
      {d.title}
    </div>
  );
}

const NODE_TYPES = { screen: ScreenFlowNode, decision: DecisionFlowNode, end: EndFlowNode };

/** Layered left→right layout: BFS depth from the entry (fallback: in-degree-0
 * nodes) picks the column; siblings stack vertically inside their column. */
function layoutFlow(
  flow: FlowDoc,
  screenIds: Set<string>,
): { kinds: Map<string, 'screen' | 'decision' | 'end'>; pos: Map<string, { x: number; y: number }> } {
  const declared = new Map((flow.nodes ?? []).map((n) => [n.id, n]));
  const kinds = new Map<string, 'screen' | 'decision' | 'end'>();
  const touch = (id: string) => {
    if (kinds.has(id)) return;
    const n = declared.get(id);
    if (n && (n.kind === 'decision' || n.kind === 'end')) kinds.set(id, n.kind);
    else if (n?.kind === 'screen') kinds.set(id, 'screen');
    else kinds.set(id, screenIds.has(id) ? 'screen' : 'end');
  };
  const edges = (flow.edges ?? []).filter((e) => e.from && e.to);
  for (const e of edges) {
    touch(e.from!);
    touch(e.to!);
  }
  for (const n of flow.nodes ?? []) touch(n.id);

  const out = new Map<string, string[]>();
  const indeg = new Map<string, number>();
  for (const id of kinds.keys()) indeg.set(id, 0);
  for (const e of edges) {
    out.set(e.from!, [...(out.get(e.from!) ?? []), e.to!]);
    indeg.set(e.to!, (indeg.get(e.to!) ?? 0) + 1);
  }
  const roots = flow.entry && kinds.has(flow.entry)
    ? [flow.entry]
    : [...kinds.keys()].filter((id) => (indeg.get(id) ?? 0) === 0);
  const depth = new Map<string, number>();
  const queue = (roots.length ? roots : [...kinds.keys()].slice(0, 1)).map((id) => ({ id, d: 0 }));
  while (queue.length) {
    const { id, d } = queue.shift()!;
    if (depth.has(id)) continue;
    depth.set(id, d);
    for (const to of out.get(id) ?? []) queue.push({ id: to, d: d + 1 });
  }
  for (const id of kinds.keys()) if (!depth.has(id)) depth.set(id, 0);

  const byCol = new Map<number, string[]>();
  for (const [id, d] of depth) byCol.set(d, [...(byCol.get(d) ?? []), id]);
  const widthOf = (k: 'screen' | 'decision' | 'end') =>
    k === 'screen' ? SCREEN_W : k === 'decision' ? DECISION_W : END_W;
  const heightOf = (k: 'screen' | 'decision' | 'end') =>
    k === 'screen' ? SCREEN_H : k === 'decision' ? DECISION_H : END_H;

  // Crossing reduction (barycenter): order each column by the average row of
  // its already-placed predecessors, so an edge mostly flows straight right
  // instead of slicing across the chart.
  const preds = new Map<string, string[]>();
  for (const e of edges) preds.set(e.to!, [...(preds.get(e.to!) ?? []), e.from!]);
  const cols = [...byCol.keys()].sort((a, b) => a - b);
  const rowIndex = new Map<string, number>();
  for (const c of cols) {
    const ids = byCol.get(c)!;
    if (c !== cols[0]) {
      const bary = (id: string) => {
        const rows = (preds.get(id) ?? []).map((p) => rowIndex.get(p)).filter((r): r is number => r !== undefined);
        return rows.length ? rows.reduce((a, b) => a + b, 0) / rows.length : Number.MAX_SAFE_INTEGER;
      };
      ids.sort((a, b) => bary(a) - bary(b));
    }
    ids.forEach((id, i) => rowIndex.set(id, i));
  }

  // Vertical centering: short columns float to the middle of the tallest one,
  // so cross-column edges run near-horizontal instead of long diagonals.
  const colHeight = (c: number) =>
    byCol.get(c)!.reduce((s, id) => s + heightOf(kinds.get(id)!) + NODE_GAP, -NODE_GAP);
  const maxH = Math.max(...cols.map(colHeight));
  const pos = new Map<string, { x: number; y: number }>();
  for (const c of cols) {
    let y = (maxH - colHeight(c)) / 2;
    for (const id of byCol.get(c)!) {
      const kind = kinds.get(id)!;
      pos.set(id, { x: c * COL_W + (SCREEN_W - widthOf(kind)) / 2, y });
      y += heightOf(kind) + NODE_GAP;
    }
  }
  return { kinds, pos };
}

export function SpecFlowCanvas({
  flows,
  spec,
  wireframes,
  platforms,
}: {
  flows: FlowDoc[];
  spec: SpecDoc;
  wireframes: Record<string, WireDoc> | null;
  platforms: Record<string, string> | null;
}) {
  const screens = ((spec as { screens?: Array<Record<string, any>> }).screens ?? []) as Array<Record<string, any>>;
  const screenIds = useMemo(() => new Set(screens.map((s) => String(s.id ?? ''))), [screens]);
  const nameOf = useMemo(
    () => new Map(screens.map((s) => [String(s.id ?? ''), String(s.name ?? s.title ?? s.id ?? '')])),
    [screens],
  );
  const effective = useMemo(() => {
    if (flows.length) return flows;
    const derived = deriveFlowFromSpec(spec);
    return derived ? [derived] : [];
  }, [flows, spec]);
  const [idx, setIdx] = useState(0);
  const flow = effective[Math.min(idx, effective.length - 1)];

  const { nodes, edges } = useMemo(() => {
    if (!flow) return { nodes: [] as Node[], edges: [] as Edge[] };
    const { kinds, pos } = layoutFlow(flow, screenIds);
    const nodes: Node[] = [...kinds.entries()].map(([id, kind]) => {
      const declared = (flow.nodes ?? []).find((n) => n.id === id);
      const screenId = declared?.screen ?? id;
      return {
        id,
        type: kind,
        position: pos.get(id) ?? { x: 0, y: 0 },
        draggable: true,
        data: {
          title:
            kind === 'screen'
              ? nameOf.get(screenId) ?? screenId
              : declared?.label ?? id,
          wire: kind === 'screen' ? (wireframes?.[screenId] ?? null) : null,
          platform: kind === 'screen' ? (platforms?.[screenId] ?? 'mobile') : undefined,
        } satisfies FlowNodeData,
      };
    });
    const edges: Edge[] = (flow.edges ?? [])
      .filter((e) => e.from && e.to)
      .map((e, i) => ({
        id: `e${i}`,
        source: e.from!,
        target: e.to!,
        // Orthogonal routing + HTML label chips (LabeledEdge) read as a real
        // flowchart; bezier diagonals with floating one-line SVG labels turned
        // dense graphs into soup.
        type: 'labeled',
        data: { label: e.label, shift: ((i % 3) - 1) * 18 },
        style: { stroke: T.muted, strokeWidth: 1.3 },
        markerEnd: { type: MarkerType.ArrowClosed, color: T.muted },
      }));
    return { nodes, edges };
  }, [flow, screenIds, nameOf, wireframes, platforms]);

  if (!flow) {
    return (
      <div style={{ padding: 24, fontSize: 13, color: T.muted }}>
        Chưa có flow — bước UX Spec chưa emit <code>flows/*.flow.json</code> và spec cũng chưa có{' '}
        <code>navigates_to</code>. Chạy lại bước UX Spec để có flowchart.
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 480 }}>
      {effective.length > 1 ? (
        <div style={{ display: 'flex', gap: 6, padding: '8px 12px', borderBottom: `1px solid ${T.border}`, flexWrap: 'wrap' }}>
          {effective.map((f, i) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setIdx(i)}
              style={{
                fontSize: 12,
                fontWeight: 600,
                padding: '3px 10px',
                borderRadius: 999,
                cursor: 'pointer',
                border: `1px solid ${i === idx ? T.accent : T.border}`,
                background: i === idx ? 'var(--accent-tint, #e6f0f8)' : 'transparent',
                color: i === idx ? T.accent : T.muted,
              }}
            >
              {f.name ?? f.id}
            </button>
          ))}
        </div>
      ) : null}
      <div style={{ flex: 1, minHeight: 440 }}>
        <ReactFlowProvider>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={NODE_TYPES}
            edgeTypes={EDGE_TYPES}
            fitView
            fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
            minZoom={0.1}
            proOptions={{ hideAttribution: true }}
            nodesConnectable={false}
          >
            <Background gap={22} size={1.4} />
            <Controls showInteractive={false} />
          </ReactFlow>
        </ReactFlowProvider>
      </div>
    </div>
  );
}
