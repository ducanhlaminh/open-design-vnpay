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
   *  không ra kết quả (chunk đó bị bỏ, fail-soft ở tầng gọi). */
  runAgentChunk: (input: DescribeInputFile, chunkDir: string, chunkIndex: number) => Promise<string>;
  /** Tối đa bao nhiêu component xử lý trong MỘT lần gọi (mặc định 60, theo
   *  quyết định đã chốt: "mỗi click sinh tối đa 60 comp"). */
  cap?: number;
  /** Bao nhiêu component mỗi lượt agent (mặc định 12). */
  chunkSize?: number;
  onProgress?: (info: { chunkIndex: number; totalChunks: number; note: string }) => void;
}

export interface GuideGenerationResult {
  guideMarkdown: string;
  generated: number;
  rejected: number;
  /** Component còn thiếu mô tả SAU lượt này (bị cap, chưa xử lý) — báo cho
   *  người dùng biết cần bấm tiếp. */
  remaining: number;
  /** Lỗi/timeout của từng chunk (fail-soft — không fail cả job trừ khi 0
   *  chunk nào thành công, xem điều kiện throw bên dưới). */
  chunkErrors: string[];
}

/** Sinh mô tả cho những component còn thiếu (fail-soft theo chunk — TRỪ khi
 *  0 chunk nào thành công, lúc đó throw kèm lỗi gốc để caller đánh job/stage
 *  là thất bại, theo đúng khuôn trong `.tmp/pipeline/wp19b.yaml`). Dùng
 *  CHUNG bởi job POST /generate-guide (figma-catalog-routes.ts) VÀ vòng sinh
 *  bù của dr-comp (server.ts, khối docs-comp prep) — hai caller khác nhau ở
 *  CÁCH tiêm `runAgentChunk`/`fetchTree`/`fetchImages`, không ở logic sinh. */
export async function generateComponentDescriptions(
  snapshot: FigmaComponentCatalogSnapshot,
  existingGuideMd: string | null,
  deps: GuideGenerationDeps,
): Promise<GuideGenerationResult> {
  const missing = computeMissingDescriptions(snapshot, existingGuideMd);
  const cap = deps.cap ?? 60;
  const chunkSize = deps.chunkSize ?? 12;
  const capped = missing.slice(0, cap);
  const remaining = missing.length - capped.length;

  if (capped.length === 0) {
    return {
      guideMarkdown: existingGuideMd ?? renderComponentsGuideMarkdown([]),
      generated: 0,
      rejected: 0,
      remaining: 0,
      chunkErrors: [],
    };
  }

  const allowedAnchors = new Map(capped.map((item) => [item.anchor, item.name] as const));
  const chunks: MissingComponentDescription[][] = [];
  for (let i = 0; i < capped.length; i += chunkSize) chunks.push(capped.slice(i, i + chunkSize));

  await fs.promises.mkdir(deps.baseDir, { recursive: true });

  const accepted: DescribeOutputEntry[] = [];
  let rejectedCount = 0;
  const chunkErrors: string[] = [];
  // Đếm SỐ CHUNK thành công (agent chạy xong và đọc/parse được output), KHÔNG
  // dùng chunkErrors.length — chunkErrors đếm SỐ THÔNG ĐIỆP lỗi phụ (tree lỗi
  // + ảnh lỗi của cùng một chunk đều bị push riêng), nên một chunk chạy xong
  // bình thường vẫn có thể đẩy 2 message vào đó (xem điểm 1,
  // `.tmp/pipeline/wp19b-fix.yaml`).
  let successfulChunks = 0;

  for (const [index, chunk] of chunks.entries()) {
    try {
      // Tuần tự theo file trong chunk (rate-limit nhẹ nhàng — quyết định đã
      // chốt: "không bắn song song vô hạn").
      const byFile = new Map<string, MissingComponentDescription[]>();
      for (const item of chunk) {
        const list = byFile.get(item.fileKey) ?? [];
        list.push(item);
        byFile.set(item.fileKey, list);
      }
      const treeByNode = new Map<string, SummarizedNode | null>();
      const imagePathByNode = new Map<string, string>();
      for (const [fileKey, items] of byFile) {
        const nodeIds = items.map((item) => item.nodeId);
        const trees = await deps.fetchTree(fileKey, nodeIds).catch((err) => {
          chunkErrors.push(`chunk ${index + 1}: cây node của ${fileKey} lỗi (tiếp tục bằng ảnh) — ${String((err as Error)?.message ?? err)}`);
          return new Map<string, unknown>();
        });
        for (const [nodeId, tree] of trees) treeByNode.set(nodeId, summarizeNodeTree(tree));
        const images = await deps.fetchImages(fileKey, nodeIds).catch((err) => {
          chunkErrors.push(`chunk ${index + 1}: ảnh của ${fileKey} lỗi (tiếp tục bằng cây node) — ${String((err as Error)?.message ?? err)}`);
          return new Map<string, string>();
        });
        for (const [nodeId, url] of images) {
          const destName = `img-${anchorFor(fileKey, nodeId)}.png`;
          const ok = await deps.downloadImage(url, path.join(deps.baseDir, destName)).catch(() => false);
          if (ok) imagePathByNode.set(nodeId, destName);
        }
      }
      const input = buildDescribeInput(chunk, treeByNode, imagePathByNode);
      await fs.promises.writeFile(path.join(deps.baseDir, `input-${index}.json`), JSON.stringify(input, null, 2), 'utf8');
      const rawOutput = await deps.runAgentChunk(input, deps.baseDir, index);
      const result = validateDescribeOutput(rawOutput, allowedAnchors);
      accepted.push(...result.accepted);
      rejectedCount += result.rejected.length;
      deps.onProgress?.({
        chunkIndex: index,
        totalChunks: chunks.length,
        note: `Lượt ${index + 1}/${chunks.length}: +${result.accepted.length} mô tả, loại ${result.rejected.length}.`,
      });
      // Tới được đây nghĩa là agent đã chạy xong và output đã đọc/parse được
      // (dù accepted có thể là 0) — tính là 1 chunk thành công.
      successfulChunks += 1;
    } catch (err) {
      chunkErrors.push(`chunk ${index + 1}: ${String((err as Error)?.message ?? err)}`);
    }
  }

  // Job failed CHỈ khi 0 chunk nào thành công và có ≥1 chunk để chạy — không
  // phải khi số MESSAGE lỗi phụ (chunkErrors) chạm số chunk, vì một chunk có
  // thể vừa thành công vừa đẩy nhiều message lỗi phụ (tree/ảnh) mà không ảnh
  // hưởng tới việc agent chạy xong.
  if (successfulChunks === 0 && chunks.length > 0) {
    throw new Error(`Toàn bộ ${chunks.length} lượt sinh mô tả đều lỗi — ${chunkErrors.join('; ')}`);
  }

  return {
    guideMarkdown: mergeGuideEntries(existingGuideMd, accepted, snapshot),
    generated: accepted.length,
    rejected: rejectedCount,
    remaining,
    chunkErrors,
  };
}
