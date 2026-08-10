// SpecFlowCanvas — the UX Spec "user flow" view: wireframes + RULE FLOWCHART.
// Renders the ux stage's `flows/<FLOW-ID>.flow.json` (decision/end nodes +
// labeled edges between screen ids) as a React Flow chart whose screen nodes
// are the screens' own wireframe thumbnails (WireBlocks, scaled down) —
// replacing the retired Mermaid view. Screens are implicit nodes: any edge
// endpoint matching a spec screen id renders as that screen; `nodes[]` in the
// flow file lists only decisions/ends. With no flow files (older ux runs) one
// implicit flow is derived from the components' `navigates_to` edges so the
// tab still shows the navigation graph.
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
  useNodesState,
  useEdgesState,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

const DEVICE_WIDTHS = { desktop: 1280, mobile: 390 } as const;
import { WireBlocks } from './WireBlocks';
import { UseCaseReader } from './UseCaseReader';
import { flowDocToChart, deriveUseCases } from './flow-usecases';
import readerStyles from './UseCaseReader.module.css';
import type { SpecDoc } from './SpecPreview';

export interface FlowDocNode {
  id: string;
  kind: 'decision' | 'end' | 'screen' | 'nav';
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

/** Derive one flow PER JOURNEY from a Customer Journey document.
 *
 * A CJ file has `journeys[].stages[]` and no screens, so the screen-graph
 * derivation above finds nothing and the Flow tab renders empty — which is what
 * it did for every customer journey.
 *
 * Stages are an ORDERED list, so the default shape is a chain (1 → 2 → 3). A
 * stage that documents a fork carries `next[]` (one entry per branch, each with
 * the `condition` copied off the source flow diagram's arrow); when it is
 * present it REPLACES the implicit "next by order" edge, so a three-way branch
 * draws as three labelled edges out of a decision node instead of a straight
 * line that hides two of the outcomes.
 */
export function deriveFlowsFromJourneys(spec: SpecDoc): FlowDoc[] {
  const journeys = (spec as { journeys?: Array<Record<string, any>> }).journeys ?? [];
  const flows: FlowDoc[] = [];
  for (const journey of journeys) {
    const stages = [...((journey.stages ?? []) as Array<Record<string, any>>)].sort(
      (a, b) => Number(a.order ?? 0) - Number(b.order ?? 0),
    );
    if (stages.length === 0) continue;
    const ids = new Set(stages.map((st) => String(st.id ?? '')));
    const nodes: FlowDocNode[] = [];
    const edges: FlowDoc['edges'] = [];

    for (const [i, stage] of stages.entries()) {
      const id = String(stage.id ?? '');
      if (!id) continue;
      const kind: FlowDocNode['kind'] = stage.stage_type === 'decision' ? 'decision' : 'end';
      nodes.push({ id, kind, label: String(stage.name ?? id) });

      const branches = (Array.isArray(stage.next) ? stage.next : []) as Array<Record<string, any>>;
      const declared = branches
        .map((b) => ({ to: String(b?.to ?? ''), label: String(b?.condition ?? '') }))
        .filter((b) => b.to && ids.has(b.to));
      if (declared.length > 0) {
        for (const b of declared) edges.push({ from: id, to: b.to, ...(b.label ? { label: b.label } : {}) });
        continue;
      }
      const nextStage = stages[i + 1];
      const to = nextStage ? String(nextStage.id ?? '') : '';
      if (to) edges.push({ from: id, to });
    }
    if (!edges.length) continue;
    flows.push({
      id: String(journey.id ?? `UFLW-${flows.length + 1}`),
      name: String(journey.name ?? journey.goal ?? 'Hành trình'),
      entry: String(stages[0]?.id ?? ''),
      nodes,
      edges,
    });
  }
  return flows;
}

// A branch that ends badly — cancel, error, "No", a rejected validation. Drawn
// RED + DASHED so the happy path is legible at a glance in a dense chart; every
// other edge stays solid black. Matching is on the edge LABEL, which is the
// condition copied off the source flow diagram ("Chưa có DN", "KẾT THÚC nhánh
// hủy", "Dữ liệu không hợp lệ").
const NEGATIVE_BRANCH_RE =
  /\b(no|not|invalid|fail(ed|ure)?|error|cancel(l?ed)?|reject(ed)?|deny|denied|timeout)\b|không|kh\.|hủy|huỷ|thoát|lỗi|sai|thất bại|từ chối|chưa |hết hạn|quá hạn/i;

function isNegativeBranch(label: string | undefined): boolean {
  return !!label && NEGATIVE_BRANCH_RE.test(label);
}

const T = {
  ink: 'var(--text, #1a1a1a)',
  muted: 'var(--text-muted, #6b7280)',
  border: 'var(--border, #e1e5eb)',
  paper: 'var(--bg-panel, #fff)',
  accent: 'var(--accent, #0066b3)',
  danger: 'var(--danger, #d14343)',
};

// Node box sizes (layout uses these; React Flow nodes are absolutely placed).
const SCREEN_W = 210;
const SCREEN_H = 300;
const DECISION_W = 170;
const DECISION_H = 150;
const END_W = 170;
const END_H = 56;
// Vertical breathing room between nodes in a column. It also sets the ceiling on
// how many label chips a gutter can stack without the ladder running past its
// neighbours, so it is deliberately generous.
const NODE_GAP = 64;
// Wide gutters so smoothstep edges + their labels have room between columns.
const COL_W = SCREEN_W + 230;

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
  // A negative branch's chip is tinted to match its red dashed edge, so the
  // condition and the line it belongs to read as one thing in a dense chart.
  const negative = (data as { negative?: boolean } | undefined)?.negative === true;
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
              border: `1px solid ${negative ? T.danger : T.border}`,
              background: 'var(--bg-panel, #fff)',
              boxShadow: '0 1px 2px rgba(0,0,0,.06)',
              fontSize: 10.5,
              fontWeight: 600,
              color: negative ? T.danger : T.ink,
              lineHeight: 1.3,
              textAlign: 'center',
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
              // Non-interactive so the chip never blocks panning/dragging the
              // canvas underneath it (labels sit in the middle gutter).
              pointerEvents: 'none',
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
  wire?: string | null;
  platform?: string;
};

function ScreenFlowNode({ data }: NodeProps) {
  const d = data as FlowNodeData;
  const isWeb = d.platform === 'web';
  const natural = isWeb ? DEVICE_WIDTHS.desktop : DEVICE_WIDTHS.mobile;
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
            <WireBlocks html={d.wire} platform={d.platform} />
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

function NavFlowNode({ data }: NodeProps) {
  const d = data as FlowNodeData;
  return <div style={{ width: END_W, minHeight: END_H, border: `1px solid ${T.border}`, borderRadius: 10, background: T.paper, display: 'grid', placeItems: 'center', padding: '10px 16px', fontSize: 12, fontWeight: 700, color: T.ink, textAlign: 'center' }}>
    <Handle type="target" position={Position.Left} style={{ opacity: 0 }} /><Handle type="source" position={Position.Right} style={{ opacity: 0 }} />{d.title}
  </div>;
}

const NODE_TYPES = { screen: ScreenFlowNode, decision: DecisionFlowNode, end: EndFlowNode, nav: NavFlowNode };

/** Layered left→right layout: BFS depth from the entry (fallback: in-degree-0
 * nodes) picks the column; siblings stack vertically inside their column. */
function layoutFlow(
  flow: FlowDoc,
  screenIds: Set<string>,
): { kinds: Map<string, 'screen' | 'decision' | 'end' | 'nav'>; pos: Map<string, { x: number; y: number }> } {
  const declared = new Map((flow.nodes ?? []).map((n) => [n.id, n]));
  const kinds = new Map<string, 'screen' | 'decision' | 'end' | 'nav'>();
  const touch = (id: string) => {
    if (kinds.has(id)) return;
    const n = declared.get(id);
    if (n && (n.kind === 'decision' || n.kind === 'end' || n.kind === 'nav')) kinds.set(id, n.kind);
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
  const widthOf = (k: 'screen' | 'decision' | 'end' | 'nav') => k === 'screen' ? SCREEN_W : k === 'decision' ? DECISION_W : END_W;
  const heightOf = (k: 'screen' | 'decision' | 'end' | 'nav') => k === 'screen' ? SCREEN_H : k === 'decision' ? DECISION_H : END_H;

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
  wireframes: Record<string, string> | null;
  platforms: Record<string, string> | null;
}) {
  // MUST be memoized: `?? []` mints a new array on every render when the spec
  // has no `screens`, which changes `screenIds`/`nameOf` → `built` → the
  // seeding effect below → setState → render again. That self-sustaining loop
  // is what throws "Maximum update depth exceeded" on this canvas.
  const screens = useMemo(
    () => ((spec as { screens?: Array<Record<string, any>> }).screens ?? []) as Array<Record<string, any>>,
    [spec],
  );
  const screenIds = useMemo(() => new Set(screens.map((s) => String(s.id ?? ''))), [screens]);
  const nameOf = useMemo(
    () => new Map(screens.map((s) => [String(s.id ?? ''), String(s.name ?? s.title ?? s.id ?? '')])),
    [screens],
  );
  const effective = useMemo(() => {
    if (flows.length) return flows;
    // A Customer Journey has journeys, not screens — derive one flow per
    // journey. Without this the tab was empty for every CJ document, because
    // both other sources (flow files, `navigates_to`) are ux-stage artifacts.
    const fromJourneys = deriveFlowsFromJourneys(spec);
    if (fromJourneys.length) return fromJourneys;
    const derived = deriveFlowFromSpec(spec);
    return derived ? [derived] : [];
  }, [flows, spec]);
  const [idx, setIdx] = useState(0);
  const [mode, setMode] = useState<'scenarios' | 'graph'>('scenarios');
  const flow = effective[Math.min(idx, effective.length - 1)];
  const screenTitles = useMemo(() => Object.fromEntries(screens.map((s) => [String(s.id), String(s.name ?? s.title ?? s.id)])), [screens]);
  const chart = useMemo(() => (flow ? flowDocToChart(flow, screenTitles) : null), [flow, screenTitles]);
  const useCaseCount = useMemo(() => (chart ? deriveUseCases(chart).useCases.length : 0), [chart]);

  const built = useMemo(() => {
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
    // Edges that share a source fan out to the same gutter, so their label
    // chips land on nearly the same midpoint and pile up. Distribute each
    // source's labels into vertical slots (~a chip-height apart) so parallel
    // edges never stack their labels.
    const filtered = (flow.edges ?? []).filter((e) => e.from && e.to);
    // Label chips land near the midpoint of their edge, so every edge crossing
    // the SAME gutter (the empty column between two node columns) competes for
    // the same strip of space. Staggering per SOURCE only — what this did
    // before — still let two different sources drop their chips on top of each
    // other. Slot them per gutter instead: one shared ladder of vertical slots,
    // so no two chips in a gutter share a row.
    const gutterOf = (id: string) => Math.round((pos.get(id)?.x ?? 0) / COL_W);
    const byGutter = new Map<number, number>();
    const LABEL_SLOT = 40; // ~2-line chip height + gap
    const edges: Edge[] = filtered.map((e, i) => {
      const from = e.from!;
      const gutter = gutterOf(from);
      const seen = byGutter.get(gutter) ?? 0;
      byGutter.set(gutter, seen + 1);
      const negative = isNegativeBranch(e.label);
      const stroke = negative ? T.danger : T.ink;
      return {
        id: `e${i}`,
        source: from,
        target: e.to!,
        // Orthogonal routing + HTML label chips (LabeledEdge) read as a real
        // flowchart; bezier diagonals with floating one-line SVG labels turned
        // dense graphs into soup.
        type: 'labeled',
        data: { label: e.label, slot: seen, negative },
        style: {
          stroke,
          strokeWidth: negative ? 1.4 : 1.6,
          ...(negative ? { strokeDasharray: '6 4' } : {}),
        },
        markerEnd: { type: MarkerType.ArrowClosed, color: stroke },
      };
    });
    // Centre each gutter's ladder on the edges' own midpoints.
    const gutterTotal = new Map(byGutter);
    for (const edge of edges) {
      const d = edge.data as { slot: number };
      const total = gutterTotal.get(gutterOf(edge.source)) ?? 1;
      (edge.data as { shift?: number }).shift = total > 1 ? (d.slot - (total - 1) / 2) * LABEL_SLOT : 0;
    }
    return { nodes, edges };
  }, [flow, screenIds, nameOf, wireframes, platforms]);

  // React Flow needs STATEFUL nodes/edges + change handlers to apply drag
  // (position) updates — a controlled `nodes` prop with no `onNodesChange` makes
  // a dragged node snap straight back. Seed from the computed layout and re-seed
  // whenever it changes (switching flows / new data), which also resets any
  // manual drag for the new layout.
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  useEffect(() => {
    setNodes(built.nodes);
    setEdges(built.edges);
  }, [built, setNodes, setEdges]);

  if (!flow) {
    return (
      <div style={{ padding: 24, fontSize: 13, color: T.muted }}>
        Chưa có flow — bước UX Spec chưa emit <code>flows/*.flow.json</code> và spec cũng chưa có{' '}
        <code>navigates_to</code>. Chạy lại bước UX Spec để có flowchart.
      </div>
    );
  }

  const renderStepExtra = (node: import('./FlowchartPreview').FlowchartNode) => {
    if (node.type !== 'action' && node.type !== 'start') return null;
    const wire = wireframes?.[node.id];
    if (!wire) return null;
    const platform = platforms?.[node.id] ?? 'mobile';
    const natural = platform === 'web' ? DEVICE_WIDTHS.desktop : DEVICE_WIDTHS.mobile;
    const scale = 174 / natural;
    return (
      <div style={{ height: 142, marginTop: 10, overflow: 'hidden', position: 'relative', borderRadius: 5, background: 'var(--bg-subtle, #f5f6f8)' }}>
        <div style={{ width: natural, transform: `scale(${scale})`, transformOrigin: 'top left', pointerEvents: 'none' }}>
          <WireBlocks html={wire} platform={platform} />
        </div>
      </div>
    );
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 480 }}>
      <div className={readerStyles.modeBar} role="tablist" aria-label="Chế độ xem flow">
        <button type="button" role="tab" aria-selected={mode === 'scenarios'} className={`${readerStyles.modeButton} ${mode === 'scenarios' ? readerStyles.modeButtonActive : ''}`} onClick={() => setMode('scenarios')}>
          <span className={readerStyles.modeButtonName}>Kịch bản</span><span className={readerStyles.modeButtonMeta}>· {useCaseCount}</span>
        </button>
        <button type="button" role="tab" aria-selected={mode === 'graph'} className={`${readerStyles.modeButton} ${mode === 'graph' ? readerStyles.modeButtonActive : ''}`} onClick={() => setMode('graph')}>
          <span className={readerStyles.modeButtonName}>Sơ đồ</span><span className={readerStyles.modeButtonMeta}>· {built.nodes.length}</span>
        </button>
      </div>
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
      {mode === 'scenarios' && chart ? <UseCaseReader doc={chart} renderStepExtra={renderStepExtra} /> : null}
      {mode === 'graph' ? <>
      {/* Without a key, the red dashed edges read as "something is broken"
          rather than "this is the branch that does not go well". */}
      {built.edges.some((e) => (e.data as { negative?: boolean } | undefined)?.negative) ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 14,
            padding: '6px 12px',
            borderBottom: `1px solid ${T.border}`,
            fontSize: 11.5,
            color: T.muted,
          }}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 22, height: 0, borderTop: `2px solid ${T.ink}` }} />
            Luồng thuận
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: T.danger }}>
            <span style={{ width: 22, height: 0, borderTop: `2px dashed ${T.danger}` }} />
            Nhánh lỗi / hủy / không hợp lệ
          </span>
        </div>
      ) : null}
      <div style={{ flex: 1, minHeight: 440 }}>
        <ReactFlowProvider>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            nodeTypes={NODE_TYPES}
            edgeTypes={EDGE_TYPES}
            fitView
            fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
            minZoom={0.1}
            proOptions={{ hideAttribution: true }}
            nodesConnectable={false}
            nodesDraggable
            elementsSelectable
            panOnDrag
            zoomOnScroll
            panOnScroll={false}
          >
            <Background gap={22} size={1.4} />
            <Controls showInteractive={false} />
          </ReactFlow>
        </ReactFlowProvider>
      </div>
      </> : null}
    </div>
  );
}
