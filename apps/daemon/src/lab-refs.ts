// ds-lab / lab-refs — "Reference concept": người dùng dán 1..N link Figma
// (PAGE — "Copy link to page", HOẶC SELECTION — "Copy link to selection" của
// một frame/section/component/component_set/instance); daemon verify + quét
// thành danh sách CONCEPT màn (tên + PNG thumbnail + structure.json cây bố
// cục) để bước "Bản đồ màn" (lab-map) map concept ↔ màn, rồi "Sáng tác màn"
// (lab-compose) dựng THEO cấu trúc thật của concept đã map (xem
// `.tmp/pipeline/wp-lab-refs-daemon.yaml` — quyết định người dùng 24/08 qua
// AskUserQuestion — và `.tmp/pipeline/wp-lab-refs-v2-daemon.yaml` — 4 gap lộ
// ra khi test trên file prod thật: link frame bị từ chối, frame rác chiếm cap
// theo thứ tự tài liệu, warnings PUT-only không lưu, brief chỉ có ảnh khiến
// agent phải "đoán cấu trúc" từ mockup).
//
// Module này chứa phần THUẦN test-được (parse/detect/lọc/rút gọn cây) + fs
// boundary hẹp (đọc/ghi `refs/refs.json`, tải PNG, ghi structure.json) — cùng
// khuôn `figma-build.ts`'s docblock ("pure ... except the two preview-config
// helpers"): mọi hàm ở đây hoặc thuần hoặc fs/network có giới hạn rõ ràng
// (readLabRefs/writeLabRefs/scanLabRefs). figma-build-routes.ts
// (registerFigmaBuildRoutes) sở hữu lớp HTTP.
//
// `refs/` SỐNG NGOÀI `outputs` của mọi stage trong pipelines.ts (tiền lệ
// `patterns/`, `.figma-preview.json`) — không phải sản phẩm của MỘT lần chạy
// stage, phải sống sót "Chạy lại".

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { describeFigmaError, fetchNodeImages, fetchNodeSubtrees, type FigmaRestDeps } from './figma-rest.js';

/** Thư mục PNG thumbnail + structure.json của các concept — CỐ Ý ngoài
 *  `outputs` (xem docblock đầu file). */
export const LAB_REFS_DIR_REL = 'refs';

/** Registry máy đọc — nguồn sự thật của danh sách trang/concept đã quét. */
export const LAB_REFS_FILE_REL = 'refs/refs.json';

/** Loại node mà một link trỏ tới — 'page' cho link "Copy link to page" cũ;
 *  bốn loại còn lại cho link "Copy link to selection". Web dùng field này để
 *  hiển thị badge trên mỗi dòng link đã quét. */
export type RefsNodeKind = 'page' | 'frame' | 'section' | 'component' | 'component_set' | 'instance';

/** Một link đã quét — `ok:false` khi link hỏng, node không phải page/frame/
 *  section, hoặc REST lỗi (403/404/…, `detail` qua `describeFigmaError`). */
export interface RefsPageRow {
  url: string;
  fileKey: string;
  nodeId: string;
  /** Tên node (Figma node's `name`) — vắng khi `ok:false` trước khi daemon
   *  đọc được node. */
  name?: string;
  ok: boolean;
  detail?: string;
  /** Loại node được link trỏ tới — chỉ có khi daemon xác định được type (tức
   *  `ok:true`, hoặc `ok:false` vì lý do khác việc type không xác định). */
  kind?: RefsNodeKind;
  /** "WxH" của CHÍNH node được chọn — chỉ có ở selection link (kind khác
   *  'page'; trang không có kích thước hữu ích để hiển thị). */
  size?: string;
}

/** Một concept màn — `png` rỗng khi ảnh lỗi (fail-soft, xem `scanLabRefs`'s
 *  docblock), KHÔNG làm mất concept. */
export interface RefsConcept {
  /** `<fileKey>:<nodeId>` — khoá ổn định để lab-map's `reference.conceptId`
   *  và lab-compose trỏ lại đúng concept. */
  id: string;
  fileKey: string;
  nodeId: string;
  name: string;
  /** `refs/<slug>.png`, tương đối từ `labCwd` — rỗng khi tải ảnh thất bại. */
  png: string;
  /** `refs/<slug>.structure.json`, tương đối từ `labCwd` — cây bố cục rút gọn
   *  (xem `buildConceptStructure`), LUÔN có (dựng từ subtree ĐÃ fetch để lấy
   *  candidate này, không gọi thêm API — khác `png` không thể fail-soft rỗng
   *  vì đây không phụ thuộc mạng). */
  structure: string;
  width?: number;
  height?: number;
}

export interface RefsFile {
  schema_version: 1;
  /** Vắng mặt cho tới lần `scanLabRefs` đầu tiên (route GET trả về registry
   *  "chưa quét lần nào" mà không có field này — xem `readLabRefs`). */
  scannedAt?: string;
  pages: RefsPageRow[];
  concepts: RefsConcept[];
  /** Toàn bộ warning của lượt quét gần nhất (cap vượt trần, frame bị lọc, lỗi
   *  ảnh…) — trước WP-lab-refs-v2 warnings chỉ có trong response PUT, KHÔNG
   *  lưu (sự cố 40/40 png:"" ngày 24/08: sau khi PUT trả lời xong, không còn
   *  dấu vết chẩn đoán nào). File CŨ không có field này → `[]` khi đọc
   *  (KHÔNG coi là hỏng, xem `readLabRefs`). */
  warnings: string[];
}

function defaultRefsFile(): RefsFile {
  return { schema_version: 1, pages: [], concepts: [], warnings: [] };
}

// ── parseFigmaPageLink ───────────────────────────────────────────────────

export interface ParsedFigmaPageLink {
  fileKey: string;
  nodeId: string;
  url: string;
}

/** Parse MỘT link `figma.com/design|file/<fileKey>/...?node-id=<a>-<b>` —
 *  khác `parseFigmaPreviewLink` (figma-build.ts): hàm đó VỨT `node-id` (chỉ
 *  cần fileKey của file preview); hàm này GIỮ `node-id` (chuyển `a-b` →
 *  `a:b`, dạng id node Figma thường) vì mục đích ở đây là trỏ ĐÚNG một node cụ
 *  thể (page HOẶC selection — xem `detectConceptsFromNode`), không phải cả
 *  file. Thiếu `node-id`, `node-id` sai dạng, hoặc không phải link Figma →
 *  `null` — cả "Copy link to page" lẫn "Copy link to selection" của Figma LUÔN
 *  kèm `node-id`, nên thiếu nó nghĩa là người dùng dán nhầm loại link (link
 *  file gốc, hoặc link không phải Figma). Thuần — không fs/network. */
export function parseFigmaPageLink(raw: string): ParsedFigmaPageLink | null {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (!['figma.com', 'www.figma.com'].includes(parsed.hostname.toLowerCase())) return null;
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (!['design', 'file'].includes(parts[0] ?? '') || !/^[A-Za-z0-9]+$/.test(parts[1] ?? '')) return null;
  const fileKey = parts[1]!;
  const nodeIdRaw = parsed.searchParams.get('node-id');
  if (!nodeIdRaw) return null;
  const match = /^(\d+)-(\d+)$/.exec(nodeIdRaw.trim());
  if (!match) return null;
  const nodeId = `${match[1]}:${match[2]}`;
  return { fileKey, nodeId, url: `https://www.figma.com/design/${fileKey}/?node-id=${match[1]}-${match[2]}` };
}

// ── isScreenLikeCandidate / detectConceptsFromNode ──────────────────────

const CONCEPT_NODE_TYPES = new Set(['FRAME', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE']);

/** Cap "concept/trang" — vượt quá (SAU khi lọc hình học, xem
 *  `isScreenLikeCandidate`) → chỉ giữ 60 đầu (theo đúng thứ tự `children` của
 *  Figma), kèm cảnh báo (xem `detectConceptsFromNode`). Nâng từ 40 → 60
 *  (WP-lab-refs-v2): với bộ lọc hình học đã loại rác, 60 đủ chỗ cho các page
 *  nhiều màn thật mà không cần cap đá bay màn hợp lệ. */
const MAX_CONCEPTS_PER_PAGE = 60;

export interface DetectedConcept {
  nodeId: string;
  name: string;
  width?: number;
  height?: number;
}

export interface DetectConceptsResult {
  ok: boolean;
  /** Chỉ có khi `ok:false` — node truyền vào không phải page/frame/section
   *  (hoặc `null`). */
  detail?: string;
  candidates: DetectedConcept[];
  /** Một hoặc hai mẩu tin nối bằng " | ": "đã loại N frame..." (bộ lọc hình
   *  học loại ≥1 candidate) và/hoặc "trang X có N frame, chỉ lấy 60 đầu" (vượt
   *  cap). Vắng mặt khi không mẩu nào áp dụng. */
  warning?: string;
}

function isVisibleNode(node: Record<string, unknown>): boolean {
  return node.visible !== false;
}

function toDetectedConcept(node: Record<string, unknown>): DetectedConcept | null {
  const nodeId = typeof node.id === 'string' ? node.id : '';
  const name = typeof node.name === 'string' ? node.name : '';
  if (!nodeId || !name) return null;
  const box =
    node.absoluteBoundingBox && typeof node.absoluteBoundingBox === 'object'
      ? (node.absoluteBoundingBox as Record<string, unknown>)
      : null;
  const width = box && typeof box.width === 'number' ? box.width : undefined;
  const height = box && typeof box.height === 'number' ? box.height : undefined;
  return { nodeId, name, ...(width !== undefined ? { width } : {}), ...(height !== undefined ? { height } : {}) };
}

/** Lọc frame "rác" bằng hình học THUẦN (KHÔNG dùng tên node) — mô phỏng trên
 *  page thật 76-frame ([SDK] SIM Giá Rẻ Copy, 4:147, 24/08): 20 frame rác
 *  (utility-section ngang 2550–10348×132, utility-flow 515×72, utility-note
 *  390×148, icon 20×20) lẫn với 56 màn thật (đều 390px rộng, cao 300–1900px).
 *  Ba luật loại: (1) thiếu bbox/width/height, (2) `min(w,h) < 100` — icon/
 *  instance nhỏ, (3) `w/h > 3` — dải ngang utility-section, (4) `h < 300` —
 *  utility-flow/utility-note thấp. Đo thật: KEEP 56/56 màn thật, loại 20/20
 *  rác — không một trường hợp sai. */
export function isScreenLikeCandidate(node: Record<string, unknown>): boolean {
  const box =
    node.absoluteBoundingBox && typeof node.absoluteBoundingBox === 'object'
      ? (node.absoluteBoundingBox as Record<string, unknown>)
      : null;
  const width = box && typeof box.width === 'number' ? box.width : undefined;
  const height = box && typeof box.height === 'number' ? box.height : undefined;
  if (width === undefined || height === undefined) return false;
  if (Math.min(width, height) < 100) return false;
  if (width / height > 3) return false;
  if (height < 300) return false;
  return true;
}

/** Candidate nội bộ mang theo raw node (để `scanLabRefs` dựng structure.json
 *  từ subtree ĐÃ fetch, không cần fetch lại) — KHÔNG lộ ra `DetectedConcept`
 *  công khai. */
interface DetectedConceptInternal extends DetectedConcept {
  rawNode: Record<string, unknown>;
}

function collectCandidate(
  node: Record<string, unknown>,
  applyFilter: boolean,
  filteredOutCounter: { count: number },
): DetectedConceptInternal | null {
  if (applyFilter && !isScreenLikeCandidate(node)) {
    filteredOutCounter.count++;
    return null;
  }
  const base = toDetectedConcept(node);
  if (!base) return null;
  return { ...base, rawNode: node };
}

/** Bản nội bộ của `detectConceptsFromNode` — giữ `rawNode` cho `scanLabRefs`.
 *  Hành vi theo `node.type`:
 *  - CANVAS (page): children cấp đỉnh + con trực tiếp của SECTION là
 *    candidate — MỌI candidate qua bộ lọc `isScreenLikeCandidate`.
 *  - FRAME|COMPONENT|COMPONENT_SET|INSTANCE (selection link trỏ thẳng vào
 *    concept): CHÍNH node đó là 1 concept duy nhất — người dùng đã chọn đích
 *    danh, KHÔNG qua bộ lọc.
 *  - SECTION (selection link trỏ vào một nhóm): các con trực tiếp thuộc 4
 *    type trên là candidate — QUA bộ lọc (cùng luật CANVAS).
 *  - node khác/`null`: `ok:false`.
 *  Node ẩn (`visible === false`) bị bỏ ở MỌI nhánh duyệt con (không áp dụng
 *  cho chính node được chọn trực tiếp — người dùng đã chọn nó). */
function detectConceptsFromNodeInternal(nodeInput: unknown): {
  ok: boolean;
  detail?: string;
  candidates: DetectedConceptInternal[];
  warning?: string;
} {
  const node = nodeInput && typeof nodeInput === 'object' ? (nodeInput as Record<string, unknown>) : null;
  if (!node) return { ok: false, detail: 'link không trỏ vào page/frame/section', candidates: [] };

  const type = typeof node.type === 'string' ? node.type : '';
  const filteredOut = { count: 0 };
  let out: DetectedConceptInternal[] = [];

  if (type === 'CANVAS') {
    const children = Array.isArray(node.children) ? (node.children as unknown[]) : [];
    for (const rawChild of children) {
      const child = rawChild && typeof rawChild === 'object' ? (rawChild as Record<string, unknown>) : null;
      if (!child || !isVisibleNode(child)) continue;
      if (child.type === 'SECTION') {
        const grandChildren = Array.isArray(child.children) ? (child.children as unknown[]) : [];
        for (const rawGrand of grandChildren) {
          const grand = rawGrand && typeof rawGrand === 'object' ? (rawGrand as Record<string, unknown>) : null;
          if (!grand || !isVisibleNode(grand)) continue;
          if (!CONCEPT_NODE_TYPES.has(String(grand.type))) continue;
          const candidate = collectCandidate(grand, true, filteredOut);
          if (candidate) out.push(candidate);
        }
        continue;
      }
      if (!CONCEPT_NODE_TYPES.has(String(child.type))) continue;
      const candidate = collectCandidate(child, true, filteredOut);
      if (candidate) out.push(candidate);
    }
  } else if (CONCEPT_NODE_TYPES.has(type)) {
    const candidate = collectCandidate(node, false, filteredOut);
    if (candidate) out.push(candidate);
  } else if (type === 'SECTION') {
    const children = Array.isArray(node.children) ? (node.children as unknown[]) : [];
    for (const rawChild of children) {
      const child = rawChild && typeof rawChild === 'object' ? (rawChild as Record<string, unknown>) : null;
      if (!child || !isVisibleNode(child)) continue;
      if (!CONCEPT_NODE_TYPES.has(String(child.type))) continue;
      const candidate = collectCandidate(child, true, filteredOut);
      if (candidate) out.push(candidate);
    }
  } else {
    return { ok: false, detail: 'link không trỏ vào page/frame/section', candidates: [] };
  }

  const nodeName = typeof node.name === 'string' && node.name.trim() ? node.name.trim() : '(không tên)';
  const messages: string[] = [];
  if (filteredOut.count > 0) {
    messages.push(`trang ${nodeName}: đã loại ${filteredOut.count} frame không giống màn (dải ngang/icon/ghi chú)`);
  }
  let candidates = out;
  if (out.length > MAX_CONCEPTS_PER_PAGE) {
    candidates = out.slice(0, MAX_CONCEPTS_PER_PAGE);
    messages.push(`trang ${nodeName} có ${out.length} frame, chỉ lấy ${MAX_CONCEPTS_PER_PAGE} đầu`);
  }
  return { ok: true, candidates, ...(messages.length > 0 ? { warning: messages.join(' | ') } : {}) };
}

/** Từ MỘT node đã fetch (`fetchNodeSubtrees`, khoá theo chính `nodeId` của
 *  link) → danh sách concept. Xem `detectConceptsFromNodeInternal`'s docblock
 *  cho hành vi theo `node.type`. Thuần — không fs/network. */
export function detectConceptsFromNode(nodeDoc: unknown): DetectConceptsResult {
  const result = detectConceptsFromNodeInternal(nodeDoc);
  return {
    ok: result.ok,
    ...(result.detail !== undefined ? { detail: result.detail } : {}),
    candidates: result.candidates.map(({ rawNode: _rawNode, ...rest }) => rest),
    ...(result.warning !== undefined ? { warning: result.warning } : {}),
  };
}

/** Alias tương thích ngược — tên cũ trước WP-lab-refs-v2 (khi mọi link chỉ có
 *  thể là link PAGE/CANVAS). Hành vi giờ tổng quát hơn (xem
 *  `detectConceptsFromNode`), nhưng với input CANVAS thì y hệt trước. */
export const detectConceptsFromPage = detectConceptsFromNode;

// ── structure.json — cây bố cục rút gọn ─────────────────────────────────

/** Depth tối đa của cây bố cục rút gọn (gốc = depth 1) — vượt trần → cắt cành
 *  + `truncated:true` ở node bị cắt (xem `buildConceptStructure`). */
export const STRUCTURE_MAX_DEPTH = 6;

/** Tổng số node tối đa/concept — đo thật: màn trung bình 344 node/sâu 14 →
 *  sau trim còn ~100-150 node (~20KB/màn), đủ chi tiết cho lab-compose đối
 *  chiếu mà không phình brief. */
export const STRUCTURE_MAX_NODES = 400;

/** Số ký tự tối đa giữ lại của `characters` một node TEXT. */
export const STRUCTURE_TEXT_MAX_CHARS = 120;

export interface ConceptStructureNode {
  type: string;
  name: string;
  w: number;
  h: number;
  layoutMode?: string;
  itemSpacing?: number;
  /** 4 cạnh gộp "top right bottom left" — chỉ có khi ÍT NHẤT một cạnh padding
   *  được Figma trả về (auto-layout). */
  padding?: string;
  /** Chỉ có ở node TEXT — `characters`, cắt còn `STRUCTURE_TEXT_MAX_CHARS`
   *  ký tự. */
  text?: string;
  children?: ConceptStructureNode[];
  /** `true` khi cây con của CHÍNH node này bị cắt vì vượt `STRUCTURE_MAX_DEPTH`
   *  hoặc `STRUCTURE_MAX_NODES` — KHÔNG áp dụng cho INSTANCE/COMPONENT/
   *  COMPONENT_SET không phải gốc (không đi sâu là chủ đích, không phải bị
   *  cắt vì vượt trần). */
  truncated?: true;
}

function paddingOf(node: Record<string, unknown>): string | undefined {
  const sides = [node.paddingTop, node.paddingRight, node.paddingBottom, node.paddingLeft];
  if (!sides.some((v) => typeof v === 'number')) return undefined;
  const n = (v: unknown) => (typeof v === 'number' ? Math.round(v) : 0);
  return `${n(sides[0])} ${n(sides[1])} ${n(sides[2])} ${n(sides[3])}`;
}

/** Đệ quy rút gọn subtree Figma ĐÃ fetch (không gọi thêm API) thành cây bố
 *  cục nhỏ gọn — nguồn cấu trúc thật cho lab-compose (thay vì agent "nhìn ảnh
 *  đoán cấu trúc"). Giữ {type, name, w, h, layoutMode?, itemSpacing?,
 *  padding?, text? (chỉ TEXT), children?} — bỏ mọi field khác (fill/stroke/
 *  effect/constraint… không cần thiết để dựng lại bố cục).
 *
 *  INSTANCE/COMPONENT/COMPONENT_SET KHÔNG đi sâu vào con — chỉ dừng ở "hết
 *  các tầng comp" (đo thật: ruột instance status-bar toàn RECTANGLE/VECTOR
 *  pin/sóng, vô nghĩa với việc dựng lại; data này chỉ dùng làm concept LAYOUT
 *  của màn, agent sẽ đặt instance/component DS tương đương thay vì tái tạo
 *  ruột — tên + kích thước là đủ). NGOẠI LỆ DUY NHẤT: node GỐC của cả cây
 *  (depth 1) — nếu chính concept là một comp (link frame trỏ thẳng một
 *  COMPONENT/INSTANCE), gốc vẫn được mở con, nếu không cây chỉ có đúng 1 node
 *  và vô dụng.
 *
 *  `STRUCTURE_MAX_DEPTH`/`STRUCTURE_MAX_NODES`: vượt trần → cắt cành (không
 *  throw — một concept quá phức tạp không được làm hỏng cả lượt quét) và đánh
 *  dấu `truncated:true` ở ĐÚNG node bị cắt. Thuần — không fs/network. */
export function buildConceptStructure(rawNode: unknown): ConceptStructureNode | null {
  let nodeCount = 0;
  const COMP_TYPES = new Set(['INSTANCE', 'COMPONENT', 'COMPONENT_SET']);

  function build(raw: unknown, depth: number): ConceptStructureNode | null {
    const n = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
    if (!n) return null;
    nodeCount++;

    const box =
      n.absoluteBoundingBox && typeof n.absoluteBoundingBox === 'object'
        ? (n.absoluteBoundingBox as Record<string, unknown>)
        : null;
    const w = box && typeof box.width === 'number' ? Math.round(box.width) : 0;
    const h = box && typeof box.height === 'number' ? Math.round(box.height) : 0;
    const type = typeof n.type === 'string' ? n.type : 'UNKNOWN';
    const name = typeof n.name === 'string' ? n.name : '';

    const out: ConceptStructureNode = { type, name, w, h };
    if (typeof n.layoutMode === 'string' && n.layoutMode !== 'NONE') out.layoutMode = n.layoutMode;
    if (typeof n.itemSpacing === 'number') out.itemSpacing = n.itemSpacing;
    const padding = paddingOf(n);
    if (padding) out.padding = padding;
    if (type === 'TEXT' && typeof n.characters === 'string' && n.characters) {
      out.text = n.characters.slice(0, STRUCTURE_TEXT_MAX_CHARS);
    }

    // INSTANCE/COMPONENT/COMPONENT_SET: chủ đích không đi sâu (xem docblock
    // hàm) — TRỪ khi đây chính là node gốc của cây (depth 1: concept chính là
    // một comp, mở con thì cây mới không chỉ có 1 node).
    if (COMP_TYPES.has(type) && depth > 1) return out;

    const children = Array.isArray(n.children) ? (n.children as unknown[]) : [];
    if (children.length === 0) return out;
    if (depth >= STRUCTURE_MAX_DEPTH) {
      out.truncated = true;
      return out;
    }

    const built: ConceptStructureNode[] = [];
    let cut = false;
    for (const child of children) {
      if (nodeCount >= STRUCTURE_MAX_NODES) {
        cut = true;
        break;
      }
      const builtChild = build(child, depth + 1);
      if (builtChild) built.push(builtChild);
    }
    if (built.length > 0) out.children = built;
    if (cut) out.truncated = true;
    return out;
  }

  return build(rawNode, 1);
}

// ── refs/<slug>.png / <slug>.structure.json path ────────────────────────

/** Slug ổn định `<fileKey>-<nodeId>` (`:` → `-`), lọc còn ký tự an toàn cho
 *  tên file — dùng cho tên PNG, tên structure.json, lẫn việc dọn file cũ khi
 *  quét lại. */
export function conceptSlug(fileKey: string, nodeId: string): string {
  return `${fileKey}-${nodeId}`.replace(/[^A-Za-z0-9_-]/g, '-');
}

/** Đường dẫn PNG của một concept, tương đối từ `labCwd`. */
export function conceptPngRel(fileKey: string, nodeId: string): string {
  return `${LAB_REFS_DIR_REL}/${conceptSlug(fileKey, nodeId)}.png`;
}

/** Đường dẫn structure.json của một concept, tương đối từ `labCwd` — cạnh
 *  PNG, cùng slug. */
export function conceptStructureRel(fileKey: string, nodeId: string): string {
  return `${LAB_REFS_DIR_REL}/${conceptSlug(fileKey, nodeId)}.structure.json`;
}

// ── readLabRefs / writeLabRefs (fail-soft) ──────────────────────────────

/** Đọc `refs/refs.json`. File thiếu, JSON hỏng, hoặc thiếu `pages`/`concepts`
 *  (không phải mảng) → registry rỗng mặc định (`{schema_version:1, pages:[],
 *  concepts:[], warnings:[]}`, KHÔNG có `scannedAt` — route GET dùng nguyên
 *  giá trị này cho dự án "chưa quét lần nào"). `warnings` thiếu/không phải
 *  mảng (file ghi TRƯỚC WP-lab-refs-v2) → `[]`, KHÔNG coi cả file là hỏng.
 *  Không bao giờ throw. */
export async function readLabRefs(labCwd: string): Promise<RefsFile> {
  try {
    const raw = await fs.promises.readFile(path.join(labCwd, LAB_REFS_FILE_REL), 'utf8');
    const parsed = JSON.parse(raw) as Partial<RefsFile> | null;
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.pages) || !Array.isArray(parsed.concepts)) {
      return defaultRefsFile();
    }
    return {
      schema_version: 1,
      ...(typeof parsed.scannedAt === 'string' ? { scannedAt: parsed.scannedAt } : {}),
      pages: parsed.pages as RefsPageRow[],
      concepts: parsed.concepts as RefsConcept[],
      warnings: Array.isArray(parsed.warnings) ? (parsed.warnings as string[]) : [],
    };
  } catch {
    return defaultRefsFile();
  }
}

/** Ghi đè `refs/refs.json` (atomic: tmp → rename, cùng khuôn
 *  `writeFigmaPreviewConfig`). Fail-soft: lỗi ghi chỉ nuốt, KHÔNG throw — một
 *  lượt quét vẫn coi là thành công về mặt dữ liệu trả cho caller (route trả
 *  `refs` đã tính trong bộ nhớ) dù việc BỀN xuống đĩa thất bại. */
export async function writeLabRefs(labCwd: string, refs: RefsFile): Promise<void> {
  try {
    await fs.promises.mkdir(path.join(labCwd, LAB_REFS_DIR_REL), { recursive: true });
    const target = path.join(labCwd, LAB_REFS_FILE_REL);
    const tmp = `${target}.${randomUUID()}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify(refs, null, 2), 'utf8');
    await fs.promises.rename(tmp, target);
  } catch {
    // fail-soft, xem docblock.
  }
}

async function downloadConceptPng(fetchImpl: typeof fetch, url: string, destPath: string): Promise<boolean> {
  try {
    const res = await fetchImpl(url);
    if (!res.ok) return false;
    const buf = Buffer.from(await res.arrayBuffer());
    await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
    await fs.promises.writeFile(destPath, buf);
    return true;
  } catch {
    return false;
  }
}

/** Ghi `refs/<slug>.structure.json` — fail-soft (lỗi ghi chỉ nuốt, không làm
 *  hỏng cả lượt quét vì một concept không ghi được structure). */
async function writeConceptStructure(labCwd: string, rel: string, structure: ConceptStructureNode | null): Promise<void> {
  try {
    const dest = path.join(labCwd, rel);
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    await fs.promises.writeFile(dest, JSON.stringify(structure ?? {}, null, 2), 'utf8');
  } catch {
    // fail-soft, xem docblock.
  }
}

/** Xoá mọi `refs/*.png` và `refs/*.structure.json` không còn trong
 *  `keepSlugs` (dọn file mồ côi khi quét lại đè toàn bộ danh sách link).
 *  Fail-soft — thư mục thiếu/không đọc được → coi như không có gì để dọn. */
async function cleanupStaleConceptFiles(labCwd: string, keepSlugs: ReadonlySet<string>): Promise<void> {
  const dir = path.join(labCwd, LAB_REFS_DIR_REL);
  const entries = await fs.promises.readdir(dir).catch(() => [] as string[]);
  for (const entry of entries) {
    const lower = entry.toLowerCase();
    let slug: string | null = null;
    if (lower.endsWith('.structure.json')) slug = entry.slice(0, -'.structure.json'.length);
    else if (lower.endsWith('.png')) slug = entry.slice(0, -'.png'.length);
    if (!slug) continue;
    if (keepSlugs.has(slug)) continue;
    await fs.promises.rm(path.join(dir, entry), { force: true }).catch(() => undefined);
  }
}

function pageDocName(pageDoc: unknown): string {
  const node = pageDoc && typeof pageDoc === 'object' ? (pageDoc as Record<string, unknown>) : null;
  return typeof node?.name === 'string' ? node.name.trim() : '';
}

/** `node.type` → `RefsNodeKind` cho `RefsPageRow.kind` — `undefined` khi type
 *  không thuộc tập page/frame/section/component/component_set/instance
 *  (trường hợp `ok:false` vì type lạ, `detectConceptsFromNode` đã từ chối). */
function nodeKind(type: unknown): RefsNodeKind | undefined {
  switch (type) {
    case 'CANVAS': return 'page';
    case 'FRAME': return 'frame';
    case 'SECTION': return 'section';
    case 'COMPONENT': return 'component';
    case 'COMPONENT_SET': return 'component_set';
    case 'INSTANCE': return 'instance';
    default: return undefined;
  }
}

/** `kind` + `size` ("WxH") của một `RefsPageRow` — `size` chỉ có ở selection
 *  link (kind khác 'page'). */
function pageRowKindAndSize(pageDoc: unknown): { kind?: RefsNodeKind; size?: string } {
  const node = pageDoc && typeof pageDoc === 'object' ? (pageDoc as Record<string, unknown>) : null;
  const kind = nodeKind(node?.type);
  if (!kind) return {};
  if (kind === 'page') return { kind };
  const box =
    node?.absoluteBoundingBox && typeof node.absoluteBoundingBox === 'object'
      ? (node.absoluteBoundingBox as Record<string, unknown>)
      : null;
  const width = box && typeof box.width === 'number' ? Math.round(box.width) : undefined;
  const height = box && typeof box.height === 'number' ? Math.round(box.height) : undefined;
  return width !== undefined && height !== undefined ? { kind, size: `${width}x${height}` } : { kind };
}

async function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Số id/lần gọi `fetchNodeImages` trong `fetchImagesInChunks` — export để
 *  test. Đo thật trên page prod 56 concept (24/08): 56 id chia 2 batch theo
 *  `NODES_BATCH_SIZE` (40, figma-rest.ts) → batch 40 id render FRESH ở
 *  scale 2 vượt `REQUEST_TIMEOUT_MS` (30s, figma-rest.ts) → `figmaGet` THROW
 *  cả request; retry đổi scale 1 (WP-lab-refs-v2 mục A.6 gốc) VẪN 40
 *  id/call → VẪN timeout → 0/56 ảnh, đúng triệu chứng "40/40 png rỗng" người
 *  dùng gặp. Retry đổi scale KHÔNG đủ vì nút thắt là KÍCH THƯỚC batch, không
 *  phải scale — 10 id/call giữ mỗi request dưới ngưỡng timeout. */
export const IMAGE_CHUNK_SIZE = 10;

/** Một chunk (≤`IMAGE_CHUNK_SIZE` id) không lấy được ảnh sau CẢ hai lần thử. */
interface FailedImageChunk {
  nodeIds: string[];
  error: unknown;
}

/** Chia `nodeIds` thành các chunk `IMAGE_CHUNK_SIZE` id, gọi `fetchNodeImages`
 *  RIÊNG từng chunk (chunk nhỏ → mỗi request nằm dưới timeout, một chunk chậm/
 *  lỗi không kéo timeout toàn bộ lượt render — xem `IMAGE_CHUNK_SIZE`'s
 *  docblock cho số đo thật). Mỗi chunk: thử scale 2 → THROW → chờ 2s → thử
 *  lại scale 1 → vẫn THROW thì GHI NHẬN chunk đó fail (đưa vào
 *  `failedChunks`, KHÔNG throw ra ngoài) và ĐI TIẾP chunk kế tiếp — một chunk
 *  hỏng không làm mất ảnh của các chunk còn lại. Kết quả = union các map
 *  thành công của mọi chunk (id thuộc chunk fail đơn giản KHÔNG có trong map
 *  trả về — caller `scanLabRefs` tự suy "ảnh rỗng" từ đó). KHÔNG BAO GIỜ
 *  throw. */
async function fetchImagesInChunks(
  token: string,
  fileKey: string,
  nodeIds: string[],
  restDeps: FigmaRestDeps,
  sleep: (ms: number) => Promise<void>,
): Promise<{ images: Map<string, string>; failedChunks: FailedImageChunk[] }> {
  const images = new Map<string, string>();
  const failedChunks: FailedImageChunk[] = [];
  for (let start = 0; start < nodeIds.length; start += IMAGE_CHUNK_SIZE) {
    const chunk = nodeIds.slice(start, start + IMAGE_CHUNK_SIZE);
    try {
      const result = await fetchNodeImages(token, fileKey, chunk, restDeps, { scale: 2 });
      for (const [id, url] of result) images.set(id, url);
      continue;
    } catch {
      // scale 2 thất bại cho CHUNK này — thử lại scale 1 sau 2s (xem docblock
      // hàm), KHÔNG phải cho toàn bộ nodeIds.
    }
    await sleep(2000);
    try {
      const result = await fetchNodeImages(token, fileKey, chunk, restDeps, { scale: 1 });
      for (const [id, url] of result) images.set(id, url);
    } catch (err) {
      failedChunks.push({ nodeIds: chunk, error: err });
    }
  }
  return { images, failedChunks };
}

export interface ScanLabRefsDeps {
  /** Mặc định `globalThis.fetch` — override trong test để mock cả REST
   *  (qua `fetchNodeSubtrees`/`fetchNodeImages`) lẫn tải PNG (URL S3 giả). */
  fetch?: typeof fetch;
  now?: () => Date;
  /** Mặc định `setTimeout`-based sleep — override trong test để bỏ qua chờ
   *  2s thật của `fetchImagesInChunks`. */
  sleep?: (ms: number) => Promise<void>;
}

/** Quét TOÀN BỘ link người dùng dán, ghi đè `refs/refs.json` — nguồn sự thật
 *  DUY NHẤT sau mỗi lần quét (không merge với lần trước): mỗi link → parse
 *  (hỏng → page row `ok:false`, KHÔNG throw) → `fetchNodeSubtrees` một node
 *  (page/frame/section) → `detectConceptsFromNode` → `fetchImagesInChunks`
 *  cho các concept (theo `fileKey`, chia `IMAGE_CHUNK_SIZE` id/lần — xem
 *  docblock hằng số đó cho số đo thật khiến cần chunk thay vì chỉ đổi scale)
 *  → TẢI PNG về `refs/<slug>.png` NGAY (URL Figma trả về là S3 pre-signed,
 *  sống ngắn — không thể chỉ lưu URL) + ghi `refs/<slug>.structure.json` (từ
 *  subtree ĐÃ fetch, không gọi thêm API). Ảnh lỗi → GIỮ concept, `png` rỗng:
 *  một chunk fail cả hai lần thử → MỘT warning nêu số ảnh của chunk đó (không
 *  phải 1 warning/concept — tránh spam khi cả trang render lỗi), một id đơn
 *  lẻ thiếu URL dù chunk của nó fetch thành công (Figma trả `null` — node bị
 *  khoá/xoá) → warning riêng cho concept đó (giữ nguyên khuôn cũ). REST lỗi
 *  (403/404/mạng…) ở tầng node → page row `ok:false`, `detail` qua
 *  `describeFigmaError` — KHÔNG BAO GIỜ throw ra ngoài vì một link hỏng, để
 *  các link còn lại trong cùng lượt vẫn được quét. Dọn mọi PNG/structure.json
 *  cũ không còn trong danh sách concept mới (quét lại = đè hoàn toàn, không
 *  phải merge). `warnings` được LƯU vào `refs.json.warnings` (KHÔNG chỉ trả
 *  về response PUT — sự cố 40/40 png:"" ngày 24/08 xảy ra vì trước đây
 *  warnings chỉ sống trong response, không có dấu vết chẩn đoán sau đó). */
export async function scanLabRefs(opts: {
  labCwd: string;
  links: readonly string[];
  token: string;
  deps?: ScanLabRefsDeps;
}): Promise<{ refs: RefsFile; warnings: string[] }> {
  const fetchImpl = opts.deps?.fetch ?? fetch;
  const sleepImpl = opts.deps?.sleep ?? defaultSleep;
  const restDeps: FigmaRestDeps = { fetch: fetchImpl };
  const warnings: string[] = [];
  const pages: RefsPageRow[] = [];
  const concepts: RefsConcept[] = [];
  const keepSlugs = new Set<string>();

  for (const raw of opts.links) {
    const parsed = parseFigmaPageLink(raw);
    if (!parsed) {
      pages.push({
        url: raw,
        fileKey: '',
        nodeId: '',
        ok: false,
        detail: 'Link không hợp lệ — cần link "Copy link to page" hoặc "Copy link to selection" của Figma (có node-id).',
      });
      continue;
    }
    try {
      const subtrees = await fetchNodeSubtrees(opts.token, parsed.fileKey, [parsed.nodeId], restDeps);
      const pageDoc = subtrees.get(parsed.nodeId);
      if (!pageDoc) {
        pages.push({
          url: parsed.url,
          fileKey: parsed.fileKey,
          nodeId: parsed.nodeId,
          ok: false,
          detail: 'Không tìm thấy node — link sai hoặc node đã bị xoá.',
        });
        continue;
      }
      const detected = detectConceptsFromNodeInternal(pageDoc);
      if (!detected.ok) {
        pages.push({
          url: parsed.url,
          fileKey: parsed.fileKey,
          nodeId: parsed.nodeId,
          ok: false,
          detail: detected.detail ?? 'link không trỏ vào page/frame/section',
        });
        continue;
      }
      if (detected.warning) warnings.push(detected.warning);
      const pageName = pageDocName(pageDoc);
      pages.push({
        url: parsed.url,
        fileKey: parsed.fileKey,
        nodeId: parsed.nodeId,
        ok: true,
        ...(pageName ? { name: pageName } : {}),
        ...pageRowKindAndSize(pageDoc),
      });

      if (detected.candidates.length === 0) continue;

      // fetchImagesInChunks KHÔNG BAO GIỜ throw (xem docblock hàm) — không
      // cần try/catch ở đây nữa (khác `fetchImagesWithRetry` cũ, mục A.6 gốc:
      // batch nguyên trang timeout, throw cả hàm).
      const { images, failedChunks } = await fetchImagesInChunks(
        opts.token,
        parsed.fileKey,
        detected.candidates.map((c) => c.nodeId),
        restDeps,
        sleepImpl,
      );
      // Id thuộc một chunk fail cả hai lần thử → đã có MỘT warning gộp cho cả
      // chunk (bên dưới) — đừng thêm cảnh báo per-concept nữa (mới id thiếu
      // URL dù chunk fetch OK mới rơi vào nhánh else bên dưới).
      const chunkFailedNodeIds = new Set<string>();
      for (const failed of failedChunks) {
        for (const id of failed.nodeIds) chunkFailedNodeIds.add(id);
        warnings.push(
          `Trang "${pageName || parsed.nodeId}": ${failed.nodeIds.length} ảnh không lấy được từ Figma — ${describeFigmaError(failed.error)}`,
        );
      }

      for (const candidate of detected.candidates) {
        const conceptId = `${parsed.fileKey}:${candidate.nodeId}`;
        const slug = conceptSlug(parsed.fileKey, candidate.nodeId);
        const pngRel = conceptPngRel(parsed.fileKey, candidate.nodeId);
        const structureRel = conceptStructureRel(parsed.fileKey, candidate.nodeId);
        keepSlugs.add(slug);

        const structure = buildConceptStructure(candidate.rawNode);
        await writeConceptStructure(opts.labCwd, structureRel, structure);

        const imageUrl = images.get(candidate.nodeId);
        let png = '';
        if (imageUrl) {
          const ok = await downloadConceptPng(fetchImpl, imageUrl, path.join(opts.labCwd, pngRel));
          if (ok) png = pngRel;
          else warnings.push(`Concept "${candidate.name}" (${conceptId}): tải ảnh thất bại — giữ concept, ảnh rỗng.`);
        } else if (!chunkFailedNodeIds.has(candidate.nodeId)) {
          warnings.push(`Concept "${candidate.name}" (${conceptId}): không lấy được ảnh render từ Figma — giữ concept, ảnh rỗng.`);
        }
        concepts.push({
          id: conceptId,
          fileKey: parsed.fileKey,
          nodeId: candidate.nodeId,
          name: candidate.name,
          png,
          structure: structureRel,
          ...(candidate.width !== undefined ? { width: candidate.width } : {}),
          ...(candidate.height !== undefined ? { height: candidate.height } : {}),
        });
      }
    } catch (err) {
      pages.push({
        url: parsed.url,
        fileKey: parsed.fileKey,
        nodeId: parsed.nodeId,
        ok: false,
        detail: describeFigmaError(err),
      });
    }
  }

  await cleanupStaleConceptFiles(opts.labCwd, keepSlugs);

  const refs: RefsFile = {
    schema_version: 1,
    scannedAt: (opts.deps?.now?.() ?? new Date()).toISOString(),
    pages,
    concepts,
    warnings,
  };
  await writeLabRefs(opts.labCwd, refs);
  return { refs, warnings };
}
