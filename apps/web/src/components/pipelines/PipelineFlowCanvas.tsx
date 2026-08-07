// PipelineFlowCanvas — pipeline của một workflow vẽ thành SƠ ĐỒ NODE (React
// Flow) thay cho stepper dọc.
//
// Vì sao cần: stepper dọc buộc mọi bước phải xếp thành MỘT hàng, nên ba đầu ra
// UI-Spec (`ui-html` | `ui-react` | `ui-react-ds`) — vốn là ba nhánh SONG SONG
// cùng ăn output của ux — phải nhồi vào một thẻ với ba badge trạng thái. Người
// đọc không nhìn ra đó là ba lựa chọn, càng không thấy được nhánh nào sẽ chạy.
// Ở dạng sơ đồ, ba nhánh đó tự rơi vào CÙNG MỘT TẦNG (chúng có cùng độ sâu phụ
// thuộc) và nằm cạnh nhau — không cần gom badge, không cần luật gộp theo id.
//
// Component này CHỈ trình bày: trạng thái tick do phía gọi sở hữu
// (controlled), nên canvas và danh sách checkbox "Các bước sẽ chạy" ở panel
// phải đọc/ghi chung một `stageIds` thay vì hai state rời nhau. Luật tick lan
// theo phụ thuộc nằm ở `resolveToggle` (hàm thuần, export riêng) và ủy quyền
// thẳng cho `selectStageWithDeps` / `deselectStageWithDependents` của
// PipelineModals — chép lại luật lần hai là cách chắc chắn nhất để hai bề mặt
// lệch nhau.
import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import type { PipelineStatus, PipelineView } from '@open-design/contracts';

import {
  deselectStageWithDependents,
  selectStageWithDeps,
  type RunStageOption,
} from './PipelineModals';
import styles from './PipelineFlowCanvas.module.css';

/** Kích thước khai báo SẴN cho React Flow (thay vì để nó tự đo): lượt vẽ đầu
 *  tiên chưa biết khối to bằng nào thì chưa dựng được đường nối nào cả. */
const NODE_W = 244;
const NODE_H = 136;
/** Khoảng cách giữa hai TẦNG (trục ngang) và giữa hai node cùng tầng (dọc). */
const COL_GAP = 92;
const ROW_GAP = 30;

const STATUS_TEXT: Record<PipelineStatus, string> = {
  idle: 'Chưa chạy',
  queued: 'Đang chờ',
  running: 'Đang chạy',
  succeeded: 'Xong',
  failed: 'Lỗi',
};

/** Chỉ những bước đọc được `PipelineView` mới cần — giữ đúng tập con này để
 *  test dựng fixture gọn và để component không lỡ tay phụ thuộc field khác. */
export type StageLike = Pick<PipelineView, 'id' | 'name' | 'dependsOn' | 'status'> &
  Partial<Pick<PipelineView, 'active' | 'skipped' | 'effectiveDependsOn'>>;

function toStageOptions(pipelines: readonly StageLike[]): RunStageOption[] {
  return pipelines.map((p) => ({
    id: p.id,
    name: p.name,
    dependsOn: p.dependsOn,
    status: p.status,
    ...(p.skipped === true ? { skipped: true } : {}),
  }));
}

function toIdSet(selected: ReadonlySet<string> | readonly string[]): Set<string> {
  return selected instanceof Set ? new Set(selected) : new Set(selected as readonly string[]);
}

/**
 * Tick/bỏ tick MỘT bước ⇒ tập bước sẽ chạy sau thao tác đó, theo ĐÚNG thứ tự
 * `pipelines` (thứ tự workflow, không phải thứ tự bấm).
 *
 * Hàm thuần và export riêng vì hai lý do: phía gọi (PipelinesView) cần dùng lại
 * y hệt cho danh sách checkbox ở panel phải — cùng một luật, một bản mã — và vì
 * luật này là phần đắt nhất của tính năng nên nó phải test được trực tiếp,
 * không phải qua DOM.
 *
 * Thân hàm ủy quyền cho `selectStageWithDeps` / `deselectStageWithDependents`:
 * tick kéo theo mọi phụ thuộc CHƯA `succeeded` (đệ quy), bỏ tick kéo theo mọi
 * bước vì thế mất input. Phụ thuộc đã `succeeded` có output sẵn trên đĩa nên
 * không bị đụng tới.
 */
export function resolveToggle(
  pipelines: readonly StageLike[],
  selectedIds: ReadonlySet<string> | readonly string[],
  id: string,
  next: boolean,
): string[] {
  const stages = toStageOptions(pipelines);
  const current = toIdSet(selectedIds);
  const resolved = next
    ? selectStageWithDeps(id, stages, current)
    : deselectStageWithDependents(id, stages, current);
  return pipelines.filter((p) => resolved.has(p.id)).map((p) => p.id);
}

/**
 * Tầng của một bước = ĐỘ SÂU LỚN NHẤT theo `dependsOn` (bước không phụ thuộc
 * gì = tầng 0). Lấy max chứ không lấy min: một bước chỉ chạy được khi phụ thuộc
 * SAU CÙNG của nó xong, nên min sẽ vẽ nó đứng trước một bước nó phải chờ.
 *
 * Node cùng tầng xếp dọc, cách đều và canh giữa quanh y=0 nên cạnh đi gần như
 * ngang. Đủ cho vài chục bước — không kéo dagre/elk vào bundle, cùng cách làm
 * với `layoutFlowchart` của FlowchartPreview, chỉ xoay trục.
 *
 * Phụ thuộc trỏ ra ngoài danh sách bị bỏ qua (workflow lọc bớt bước), và vòng
 * lặp phụ thuộc — dữ liệu hỏng, không nên làm sập khung nhìn — được chặn bằng
 * cờ `visiting`, node trong vòng coi như tầng 0.
 */
export function layoutPipelineFlow(
  pipelines: readonly StageLike[],
): Map<string, { tier: number; x: number; y: number }> {
  const byId = new Map(pipelines.map((p) => [p.id, p]));
  const tiers = new Map<string, number>();
  const visiting = new Set<string>();

  const tierOf = (id: string): number => {
    const cached = tiers.get(id);
    if (cached !== undefined) return cached;
    const stage = byId.get(id);
    if (!stage || visiting.has(id)) return 0;
    visiting.add(id);
    let tier = 0;
    for (const dep of stage.dependsOn) {
      if (!byId.has(dep)) continue;
      tier = Math.max(tier, tierOf(dep) + 1);
    }
    visiting.delete(id);
    tiers.set(id, tier);
    return tier;
  };
  for (const p of pipelines) tierOf(p.id);

  const byTier = new Map<number, string[]>();
  for (const p of pipelines) {
    const tier = tiers.get(p.id) ?? 0;
    byTier.set(tier, [...(byTier.get(tier) ?? []), p.id]);
  }

  const pos = new Map<string, { tier: number; x: number; y: number }>();
  for (const [tier, ids] of byTier) {
    const span = NODE_H + ROW_GAP;
    const top = -((ids.length - 1) * span) / 2;
    ids.forEach((id, i) => {
      pos.set(id, { tier, x: tier * (NODE_W + COL_GAP), y: top + i * span });
    });
  }
  return pos;
}

/** Nhãn chip trạng thái. "Bỏ qua" thắng `idle` vì chế độ chạy hiện tại KHÔNG
 *  chạy bước đó — nói "Chưa chạy" sẽ khiến người dùng ngồi đợi nó tự chạy. */
function statusLabel(p: StageLike): string {
  if (p.skipped === true && p.status === 'idle') return 'Bỏ qua';
  return STATUS_TEXT[p.status] ?? p.status;
}

function statusClass(p: StageLike): string {
  if (p.skipped === true && p.status === 'idle') return styles.chipSkipped ?? '';
  switch (p.status) {
    case 'succeeded':
      return styles.chipDone ?? '';
    case 'failed':
      return styles.chipFailed ?? '';
    case 'running':
    case 'queued':
      return styles.chipRunning ?? '';
    default:
      return styles.chipIdle ?? '';
  }
}

/** Lời nhắc của bước bị khoá: nêu ĐÚNG các bước còn thiếu, lấy theo
 *  `effectiveDependsOn` khi có — cổng mà chế độ chạy hiện tại thực sự áp — nên
 *  không bao giờ nêu tên một bước mà chế độ này bỏ qua. */
function lockHint(p: StageLike, byId: ReadonlyMap<string, StageLike>): string {
  const gate = (p.effectiveDependsOn ?? p.dependsOn).filter((dep) => {
    const d = byId.get(dep);
    return !d || d.status !== 'succeeded';
  });
  if (gate.length === 0) return 'Bước này chưa mở khoá.';
  const names = gate.map((dep) => byId.get(dep)?.name ?? dep).join(', ');
  return `Cần xong ${names} trước. Vẫn tick được để chạy ở lượt sau.`;
}

interface StageNodeData extends Record<string, unknown> {
  stage: StageLike;
  checked: boolean;
  locked: boolean;
  lockHint: string;
  onToggle: (id: string, next: boolean) => void;
  onRun: (id: string) => void;
}

function StageNode({ data }: NodeProps): JSX.Element {
  const { stage, checked, locked, lockHint: hint, onToggle, onRun } = data as StageNodeData;
  const running = stage.status === 'running' || stage.status === 'queued';
  return (
    <div
      className={`${styles.node} ${locked ? styles.nodeLocked : ''} ${checked ? styles.nodeChecked : ''}`}
      data-stage-id={stage.id}
      data-locked={locked ? 'true' : 'false'}
      {...(locked ? { title: hint } : {})}
    >
      {/* Ẩn hẳn hai đầu nối: khung nhìn này không cho nối tay, handle chỉ tồn
          tại để React Flow biết cạnh vào/ra ở mép nào. */}
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />

      <div className={styles.head}>
        {/* `nodrag nopan` — không có nó thì kéo chuột trên ô tick sẽ thành kéo
            node/kéo canvas và cú bấm không bao giờ tới được input. */}
        <label className={`${styles.tick} nodrag nopan`} title={hint || undefined}>
          <input
            type="checkbox"
            checked={checked}
            aria-label={`Chọn bước ${stage.name}`}
            onChange={(e) => onToggle(stage.id, e.target.checked)}
          />
          <span className={styles.tickText}>Chạy bước này</span>
        </label>
      </div>

      <div className={styles.name} title={stage.name}>
        {stage.name}
      </div>

      <div className={styles.foot}>
        <span className={`${styles.chip} ${statusClass(stage)}`}>
          {running ? <span className={styles.dot} aria-hidden="true" /> : null}
          {statusLabel(stage)}
        </span>
        <button
          type="button"
          className={`${styles.run} nodrag nopan`}
          aria-label={`Chạy ${stage.name}`}
          onClick={() => onRun(stage.id)}
        >
          {running ? 'Đang chạy…' : 'Chạy'}
        </button>
      </div>

      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
    </div>
  );
}

const NODE_TYPES = { stage: StageNode };

export interface PipelineFlowCanvasProps {
  /** Các bước của workflow đang mở, ĐÚNG thứ tự workflow. */
  pipelines: StageLike[];
  /** Các bước đang được tick — do PHÍA GỌI sở hữu (controlled). Nhận cả Set lẫn
   *  mảng để caller khỏi phải đổi kiểu state đang có. */
  selectedIds: Set<string> | string[];
  /** Báo một ô tick vừa đổi. Canvas KHÔNG tự lan theo phụ thuộc — phía gọi chạy
   *  `resolveToggle` rồi ghi lại state, để canvas và danh sách checkbox ở panel
   *  phải dùng chung một nguồn sự thật. */
  onToggle: (id: string, next: boolean) => void;
  /** Nút Chạy của riêng một bước. */
  /** Nút Chạy của riêng một bước. BỎ TRỐNG thì node không render nút đó — dùng
   *  cho ca canvas nằm trong modal chọn bước, nơi chạy lẻ không có nghĩa. */
  onRunStage?: (p: StageLike) => void;
}

export function PipelineFlowCanvas({
  pipelines,
  selectedIds,
  onToggle,
  onRunStage,
}: PipelineFlowCanvasProps): JSX.Element {
  // Callback đi qua `data` của node, mà `data` chỉ được dựng lại khi input đổi.
  // Giữ bản mới nhất trong ref rồi gọi gián tiếp: node không phải dựng lại chỉ
  // vì caller truyền vào một closure mới mỗi lượt render.
  const handlers = useRef({ onToggle, onRunStage });
  handlers.current = { onToggle, onRunStage };

  const selected = useMemo(() => toIdSet(selectedIds), [selectedIds]);

  const emitToggle = useCallback((id: string, next: boolean) => {
    handlers.current.onToggle(id, next);
  }, []);
  const emitRun = useCallback(
    (id: string) => {
      const stage = pipelines.find((p) => p.id === id);
      if (stage) handlers.current.onRunStage?.(stage);
    },
    [pipelines],
  );

  const built = useMemo(() => {
    const pos = layoutPipelineFlow(pipelines);
    const byId = new Map<string, StageLike>(pipelines.map((p) => [p.id, p]));

    const nodes: Node[] = pipelines.map((p) => {
      const locked = p.active === false;
      return {
        id: p.id,
        type: 'stage',
        position: pos.get(p.id) ?? { x: 0, y: 0 },
        width: NODE_W,
        height: NODE_H,
        draggable: true,
        data: {
          stage: p,
          checked: selected.has(p.id),
          locked,
          lockHint: locked ? lockHint(p, byId) : '',
          onToggle: emitToggle,
          onRun: emitRun,
        } satisfies StageNodeData,
      };
    });

    // Cạnh = quan hệ `dependsOn`, hướng từ bước TRƯỚC sang bước SAU. Phụ thuộc
    // trỏ ra ngoài danh sách (workflow lọc bớt bước) bị bỏ, không vẽ cạnh cụt.
    const edges: Edge[] = [];
    for (const p of pipelines) {
      for (const dep of p.dependsOn) {
        if (!byId.has(dep)) continue;
        edges.push({
          id: `${dep}->${p.id}`,
          source: dep,
          target: p.id,
          type: 'smoothstep',
          style: { stroke: 'var(--text-muted, #57544e)', strokeWidth: 1.5 },
          markerEnd: { type: MarkerType.ArrowClosed, color: 'var(--text-muted, #57544e)' },
        });
      }
    }
    return { nodes, edges };
  }, [pipelines, selected, emitToggle, emitRun]);

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  useEffect(() => {
    setNodes(built.nodes);
    setEdges(built.edges);
  }, [built, setNodes, setEdges]);

  if (pipelines.length === 0) {
    return <div className={styles.empty}>Workflow này chưa có bước nào.</div>;
  }

  return (
    <div className={styles.canvas}>
      <ReactFlowProvider>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          nodeTypes={NODE_TYPES}
          fitView
          fitViewOptions={{ padding: 0.18, maxZoom: 1 }}
          minZoom={0.2}
          proOptions={{ hideAttribution: true }}
          nodesConnectable={false}
          nodesDraggable
          elementsSelectable
          panOnDrag
          zoomOnScroll
        >
          <Background gap={22} size={1.4} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </ReactFlowProvider>
    </div>
  );
}
