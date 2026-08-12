// flow-usecases — tách MỘT sơ đồ khối (`flows/<id>.flowchart.json`) thành các
// KỊCH BẢN (use-case) độc lập: mỗi đường đi từ "Bắt đầu" tới một điểm kết thúc
// là một kịch bản riêng ("Thêm mới thành công", "Thiếu thông tin bắt buộc",
// "Không có quyền"…).
//
// Vì sao cần: sơ đồ nghiệp vụ thật ở đây có tới 23 node / 7 điểm rẽ nhánh —
// vẽ nguyên khối thì đúng nhưng không đọc nổi. Trong khi số ĐƯỜNG ĐI lại rất
// nhỏ (đo trên 22 file thật: nhiều nhất 11, điển hình 3–9), nên chẻ theo đường
// đi cho ra vài thẻ ngắn ai cũng đọc được, mà KHÔNG cần đổi schema hay chạy
// lại pipeline — dữ liệu đã nằm sẵn trong file.
//
// Module thuần (không React, không I/O) để test được và để khung nhìn flow của
// bước ux (`.flow.json`, schema khác) sau này tái dùng cùng cách chẻ.

import type { FlowchartDoc, FlowchartNode } from './FlowchartPreview';

/** Kết cục của một kịch bản — quyết định màu badge và cách gọi tên. */
export type UseCaseOutcome =
  | 'success' // kết thúc và nhãn nói rõ là thành công
  | 'blocked' // kết thúc nhưng là lỗi/từ chối/hủy
  | 'loop' // quay ngược lại một bước đã qua (nhập lại, thử lại)
  | 'neutral'; // kết thúc trung tính, hoặc node cụt không rõ nghĩa

export interface UseCaseStep {
  node: FlowchartNode;
  /** Nhãn cạnh ĐI RA khỏi node này trong kịch bản — câu trả lời đã chọn tại
   *  điểm rẽ nhánh ("Có"/"Không"). Bước cuối không có. */
  answer?: string;
}

export interface FlowUseCase {
  id: string;
  title: string;
  /** Chuỗi câu trả lời tại các điểm rẽ nhánh — đây là thứ PHÂN BIỆT kịch bản
   *  này với kịch bản khác, nên nó là mô tả tự nhiên nhất cho thẻ listing. */
  description: string;
  outcome: UseCaseOutcome;
  steps: UseCaseStep[];
  /** Kịch bản 'loop': node bị quay lại (để khung nhìn nói "quay lại bước N"). */
  loopToNodeId?: string;
}

export interface FlowUseCaseResult {
  useCases: FlowUseCase[];
  /** Cắt bớt vì sơ đồ có quá nhiều đường đi — PHẢI hiện ra cho người dùng
   *  biết, im lặng cắt là nói dối về độ phủ. */
  truncated: boolean;
}

export interface UseCaseSplit {
  /** Các bước MỌI kịch bản đều đi qua ở đầu — đường vào tính năng. */
  entryPath: UseCaseStep[];
  /** Kịch bản đã CẮT BỎ phần entryPath khỏi `steps`. */
  useCases: FlowUseCase[];
  truncated: boolean;
}

/** Trần số kịch bản. Đo trên dữ liệu thật thì tối đa 11 nên trần này chỉ là
 *  lưới an toàn cho sơ đồ bệnh lý (rẽ nhánh lồng nhau nhiều tầng). */
export const MAX_USE_CASES = 60;

const SUCCESS_RE = /thành\s*công|hoàn\s*t(ấ|â)t|success|đã\s*lưu/i;
const BLOCKED_RE =
  /lỗi|thất\s*bại|không\s*có\s*quyền|từ\s*chối|hu(ỷ|y)|hủy|dừng|không\s*hợp\s*lệ|denied|fail|(không|chưa)\s+\S+\s*(thành\s*công|hợp\s*lệ)/i;

/** Xét "hỏng" TRƯỚC "thành công": nhãn thật hay là câu phủ định chứa nguyên từ
 *  tích cực — "Báo lỗi: không có thẻ hợp lệ" từng bị gắn nhãn Thành công vì
 *  khớp chữ "hợp lệ". Kết thúc mà nhắc tới lỗi/từ chối/hủy thì luôn là hỏng. */
function outcomeOfEnd(label: string): UseCaseOutcome {
  if (BLOCKED_RE.test(label)) return 'blocked';
  if (SUCCESS_RE.test(label)) return 'success';
  return 'neutral';
}

/** Tên kịch bản: lấy từ ĐIỂM KẾT THÚC vì đó là điều người đọc muốn biết
 *  ("Thêm mới nhân viên thành công", "Không có quyền thao tác"). Kịch bản quay
 *  vòng thì điểm kết thúc là chính cái bước gây quay lại (thường là node hiện
 *  thông báo lỗi) — cũng là câu trả lời đúng cho "kịch bản này là gì". */
function titleOf(steps: UseCaseStep[], outcome: UseCaseOutcome): string {
  const last = steps[steps.length - 1]?.node;
  if (outcome !== 'loop') return last?.label?.trim() || 'Kịch bản';
  // Quay vòng: node cuối có thể là điểm rẽ nhánh ("Người dùng chọn tiếp tục?"),
  // khi đó bước hành động gần nhất mới là cái mô tả được kịch bản.
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const node = steps[i]!.node;
    if (node.type === 'action') return node.label.trim();
  }
  return last?.label?.trim() || 'Quay lại bước trước';
}

/** Mô tả = các ngã rẽ đã chọn. Đây là thứ duy nhất phân biệt hai kịch bản đi
 *  qua cùng một dãy màn hình, nên nó quan trọng hơn mọi tóm tắt khác. */
function describe(steps: UseCaseStep[]): string {
  const parts: string[] = [];
  for (const step of steps) {
    if (step.node.type !== 'decision' || !step.answer) continue;
    parts.push(`${step.node.label.trim()} → ${step.answer}`);
  }
  return parts.join(' · ');
}

/** Chẻ sơ đồ thành các kịch bản.
 *
 *  Duyệt sâu từ node `start`; một đường đi kết thúc khi (a) tới node `end`,
 *  (b) node không còn cạnh đi ra, hoặc (c) gặp lại node đã đi qua TRONG CHÍNH
 *  đường đi đó — vòng lặp "nhập sai rồi nhập lại" là hữu hạn về mặt kịch bản
 *  chứ không phải vô hạn, nên cắt tại đó và đánh dấu 'loop' thay vì đi mãi. */
export function deriveUseCases(doc: FlowchartDoc): FlowUseCaseResult {
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  const outgoing = new Map<string, Array<{ to: string; label?: string }>>();
  for (const edge of doc.edges) {
    if (!byId.has(edge.from) || !byId.has(edge.to)) continue;
    const list = outgoing.get(edge.from) ?? [];
    list.push({ to: edge.to, ...(edge.label ? { label: edge.label } : {}) });
    outgoing.set(edge.from, list);
  }

  const starts = doc.nodes.filter((n) => n.type === 'start');
  // Sơ đồ do LLM sinh có thể thiếu node 'start' — lấy node không có cạnh đi vào
  // làm điểm xuất phát thay vì trả về rỗng (khung nhìn rỗng là vô dụng).
  const entries = starts.length
    ? starts
    : doc.nodes.filter((n) => !doc.edges.some((e) => e.to === n.id)).slice(0, 1);

  const useCases: FlowUseCase[] = [];
  let truncated = false;

  const walk = (steps: UseCaseStep[], seen: Set<string>): void => {
    if (useCases.length >= MAX_USE_CASES) {
      truncated = true;
      return;
    }
    const current = steps[steps.length - 1]!.node;
    const next = outgoing.get(current.id) ?? [];
    if (current.type === 'end' || next.length === 0) {
      const outcome = current.type === 'end' ? outcomeOfEnd(current.label) : 'neutral';
      useCases.push(finish(steps, outcome));
      return;
    }
    for (const edge of next) {
      const target = byId.get(edge.to)!;
      const step: UseCaseStep = { node: current, ...(edge.label ? { answer: edge.label } : {}) };
      const walked = [...steps.slice(0, -1), step];
      if (seen.has(edge.to)) {
        useCases.push({ ...finish(walked, 'loop'), loopToNodeId: edge.to });
        continue;
      }
      walk([...walked, { node: target }], new Set([...seen, edge.to]));
    }
  };

  // A path is not identified by nodes alone: two labelled edges may connect
  // the same pair of nodes (for example two permission outcomes converging on
  // one "Kết thúc" screen). Include the selected edge answer in the stable id
  // so React keys and scenario selection remain unique.
  const pathId = (steps: UseCaseStep[]): string =>
    steps
      .map((step) => `${encodeURIComponent(step.node.id)}${step.answer ? `~${encodeURIComponent(step.answer)}` : ''}`)
      .join('>');

  const finish = (steps: UseCaseStep[], outcome: UseCaseOutcome): FlowUseCase => ({
    id: `${encodeURIComponent(doc.id || 'flow')}::${pathId(steps)}`,
    title: titleOf(steps, outcome),
    description: describe(steps),
    outcome,
    steps,
  });

  for (const entry of entries) walk([{ node: entry }], new Set([entry.id]));

  // Malformed/generated flow files occasionally repeat the exact same edge.
  // Such a duplicate represents the same scenario, not another card. Remove
  // it here instead of merely appending an arbitrary React-key suffix.
  const uniqueUseCases = [...new Map(useCases.map((useCase) => [useCase.id, useCase])).values()];

  // Hai kịch bản trùng tên (cùng kết thúc, khác đường) — thêm ngã rẽ khác biệt
  // vào tên để thẻ listing không hiện hai dòng y hệt nhau.
  const seenTitles = new Map<string, number>();
  for (const useCase of uniqueUseCases) {
    const count = (seenTitles.get(useCase.title) ?? 0) + 1;
    seenTitles.set(useCase.title, count);
  }
  for (const useCase of uniqueUseCases) {
    if ((seenTitles.get(useCase.title) ?? 0) < 2) continue;
    const last = useCase.description.split(' · ').pop();
    if (last) useCase.title = `${useCase.title} (${last})`;
  }

  return { useCases: uniqueUseCases, truncated };
}

/** Tách tiền tố giống nhau khỏi các kịch bản để đường vào chỉ hiện một lần. */
export function deriveUseCasesWithEntry(doc: FlowchartDoc): UseCaseSplit {
  const result = deriveUseCases(doc);
  if (result.useCases.length < 2) {
    return { entryPath: [], useCases: result.useCases, truncated: result.truncated };
  }

  const first = result.useCases[0]!.steps;
  const shortest = Math.min(...result.useCases.map((item) => item.steps.length));
  let length = 0;
  // So khớp CẢ câu trả lời, không chỉ node: điểm rẽ nhánh mà mọi kịch bản đều
  // đi qua ("Có quyền Thêm KH?") vẫn là node CHUNG, nhưng mỗi kịch bản trả lời
  // một kiểu — gộp nó vào "đường vào chung" thì khối chung sẽ hiện câu trả lời
  // của kịch bản đầu tiên như thể đó là đáp án của tất cả. Tiền tố phải dừng
  // ĐÚNG chỗ các đường đi tách nhau.
  while (
    length < shortest &&
    result.useCases.every(
      (item) =>
        item.steps[length]?.node.id === first[length]?.node.id &&
        item.steps[length]?.answer === first[length]?.answer,
    )
  ) {
    length += 1;
  }

  if (length < 2 || length * 100 > shortest * 60) {
    return { entryPath: [], useCases: result.useCases, truncated: result.truncated };
  }

  return {
    entryPath: first.slice(0, length),
    useCases: result.useCases.map((useCase) => ({ ...useCase, steps: useCase.steps.slice(length) })),
    truncated: result.truncated,
  };
}

/** Node của `flows/*.flow.json` (bước ux) — schema KHÁC `.flowchart.json`:
 *  màn hình là NGẦM ĐỊNH (đầu cạnh nào trùng `screens[].id` thì đó là màn), chỉ
 *  node quyết định/kết thúc mới khai tường minh. Khai lại tối thiểu ở đây để
 *  module này không phải import ngược SpecFlowCanvas (vòng import). */
export interface FlowLikeDoc {
  id: string;
  name?: string;
  entry?: string;
  nodes?: Array<{ id: string; kind?: string; label?: string; screen?: string }>;
  edges?: Array<{ from?: string; to?: string; label?: string }>;
}

/** Đưa `.flow.json` (bước ux) về đúng hình dạng `.flowchart.json` để dùng CHUNG
 *  bộ chẻ kịch bản. Màn hình ngầm định thành node `action` mang TÊN màn (tra
 *  theo `screenTitles`, không có thì lấy chính id); `entry` thành `start` để
 *  đường đi bắt đầu đúng chỗ. */
export function flowDocToChart(
  flow: FlowLikeDoc,
  screenTitles: Record<string, string> = {},
): FlowchartDoc {
  const declared = new Map((flow.nodes ?? []).map((n) => [n.id, n]));
  const edges = (flow.edges ?? [])
    .filter((e): e is { from: string; to: string; label?: string } => Boolean(e.from && e.to))
    .map((e) => ({ from: e.from, to: e.to, ...(e.label ? { label: e.label } : {}) }));

  const ids = new Set<string>([...declared.keys(), ...edges.flatMap((e) => [e.from, e.to])]);
  const entry = flow.entry && ids.has(flow.entry) ? flow.entry : undefined;

  const nodes: FlowchartNode[] = [...ids].map((id) => {
    const node = declared.get(id);
    const kind = node?.kind;
    const label = node?.label?.trim() || screenTitles[node?.screen ?? id] || screenTitles[id] || id;
    if (id === entry) return { id, type: 'start', label };
    if (kind === 'decision') return { id, type: 'decision', label };
    if (kind === 'end') return { id, type: 'end', label };
    return { id, type: 'action', label };
  });

  return {
    id: flow.id,
    ...(flow.name ? { title: flow.name } : {}),
    nodes,
    edges,
  };
}

export const OUTCOME_LABELS: Record<UseCaseOutcome, string> = {
  success: 'Thành công',
  blocked: 'Dừng / lỗi',
  loop: 'Quay lại bước trước',
  neutral: 'Kết thúc',
};

/** Nhãn loại cho từng khối trong khung nhìn chi tiết. */
export const STEP_KIND_LABELS: Record<FlowchartNode['type'], string> = {
  start: 'Bắt đầu',
  action: 'Bước làm',
  decision: 'Rẽ nhánh',
  end: 'Kết thúc',
};
