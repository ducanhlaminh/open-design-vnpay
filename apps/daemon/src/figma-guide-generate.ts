// Sinh mô tả AI cho component Figma thiếu description — WP19b (SINH nội
// dung, tiếp nối hạ tầng WP19a ở figma-component-guide.ts /
// figma-catalog-routes.ts). Chỉ áp dụng cho App có
// `docsReviewComponentSource.mode === 'figma-links'` — quyết định đã chốt,
// xem `.tmp/pipeline/wp19b.yaml`.
//
// File này TÁCH hàm thuần (tính danh sách thiếu, rút gọn cây node, dựng input
// agent, validate output, merge guide — không đọc/ghi đĩa, không gọi mạng)
// khỏi phần IO ({@link generateComponentDescriptions}, orchestration: fetch
// cây/ảnh, ghi input, gọi agent qua callback tiêm vào, đọc lại output). Phần
// IO nhận DEPS tiêm từ ngoài (figma-catalog-routes.ts / server.ts) thay vì tự
// import `figma-rest.ts`/`node:fs` trực tiếp cho fetch/spawn-agent, để giữ
// khả năng test được bằng deps giả — chỉ `fs` thật cho việc ghi input/đọc lại
// output vì đó là hợp đồng file cố định với agent (skill
// `figma-comp-describe`), không cần thay thế trong test.

import fs from 'node:fs';
import path from 'node:path';

import type { FigmaCatalogProperty, FigmaComponentCatalogSnapshot } from './figma-component-catalog.js';
import { anchorFor } from './figma-component-catalog.js';
import { parseComponentsGuide, renderComponentsGuideMarkdown, type ComponentsGuideEntry } from './figma-component-guide.js';

/* ── 0. isJunkComponentName / classifyComponentKind (WP23a mục 1) ─────────
 * Người dùng chốt 2026-08-21 (`.tmp/pipeline/wp23-contract.md` mục 1): tên
 * rác (Frame 123, Vector, "123", "Property 1=Default"…) không mang đủ tín
 * hiệu cho agent tả — gửi cho agent chỉ tốn lượt và ra mô tả bịa. Daemon là
 * NGUỒN SỰ THẬT DUY NHẤT cho việc phân loại này (không lặp regex ở web) —
 * áp dụng cho MỌI component, kể cả loại 'asset'. */
const JUNK_NAME_PATTERN =
  /^(frame|group|vector|rectangle|ellipse|line|polygon|star|slice|component|instance|union|subtract|intersect|exclude|boolean)\s*\d*$/i;
const JUNK_PROPERTY_PATTERN = /^property\s*\d*=/i;
// Toàn số/khoảng trắng/dấu câu — Unicode property escape `\p{P}` bắt mọi dấu
// câu (kể cả dấu Việt/CJK), không chỉ ASCII. Chuỗi rỗng sau trim cũng khớp
// (mọi tên rỗng đều "không đủ nghĩa" — coi là rác).
const JUNK_NUMERIC_OR_PUNCT_PATTERN = /^[\d\s\p{P}]*$/u;

/** Đúng nguyên văn contract mục 3 — dùng cho `onItemStatus(anchor, 'skipped',
 *  reason)` khi bypass một component tên rác. */
export const RENAME_NEEDED_REASON = 'Tên không đủ nghĩa — cần đặt lại tên trong Figma';

export function isJunkComponentName(name: string): boolean {
  const trimmed = name.trim();
  if (JUNK_NUMERIC_OR_PUNCT_PATTERN.test(trimmed)) return true;
  if (JUNK_NAME_PATTERN.test(trimmed)) return true;
  if (JUNK_PROPERTY_PATTERN.test(trimmed)) return true;
  return false;
}

const ASSET_PAGE_KEYWORDS = ['icon', 'logo', 'avatar', 'image', 'background', 'illustration', 'asset', 'cover', 'thumbnail'];
const ASSET_NAME_PREFIXES = ['ic-', 'ic_', 'ic/', 'icon', 'logo', 'img-', 'img/', 'avatar'];

/** 'asset' (icon/logo/ảnh…): chỉ cần TÊN để sinh mô tả — xem
 *  `buildAssetDescribeInput`. 'normal': giữ nguyên luồng cây node + ảnh hiện
 *  có. Trang thắng trước (một page "Icons" toàn icon dù tên component không
 *  theo quy ước prefix); tên chỉ xét khi trang không nói lên điều gì. */
export function classifyComponentKind(page: string | undefined, name: string): 'asset' | 'normal' {
  const pageLower = (page ?? '').toLowerCase();
  if (ASSET_PAGE_KEYWORDS.some((keyword) => pageLower.includes(keyword))) return 'asset';
  const nameLower = name.toLowerCase();
  if (ASSET_NAME_PREFIXES.some((prefix) => nameLower.startsWith(prefix))) return 'asset';
  return 'normal';
}

/* ── 1. computeMissingDescriptions ───────────────────────────────────────── */

/** Một component còn thiếu mô tả: có mặt trong snapshot Figma (nguồn thật)
 *  nhưng KHÔNG có `description` trong snapshot VÀ anchor đó KHÔNG có mặt
 *  trong guide hiện có (guide chỉ chứa entry đã qua {@link
 *  validateDescribeOutput}, nên description trong guide không bao giờ rỗng —
 *  "có mặt trong guide" tương đương "đã có mô tả dự phòng"). */
export interface MissingComponentDescription {
  fileKey: string;
  nodeId: string;
  anchor: string;
  name: string;
  page?: string;
  properties: FigmaCatalogProperty[];
}

/** Tính danh sách component cần sinh mô tả: duyệt đúng snapshot (nguồn thật,
 *  luôn thắng — bất biến của WP19a), không bao giờ nhìn vào một anchor không
 *  còn tồn tại trong Figma. `guideMd == null` (App chưa từng sinh guide) xử
 *  lý giống hệt guide rỗng. */
export function computeMissingDescriptions(
  snapshot: FigmaComponentCatalogSnapshot,
  guideMd: string | null,
): MissingComponentDescription[] {
  const guide = guideMd != null ? parseComponentsGuide(guideMd) : new Map<string, { name: string; description: string }>();
  const missing: MissingComponentDescription[] = [];
  for (const file of snapshot.files) {
    for (const component of file.components) {
      if (component.description) continue;
      const anchor = anchorFor(file.fileKey, component.nodeId);
      if (guide.has(anchor)) continue;
      missing.push({
        fileKey: file.fileKey,
        nodeId: component.nodeId,
        anchor,
        name: component.name,
        ...(component.page ? { page: component.page } : {}),
        properties: component.properties,
      });
    }
  }
  return missing;
}

/** Coverage cho GET catalog (hiện dòng "X/Y component có mô tả · Z từ AI ·
 *  N thiếu" ở web). `described` đếm cả mô tả thật (Figma) lẫn mô tả từ guide —
 *  đúng những gì {@link mergeCatalogueWithGuide} (figma-component-guide.ts)
 *  sẽ hiện cho người dùng, không phải chỉ riêng Figma. */
export interface GuideCoverage {
  total: number;
  described: number;
  fromGuide: number;
  missing: number;
}

export function computeGuideCoverage(snapshot: FigmaComponentCatalogSnapshot, guideMd: string | null): GuideCoverage {
  const guide = guideMd != null ? parseComponentsGuide(guideMd) : new Map<string, { name: string; description: string }>();
  let total = 0;
  let described = 0;
  let fromGuide = 0;
  for (const file of snapshot.files) {
    for (const component of file.components) {
      total += 1;
      if (component.description) {
        described += 1;
        continue;
      }
      if (guide.has(anchorFor(file.fileKey, component.nodeId))) {
        described += 1;
        fromGuide += 1;
      }
    }
  }
  return { total, described, fromGuide, missing: total - described };
}

/* ── 2. summarizeNodeTree ────────────────────────────────────────────────── */

/** Cây node Figma rút gọn: chỉ giữ name/type/characters/số con — đủ cho
 *  agent nhận diện component KHÔNG cần cả payload REST đầy đủ (icon path
 *  data, styles, effects…, thường gấp hàng trăm lần kích thước cần thiết). */
export interface SummarizedNode {
  name: string;
  type: string;
  characters?: string;
  /** Số con thật sự trong Figma — giữ lại kể cả khi bị cắt (`truncated`) để
   *  agent biết node còn nội dung chưa thấy, không tưởng đây là node lá. */
  childCount?: number;
  children?: SummarizedNode[];
  /** true = còn con nhưng bị cắt (do vượt tầng cắt sâu hoặc để vừa `cap`). */
  truncated?: true;
}

const DEFAULT_TREE_DEPTH_CUTOFF = 6;
const DEFAULT_TREE_CAP_CHARS = 8_000;
const MAX_CHARACTERS_LEN = 300;
const TRIM_GUARD = 10_000;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function buildSummarizedNode(raw: unknown, depth: number, maxDepth: number): SummarizedNode | null {
  const node = asRecord(raw);
  if (!node) return null;
  const out: SummarizedNode = {
    name: typeof node.name === 'string' ? node.name : '',
    type: typeof node.type === 'string' ? node.type : '',
  };
  if (typeof node.characters === 'string' && node.characters.trim()) {
    out.characters = node.characters.trim().slice(0, MAX_CHARACTERS_LEN);
  }
  const rawChildren = Array.isArray(node.children) ? node.children : [];
  if (rawChildren.length > 0) {
    out.childCount = rawChildren.length;
    if (depth >= maxDepth) {
      // Tầng cắt sâu: KHÔNG đệ quy tiếp — node ở tầng >= maxDepth luôn là lá
      // rút gọn, dù Figma còn con thật. `childCount` ở trên đã nói cho agent
      // biết còn nội dung.
      out.truncated = true;
    } else {
      out.children = rawChildren
        .map((child) => buildSummarizedNode(child, depth + 1, maxDepth))
        .filter((child): child is SummarizedNode => child != null);
    }
  }
  return out;
}

/** Liệt kê mọi node CÓ `children` theo thứ tự hậu-thứ-tự (post-order — cành
 *  sâu nhất trước) để {@link trimToCap} luôn cắt bớt phần chi tiết ít giá trị
 *  nhất (đuôi của nhánh sâu/lặp lại nhiều, ví dụ danh sách item giống hệt
 *  nhau) trước khi đụng tới một node nông, nhiều tín hiệu.*/
function collectPrunable(node: SummarizedNode, out: SummarizedNode[]): void {
  if (!node.children) return;
  for (const child of node.children) collectPrunable(child, out);
  out.push(node);
}

/** Cắt bớt cây (mutating) tới khi `JSON.stringify` không vượt `cap` ký tự,
 *  hoặc hết node để cắt. `guard` chặn vòng lặp không đáng — cây component
 *  Figma thực tế chỉ vài trăm node, cap mặc định 8KB thường không bao giờ
 *  chạm ngưỡng này. */
function trimToCap(root: SummarizedNode, cap: number): SummarizedNode {
  let guard = 0;
  while (JSON.stringify(root).length > cap && guard < TRIM_GUARD) {
    guard += 1;
    const prunable: SummarizedNode[] = [];
    collectPrunable(root, prunable);
    const target = prunable[prunable.length - 1];
    if (!target || !target.children || target.children.length === 0) break;
    target.children.pop();
    // Bất kỳ lần cắt nào cũng đánh dấu truncated — kể cả khi vẫn còn con
    // (cắt bớt ĐUÔI danh sách, không cắt hết): agent cần biết cây này không
    // đầy đủ 100% so với Figma thật, không chỉ khi bị cắt trụi.
    target.truncated = true;
    if (target.children.length === 0) delete target.children;
  }
  return root;
}

/** Rút gọn `document` của một node Figma (từ `GET /v1/files/:key/nodes?
 *  ids=<nodeId>`, trường `nodes[<nodeId>].document`) thành JSON nhỏ đủ cho
 *  agent đọc: cắt sâu ở `maxDepth` tầng, rồi cắt bớt (post-order) tới khi vừa
 *  `cap` ký tự stringify. `null` khi `rawNode` không phải object node hợp lệ. */
export function summarizeNodeTree(
  rawNode: unknown,
  cap: number = DEFAULT_TREE_CAP_CHARS,
  maxDepth: number = DEFAULT_TREE_DEPTH_CUTOFF,
): SummarizedNode | null {
  const root = buildSummarizedNode(rawNode, 0, maxDepth);
  if (!root) return null;
  return trimToCap(root, cap);
}

/* ── 3. buildDescribeInput ───────────────────────────────────────────────── */

export interface DescribeInputComponent {
  anchor: string;
  name: string;
  page?: string;
  properties: FigmaCatalogProperty[];
  /** null khi không lấy được cây (lỗi mạng) — agent vẫn tả được từ ảnh. */
  tree: SummarizedNode | null;
  /** Tên file PNG cạnh `input-<n>.json` trong cùng thư mục, hoặc null khi
   *  ảnh lỗi/URL chết (fail-soft — xem `.tmp/pipeline/wp19b.yaml`). */
  image: string | null;
}

export interface DescribeInputFile {
  schemaVersion: '1.0';
  components: DescribeInputComponent[];
}

/** WP23a mục 3: input cho một chunk 'asset' — CHỈ tên (+ trang), KHÔNG
 *  `tree`/`image` (không fetch cây node/ảnh cho các component icon/logo/ảnh —
 *  mô tả sinh thuần từ tên/nhóm trang, xem skill `figma-comp-describe` mode
 *  asset). Type RIÊNG với {@link DescribeInputComponent} (không union vào
 *  cùng field) để không đổi shape của {@link buildDescribeInput} — hàm đó có
 *  test hồi quy so khớp object CHÍNH XÁC (`figma-guide-generate.test.ts`). */
export interface AssetDescribeInputComponent {
  anchor: string;
  name: string;
  page?: string;
  kind: 'asset';
}

export interface AssetDescribeInputFile {
  schemaVersion: '1.0';
  components: AssetDescribeInputComponent[];
}

export function buildAssetDescribeInput(batch: readonly MissingComponentDescription[]): AssetDescribeInputFile {
  return {
    schemaVersion: '1.0',
    components: batch.map((item) => ({
      anchor: item.anchor,
      name: item.name,
      ...(item.page ? { page: item.page } : {}),
      kind: 'asset' as const,
    })),
  };
}

/** Dựng nội dung file `_describe/input-<n>.json` cho một batch — hàm thuần,
 *  không ghi đĩa (caller ghi ra file, xem {@link generateComponentDescriptions}). */
export function buildDescribeInput(
  batch: readonly MissingComponentDescription[],
  treeByNode: ReadonlyMap<string, SummarizedNode | null>,
  imagePathByNode: ReadonlyMap<string, string>,
): DescribeInputFile {
  return {
    schemaVersion: '1.0',
    components: batch.map((item) => ({
      anchor: item.anchor,
      name: item.name,
      ...(item.page ? { page: item.page } : {}),
      properties: item.properties,
      tree: treeByNode.get(item.nodeId) ?? null,
      image: imagePathByNode.get(item.nodeId) ?? null,
    })),
  };
}

/* ── 4. validateDescribeOutput ───────────────────────────────────────────── */

export interface DescribeOutputEntry {
  anchor: string;
  description: string;
}

export interface RejectedDescribeOutputEntry {
  anchor?: string;
  reason: string;
}

export interface ValidateDescribeOutputResult {
  accepted: DescribeOutputEntry[];
  rejected: RejectedDescribeOutputEntry[];
}

const MAX_DESCRIPTION_LEN = 300;

/** Kiểm tất định output agent ghi ra `_describe/output-<n>.json`.
 *  `allowedAnchors`: Map anchor → tên component (từ batch đã gửi cho agent —
 *  dùng cả để kiểm "anchor có thuộc batch" LẪN để chặn mô tả trùng nguyên văn
 *  tên component, tức "mô tả rỗng nghĩa" — chỉ lặp lại tên, không nói gì
 *  thêm). Luật, theo đúng thứ tự áp dụng:
 *   1. `raw` phải parse được thành JSON là một MẢNG — hỏng → một rejected
 *      duy nhất, không cố đoán entry nào.
 *   2. Mỗi phần tử phải có `anchor` (string) và `description` (string).
 *   3. `anchor` phải có trong `allowedAnchors` (agent không được bịa anchor
 *      ngoài batch đã gửi) và không được lặp lại trong cùng output.
 *   4. `description` chuẩn hoá (collapse khoảng trắng, trim): 1..300 ký tự,
 *      không chứa `|` (vỡ ô bảng), không chứa xuống dòng NGUYÊN VĂN (kiểm
 *      trước khi collapse — sau collapse thì `\n` đã biến mất, không còn gì
 *      để bắt), và không trùng nguyên văn (không phân biệt hoa/thường) tên
 *      component ứng với anchor đó. */
export function validateDescribeOutput(
  raw: string,
  allowedAnchors: ReadonlyMap<string, string>,
): ValidateDescribeOutputResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { accepted: [], rejected: [{ reason: 'output không phải JSON hợp lệ' }] };
  }
  if (!Array.isArray(parsed)) {
    return { accepted: [], rejected: [{ reason: 'output phải là một mảng [{anchor, description}]' }] };
  }

  const accepted: DescribeOutputEntry[] = [];
  const rejected: RejectedDescribeOutputEntry[] = [];
  const seenAnchors = new Set<string>();

  for (const raw of parsed) {
    const item = asRecord(raw);
    if (!item) {
      rejected.push({ reason: 'phần tử không phải object {anchor, description}' });
      continue;
    }
    const anchor = typeof item.anchor === 'string' ? item.anchor.trim() : '';
    if (!anchor) {
      rejected.push({ reason: 'thiếu anchor' });
      continue;
    }
    const componentName = allowedAnchors.get(anchor);
    if (componentName === undefined) {
      rejected.push({ anchor, reason: 'anchor không thuộc batch đã gửi cho agent' });
      continue;
    }
    if (seenAnchors.has(anchor)) {
      rejected.push({ anchor, reason: 'anchor bị lặp lại trong cùng output' });
      continue;
    }
    if (typeof item.description !== 'string' || !item.description.trim()) {
      rejected.push({ anchor, reason: 'thiếu description' });
      continue;
    }
    if (/\r|\n/.test(item.description)) {
      rejected.push({ anchor, reason: 'description chứa xuống dòng (phải nằm gọn trong một ô bảng)' });
      continue;
    }
    const description = item.description.replace(/\s+/g, ' ').trim();
    if (description.includes('|')) {
      rejected.push({ anchor, reason: 'description chứa ký tự "|" (vỡ ô bảng markdown)' });
      continue;
    }
    if (description.length < 1 || description.length > MAX_DESCRIPTION_LEN) {
      rejected.push({ anchor, reason: `độ dài description không hợp lệ (1–${MAX_DESCRIPTION_LEN} ký tự)` });
      continue;
    }
    if (description.toLocaleLowerCase() === componentName.trim().toLocaleLowerCase()) {
      rejected.push({ anchor, reason: 'description trùng nguyên văn tên component (không nói gì thêm)' });
      continue;
    }
    seenAnchors.add(anchor);
    accepted.push({ anchor, description });
  }

  return { accepted, rejected };
}

/* ── 5. mergeGuideEntries ────────────────────────────────────────────────── */

/** Ghép `accepted` (lượt sinh vừa xong) vào guide hiện có, render lại qua
 *  {@link renderComponentsGuideMarkdown} của WP19a — giữ entry cũ, entry mới
 *  thắng entry cũ CÙNG anchor, và chỉ giữ những anchor CÒN THẬT trong
 *  `snapshot` (component đã bị xoá khỏi Figma từ lần sinh trước không mang
 *  mô tả ma sang lần này — cùng bất biến khối freeze docs-comp ở
 *  server.ts áp dụng khi đóng băng guide vào criteria/). Duyệt theo thứ tự
 *  `snapshot.files[].components[]` nên kết quả ổn định (không phụ thuộc thứ
 *  tự Map). */
export function mergeGuideEntries(
  existingGuideMd: string | null,
  accepted: readonly DescribeOutputEntry[],
  snapshot: FigmaComponentCatalogSnapshot,
): string {
  const existing = existingGuideMd != null ? parseComponentsGuide(existingGuideMd) : new Map<string, { name: string; description: string }>();
  const acceptedByAnchor = new Map(accepted.map((entry) => [entry.anchor, entry.description] as const));
  const entries: ComponentsGuideEntry[] = [];
  for (const file of snapshot.files) {
    for (const component of file.components) {
      const anchor = anchorFor(file.fileKey, component.nodeId);
      const description = acceptedByAnchor.get(anchor) ?? existing.get(anchor)?.description ?? '';
      if (!description) continue;
      entries.push({ anchor, name: component.name, description });
    }
  }
  return renderComponentsGuideMarkdown(entries);
}

/* ── 6. generateComponentDescriptions (IO orchestration) ─────────────────── */

/** Deps tiêm từ caller (figma-catalog-routes.ts cho job, server.ts cho vòng
 *  sinh bù của dr-comp) — giữ file này không phụ thuộc trực tiếp
 *  `figma-rest.ts` (network Figma thật) hay cách spawn agent (`startChatRun`,
 *  daemon-specific), để phần orchestration vẫn test được bằng deps giả. */
export interface GuideGenerationDeps {
  /** Thư mục ghi `input-<n>.json` / ảnh / đọc `output-<n>.json` — cwd của
   *  agent (skill `figma-comp-describe`). Caller đảm bảo thư mục này tồn tại
   *  hoặc để hàm tự tạo (mkdir recursive). */
  baseDir: string;
  fetchTree: (fileKey: string, nodeIds: readonly string[]) => Promise<ReadonlyMap<string, unknown>>;
  fetchImages: (fileKey: string, nodeIds: readonly string[]) => Promise<ReadonlyMap<string, string>>;
  /** Tải một URL ảnh (S3 Figma) về `destPath`. `false`/throw = ảnh lỗi — bỏ
   *  qua phần ảnh của đúng component đó, không fail cả chunk. */
  downloadImage: (url: string, destPath: string) => Promise<boolean>;
  /** Chạy MỘT lượt agent cho một chunk: caller ghi input, spawn agent, đọc lại
   *  `output-<n>.json`, trả về nội dung thô (text) — hoặc throw khi agent
   *  không ra kết quả (chunk đó bị bỏ, fail-soft ở tầng gọi). `group` (WP21a):
   *  nhóm trang Figma (fileKey + page) chunk này thuộc về — caller có thể
   *  dùng để tách hội thoại/tài nguyên riêng cho từng nhóm khi các nhóm chạy
   *  song song (`concurrency`), tránh xen lượt agent của nhiều nhóm vào CÙNG
   *  một cuộc hội thoại. Deps hiện có (server.ts, figma-guide-generate.test.ts)
   *  khai `runAgentChunk` với ít hơn 4 tham số vẫn hợp lệ — TypeScript cho
   *  phép implementation khai ít tham số hơn type yêu cầu. */
  runAgentChunk: (
    input: DescribeInputFile | AssetDescribeInputFile,
    chunkDir: string,
    chunkIndex: number,
    group: { fileKey: string; page?: string },
  ) => Promise<string>;
  /** WP23a mục 1.d (optional, tiêm từ figma-design-system-routes.ts): kho ảnh
   *  PNG đã prefetch cạnh nguồn (`figma-design-systems/<sourceId>/images/`,
   *  xem prefetchComponentImages). Chunk kind 'normal' ưu tiên đọc cache này
   *  TRƯỚC khi gọi `fetchImages`/`downloadImage` REST — thiếu (has() false)
   *  thì rơi về đường REST cũ NHƯ TRƯỚC, rồi ghi bù (best-effort, không throw)
   *  ảnh vừa tải vào cache để lần sau khỏi tải lại. KHÔNG truyền field này
   *  (undefined) ⇒ hành vi y hệt trước WP23a — điểm hồi quy phải giữ (đường
   *  App-level figma-catalog.ts / vòng sinh bù dr-comp server.ts không tiêm
   *  deps này). */
  imageCache?: {
    pathFor(anchor: string): string;
    has(anchor: string): Promise<boolean>;
  };
  /** Tối đa bao nhiêu component xử lý trong MỘT lần gọi. Mặc định 60 (giữ
   *  đúng quyết định cũ — vòng sinh bù dr-comp trong server.ts KHÔNG truyền
   *  option này nên vẫn 60 y hệt trước WP21a). WP21a: truyền `null` để KHÔNG
   *  cap — sinh TOÀN BỘ comp thiếu trong một lượt (nút "Sinh mô tả" ở nguồn
   *  dùng chung, xem `.tmp/pipeline/wp21-contract.md` mục 2). Chỉ
   *  `undefined` (không truyền field) mới rơi vào mặc định 60 — `null` là một
   *  giá trị CÓ CHỦ Ý, khác `??`. */
  cap?: number | null;
  /** Bao nhiêu component mỗi lượt agent cho chunk kind 'normal' (mặc định
   *  `NORMAL_CHUNK_SIZE` = 12). Chunk kind 'asset' luôn cố định
   *  `ASSET_CHUNK_SIZE` = 100 — KHÔNG đọc field này (asset không đụng cây
   *  node/ảnh nên gửi được nhiều component hơn mỗi lượt). */
  chunkSize?: number;
  /** WP23a mục 3: số CHUNK chạy song song tối đa (mặc định 1 = tuần tự).
   *  THAY HẲN mô hình WP21a/WP21-fix (nhóm trang chạy song song, chunk trong
   *  một nhóm luôn tuần tự) — giờ pool song song ở MỨC CHUNK, không phải mức
   *  nhóm: mọi chunk của MỌI nhóm (fileKey, page, kind) được dàn phẳng thành
   *  một danh sách rồi chạy qua CÙNG MỘT pool `concurrency`. Route job "Sinh
   *  mô tả" (figma-design-system-routes.ts) truyền 3. */
  concurrency?: number;
  onProgress?: (info: { chunkIndex: number; totalChunks: number; note: string }) => void;
  /** Callback trạng thái TỪNG component trong lượt này — optional, KHÔNG
   *  truyền thì hành vi/giá trị trả về y hệt trước (điểm hồi quy phải giữ,
   *  xem test "hồi quy" trong figma-design-system-guide.test.ts). Chuỗi trạng
   *  thái: WP23a mục 1 — component tên rác (isJunkComponentName) → 'skipped'
   *  NGAY khi lượt bắt đầu, không bao giờ có 'queued'/'running' cho nó. Với
   *  component còn lại: 'queued' cho mọi comp trong `capped` ngay khi biết
   *  danh sách lượt; 'running' khi chunk chứa nó bắt đầu; sau validate —
   *  accepted 'succeeded', rejected 'failed' kèm `reason` (lý do validate,
   *  hoặc lý do chunk-level như "output không phải JSON hợp lệ" khi KHÔNG có
   *  anchor riêng — áp dụng cho mọi comp của chunk đó chưa có trạng thái);
   *  chunk agent lỗi (throw) → cả chunk 'failed' reason `"agent lỗi: <msg>"`. */
  onItemStatus?: (anchor: string, status: 'queued' | 'running' | 'succeeded' | 'failed' | 'skipped', reason?: string) => void;
}

export interface GuideGenerationResult {
  guideMarkdown: string;
  generated: number;
  rejected: number;
  /** Component còn thiếu mô tả SAU lượt này (bị cap, chưa xử lý) — báo cho
   *  người dùng biết cần bấm tiếp. KHÔNG đếm component tên rác (`skipped`) —
   *  đó là một loại riêng, bấm lại không giải quyết được (cần đổi tên trên
   *  Figma trước). */
  remaining: number;
  /** WP23a mục 1: số component bị bypass vì tên rác (isJunkComponentName) —
   *  không gửi agent, không tính vào `rejected`. */
  skipped: number;
  /** Lỗi/timeout của từng chunk (fail-soft — không fail cả job trừ khi 0
   *  chunk nào thành công, xem điều kiện throw bên dưới). */
  chunkErrors: string[];
}

/** Chạy tối đa `limit` task đồng thời — pool đơn giản tự viết (không thêm
 *  dependency mới). Mỗi task tự bọc try/catch nội bộ (xem các chunk task
 *  trong {@link generateComponentDescriptions}: một chunk lỗi ghi lỗi vào
 *  mảng dùng chung rồi tiếp tục, KHÔNG throw) nên `Promise.all` ở đây không
 *  cần `allSettled` — một task throw thật (bug, không phải lỗi nghiệp vụ) vẫn
 *  nên văng ra ngoài để lộ ra thay vì nuốt câm lặng. */
async function runWithConcurrencyLimit(tasks: ReadonlyArray<() => Promise<void>>, limit: number): Promise<void> {
  if (tasks.length === 0) return;
  let cursor = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const current = cursor;
      cursor += 1;
      if (current >= tasks.length) return;
      await tasks[current]!();
    }
  }
  const workerCount = Math.max(1, Math.min(limit, tasks.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
}

function guideGroupLabel(meta: { fileKey: string; page?: string }): string {
  return meta.page ? `${meta.fileKey}/${meta.page}` : meta.fileKey;
}

const NORMAL_CHUNK_SIZE = 12;
const ASSET_CHUNK_SIZE = 100;

/** Sinh mô tả cho những component còn thiếu (fail-soft theo chunk — TRỪ khi
 *  0 chunk nào thành công, lúc đó throw kèm lỗi gốc để caller đánh job/stage
 *  là thất bại, theo đúng khuôn trong `.tmp/pipeline/wp19b.yaml`). Dùng
 *  CHUNG bởi job POST /generate-guide (figma-catalog-routes.ts /
 *  figma-design-system-routes.ts) VÀ vòng sinh bù của dr-comp (server.ts,
 *  khối docs-comp prep) — hai/ba caller khác nhau ở CÁCH tiêm
 *  `runAgentChunk`/`fetchTree`/`fetchImages`/`cap`/`concurrency`/`imageCache`,
 *  không ở logic sinh.
 *
 *  WP23a (`.tmp/pipeline/wp23-contract.md` mục 1+3), THAY HẲN mô hình fan-out
 *  WP21a/WP21-fix:
 *   1. Component tên rác (`isJunkComponentName`) bị bypass HOÀN TOÀN trước
 *      khi cap/chunk — 'skipped' ngay, không tốn một lượt agent nào, không
 *      tính vào `remaining` (đổi tên rồi mới xử lý lại được, bấm-lại không
 *      giúp gì).
 *   2. Component còn lại được nhóm theo (fileKey, page, kind) — MỖI nhóm là
 *      MỘT đơn vị chunk riêng, KHÔNG BAO GIỜ trộn page hay trộn kind: kind
 *      'normal' chunk `NORMAL_CHUNK_SIZE` (12, input tree+ảnh như cũ); kind
 *      'asset' chunk `ASSET_CHUNK_SIZE` (100, input chỉ tên — không cây/ảnh).
 *   3. TOÀN BỘ chunk của MỌI nhóm được dàn PHẲNG thành một danh sách, gán
 *      `globalIndex` CỐ ĐỊNH theo thứ tự đó (ổn định, không phụ thuộc thứ tự
 *      hoàn tất — file `input-<n>.json` không đụng tên nhau), rồi chạy qua
 *      MỘT pool duy nhất giới hạn `deps.concurrency` (mặc định 1 = tuần tự).
 *      Đây là khác biệt cốt lõi với WP21a: pool song song ở MỨC CHUNK, không
 *      còn ở mức "nhóm trang" — WP21-fix "concurrency<=1 span qua page" cũng
 *      hết hiệu lực, vì việc nhóm theo (page, kind) giờ áp dụng LUÔN, không
 *      phụ thuộc `concurrency`.
 *  `accepted` được gom TRONG BỘ NHỚ từ mọi chunk rồi merge+trả về
 *  guideMarkdown ĐÚNG MỘT LẦN ở cuối hàm — không chunk nào tự ghi đĩa riêng —
 *  nên không có lost-update dù nhiều chunk chạy đồng thời (JS đơn luồng:
 *  `accepted.push`/các counter dùng chung chỉ đổi giữa các điểm `await`,
 *  không bao giờ xen ngang giữa chừng một lần gán). */
export async function generateComponentDescriptions(
  snapshot: FigmaComponentCatalogSnapshot,
  existingGuideMd: string | null,
  deps: GuideGenerationDeps,
): Promise<GuideGenerationResult> {
  const missing = computeMissingDescriptions(snapshot, existingGuideMd);
  const normalChunkSize = deps.chunkSize ?? NORMAL_CHUNK_SIZE;
  const concurrency = Math.max(1, deps.concurrency ?? 1);

  // WP23a mục 1: tên rác bypass TRƯỚC cap — không đáng tốn một slot cap cho
  // một component mà agent không thể tả có ý nghĩa (asset lẫn normal).
  const renameNeeded: MissingComponentDescription[] = [];
  const processable: MissingComponentDescription[] = [];
  for (const item of missing) {
    if (isJunkComponentName(item.name)) renameNeeded.push(item);
    else processable.push(item);
  }
  for (const item of renameNeeded) {
    deps.onItemStatus?.(item.anchor, 'skipped', RENAME_NEEDED_REASON);
  }

  // `cap: null` (CÓ CHỦ Ý) = không cap — khác `undefined` (không truyền field
  // = mặc định 60). Dùng so sánh tường minh thay vì `??` vì `??` sẽ biến
  // `null` thành 60, phá đúng ngữ nghĩa "null = sinh hết" mà nút "Sinh mô tả"
  // (figma-design-system-routes.ts) cần.
  const capValue = deps.cap === undefined ? 60 : deps.cap;
  const capped = capValue == null ? processable : processable.slice(0, capValue);
  const remaining = capValue == null ? 0 : processable.length - capped.length;

  if (capped.length === 0) {
    return {
      guideMarkdown: existingGuideMd ?? renderComponentsGuideMarkdown([]),
      generated: 0,
      rejected: 0,
      remaining,
      skipped: renameNeeded.length,
      chunkErrors: [],
    };
  }

  // 'queued' cho MỌI comp còn lại của lượt này ngay khi biết danh sách —
  // trước khi chunk đầu tiên chạy. Không truyền onItemStatus (deps.onItemStatus
  // undefined) → optional chaining no-op, hành vi hồi quy y hệt cũ.
  for (const item of capped) deps.onItemStatus?.(item.anchor, 'queued');

  const allowedAnchors = new Map(capped.map((item) => [item.anchor, item.name] as const));

  await fs.promises.mkdir(deps.baseDir, { recursive: true });

  // WP23a mục 3: đơn vị chunk = (fileKey, page, kind) — không bao giờ trộn.
  interface Bucket {
    fileKey: string;
    page?: string;
    kind: 'asset' | 'normal';
    items: MissingComponentDescription[];
  }
  const bucketOrder: string[] = [];
  const buckets = new Map<string, Bucket>();
  for (const item of capped) {
    const kind = classifyComponentKind(item.page, item.name);
    const key = `${item.fileKey}\0${item.page ?? ''}\0${kind}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { fileKey: item.fileKey, ...(item.page ? { page: item.page } : {}), kind, items: [] };
      buckets.set(key, bucket);
      bucketOrder.push(key);
    }
    bucket.items.push(item);
  }

  interface ChunkTask {
    globalIndex: number;
    bucket: Bucket;
    items: MissingComponentDescription[];
    localIndex: number;
    totalInBucket: number;
  }
  const chunkTasks: ChunkTask[] = [];
  for (const key of bucketOrder) {
    const bucket = buckets.get(key)!;
    const size = bucket.kind === 'asset' ? ASSET_CHUNK_SIZE : normalChunkSize;
    const chunks: MissingComponentDescription[][] = [];
    for (let i = 0; i < bucket.items.length; i += size) chunks.push(bucket.items.slice(i, i + size));
    chunks.forEach((chunkItems, localIndex) => {
      chunkTasks.push({ globalIndex: -1, bucket, items: chunkItems, localIndex, totalInBucket: chunks.length });
    });
  }
  // globalIndex CỐ ĐỊNH TRƯỚC KHI chạy song song (không theo thứ tự hoàn tất
  // — các chunk chạy song song nên thứ tự hoàn tất không tất định) để
  // `input-<n>.json` không đụng tên nhau trong `baseDir` DÙNG CHUNG.
  chunkTasks.forEach((task, index) => { task.globalIndex = index; });
  const totalChunksAcrossGroups = chunkTasks.length;

  const accepted: DescribeOutputEntry[] = [];
  let rejectedCount = 0;
  const chunkErrors: string[] = [];
  // Đếm SỐ CHUNK thành công (agent chạy xong và đọc/parse được output), KHÔNG
  // dùng chunkErrors.length — chunkErrors đếm SỐ THÔNG ĐIỆP lỗi phụ (tree lỗi
  // + ảnh lỗi của cùng một chunk đều bị push riêng), nên một chunk chạy xong
  // bình thường vẫn có thể đẩy 2 message vào đó (xem điểm 1,
  // `.tmp/pipeline/wp19b-fix.yaml`). Dùng chung giữa các chunk chạy song song —
  // an toàn vì JS đơn luồng, `+= 1`/`.push` không bao giờ xen ngang nhau.
  let successfulChunks = 0;

  const runOneChunk = async (task: ChunkTask): Promise<void> => {
    const { bucket, items: chunk, globalIndex, localIndex, totalInBucket } = task;
    const label = guideGroupLabel(bucket);
    // 'running' cho cả chunk NGAY khi lượt này bắt đầu — trước try để luôn
    // bắn dù chunk lỗi sớm (vd runAgentChunk throw ngay).
    for (const item of chunk) deps.onItemStatus?.(item.anchor, 'running');
    try {
      let input: DescribeInputFile | AssetDescribeInputFile;
      if (bucket.kind === 'asset') {
        // WP23a mục 1.b: asset chỉ cần TÊN — KHÔNG fetchTree/fetchImages.
        input = buildAssetDescribeInput(chunk);
      } else {
        const byFile = new Map<string, MissingComponentDescription[]>();
        for (const item of chunk) {
          const list = byFile.get(item.fileKey) ?? [];
          list.push(item);
          byFile.set(item.fileKey, list);
        }
        const treeByNode = new Map<string, SummarizedNode | null>();
        const imagePathByNode = new Map<string, string>();
        for (const [fileKey, fileItems] of byFile) {
          const nodeIds = fileItems.map((item) => item.nodeId);
          const trees = await deps.fetchTree(fileKey, nodeIds).catch((err) => {
            chunkErrors.push(`nhóm ${label} · lượt ${localIndex + 1}: cây node của ${fileKey} lỗi (tiếp tục bằng ảnh) — ${String((err as Error)?.message ?? err)}`);
            return new Map<string, unknown>();
          });
          for (const [nodeId, tree] of trees) treeByNode.set(nodeId, summarizeNodeTree(tree));

          // WP23a mục 1.d: ảnh cache TRƯỚC — chỉ fetch REST cho anchor CHƯA
          // có cache (hoặc khi không tiêm imageCache — hành vi cũ y hệt).
          const idsNeedingFetch: string[] = [];
          for (const item of fileItems) {
            if (deps.imageCache) {
              const cached = await deps.imageCache.has(item.anchor).catch(() => false);
              if (cached) {
                const destName = `img-${item.anchor}.png`;
                const ok = await fs.promises
                  .copyFile(deps.imageCache.pathFor(item.anchor), path.join(deps.baseDir, destName))
                  .then(() => true)
                  .catch(() => false);
                if (ok) {
                  imagePathByNode.set(item.nodeId, destName);
                  continue;
                }
                // Cache báo có nhưng copy fail (file vừa bị xoá/hỏng) — rơi
                // về REST như anchor chưa cache thay vì mất ảnh lượt này.
              }
            }
            idsNeedingFetch.push(item.nodeId);
          }
          if (idsNeedingFetch.length > 0) {
            const images = await deps.fetchImages(fileKey, idsNeedingFetch).catch((err) => {
              chunkErrors.push(`nhóm ${label} · lượt ${localIndex + 1}: ảnh của ${fileKey} lỗi (tiếp tục bằng cây node) — ${String((err as Error)?.message ?? err)}`);
              return new Map<string, string>();
            });
            for (const [nodeId, url] of images) {
              const nodeAnchor = anchorFor(fileKey, nodeId);
              const destName = `img-${nodeAnchor}.png`;
              const ok = await deps.downloadImage(url, path.join(deps.baseDir, destName)).catch(() => false);
              if (ok) {
                imagePathByNode.set(nodeId, destName);
                // Ghi bù best-effort vào cache — lần sau khỏi tải lại REST.
                if (deps.imageCache) {
                  await fs.promises.copyFile(path.join(deps.baseDir, destName), deps.imageCache.pathFor(nodeAnchor)).catch(() => {});
                }
              }
            }
          }
        }
        input = buildDescribeInput(chunk, treeByNode, imagePathByNode);
      }
      await fs.promises.writeFile(path.join(deps.baseDir, `input-${globalIndex}.json`), JSON.stringify(input, null, 2), 'utf8');
      const rawOutput = await deps.runAgentChunk(input, deps.baseDir, globalIndex, { fileKey: bucket.fileKey, ...(bucket.page ? { page: bucket.page } : {}) });
      const result = validateDescribeOutput(rawOutput, allowedAnchors);
      accepted.push(...result.accepted);
      rejectedCount += result.rejected.length;
      // Sau validate — accepted 'succeeded'; rejected CÓ anchor riêng 'failed'
      // kèm đúng reason validate. Rejected KHÔNG có anchor (JSON hỏng/không
      // phải mảng — áp cho CẢ chunk, không đoán entry nào) dùng làm reason dự
      // phòng cho những comp của chunk này chưa có trạng thái (agent không
      // nhắc tới anchor đó trong output) — không bao giờ để một comp kẹt ở
      // 'running' vĩnh viễn.
      const statusedAnchors = new Set<string>();
      for (const entry of result.accepted) {
        deps.onItemStatus?.(entry.anchor, 'succeeded');
        statusedAnchors.add(entry.anchor);
      }
      // WP21-fix điểm 3 (review WP21a, vẫn giữ nguyên ở WP23a): agent có thể
      // hallucinate một anchor KHÔNG thuộc batch đã gửi cho chunk này
      // (validateDescribeOutput vẫn kiểm theo `allowedAnchors` TOÀN CỤC của cả
      // lượt, không phải riêng chunk — xem khai báo `allowedAnchors` ở trên).
      // Rejected loại "anchor không thuộc batch" vẫn đếm vào `rejectedCount`
      // như cũ (không đổi ở trên), nhưng KHÔNG được bắn onItemStatus cho
      // anchor lạ đó — nếu bắn, figma-design-system-routes.ts (onItemStatus
      // callback, `missingByAnchor.get(anchor)` miss) tạo item ma `name: ''`
      // trong job.items/meta.failures. Chỉ bắn cho anchor THẬT SỰ thuộc batch
      // của CHÍNH chunk này (`allowedAnchorsInChunk`, không phải
      // allowedAnchors toàn cục — một anchor thuộc chunk KHÁC trong cùng lượt
      // cũng không hợp lệ ở đây).
      const allowedAnchorsInChunk = new Set(chunk.map((item) => item.anchor));
      let chunkLevelReason: string | undefined;
      for (const entry of result.rejected) {
        if (entry.anchor && allowedAnchorsInChunk.has(entry.anchor)) {
          deps.onItemStatus?.(entry.anchor, 'failed', entry.reason);
          statusedAnchors.add(entry.anchor);
        } else if (!entry.anchor && chunkLevelReason === undefined) {
          chunkLevelReason = entry.reason;
        }
      }
      for (const item of chunk) {
        if (statusedAnchors.has(item.anchor)) continue;
        deps.onItemStatus?.(item.anchor, 'failed', chunkLevelReason ?? 'agent không trả kết quả cho component này');
      }
      deps.onProgress?.({
        chunkIndex: globalIndex,
        totalChunks: totalChunksAcrossGroups,
        note: `Nhóm ${label} · lượt ${localIndex + 1}/${totalInBucket}: +${result.accepted.length} mô tả, loại ${result.rejected.length}.`,
      });
      // Tới được đây nghĩa là agent đã chạy xong và output đã đọc/parse được
      // (dù accepted có thể là 0) — tính là 1 chunk thành công.
      successfulChunks += 1;
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      chunkErrors.push(`nhóm ${label} · lượt ${localIndex + 1}: ${msg}`);
      // Chunk agent lỗi → CẢ chunk 'failed' reason "agent lỗi: <msg>" (contract
      // mục 2/WP21a, vẫn giữ nguyên ở WP23a) — không phân biệt component nào
      // trong chunk gây lỗi, vì lỗi xảy ra ở tầng chunk (spawn agent/ghi
      // input/…), trước khi có output riêng cho từng comp. Chunk này lỗi
      // KHÔNG chặn chunk khác (bắt lỗi ở đây, trong task của CHÍNH chunk này).
      for (const item of chunk) deps.onItemStatus?.(item.anchor, 'failed', `agent lỗi: ${msg}`);
    }
  };

  // WP23a mục 3: pool song song ở MỨC CHUNK (không còn mức "nhóm trang" như
  // WP21a) — mọi chunk task tự bọc try/catch nội bộ nên một chunk lỗi không
  // chặn các chunk khác. concurrency=1 (mặc định) ⇒ 1 worker ⇒ mọi chunk chạy
  // tuần tự đúng thứ tự `chunkTasks` (đúng thứ tự bucket → thứ tự capped gốc).
  await runWithConcurrencyLimit(chunkTasks.map((task) => () => runOneChunk(task)), concurrency);

  // Job failed CHỈ khi 0 chunk nào thành công (trên TOÀN BỘ mọi chunk) và có
  // ≥1 chunk để chạy — không phải khi số MESSAGE lỗi phụ (chunkErrors) chạm
  // số chunk, vì một chunk có thể vừa thành công vừa đẩy nhiều message lỗi
  // phụ (tree/ảnh) mà không ảnh hưởng tới việc agent chạy xong.
  if (successfulChunks === 0 && totalChunksAcrossGroups > 0) {
    throw new Error(`Toàn bộ ${totalChunksAcrossGroups} lượt sinh mô tả đều lỗi — ${chunkErrors.join('; ')}`);
  }

  // Gom `accepted` từ MỌI chunk rồi merge+trả về guideMarkdown ĐÚNG MỘT LẦN ở
  // đây — không chunk nào tự gọi writeFigmaDesignSystemGuide riêng — caller
  // (figma-design-system-routes.ts) chỉ ghi đĩa MỘT LẦN với kết quả này, nên
  // không có lost-update dù nhiều chunk chạy đồng thời.
  return {
    guideMarkdown: mergeGuideEntries(existingGuideMd, accepted, snapshot),
    generated: accepted.length,
    rejected: rejectedCount,
    remaining,
    skipped: renameNeeded.length,
    chunkErrors,
  };
}
