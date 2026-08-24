// ds-lab / lab-refs — "Reference concept": người dùng dán 1..N link PAGE
// Figma (không phải link từng node — "Copy link to page" của Figma luôn kèm
// `node-id`); daemon verify + quét các frame con cấp đỉnh của trang đó thành
// danh sách CONCEPT màn (tên + PNG thumbnail tải về đĩa) để bước "Bản đồ màn"
// (lab-map) map concept ↔ màn, rồi "Sáng tác màn" (lab-compose) dựng SÁT CẤU
// TRÚC bố cục của concept đã map (xem `.tmp/pipeline/wp-lab-refs-daemon.yaml`
// — quyết định người dùng 24/08 qua AskUserQuestion).
//
// Module này chứa phần THUẦN test-được (parse/detect) + fs boundary hẹp
// (đọc/ghi `refs/refs.json`, tải PNG) — cùng khuôn `figma-build.ts`'s
// docblock ("pure ... except the two preview-config helpers"): mọi hàm ở đây
// hoặc thuần (parseFigmaPageLink/detectConceptsFromPage) hoặc fs/network có
// giới hạn rõ ràng (readLabRefs/writeLabRefs/scanLabRefs). figma-build-
// routes.ts (registerFigmaBuildRoutes) sở hữu lớp HTTP.
//
// `refs/` SỐNG NGOÀI `outputs` của mọi stage trong pipelines.ts (tiền lệ
// `patterns/`, `.figma-preview.json`) — không phải sản phẩm của MỘT lần chạy
// stage, phải sống sót "Chạy lại".

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { describeFigmaError, fetchNodeImages, fetchNodeSubtrees, type FigmaRestDeps } from './figma-rest.js';

/** Thư mục PNG thumbnail của các concept — CỐ Ý ngoài `outputs` (xem docblock
 *  đầu file). */
export const LAB_REFS_DIR_REL = 'refs';

/** Registry máy đọc — nguồn sự thật của danh sách trang/concept đã quét. */
export const LAB_REFS_FILE_REL = 'refs/refs.json';

/** Một link PAGE đã quét — `ok:false` khi link hỏng, không phải page, hoặc
 *  REST lỗi (403/404/…, `detail` qua `describeFigmaError`). */
export interface RefsPageRow {
  url: string;
  fileKey: string;
  nodeId: string;
  /** Tên trang (Figma CANVAS node's `name`) — vắng khi `ok:false` trước khi
   *  daemon đọc được node. */
  name?: string;
  ok: boolean;
  detail?: string;
}

/** Một concept màn (frame con cấp đỉnh của trang) — `png` rỗng khi ảnh lỗi
 *  (fail-soft, xem `scanLabRefs`'s docblock), KHÔNG làm mất concept. */
export interface RefsConcept {
  /** `<fileKey>:<nodeId>` — khoá ổn định để lab-map's `reference.conceptId`
   *  và lab-compose trỏ lại đúng concept. */
  id: string;
  fileKey: string;
  nodeId: string;
  name: string;
  /** `refs/<slug>.png`, tương đối từ `labCwd` — rỗng khi tải ảnh thất bại. */
  png: string;
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
}

function defaultRefsFile(): RefsFile {
  return { schema_version: 1, pages: [], concepts: [] };
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
 *  `a:b`, dạng id node Figma thường) vì mục đích ở đây là trỏ ĐÚNG một trang
 *  cụ thể, không phải cả file. Thiếu `node-id`, `node-id` sai dạng, hoặc
 *  không phải link Figma → `null` — "Copy link to page" của Figma LUÔN kèm
 *  `node-id`, nên thiếu nó nghĩa là người dùng dán nhầm loại link (link file
 *  gốc, hoặc link không phải Figma). Thuần — không fs/network. */
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

// ── detectConceptsFromPage ───────────────────────────────────────────────

const CONCEPT_NODE_TYPES = new Set(['FRAME', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE']);

/** Cap "concept/trang" — vượt quá → chỉ giữ 40 đầu (theo đúng thứ tự
 *  `children` của Figma), kèm cảnh báo (xem `detectConceptsFromPage`). */
const MAX_CONCEPTS_PER_PAGE = 40;

export interface DetectedConcept {
  nodeId: string;
  name: string;
  width?: number;
  height?: number;
}

export interface DetectConceptsResult {
  ok: boolean;
  /** Chỉ có khi `ok:false` — node truyền vào không phải CANVAS (không phải
   *  page). */
  detail?: string;
  candidates: DetectedConcept[];
  /** Chỉ có khi số frame tìm được > `MAX_CONCEPTS_PER_PAGE`. */
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

/** Từ node `document` của MỘT trang (kết quả `fetchNodeSubtrees`, khoá theo
 *  chính `nodeId` của trang đó) → danh sách concept: children CẤP ĐỈNH của
 *  trang có type FRAME|COMPONENT|COMPONENT_SET|INSTANCE là concept trực
 *  tiếp; child type SECTION → lấy các frame CON TRỰC TIẾP của section (kể cả
 *  khi không nằm ở cấp đỉnh của trang — designer thường gom các concept vào
 *  section). Node ẩn (`visible === false`, ở BẤT KỲ cấp nào trên đường xét)
 *  bị bỏ. Node truyền vào không phải CANVAS (không phải trang) →
 *  `ok: false`. Thuần — không fs/network. */
export function detectConceptsFromPage(pageDoc: unknown): DetectConceptsResult {
  const node = pageDoc && typeof pageDoc === 'object' ? (pageDoc as Record<string, unknown>) : null;
  if (!node || node.type !== 'CANVAS') {
    return { ok: false, detail: 'link không phải page', candidates: [] };
  }
  const children = Array.isArray(node.children) ? (node.children as unknown[]) : [];
  const out: DetectedConcept[] = [];
  for (const rawChild of children) {
    const child = rawChild && typeof rawChild === 'object' ? (rawChild as Record<string, unknown>) : null;
    if (!child || !isVisibleNode(child)) continue;
    if (child.type === 'SECTION') {
      const grandChildren = Array.isArray(child.children) ? (child.children as unknown[]) : [];
      for (const rawGrand of grandChildren) {
        const grand = rawGrand && typeof rawGrand === 'object' ? (rawGrand as Record<string, unknown>) : null;
        if (!grand || !isVisibleNode(grand)) continue;
        if (!CONCEPT_NODE_TYPES.has(String(grand.type))) continue;
        const candidate = toDetectedConcept(grand);
        if (candidate) out.push(candidate);
      }
      continue;
    }
    if (!CONCEPT_NODE_TYPES.has(String(child.type))) continue;
    const candidate = toDetectedConcept(child);
    if (candidate) out.push(candidate);
  }

  if (out.length <= MAX_CONCEPTS_PER_PAGE) {
    return { ok: true, candidates: out };
  }
  const pageName = typeof node.name === 'string' && node.name.trim() ? node.name.trim() : '(không tên)';
  return {
    ok: true,
    candidates: out.slice(0, MAX_CONCEPTS_PER_PAGE),
    warning: `trang ${pageName} có ${out.length} frame, chỉ lấy 40 đầu`,
  };
}

// ── refs/<slug>.png path ─────────────────────────────────────────────────

/** Slug ổn định `<fileKey>-<nodeId>` (`:` → `-`), lọc còn ký tự an toàn cho
 *  tên file — dùng cho cả tên PNG lẫn việc dọn PNG cũ khi quét lại. */
export function conceptSlug(fileKey: string, nodeId: string): string {
  return `${fileKey}-${nodeId}`.replace(/[^A-Za-z0-9_-]/g, '-');
}

/** Đường dẫn PNG của một concept, tương đối từ `labCwd`. */
export function conceptPngRel(fileKey: string, nodeId: string): string {
  return `${LAB_REFS_DIR_REL}/${conceptSlug(fileKey, nodeId)}.png`;
}

// ── readLabRefs / writeLabRefs (fail-soft) ──────────────────────────────

/** Đọc `refs/refs.json`. File thiếu, JSON hỏng, hoặc thiếu `pages`/`concepts`
 *  (không phải mảng) → registry rỗng mặc định (`{schema_version:1, pages:[],
 *  concepts:[]}`, KHÔNG có `scannedAt` — route GET dùng nguyên giá trị này
 *  cho dự án "chưa quét lần nào"). Không bao giờ throw. */
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

/** Xoá mọi `refs/*.png` không còn trong `keepSlugs` (dọn PNG cũ khi quét lại
 *  đè toàn bộ danh sách link). Fail-soft — thư mục thiếu/không đọc được →
 *  coi như không có gì để dọn. */
async function cleanupStaleConceptPngs(labCwd: string, keepSlugs: ReadonlySet<string>): Promise<void> {
  const dir = path.join(labCwd, LAB_REFS_DIR_REL);
  const entries = await fs.promises.readdir(dir).catch(() => [] as string[]);
  for (const entry of entries) {
    if (!entry.toLowerCase().endsWith('.png')) continue;
    const slug = entry.slice(0, -'.png'.length);
    if (keepSlugs.has(slug)) continue;
    await fs.promises.rm(path.join(dir, entry), { force: true }).catch(() => undefined);
  }
}

function pageDocName(pageDoc: unknown): string {
  const node = pageDoc && typeof pageDoc === 'object' ? (pageDoc as Record<string, unknown>) : null;
  return typeof node?.name === 'string' ? node.name.trim() : '';
}

export interface ScanLabRefsDeps {
  /** Mặc định `globalThis.fetch` — override trong test để mock cả REST
   *  (qua `fetchNodeSubtrees`/`fetchNodeImages`) lẫn tải PNG (URL S3 giả). */
  fetch?: typeof fetch;
  now?: () => Date;
}

/** Quét TOÀN BỘ link người dùng dán, ghi đè `refs/refs.json` — nguồn sự thật
 *  DUY NHẤT sau mỗi lần quét (không merge với lần trước): mỗi link → parse
 *  (hỏng → page row `ok:false`, KHÔNG throw) → `fetchNodeSubtrees` một trang
 *  → `detectConceptsFromPage` → `fetchNodeImages` cho các concept (batch
 *  theo `fileKey`, tự nhiên vì `detectConceptsFromPage` chỉ trả concept của
 *  MỘT `fileKey`/lần) → TẢI PNG về `refs/<slug>.png` NGAY (URL Figma trả về
 *  là S3 pre-signed, sống ngắn — không thể chỉ lưu URL). Ảnh lỗi (Figma
 *  không trả URL, hoặc tải thất bại) → GIỮ concept, `png` rỗng, kèm một
 *  warning (fail-soft — concept vẫn hữu ích cho lab-map dù chưa có ảnh). REST
 *  lỗi (403/404/mạng…) ở tầng trang → page row `ok:false`, `detail` qua
 *  `describeFigmaError` — KHÔNG BAO GIỜ throw ra ngoài vì một link hỏng, để
 *  các link còn lại trong cùng lượt vẫn được quét. Dọn mọi PNG cũ không còn
 *  trong danh sách concept mới (quét lại = đè hoàn toàn, không phải merge).
 */
export async function scanLabRefs(opts: {
  labCwd: string;
  links: readonly string[];
  token: string;
  deps?: ScanLabRefsDeps;
}): Promise<{ refs: RefsFile; warnings: string[] }> {
  const fetchImpl = opts.deps?.fetch ?? fetch;
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
        detail: 'Link không hợp lệ — cần link "Copy link to page" của Figma (có node-id).',
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
      const detected = detectConceptsFromPage(pageDoc);
      if (!detected.ok) {
        pages.push({
          url: parsed.url,
          fileKey: parsed.fileKey,
          nodeId: parsed.nodeId,
          ok: false,
          detail: detected.detail ?? 'link không phải page',
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
      });

      if (detected.candidates.length === 0) continue;

      let images = new Map<string, string>();
      try {
        images = await fetchNodeImages(opts.token, parsed.fileKey, detected.candidates.map((c) => c.nodeId), restDeps);
      } catch (err) {
        warnings.push(`Trang "${pageName || parsed.nodeId}": không lấy được ảnh render từ Figma — ${describeFigmaError(err)}`);
      }

      for (const candidate of detected.candidates) {
        const conceptId = `${parsed.fileKey}:${candidate.nodeId}`;
        const slug = conceptSlug(parsed.fileKey, candidate.nodeId);
        const pngRel = conceptPngRel(parsed.fileKey, candidate.nodeId);
        keepSlugs.add(slug);
        const imageUrl = images.get(candidate.nodeId);
        let png = '';
        if (imageUrl) {
          const ok = await downloadConceptPng(fetchImpl, imageUrl, path.join(opts.labCwd, pngRel));
          if (ok) png = pngRel;
          else warnings.push(`Concept "${candidate.name}" (${conceptId}): tải ảnh thất bại — giữ concept, ảnh rỗng.`);
        } else {
          warnings.push(`Concept "${candidate.name}" (${conceptId}): không lấy được ảnh render từ Figma — giữ concept, ảnh rỗng.`);
        }
        concepts.push({
          id: conceptId,
          fileKey: parsed.fileKey,
          nodeId: candidate.nodeId,
          name: candidate.name,
          png,
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

  await cleanupStaleConceptPngs(opts.labCwd, keepSlugs);

  const refs: RefsFile = {
    schema_version: 1,
    scannedAt: (opts.deps?.now?.() ?? new Date()).toISOString(),
    pages,
    concepts,
  };
  await writeLabRefs(opts.labCwd, refs);
  return { refs, warnings };
}
