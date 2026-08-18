// FlowchartPreview — khung nhìn cho sơ đồ khối `flows/<FLOW-ID>.flowchart.json`
// (bước `dr-flow` của workflow docs-review sinh ra).
//
// Khác với SpecFlowCanvas (flow của bước ux: node LÀ màn hình, có wireframe thu
// nhỏ), file này vẽ đúng KÝ PHÁP SƠ ĐỒ KHỐI kinh điển — oval bắt đầu/kết thúc,
// chữ nhật cho bước làm, hình thoi cho điểm rẽ nhánh — nên người đọc tài liệu
// nghiệp vụ nhìn ra ngay đâu là quyết định mà không cần ai giải thích. Kèm một
// hộp "Chú thích" bật/tắt được, vì ký pháp chỉ có ích khi người xem biết nó.
//
// Hai khung nhìn cố ý KHÔNG dùng chung mã: chúng đọc hai schema khác nhau
// (`.flow.json` với `kind` + màn hình ngầm, `.flowchart.json` với `type` +
// node tường minh) và trả lời hai câu hỏi khác nhau. Riêng tab "Flow màn hình"
// (node = màn hình có thumbnail wireframe) thì TÁI DÙNG bộ node của
// SpecFlowCanvas: flowchart được chuyển sang FlowDoc (flowchart-to-flow.ts)
// rồi vẽ bằng buildFlowGraph/FlowGraphView, để hai nơi nhìn màn hình giống
// hệt nhau.
import { useEffect, useMemo, useState } from 'react';
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import type { ProjectFile } from '../types';
import { fetchProjectFileText } from '../providers/registry';
import styles from './FlowchartPreview.module.css';
import readerStyles from './UseCaseReader.module.css';
import { deriveUseCases } from './flow-usecases';
import { UseCaseReader } from './UseCaseReader';
import { flowchartToFlowDoc } from './flowchart-to-flow';
import {
  FlowGraphView,
  buildFlowGraph,
  makeWireframeStepExtra,
  useFlowGraphState,
  type BuiltFlowGraph,
  type FlowDoc,
} from './SpecFlowCanvas';

export type FlowchartNodeType = 'start' | 'end' | 'action' | 'decision';

export interface FlowchartNode {
  id: string;
  type: FlowchartNodeType;
  label: string;
  /** SCREEN-KEY (`<file-stem>__<mã màn>`) của màn mà bước này diễn ra trên đó
   *  — chỉ có ở file dr-flow bản mới; thiếu = bước hệ thống/điều hướng ngoài
   *  feature. Tab "Flow màn hình" gộp các bước cùng màn thành một node và tìm
   *  wireframe `wireframes/<SCREEN-KEY>.html` theo key này. */
  screen?: string;
}
export interface FlowchartEdge {
  from: string;
  to: string;
  label?: string;
}
export interface FlowchartDoc {
  id: string;
  title?: string;
  source?: string;
  nodes: FlowchartNode[];
  edges: FlowchartEdge[];
}

const NODE_TYPE_SET = new Set<string>(['start', 'end', 'action', 'decision']);

/** File có tên `<gì đó>.flowchart.json` — dùng để route trong FileViewer. */
export function isFlowchartFile(file: ProjectFile): boolean {
  return /\.flowchart\.json$/i.test(file.name);
}

/** Đọc nội dung một file `*.flowchart.json`. Khoan dung y như parseDocChanges
 *  trong DocRedlinePreview: phần tử hỏng bị BỎ QUA chứ không đánh hỏng cả khung
 *  nhìn, vì file do LLM sinh nên một node thiếu `label` là chuyện thường và vẫn
 *  còn cả sơ đồ đáng xem. Trả null khi file nói chung không dùng được (không
 *  phải JSON, không phải object, hoặc không còn node nào hợp lệ) — lúc đó
 *  không có gì để vẽ, hiện thông báo lỗi mới đúng. */
export function parseFlowchartDoc(raw: string): FlowchartDoc | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const doc = parsed as Record<string, unknown>;

  const nodes: FlowchartNode[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(doc.nodes) ? doc.nodes : []) {
    if (!item || typeof item !== 'object') continue;
    const n = item as Record<string, unknown>;
    const id = typeof n.id === 'string' ? n.id.trim() : '';
    if (!id || seen.has(id)) continue; // id trùng làm key React đụng nhau
    seen.add(id);
    const screen = typeof n.screen === 'string' ? n.screen.trim() : '';
    nodes.push({
      id,
      // Loại lạ (hoặc thiếu) quy về `action`: một ô chữ nhật không nhãn loại
      // vẫn đọc được, còn bỏ hẳn node thì các cạnh trỏ vào nó cũng mất theo.
      type: (typeof n.type === 'string' && NODE_TYPE_SET.has(n.type)
        ? n.type
        : 'action') as FlowchartNodeType,
      label: typeof n.label === 'string' && n.label.trim() ? n.label : id,
      ...(screen ? { screen } : {}),
    });
  }
  if (nodes.length === 0) return null;

  // Cạnh trỏ tới node không tồn tại bị loại: React Flow lặng lẽ bỏ qua cạnh như
  // vậy, nhưng bố cục BFS bên dưới thì không — nó sẽ xếp một node ma.
  const edges: FlowchartEdge[] = [];
  for (const item of Array.isArray(doc.edges) ? doc.edges : []) {
    if (!item || typeof item !== 'object') continue;
    const e = item as Record<string, unknown>;
    const from = typeof e.from === 'string' ? e.from.trim() : '';
    const to = typeof e.to === 'string' ? e.to.trim() : '';
    if (!from || !to || !seen.has(from) || !seen.has(to)) continue;
    const label = typeof e.label === 'string' && e.label.trim() ? e.label : undefined;
    edges.push({ from, to, ...(label ? { label } : {}) });
  }

  return {
    id: typeof doc.id === 'string' && doc.id.trim() ? doc.id : 'FLOW',
    title: typeof doc.title === 'string' && doc.title.trim() ? doc.title : undefined,
    source: typeof doc.source === 'string' && doc.source.trim() ? doc.source : undefined,
    nodes,
    edges,
  };
}

// Kích thước từng loại khối. Bố cục tự tính vị trí tuyệt đối nên các số này
// phải khớp với CSS module (xem `.start/.end/.action/.decision`).
const SIZE: Record<FlowchartNodeType, { w: number; h: number }> = {
  start: { w: 200, h: 56 },
  end: { w: 200, h: 56 },
  action: { w: 220, h: 68 },
  decision: { w: 180, h: 180 },
};
const ROW_GAP = 70;
const COL_GAP = 48;

/** Bố cục TỪ TRÊN XUỐNG: BFS từ node `start` (không có thì lấy các node không
 *  ai trỏ vào) cho ra tầng của mỗi node; node cùng tầng nằm cùng một hàng và
 *  hàng được canh giữa, nên cạnh đi gần như thẳng đứng. Cùng cách làm với
 *  layoutFlow của SpecFlowCanvas, chỉ xoay trục — đủ cho sơ đồ vài chục khối và
 *  không phải kéo thêm dagre/elk vào bundle. */
export function layoutFlowchart(doc: FlowchartDoc): Map<string, { x: number; y: number }> {
  const typeOf = new Map(doc.nodes.map((n) => [n.id, n.type]));
  const out = new Map<string, string[]>();
  const indeg = new Map<string, number>();
  for (const n of doc.nodes) indeg.set(n.id, 0);
  for (const e of doc.edges) {
    out.set(e.from, [...(out.get(e.from) ?? []), e.to]);
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  }

  const starts = doc.nodes.filter((n) => n.type === 'start').map((n) => n.id);
  const roots = starts.length
    ? starts
    : doc.nodes.filter((n) => (indeg.get(n.id) ?? 0) === 0).map((n) => n.id);
  const depth = new Map<string, number>();
  const queue = (roots.length ? roots : [doc.nodes[0]!.id]).map((id) => ({ id, d: 0 }));
  while (queue.length) {
    const { id, d } = queue.shift()!;
    if (depth.has(id)) continue;
    depth.set(id, d);
    for (const to of out.get(id) ?? []) queue.push({ id: to, d: d + 1 });
  }
  // Node không ai với tới (cạnh hỏng, sơ đồ rời) vẫn phải có chỗ đứng — xếp
  // xuống tầng cuối chứ không chồng lên nhau ở gốc toạ độ.
  const maxDepth = Math.max(0, ...depth.values());
  for (const n of doc.nodes) if (!depth.has(n.id)) depth.set(n.id, maxDepth + 1);

  const byRow = new Map<number, string[]>();
  for (const n of doc.nodes) {
    const d = depth.get(n.id)!;
    byRow.set(d, [...(byRow.get(d) ?? []), n.id]);
  }

  const pos = new Map<string, { x: number; y: number }>();
  let y = 0;
  for (const row of [...byRow.keys()].sort((a, b) => a - b)) {
    const ids = byRow.get(row)!;
    const sizes = ids.map((id) => SIZE[typeOf.get(id) ?? 'action']);
    const rowW = sizes.reduce((s, size) => s + size.w + COL_GAP, -COL_GAP);
    const rowH = Math.max(...sizes.map((size) => size.h));
    let x = -rowW / 2;
    ids.forEach((id, i) => {
      const size = sizes[i]!;
      // Canh giữa theo chiều dọc trong hàng: hàng có hình thoi (cao 180) đứng
      // cạnh ô chữ nhật (cao 68) mà canh mép trên thì cạnh nối lệch hẳn.
      pos.set(id, { x, y: y + (rowH - size.h) / 2 });
      x += size.w + COL_GAP;
    });
    y += rowH + ROW_GAP;
  }
  return pos;
}

function labelOf(props: NodeProps): string {
  return String((props.data as { label?: string } | undefined)?.label ?? '');
}

// Mọi khối đều nhận cạnh ở CẠNH TRÊN và phát ra ở CẠNH DƯỚI — đó là điều làm
// sơ đồ đọc từ trên xuống. Handle để trong suốt vì khung nhìn này không cho nối
// tay (`nodesConnectable={false}`).
const HANDLE_STYLE = { opacity: 0 } as const;

/** start và end dùng CHUNG một component vì cả hai là oval — chỉ khác lớp màu
 *  (start nền accent nhạt, end viền đậm). `props.type` là loại node React Flow
 *  đang dựng, nên không cần hai hàm gần như y hệt nhau. */
function TerminalNode(props: NodeProps) {
  const cls = (props.type === 'start' ? styles.start : styles.end) ?? '';
  return (
    <div className={`${styles.node} ${styles.terminal} ${cls}`}>
      <Handle type="target" position={Position.Top} style={HANDLE_STYLE} />
      <span className={styles.label}>{labelOf(props)}</span>
      <Handle type="source" position={Position.Bottom} style={HANDLE_STYLE} />
    </div>
  );
}

function ActionNode(props: NodeProps) {
  return (
    <div className={`${styles.node} ${styles.action}`}>
      <Handle type="target" position={Position.Top} style={HANDLE_STYLE} />
      <span className={styles.label}>{labelOf(props)}</span>
      <Handle type="source" position={Position.Bottom} style={HANDLE_STYLE} />
    </div>
  );
}

/** Hình thoi = ô vuông XOAY 45°, còn chữ nằm trong một lớp phủ KHÔNG xoay.
 *  Xoay cả cụm rồi xoay ngược chữ lại cũng ra hình đó nhưng chữ bị méo theo
 *  phép biến đổi lồng nhau; tách hẳn lớp hình và lớp chữ thì chữ luôn ngay
 *  ngắn, và phần chữ dài chỉ cần cắt bớt trong khung chữ nhật nội tiếp. */
function DecisionNode(props: NodeProps) {
  const label = labelOf(props);
  return (
    <div className={`${styles.node} ${styles.decision}`}>
      <Handle type="target" position={Position.Top} style={HANDLE_STYLE} />
      <div className={styles.diamond} aria-hidden="true" />
      <div className={styles.diamondLabel}>
        <span className={styles.label} title={label}>
          {label}
        </span>
      </div>
      <Handle type="source" position={Position.Bottom} style={HANDLE_STYLE} />
    </div>
  );
}

const NODE_TYPES = {
  start: TerminalNode,
  end: TerminalNode,
  action: ActionNode,
  decision: DecisionNode,
};

/** Hộp "Chú thích": ký pháp sơ đồ khối chỉ tự giải thích với người đã biết nó,
 *  nên bảng nghĩa phải nằm ngay trên khung nhìn. Thu gọn được vì với sơ đồ nhỏ
 *  nó chiếm mất một góc canvas. */
function Legend() {
  const [open, setOpen] = useState(true);
  return (
    <div className={styles.legend}>
      <button type="button" className={styles.legendToggle} onClick={() => setOpen((v) => !v)}>
        <span>Chú thích</span>
        <span aria-hidden="true">{open ? '−' : '+'}</span>
      </button>
      {open ? (
        <ul className={styles.legendList}>
          <li className={styles.legendRow}>
            <span className={`${styles.legendShape} ${styles.legendOval}`} aria-hidden="true" />
            <span>Oval — điểm bắt đầu/kết thúc</span>
          </li>
          <li className={styles.legendRow}>
            <span className={`${styles.legendShape} ${styles.legendRect}`} aria-hidden="true" />
            <span>Chữ nhật — bước thực hiện/hành động</span>
          </li>
          <li className={styles.legendRow}>
            <span className={`${styles.legendShape} ${styles.legendDiamondWrap}`} aria-hidden="true">
              <span className={styles.legendDiamond} />
            </span>
            <span>Hình thoi — điểm quyết định (rẽ nhánh Có/Không)</span>
          </li>
          <li className={styles.legendRow}>
            <span className={`${styles.legendShape} ${styles.legendArrow}`} aria-hidden="true" />
            <span>Mũi tên — hướng đi giữa các bước</span>
          </li>
        </ul>
      ) : null}
    </div>
  );
}

/** Khung vẽ thuần tuý: nhận một FlowchartDoc đã parse. Tách khỏi component
 *  đọc file để test dựng thẳng từ dữ liệu, không phải giả lập tầng fetch. */
export function FlowchartCanvas({ doc }: { doc: FlowchartDoc }) {
  const built = useMemo(() => {
    const pos = layoutFlowchart(doc);
    const nodes: Node[] = doc.nodes.map((n) => ({
      id: n.id,
      type: n.type,
      position: pos.get(n.id) ?? { x: 0, y: 0 },
      // Khai báo sẵn kích thước thay vì để React Flow đo: kích thước đã cố định
      // trong SIZE/CSS, mà chờ đo xong thì lượt vẽ ĐẦU tiên chưa có cạnh nào
      // (React Flow không tính được đường nối khi chưa biết khối to bằng nào).
      width: SIZE[n.type].w,
      height: SIZE[n.type].h,
      draggable: true,
      data: { label: n.label },
    }));
    const edges: Edge[] = doc.edges.map((e, i) => ({
      id: `e${i}`,
      source: e.from,
      target: e.to,
      // Gấp khúc vuông góc chứ không cong: đó là cách sơ đồ khối được vẽ trong
      // mọi tài liệu nghiệp vụ mà khung nhìn này dựng lại.
      type: 'smoothstep',
      ...(e.label ? { label: e.label } : {}),
      labelShowBg: true,
      style: { stroke: 'var(--text-muted, #57544e)', strokeWidth: 1.6 },
      markerEnd: { type: MarkerType.ArrowClosed, color: 'var(--text-muted, #57544e)' },
    }));
    return { nodes, edges };
  }, [doc]);

  return (
    <div className={styles.canvas}>
      <ReactFlowProvider>
        <ReactFlow
          nodes={built.nodes}
          edges={built.edges}
          nodeTypes={NODE_TYPES}
          fitView
          fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
          minZoom={0.1}
          proOptions={{ hideAttribution: true }}
          nodesConnectable={false}
          nodesDraggable
          elementsSelectable
          panOnDrag
          zoomOnScroll
        >
          <Background gap={22} size={1.4} />
          <Controls showInteractive={false} />
          {/* Góc TRÊN-PHẢI: `Controls` mặc định nằm ở dưới-trái nên đặt chú
              thích cùng chỗ là hai hộp chồng lên nhau. */}
          <Panel position="top-right">
            <Legend />
          </Panel>
        </ReactFlow>
      </ReactFlowProvider>
    </div>
  );
}

type PreviewMode = 'list' | 'screens' | 'graph';

function ModeBar({
  mode,
  onChange,
  useCaseCount,
  screenCount,
  stepCount,
}: {
  mode: PreviewMode;
  onChange: (mode: PreviewMode) => void;
  useCaseCount: number;
  screenCount: number;
  stepCount: number;
}) {
  const tab = (id: PreviewMode, name: string, meta: string) => (
    <button type="button" role="tab" aria-selected={mode === id} className={`${readerStyles.modeButton} ${mode === id ? readerStyles.modeButtonActive : ''}`} onClick={() => onChange(id)}>
      <span className={readerStyles.modeButtonName}>{name}</span><span className={readerStyles.modeButtonMeta}>· {meta}</span>
    </button>
  );
  return (
    <div className={readerStyles.modeBar} role="tablist" aria-label="Chế độ xem sơ đồ">
      {tab('list', 'Kịch bản', String(useCaseCount))}
      {tab('screens', 'Flow màn hình', `${screenCount} màn`)}
      {tab('graph', 'Sơ đồ đầy đủ', `${stepCount} bước`)}
    </div>
  );
}

/** Thư mục workflow chứa `flows/` — phần trước `flows/` của tên file. Wireframe
 *  nằm ở `<dir>wireframes/`, index tên màn ở `<dir>flows/index.json`. File
 *  không nằm dưới `flows/` (mở tay) → lấy thư mục cha. */
export function workflowDirOf(fileName: string): string {
  const m = /^(.*?)flows\/[^/]+$/.exec(fileName);
  if (m && (m[1] === '' || m[1]!.endsWith('/'))) return m[1]!;
  const slash = fileName.lastIndexOf('/');
  return slash >= 0 ? fileName.slice(0, slash + 1) : '';
}

/** Tên màn từ `flows/index.json` (`[].screens[].{key,name}`); file hỏng/thiếu
 *  → rỗng, viewer fallback về SCREEN-KEY. */
export function parseScreenNames(raw: string | null): Record<string, string> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { flows?: unknown }).flows)
      ? ((parsed as { flows: unknown[] }).flows)
      : [];
  const names: Record<string, string> = {};
  for (const item of list) {
    const screens = (item as { screens?: unknown } | null)?.screens;
    if (!Array.isArray(screens)) continue;
    for (const s of screens) {
      const key = typeof (s as { key?: unknown })?.key === 'string' ? (s as { key: string }).key.trim() : '';
      const name = typeof (s as { name?: unknown })?.name === 'string' ? (s as { name: string }).name.trim() : '';
      if (key && name && !names[key]) names[key] = name;
    }
  }
  return names;
}

/** `web` | `mobile` từ `<body data-layout="…">` của wireframe; mặc định web
 *  (tài liệu URD backoffice). */
export function wireframeLayoutOf(html: string): 'web' | 'mobile' {
  return /data-layout\s*=\s*["']?mobile\b/i.test(html) ? 'mobile' : 'web';
}

interface ScreenAssets {
  names: Record<string, string>;
  wireframes: Record<string, string>;
  platforms: Record<string, string>;
}
const EMPTY_ASSETS: ScreenAssets = { names: {}, wireframes: {}, platforms: {} };

const MISSING_WIRE_TEXT = '(chưa có wireframe — chạy bước Màn hình → Component)';

/** Tab "Flow màn hình": vẽ FlowDoc đã chuyển đổi bằng bộ node dùng chung với
 *  ux (màn có thumbnail, hình thoi, oval, nav xám). Component riêng để state
 *  kéo-thả của React Flow sống cùng tab. */
function ScreenFlowTab({
  flow,
  screenNames,
  wireframes,
  platforms,
  layoutRoot,
  hasScreens,
}: {
  flow: FlowDoc;
  screenNames: ReadonlyMap<string, string>;
  wireframes: Record<string, string>;
  platforms: Record<string, string>;
  layoutRoot?: string;
  hasScreens: boolean;
}) {
  const built = useMemo<BuiltFlowGraph>(
    () =>
      buildFlowGraph({
        flow,
        screenIds: new Set(),
        screenNames,
        wireframes,
        platforms,
        layoutRoot,
        missingWireText: MISSING_WIRE_TEXT,
      }),
    [flow, screenNames, wireframes, platforms, layoutRoot],
  );
  const graph = useFlowGraphState(built);
  return (
    <>
      {hasScreens ? null : (
        <div className={styles.hint}>
          Sơ đồ chưa gán màn hình — chạy lại bước Đánh giá luồng UX (dr-flow) để có thumbnail
        </div>
      )}
      <FlowGraphView {...graph} />
    </>
  );
}

export function FlowchartPreview({ projectId, file }: { projectId: string; file: ProjectFile }) {
  const [raw, setRaw] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [mode, setMode] = useState<PreviewMode>('list');
  const [assets, setAssets] = useState<ScreenAssets | null>(null);

  useEffect(() => {
    let cancelled = false;
    setRaw(null);
    setMissing(false);
    void fetchProjectFileText(projectId, file.name).then((text) => {
      if (cancelled) return;
      if (text == null) setMissing(true);
      else setRaw(text);
    });
    return () => {
      cancelled = true;
    };
  }, [projectId, file.name, file.mtime]);

  const doc = useMemo(() => (raw == null ? null : parseFlowchartDoc(raw)), [raw]);
  const useCaseCount = useMemo(() => (doc ? deriveUseCases(doc).useCases.length : 0), [doc]);
  const screenKeys = useMemo(
    () => (doc ? [...new Set(doc.nodes.map((n) => n.screen).filter((s): s is string => !!s))] : []),
    [doc],
  );

  // Wireframe + tên màn: đọc thẳng theo SCREEN-KEY, không cần liệt kê thư mục.
  // Wireframe do bước dr-comp (chạy SAU dr-flow) sinh nên có thể chưa có — null
  // là bình thường, node hiện chỗ trống có chỉ dẫn.
  const dir = workflowDirOf(file.name);
  useEffect(() => {
    setAssets(null);
    if (!doc) return;
    if (screenKeys.length === 0) {
      setAssets(EMPTY_ASSETS);
      return;
    }
    let cancelled = false;
    void (async () => {
      const [indexRaw, ...htmls] = await Promise.all([
        fetchProjectFileText(projectId, `${dir}flows/index.json`).catch(() => null),
        ...screenKeys.map((key) => fetchProjectFileText(projectId, `${dir}wireframes/${key}.html`).catch(() => null)),
      ]);
      if (cancelled) return;
      const wireframes: Record<string, string> = {};
      const platforms: Record<string, string> = {};
      screenKeys.forEach((key, i) => {
        const html = htmls[i];
        if (!html) return;
        wireframes[key] = html;
        platforms[key] = wireframeLayoutOf(html);
      });
      setAssets({ names: parseScreenNames(indexRaw), wireframes, platforms });
    })();
    return () => {
      cancelled = true;
    };
  }, [doc, screenKeys, projectId, dir]);

  const converted = useMemo(() => (doc ? flowchartToFlowDoc(doc, assets?.names ?? {}) : null), [doc, assets]);
  const screenNames = useMemo(
    () => new Map((converted?.screens ?? []).map((s) => [s.id, s.name])),
    [converted],
  );
  const renderStepExtra = useMemo(
    () =>
      makeWireframeStepExtra({
        screenOf: (node) => node.screen,
        wireframes: assets?.wireframes ?? null,
        platforms: assets?.platforms ?? null,
        screenNames,
      }),
    [assets, screenNames],
  );

  if (missing) {
    return (
      <div className="viewer">
        <div className={`viewer-body ${styles.message}`}>Không đọc được file sơ đồ.</div>
      </div>
    );
  }
  if (raw == null) {
    return (
      <div className="viewer">
        <div className={`viewer-body ${styles.message}`}>Đang tải…</div>
      </div>
    );
  }
  if (!doc || !converted) {
    // Không crash: file hỏng vẫn là kết quả của một lượt chạy, nên nói rõ hỏng
    // ở đâu để người dùng biết phải chạy lại bước nào.
    return (
      <div className="viewer">
        <div className={`viewer-body ${styles.message} ${styles.error}`}>
          Không đọc được sơ đồ: <code>{file.name}</code> không phải JSON hợp lệ hoặc không có node
          nào. Chạy lại bước sinh sơ đồ để có file mới.
        </div>
      </div>
    );
  }

  // Bố cục Flow màn hình bắt đầu từ node start ĐÃ GỘP (màn nếu start là màn,
  // không thì node nav "Bắt đầu"); `flow.entry` là màn đầu tiên nên nếu lấy nó
  // làm gốc thì node nav đứng trước bị rơi ra ngoài cây.
  const start = doc.nodes.find((n) => n.type === 'start');
  const layoutRoot = start ? start.screen ?? start.id : undefined;
  const head = (
    <div className={styles.head}>
      <h2 className={styles.title}>{doc.title ?? doc.id}</h2>
      {doc.source ? <span className={styles.source} title={doc.source}>Nguồn: <code>{doc.source}</code></span> : null}
    </div>
  );

  return (
    <div className="viewer" style={{ height: '100%' }}>
      <div className={`viewer-body ${styles.viewerBody}`}>
        <ModeBar mode={mode} useCaseCount={useCaseCount} screenCount={converted.screens.length} stepCount={doc.nodes.length} onChange={setMode} />
        {mode === 'list' ? <UseCaseReader doc={doc} renderStepExtra={renderStepExtra} /> : null}
        {mode === 'screens' ? (
          <>
            {head}
            <ScreenFlowTab
              flow={converted.flow}
              screenNames={screenNames}
              wireframes={assets?.wireframes ?? EMPTY_ASSETS.wireframes}
              platforms={assets?.platforms ?? EMPTY_ASSETS.platforms}
              layoutRoot={layoutRoot}
              hasScreens={converted.screens.length > 0}
            />
          </>
        ) : null}
        {mode === 'graph' ? <>{head}<FlowchartCanvas doc={doc} /></> : null}
      </div>
    </div>
  );
}
