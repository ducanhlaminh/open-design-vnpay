import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background, Controls, Handle, Position, ReactFlow, ReactFlowProvider, useNodesState,
  type Edge, type Node, type NodeProps, type ReactFlowInstance,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { Icon } from './Icon';
import styles from './ScreenFlowCanvas.module.css';

export type ScreenFlowEdgeKind = 'primary' | 'branch' | 'return' | 'secondary' | 'inferred';
export interface ScreenFlowCanvasModel {
  entryScreens: string[];
  screens: Array<{ key: string; name: string; linked: boolean }>;
  edges: Array<{ id: string; from: string; to: string; via?: string; condition?: string; kind?: ScreenFlowEdgeKind }>;
  unlinkedScreens: string[];
}
interface LayoutNode { key: string; name: string; x: number; y: number; unlinked: boolean }
type LayoutEdge = ScreenFlowCanvasModel['edges'][number] & { label: string; back: boolean; secondary: boolean };
export interface ScreenFlowLayout { width: number; height: number; nodes: LayoutNode[]; edges: LayoutEdge[]; unlinkedTop: number | null }
export type ScreenFlowLayoutPositions = Record<string, { x: number; y: number }>;
export interface ScreenFlowCanvasProps {
  model: ScreenFlowCanvasModel;
  currentScreenKey: string | null;
  onOpenScreen: (key: string) => void;
  layoutPositions?: ScreenFlowLayoutPositions | null;
  layoutLocked?: boolean;
  onLayoutPositionsChange?: (positions: ScreenFlowLayoutPositions) => void;
  onLayoutLockedChange?: (locked: boolean) => void;
  onResetLayout?: () => void;
}

const NODE_WIDTH = 224;
const NODE_HEIGHT = 84;
const COLUMN_GAP = 72;
const ROW_GAP = 106;
const PADDING_X = 54;
const PADDING_Y = 44;
const SEMANTIC_KINDS = new Set<ScreenFlowEdgeKind>(['primary', 'branch', 'inferred']);

function compact(value: string, max: number): string {
  const line = value.replace(/<br\s*\/?\s*>/gi, ' ').replace(/[`*_~|#[\]()>]+/g, ' ').replace(/\s+/g, ' ').trim();
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
}
function edgeLabel(edge: ScreenFlowCanvasModel['edges'][number]): string { return compact(edge.condition || edge.via || '', 42); }
function shortCode(key: string): string { const marker = key.lastIndexOf('__'); return marker >= 0 ? key.slice(marker + 2) : key; }
function displayName(name: string, code: string): string {
  const escaped = code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return name.replace(new RegExp(`^${escaped}\\.?\\s*`), '').replace(/^Màn hình\s+/i, '').trim() || name;
}
function isSemantic(edge: ScreenFlowCanvasModel['edges'][number]): boolean { return SEMANTIC_KINDS.has(edge.kind ?? 'primary'); }

/** Condense semantic cycles, then longest-path rank the DAG. Auxiliary
 * navigation is excluded so returns and tab changes never distort rows. */
function semanticRanks(keys: string[], edges: ScreenFlowCanvasModel['edges']): Map<string, number> {
  const outgoing = new Map(keys.map((key) => [key, [] as string[]]));
  for (const edge of edges) outgoing.get(edge.from)?.push(edge.to);
  let cursor = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const active = new Set<string>();
  const components: string[][] = [];
  const visit = (key: string) => {
    index.set(key, cursor); low.set(key, cursor++); stack.push(key); active.add(key);
    for (const next of outgoing.get(key) ?? []) {
      if (!index.has(next)) { visit(next); low.set(key, Math.min(low.get(key)!, low.get(next)!)); }
      else if (active.has(next)) low.set(key, Math.min(low.get(key)!, index.get(next)!));
    }
    if (low.get(key) !== index.get(key)) return;
    const component: string[] = [];
    while (stack.length) {
      const member = stack.pop()!; active.delete(member); component.push(member);
      if (member === key) break;
    }
    components.push(component);
  };
  for (const key of keys) if (!index.has(key)) visit(key);
  const componentOf = new Map<string, number>();
  components.forEach((component, id) => component.forEach((key) => componentOf.set(key, id)));
  const componentOut = new Map(components.map((_, id) => [id, new Set<number>()]));
  const indegree = new Map(components.map((_, id) => [id, 0]));
  for (const edge of edges) {
    const from = componentOf.get(edge.from)!; const to = componentOf.get(edge.to)!;
    if (from === to || componentOut.get(from)!.has(to)) continue;
    componentOut.get(from)!.add(to); indegree.set(to, indegree.get(to)! + 1);
  }
  const ranks = new Map(components.map((_, id) => [id, 0]));
  const queue = [...components.keys()].filter((id) => indegree.get(id) === 0);
  while (queue.length) {
    const id = queue.shift()!;
    for (const next of componentOut.get(id)!) {
      ranks.set(next, Math.max(ranks.get(next)!, ranks.get(id)! + 1));
      indegree.set(next, indegree.get(next)! - 1);
      if (indegree.get(next) === 0) queue.push(next);
    }
  }
  return new Map(keys.map((key) => [key, ranks.get(componentOf.get(key)!) ?? 0]));
}

export function layoutScreenFlow(model: ScreenFlowCanvasModel): ScreenFlowLayout {
  const unlinkedKeys = new Set(model.unlinkedScreens);
  const edgeKeys = new Set(model.edges.flatMap((edge) => [edge.from, edge.to]));
  const linked = model.screens.filter((screen) => !unlinkedKeys.has(screen.key) && (screen.linked || edgeKeys.has(screen.key)));
  const linkedKeys = new Set(linked.map((screen) => screen.key));
  const edges = model.edges.filter((edge) => linkedKeys.has(edge.from) && linkedKeys.has(edge.to) && edge.from !== edge.to);
  const rank = semanticRanks(linked.map((screen) => screen.key), edges.filter(isSemantic));
  const layers = new Map<number, typeof linked>();
  for (const screen of linked) {
    const layer = rank.get(screen.key) ?? 0;
    layers.set(layer, [...(layers.get(layer) ?? []), screen]);
  }
  const maxColumns = Math.max(1, ...[...layers.values()].map((layer) => layer.length));
  const width = Math.max(760, PADDING_X * 2 + maxColumns * NODE_WIDTH + (maxColumns - 1) * COLUMN_GAP + 120);
  const nodes: LayoutNode[] = [];
  for (const [layer, screens] of [...layers].sort(([a], [b]) => a - b)) {
    const rowWidth = screens.length * NODE_WIDTH + Math.max(0, screens.length - 1) * COLUMN_GAP;
    const startX = (width - rowWidth) / 2;
    screens.forEach((screen, column) => nodes.push({ key: screen.key, name: screen.name, x: startX + column * (NODE_WIDTH + COLUMN_GAP), y: PADDING_Y + layer * (NODE_HEIGHT + ROW_GAP), unlinked: false }));
  }
  const unlinked = model.screens.filter((screen) => unlinkedKeys.has(screen.key) || (!screen.linked && !edgeKeys.has(screen.key)));
  const lastLinkedBottom = nodes.length ? Math.max(...nodes.map((node) => node.y + NODE_HEIGHT)) : PADDING_Y;
  const unlinkedTop = unlinked.length ? lastLinkedBottom + 76 : null;
  if (unlinkedTop != null) {
    const columns = Math.min(3, unlinked.length);
    const rowWidth = columns * NODE_WIDTH + Math.max(0, columns - 1) * 32;
    const startX = (width - rowWidth) / 2;
    unlinked.forEach((screen, index) => nodes.push({ key: screen.key, name: screen.name, x: startX + (index % columns) * (NODE_WIDTH + 32), y: unlinkedTop + 46 + Math.floor(index / columns) * (NODE_HEIGHT + 28), unlinked: true }));
  }
  const byKey = new Map(nodes.map((node) => [node.key, node]));
  const layoutEdges = edges.map((edge): LayoutEdge => {
    const secondary = !isSemantic(edge);
    return { ...edge, label: edgeLabel(edge), secondary, back: secondary || (byKey.get(edge.to)?.y ?? 0) <= (byKey.get(edge.from)?.y ?? 0) };
  });
  const unlinkedBottom = unlinked.length && unlinkedTop != null ? unlinkedTop + 46 + Math.ceil(unlinked.length / Math.min(3, unlinked.length)) * (NODE_HEIGHT + 28) : lastLinkedBottom;
  return { width, height: Math.max(360, unlinkedBottom + PADDING_Y), nodes, edges: layoutEdges, unlinkedTop };
}

type ScreenNodeData = { name: string; code: string; selected: boolean; unlinked: boolean; onOpen: () => void } & Record<string, unknown>;
type ScreenNode = Node<ScreenNodeData, 'screen'>;
function ScreenNodeView({ data }: NodeProps<ScreenNode>) {
  return (
    <button type="button" className={`${styles.nodeCard} ${data.unlinked ? styles.unlinkedNode : ''} ${data.selected ? styles.selectedNode : ''}`} aria-pressed={data.selected} aria-label={`Mở màn hình ${data.name}`} title={data.name} onClick={data.onOpen}>
      <Handle id="main-in" type="target" position={Position.Top} className={styles.mainHandle} />
      <Handle id="aux-in" type="target" position={Position.Right} className={styles.auxHandle} />
      <span className={styles.nodeCode}>{data.code}</span>
      <span className={styles.nodeName}>{displayName(data.name, data.code)}</span>
      <Handle id="main-out" type="source" position={Position.Bottom} className={styles.mainHandle} />
      <Handle id="aux-out" type="source" position={Position.Right} className={styles.auxHandle} />
    </button>
  );
}
const NODE_TYPES = { screen: ScreenNodeView };
function buildNodes(layout: ScreenFlowLayout, currentScreenKey: string | null, onOpenScreen: (key: string) => void, overrides?: ScreenFlowLayoutPositions | null): ScreenNode[] {
  return layout.nodes.map((node) => ({ id: node.key, type: 'screen', position: overrides?.[node.key] ?? { x: node.x, y: node.y }, data: { name: node.name, code: shortCode(node.key), selected: currentScreenKey === node.key, unlinked: node.unlinked, onOpen: () => onOpenScreen(node.key) }, draggable: !node.unlinked }));
}
function buildEdges(layout: ScreenFlowLayout, showSecondary: boolean): Edge[] {
  return layout.edges.filter((edge) => showSecondary || !edge.secondary).map((edge) => ({
    id: edge.id, source: edge.from, target: edge.to,
    sourceHandle: edge.secondary ? 'aux-out' : 'main-out', targetHandle: edge.secondary ? 'aux-in' : 'main-in',
    type: 'smoothstep', label: edge.label || undefined,
    className: edge.secondary ? styles.secondaryEdge : styles.semanticEdge,
    animated: edge.kind === 'inferred', deletable: false, selectable: false,
    style: edge.secondary ? { strokeDasharray: '6 5' } : undefined,
    labelStyle: { fontSize: 11, fontWeight: 550 },
    labelBgStyle: { fill: 'var(--bg, #fff)', stroke: 'var(--border, #e1e5eb)' },
    labelBgPadding: [8, 4] as [number, number], labelBgBorderRadius: 8,
  }));
}

function ScreenFlowCanvasInner({ model, currentScreenKey, onOpenScreen, layoutPositions, layoutLocked, onLayoutPositionsChange, onLayoutLockedChange, onResetLayout }: ScreenFlowCanvasProps) {
  const layout = useMemo(() => layoutScreenFlow(model), [model]);
  const [nodes, setNodes, onNodesChange] = useNodesState<ScreenNode>([]);
  const [showSecondary, setShowSecondary] = useState(false);
  const [internalLocked, setInternalLocked] = useState(false);
  const locked = layoutLocked ?? internalLocked;
  const flowRef = useRef<ReactFlowInstance<ScreenNode, Edge> | null>(null);
  useEffect(() => { setNodes(buildNodes(layout, currentScreenKey, onOpenScreen, layoutPositions)); }, [currentScreenKey, layout, layoutPositions, onOpenScreen, setNodes]);
  const edges = useMemo(() => buildEdges(layout, showSecondary), [layout, showSecondary]);
  const renderNodes: ScreenNode[] = useMemo(
    () => nodes.map((node): ScreenNode => ({ ...node, draggable: !locked && !node.data.unlinked })),
    [locked, nodes],
  );
  const autoLayout = useCallback(() => {
    setNodes(buildNodes(layout, currentScreenKey, onOpenScreen));
    requestAnimationFrame(() => void flowRef.current?.fitView({ padding: 0.18, duration: 250 }));
  }, [currentScreenKey, layout, onOpenScreen, setNodes]);
  const resetLayout = useCallback(() => { autoLayout(); onResetLayout?.(); }, [autoLayout, onResetLayout]);
  const toggleLocked = useCallback(() => {
    const next = !locked;
    if (layoutLocked == null) setInternalLocked(next);
    onLayoutLockedChange?.(next);
  }, [layoutLocked, locked, onLayoutLockedChange]);
  return (
    <div className={styles.root} data-testid="screen-flow-canvas">
      <div className={styles.toolbar} aria-label="Điều khiển sơ đồ">
        <button type="button" aria-label="Thu nhỏ" title="Thu nhỏ" onClick={() => void flowRef.current?.zoomOut()}><Icon name="zoom-out" size={15} /></button>
        <button type="button" aria-label="Phóng to" title="Phóng to" onClick={() => void flowRef.current?.zoomIn()}><Icon name="zoom-in" size={15} /></button>
        <button type="button" aria-label="Vừa màn hình" title="Vừa màn hình" onClick={() => void flowRef.current?.fitView({ padding: 0.18, duration: 250 })}><Icon name="maximize" size={15} /></button>
        <span className={styles.separator} aria-hidden="true" />
        <button type="button" className={styles.textButton} aria-label="Tự sắp xếp" onClick={autoLayout}><Icon name="grid" size={14} />Tự sắp xếp</button>
        <button type="button" className={styles.textButton} aria-label="Đặt lại bố cục" onClick={resetLayout}><Icon name="refresh" size={14} />Đặt lại</button>
        <button type="button" className={styles.textButton} aria-label={locked ? 'Mở khóa vị trí node' : 'Khóa vị trí node'} onClick={toggleLocked}><Icon name={locked ? 'eye' : 'eye-off'} size={14} />{locked ? 'Mở khóa' : 'Khóa node'}</button>
        <button type="button" className={`${styles.textButton} ${showSecondary ? styles.activeButton : ''}`} aria-label={showSecondary ? 'Ẩn điều hướng phụ' : 'Hiện điều hướng phụ'} aria-pressed={showSecondary} onClick={() => setShowSecondary((value) => !value)}><Icon name={showSecondary ? 'eye-off' : 'eye'} size={14} />{showSecondary ? 'Ẩn điều hướng phụ' : 'Hiện điều hướng phụ'}</button>
      </div>
      <div className={styles.canvas} role="img" aria-label="Sơ đồ luồng màn hình">
        <ReactFlow
          nodes={renderNodes}
          edges={edges} nodeTypes={NODE_TYPES} onNodesChange={onNodesChange}
          onNodeDragStop={(_, __, draggedNodes) => {
            if (!onLayoutPositionsChange) return;
            const changed = new Map(draggedNodes.map((node) => [node.id, node.position]));
            onLayoutPositionsChange(Object.fromEntries(nodes.map((node) => [node.id, changed.get(node.id) ?? node.position])));
          }}
          onInit={(instance) => { flowRef.current = instance; }} fitView fitViewOptions={{ padding: 0.18, maxZoom: 1.15 }}
          minZoom={0.25} maxZoom={1.8} snapToGrid snapGrid={[16, 16]}
          nodesConnectable={false} edgesReconnectable={false} deleteKeyCode={null}
          elementsSelectable={false} panOnDrag zoomOnScroll proOptions={{ hideAttribution: true }}
        >
          <Background gap={22} size={1} />
          <Controls position="bottom-left" showInteractive={false} />
        </ReactFlow>
      </div>
    </div>
  );
}
export function ScreenFlowCanvas(props: ScreenFlowCanvasProps) {
  return <ReactFlowProvider><ScreenFlowCanvasInner {...props} /></ReactFlowProvider>;
}
