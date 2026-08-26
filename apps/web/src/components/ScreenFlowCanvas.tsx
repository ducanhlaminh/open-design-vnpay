import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background, BaseEdge, Controls, EdgeLabelRenderer, Handle, MarkerType, Position, ReactFlow, ReactFlowProvider,
  getBezierPath, getSmoothStepPath, useNodesState,
  type Edge, type EdgeProps, type Node, type NodeProps, type ReactFlowInstance,
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
  // Barycenter ordering: trong mỗi hàng, xếp node theo trung bình toạ độ x
  // của các node CHA (cạnh semantic) đã đặt ở các hàng trên — con đứng ngay
  // dưới cha thay vì theo thứ tự khai báo, cạnh bớt vòng chéo qua nhánh khác.
  // Node không có cha đã đặt (hàng đầu, hoặc cha cùng hàng) giữ thứ tự gốc
  // (sort ổn định, key so sánh Infinity) — hàng 1 nhánh không đổi gì.
  const placedX = new Map<string, number>();
  const semanticParents = new Map<string, string[]>();
  for (const edge of edges.filter(isSemantic)) {
    semanticParents.set(edge.to, [...(semanticParents.get(edge.to) ?? []), edge.from]);
  }
  for (const [layer, screens] of [...layers].sort(([a], [b]) => a - b)) {
    const barycenter = (key: string): number => {
      const xs = (semanticParents.get(key) ?? []).map((parent) => placedX.get(parent)).filter((x): x is number => x != null);
      return xs.length ? xs.reduce((sum, x) => sum + x, 0) / xs.length : Number.POSITIVE_INFINITY;
    };
    const ordered = screens
      .map((screen, index) => ({ screen, index, center: barycenter(screen.key) }))
      .sort((a, b) => (a.center === b.center ? a.index - b.index : a.center - b.center))
      .map((entry) => entry.screen);
    const rowWidth = ordered.length * NODE_WIDTH + Math.max(0, ordered.length - 1) * COLUMN_GAP;
    const startX = (width - rowWidth) / 2;
    ordered.forEach((screen, column) => {
      const x = startX + column * (NODE_WIDTH + COLUMN_GAP);
      placedX.set(screen.key, x + NODE_WIDTH / 2);
      nodes.push({ key: screen.key, name: screen.name, x, y: PADDING_Y + layer * (NODE_HEIGHT + ROW_GAP), unlinked: false });
    });
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
      {/* Handle TRÁI cho cặp cạnh 2 chiều: hai chiều cùng bám bên phải thì
          đường + label đè nhau — chiều ngược tách sang trái (buildEdges). */}
      <Handle id="aux-in-left" type="target" position={Position.Left} className={styles.auxHandle} />
      <span className={styles.nodeCode}>{data.code}</span>
      <span className={styles.nodeName}>{displayName(data.name, data.code)}</span>
      <Handle id="main-out" type="source" position={Position.Bottom} className={styles.mainHandle} />
      <Handle id="aux-out" type="source" position={Position.Right} className={styles.auxHandle} />
      <Handle id="aux-out-left" type="source" position={Position.Left} className={styles.auxHandle} />
    </button>
  );
}
const NODE_TYPES = { screen: ScreenNodeView };

// Custom edge: path vẽ trong SVG như thường, nhưng LABEL render qua
// EdgeLabelRenderer — một lớp HTML nổi TRÊN toàn bộ lớp cạnh. Label built-in
// của React Flow nằm cùng lớp SVG với path nên path của cạnh vẽ SAU gạch
// xuyên qua chữ của cạnh vẽ trước (bug review: "eSIM / SIM Vật lý" bị một
// đường kẻ ngang cắt đôi); nền trắng của label không cứu được vì thứ tự vẽ.
type ScreenEdgeData = {
  variant: 'smoothstep' | 'bezier';
  borderRadius?: number;
  offset?: number;
  curvature?: number;
  labelText?: string;
  secondary?: boolean;
} & Record<string, unknown>;
type ScreenEdge = Edge<ScreenEdgeData, 'screen'>;
function ScreenEdgeView({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, style, data }: EdgeProps<ScreenEdge>) {
  const variant = data?.variant ?? 'smoothstep';
  const [path, labelX, labelY] =
    variant === 'bezier'
      ? getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, curvature: data?.curvature ?? 0.25 })
      : getSmoothStepPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, borderRadius: data?.borderRadius ?? 10, offset: data?.offset ?? 18 });
  return (
    <>
      <BaseEdge path={path} markerEnd={markerEnd} style={style} />
      {data?.labelText ? (
        <EdgeLabelRenderer>
          <div
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              pointerEvents: 'none',
              fontSize: 11,
              fontWeight: 550,
              padding: '3px 8px',
              borderRadius: 8,
              background: 'var(--bg, #fff)',
              border: '1px solid var(--border, #e1e5eb)',
              color: data?.secondary ? 'var(--text-muted, #77736c)' : 'var(--text, #1a1916)',
              maxWidth: 260,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {data.labelText}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}
const EDGE_TYPES = { screen: ScreenEdgeView };
function buildNodes(layout: ScreenFlowLayout, currentScreenKey: string | null, onOpenScreen: (key: string) => void, overrides?: ScreenFlowLayoutPositions | null): ScreenNode[] {
  return layout.nodes.map((node) => ({ id: node.key, type: 'screen', position: overrides?.[node.key] ?? { x: node.x, y: node.y }, data: { name: node.name, code: shortCode(node.key), selected: currentScreenKey === node.key, unlinked: node.unlinked, onOpen: () => onOpenScreen(node.key) }, draggable: !node.unlinked }));
}
export function buildEdges(layout: ScreenFlowLayout, showSecondary: boolean): Edge[] {
  const visible = layout.edges.filter((edge) => showSecondary || !edge.secondary);
  // Đếm thứ tự cạnh trong nhóm cùng node nguồn/đích để so le `offset` của
  // smoothstep — mọi cạnh chính đều cắm vào CÙNG một handle giữa cạnh node,
  // không so le thì các cạnh trùng đoạn thẳng và gộp thành một "bus" chung,
  // hết phân biệt được cạnh nào của màn nào.
  const bySource = new Map<string, number>();
  const byTarget = new Map<string, number>();
  // Cặp 2 CHIỀU (A→B và B→A cùng hiện): hai đường + hai label đè nhau nếu
  // cùng bám một phía. Chiều ngược tách hẳn sang handle TRÁI: chiều xuôi ở
  // giữa/bên phải, chiều ngược bên trái → label hai chiều nằm hai phía node.
  // Key hướng qua JSON.stringify — key màn có thể chứa khoảng trắng ("MH 2")
  // nên nối chuỗi trần sẽ nhập nhằng.
  const byDirection = new Map(visible.map((edge) => [JSON.stringify([edge.from, edge.to]), edge] as const));
  const reverseOf = (edge: LayoutEdge) => byDirection.get(JSON.stringify([edge.to, edge.from]));
  const hasReverse = (edge: LayoutEdge) => reverseOf(edge) != null;
  const isAux = (edge: LayoutEdge) => edge.secondary || edge.back;
  return visible.map((edge) => {
    // Cạnh chính đi NGƯỢC (quay lại màn đứng trên) tách khỏi lưới dọc: vòng
    // qua handle bên cạnh bằng đường cong bezier — vẽ chung kiểu smoothstep
    // với cạnh xuôi thì nó đâm xuyên các hàng giữa hai node.
    const backSemantic = !edge.secondary && edge.back;
    const useAux = edge.secondary || backSemantic;
    // Chọn phía cho cạnh aux trong cặp 2 chiều: chiều ngược của một cạnh
    // CHÍNH (smoothstep giữa hai node) sang trái — cạnh chính đã chiếm hành
    // lang giữa còn aux phải là đất của điều hướng phụ; cặp mà CẢ HAI chiều
    // đều aux (2 cạnh phụ, hoặc 2 màn cùng hàng trỏ nhau) chia trái/phải
    // theo thứ tự key cho tất định.
    const reverse = reverseOf(edge);
    const auxLeft = useAux && reverse != null && (!isAux(reverse) ? true : edge.from > edge.to);
    const sourceOrder = bySource.get(edge.from) ?? 0;
    bySource.set(edge.from, sourceOrder + 1);
    const targetOrder = byTarget.get(edge.to) ?? 0;
    byTarget.set(edge.to, targetOrder + 1);
    const stagger = Math.max(sourceOrder, targetOrder);
    return {
      id: edge.id, source: edge.from, target: edge.to,
      sourceHandle: useAux ? (auxLeft ? 'aux-out-left' : 'aux-out') : 'main-out',
      targetHandle: useAux ? (auxLeft ? 'aux-in-left' : 'aux-in') : 'main-in',
      type: 'screen' as const,
      // Cạnh aux trong cặp 2 chiều cong sâu hơn (curvature 0.5) để label ở
      // giữa cung nằm hẳn ra ngoài hành lang cạnh xuôi, không kê lên nhau.
      data: {
        variant: (useAux ? 'bezier' : 'smoothstep') as 'bezier' | 'smoothstep',
        ...(useAux
          ? { curvature: hasReverse(edge) ? 0.5 : 0.25 }
          : { borderRadius: 10, offset: 18 + (stagger % 4) * 12 }),
        labelText: edge.label || undefined,
        secondary: edge.secondary,
      },
      className: edge.secondary ? styles.secondaryEdge : styles.semanticEdge,
      animated: edge.kind === 'inferred', deletable: false, selectable: false,
      style: edge.secondary ? { strokeDasharray: '6 5' } : undefined,
      // Đầu mũi tên chỉ HƯỚNG điều hướng — không có nó thì nhãn "Điều hướng"/
      // "Mở màn hình" không nói được từ màn nào sang màn nào. Màu qua CSS var
      // (marker của @xyflow render bằng inline style nên var() ăn theo theme).
      markerEnd: {
        type: MarkerType.ArrowClosed,
        width: 15,
        height: 15,
        color: edge.secondary ? 'var(--text-muted, #77736c)' : 'var(--text, #1a1916)',
      },
    };
  });
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
          edges={edges} nodeTypes={NODE_TYPES} edgeTypes={EDGE_TYPES} onNodesChange={onNodesChange}
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
