// ds-lab / lab-kit-scan — tiền-quét ứng viên "đóng gói comp" từ MÀN ĐÃ DỰNG
// (WP-lab-reorder, 2026-08-23 — xem .tmp/pipeline/wp-lab-reorder.yaml).
//
// Bối cảnh: từ WP này "Đề xuất kit" (lab-kit-plan) đứng SAU "Sáng tác màn"
// (lab-compose) và đổi vai trò — thay vì đoán từ docs (chưa có màn), agent
// giờ QUÉT MÀN ĐÃ DUYỆT để đề xuất comp cần đóng gói. Module này là phần
// TIỀN-QUÉT tất định daemon tự chạy TRƯỚC khi agent vào phiên: duyệt subtree
// REST (`fetchNodeSubtrees`, figma-rest.ts) của từng frame màn trong
// `lab-result.json`, tìm hai loại bằng chứng "khối nên đóng gói":
//   - `repeat`: một khối (FRAME/GROUP) có "chữ ký cấu trúc" (loại node + tập
//     hợp mô tả con/cháu) LẶP LẠI ≥2 lần — bằng chứng MẠNH nhất cho một
//     component tái sử dụng thật (card sản phẩm, hàng danh sách…).
//   - `anchor`: điểm neo thị giác lớn nhất mỗi màn (không phải khung, không
//     phải root) — khối trọng tâm dù không lặp lại vẫn đáng đóng gói vì nó
//     LÀ nội dung chính của màn.
//
// Ghi ra `kit-candidates.json` (máy đọc, agent lab-kit-plan đọc lại) +
// `kit-candidates/<id>.png` (crop, server.ts tự chụp qua fetchNodeImages) để
// agent CHỈ ĐỌC đề xuất đúng cái ĐÃ THẤY trên màn — không còn đoán từ docs.
//
// Module THUẦN: không fs/network/AI — server.ts (runLabKitPlan) là caller
// duy nhất, tự gọi fetchNodeSubtrees lấy `node` cho mỗi màn, gọi
// `scanKitCandidates` ở đây, rồi tự ghi file + crop (fail-soft TUYỆT ĐỐI:
// thiếu token/preview/lỗi quét → không có candidates, KHÔNG fail stage — xem
// runLabKitPlan). ĐƯỢC PHÉP import regex từ lab-shell.js
// (SHELL_ROLE_NODE_PATTERNS) để loại node khớp vai trò khung (app-bar/
// tabbar) khỏi ứng viên — khung màn đã có đường riêng (lab-shell.ts's
// detectShellBindings), không cần đóng gói lại qua "đề xuất kit". Tất định:
// không mạng/AI, cùng input luôn ra cùng kết quả theo đúng thứ tự duyệt cây.

import { SHELL_ROLE_NODE_PATTERNS } from './lab-shell.js';

/** File đề xuất do DAEMON tự quét (khác `kit-plan.json` — file agent lab-
 *  kit-plan tự ghi sau khi đọc file này). Một trong các output khai báo của
 *  `lab-kit-plan` trong pipelines.ts. */
export const KIT_CANDIDATES_FILE_REL = 'kit-candidates.json';

/** Thư mục chứa PNG crop của từng ứng viên — output khai báo của `lab-kit-plan`. */
export const KIT_CANDIDATES_DIR_REL = 'kit-candidates';

/** Đường dẫn (project-cwd-relative) daemon ghi PNG crop của một ứng viên vào —
 *  sanitize NGUYÊN khuôn `kitShotPngRel`/`screenPngRel`: chỉ giữ
 *  `[A-Za-z0-9._-]` để không bao giờ thoát ra ngoài `kit-candidates/`. */
export function kitCandidatePngRel(id: string): string {
  const safe = id.replace(/[^A-Za-z0-9._-]/g, '_');
  return `${KIT_CANDIDATES_DIR_REL}/${safe}.png`;
}

/** Một lần xuất hiện của một ứng viên trên MỘT màn cụ thể. */
export interface KitCandidateOccurrence {
  screenKey: string;
  nodeId: string;
  name: string;
  width?: number;
  height?: number;
}

/** Một ứng viên "nên đóng gói thành component" — do daemon TỰ QUÉT (chưa qua
 *  duyệt của người; `lab-kit-plan` đọc mảng này để đề xuất, không phải đã
 *  chốt). */
export interface KitCandidate {
  id: string;
  /** Chữ ký cấu trúc dùng để gom nhóm — chỉ để debug/kiểm tra lại, KHÔNG có
   *  ý nghĩa hiển thị cho agent. */
  signature: string;
  suggestedName: string;
  occurrences: KitCandidateOccurrence[];
  /** ≤6 mô tả con/cháu đầu (dạng `<type>:<tên chuẩn hoá>`) — tóm tắt nhanh
   *  "khối này chứa gì" mà không cần mở crop. */
  childrenSummary: string[];
  /** `true` khi ÍT NHẤT MỘT lần xuất hiện đã chứa sẵn instance base thật bên
   *  trong (gợi ý: có thể chỉ cần chuẩn hoá thay vì dựng từ đầu). */
  hasInstance: boolean;
  reason: 'repeat' | 'anchor';
}

export interface KitCandidatesFile {
  schema_version: 1;
  generatedAt: string;
  candidates: KitCandidate[];
}

const MIN_WIDTH = 120;
const MIN_HEIGHT = 40;
const MIN_CHILDREN_FOR_CANDIDATE = 2;
const MIN_CHILDREN_FOR_ANCHOR = 3;
const DEFAULT_MAX_CANDIDATES = 12;

interface ScanNode {
  id?: string;
  type?: string;
  visible?: boolean;
  name?: string;
  children?: unknown;
  absoluteBoundingBox?: { x: number; y: number; width: number; height: number };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Con TRỰC TIẾP đang hiển thị của một node ĐÃ BIẾT hiển thị (giả định gọi
 *  đúng chuỗi tổ tiên hiển thị từ ngoài vào — cùng quy ước `detectShellRolesInSubtree`). */
function visibleChildrenOf(node: ScanNode): ScanNode[] {
  return asArray(node.children).filter(
    (c): c is ScanNode => isRecord(c) && (c as ScanNode).visible !== false,
  ) as ScanNode[];
}

// normalizeName: lowercase, bỏ hậu tố "copy"/"copy 2" và số/ký tự đếm ở cuối
// (" 2", "-3", "_4"), trim — để "Card 2"/"Card copy" gộp cùng một chữ ký với
// "Card".
function normalizeName(raw: string): string {
  let s = (raw ?? '').trim().toLowerCase();
  s = s.replace(/[\s-]*copy(\s*\d+)?\s*$/i, '');
  s = s.replace(/[\s#_-]+\d+\s*$/i, '');
  return s.trim();
}

function capitalizeFirst(s: string): string {
  return s.length > 0 ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function childDescriptor(node: ScanNode): string {
  return `${node.type ?? '?'}:${normalizeName(node.name ?? '')}`;
}

/** Chữ ký cấu trúc của một node candidate: `<type>|<sorted multiset con+cháu>`
 *  — tính tới độ sâu 2 (con trực tiếp + cháu) để phân biệt hai card cùng
 *  FRAME nhưng ruột khác hẳn nhau. `descriptors` (KHÔNG sort, thứ tự duyệt
 *  tự nhiên) dùng làm `childrenSummary`. */
function computeSignature(node: ScanNode): { signature: string; descriptors: string[] } {
  const children = visibleChildrenOf(node);
  const descriptors: string[] = children.map(childDescriptor);
  for (const child of children) {
    for (const grandchild of visibleChildrenOf(child)) {
      descriptors.push(childDescriptor(grandchild));
    }
  }
  const sorted = [...descriptors].sort();
  return { signature: `${node.type ?? '?'}|${sorted.join(',')}`, descriptors };
}

function subtreeHasInstanceVisible(node: ScanNode): boolean {
  if (node.type === 'INSTANCE') return true;
  for (const child of visibleChildrenOf(node)) {
    if (subtreeHasInstanceVisible(child)) return true;
  }
  return false;
}

const CANDIDATE_NODE_TYPES = new Set(['FRAME', 'GROUP']);

function matchesShellRoleName(name: string): boolean {
  for (const re of Object.values(SHELL_ROLE_NODE_PATTERNS)) {
    if (re && re.test(name)) return true;
  }
  return false;
}

interface ScanHit {
  screenKey: string;
  nodeId: string;
  name: string;
  width?: number;
  height?: number;
  signature: string;
  childrenSummary: string[];
  hasInstance: boolean;
  childCount: number;
  area: number;
}

/** Duyệt subtree REST của TỪNG frame màn (`inputs`, mỗi phần tử là MỘT màn
 *  trong `lab-result.json` đã dựng) tìm ứng viên đóng gói. CHỈ nhánh hiển
 *  thị. Xét node FRAME/GROUP (KHÔNG INSTANCE — instance base đã là comp;
 *  KHÔNG node gốc màn); bỏ node khớp vai trò khung app-bar/tabbar theo tên
 *  (regex của lab-shell.ts — khung màn đã có đường riêng); bỏ node nhỏ
 *  (width<120 hoặc height<40) và node có <2 con hiển thị. Một node đã thành
 *  candidate → KHÔNG xét con cháu của nó làm candidate khác (dừng đệ quy
 *  ngay khi một node đủ điều kiện — tránh lồng trùng, ví dụ card và badge
 *  bên trong card không cùng lúc là hai ứng viên riêng).
 *
 *  Nhóm theo `signature` trên TOÀN BỘ màn đầu vào: nhóm ≥2 occurrence →
 *  candidate `reason: 'repeat'` (sắp xếp nhóm nhiều occurrence trước, ổn
 *  định theo thứ tự phát hiện khi bằng nhau). Sau đó, với MỖI màn (theo thứ
 *  tự `inputs`), chọn node FRAME/GROUP hiển thị lớn nhất theo diện tích
 *  (không phải root/khung, ≥3 con hiển thị, CHƯA thuộc nhóm repeat) làm
 *  candidate `reason: 'anchor'` (tối đa 1/màn).
 *
 *  `maxCandidates` (mặc định 12) cắt đuôi danh sách cuối cùng (repeat trước,
 *  anchor sau) — KHÔNG lặng lẽ: caller (server.ts) tự log số bị cắt bằng
 *  cách so với một lần gọi không giới hạn (xem `runLabKitPlan`).
 *
 *  Tất định: không gọi mạng/AI, cùng input luôn ra cùng kết quả theo đúng
 *  thứ tự duyệt cây + thứ tự `inputs`. */
export function scanKitCandidates(
  inputs: readonly { screenKey: string; node: unknown }[],
  opts?: { maxCandidates?: number },
): KitCandidate[] {
  const maxCandidates = opts?.maxCandidates ?? DEFAULT_MAX_CANDIDATES;

  const hits: ScanHit[] = [];

  for (const input of inputs) {
    if (!isRecord(input.node)) continue;
    const root = input.node as ScanNode;

    const walk = (raw: unknown, parentVisible: boolean, isRoot: boolean): void => {
      if (!isRecord(raw)) return;
      const node = raw as ScanNode;
      const visible = parentVisible && node.visible !== false;
      if (!visible) return;

      if (!isRoot && CANDIDATE_NODE_TYPES.has(node.type ?? '')) {
        const name = node.name ?? '';
        const box = node.absoluteBoundingBox;
        const width = box?.width;
        const height = box?.height;
        const tooSmall = (width !== undefined && width < MIN_WIDTH) || (height !== undefined && height < MIN_HEIGHT);
        const children = visibleChildrenOf(node);
        if (!matchesShellRoleName(name) && !tooSmall && children.length >= MIN_CHILDREN_FOR_CANDIDATE) {
          const { signature, descriptors } = computeSignature(node);
          hits.push({
            screenKey: input.screenKey,
            nodeId: node.id ?? '',
            name,
            ...(width !== undefined ? { width } : {}),
            ...(height !== undefined ? { height } : {}),
            signature,
            childrenSummary: descriptors.slice(0, 6),
            hasInstance: subtreeHasInstanceVisible(node),
            childCount: children.length,
            area: (width ?? 0) * (height ?? 0),
          });
          // Đã thành candidate — không xét con cháu của nó làm candidate khác.
          return;
        }
      }

      for (const child of asArray(node.children)) walk(child, visible, false);
    };

    walk(root, true, true);
  }

  const bySignature = new Map<string, ScanHit[]>();
  for (const hit of hits) {
    const list = bySignature.get(hit.signature) ?? [];
    list.push(hit);
    bySignature.set(hit.signature, list);
  }

  const consumed = new Set<string>();
  const repeatGroups: ScanHit[][] = [];
  for (const list of bySignature.values()) {
    if (list.length >= 2) {
      repeatGroups.push(list);
      for (const h of list) consumed.add(`${h.screenKey}::${h.nodeId}`);
    }
  }
  // Nhiều occurrence trước; sort ổn định (Array#sort là stable) nên nhóm
  // bằng nhau giữ nguyên thứ tự phát hiện.
  repeatGroups.sort((a, b) => b.length - a.length);

  const anchorGroups: ScanHit[][] = [];
  for (const input of inputs) {
    const candidates = hits.filter(
      (h) =>
        h.screenKey === input.screenKey &&
        !consumed.has(`${h.screenKey}::${h.nodeId}`) &&
        h.childCount >= MIN_CHILDREN_FOR_ANCHOR,
    );
    if (candidates.length === 0) continue;
    let best = candidates[0]!;
    for (const h of candidates) {
      if (h.area > best.area) best = h;
    }
    anchorGroups.push([best]);
    consumed.add(`${best.screenKey}::${best.nodeId}`);
  }

  const buildSuggestedName = (group: ScanHit[], fallbackIndex: number): string => {
    const counts = new Map<string, number>();
    for (const h of group) {
      const n = normalizeName(h.name);
      if (!n) continue;
      counts.set(n, (counts.get(n) ?? 0) + 1);
    }
    let best: string | null = null;
    let bestCount = 0;
    for (const [n, c] of counts) {
      if (c > bestCount) {
        best = n;
        bestCount = c;
      }
    }
    return best ? capitalizeFirst(best) : `Khối ${fallbackIndex}`;
  };

  const toOccurrence = (h: ScanHit): KitCandidateOccurrence => ({
    screenKey: h.screenKey,
    nodeId: h.nodeId,
    name: h.name,
    ...(h.width !== undefined ? { width: h.width } : {}),
    ...(h.height !== undefined ? { height: h.height } : {}),
  });

  const withoutId: Omit<KitCandidate, 'id'>[] = [];
  let fallbackIndex = 1;
  for (const group of repeatGroups) {
    const first = group[0]!;
    withoutId.push({
      signature: first.signature,
      suggestedName: buildSuggestedName(group, fallbackIndex),
      occurrences: group.map(toOccurrence),
      childrenSummary: first.childrenSummary,
      hasInstance: group.some((h) => h.hasInstance),
      reason: 'repeat',
    });
    fallbackIndex += 1;
  }
  for (const group of anchorGroups) {
    const first = group[0]!;
    withoutId.push({
      signature: first.signature,
      suggestedName: buildSuggestedName(group, fallbackIndex),
      occurrences: group.map(toOccurrence),
      childrenSummary: first.childrenSummary,
      hasInstance: group.some((h) => h.hasInstance),
      reason: 'anchor',
    });
    fallbackIndex += 1;
  }

  return withoutId.slice(0, maxCandidates).map((c, i) => ({ ...c, id: `KC-${String(i + 1).padStart(2, '0')}` }));
}

/** Render bảng markdown phụ lục — nối vào cuối `kit-plan.md` khi có ứng viên
 *  daemon quét được (fallback của `renderKitPlanMd`, xem lab-kit.ts + runLabKitPlan). */
export function renderKitCandidatesMd(c: readonly KitCandidate[]): string {
  if (c.length === 0) return '';
  const header = '| Id | Tên gợi ý | Lặp × | Màn | Có instance | Lý do |\n| --- | --- | --- | --- | --- | --- |';
  const rows = c.map((cand) => {
    const screens = Array.from(new Set(cand.occurrences.map((o) => o.screenKey))).join(', ');
    return `| ${cand.id} | ${cand.suggestedName} | ${cand.occurrences.length} | ${screens} | ${cand.hasInstance ? '✓' : '✗'} | ${cand.reason} |`;
  });
  return ['', '## Ứng viên daemon quét được (kit-candidates.json)', '', header, ...rows, ''].join('\n');
}
